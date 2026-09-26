import type {
  AccountClassification,
  ClientProfile,
  Condition,
  ConditionField,
  ConditionLeaf,
  NormalizedTransaction,
  VatClassification,
  VatType,
} from '../types';
import { FIELD_LABELS, validateCondition } from '../dsl';
import { weekdayOf } from '../normalize';
import {
  DEFAULT_VAT_ENGINE_OPTIONS,
  type VatEngineOptions,
  type VatRuleDef,
  type VatRuleOutcome,
} from '../data/vat-rules';

// ═══════════════════════════════ 규칙 평가 공통 (VAT · Risk 공용) ═══════════════════════════════

/**
 * 규칙 조건이 참조할 수 있는 필드 = 계약 DSL 필드 + 엔진 가상 필드.
 * 가상 필드는 거래 한 건과 수임처 프로필에서 결정적으로 계산된다.
 */
export type RuleFactField =
  | ConditionField
  | 'searchText' // 상호 + 가맹점 업종 + 적요 (용도 키워드 매칭용)
  | 'merchantText' // 상호 + 가맹점 업종 (공급자 업종 판정용 — 적요 제외)
  | 'accountName'
  | 'clientVatType' // 수임처 과세유형
  | 'clientBusinessType' // corporation | individual
  | 'sourceDeductibleHint' // 원천 공제여부 힌트 (true/false/null)
  | 'vehicleMatched' // 수임처 불공제 차량번호가 거래 텍스트에 등장
  | 'clientHasVehicles' // 수임처에 불공제 차량이 등록되어 있음
  | 'hour' // 원본 행에 시각이 있으면 0~23, 없으면 null
  | 'serviceCharge'
  // Risk 평가 시에만 채워짐 (부가세 판단 결과)
  | 'vatType'
  | 'deductible';

export const RULE_FACT_LABELS: Record<RuleFactField, string> = {
  ...FIELD_LABELS,
  searchText: '상호·업종·적요',
  merchantText: '상호·업종',
  accountName: '계정명',
  clientVatType: '수임처 과세유형',
  clientBusinessType: '수임처 사업자구분',
  sourceDeductibleHint: '원천 공제여부',
  vehicleMatched: '불공제 차량 연결',
  clientHasVehicles: '불공제 차량 등록 여부',
  hour: '거래 시각',
  serviceCharge: '봉사료',
  vatType: '부가세 유형',
  deductible: '공제 여부',
};

export type RuleFacts = Partial<Record<RuleFactField, string | number | boolean | null>>;

const TIME_KEYS = ['승인시간', '승인시각', '거래시간', '거래시각', '이용시간', '이용시각', '결제시간', '승인일시', '거래일시', '이용일시', '결제일시', 'time', 'approvedAt'];

/** 원본 행(rawData)에서 시(hour) 추출. 없거나 해석 불가면 null */
export function extractHour(rawData: Record<string, unknown> | null | undefined): number | null {
  if (!rawData) return null;
  for (const key of TIME_KEYS) {
    const v = rawData[key];
    if (v === null || v === undefined || v === '') continue;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getUTCHours();
    const s = String(v).trim();
    const m = s.match(/(\d{1,2}):(\d{2})/);
    if (m) {
      const h = Number(m[1]);
      return h >= 0 && h <= 23 ? h : null;
    }
    // HHMMSS / HHMM (시간 전용 컬럼일 때만)
    if (/시간|시각|time/i.test(key) && /^\d{4}(\d{2})?$/.test(s)) {
      const h = Number(s.slice(0, 2));
      return h >= 0 && h <= 23 ? h : null;
    }
  }
  return null;
}

function compactPlate(s: string): string {
  return s.normalize('NFKC').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * 수임처 불공제 차량번호가 적요·상호·원본 행 문자열 값에 등장하는가.
 * - 한글이 들어간 정식 번호('12가3456')는 공백·하이픈을 무시하고 원본 행까지 찾는다.
 * - 숫자만 등록된 번호(뒷 4자리 등)는 승인번호·금액·카드번호에 우연히 섞이므로
 *   적요·상호에서 앞뒤가 숫자가 아닌 독립된 숫자열일 때만 인정한다.
 */
export function matchesClientVehicle(tx: Pick<NormalizedTransaction, 'description' | 'merchantName' | 'rawData'>, vehicles: readonly string[]): boolean {
  if (!vehicles || vehicles.length === 0) return false;
  let hay: string | null = null;
  let free: string | null = null;
  return vehicles.some((p) => {
    const k = compactPlate(p);
    if (k.length < 4) return false;
    if (/^\d+$/.test(k)) {
      free ??= `${tx.description ?? ''} ${tx.merchantName ?? ''}`.normalize('NFKC');
      let i = free.indexOf(k);
      while (i >= 0) {
        if (!/\d/.test(free[i - 1] ?? '') && !/\d/.test(free[i + k.length] ?? '')) return true;
        i = free.indexOf(k, i + 1);
      }
      return false;
    }
    if (hay === null) {
      const parts: string[] = [tx.description ?? '', tx.merchantName ?? ''];
      if (tx.rawData) for (const v of Object.values(tx.rawData)) if (typeof v === 'string') parts.push(v);
      hay = compactPlate(parts.join('|'));
    }
    return hay.includes(k);
  });
}

// 일자별 요일 메모 (1만 건 배치에서도 일자 종류는 수십 개) — 크기 상한을 두어 장기 실행 프로세스에서도 무한 증가 방지
const weekdayMemo = new Map<string, number>();
function cachedWeekday(date: string): number {
  let w = weekdayMemo.get(date);
  if (w === undefined) {
    if (weekdayMemo.size >= 4096) weekdayMemo.clear();
    w = weekdayOf(date);
    weekdayMemo.set(date, w);
  }
  return w;
}

/** 거래 + 계정 결과 + 수임처 → 규칙 평가용 사실(facts) */
export function buildRuleFacts(
  tx: NormalizedTransaction,
  account: Pick<AccountClassification, 'accountCode' | 'accountName'> | null,
  client: ClientProfile,
  vat?: Pick<VatClassification, 'vatType' | 'deductible'> | null,
): RuleFacts {
  const date = tx.transactionDate;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
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
    serviceCharge: tx.serviceCharge,
    cardNumberMasked: tx.cardNumberMasked,
    isForeign: tx.isForeign,
    currency: tx.currency,
    weekday: validDate ? cachedWeekday(date) : null,
    dayOfMonth: validDate ? Number(date.slice(8, 10)) : null,
    accountCode: account?.accountCode ?? null,
    accountName: account?.accountName ?? null,
    industry: client.industry,
    searchText: [tx.merchantName, tx.merchantCategory ?? '', tx.description ?? ''].join(' '),
    merchantText: [tx.merchantName, tx.merchantCategory ?? ''].join(' '),
    clientVatType: client.vatType,
    clientBusinessType: client.businessType,
    sourceDeductibleHint: tx.sourceDeductibleHint,
    vehicleMatched: matchesClientVehicle(tx, client.nonDeductibleVehicles),
    clientHasVehicles: client.nonDeductibleVehicles.length > 0,
    hour: extractHour(tx.rawData),
    vatType: vat?.vatType ?? null,
    deductible: vat ? vat.deductible : null,
  };
}

// ─────────────── 조건 컴파일러 (dsl.evaluateCondition 과 의미 동일, 거래당 정규화 캐시) ───────────────

/** 한 거래의 사실 + 정규화 문자열 캐시 */
export class FactView {
  private readonly cache = new Map<string, string>();
  constructor(readonly facts: RuleFacts) {}
  raw(field: string): unknown {
    return (this.facts as Record<string, unknown>)[field];
  }
  str(field: string, ignoreCase: boolean): string {
    const key = ignoreCase ? `U${field}` : `N${field}`;
    let s = this.cache.get(key);
    if (s === undefined) {
      s = normStr(this.raw(field), ignoreCase);
      this.cache.set(key, s);
    }
    return s;
  }
}

export type CompiledCondition = (view: FactView) => boolean;

function normStr(v: unknown, ignoreCase: boolean): string {
  const s = v === null || v === undefined ? '' : String(v).normalize('NFKC');
  return ignoreCase ? s.toUpperCase() : s;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/**
 * Condition → 술어 함수. `evaluateCondition()` 과 결과가 같도록 구현했다 (vat.test.ts 에서 동등성 검증).
 * 키워드 값 정규화를 규칙 로딩 시 1회만 하므로 대량 평가(1만 건+)에서도 빠르다.
 */
export function compileCondition(cond: Condition): CompiledCondition {
  if ('all' in cond) {
    const ps = cond.all.map(compileCondition);
    return (v) => ps.every((p) => p(v));
  }
  if ('any' in cond) {
    const ps = cond.any.map(compileCondition);
    return (v) => ps.some((p) => p(v));
  }
  if ('not' in cond) {
    const p = compileCondition(cond.not);
    return (v) => !p(v);
  }
  return compileLeaf(cond);
}

function compileLeaf(leaf: ConditionLeaf): CompiledCondition {
  const field = leaf.field as string;
  const ic = leaf.ignoreCase !== false;
  const v = leaf.value;
  const nv = normStr(v, ic);
  const arr = Array.isArray(v) ? v : null;
  const narr = arr ? arr.map((x) => normStr(x, ic)) : null;
  const isEmpty = (a: unknown) => a === null || a === undefined || a === '';
  const eqPrim = (a: number | boolean): boolean => (typeof a === 'number' ? a === Number(v) : a === (v === true || v === 'true'));
  switch (leaf.op) {
    case 'is_empty':
      return (x) => isEmpty(x.raw(field));
    case 'is_not_empty':
      return (x) => !isEmpty(x.raw(field));
    case 'eq':
      return (x) => {
        const a = x.raw(field);
        if (typeof a === 'number' || typeof a === 'boolean') return eqPrim(a);
        return x.str(field, ic) === nv;
      };
    case 'neq':
      return (x) => {
        const a = x.raw(field);
        if (typeof a === 'number' || typeof a === 'boolean') return !eqPrim(a);
        return x.str(field, ic) !== nv;
      };
    case 'contains':
      return narr ? (x) => { const s = x.str(field, ic); return narr.some((k) => s.includes(k)); } : (x) => x.str(field, ic).includes(nv);
    case 'not_contains':
      return narr ? (x) => { const s = x.str(field, ic); return !narr.some((k) => s.includes(k)); } : (x) => !x.str(field, ic).includes(nv);
    case 'starts_with':
      return (x) => x.str(field, ic).startsWith(nv);
    case 'ends_with':
      return (x) => x.str(field, ic).endsWith(nv);
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(String(v), ic ? 'i' : '');
      } catch {
        return () => false;
      }
      return (x) => re.test(String(x.raw(field) ?? ''));
    }
    case 'in': {
      if (!narr) return () => false;
      const set = new Set(narr);
      return (x) => set.has(x.str(field, ic));
    }
    case 'not_in': {
      if (!narr) return () => false;
      const set = new Set(narr);
      return (x) => !set.has(x.str(field, ic));
    }
    case 'gt': {
      const n = Number(v);
      return (x) => { const a = toNum(x.raw(field)); return a !== null && a > n; };
    }
    case 'gte': {
      const n = Number(v);
      return (x) => { const a = toNum(x.raw(field)); return a !== null && a >= n; };
    }
    case 'lt': {
      const n = Number(v);
      return (x) => { const a = toNum(x.raw(field)); return a !== null && a < n; };
    }
    case 'lte': {
      const n = Number(v);
      return (x) => { const a = toNum(x.raw(field)); return a !== null && a <= n; };
    }
    case 'between': {
      if (!arr || arr.length !== 2) return () => false;
      const lo = Number(arr[0]);
      const hi = Number(arr[1]);
      return (x) => { const a = toNum(x.raw(field)); return a !== null && a >= lo && a <= hi; };
    }
    default:
      return () => false;
  }
}

/**
 * VAT/Risk 규칙 조건 검증 (Rule Studio 저장 전).
 * 계약 validateCondition 과 같되, 엔진 가상 필드(RuleFactField)도 허용한다.
 */
export function validateRuleCondition(cond: unknown, path = 'condition'): string[] {
  if (!cond || typeof cond !== 'object') return [`${path}: 조건이 비어 있습니다`];
  const c = cond as Record<string, unknown>;
  if ('all' in c || 'any' in c) {
    const arr = (c.all ?? c.any) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return [`${path}: 하위 조건이 필요합니다`];
    return arr.flatMap((x, i) => validateRuleCondition(x, `${path}[${i}]`));
  }
  if ('not' in c) return validateRuleCondition(c.not, `${path}.not`);
  const field = String(c.field);
  if (!(field in RULE_FACT_LABELS)) return [`${path}: 알 수 없는 필드 ${field}`];
  // 필드 검사는 위에서 끝났으므로 계약 필드로 치환해 연산자·값 검사를 위임
  return validateCondition({ ...c, field: 'merchantName' }, path);
}

/**
 * 수임처에 적용할 규칙 목록: 비활성 제거, 다른 수임처 전용 규칙 제거,
 * 같은 code 는 수임처 전용 규칙이 공통 규칙을 덮어쓴다.
 */
export function resolveRulesForClient<R extends { code: string; clientId?: string | null; active?: boolean }>(
  rules: readonly R[],
  clientId: string,
): R[] {
  const byCode = new Map<string, R>();
  for (const r of rules) {
    if (r.clientId && r.clientId !== clientId) continue;
    const prev = byCode.get(r.code);
    if (!prev || (!prev.clientId && r.clientId)) byCode.set(r.code, r);
  }
  return [...byCode.values()].filter((r) => r.active !== false);
}

// ═══════════════════════════════ 부가세 엔진 ═══════════════════════════════

/** 사람이 승인한 매핑 규칙이 부가세 판단까지 지정한 경우 (MappingRule.vatOverride) */
export interface VatOverride {
  deductible: boolean;
  reasonCode?: string | null;
  ruleId?: string | null;
  ruleName?: string | null;
  confidence?: number;
}

export interface VatContext {
  client: ClientProfile;
  rules: readonly VatRuleDef[];
  override?: VatOverride | null;
  options?: Partial<VatEngineOptions>;
}

interface CompiledVatRule {
  rule: VatRuleDef;
  test: CompiledCondition;
}

const OUTCOME_RANK: Record<VatRuleOutcome, number> = { non_deductible: 0, review: 1, deductible: 2 };

const compiledCache = new WeakMap<readonly VatRuleDef[], Map<string, CompiledVatRule[]>>();

/** 규칙을 수임처 기준으로 정리·정렬·컴파일 (같은 rules 배열이면 캐시 재사용) */
export function compileVatRules(rules: readonly VatRuleDef[], clientId: string): CompiledVatRule[] {
  let perClient = compiledCache.get(rules);
  if (!perClient) {
    perClient = new Map();
    compiledCache.set(rules, perClient);
  }
  let compiled = perClient.get(clientId);
  if (!compiled) {
    compiled = resolveRulesForClient(rules, clientId)
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome] || // 동순위면 보수적 결론 우선
          a.code.localeCompare(b.code),
      )
      .map((rule) => ({ rule, test: compileCondition(rule.condition) }));
    perClient.set(clientId, compiled);
  }
  return compiled;
}

type SalesVatType = Extract<VatType, `sales_${string}`>;

/** 매출 증빙 → VatType */
function salesVatType(tx: NormalizedTransaction): SalesVatType {
  switch (tx.evidenceType) {
    case 'tax_invoice':
      return 'sales_taxable';
    case 'invoice_exempt':
      return 'sales_exempt';
    case 'card':
      return 'sales_card';
    case 'cash_receipt':
      return 'sales_cash_receipt';
    default:
      return 'sales_other';
  }
}

/**
 * 매입 증빙 × 공제여부 → VatType.
 * - 카드·현금영수증 불공제분은 매입매출전표가 아니라 일반전표(부가세 포함 비용)로 처리 → purchase_no_evidence (검증필요: 사무소 관행)
 * - 판단불가(null)는 증빙 기준 잠정 유형을 준다 (검토 후 확정).
 */
export function purchaseVatType(
  tx: Pick<NormalizedTransaction, 'evidenceType' | 'vatAmount' | 'isForeign' | 'merchantTaxType'>,
  deductible: boolean | null,
): VatType {
  if (tx.isForeign) return 'purchase_no_evidence';
  const noVat = tx.vatAmount === 0;
  switch (tx.evidenceType) {
    case 'tax_invoice':
      return deductible === false && !noVat ? 'purchase_non_deductible' : 'purchase_taxable';
    case 'invoice_exempt':
      return 'purchase_exempt';
    case 'card':
      if (noVat) return tx.merchantTaxType === 'simplified' ? 'purchase_no_evidence' : 'purchase_card_exempt';
      return deductible === false ? 'purchase_no_evidence' : 'purchase_card';
    case 'cash_receipt':
      if (noVat) return tx.merchantTaxType === 'simplified' ? 'purchase_no_evidence' : 'purchase_cash_receipt_exempt';
      return deductible === false ? 'purchase_no_evidence' : 'purchase_cash_receipt';
    default:
      return 'purchase_no_evidence';
  }
}

function outcomeToDeductible(o: VatRuleOutcome): boolean | null {
  return o === 'deductible' ? true : o === 'non_deductible' ? false : null;
}

function ruleLine(r: VatRuleDef): string {
  return `[${r.code}] ${r.reasonText}${r.legalBasis ? ` (근거: ${r.legalBasis})` : ''}`;
}

const OUTCOME_LABEL: Record<VatRuleOutcome, string> = { deductible: '공제', non_deductible: '불공제', review: '검토 필요' };

/**
 * 부가세 공제/불공제 판단. 계정 엔진과 독립된 축이며, 계정 결과는 `accountCode` 사실로만 참조한다.
 * - 매입: 규칙을 priority 순으로 평가해 처음 일치한 규칙이 결론 (나머지는 참고 근거)
 * - 원천 힌트(sourceDeductibleHint)와 결론이 같으면 가산, 엔진 '공제' ↔ 힌트 '불공제'면 판단불가(null)
 * - 매출: 공제 판단 대상이 아니므로 증빙 기준 유형만 정한다 (deductible=true 로 표기, 검토 불필요)
 */
export function classifyVat(tx: NormalizedTransaction, account: AccountClassification, ctx: VatContext): VatClassification {
  const opt: VatEngineOptions = { ...DEFAULT_VAT_ENGINE_OPTIONS, ...(ctx.options ?? {}) };

  if (tx.direction === 'sales') {
    const vatType = salesVatType(tx);
    const conf = tx.evidenceType === 'bank' || tx.evidenceType === 'other' ? 85 : 97;
    return {
      vatType,
      deductible: true,
      nonDeductibleReasonCode: null,
      confidence: conf,
      summary: `매출 — ${SALES_LABEL[vatType]}`,
      reasons: ['매출 거래는 매입세액 공제 판단 대상이 아니며, 증빙 유형에 따라 부가세 유형을 정했습니다.'],
      ruleIds: [],
    };
  }

  const view = new FactView(buildRuleFacts(tx, account, ctx.client));
  const compiled = compileVatRules(ctx.rules, ctx.client.id);
  const matched: VatRuleDef[] = [];
  for (const c of compiled) if (c.test(view)) matched.push(c.rule);

  const primary = matched[0] ?? null;
  const reasons: string[] = [];
  const ruleIds: string[] = matched.map((r) => r.id ?? r.code);
  let deductible: boolean | null;
  let confidence: number;
  let summary: string;
  let reasonCode: string | null = null;

  // 사람 승인 규칙의 vat_override — 데이터 사실 규칙보다 우선하지 않는다
  const ov = ctx.override;
  if (ov && !(primary && primary.priority >= opt.factPriorityMin)) {
    deductible = ov.deductible;
    confidence = Math.min(100, Math.max(0, ov.confidence ?? opt.overrideConfidence));
    summary = `${deductible ? '공제' : '불공제'} — 승인된 규칙${ov.ruleName ? ` '${ov.ruleName}'` : ''}이 공제 여부를 지정`;
    reasons.push(`사람이 승인한 분류 규칙${ov.ruleName ? ` '${ov.ruleName}'` : ''}이 부가세를 ${deductible ? '공제' : '불공제'}로 지정했습니다.`);
    if (ov.ruleId) ruleIds.unshift(ov.ruleId);
    if (!deductible) reasonCode = ov.reasonCode ?? ov.ruleId ?? null;
    for (const r of matched) reasons.push(`참고: ${ruleLine(r)}`);
    // 사람 규칙은 가맹점 단위 일반 규칙이고 원천 힌트는 이 거래 한 건의 자료다 → '공제' 지정 ↔ 원천 '불공제'면 검토
    if (deductible === true && tx.sourceDeductibleHint === false) {
      deductible = null;
      confidence = Math.min(confidence, opt.hintConflictMaxConfidence);
      summary = '검토 필요 — 승인된 규칙(공제)과 원천자료 공제여부(불공제)가 다릅니다';
      reasons.push('원천자료(홈택스)는 이 거래를 불공제로 표시했습니다. 가맹점 과세유형·업종이 바뀌었는지 확인하세요.');
    }
  } else if (!primary) {
    deductible = null;
    confidence = opt.noRuleConfidence;
    summary = '검토 필요 — 공제 여부를 판단할 규칙이 없습니다';
    reasons.push('일치하는 부가세 규칙이 없어 공제 여부를 사람이 확인해야 합니다.');
  } else {
    deductible = outcomeToDeductible(primary.outcome);
    confidence = primary.confidence;
    summary = `${OUTCOME_LABEL[primary.outcome]} — ${primary.name}${primary.legalBasis ? ` (${primary.legalBasis})` : ''}`;
    reasons.push(ruleLine(primary));
    for (const r of matched.slice(1)) {
      if (r.outcome !== primary.outcome) reasons.push(`참고(우선순위 낮음, ${OUTCOME_LABEL[r.outcome]}): ${ruleLine(r)}`);
    }
    if (deductible === false) reasonCode = primary.code;

    // 원천 힌트와 비교
    const hint = tx.sourceDeductibleHint;
    if (hint !== null && deductible !== null) {
      if (hint === deductible) {
        const boosted = Math.min(opt.hintAgreementMaxConfidence, confidence + opt.hintAgreementBonus);
        if (boosted > confidence) {
          confidence = boosted;
          reasons.push(`원천자료(홈택스) 공제여부 '${hint ? '공제' : '불공제'}'와 판단이 일치합니다.`);
        }
      } else if (deductible === true && hint === false) {
        deductible = null;
        confidence = Math.min(confidence, opt.hintConflictMaxConfidence);
        summary = `검토 필요 — 엔진 판단(공제)과 원천자료 공제여부(불공제)가 다릅니다`;
        reasons.push('원천자료(홈택스)는 불공제로 표시했지만 엔진 규칙은 공제로 판단했습니다. 가맹점 과세유형·업종을 확인하세요.');
      } else {
        reasons.push('원천자료(홈택스)는 공제로 표시했지만, 용도·업종 기준으로 불공제로 판단했습니다 (홈택스 판정은 가맹점 기준).');
      }
    }
  }

  const vatType = purchaseVatType(tx, deductible);
  // 실제로 부가세가 있는데 공제하지 않는 경우에만 불공제 사유 코드를 남긴다 (세액 0·면세는 사유 아님)
  const disallowsRealVat = deductible === false && tx.vatAmount !== 0 && !tx.isForeign;
  if (!disallowsRealVat) reasonCode = null;
  if (disallowsRealVat && (tx.evidenceType === 'card' || tx.evidenceType === 'cash_receipt')) {
    reasons.push('불공제 카드·현금영수증은 부가세를 포함한 전액을 비용으로 처리합니다 (일반전표).');
  }

  return {
    vatType,
    deductible,
    nonDeductibleReasonCode: reasonCode,
    confidence: Math.round(Math.min(100, Math.max(0, confidence))),
    summary,
    reasons,
    ruleIds,
  };
}

const SALES_LABEL: Record<SalesVatType, string> = {
  sales_taxable: '과세매출(세금계산서)',
  sales_exempt: '면세매출(계산서)',
  sales_card: '카드매출',
  sales_cash_receipt: '현금영수증매출',
  sales_other: '기타매출',
};

/** 조건 필드가 계약 DSL 밖(가상 필드)인지 — 저장 계층에서 안내용 */
export function usesVirtualFields(cond: Condition): boolean {
  if ('all' in cond) return cond.all.some(usesVirtualFields);
  if ('any' in cond) return cond.any.some(usesVirtualFields);
  if ('not' in cond) return usesVirtualFields(cond.not);
  return !(cond.field in FIELD_LABELS);
}
