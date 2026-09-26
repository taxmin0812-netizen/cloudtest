/**
 * 셀 값·헤더 문자열 유틸.
 */

/** 셀 값을 화면/비교용 문자열로 (null/빈칸 → '') */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    if (Number.isInteger(v)) return Number.isSafeInteger(v) ? String(v) : BigInt(Math.round(v)).toString();
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  return String(v).trim();
}

export function isBlankCell(v: unknown): boolean {
  return cellText(v) === '';
}

export function isBlankRow(row: readonly unknown[] | undefined): boolean {
  if (!row) return true;
  for (const c of row) if (!isBlankCell(c)) return false;
  return true;
}

/**
 * 헤더 비교 키: NFKC, 공백/개행/필수표시(*)/구분기호 제거, 단위 표기 "(원)" 제거, 소문자.
 * 예) " 공급가액\n(원) " → "공급가액", "영수/청구 구분" → "영수청구구분"
 */
export function normalizeHeader(v: unknown): string {
  let s = cellText(v).normalize('NFKC');
  s = s.replace(/[(\[]\s*(단위\s*[:：]?\s*)?원\s*[)\]]/g, '');
  s = s.replace(/[\s*※·_\-./:;'"`]/g, '');
  return s.toLowerCase();
}

/** 괄호 안 내용까지 제거한 느슨한 헤더 키 — 정확 일치가 없을 때 2차 비교용 */
export function looseHeader(v: unknown): string {
  return normalizeHeader(v).replace(/[(\[{][^)\]}]*[)\]}]/g, '');
}

/** 엑셀/WEHAGO 업로드용 텍스트 정리: 제어문자 제거, 공백 정리 */
export function sanitizeText(s: string, forbiddenChars = ''): string {
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (forbiddenChars) {
    for (const ch of forbiddenChars) out = out.split(ch).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function digitsOnly(v: unknown): string {
  return cellText(v).replace(/\D/g, '');
}
