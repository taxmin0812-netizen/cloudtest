import { formatBusinessNumber, isValidBusinessNumber } from '@mintax/core';
import type { Rng } from './prng';

/**
 * 합성 식별자 — 실존 데이터와 겹치지 않도록 설계한다.
 *
 * - 사업자등록번호: 체크섬은 맞지만 앞 3자리(세무서 코드)를 '0xx' 로 둔다. 국세청 세무서 코드는 101 이상이라
 *   실제로 발급될 수 없는 번호다 (합성 표식). 가운데 2자리는 개인(01~79)·법인(81/86/87)·면세 개인(90~99) 관례를 따른다.
 * - 주민등록번호: 형식(YYMMDD-GXXXXXX)만 맞추고 ① 뒤 7자리의 2~3번째를 '99' 로 고정 ② 검증번호(끝자리)를 일부러 틀리게 만든다.
 *   2020.10 이전 체계의 실제 번호는 검증번호가 맞으므로 실존 번호가 될 수 없다. 인건비 직원 객체에만 평문으로 둔다 (로더가 암호화).
 * - 카드번호: 원문 없이 마스킹 형태(앞4-****-****-뒤4)로만 만든다.
 */

// ────────────────────────────── 사업자등록번호 ──────────────────────────────

export type BizNoKind = 'corporation' | 'individual' | 'individual_exempt' | 'nonprofit';

const BIZNO_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5] as const;

/** 앞 9자리 → 국세청 체크섬 끝자리 */
export function businessNumberCheckDigit(prefix9: string): number {
  if (!/^\d{9}$/.test(prefix9)) throw new Error(`사업자번호 앞 9자리 형식 오류: ${prefix9}`);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(prefix9[i]) * BIZNO_WEIGHTS[i]!;
  sum += Math.floor((Number(prefix9[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10;
}

function middleFor(kind: BizNoKind, rng: Rng): string {
  switch (kind) {
    case 'corporation':
      return rng.pick(['81', '81', '81', '86', '87']);
    case 'nonprofit':
      return '82';
    case 'individual_exempt':
      return String(rng.int(90, 99));
    case 'individual':
      return String(rng.int(1, 79)).padStart(2, '0');
  }
}

/** 체크섬이 맞는 합성 사업자번호 (숫자 10자리). used 에 없는 값이 나올 때까지 다시 뽑는다. */
export function makeBusinessNumber(rng: Rng, kind: BizNoKind, used: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const office = `0${String(rng.int(10, 99))}`;
    const prefix9 = `${office}${middleFor(kind, rng)}${String(rng.int(0, 9999)).padStart(4, '0')}`;
    const bn = `${prefix9}${businessNumberCheckDigit(prefix9)}`;
    if (!used.has(bn)) {
      used.add(bn);
      return bn;
    }
  }
  throw new Error('사업자번호 생성 실패 (충돌 과다)');
}

/** 합성 사업자번호인가 (체크섬 유효 + 세무서 코드 0xx) */
export function isSyntheticBusinessNumber(bn: string | null | undefined): boolean {
  return !!bn && isValidBusinessNumber(bn) && bn.startsWith('0');
}

export function dashedBusinessNumber(bn: string): string {
  return formatBusinessNumber(bn);
}

// ────────────────────────────── 카드 ──────────────────────────────

export const CARD_COMPANIES = ['신한카드', 'KB국민카드', '삼성카드', '현대카드', '비씨카드', '롯데카드', '하나카드', '우리카드', 'NH농협카드'] as const;

/** 카드번호 앞 4자리 (합성값 — 실제 BIN 과 무관) */
const CARD_HEADS = ['9410', '9420', '5310', '5420', '4518', '4579', '3565', '6250'];

/** core maskCardNumber 와 같은 모양: 앞4-****-****-뒤4 */
export function makeMaskedCard(rng: Rng, used: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const masked = `${rng.pick(CARD_HEADS)}-****-****-${String(rng.int(0, 9999)).padStart(4, '0')}`;
    if (!used.has(masked)) {
      used.add(masked);
      return masked;
    }
  }
  throw new Error('카드번호 생성 실패');
}

// ────────────────────────────── 승인번호 ──────────────────────────────

/** 카드 승인번호 8자리 */
export function makeCardApproval(rng: Rng, used: Set<string>): string {
  return unique(used, () => String(rng.int(10_000_000, 99_999_999)));
}

/** 현금영수증 승인번호 9자리 */
export function makeCashReceiptApproval(rng: Rng, used: Set<string>): string {
  return unique(used, () => String(rng.int(100_000_000, 999_999_999)));
}

/**
 * 전자(세금)계산서 승인번호 (24자리, 하이픈 포함 26자): 작성일자8-41000xxx-일련8.
 * 형식은 관행 모양만 흉내 낸 합성값이다 (검증필요: 실제 발급 규칙과 무관).
 */
export function makeInvoiceApproval(rng: Rng, date: string, used: Set<string>): string {
  const ymd = date.replace(/-/g, '');
  return unique(used, () => `${ymd}-4100${String(rng.int(0, 9999)).padStart(4, '0')}-${String(rng.int(0, 99_999_999)).padStart(8, '0')}`);
}

function unique(used: Set<string>, make: () => string): string {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const v = make();
    if (!used.has(v)) {
      used.add(v);
      return v;
    }
  }
  throw new Error('고유값 생성 실패');
}

// ────────────────────────────── 사람 이름 ──────────────────────────────

const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍'];
const GIVEN = ['민', '서', '지', '현', '준', '우', '도', '하', '윤', '수', '영', '은', '재', '성', '동', '혜', '진', '경', '태', '유', '예', '나', '시', '연', '호', '승', '아', '주', '원', '희'];

/** 가상 이름 (성 1자 + 이름 2자). used 로 같은 데이터셋 안 중복을 피한다. */
export function makePersonName(rng: Rng, used: Set<string>): string {
  return unique(used, () => {
    const a = rng.pick(GIVEN);
    let b = rng.pick(GIVEN);
    if (b === a) b = GIVEN[(GIVEN.indexOf(a) + 7) % GIVEN.length]!;
    return `${rng.pick(SURNAMES)}${a}${b}`;
  });
}

// ────────────────────────────── 주민등록번호 (가짜) ──────────────────────────────

const RRN_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5] as const;

/** 2020.10 이전 체계의 검증번호 (앞 12자리 기준) */
export function residentNumberCheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * RRN_WEIGHTS[i]!;
  return (11 - (sum % 11)) % 10;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 가짜 주민등록번호 'YYMMDD-G99NNNC' — C 는 일부러 틀린 검증번호.
 * birthYear 1900~1999 → 성별자리 1/2, 2000~ → 3/4.
 */
export function makeFakeResidentNumber(rng: Rng, birthYear: number, gender: 'M' | 'F', used: Set<string>): string {
  return unique(used, () => {
    const month = rng.int(1, 12);
    const day = rng.int(1, daysInMonth(birthYear, month));
    const g = birthYear >= 2000 ? (gender === 'M' ? 3 : 4) : gender === 'M' ? 1 : 2;
    const front = `${String(birthYear % 100).padStart(2, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    const back6 = `${g}99${String(rng.int(0, 999)).padStart(3, '0')}`;
    const valid = residentNumberCheckDigit(`${front}${back6}`);
    const wrong = (valid + rng.int(1, 9)) % 10;
    return `${front}-${back6}${wrong}`;
  });
}

/** 이 생성기가 만든 가짜 주민번호 형식인가 ('99' 표식 + 검증번호 불일치) */
export function isSyntheticResidentNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  const m = /^(\d{6})-([1-4]99\d{3})(\d)$/.exec(value);
  if (!m) return false;
  return residentNumberCheckDigit(`${m[1]}${m[2]}`) !== Number(m[3]);
}

// ────────────────────────────── 기타 ──────────────────────────────

const PLATE_SYLLABLES = ['가', '나', '다', '라', '마', '거', '너', '더', '러', '머', '버', '서', '어', '저', '고', '노', '도', '로', '모', '보', '소', '오', '조', '구', '누', '두', '루', '무', '부', '수', '우', '주'];

/** 가상 차량번호 (예: 123가4567) */
export function makePlate(rng: Rng, used: Set<string>): string {
  return unique(used, () => `${rng.int(10, 399)}${rng.pick(PLATE_SYLLABLES)}${rng.int(1000, 9999)}`);
}

const DISTRICTS = ['중앙', '동부', '서부', '남부', '북부', '한빛', '새솔', '푸른', '늘봄'];

/** 명백히 가상인 주소 */
export function makeAddress(rng: Rng): string {
  return `가상시 ${rng.pick(DISTRICTS)}구 샘플로 ${rng.int(1, 300)}`;
}

/** 예약 도메인(example.com) 이메일 */
export function makeEmail(local: string): string {
  return `${local.toLowerCase()}@example.com`;
}
