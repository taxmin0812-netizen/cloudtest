/**
 * 민감정보(카드번호 전체, 주민/외국인등록번호) 탐지·마스킹.
 *
 * core.scrubSensitive 는 로그용이라 24자리 세금계산서 승인번호 일부를 카드번호로 오인할 수 있다.
 * 원본 행(rawData)에는 Luhn 체크섬·생년월일 형식까지 확인하는 보수적인 탐지를 쓴다.
 */
import { maskCardNumber } from '@mintax/core';

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** 이미 마스킹된 값('*' 포함)인지 */
export function isMasked(s: string): boolean {
  return /[*＊xX]{2,}/.test(s);
}

/** 문자열 전체가 카드번호(13~19자리, Luhn 통과)로 보이는지. 마스킹된 값은 false */
export function looksLikeFullCardNumber(s: string): boolean {
  const t = s.trim();
  if (!/^\d[\d\s-]{11,24}\d$/.test(t)) return false;
  const digits = t.replace(/[\s-]/g, '');
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

function validBirthPrefix(yymmdd: string): boolean {
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** 문자열 전체가 주민(외국인)등록번호 형식인지 (YYMMDD-[1-8]XXXXXX) */
export function looksLikeResidentNumber(s: string): boolean {
  const m = s.trim().match(/^(\d{6})[-\s]?([1-8])(\d{6})$/);
  return !!m && validBirthPrefix(m[1]!);
}

export function maskResidentLike(s: string): string {
  const d = s.replace(/\D/g, '');
  if (d.length !== 13) return '******-*******';
  return `${d.slice(0, 6)}-${d[6]}******`;
}

/** 카드번호 마스킹 (이미 마스킹된 값은 형식만 맞춘다). 빈 값은 null */
export function maskCard(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  return maskCardNumber(s);
}

const CARD_IN_TEXT = /(?<![\d*])(\d[\d -]{11,22}\d)(?![\d*])/g;
const RRN_IN_TEXT = /(?<!\d)(\d{6})[-\s]?([1-8])(\d{6})(?!\d)/g;

/** 자유 텍스트 안의 카드번호 전체·주민번호를 마스킹한다. */
export function scrubFreeText(text: string): string {
  let out = text.replace(RRN_IN_TEXT, (m, birth: string, g: string) => (validBirthPrefix(birth) ? `${birth}-${g}******` : m));
  out = out.replace(CARD_IN_TEXT, (m: string) => {
    const digits = m.replace(/[\s-]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return m;
    return maskCardNumber(digits) ?? m;
  });
  return out;
}
