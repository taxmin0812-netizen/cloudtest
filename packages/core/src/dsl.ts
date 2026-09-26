import type { Condition, ConditionField, ConditionLeaf } from './types';

/**
 * 규칙 조건 DSL 평가기.
 * Rule Studio / VAT Rule / Risk Rule 이 모두 같은 DSL 을 사용한다.
 *
 * 예) { all: [ { field: 'merchantName', op: 'contains', value: '농협' },
 *              { field: 'description', op: 'contains', value: '축산' } ] }
 */
export type ConditionContext = Partial<Record<ConditionField, string | number | boolean | null | undefined>>;

export function evaluateCondition(cond: Condition, ctx: ConditionContext): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, ctx));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, ctx));
  if ('not' in cond) return !evaluateCondition(cond.not, ctx);
  return evaluateLeaf(cond, ctx);
}

function norm(v: unknown, ignoreCase: boolean): string {
  const s = v === null || v === undefined ? '' : String(v).normalize('NFKC');
  return ignoreCase ? s.toUpperCase() : s;
}

function evaluateLeaf(leaf: ConditionLeaf, ctx: ConditionContext): boolean {
  const actual = ctx[leaf.field];
  const ic = leaf.ignoreCase !== false;
  const v = leaf.value;
  switch (leaf.op) {
    case 'is_empty':
      return actual === null || actual === undefined || actual === '';
    case 'is_not_empty':
      return !(actual === null || actual === undefined || actual === '');
    case 'eq':
      if (typeof actual === 'number' || typeof actual === 'boolean') return actual === coerceLike(actual, v);
      return norm(actual, ic) === norm(v, ic);
    case 'neq':
      if (typeof actual === 'number' || typeof actual === 'boolean') return actual !== coerceLike(actual, v);
      return norm(actual, ic) !== norm(v, ic);
    case 'contains':
      return Array.isArray(v)
        ? v.some((x) => norm(actual, ic).includes(norm(x, ic)))
        : norm(actual, ic).includes(norm(v, ic));
    case 'not_contains':
      return Array.isArray(v)
        ? !v.some((x) => norm(actual, ic).includes(norm(x, ic)))
        : !norm(actual, ic).includes(norm(v, ic));
    case 'starts_with':
      return norm(actual, ic).startsWith(norm(v, ic));
    case 'ends_with':
      return norm(actual, ic).endsWith(norm(v, ic));
    case 'regex': {
      try {
        return new RegExp(String(v), ic ? 'i' : '').test(String(actual ?? ''));
      } catch {
        return false;
      }
    }
    case 'in':
      return Array.isArray(v) && v.some((x) => norm(x, ic) === norm(actual, ic));
    case 'not_in':
      return Array.isArray(v) && !v.some((x) => norm(x, ic) === norm(actual, ic));
    case 'gt':
      return num(actual) !== null && num(actual)! > Number(v);
    case 'gte':
      return num(actual) !== null && num(actual)! >= Number(v);
    case 'lt':
      return num(actual) !== null && num(actual)! < Number(v);
    case 'lte':
      return num(actual) !== null && num(actual)! <= Number(v);
    case 'between': {
      if (!Array.isArray(v) || v.length !== 2) return false;
      const n = num(actual);
      return n !== null && n >= Number(v[0]) && n <= Number(v[1]);
    }
    default:
      return false;
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function coerceLike(actual: number | boolean, v: unknown): unknown {
  if (typeof actual === 'number') return Number(v);
  if (typeof actual === 'boolean') return v === true || v === 'true';
  return v;
}

/** 규칙 조건을 사람이 읽을 수 있는 한국어로 */
export function describeCondition(cond: Condition): string {
  if ('all' in cond) return cond.all.map(describeCondition).join(' 그리고 ');
  if ('any' in cond) return `(${cond.any.map(describeCondition).join(' 또는 ')})`;
  if ('not' in cond) return `아님(${describeCondition(cond.not)})`;
  const f = FIELD_LABELS[cond.field] ?? cond.field;
  const val = Array.isArray(cond.value) ? cond.value.join(', ') : String(cond.value ?? '');
  const ops: Record<string, string> = {
    eq: `${f} = "${val}"`,
    neq: `${f} ≠ "${val}"`,
    contains: `${f}에 "${val}" 포함`,
    not_contains: `${f}에 "${val}" 미포함`,
    starts_with: `${f}이(가) "${val}"(으)로 시작`,
    ends_with: `${f}이(가) "${val}"(으)로 끝남`,
    regex: `${f} ~ /${val}/`,
    in: `${f} ∈ [${val}]`,
    not_in: `${f} ∉ [${val}]`,
    gt: `${f} > ${val}`,
    gte: `${f} ≥ ${val}`,
    lt: `${f} < ${val}`,
    lte: `${f} ≤ ${val}`,
    between: `${f} ${val.replace(', ', ' ~ ')} 사이`,
    is_empty: `${f} 없음`,
    is_not_empty: `${f} 있음`,
  };
  return ops[cond.op] ?? `${f} ${cond.op} ${val}`;
}

export const FIELD_LABELS: Record<ConditionField, string> = {
  merchantName: '상호',
  merchantKey: '상호키',
  merchantBusinessNumber: '상대방 사업자번호',
  merchantCategory: '가맹점 업종',
  merchantTaxType: '상대방 과세유형',
  description: '적요',
  evidenceType: '증빙',
  direction: '매입/매출',
  supplyAmount: '공급가액',
  vatAmount: '부가세',
  totalAmount: '합계금액',
  cardNumberMasked: '카드번호',
  isForeign: '해외결제',
  currency: '통화',
  weekday: '요일',
  dayOfMonth: '일',
  accountCode: '계정코드',
  industry: '업종',
};

/** DSL 구조 검증 (Rule Studio 저장 전). 오류 메시지 배열 반환 */
export function validateCondition(cond: unknown, path = 'condition'): string[] {
  const errors: string[] = [];
  if (!cond || typeof cond !== 'object') return [`${path}: 조건이 비어 있습니다`];
  const c = cond as Record<string, unknown>;
  if ('all' in c || 'any' in c) {
    const arr = (c.all ?? c.any) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return [`${path}: 하위 조건이 필요합니다`];
    arr.forEach((x, i) => errors.push(...validateCondition(x, `${path}[${i}]`)));
    return errors;
  }
  if ('not' in c) return validateCondition(c.not, `${path}.not`);
  if (!c.field || !(String(c.field) in FIELD_LABELS)) errors.push(`${path}: 알 수 없는 필드 ${String(c.field)}`);
  const ops = ['eq','neq','contains','not_contains','starts_with','ends_with','regex','in','not_in','gt','gte','lt','lte','between','is_empty','is_not_empty'];
  if (!ops.includes(String(c.op))) errors.push(`${path}: 알 수 없는 연산자 ${String(c.op)}`);
  if (c.op === 'regex') {
    try { new RegExp(String(c.value)); } catch { errors.push(`${path}: 정규식 오류`); }
  }
  if ((c.op === 'in' || c.op === 'not_in' || c.op === 'between') && !Array.isArray(c.value)) {
    errors.push(`${path}: ${String(c.op)} 연산자는 배열 값이 필요합니다`);
  }
  return errors;
}
