import type {
  AccountClassification,
  ClientProfile,
  Condition,
  ConditionLeaf,
  EvidenceType,
  ExceptionBucket,
  HistoryEntry,
  LocalDate,
  NormalizedTransaction,
  RiskFlag,
  RiskSeverity,
  VatClassification,
  Won,
  YearMonth,
} from '../types';
import { possibleDuplicateKey } from '../fingerprint';
import { formatWon } from '../money';
import { previousYearMonth, yearMonthOf } from '../normalize';
import {
  REVIEW_RULE_KINDS,
  type ReviewRuleDef,
  type ReviewRuleKind,
  type RuleParamValue,
} from '../data/review-rules';
import {
  FactView,
  buildRuleFacts,
  compileCondition,
  resolveRulesForClient,
  validateRuleCondition,
  type CompiledCondition,
} from './vat';

// ═══════════════════════════════ 과거 이력 인덱스 ═══════════════════════════════

export interface MerchantHistorySummary {
  count: number;
  dominantAccountCode: string;
  dominantAccountName: string;
  dominantCount: number;
  lastDate: LocalDate;
  /** 계정코드 → 건수 */
  accountCounts: Map<string, number>;
}

export interface ClientHistoryIndex {
  /** 상대방 사업자번호 → 요약 */
  byBusinessNumber: Map<string, MerchantHistorySummary>;
  /** 정규화 상호키 → 요약 (사업자번호 유무와 무관하게 전부) */
  byMerchantKey: Map<string, MerchantHistorySummary>;
  /** possibleDuplicateKey → 이력 건수 */
  duplicateKeys: Map<string, number>;
  size: number;
}

function summarize(entries: HistoryEntry[]): MerchantHistorySummary {
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  const lastByCode = new Map<string, string>();
  let lastDate = '';
  for (const e of entries) {
    counts.set(e.accountCode, (counts.get(e.accountCode) ?? 0) + 1);
    const prevLast = lastByCode.get(e.accountCode) ?? '';
    if (e.transactionDate >= prevLast) {
      lastByCode.set(e.accountCode, e.transactionDate);
      names.set(e.accountCode, e.accountName);
    }
    if (e.transactionDate > lastDate) lastDate = e.transactionDate;
  }
  let dom = '';
  let domCount = -1;
  for (const [code, c] of counts) {
    const better =
      c > domCount ||
      (c === domCount && ((lastByCode.get(code) ?? '') > (lastByCode.get(dom) ?? '') ||
        ((lastByCode.get(code) ?? '') === (lastByCode.get(dom) ?? '') && code < dom)));
    if (better) {
      dom = code;
      domCount = c;
    }
  }
  return {
    count: entries.length,
    dominantAccountCode: dom,
    dominantAccountName: names.get(dom) ?? dom,
    dominantCount: Math.max(0, domCount),
    lastDate,
    accountCounts: counts,
  };
}

/** 수임처 과거 확정 이력 → 조회 인덱스 (한 번 만들어 배치 전체에서 재사용) */
export function buildClientHistoryIndex(entries: readonly HistoryEntry[]): ClientHistoryIndex {
  const byBiz = new Map<string, HistoryEntry[]>();
  const byKey = new Map<string, HistoryEntry[]>();
  const dup = new Map<string, number>();
  for (const e of entries) {
    if (e.merchantBusinessNumber) push(byBiz, e.merchantBusinessNumber, e);
    if (e.merchantKey) push(byKey, e.merchantKey, e);
    const k = possibleDuplicateKey(e);
    dup.set(k, (dup.get(k) ?? 0) + 1);
  }
  const toSummary = (m: Map<string, HistoryEntry[]>) => new Map([...m].map(([k, v]) => [k, summarize(v)] as const));
  return { byBusinessNumber: toSummary(byBiz), byMerchantKey: toSummary(byKey), duplicateKeys: dup, size: entries.length };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

export function lookupMerchantHistory(
  index: ClientHistoryIndex | null | undefined,
  tx: Pick<NormalizedTransaction, 'merchantBusinessNumber' | 'merchantKey'>,
): MerchantHistorySummary | null {
  if (!index) return null;
  return (
    (tx.merchantBusinessNumber ? index.byBusinessNumber.get(tx.merchantBusinessNumber) : undefined) ??
    (tx.merchantKey ? index.byMerchantKey.get(tx.merchantKey) : undefined) ??
    null
  );
}

// ═══════════════════════════════ 규칙 파라미터 ═══════════════════════════════

/** client_business_profiles.rule_params 형식: { '<code>.<param>': 값 } */
export type ClientRuleParams = Record<string, number | string | boolean>;

/** 규칙 기본 params 에 수임처 override 를 적용 (기본값 타입으로 변환) */
export function resolveRuleParams(rule: Pick<ReviewRuleDef, 'code' | 'params'>, overrides?: ClientRuleParams | null): Record<string, RuleParamValue> {
  const out: Record<string, RuleParamValue> = { ...rule.params };
  if (!overrides) return out;
  const prefix = `${rule.code}.`;
  for (const [k, raw] of Object.entries(overrides)) {
    if (!k.startsWith(prefix)) continue;
    const name = k.slice(prefix.length);
    const base = rule.params[name];
    if (Array.isArray(base)) {
      out[name] = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [String(raw)];
    } else if (typeof base === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(n)) out[name] = n;
    } else if (typeof base === 'boolean') {
      out[name] = raw === true || raw === 'true';
    } else {
      out[name] = raw;
    }
  }
  return out;
}

/** 조건 안의 '$이름' 을 params 값으로 치환 */
export function bindParams(cond: Condition, params: Record<string, RuleParamValue>): Condition {
  if ('all' in cond) return { all: cond.all.map((c) => bindParams(c, params)) };
  if ('any' in cond) return { any: cond.any.map((c) => bindParams(c, params)) };
  if ('not' in cond) return { not: bindParams(cond.not, params) };
  const v = cond.value;
  const sub = (x: unknown): unknown => (typeof x === 'string' && x.startsWith('$') && x.slice(1) in params ? params[x.slice(1)] : x);
  let value: ConditionLeaf['value'] = v;
  if (typeof v === 'string') value = sub(v) as ConditionLeaf['value'];
  else if (Array.isArray(v)) value = v.flatMap((x) => sub(x) as string | number | Array<string | number>);
  return { ...cond, value };
}

function unboundParams(cond: Condition): string[] {
  if ('all' in cond) return cond.all.flatMap(unboundParams);
  if ('any' in cond) return cond.any.flatMap(unboundParams);
  if ('not' in cond) return unboundParams(cond.not);
  const vals = Array.isArray(cond.value) ? cond.value : [cond.value];
  return vals.filter((x): x is string => typeof x === 'string' && x.startsWith('$')).map((x) => x.slice(1));
}

const BUCKETS: readonly ExceptionBucket[] = [
  'low_confidence', 'new_merchant', 'vat_review', 'account_conflict', 'changed_from_history', 'high_amount', 'duplicate',
  'unclassified', 'possible_asset', 'personal_use', 'entertainment', 'vehicle', 'foreign', 'spike', 'export_error',
];
const SEVERITIES: readonly RiskSeverity[] = ['info', 'warning', 'high'];

const REQUIRED_NUMERIC_PARAMS: Partial<Record<ReviewRuleKind, string[]>> = {
  high_amount: ['threshold'],
  new_merchant_high_amount: ['threshold'],
  repeated_abnormal: ['count'],
  account_spike: ['ratio', 'minAmount', 'lookbackMonths'],
  changed_from_history: ['minHistory', 'minShare'],
};

/** Rule Studio 저장 전 검증. 오류 메시지 배열 (빈 배열이면 정상) */
export function validateReviewRule(rule: ReviewRuleDef, overrides?: ClientRuleParams | null): string[] {
  const errs: string[] = [];
  if (!rule.code) errs.push('code: 규칙 코드가 비어 있습니다');
  if (!REVIEW_RULE_KINDS.includes(rule.kind)) errs.push(`kind: 알 수 없는 규칙 종류 ${String(rule.kind)}`);
  if (!BUCKETS.includes(rule.bucket)) errs.push(`bucket: 알 수 없는 버킷 ${String(rule.bucket)}`);
  if (!SEVERITIES.includes(rule.severity)) errs.push(`severity: 알 수 없는 심각도 ${String(rule.severity)}`);
  if (!rule.messageTemplate) errs.push('messageTemplate: 안내 문구가 비어 있습니다');
  const params = resolveRuleParams(rule, overrides);
  if (rule.kind === 'condition' && !rule.condition) errs.push('condition: condition 규칙에는 조건이 필요합니다');
  if (rule.condition) {
    for (const p of unboundParams(bindParams(rule.condition, params))) errs.push(`condition: 파라미터 '${p}' 값이 없습니다`);
    errs.push(...validateRuleCondition(bindParams(rule.condition, params)));
  }
  for (const p of REQUIRED_NUMERIC_PARAMS[rule.kind] ?? []) {
    if (typeof params[p] !== 'number' || !Number.isFinite(params[p])) errs.push(`params.${p}: 숫자 값이 필요합니다`);
  }
  return errs;
}

// ═══════════════════════════════ 위험 평가 ═══════════════════════════════

export interface AccountMonthlyTotal {
  period: YearMonth;
  total: Won;
}

export interface RiskContext {
  client: ClientProfile;
  rules: readonly ReviewRuleDef[];
  /** 수임처 과거 확정 이력 인덱스 (이번 배치 거래는 포함하지 않는다) */
  clientHistoryIndex?: ClientHistoryIndex | null;
  /** 같은 수임처·같은 기간의 이번 배치 전체 */
  batch: readonly NormalizedTransaction[];
  /**
   * 계정별 월합계 (이번 배치 제외). 이번 달 값이 있으면 배치 합계에 더해진다.
   * 직전 lookbackMonths 개월로 평균을 낸다 (자료 없는 달은 0).
   */
  accountMonthlyTotals?: Record<string, AccountMonthlyTotal[]>;
  /** batch 와 같은 순서의 계정 분류 결과 코드 — 이번 달 계정 합계 계산용 */
  batchAccountCodes?: ReadonlyArray<string | null>;
  /** client_business_profiles.rule_params */
  ruleParams?: ClientRuleParams | null;
}

interface CompiledReviewRule {
  rule: ReviewRuleDef;
  params: Record<string, RuleParamValue>;
  filter: CompiledCondition | null;
}

export interface PreparedRiskBatch {
  rules: CompiledReviewRule[];
  members: Set<NormalizedTransaction>;
  dupCounts: Map<string, number>;
  sameDayCounts: Map<string, number>;
  /** `${period}|${accountCode}` → 이번 배치 합계 */
  batchAccountTotals: Map<string, number>;
  hasBatchAccounts: boolean;
  spikeCache: Map<string, SpikeResult | null>;
}

export interface PreparedRiskContext extends RiskContext {
  prepared: PreparedRiskBatch;
}

interface SpikeResult {
  current: number;
  average: number;
  ratio: number;
}

const preparedCache = new WeakMap<RiskContext, PreparedRiskBatch>();

const merchantParty = (t: Pick<NormalizedTransaction, 'merchantBusinessNumber' | 'merchantKey'>) => t.merchantBusinessNumber || t.merchantKey;

/**
 * 배치 단위 사전계산: 규칙 컴파일(파라미터 바인딩), 중복의심 키 집계, 같은 날 같은 가맹점 집계, 계정 월합계.
 * 이후 evaluateRisks() 는 거래당 O(규칙 수).
 */
export function prepareRiskBatch(ctx: RiskContext): PreparedRiskContext {
  const rules: CompiledReviewRule[] = resolveRulesForClient(ctx.rules, ctx.client.id)
    .filter((r) => REVIEW_RULE_KINDS.includes(r.kind))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((rule) => {
      const params = resolveRuleParams(rule, ctx.ruleParams);
      return { rule, params, filter: rule.condition ? compileCondition(bindParams(rule.condition, params)) : null };
    });

  const dupCounts = new Map<string, number>();
  const sameDayCounts = new Map<string, number>();
  const batchAccountTotals = new Map<string, number>();
  const codes = ctx.batchAccountCodes;
  ctx.batch.forEach((t, i) => {
    const dk = possibleDuplicateKey(t);
    dupCounts.set(dk, (dupCounts.get(dk) ?? 0) + 1);
    const sk = `${t.transactionDate}|${merchantParty(t)}`;
    sameDayCounts.set(sk, (sameDayCounts.get(sk) ?? 0) + 1);
    const code = codes?.[i];
    if (code) {
      const ak = `${yearMonthOf(t.transactionDate)}|${code}`;
      batchAccountTotals.set(ak, (batchAccountTotals.get(ak) ?? 0) + t.totalAmount);
    }
  });

  const prepared: PreparedRiskBatch = {
    rules,
    members: new Set(ctx.batch),
    dupCounts,
    sameDayCounts,
    batchAccountTotals,
    hasBatchAccounts: !!codes && codes.length === ctx.batch.length,
    spikeCache: new Map(),
  };
  preparedCache.set(ctx, prepared);
  return { ...ctx, prepared };
}

function getPrepared(ctx: RiskContext | PreparedRiskContext): PreparedRiskBatch {
  if ('prepared' in ctx && ctx.prepared) return ctx.prepared;
  return preparedCache.get(ctx) ?? prepareRiskBatch(ctx).prepared;
}

const EVIDENCE_LABEL: Record<EvidenceType, string> = {
  tax_invoice: '세금계산서',
  invoice_exempt: '계산서',
  card: '카드',
  cash_receipt: '현금영수증',
  bank: '통장',
  other: '기타증빙',
};
const WEEKDAY_LABEL = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

/** {이름} 치환. 없는 이름은 그대로 둔다 */
export function fillTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? m : String(v);
  });
}

function formatParam(name: string, v: RuleParamValue): string {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'number') return /threshold|amount/i.test(name) ? formatWon(v) : v.toLocaleString('ko-KR');
  return String(v);
}

function computeSpike(
  code: string,
  period: YearMonth,
  ctx: RiskContext,
  prep: PreparedRiskBatch,
  params: Record<string, RuleParamValue>,
): SpikeResult | null {
  const cacheKey = `${period}|${code}|${String(params.lookbackMonths)}`;
  if (prep.spikeCache.has(cacheKey)) return prep.spikeCache.get(cacheKey)!;
  const series = ctx.accountMonthlyTotals?.[code] ?? [];
  const byPeriod = new Map<string, number>();
  for (const s of series) byPeriod.set(s.period, (byPeriod.get(s.period) ?? 0) + s.total);
  const lookback = Math.max(1, Math.trunc(Number(params.lookbackMonths) || 3));
  let result: SpikeResult | null = null;
  const stored = byPeriod.get(period);
  const batchPart = prep.batchAccountTotals.get(`${period}|${code}`);
  if (stored !== undefined || (prep.hasBatchAccounts && batchPart !== undefined)) {
    const current = (stored ?? 0) + (batchPart ?? 0);
    let p = period;
    let sum = 0;
    let months = 0;
    for (let i = 0; i < lookback; i++) {
      p = previousYearMonth(p);
      const v = byPeriod.get(p);
      if (v !== undefined) months++;
      sum += v ?? 0;
    }
    const average = sum / lookback;
    if (months > 0 && average > 0) result = { current, average, ratio: current / average };
  }
  prep.spikeCache.set(cacheKey, result);
  return result;
}

/**
 * 한 거래의 고위험 플래그. prepareRiskBatch() 결과를 넘기면 거래당 O(규칙 수).
 * (준비되지 않은 RiskContext 를 넘기면 첫 호출에서 준비해 캐시한다)
 */
export function evaluateRisks(
  tx: NormalizedTransaction,
  account: AccountClassification,
  vat: VatClassification | null,
  ctx: RiskContext | PreparedRiskContext,
): RiskFlag[] {
  const prep = getPrepared(ctx);
  const view = new FactView(buildRuleFacts(tx, account, ctx.client, vat));
  const hour = view.raw('hour') as number | null;
  const weekday = view.raw('weekday') as number | null;
  const baseVars: Record<string, string | number | null> = {
    merchantName: tx.merchantName || '(상호 없음)',
    date: tx.transactionDate,
    amount: formatWon(tx.totalAmount),
    supplyAmount: formatWon(tx.supplyAmount),
    vatAmount: formatWon(tx.vatAmount),
    accountCode: account.accountCode ?? '-',
    accountName: account.accountName ?? '미분류',
    evidenceLabel: EVIDENCE_LABEL[tx.evidenceType] ?? tx.evidenceType,
    currency: tx.currency,
    vatSummary: vat?.summary ?? '',
    when: [weekday !== null ? WEEKDAY_LABEL[weekday] : null, hour !== null ? `${hour}시` : null].filter(Boolean).join(' '),
  };
  const isMember = prep.members.has(tx);
  const history = ctx.clientHistoryIndex ?? null;
  const flags: RiskFlag[] = [];

  for (const { rule, params, filter } of prep.rules) {
    if (filter && !filter(view)) continue;
    let extra: Record<string, string | number> | null = null;
    switch (rule.kind) {
      case 'condition':
        extra = {};
        break;
      case 'high_amount': {
        const th = Number(params.threshold);
        if (Number.isFinite(th) && Math.abs(tx.totalAmount) >= th) extra = {};
        break;
      }
      case 'new_merchant_high_amount': {
        const th = Number(params.threshold);
        if (Number.isFinite(th) && Math.abs(tx.totalAmount) >= th && !lookupMerchantHistory(history, tx)) extra = {};
        break;
      }
      case 'duplicate_amount': {
        const k = possibleDuplicateKey(tx);
        const inBatch = (prep.dupCounts.get(k) ?? 0) - (isMember ? 1 : 0);
        const inHistory = params.includeHistory === false ? 0 : history?.duplicateKeys.get(k) ?? 0;
        if (inBatch + inHistory > 0) {
          const src = [inBatch > 0 ? `이번 자료 ${inBatch + 1}건` : '', inHistory > 0 ? `기존 등록 ${inHistory}건` : ''].filter(Boolean).join(', ');
          extra = { duplicateCount: inBatch + inHistory + 1, duplicateSource: src ? ` — ${src}` : '' };
        }
        break;
      }
      case 'repeated_abnormal': {
        const n = (prep.sameDayCounts.get(`${tx.transactionDate}|${merchantParty(tx)}`) ?? 0) + (isMember ? 0 : 1);
        const min = Number(params.count);
        if (Number.isFinite(min) && n >= min) extra = { sameDayCount: n };
        break;
      }
      case 'changed_from_history': {
        if (!account.accountCode) break;
        if (params.skipManual !== false && account.source === 'manual') break;
        const h = lookupMerchantHistory(history, tx);
        if (!h || !h.dominantAccountCode) break;
        const minHistory = Number(params.minHistory);
        const minShare = Number(params.minShare);
        if (h.count >= minHistory && h.dominantCount / h.count >= minShare && h.dominantAccountCode !== account.accountCode) {
          extra = {
            historyCount: h.count,
            dominantCount: h.dominantCount,
            dominantAccountCode: h.dominantAccountCode,
            dominantAccountName: h.dominantAccountName,
          };
        }
        break;
      }
      case 'account_spike': {
        if (!account.accountCode) break;
        const s = computeSpike(account.accountCode, yearMonthOf(tx.transactionDate), ctx, prep, params);
        const ratio = Number(params.ratio);
        const minAmount = Number(params.minAmount);
        if (s && s.current >= minAmount && s.current >= ratio * s.average) {
          extra = {
            monthTotal: formatWon(s.current),
            averageTotal: formatWon(Math.round(s.average)),
            changeRatio: (Math.round(s.ratio * 10) / 10).toFixed(1),
          };
        }
        break;
      }
      case 'unbalanced': {
        const components = tx.supplyAmount + tx.vatAmount + tx.serviceCharge;
        const diff = tx.totalAmount - components;
        if (diff !== 0) extra = { componentsTotal: formatWon(components), diff: formatWon(Math.abs(diff)) };
        break;
      }
    }
    if (!extra) continue;
    const vars: Record<string, string | number | null> = { ...baseVars };
    for (const [k, v] of Object.entries(params)) vars[k] = formatParam(k, v);
    Object.assign(vars, extra);
    flags.push({
      ruleCode: rule.code,
      ruleName: rule.name,
      bucket: rule.bucket,
      severity: rule.severity,
      blocksAutoApproval: rule.blocksAutoApproval,
      message: fillTemplate(rule.messageTemplate, vars),
    });
  }
  return flags;
}
