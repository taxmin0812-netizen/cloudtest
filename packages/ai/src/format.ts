import { formatWon, type Won } from '@mintax/core';

/**
 * 검토 메시지용 한국어 금액·증감률 표기.
 * - 10만원 미만: 원 단위 그대로 (55,000원)
 * - 10만원 ~ 100만원 미만: 만원 단위 소수 1자리 (12.5만원)
 * - 100만원 ~ 1억 미만: 만원 단위 반올림 (240만원, 1,234만원)
 * - 1억 이상: 억 + 만원 (1억 2,300만원)
 */
export function formatManwon(value: Won): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 100_000) return `${sign}${formatWon(abs)}`;
  if (abs < 1_000_000) {
    const man = Math.round(abs / 1_000) / 10;
    return `${sign}${stripZero(man.toFixed(1))}만원`;
  }
  const totalMan = Math.round(abs / 10_000);
  const eok = Math.floor(totalMan / 10_000);
  const man = totalMan % 10_000;
  if (eok === 0) return `${sign}${man.toLocaleString('ko-KR')}만원`;
  return man === 0 ? `${sign}${eok.toLocaleString('ko-KR')}억원` : `${sign}${eok.toLocaleString('ko-KR')}억 ${man.toLocaleString('ko-KR')}만원`;
}

function stripZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** 증감률(%) 계산. 기준이 0 이하이면 null */
export function changeRatePercent(current: number, baseline: number): number | null {
  if (!(baseline > 0)) return null;
  return round1(((current - baseline) / baseline) * 100);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** +47% / -12% / +3.5% (10% 미만은 소수 1자리) */
export function formatRate(rate: number): string {
  const sign = rate > 0 ? '+' : rate < 0 ? '-' : '';
  const abs = Math.abs(rate);
  const body = abs >= 10 ? String(Math.round(abs)) : stripZero(abs.toFixed(1));
  return `${sign}${body}%`;
}

/** 배수 표기: 3.7배 */
export function formatRatio(ratio: number): string {
  return `${stripZero((Math.round(ratio * 10) / 10).toFixed(1))}배`;
}

/** 퍼센트포인트 표기: +19%p */
export function formatPp(pp: number): string {
  const sign = pp > 0 ? '+' : pp < 0 ? '-' : '';
  const abs = Math.abs(pp);
  return `${sign}${abs >= 10 ? Math.round(abs) : stripZero(abs.toFixed(1))}%p`;
}

export function formatCount(n: number): string {
  return `${n.toLocaleString('ko-KR')}건`;
}
