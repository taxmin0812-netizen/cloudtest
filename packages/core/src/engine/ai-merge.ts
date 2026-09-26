import type {
  AccountClassification,
  AccountCode,
  AIClassificationInput,
  AIClassificationSuggestion,
  ClassificationSource,
  Direction,
  NormalizedTransaction,
} from '../types';
import { scrubSensitive } from '../normalize';
import { DEFAULT_CONFIDENCE_POLICY } from '../policy';
import { buildAccountMap, DEFAULT_ACCOUNT_CODES, isAccountCompatible } from '../data/accounts';
import { biznoKey, historyKey, lookupMerchant, merchantNameKey, type DirectedHistoryEntry } from './history';
import { buildReasons, buildSummary } from './explain';
import { CLASSIFY_PARAMS, type ClassificationContext } from './classify';

/**
 * AI 추천 병합 — AI 는 규칙·이력이 없거나 약할 때만 빈칸을 채운다.
 * 신뢰도 상한: 유사 이력이 있으면 85, AI 추론만 있으면 70 (CONFIDENCE_LADDER 와 동일). 따라서 AI 단독으로 자동승인은 불가.
 * 명시 cap 으로 낮출 수는 있지만 85 와 (자동승인 기준 − 1) 을 넘을 수는 없다.
 * 사용자 규칙·직접 지정(manual) 결과는 신뢰도와 무관하게 AI 가 바꾸지 않는다.
 */
export const AI_CAP_WITH_HISTORY = 85;
export const AI_CAP_AI_ONLY = 70;

/** AI 가 덮어쓸 수 없는 사람의 결정 */
const HUMAN_SOURCES: ReadonlySet<ClassificationSource> = new Set<ClassificationSource>(['user_rule', 'manual']);

export interface MergeAiOptions {
  /** 명시 상한 (기본: hasSimilarHistory ? 85 : 70). 85 및 (자동승인 기준 − 1) 을 넘지 못한다 */
  cap?: number;
  /** 거래 방향 — 주면 방향과 맞지 않는 계정(매입에 수익 계정 등) 추천을 버린다 */
  direction?: Direction;
  /** 기본: current.evidence 의 이력·업종 참조 수로 추정 */
  hasSimilarHistory?: boolean;
  /** 이 신뢰도 미만이면 '낮음' → AI 가 대체 가능 (기본 context.policy.quickReviewMin 또는 80) */
  lowThreshold?: number;
  /** 계정 검증용 계정과목표 (기본 context.accounts → DEFAULT_ACCOUNT_CODES) */
  accounts?: readonly AccountCode[] | ReadonlyMap<string, AccountCode>;
  context?: Pick<ClassificationContext, 'accounts' | 'policy'>;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function resolveAccounts(opts: MergeAiOptions): ReadonlyMap<string, AccountCode> {
  if (opts.accounts) return opts.accounts instanceof Map ? opts.accounts : buildAccountMap(opts.accounts as readonly AccountCode[]);
  if (opts.context) return opts.context.accounts;
  return buildAccountMap(DEFAULT_ACCOUNT_CODES);
}

type Alt = AccountClassification['alternatives'][number];

function upsertAlt(list: readonly Alt[], alt: Alt, excludeCode: string | null): Alt[] {
  const out = list.filter((a) => a.accountCode !== alt.accountCode && a.accountCode !== excludeCode);
  if (alt.accountCode !== excludeCode) {
    const prev = list.find((a) => a.accountCode === alt.accountCode);
    out.push(prev && prev.confidence >= alt.confidence ? prev : alt);
  }
  return out.sort((a, b) => b.confidence - a.confidence || (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0));
}

export function mergeAiSuggestion(
  current: AccountClassification,
  ai: AIClassificationSuggestion | null,
  opts: MergeAiOptions = {},
): AccountClassification {
  if (!ai) return current;
  const accounts = resolveAccounts(opts);
  const code = String(ai.accountCode ?? '').trim();
  const acc = accounts.get(code);
  const label = `${code || '(빈 코드)'}${ai.accountName ? ` ${ai.accountName}` : ''}`;
  if (!acc || !acc.active) {
    const why = acc ? '비활성 계정' : '계정과목표에 없는 코드';
    return { ...current, reasons: [...current.reasons, `AI 추천 무시: ${label} — ${why}`] };
  }
  if (opts.direction && !isAccountCompatible(code, opts.direction, accounts)) {
    const dir = opts.direction === 'purchase' ? '매입' : '매출';
    return { ...current, reasons: [...current.reasons, `AI 추천 무시: ${label} — ${dir} 거래의 매입/매출 방향과 맞지 않는 계정`] };
  }

  const ev = current.evidence;
  const hasSimilar = opts.hasSimilarHistory ?? ((ev.historyCount ?? 0) > 0 || (ev.peerClientCount ?? 0) > 0);
  const autoApproveMin = opts.context?.policy.autoApproveMin ?? DEFAULT_CONFIDENCE_POLICY.autoApproveMin;
  const ceiling = Math.min(AI_CAP_WITH_HISTORY, autoApproveMin - 1);
  const cap = Math.min(opts.cap ?? (hasSimilar ? AI_CAP_WITH_HISTORY : AI_CAP_AI_ONLY), ceiling);
  const aiConf = clamp(Math.min(ai.confidence, cap));
  const lowThreshold = opts.lowThreshold ?? opts.context?.policy.quickReviewMin ?? 80;
  const aiEvidence = { aiProvider: ai.provider, ...(ai.model ? { aiModel: ai.model } : {}) };
  const isNone = current.accountCode === null || current.source === 'none';
  const isHuman = !isNone && HUMAN_SOURCES.has(current.source);
  const isLow = !isHuman && (isNone || current.confidence < lowThreshold);

  // 같은 계정이면 교차확인만 (낮은 판단은 AI 신뢰도까지 끌어올림)
  if (!isNone && current.accountCode === code) {
    return {
      ...current,
      confidence: isLow ? Math.max(current.confidence, aiConf) : current.confidence,
      reasons: [...current.reasons, `AI 추천도 동일 계정 (AI 신뢰도 ${aiConf})`],
      evidence: { ...ev, ...aiEvidence },
    };
  }

  const aiAlt: Alt = { accountCode: code, accountName: acc.name, confidence: aiConf, source: 'ai' };

  // 충분히 확실한 판단은 바꾸지 않는다 — AI 는 참고 대안(충돌 미유발)으로만
  if (!isLow) {
    const quiet = Math.max(0, current.confidence - CLASSIFY_PARAMS.conflictGap - 1);
    return {
      ...current,
      reasons: isHuman ? [...current.reasons, `AI 추천(${acc.name})은 사람이 정한 판단을 바꾸지 않음 — 참고 대안으로만 표시`] : current.reasons,
      alternatives: upsertAlt(current.alternatives, { ...aiAlt, confidence: Math.min(aiConf, quiet) }, current.accountCode),
    };
  }

  const aiWins = isNone || aiConf > current.confidence;
  if (!aiWins) {
    return {
      ...current,
      reasons: [...current.reasons, `AI 추천(${acc.name}, ${aiConf})은 기존 판단보다 낮아 대안으로만 표시`],
      evidence: { ...ev, ...aiEvidence },
      alternatives: upsertAlt(current.alternatives, aiAlt, current.accountCode),
    };
  }

  const evidence = { ...ev, ...aiEvidence };
  const facts = { source: 'ai' as const, merchantName: '', accountName: acc.name, evidence, aiRationale: ai.rationale };
  const reasons = buildReasons(facts);
  reasons.push(hasSimilar ? `신뢰도 상한 ${cap} (유사 이력 있음)` : `신뢰도 상한 ${cap} (AI 추론만 존재)`);
  if (!isNone) reasons.push(`기존 판단: ${current.accountName ?? '미분류'} (${current.confidence}) — 대안으로 이동`);
  let alternatives = current.alternatives.filter((a) => a.accountCode !== code);
  if (!isNone && current.accountCode) {
    alternatives = upsertAlt(
      alternatives,
      { accountCode: current.accountCode, accountName: current.accountName ?? current.accountCode, confidence: current.confidence, source: current.source },
      code,
    );
  }
  return {
    accountCode: code,
    accountName: acc.name,
    confidence: aiConf,
    source: 'ai',
    summary: buildSummary(facts),
    reasons,
    evidence,
    alternatives,
  };
}

// ────────────────────────────── AI 입력 구성 ──────────────────────────────

/**
 * 외부 AI 로 나가는 문자열 마스킹. scrubSensitive(주민번호·카드번호·비밀번호) 에 더해
 * 이메일, 휴대폰·유선 전화번호, 계좌번호로 보이는 숫자열(하이픈 포함 10자리 이상, 연속 10자리 이상)을 가린다.
 */
export function scrubForAi(text: string | null | undefined): string {
  if (!text) return '';
  return scrubSensitive(String(text))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[이메일]')
    .replace(/(?<!\d)01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)/g, '[전화번호]')
    .replace(/(?<!\d)0\d{1,2}[-\s.)]\d{3,4}[-\s.]\d{4}(?!\d)/g, '[전화번호]')
    .replace(/(?<![\d*])\d{2,6}(?:-\d{2,8}){1,4}(?![\d*])/g, (m) => (m.replace(/-/g, '').length >= 10 ? '[계좌번호]' : m))
    .replace(/(?<!\d)\d{10,}(?!\d)/g, '[번호]');
}

/**
 * AI Provider 입력. 개인식별정보 최소화: 상호·적요·업종·예시 상호는 scrubForAi, 카드번호·사업자번호·원본행은 넣지 않는다.
 * similarExamples: 같은 거래처의 동일 상대방 이력 + 상호키 앞 2글자가 같은 상대방 이력 (최대 maxExamples).
 */
export function buildAiClassificationInput(
  tx: NormalizedTransaction,
  ctx: ClassificationContext,
  opts: { maxExamples?: number } = {},
): AIClassificationInput {
  const max = opts.maxExamples ?? 10;
  const candidateAccounts = [...ctx.accounts.values()]
    .filter((a) => a.active && isAccountCompatible(a.code, tx.direction, ctx.accounts))
    .filter((a) => (tx.direction === 'purchase' ? a.category === 'expense' || a.category === 'cogs' || a.category === 'asset' : a.category === 'revenue'))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((a) => ({ code: a.code, name: a.name }));
  return {
    merchantName: scrubForAi(tx.merchantName),
    merchantCategory: tx.merchantCategory === null ? null : scrubForAi(tx.merchantCategory),
    description: scrubForAi(tx.description),
    totalAmount: tx.totalAmount,
    evidenceType: tx.evidenceType,
    direction: tx.direction,
    industry: ctx.client.industry,
    candidateAccounts,
    similarExamples: similarExamples(tx, ctx, max),
  };
}

function similarExamples(tx: NormalizedTransaction, ctx: ClassificationContext, max: number): AIClassificationInput['similarExamples'] {
  const cid = ctx.client.id;
  const tally = new Map<string, { merchantName: string; accountCode: string; accountName: string; count: number; same: boolean }>();
  const add = (e: DirectedHistoryEntry, same: boolean) => {
    if (e.direction && e.direction !== tx.direction) return;
    if (!isAccountCompatible(e.accountCode, tx.direction, ctx.accounts)) return;
    const k = `${e.merchantKey}|${e.accountCode}`;
    const t = tally.get(k);
    if (t) t.count += 1;
    else
      tally.set(k, {
        merchantName: scrubForAi(same ? tx.merchantName || e.merchantKey : e.merchantKey),
        accountCode: e.accountCode,
        accountName: ctx.accounts.get(e.accountCode)?.name ?? e.accountName,
        count: 1,
        same,
      });
  };
  const same = new Set<DirectedHistoryEntry>();
  if (tx.merchantBusinessNumber) for (const e of ctx.history.byBizno.get(historyKey(cid, biznoKey(tx.merchantBusinessNumber))) ?? []) same.add(e);
  if (tx.merchantKey) for (const e of ctx.history.byKey.get(historyKey(cid, merchantNameKey(tx.merchantKey))) ?? []) same.add(e);
  for (const e of same) add(e, true);
  const prefix = tx.merchantKey.slice(0, 2);
  if (prefix.length === 2) {
    const head = `${cid}|k:`;
    for (const [k, entries] of ctx.history.byKey) {
      if (!k.startsWith(head)) continue;
      const mk = k.slice(head.length);
      if (mk === tx.merchantKey || !mk.startsWith(prefix)) continue;
      for (const e of entries) add(e, false);
    }
  }
  return [...tally.values()]
    .sort((a, b) => Number(b.same) - Number(a.same) || b.count - a.count || (a.merchantName < b.merchantName ? -1 : a.merchantName > b.merchantName ? 1 : 0) || (a.accountCode < b.accountCode ? -1 : 1))
    .slice(0, max)
    .map(({ merchantName, accountCode, accountName, count }) => ({ merchantName, accountCode, accountName, count }));
}

/** AI 상한 판단용: 이 거래처의 유사 이력 또는 타 거래처 동일 상대방 이력이 있는가 */
export function hasSimilarHistory(tx: NormalizedTransaction, ctx: ClassificationContext): boolean {
  if (similarExamples(tx, ctx, 1).length > 0) return true;
  return lookupMerchant(ctx.peers, tx).some((e) => e.clientId !== ctx.client.id);
}
