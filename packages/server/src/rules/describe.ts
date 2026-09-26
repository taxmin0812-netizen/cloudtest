/**
 * 규칙 표시·검증 도우미 (순수 함수, 단위 테스트 대상).
 */
import { FIELD_LABELS, describeCondition, normalizeMerchantName, validateCondition, type Condition, type ConditionLeaf } from '@mintax/core';
import { INDUSTRY_LABELS_KO } from '@mintax/core/engine/classify-index';
import { RULE_FACT_LABELS, validateRuleCondition } from '@mintax/core/engine/vat-risk-index';
import { ValidationError, type FieldError } from '@mintax/security';

const VALUE_LABELS: Partial<Record<string, Record<string, string>>> = {
  direction: { purchase: '매입', sales: '매출' },
  evidenceType: { tax_invoice: '세금계산서', invoice_exempt: '계산서', card: '카드', cash_receipt: '현금영수증', bank: '통장', other: '기타' },
  merchantTaxType: { general: '일반과세', simplified: '간이과세', exempt: '면세', unknown: '미상' },
  clientVatType: { general: '일반과세', simplified: '간이과세', exempt: '면세', mixed: '겸영' },
  clientBusinessType: { corporation: '법인', individual: '개인' },
  isForeign: { true: '예', false: '아니오' },
  weekday: { '0': '일', '1': '월', '2': '화', '3': '수', '4': '목', '5': '금', '6': '토' },
  industry: INDUSTRY_LABELS_KO as Record<string, string>,
};

function labelValue(field: string, v: unknown): unknown {
  const table = VALUE_LABELS[field];
  if (!table) return v;
  const one = (x: unknown) => (x === null || x === undefined ? x : (table[String(x)] ?? x));
  return Array.isArray(v) ? v.map(one) : one(v);
}

function relabel(c: Condition): Condition {
  if ('all' in c) return { all: c.all.map(relabel) };
  if ('any' in c) return { any: c.any.map(relabel) };
  if ('not' in c) return { not: relabel(c.not) };
  const leaf = c as ConditionLeaf;
  const field = String(leaf.field);
  const label = field in FIELD_LABELS ? field : ((RULE_FACT_LABELS as Record<string, string>)[field] ?? field);
  return { ...leaf, field: label as ConditionLeaf['field'], value: labelValue(field, leaf.value) as ConditionLeaf['value'] };
}

/**
 * 규칙 조건 → 사람이 읽는 한국어. 엔진 가상 필드(searchText 등)·값(매입/카드)도 한국어로.
 * 예: 매입/매출 = "매입" 그리고 상호키 = "쿠팡"
 */
export function describeRuleCondition(cond: Condition | null | undefined): string {
  if (!cond) return '(조건 없음 — 모든 거래)';
  try {
    return describeCondition(relabel(cond));
  } catch {
    return '(조건을 읽을 수 없습니다)';
  }
}

/** "상호키 = "쿠팡" → 829 사무용품비" */
export function describeMappingRule(r: { condition: Condition; accountCode: string; accountName: string }): string {
  return `${describeRuleCondition(r.condition)} → ${r.accountCode} ${r.accountName}`;
}

const MAX_CONDITION_JSON = 10_000;
const MAX_DEPTH = 8;
const MAX_REGEX = 200;

function depthAndRegex(c: unknown, depth: number, errs: string[], path: string): void {
  if (depth > MAX_DEPTH) {
    errs.push(`${path}: 조건 묶음이 너무 깊습니다 (최대 ${MAX_DEPTH}단계)`);
    return;
  }
  if (!c || typeof c !== 'object') return;
  const o = c as Record<string, unknown>;
  const arr = (o.all ?? o.any) as unknown;
  if (Array.isArray(arr)) arr.forEach((x, i) => depthAndRegex(x, depth + 1, errs, `${path}[${i}]`));
  else if ('not' in o) depthAndRegex(o.not, depth + 1, errs, `${path}.not`);
  else if (o.op === 'regex' && String(o.value ?? '').length > MAX_REGEX) errs.push(`${path}: 정규식은 ${MAX_REGEX}자 이하여야 합니다`);
}

function limits(cond: unknown, errs: string[]): void {
  let json = '';
  try {
    json = JSON.stringify(cond) ?? '';
  } catch {
    errs.push('condition: 조건을 저장할 수 없는 형식입니다');
    return;
  }
  if (json.length > MAX_CONDITION_JSON) errs.push(`condition: 조건이 너무 깁니다 (최대 ${MAX_CONDITION_JSON.toLocaleString('ko-KR')}자)`);
  depthAndRegex(cond, 1, errs, 'condition');
}

/** 매핑(계정) 규칙 조건 검증 — 계약 DSL 필드만 허용 */
export function mappingConditionErrors(cond: unknown): string[] {
  const errs = validateCondition(cond);
  limits(cond, errs);
  return errs;
}

/** 부가세·위험 규칙 조건 검증 — 엔진 가상 필드 허용 */
export function ruleConditionErrors(cond: unknown): string[] {
  const errs = validateRuleCondition(cond);
  limits(cond, errs);
  return errs;
}

/** 오류 문자열 목록 → ValidationError (필드별) */
export function validationFailure(message: string, errors: Array<string | FieldError>, defaultField = 'input'): ValidationError {
  const fieldErrors: FieldError[] = errors.map((e) => {
    if (typeof e !== 'string') return e;
    const m = e.match(/^([\w.[\]]+):\s*(.*)$/);
    return m ? { field: m[1]!, message: m[2]! } : { field: defaultField, message: e };
  });
  const detail = fieldErrors.slice(0, 3).map((f) => f.message).join(' / ');
  return new ValidationError(detail ? `${message} (${detail})` : message, fieldErrors);
}

/** 조건이 상대방·적요를 특정하는가 (없으면 너무 넓은 규칙) */
export function conditionIdentifiesParty(cond: Condition): boolean {
  if ('all' in cond) return cond.all.some(conditionIdentifiesParty);
  if ('any' in cond) return cond.any.length > 0 && cond.any.every(conditionIdentifiesParty);
  if ('not' in cond) return false;
  const f = (cond as ConditionLeaf).field;
  return ['merchantName', 'merchantKey', 'merchantBusinessNumber', 'merchantCategory', 'description', 'cardNumberMasked'].includes(f);
}

/** 조건에 매입/매출 방향이 명시되어 있는가 */
export function conditionMentionsDirection(cond: Condition): boolean {
  if ('all' in cond) return cond.all.some(conditionMentionsDirection);
  if ('any' in cond) return cond.any.length > 0 && cond.any.every(conditionMentionsDirection);
  if ('not' in cond) return false;
  return (cond as ConditionLeaf).field === 'direction';
}

/**
 * 적요에서 규칙 키워드 한 개 고르기: 숫자뿐인 토큰·상호와 겹치는 토큰을 빼고 가장 긴 것.
 * 예: ("쿠팡 주문 12345 A4용지", "쿠팡") → "A4용지"
 */
export function deriveDescriptionKeyword(description: string, merchantKey: string): string | null {
  const tokens = description
    .normalize('NFKC')
    .split(/[\s,./()[\]{}\-_:;#|*+=~'"!?<>]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
  let best: string | null = null;
  for (const t of tokens) {
    const k = normalizeMerchantName(t);
    if (k && merchantKey && (merchantKey.includes(k) || k.includes(merchantKey))) continue;
    if (!best || t.length > best.length) best = t;
  }
  return best;
}

/** 금액·숫자 파라미터 입력 해석: "3,000,000" · "₩300,000" · "300000원" */
export function parseNumberInput(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[,\s₩원]/g, '');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
