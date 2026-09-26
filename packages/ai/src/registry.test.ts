import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider, CLASSIFY_TOOL_NAME, DEFAULT_AI_MODEL, type MessagesClient } from './anthropic';
import { HeuristicProvider } from './heuristic';
import { createAIProvider, listProviderStatuses, resolveAIProviderSelection } from './registry';

describe('createAIProvider', () => {
  it('기본은 heuristic', () => {
    const p = createAIProvider({});
    expect(p).toBeInstanceOf(HeuristicProvider);
    expect(p.status()).toMatchObject({ status: 'LIVE', statusReason: '로컬 규칙 기반 추론 (LLM 아님)' });
    expect(createAIProvider({ AI_PROVIDER: 'heuristic', ANTHROPIC_API_KEY: 'sk-ant-x' })).toBeInstanceOf(HeuristicProvider);
  });

  it('anthropic + 키 없음 → heuristic 으로 대체, anthropic 상태는 NOT_AVAILABLE', () => {
    const env = { AI_PROVIDER: 'anthropic' };
    expect(createAIProvider(env)).toBeInstanceOf(HeuristicProvider);
    expect(resolveAIProviderSelection(env)).toEqual({
      requested: 'anthropic',
      active: 'heuristic',
      fallbackReason: 'ANTHROPIC_API_KEY 미설정 — 로컬 휴리스틱으로 대체',
      model: null,
    });
    const statuses = listProviderStatuses(env);
    expect(statuses.map((s) => [s.key, s.status, s.active])).toEqual([
      ['ai_provider.heuristic', 'LIVE', true],
      ['ai_provider.anthropic', 'NOT_AVAILABLE', false],
    ]);
    expect(statuses[1]!.statusReason).toBe('ANTHROPIC_API_KEY 미설정');
  });

  it('공백 키도 미설정으로 본다', () => {
    expect(createAIProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '   ' })).toBeInstanceOf(HeuristicProvider);
  });

  it('anthropic + 키 → AnthropicProvider, AI_MODEL 적용 (기본 모델 포함)', () => {
    const p = createAIProvider({ AI_PROVIDER: 'Anthropic', ANTHROPIC_API_KEY: 'sk-ant-x', AI_MODEL: 'claude-opus-5' });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.name).toBe('anthropic');
    expect(p.model).toBe('claude-opus-5');
    expect(p.status().status).toBe('LIVE');
    expect(createAIProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' }).model).toBe(DEFAULT_AI_MODEL);
    const statuses = listProviderStatuses({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(statuses.map((s) => [s.status, s.active])).toEqual([
      ['LIVE', false],
      ['LIVE', true],
    ]);
  });

  it('키는 있지만 AI_PROVIDER 미지정 → heuristic 사용, anthropic 은 사용 가능(LIVE)', () => {
    const statuses = listProviderStatuses({ ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(statuses.map((s) => [s.key, s.status, s.active])).toEqual([
      ['ai_provider.heuristic', 'LIVE', true],
      ['ai_provider.anthropic', 'LIVE', false],
    ]);
  });

  it('알 수 없는 값 → heuristic + 사유', () => {
    const env = { AI_PROVIDER: 'openai' };
    expect(createAIProvider(env)).toBeInstanceOf(HeuristicProvider);
    expect(resolveAIProviderSelection(env).fallbackReason).toBe('알 수 없는 AI_PROVIDER 값(openai) — 로컬 휴리스틱 사용');
  });

  it('주입 클라이언트로 분류 (네트워크 없음)', async () => {
    const client: MessagesClient = {
      messages: {
        create: async () =>
          ({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [{ type: 'tool_use', id: 't', name: CLASSIFY_TOOL_NAME, input: { accountCode: '822', confidence: 99, rationale: '주유' } }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }) as unknown as Anthropic.Message,
      },
    };
    const p = createAIProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' }, { anthropic: { client } });
    const r = await p.classifyTransaction({
      merchantName: 'SK에너지',
      merchantCategory: null,
      description: '',
      totalAmount: 50_000,
      evidenceType: 'card',
      direction: 'purchase',
      industry: 'service',
      candidateAccounts: [{ code: '822', name: '차량유지비' }],
      similarExamples: [],
    });
    expect(r).toMatchObject({ accountCode: '822', confidence: 85, provider: 'anthropic' });
  });

  it('process.env 기본값으로도 동작', () => {
    expect(() => createAIProvider()).not.toThrow();
    expect(listProviderStatuses()).toHaveLength(2);
  });
});
