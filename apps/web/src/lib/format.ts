/** 화면 표기 유틸 (금액·비율·일자) */
export function won(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return n.toLocaleString('ko-KR');
}
export function wonShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`;
  if (abs >= 10_000) return `${Math.round(n / 10_000).toLocaleString('ko-KR')}만`;
  return n.toLocaleString('ko-KR');
}
export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return `${n.toFixed(digits)}%`;
}
export function count(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return `${n.toLocaleString('ko-KR')}건`;
}
export function shortDate(d: string | null | undefined): string {
  if (!d) return '-';
  return d.slice(5).replace('-', '.');
}
export function dateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '-';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}
export function periodLabel(ym: string): string {
  const [y, m] = ym.split('-');
  return `${y}년 ${Number(m)}월`;
}
