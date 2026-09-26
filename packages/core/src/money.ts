import type { AmountTotals, Won } from './types';

/** 원 단위 정수인지 검증. 부동소수 금액은 세무 데이터에서 허용하지 않는다. */
export function assertWon(value: number, label = 'amount'): Won {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} 는 원 단위 정수여야 합니다: ${value}`);
  }
  return value;
}

/**
 * 문자열/숫자 금액을 원 단위 정수로 파싱한다.
 * "1,234", "₩1,234", "(1,234)"(음수), "-1234", "1234.0" 허용. 소수점 이하가 0이 아니면 null.
 */
export function parseWon(input: unknown): Won | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    const r = Math.round(input);
    return Math.abs(r - input) < 1e-6 ? r : null;
  }
  let s = String(input).trim();
  if (s === '' || s === '-') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[₩원,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, frac] = s.split('.');
  if (frac && /[1-9]/.test(frac)) return null;
  const n = Number(intPart);
  if (!Number.isSafeInteger(n)) return null;
  return negative ? -n : n;
}

export function sumWon(values: Iterable<Won>): Won {
  let t = 0;
  for (const v of values) t += v;
  return assertWon(t, 'sum');
}

export function emptyTotals(): AmountTotals {
  return { count: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0 };
}

export function addToTotals(
  t: AmountTotals,
  x: { supplyAmount: Won; vatAmount: Won; totalAmount: Won },
): AmountTotals {
  t.count += 1;
  t.supplyAmount += x.supplyAmount;
  t.vatAmount += x.vatAmount;
  t.totalAmount += x.totalAmount;
  return t;
}

export function totalsOf(items: Iterable<{ supplyAmount: Won; vatAmount: Won; totalAmount: Won }>): AmountTotals {
  const t = emptyTotals();
  for (const i of items) addToTotals(t, i);
  return t;
}

export function totalsEqual(a: AmountTotals, b: AmountTotals): boolean {
  return (
    a.count === b.count &&
    a.supplyAmount === b.supplyAmount &&
    a.vatAmount === b.vatAmount &&
    a.totalAmount === b.totalAmount
  );
}

/** 10원 미만 절사 (원천세 등 국세 계산 관행) */
export function truncateTo10(value: Won): Won {
  return Math.trunc(value / 10) * 10;
}

/** 1원 미만 절사 */
export function truncateWon(value: number): Won {
  return Math.trunc(value);
}

/** 한국어 금액 표기: 1234567 → "1,234,567원" */
export function formatWon(value: Won, suffix = '원'): string {
  return `${value.toLocaleString('ko-KR')}${suffix}`;
}

/** 공급가액 → 부가세 (10%, 원 미만 절사) */
export function vatOf(supply: Won): Won {
  return Math.trunc(supply / 10);
}

/** 합계금액 → 공급가액/부가세 역산 (과세, 10%). 공급가액 = round(total/1.1) 방식 */
export function splitVatInclusive(total: Won): { supplyAmount: Won; vatAmount: Won } {
  const supply = Math.round(total / 1.1);
  return { supplyAmount: supply, vatAmount: total - supply };
}
