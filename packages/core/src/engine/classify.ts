import type {
  AccountClassification,
  AccountCode,
  ClassificationEvidence,
  ClassificationSource,
  ClientProfile,
  Condition,
  ConditionField,
  ConditionLeaf,
  ConfidencePolicy,
  CorrectionRecord,
  HistoryEntry,
  LocalDate,
  MappingRule,
  NormalizedTransaction,
} from '../types';
import { describeCondition, evaluateCondition, type ConditionContext } from '../dsl';
import { weekdayOf } from '../normalize';
import { buildAccountMap, DEFAULT_ACCOUNT_CODES, isAccountCompatible } from '../data/accounts';
import { SYSTEM_DICTIONARY_BY_ID, SYSTEM_RULE_MAX_CONFIDENCE, systemDictionaryRules } from '../data/system-dictionary';
import {
  applyCorrectionPriority,
  biznoKey,
  buildCorrectionIndex,
  buildHistoryIndex,
  buildMerchantIndex,
  compareCorrection,
  daysBetween,
  filterCompatible,
  historyKey,
  isoToKstDate,
  latestCorrectedEntry,
  lookupCorrections,
  lookupMerchant,
  majorityAccountByCount,
  merchantNameKey,
  tallyHistory,
  type CorrectionIndex,
  type CorrectionPoint,
  type HistoryIndex,
  type HistoryStats,
  type MerchantIndex,
  type TallyOptions,
} from './history';
import { buildReasons, buildSummary, INDUSTRY_LABELS_KO, type ExplainFacts } from './explain';

/**
 * 계정과목 판단 엔진 (Level 1~6 + none). 순수·결정적·동기.
 *
 * 학습 키는 항상 client_id + 상대방(사업자번호/상호키)이다. 같은 상대방이라도 거래처마다 계정이 다를 수 있으며
 * (쿠팡: 건설업 A → 소모품비, 온라인판매 B → 상품), 타 거래처·전역 자료는 거래처 고유 이력을 절대 이기지 못한다.
 */

// ────────────────────────────── 파라미터 ──────────────────────────────

export interface ConfidenceStep {
  /** 이 건수 이상이면 */
  min: number;
  confidence: number;
}

export interface ClassifyParams {
  /** Level 2: 동일 사업자번호 일관 처리 건수 → 신뢰도 */
  exactHistoryLadder: readonly ConfidenceStep[];
  /** Level 3: 동일 상호키 (최대 97) */
  nameHistoryLadder: readonly ConfidenceStep[];
  /** 이력이 여러 계정으로 갈릴 때 1순위 상한 */
  splitHistoryCap: number;
  /** 갈린 이력 감점: round((1 − 가중 일관성) × scale) */
  splitPenaltyScale: number;
  /** 가중 일관성이 이 값 미만이면 minorityCap 으로 제한 (반드시 검토) */
  majorityMinRatio: number;
  minorityCap: number;
  /** 사람이 수정해 확정한 이력의 가중 배수 */
  correctedEntryWeight: number;
  /** 최근성 반감기 (일) */
  recencyHalfLifeDays: number;
  /** Level 4: 동일 수정 반복 횟수 → 신뢰도 (자동승인 불가 구간 90~94) */
  correctionLadder: readonly ConfidenceStep[];
  /** 수정 기록 유효기간 (일). null = 무제한 */
  correctionWindowDays: number | null;
  /** Level 5: 동일 업종 */
  industryMinClients: number;
  industryMinAgreement: number;
  industryStrongConfidence: number;
  /** 참조 거래처 ≥ min 이지만 일치율 미달 시 기준값 (감점 전) */
  industryWeakBase: number;
  industryTwoClients: number;
  industryOneClient: number;
  /** 타 업종 포함 패턴 감점·상한 */
  crossIndustryPenalty: number;
  crossIndustryCap: number;
  /** Level 6 상한 */
  systemRuleCap: number;
  /** 우선순위에서 밀린 규칙이 대안으로 남을 때 감점 */
  shadowedRulePenalty: number;
  /** 금액 이상치: |금액| > multiplier × 평균 → penalty 감점 */
  amountDeviationMultiplier: number;
  amountDeviationPenalty: number;
  amountDeviationMinHistory: number;
  /** 계정과목표에 없거나 비활성인 계정의 상한 */
  unknownAccountCap: number;
  /** 대안 신뢰도가 (1순위 − gap) 이상이면 계정 충돌 */
  conflictGap: number;
  maxAlternatives: number;
}

export const CLASSIFY_PARAMS: Readonly<ClassifyParams> = Object.freeze({
  exactHistoryLadder: Object.freeze([
    { min: 10, confidence: 99 },
    { min: 5, confidence: 98 },
    { min: 3, confidence: 97 },
    { min: 2, confidence: 95 },
    { min: 1, confidence: 92 },
  ]),
  nameHistoryLadder: Object.freeze([
    { min: 3, confidence: 97 },
    { min: 2, confidence: 94 },
    { min: 1, confidence: 90 },
  ]),
  splitHistoryCap: 98,
  splitPenaltyScale: 30,
  majorityMinRatio: 0.6,
  minorityCap: 79,
  correctedEntryWeight: 3,
  recencyHalfLifeDays: 365,
  correctionLadder: Object.freeze([
    { min: 3, confidence: 94 },
    { min: 2, confidence: 93 },
    { min: 1, confidence: 90 },
  ]),
  correctionWindowDays: 180,
  industryMinClients: 3,
  industryMinAgreement: 0.8,
  industryStrongConfidence: 93,
  industryWeakBase: 88,
  industryTwoClients: 85,
  industryOneClient: 75,
  crossIndustryPenalty: 8,
  crossIndustryCap: 85,
  systemRuleCap: SYSTEM_RULE_MAX_CONFIDENCE,
  shadowedRulePenalty: 15,
  amountDeviationMultiplier: 3,
  amountDeviationPenalty: 5,
  amountDeviationMinHistory: 2,
  unknownAccountCap: 79,
  conflictGap: 10,
  maxAlternatives: 5,
});

// ────────────────────────────── 규칙 사전필터 ──────────────────────────────

type TextField = 'merchantName' | 'merchantKey' | 'description' | 'merchantCategory' | 'merchantBusinessNumber';
const TEXT_FIELDS: ReadonlySet<ConditionField> = new Set<ConditionField>([
  'merchantName',
  'merchantKey',
  'description',
  'merchantCategory',
  'merchantBusinessNumber',
]);
const PREFILTER_OPS = new Set(['contains', 'eq', 'starts_with', 'ends_with', 'in']);

/** 조건이 참이 되려면 적어도 하나는 포함되어야 하는 (필드, 토큰) 목록 */
export interface PrefilterToken {
  field: TextField;
  token: string;
}

function normU(v: unknown): string {
  return String(v ?? '').normalize('NFKC').toUpperCase();
}

/**
 * 조건 → 사전필터 토큰. null = 사전필터 불가(항상 평가).
 * 필터는 "필요조건"만 검사하므로 결과는 evaluateCondition 과 항상 같다 (거짓 음성 없음).
 */
export function compilePrefilter(cond: Condition): PrefilterToken[] | null {
  if (!cond || typeof cond !== 'object') return null;
  if ('all' in cond) {
    if (!Array.isArray(cond.all)) return null;
    let best: PrefilterToken[] | null = null;
    for (const c of cond.all) {
      const t = compilePrefilter(c);
      if (t && (!best || t.length < best.length)) best = t;
    }
    return best;
  }
  if ('any' in cond) {
    if (!Array.isArray(cond.any)) return null;
    const out: PrefilterToken[] = [];
    for (const c of cond.any) {
      const t = compilePrefilter(c);
      if (!t) return null;
      out.push(...t);
    }
    return out;
  }
  if ('not' in cond) return null;
  const leaf = cond as ConditionLeaf;
  if (!TEXT_FIELDS.has(leaf.field) || !PREFILTER_OPS.has(leaf.op)) return null;
  // eq/starts_with/ends_with 에 배열을 주면 DSL 은 문자열화해서 비교하므로 필터하지 않는다
  if (Array.isArray(leaf.value) && leaf.op !== 'contains' && leaf.op !== 'in') return null;
  if (!Array.isArray(leaf.value) && leaf.op === 'in') return [];
  const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
  const out: PrefilterToken[] = [];
  for (const v of values) {
    if (v === undefined || v === null) return null;
    const token = normU(v);
    if (token === '') return null;
    out.push({ field: leaf.field as TextField, token });
  }
  return out;
}

type TxText = Record<TextField, string>;

function prefilterPass(tokens: readonly PrefilterToken[], text: TxText): boolean {
  for (const t of tokens) if (text[t.field].includes(t.token)) return true;
  return false;
}

// ────────────────────────────── 컨텍스트 ──────────────────────────────

export interface CompiledRule {
  rule: MappingRule;
  /** 적용 신뢰도 (정수, 시스템 규칙은 상한 적용) */
  confidence: number;
  prefilter: PrefilterToken[] | null;
  /** 사전 메모 (시스템 사전 항목일 때) */
  note?: string;
}

export interface ClassificationContextInput {
  client: ClientProfile;
  /** 이 거래처 규칙 + system_default 규칙 (DB). 다른 거래처 규칙은 무시된다 */
  rules: readonly MappingRule[];
  /** 이 거래처의 확정 과거 거래 */
  history: readonly HistoryEntry[];
  /** 다른 거래처의 확정 과거 거래 (동일/전 업종) */
  peerHistory: readonly HistoryEntry[];
  corrections: readonly CorrectionRecord[];
  /** 사무소 계정과목표. 비어 있으면 DEFAULT_ACCOUNT_CODES */
  accounts: readonly AccountCode[];
  policy: ConfidencePolicy;
  /** 기준일 (최근성·수정 유효기간). 없으면 이력·수정 기록 중 최신일 */
  asOfDate?: LocalDate;
  params?: Partial<ClassifyParams>;
  /** 내장 SYSTEM_DICTIONARY 사용 (기본 true). DB system_default 규칙이 같은 id 면 DB 가 이긴다 */
  useBuiltinDictionary?: boolean;
}

export interface ClassificationContext {
  readonly client: ClientProfile;
  readonly policy: ConfidencePolicy;
  readonly asOfDate: LocalDate | null;
  readonly params: Readonly<ClassifyParams>;
  readonly accounts: ReadonlyMap<string, AccountCode>;
  /** Level 1: 우선순위 내림차순 */
  readonly userRules: readonly CompiledRule[];
  /** Level 6: 우선순위 내림차순 */
  readonly systemRules: readonly CompiledRule[];
  readonly history: HistoryIndex;
  readonly peers: MerchantIndex;
  readonly corrections: CorrectionIndex;
  /** @internal 상대방 단위 분석 메모 (결과에 영향 없음) */
  readonly cache: Map<string, MerchantAnalysis>;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function compareRules(a: CompiledRule, b: CompiledRule): number {
  if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const ai = String(a.rule.id);
  const bi = String(b.rule.id);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

function compileRule(rule: MappingRule, cap: number, note?: string): CompiledRule {
  let prefilter: PrefilterToken[] | null = null;
  try {
    prefilter = compilePrefilter(rule.condition);
  } catch {
    prefilter = null;
  }
  const c: CompiledRule = { rule, confidence: clampConfidence(Math.min(rule.confidence, cap)), prefilter };
  if (note) c.note = note;
  return c;
}

/** 사용자 승인 규칙 여부: active + 이 거래처 + (사용자 작성 | 승인된 시스템 제안) */
function isUserRule(r: MappingRule, clientId: string): boolean {
  return r.status === 'active' && r.clientId === clientId && (r.origin === 'user' || r.origin === 'system_suggested');
}

export function buildClassificationContext(input: ClassificationContextInput): ClassificationContext {
  const client = input.client;
  const params: ClassifyParams = { ...CLASSIFY_PARAMS };
  for (const [k, v] of Object.entries(input.params ?? {})) {
    if (v !== undefined) (params as unknown as Record<string, unknown>)[k] = v;
  }
  // 사다리는 건수 내림차순이어야 한다
  for (const k of ['exactHistoryLadder', 'nameHistoryLadder', 'correctionLadder'] as const) {
    params[k] = [...params[k]].sort((a, b) => b.min - a.min);
  }
  const accounts = buildAccountMap(input.accounts.length > 0 ? input.accounts : DEFAULT_ACCOUNT_CODES);

  const userRules = input.rules
    .filter((r) => isUserRule(r, client.id))
    .map((r) => compileRule(r, 100))
    .sort(compareRules);

  // 시스템 규칙: 내장 사전 ← DB system_default (같은 id 는 DB 가 덮어씀, disabled 면 꺼짐)
  const sys = new Map<string, MappingRule>();
  if (input.useBuiltinDictionary !== false) for (const r of systemDictionaryRules(accounts)) sys.set(String(r.id), r);
  for (const r of input.rules) {
    if (r.origin !== 'system_default') continue;
    if (r.clientId !== null && r.clientId !== client.id) continue;
    sys.set(String(r.id), r);
  }
  const systemRules = [...sys.values()]
    .filter((r) => r.status === 'active')
    .map((r) => compileRule(r, params.systemRuleCap, SYSTEM_DICTIONARY_BY_ID.get(String(r.id))?.note))
    .sort(compareRules);

  const ownHistory = input.history.filter((e) => e.clientId === client.id);
  const peerHistory = input.peerHistory.filter((e) => e.clientId !== client.id);

  let asOf: LocalDate | null = input.asOfDate ?? null;
  if (!asOf) {
    for (const e of ownHistory) if (!asOf || e.transactionDate > asOf) asOf = e.transactionDate;
    for (const c of input.corrections) {
      if (c.clientId !== client.id) continue;
      const d = isoToKstDate(c.createdAt);
      if (!asOf || d > asOf) asOf = d;
    }
  }

  return {
    client,
    policy: input.policy,
    asOfDate: asOf,
    params,
    accounts,
    userRules,
    systemRules,
    history: buildHistoryIndex(ownHistory),
    peers: buildMerchantIndex(peerHistory),
    corrections: buildCorrectionIndex(input.corrections, client.id),
    cache: new Map(),
  };
}

// ────────────────────────────── 거래 → DSL 컨텍스트 ──────────────────────────────

/** 규칙 평가용 필드 값 (VAT/Risk 엔진도 같은 형태를 쓸 수 있다) */
export function transactionConditionContext(
  tx: NormalizedTransaction,
  client: Pick<ClientProfile, 'industry'>,
  accountCode: string | null = null,
): ConditionContext {
  const day = Number(tx.transactionDate.slice(8, 10));
  return {
    merchantName: tx.merchantName,
    merchantKey: tx.merchantKey,
    merchantBusinessNumber: tx.merchantBusinessNumber,
    merchantCategory: tx.merchantCategory,
    merchantTaxType: tx.merchantTaxType,
    description: tx.description,
    evidenceType: tx.evidenceType,
    direction: tx.direction,
    supplyAmount: tx.supplyAmount,
    vatAmount: tx.vatAmount,
    totalAmount: tx.totalAmount,
    cardNumberMasked: tx.cardNumberMasked,
    isForeign: tx.isForeign,
    currency: tx.currency,
    weekday: weekdayOf(tx.transactionDate),
    dayOfMonth: Number.isNaN(day) ? null : day,
    accountCode,
    industry: client.industry,
  };
}

function txText(cc: ConditionContext): TxText {
  return {
    merchantName: normU(cc.merchantName),
    merchantKey: normU(cc.merchantKey),
    description: normU(cc.description),
    merchantCategory: normU(cc.merchantCategory),
    merchantBusinessNumber: normU(cc.merchantBusinessNumber),
  };
}

function matchRules(
  rules: readonly CompiledRule[],
  cc: ConditionContext,
  text: TxText,
  tx: NormalizedTransaction,
  ctx: ClassificationContext,
  requireKnownAccount: boolean,
): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const r of rules) {
    if (r.prefilter && !prefilterPass(r.prefilter, text)) continue;
    let ok = false;
    try {
      ok = evaluateCondition(r.rule.condition, cc);
    } catch {
      ok = false; // 손상된 조건은 불일치로 취급
    }
    if (!ok) continue;
    if (!isAccountCompatible(r.rule.accountCode, tx.direction, ctx.accounts)) continue;
    if (requireKnownAccount && !isUsableAccount(r.rule.accountCode, ctx)) continue;
    out.push(r);
  }
  return out;
}

function isUsableAccount(code: string, ctx: ClassificationContext): boolean {
  const a = ctx.accounts.get(code);
  return !!a && a.active;
}

// ────────────────────────────── 상대방 분석 (Level 2~5) ──────────────────────────────

type Tier = 'client' | 'global';

interface Candidate {
  source: ClassificationSource;
  accountCode: string;
  accountName: string;
  confidence: number;
  tier: Tier;
}

interface HistoryResult {
  level: 'exact_history' | 'name_history';
  /** 유효 이력 (수정 우선 원칙 적용 후). 비었으면 null */
  stats: HistoryStats | null;
  /** 방향 필터 후 전체 이력 */
  rawStats: HistoryStats;
  supersededCount: number;
  biznoMismatch: boolean;
  confidence: number;
  alternatives: Candidate[];
}

interface CorrectionResult {
  accountCode: string;
  accountName: string;
  fromCode: string | null;
  /** 최신 수정값과 같은 수정 반복 횟수 */
  count: number;
  /** 관련 수정 전체 수 */
  total: number;
  date: LocalDate | null;
  confidence: number;
}

interface PeerResult {
  accountCode: string;
  accountName: string;
  confidence: number;
  clientCount: number;
  agreeingClients: number;
  entryCount: number;
  consistentEntries: number;
  lastUsedDate: LocalDate | null;
  strong: boolean;
  cross: boolean;
  alternatives: Candidate[];
}

/** @internal */
export interface MerchantAnalysis {
  history: HistoryResult | null;
  correction: CorrectionResult | null;
  industry: PeerResult | null;
  cross: PeerResult | null;
}

function ladder(steps: readonly ConfidenceStep[], count: number): number {
  for (const s of steps) if (count >= s.min) return s.confidence;
  return 0;
}

function tallyOpts(ctx: ClassificationContext): TallyOptions {
  return {
    asOfDate: ctx.asOfDate,
    halfLifeDays: ctx.params.recencyHalfLifeDays,
    correctedWeight: ctx.params.correctedEntryWeight,
  };
}

/** 이력 신뢰도: 건수 사다리 − 갈림 감점 (가중 일관성 기준) */
function historyConfidence(count: number, weightRatio: number, allSame: boolean, steps: readonly ConfidenceStep[], P: ClassifyParams): number {
  const base = ladder(steps, count);
  if (allSame) return base;
  let c = Math.min(base, P.splitHistoryCap) - Math.round((1 - weightRatio) * P.splitPenaltyScale);
  if (weightRatio < P.majorityMinRatio) c = Math.min(c, P.minorityCap);
  return clampConfidence(c);
}

function accountNameOf(code: string, fallback: string, ctx: ClassificationContext): string {
  return ctx.accounts.get(code)?.name ?? (fallback || code);
}

interface CorrectionEvent {
  date: LocalDate;
  after: string;
  afterName: string;
  before: string | null;
  sortKey: string;
}

function correctionEvents(tx: NormalizedTransaction, ctx: ClassificationContext, group: readonly HistoryEntry[]): CorrectionEvent[] {
  const P = ctx.params;
  const asOf = ctx.asOfDate ?? tx.transactionDate;
  const records: CorrectionRecord[] = lookupCorrections(ctx.corrections, tx).filter((c) => {
    if (!isAccountCompatible(c.after, tx.direction, ctx.accounts)) return false;
    if (P.correctionWindowDays === null) return true;
    return daysBetween(isoToKstDate(c.createdAt), asOf) <= P.correctionWindowDays;
  });
  if (records.length > 0) {
    return records.sort(compareCorrection).map((c, i) => ({
      date: isoToKstDate(c.createdAt),
      after: c.after,
      afterName: '',
      before: c.before,
      sortKey: String(i).padStart(8, '0'),
    }));
  }
  // 수정 기록이 없으면 이력의 "수정 확정" 항목을 수정 사건으로 본다 (중복 계산 방지를 위해 둘 중 하나만)
  return group
    .filter((e) => e.corrected)
    .map((e, i) => ({ date: e.transactionDate, after: e.accountCode, afterName: e.accountName, before: null, sortKey: String(i).padStart(8, '0') }));
}

function analyzeHistory(
  tx: NormalizedTransaction,
  ctx: ClassificationContext,
): { result: HistoryResult | null; group: HistoryEntry[] } {
  const P = ctx.params;
  const cid = ctx.client.id;
  let level: HistoryResult['level'] = 'exact_history';
  let group: HistoryEntry[] = [];
  if (tx.merchantBusinessNumber) {
    group = filterCompatible(ctx.history.byBizno.get(historyKey(cid, biznoKey(tx.merchantBusinessNumber))) ?? [], tx.direction, ctx.accounts);
  }
  let biznoMismatch = false;
  if (group.length === 0 && tx.merchantKey) {
    level = 'name_history';
    group = filterCompatible(ctx.history.byKey.get(historyKey(cid, merchantNameKey(tx.merchantKey))) ?? [], tx.direction, ctx.accounts);
    biznoMismatch =
      !!tx.merchantBusinessNumber && group.some((e) => !!e.merchantBusinessNumber && e.merchantBusinessNumber !== tx.merchantBusinessNumber);
  }
  if (group.length === 0) return { result: null, group };

  const opts = tallyOpts(ctx);
  const rawStats = tallyHistory(group, opts);

  // 수정 우선 원칙: 최신 수정 기준점 (수정 기록 vs 이력의 수정확정 항목 중 늦은 것)
  let point: CorrectionPoint | null = null;
  const events = correctionEvents(tx, ctx, group);
  const lastEvent = events[events.length - 1];
  if (lastEvent) point = { date: lastEvent.date, accountCode: lastEvent.after };
  const lce = latestCorrectedEntry(group);
  if (lce && (!point || lce.transactionDate > point.date)) point = { date: lce.transactionDate, accountCode: lce.accountCode };

  const { effective, superseded } = applyCorrectionPriority(group, point, majorityAccountByCount(group));
  const steps = level === 'exact_history' ? P.exactHistoryLadder : P.nameHistoryLadder;
  if (effective.length === 0) {
    return {
      result: { level, stats: null, rawStats, supersededCount: superseded.length, biznoMismatch, confidence: 0, alternatives: [] },
      group,
    };
  }
  const stats = tallyHistory(effective, opts);
  const totalWeight = stats.tallies.reduce((s, t) => s + t.weight, 0);
  const allSame = stats.tallies.length === 1;
  const dom = stats.dominant!;
  const confidence = historyConfidence(dom.count, totalWeight > 0 ? dom.weight / totalWeight : 0, allSame, steps, P);
  const alternatives: Candidate[] = stats.tallies.slice(1).map((t) => ({
    source: level,
    accountCode: t.accountCode,
    accountName: accountNameOf(t.accountCode, t.accountName, ctx),
    // 같은 단계의 대안은 1순위를 넘지 않는다
    confidence: Math.min(confidence, historyConfidence(t.count, totalWeight > 0 ? t.weight / totalWeight : 0, false, steps, P)),
    tier: 'client',
  }));
  return {
    result: { level, stats, rawStats, supersededCount: superseded.length, biznoMismatch, confidence, alternatives },
    group,
  };
}

function analyzeCorrection(tx: NormalizedTransaction, ctx: ClassificationContext, group: readonly HistoryEntry[]): CorrectionResult | null {
  const events = correctionEvents(tx, ctx, group);
  const latest = events[events.length - 1];
  if (!latest) return null;
  let count = 0;
  for (const e of events) if (e.after === latest.after) count += 1;
  return {
    accountCode: latest.after,
    accountName: accountNameOf(latest.after, latest.afterName, ctx),
    fromCode: latest.before,
    count,
    total: events.length,
    date: latest.date,
    confidence: ladder(ctx.params.correctionLadder, count),
  };
}

function peerConfidence(clientCount: number, share: number, P: ClassifyParams): number {
  if (clientCount >= P.industryMinClients) {
    if (share >= P.industryMinAgreement) return P.industryStrongConfidence;
    return clampConfidence(P.industryWeakBase - Math.round((1 - share) * P.splitPenaltyScale));
  }
  if (clientCount === 2) return share >= 1 ? P.industryTwoClients : clampConfidence(P.industryTwoClients - Math.round(0.5 * P.splitPenaltyScale));
  return P.industryOneClient;
}

function summarizePeers(byClient: Map<string, HistoryEntry[]>, cross: boolean, ctx: ClassificationContext): PeerResult | null {
  if (byClient.size === 0) return null;
  const P = ctx.params;
  const opts = tallyOpts(ctx);
  // 거래처당 1표 (대형 거래처 한 곳이 패턴을 좌우하지 않도록)
  const votes = new Map<string, { clients: number; entries: number; name: string }>();
  let entryCount = 0;
  let lastUsed: LocalDate | null = null;
  const entryCountByAccount = new Map<string, number>();
  for (const entries of byClient.values()) {
    const st = tallyHistory(entries, opts);
    const dom = st.dominant;
    if (!dom) continue;
    entryCount += st.total;
    if (st.lastUsedDate && (!lastUsed || st.lastUsedDate > lastUsed)) lastUsed = st.lastUsedDate;
    for (const t of st.tallies) entryCountByAccount.set(t.accountCode, (entryCountByAccount.get(t.accountCode) ?? 0) + t.count);
    const v = votes.get(dom.accountCode);
    if (v) {
      v.clients += 1;
      v.entries += dom.count;
    } else votes.set(dom.accountCode, { clients: 1, entries: dom.count, name: dom.accountName });
  }
  const ranked = [...votes.entries()].sort((a, b) => {
    if (a[1].clients !== b[1].clients) return b[1].clients - a[1].clients;
    if (a[1].entries !== b[1].entries) return b[1].entries - a[1].entries;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const top = ranked[0];
  if (!top) return null;
  const clientCount = byClient.size;
  const share = top[1].clients / clientCount;
  const adjust = (c: number) => (cross ? Math.min(c - P.crossIndustryPenalty, P.crossIndustryCap) : c);
  const confidence = clampConfidence(adjust(peerConfidence(clientCount, share, P)));
  const alternatives: Candidate[] = ranked.slice(1).map(([code, v]) => ({
    source: 'industry_pattern',
    accountCode: code,
    accountName: accountNameOf(code, v.name, ctx),
    confidence: Math.min(confidence, clampConfidence(adjust(peerConfidence(clientCount, v.clients / clientCount, P)))),
    tier: 'global',
  }));
  return {
    accountCode: top[0],
    accountName: accountNameOf(top[0], top[1].name, ctx),
    confidence,
    clientCount,
    agreeingClients: top[1].clients,
    entryCount,
    consistentEntries: entryCountByAccount.get(top[0]) ?? 0,
    lastUsedDate: lastUsed,
    strong: clientCount >= P.industryMinClients && share >= P.industryMinAgreement,
    cross,
    alternatives,
  };
}

function analyzePeers(tx: NormalizedTransaction, ctx: ClassificationContext): { industry: PeerResult | null; cross: PeerResult | null } {
  const entries = lookupMerchant(ctx.peers, tx).filter(
    (e) =>
      e.clientId !== ctx.client.id &&
      // 사업자번호가 서로 다르면 동명의 다른 상대방
      !(tx.merchantBusinessNumber && e.merchantBusinessNumber && e.merchantBusinessNumber !== tx.merchantBusinessNumber) &&
      isAccountCompatible(e.accountCode, tx.direction, ctx.accounts) &&
      isUsableAccount(e.accountCode, ctx),
  );
  if (entries.length === 0) return { industry: null, cross: null };
  const all = new Map<string, HistoryEntry[]>();
  const same = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    (all.get(e.clientId) ?? all.set(e.clientId, []).get(e.clientId)!).push(e);
    if (e.industry === ctx.client.industry) (same.get(e.clientId) ?? same.set(e.clientId, []).get(e.clientId)!).push(e);
  }
  return { industry: summarizePeers(same, false, ctx), cross: summarizePeers(all, true, ctx) };
}

function merchantAnalysis(tx: NormalizedTransaction, ctx: ClassificationContext): MerchantAnalysis {
  const key = `${tx.direction}|${tx.merchantBusinessNumber ?? ''}|${tx.merchantKey}`;
  const hit = ctx.cache.get(key);
  if (hit) return hit;
  const { result: history, group } = analyzeHistory(tx, ctx);
  const correction = analyzeCorrection(tx, ctx, group);
  const { industry, cross } = analyzePeers(tx, ctx);
  const a: MerchantAnalysis = { history, correction, industry, cross };
  ctx.cache.set(key, a);
  return a;
}

// ────────────────────────────── 분류 ──────────────────────────────

const LEVEL_RANK: Record<ClassificationSource, number> = {
  user_rule: 1,
  exact_history: 2,
  name_history: 3,
  correction_memory: 4,
  industry_pattern: 5,
  system_rule: 6,
  ai: 7,
  manual: 0,
  none: 9,
};

const LEVEL_LABEL: Partial<Record<ClassificationSource, string>> = {
  user_rule: '사용자 규칙',
  exact_history: '과거 이력(사업자번호)',
  name_history: '과거 이력(상호)',
  correction_memory: '최근 수정',
  industry_pattern: '업종 패턴',
  system_rule: '시스템 기본사전',
};

interface Winner {
  candidate: Candidate;
  facts: Omit<ExplainFacts, 'source' | 'merchantName' | 'accountName' | 'evidence'>;
  evidence: ClassificationEvidence;
  /** 이력 기반 금액 점검 대상 통계 */
  amountStats: HistoryStats | null;
}

function historyEvidence(stats: HistoryStats | null, accountCode: string | null): ClassificationEvidence {
  if (!stats || stats.total === 0) return { historyCount: 0 };
  const ev: ClassificationEvidence = {
    historyCount: stats.total,
    consistentCount: accountCode ? (stats.tallies.find((t) => t.accountCode === accountCode)?.count ?? 0) : stats.consistentCount,
  };
  if (stats.lastUsedDate) ev.lastUsedDate = stats.lastUsedDate;
  if (stats.averageAmount !== null) ev.averageAmount = stats.averageAmount;
  return ev;
}

function correctionFacts(c: CorrectionResult | null, ctx: ClassificationContext): ExplainFacts['correction'] {
  if (!c) return null;
  return {
    fromName: c.fromCode ? accountNameOf(c.fromCode, c.fromCode, ctx) : null,
    toName: c.accountName,
    count: c.count,
    date: c.date,
  };
}

function ruleCandidate(r: CompiledRule, source: ClassificationSource, ctx: ClassificationContext, confidence = r.confidence): Candidate {
  return {
    source,
    accountCode: r.rule.accountCode,
    accountName: accountNameOf(r.rule.accountCode, r.rule.accountName, ctx),
    confidence: clampConfidence(confidence),
    tier: source === 'user_rule' ? 'client' : 'global',
  };
}

function peerCandidate(p: PeerResult): Candidate {
  return { source: 'industry_pattern', accountCode: p.accountCode, accountName: p.accountName, confidence: p.confidence, tier: 'global' };
}

function safeDescribe(cond: Condition): string | undefined {
  try {
    return describeCondition(cond);
  } catch {
    return undefined;
  }
}

function peerEvidence(p: PeerResult): ClassificationEvidence {
  const ev: ClassificationEvidence = { historyCount: p.entryCount, consistentCount: p.consistentEntries, peerClientCount: p.clientCount };
  if (p.lastUsedDate) ev.lastUsedDate = p.lastUsedDate;
  return ev;
}

function peerWinner(p: PeerResult, industryLabel: string): Winner {
  return {
    candidate: peerCandidate(p),
    facts: { industryLabel, crossIndustry: p.cross, agreeingClientCount: p.agreeingClients },
    evidence: peerEvidence(p),
    amountStats: null,
  };
}

/**
 * 한 거래의 계정과목 판단.
 * 단계 순서: user_rule → (exact_history | name_history ↔ correction_memory) → industry_pattern(강) → system_rule
 *           → industry_pattern(약·타업종) → none.
 */
export function classifyAccount(tx: NormalizedTransaction, ctx: ClassificationContext): AccountClassification {
  if (tx.clientId !== ctx.client.id) {
    throw new Error(`classifyAccount: 거래의 clientId(${tx.clientId})가 컨텍스트 거래처(${ctx.client.id})와 다릅니다`);
  }
  const P = ctx.params;
  const cc = transactionConditionContext(tx, ctx.client);
  const text = txText(cc);
  const userMatches = matchRules(ctx.userRules, cc, text, tx, ctx, false);
  const sysMatches = matchRules(ctx.systemRules, cc, text, tx, ctx, true);
  const ma = merchantAnalysis(tx, ctx);
  const hist = ma.history;
  const corr = ma.correction;
  const industryLabel = INDUSTRY_LABELS_KO[ctx.client.industry] ?? ctx.client.industry;

  // 모든 후보 (대안·교차확인용)
  const pool: Candidate[] = [];
  userMatches.forEach((r, i) => pool.push(ruleCandidate(r, 'user_rule', ctx, i === 0 ? r.confidence : r.confidence - P.shadowedRulePenalty)));
  if (hist?.stats?.dominant) {
    const d = hist.stats.dominant;
    pool.push({ source: hist.level, accountCode: d.accountCode, accountName: accountNameOf(d.accountCode, d.accountName, ctx), confidence: hist.confidence, tier: 'client' });
    pool.push(...hist.alternatives);
  }
  if (corr) pool.push({ source: 'correction_memory', accountCode: corr.accountCode, accountName: corr.accountName, confidence: corr.confidence, tier: 'client' });
  if (ma.industry) pool.push(peerCandidate(ma.industry), ...ma.industry.alternatives);
  if (ma.cross) pool.push(peerCandidate(ma.cross), ...ma.cross.alternatives);
  sysMatches.forEach((r, i) => pool.push(ruleCandidate(r, 'system_rule', ctx, i === 0 ? r.confidence : r.confidence - P.shadowedRulePenalty)));

  // ── 1순위 결정 ──
  let winner: Winner | null = null;
  const topUser = userMatches[0];
  if (topUser) {
    winner = {
      candidate: ruleCandidate(topUser, 'user_rule', ctx),
      facts: { ruleName: topUser.rule.name, ruleConditionText: safeDescribe(topUser.rule.condition), rulePriority: topUser.rule.priority },
      evidence: { ruleId: topUser.rule.id, ruleName: topUser.rule.name, ...historyEvidence(hist?.stats ?? hist?.rawStats ?? null, topUser.rule.accountCode) },
      amountStats: null,
    };
  } else if (hist?.stats?.dominant || corr) {
    const d = hist?.stats?.dominant ?? null;
    const histCand: Candidate | null =
      hist && d
        ? { source: hist.level, accountCode: d.accountCode, accountName: accountNameOf(d.accountCode, d.accountName, ctx), confidence: hist.confidence, tier: 'client' }
        : null;
    const corrCand: Candidate | null = corr
      ? { source: 'correction_memory', accountCode: corr.accountCode, accountName: corr.accountName, confidence: corr.confidence, tier: 'client' }
      : null;
    // 이력과 수정이 같은 계정이면 더 높은 쪽, 다르면 (수정 우선 원칙 적용 후의) 이력이 이긴다
    const useCorrection = !histCand || (corrCand !== null && corrCand.accountCode === histCand.accountCode && corrCand.confidence > histCand.confidence);
    if (useCorrection && corrCand) {
      const stats = hist?.stats ?? hist?.rawStats ?? null;
      winner = {
        candidate: corrCand,
        facts: { correction: correctionFacts(corr, ctx), supersededCount: hist?.supersededCount ?? 0 },
        evidence: historyEvidence(stats, corrCand.accountCode),
        amountStats: stats,
      };
    } else if (histCand && hist?.stats) {
      winner = {
        candidate: histCand,
        facts: {
          matchedBy: hist.level === 'exact_history' ? 'bizno' : 'name',
          biznoMismatch: hist.biznoMismatch,
          supersededCount: hist.supersededCount,
          correction: corr && corr.accountCode === histCand.accountCode ? correctionFacts(corr, ctx) : null,
        },
        evidence: historyEvidence(hist.stats, histCand.accountCode),
        amountStats: hist.stats,
      };
    }
  }
  if (!winner && ma.industry?.strong) winner = peerWinner(ma.industry, industryLabel);
  const topSys = sysMatches[0];
  if (!winner && topSys) {
    winner = {
      candidate: ruleCandidate(topSys, 'system_rule', ctx),
      facts: { ruleName: topSys.rule.name, ruleNote: topSys.note },
      evidence: { ruleId: topSys.rule.id, ruleName: topSys.rule.name, historyCount: 0 },
      amountStats: null,
    };
  }
  if (!winner) {
    const weak = [ma.industry, ma.cross].filter((p): p is PeerResult => !!p).sort((a, b) => b.confidence - a.confidence || (a.cross ? 1 : 0) - (b.cross ? 1 : 0));
    if (weak[0]) winner = peerWinner(weak[0], industryLabel);
  }

  const correctionCount = corr?.total ?? 0;
  const peerClientCount = ma.industry?.clientCount ?? 0;

  if (!winner) {
    const evidence: ClassificationEvidence = { historyCount: 0, consistentCount: 0, correctionCount, peerClientCount };
    const facts: ExplainFacts = { source: 'none', merchantName: tx.merchantName || tx.merchantKey, accountName: null, evidence };
    return {
      accountCode: null,
      accountName: null,
      confidence: 0,
      source: 'none',
      summary: buildSummary(facts),
      reasons: buildReasons(facts),
      evidence,
      alternatives: [],
    };
  }

  // ── 보정: 금액 이상치, 계정표 확인 ──
  const w = winner.candidate;
  let confidence = w.confidence;
  const warnings: string[] = [];
  let amount: ExplainFacts['amount'] = null;
  const st = winner.amountStats;
  if (st && st.averageAmount !== null && st.averageAmount > 0 && st.total >= P.amountDeviationMinHistory) {
    const ratio = Math.abs(tx.totalAmount) / st.averageAmount;
    const deviated = ratio > P.amountDeviationMultiplier;
    if (deviated) confidence -= P.amountDeviationPenalty;
    amount = { value: tx.totalAmount, average: st.averageAmount, ratio, deviated, penalty: deviated ? P.amountDeviationPenalty : 0 };
  }
  const acc = ctx.accounts.get(w.accountCode);
  if (!acc) {
    warnings.push(`계정과목표에 없는 코드(${w.accountCode}) — 계정 확인 필요`);
    confidence = Math.min(confidence, P.unknownAccountCap);
  } else if (!acc.active) {
    warnings.push(`비활성 계정(${acc.code} ${acc.name}) — 계정 확인 필요`);
    confidence = Math.min(confidence, P.unknownAccountCap);
  }
  confidence = clampConfidence(confidence);

  // ── 교차확인 + 대안 ──
  const corroborations: string[] = [];
  const seenLevels = new Set<ClassificationSource>([w.source]);
  for (const c of pool) {
    if (c.accountCode !== w.accountCode || seenLevels.has(c.source)) continue;
    seenLevels.add(c.source);
    const label = LEVEL_LABEL[c.source];
    if (label) corroborations.push(`${label}도 동일 계정`);
  }

  // 거래처 고유 판단(규칙·이력·수정)이 이겼으면 타 거래처·전역 후보는 충돌을 만들지 못하게 상한을 둔다.
  // 사용자 승인 규칙은 의도된 결정이므로 모든 대안이 참고용이다.
  const quietCap = Math.max(0, confidence - P.conflictGap - 1);
  const best = new Map<string, Candidate>();
  for (const c of pool) {
    if (c.accountCode === w.accountCode) continue;
    if (c.tier === 'global' && !isUsableAccount(c.accountCode, ctx)) continue;
    let conf = c.confidence;
    if (w.source === 'user_rule' || (w.tier === 'client' && c.tier === 'global')) conf = Math.min(conf, quietCap);
    const cand = { ...c, confidence: clampConfidence(conf) };
    const prev = best.get(c.accountCode);
    if (!prev || cand.confidence > prev.confidence || (cand.confidence === prev.confidence && LEVEL_RANK[cand.source] < LEVEL_RANK[prev.source])) {
      best.set(c.accountCode, cand);
    }
  }
  const alternatives = [...best.values()]
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        LEVEL_RANK[a.source] - LEVEL_RANK[b.source] ||
        (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0),
    )
    .slice(0, P.maxAlternatives)
    .map((c) => ({ accountCode: c.accountCode, accountName: c.accountName, confidence: c.confidence, source: c.source }));

  const evidence: ClassificationEvidence = { ...winner.evidence, correctionCount };
  if (evidence.peerClientCount === undefined) evidence.peerClientCount = peerClientCount;
  const accountName = acc?.name ?? w.accountName;
  const facts: ExplainFacts = {
    ...winner.facts,
    source: w.source,
    merchantName: tx.merchantName || tx.merchantKey,
    accountName,
    evidence,
    amount,
    corroborations,
    warnings,
  };
  return {
    accountCode: w.accountCode,
    accountName,
    confidence,
    source: w.source,
    summary: buildSummary(facts),
    reasons: buildReasons(facts),
    evidence,
    alternatives,
  };
}

/** 여러 거래 일괄 분류 (같은 거래처 컨텍스트) */
export function classifyAccounts(txs: readonly NormalizedTransaction[], ctx: ClassificationContext): AccountClassification[] {
  return txs.map((t) => classifyAccount(t, ctx));
}

/** 1순위와 신뢰도 차이가 gap 이내인 다른 계정 후보가 있는가 (account_conflict 버킷) */
export function hasAccountConflict(c: AccountClassification, gap: number = CLASSIFY_PARAMS.conflictGap): boolean {
  if (!c.accountCode) return false;
  return c.alternatives.some((a) => a.accountCode !== c.accountCode && a.confidence >= c.confidence - gap);
}
