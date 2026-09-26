import { scrubSensitive } from '@mintax/core';

/**
 * 외부 AI 전송 전 개인식별정보(PII) 차단.
 *
 * - 1차: core scrubSensitive() 가 바꾸는 텍스트가 있으면 (주민번호·카드번호 전체·비밀번호/토큰) 차단
 * - 2차: 계좌번호·휴대전화·15자리 카드(AMEX)·긴 숫자열 정규식
 * - 사업자번호(3-2-5), 일반 전화(0X-XXX-XXXX), 날짜, 마스킹 카드(1234-****-****-5678), 세금계산서 승인번호(8-8-8)는 허용
 * - 오류 메시지·이벤트에는 경로와 종류만 남기고 값은 절대 남기지 않는다.
 */
export type PIIKind = 'resident_number' | 'card_number' | 'account_number' | 'mobile_phone' | 'credential';

export interface PIIFinding {
  kind: PIIKind;
  /** 예: 'input.description', 'input.similarExamples[2].merchantName' */
  path: string;
}

export const PII_KIND_LABELS: Record<PIIKind, string> = {
  resident_number: '주민(외국인)등록번호',
  card_number: '카드번호',
  account_number: '계좌번호',
  mobile_phone: '휴대전화번호',
  credential: '비밀번호·토큰',
};

const RRN = /(?<!\d)\d{6}[-\s]?[1-8]\d{6}(?!\d)/;
const CARD16 = /(?<!\d)\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}(?!\d)/;
const CARD15 = /(?<!\d)\d{4}[-\s]?\d{6}[-\s]?\d{5}(?!\d)/;
const CREDENTIAL = /(password|passwd|pwd|secret|token)["'\s:=]+[^"'\s,}]+/i;
/** 하이픈으로 3~5개 묶음인 숫자열 (계좌 후보) */
const HYPHEN_GROUPS = /(?<![\d-])\d{2,6}(?:-\d{2,8}){2,4}(?![\d-])/g;
/** 구분자 없는 긴 숫자열 */
const LONG_DIGITS = /(?<!\d)\d{11,16}(?!\d)/g;
const MOBILE = /^01[016789]-?\d{3,4}-?\d{4}$/;
const LANDLINE = /^0(?:2|[3-6]\d|70|50\d?)-\d{3,4}-\d{4}$/;
const BUSINESS_NO = /^\d{3}-\d{2}-\d{5}$/;
const APPROVAL_NO = /(?<!\d)\d{8}-\d{8}-\d{8}(?!\d)/g;

/** 문자열 하나에서 발견된 PII 종류 (중복 제거, 발견 순서 무관) */
export function detectPII(text: string): PIIKind[] {
  if (!text) return [];
  // 전자세금계산서 승인번호(8-8-8)는 안에 카드번호 모양(4-4-4-4)이 들어 있어 먼저 지운다
  const s = text.normalize('NFKC').replace(APPROVAL_NO, ' ');
  const kinds = new Set<PIIKind>();

  if (scrubSensitive(s) !== s) {
    if (RRN.test(s)) kinds.add('resident_number');
    if (CARD16.test(s)) kinds.add('card_number');
    if (CREDENTIAL.test(s)) kinds.add('credential');
    // scrubSensitive 가 잡았지만 위에서 분류되지 않은 경우도 차단
    if (kinds.size === 0) kinds.add('credential');
  }
  if (RRN.test(s)) kinds.add('resident_number');
  if (CARD16.test(s) || CARD15.test(s)) kinds.add('card_number');

  for (const m of s.matchAll(HYPHEN_GROUPS)) {
    const token = m[0];
    const digits = token.replace(/-/g, '').length;
    if (BUSINESS_NO.test(token)) continue;
    if (/^\d{4}-\d{4}-\d{4}-\d{4}$|^\d{4}-\d{6}-\d{5}$/.test(token)) continue; // 카드번호로 이미 분류
    if (MOBILE.test(token)) {
      kinds.add('mobile_phone');
      continue;
    }
    if (LANDLINE.test(token)) continue;
    if (digits >= 10 && digits <= 16) kinds.add('account_number');
  }
  for (const m of s.matchAll(LONG_DIGITS)) {
    const token = m[0];
    if (MOBILE.test(token)) kinds.add('mobile_phone');
    else if (token.length === 13 && RRN.test(token)) kinds.add('resident_number');
    else if (token.length === 16 && CARD16.test(token)) kinds.add('card_number');
    else kinds.add('account_number');
  }
  return [...kinds];
}

/** 객체·배열을 재귀 탐색해 문자열 값의 PII 를 찾는다 (숫자·불리언은 검사하지 않음) */
export function findPII(value: unknown, path = 'input', seen: WeakSet<object> = new WeakSet()): PIIFinding[] {
  if (typeof value === 'string') return detectPII(value).map((kind) => ({ kind, path }));
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: PIIFinding[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findPII(v, `${path}[${i}]`, seen)));
    return out;
  }
  let keyIndex = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // 키 자체(예: Record 의 키로 쓰인 상호·메모)도 검사하고, PII 가 있는 키는 경로에 원문을 남기지 않는다
    const keyKinds = detectPII(k);
    const segment = keyKinds.length > 0 ? `${path}[key#${keyIndex}]` : `${path}.${k}`;
    for (const kind of keyKinds) out.push({ kind, path: segment });
    out.push(...findPII(v, segment, seen));
    keyIndex++;
  }
  return out;
}

export function containsPII(value: unknown): boolean {
  return findPII(value).length > 0;
}

export class PIIDetectedError extends Error {
  readonly findings: PIIFinding[];
  constructor(findings: PIIFinding[]) {
    const summary = findings.map((f) => `${f.path}(${PII_KIND_LABELS[f.kind]})`).join(', ');
    super(`개인식별정보 패턴이 있어 외부 AI 로 전송할 수 없습니다: ${summary}`);
    this.name = 'PIIDetectedError';
    this.findings = findings;
  }
}

/** PII 가 하나라도 있으면 PIIDetectedError. 외부 전송 직전에 반드시 호출한다. */
export function assertNoPII(value: unknown, path = 'input'): void {
  const findings = findPII(value, path);
  if (findings.length > 0) throw new PIIDetectedError(findings);
}
