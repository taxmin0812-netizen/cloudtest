import type { IntegrationDescriptor } from '@mintax/core';
import { AnthropicProvider, DEFAULT_AI_MODEL, type AnthropicProviderOptions } from './anthropic';
import { HeuristicProvider, type HeuristicProviderOptions } from './heuristic';
import type { AIProvider } from './types';

export type AIEnv = Record<string, string | undefined>;
export type AIProviderKind = 'heuristic' | 'anthropic';

export interface AIProviderSelection {
  /** AI_PROVIDER 원문 (없으면 null) */
  requested: string | null;
  /** 실제 사용 Provider */
  active: AIProviderKind;
  /** 요청과 다르게 선택된 경우 사유 */
  fallbackReason: string | null;
  model: string | null;
}

export interface CreateAIProviderDeps {
  heuristic?: HeuristicProviderOptions;
  /** apiKey·model 은 env 에서 읽는다. 여기서는 클라이언트 주입·타임아웃 등만 */
  anthropic?: Omit<AnthropicProviderOptions, 'apiKey' | 'model'>;
}

function envValue(env: AIEnv, key: string): string | null {
  const v = env[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * AI_PROVIDER=heuristic|anthropic (기본 heuristic).
 * anthropic 인데 ANTHROPIC_API_KEY 가 없으면 heuristic 으로 대체한다 (파이프라인은 멈추지 않는다).
 */
export function resolveAIProviderSelection(env: AIEnv = process.env): AIProviderSelection {
  const requested = envValue(env, 'AI_PROVIDER');
  const kind = requested?.toLowerCase() ?? 'heuristic';
  const model = envValue(env, 'AI_MODEL') ?? DEFAULT_AI_MODEL;
  if (kind === 'heuristic') return { requested, active: 'heuristic', fallbackReason: null, model: null };
  if (kind === 'anthropic') {
    if (!envValue(env, 'ANTHROPIC_API_KEY')) {
      return { requested, active: 'heuristic', fallbackReason: 'ANTHROPIC_API_KEY 미설정 — 로컬 휴리스틱으로 대체', model: null };
    }
    return { requested, active: 'anthropic', fallbackReason: null, model };
  }
  return { requested, active: 'heuristic', fallbackReason: `알 수 없는 AI_PROVIDER 값(${requested}) — 로컬 휴리스틱 사용`, model: null };
}

export function createAIProvider(env: AIEnv = process.env, deps: CreateAIProviderDeps = {}): AIProvider {
  const selection = resolveAIProviderSelection(env);
  const heuristic = new HeuristicProvider(deps.heuristic);
  if (selection.active === 'anthropic') {
    return new AnthropicProvider({
      ...deps.anthropic,
      apiKey: envValue(env, 'ANTHROPIC_API_KEY'),
      model: selection.model ?? DEFAULT_AI_MODEL,
      fallback: deps.anthropic?.fallback ?? heuristic,
    });
  }
  return heuristic;
}

/** 연동 설정 화면용: 모든 Provider 상태 + 현재 사용 여부 */
export function listProviderStatuses(env: AIEnv = process.env): Array<IntegrationDescriptor & { active: boolean }> {
  const selection = resolveAIProviderSelection(env);
  const heuristic = new HeuristicProvider().status();
  const anthropic = new AnthropicProvider({
    apiKey: envValue(env, 'ANTHROPIC_API_KEY'),
    model: envValue(env, 'AI_MODEL') ?? DEFAULT_AI_MODEL,
  }).status();
  return [
    { ...heuristic, active: selection.active === 'heuristic' },
    { ...anthropic, active: selection.active === 'anthropic' },
  ];
}
