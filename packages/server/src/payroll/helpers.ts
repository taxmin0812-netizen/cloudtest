/**
 * 인건비 area — 순수 도우미 (DB 없음, 단위 테스트 대상).
 * 기간·식별자 검증, 주민번호/계좌 정규화·마스킹, 급여행 ↔ PayrollLine 변환, 금액 합계, 변동 라벨, 링크.
 */
import { createHash } from 'node:crypto';
import { formatWon, maskResidentNumber, type IncomeType, type PayrollChangeKind, type PayrollLine, type Won } from '@mintax/core';
import { INCOME_TYPE_LABELS, computeLineWithholding, localIncomeTaxOf } from '@mintax/core/payroll/index';
import { ValidationError, type FieldError } from '@mintax/security';
import type { ZodType } from 'zod';

export const INCOME_TYPES: readonly IncomeType[] = ['earned', 'business', 'daily'];

/** 수임처·귀속월 단위 급여 작업 직렬화 잠금 네임스페이스 (pg_advisory_xact_lock(ns, hashtext(...))) */
export const PAYROLL_LOCK_NAMESPACE = 72_030;
/** filing_jobs 단위 잠금 (반기 묶음 작업은 여러 달이 같은 행을 갱신한다) */
export const FILING_LOCK_NAMESPACE = 72_031;

export const CHUNK = 500;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertPeriod(period: unknown, field = 'period', label = '귀속월'): string {
  if (typeof period !== 'string' || !PERIOD_RE.test(period)) {
    throw new ValidationError(`${label} 형식이 올바르지 않습니다. 예: 2026-09`, [{ field, message: 'YYYY-MM' }]);
  }
  return period;
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function assertUuid(v: unknown, field: string, what: string): string {
  if (!isUuid(v)) throw new ValidationError(`${what} 식별자가 올바르지 않습니다.`, [{ field, message: 'uuid' }]);
  return v;
}

/** 'YYYY-MM-DD' 실재 날짜만 허용 */
export function isLocalDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function assertLocalDate(v: unknown, field: string, label: string): string {
  if (!isLocalDate(v)) throw new ValidationError(`${label} 형식이 올바르지 않습니다. 예: 2026-09-25`, [{ field, message: 'YYYY-MM-DD' }]);
  return v;
}

/** zod 검증 → 한국어 ValidationError (필드 목록 포함) */
export function parseInput<T>(schema: ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fieldErrors: FieldError[] = r.error.issues.map((i) => ({ field: i.path.join('.') || '(입력값)', message: i.message }));
  const fields = [...new Set(fieldErrors.map((f) => f.field))].slice(0, 5).join(', ');
  throw new ValidationError(`${what} 입력값을 확인해 주세요. (확인 필요 항목: ${fields})`, fieldErrors);
}

export function chunk<T>(arr: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** KST 기준 오늘 'YYYY-MM-DD' */
export function kstToday(now: Date): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 두 날짜 사이 일수 (due − today). 음수면 기한 경과 */
export function daysBetween(today: string, due: string): number {
  const a = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  const b = Date.UTC(Number(due.slice(0, 4)), Number(due.slice(5, 7)) - 1, Number(due.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

export function dDayLabel(days: number): string {
  if (days === 0) return 'D-day';
  return days > 0 ? `D-${days}` : `D+${-days}`;
}

/** 반기 마지막 달: 1~6월 → YYYY-06, 7~12월 → YYYY-12 */
export function halfEndOf(period: string): string {
  const y = period.slice(0, 4);
  return Number(period.slice(5, 7)) <= 6 ? `${y}-06` : `${y}-12`;
}

// ────────────────────────────── 주민번호 · 계좌 ──────────────────────────────

/**
 * 주민(외국인)등록번호 정규화: 숫자 13자리만 허용. 성별자리 1~8 (외국인 5~8).
 * 오류 메시지에 입력값을 절대 넣지 않는다.
 */
export function normalizeIdNumber(raw: string): { digits: string; masked: string; isForeigner: boolean } {
  const s = String(raw ?? '').normalize('NFKC').trim();
  if (/[*＊●•]/.test(s)) {
    throw new ValidationError('마스킹된 주민(외국인)등록번호는 저장할 수 없습니다. 번호 전체를 입력해 주세요.', [{ field: 'idNumber', message: '마스킹 값' }]);
  }
  const digits = s.replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(digits)) {
    throw new ValidationError('주민(외국인)등록번호는 숫자 13자리여야 합니다. 번호를 확인해 주세요.', [{ field: 'idNumber', message: '13자리 숫자' }]);
  }
  const g = Number(digits[6]);
  if (g < 1 || g > 8) {
    throw new ValidationError('주민(외국인)등록번호 뒷자리 첫 숫자가 올바르지 않습니다 (1~8).', [{ field: 'idNumber', message: '성별자리' }]);
  }
  return { digits, masked: maskResidentNumber(digits)!, isForeigner: g >= 5 };
}

/** 계좌번호 정규화: 숫자만 6~20자리 */
export function normalizeBankAccount(raw: string): { digits: string; masked: string } {
  const s = String(raw ?? '').normalize('NFKC').trim();
  if (/[*＊●•]/.test(s)) {
    throw new ValidationError('마스킹된 계좌번호는 저장할 수 없습니다. 번호 전체를 입력해 주세요.', [{ field: 'bankAccount', message: '마스킹 값' }]);
  }
  const digits = s.replace(/[\s-]/g, '');
  if (!/^\d{6,20}$/.test(digits)) {
    throw new ValidationError('계좌번호는 숫자 6~20자리여야 합니다.', [{ field: 'bankAccount', message: '숫자 6~20자리' }]);
  }
  return { digits, masked: maskBankAccount(digits) };
}

/** 계좌 마스킹: 뒤 4자리만 남김 (예: ********6789) */
export function maskBankAccount(digits: string): string {
  const d = digits.replace(/\D/g, '');
  if (d.length <= 4) return '*'.repeat(d.length);
  return `${'*'.repeat(d.length - 4)}${d.slice(-4)}`;
}

/** 문자열 안의 주민번호 원문 형태(6+7자리) 탐지 — DTO·파일 방어 점검용 */
export const RAW_RRN_PATTERN = /(?<!\d)\d{6}-?[1-8]\d{6}(?!\d)/;

export function containsRawRrn(text: string): boolean {
  return RAW_RRN_PATTERN.test(text);
}

// ────────────────────────────── 급여행 ──────────────────────────────

export interface ItemRowLike {
  employeeId: string;
  incomeType: IncomeType;
  taxablePay: number;
  nonTaxablePay: number;
  grossPay: number;
  allowances: Record<string, number>;
  workDays: number | null;
  incomeTax: number;
  localIncomeTax: number;
  otherDeductions: number;
  netPay: number;
  paymentDate: string | null;
}

export function itemToLine(item: ItemRowLike, name: string): PayrollLine {
  return {
    employeeId: item.employeeId,
    name,
    incomeType: item.incomeType,
    taxablePay: item.taxablePay,
    nonTaxablePay: item.nonTaxablePay,
    grossPay: item.grossPay,
    allowances: { ...(item.allowances ?? {}) },
    ...(item.workDays !== null && item.workDays !== undefined ? { workDays: item.workDays } : {}),
    incomeTax: item.incomeTax,
    localIncomeTax: item.localIncomeTax,
    otherDeductions: item.otherDeductions,
    netPay: item.netPay,
    paymentDate: item.paymentDate,
  };
}

export interface LineAmounts {
  taxablePay: Won;
  nonTaxablePay: Won;
  grossPay: Won;
  incomeTax: Won;
  localIncomeTax: Won;
  otherDeductions: Won;
  netPay: Won;
  workDays: number | null;
  paymentDate: string | null;
}

export function amountsOf(l: PayrollLine | ItemRowLike): LineAmounts {
  return {
    taxablePay: l.taxablePay,
    nonTaxablePay: l.nonTaxablePay,
    grossPay: l.grossPay,
    incomeTax: l.incomeTax,
    localIncomeTax: l.localIncomeTax,
    otherDeductions: l.otherDeductions,
    netPay: l.netPay,
    workDays: l.workDays ?? null,
    paymentDate: l.paymentDate,
  };
}

/**
 * 파생 필드 재계산: 지급총액 = 과세 + 비과세, 사업·일용 세액은 법정 산식, 근로 지방소득세 = 소득세 × 10%, 차인지급액.
 * 근로소득 소득세는 간이세액표(WEHAGO 값)를 그대로 둔다.
 */
export function recomputeLine(line: PayrollLine, opts: { personalService?: boolean } = {}): { line: PayrollLine; basis: string[]; issues: string[] } {
  const grossPay = line.taxablePay + line.nonTaxablePay;
  const base: PayrollLine = { ...line, grossPay };
  let incomeTax = base.incomeTax;
  let localIncomeTax = base.localIncomeTax;
  let basis: string[] = [];
  const issues: string[] = [];
  if (base.incomeType === 'earned') {
    localIncomeTax = localIncomeTaxOf(incomeTax);
    basis = [`지방소득세 = 소득세 ${formatWon(incomeTax)} × 10% = ${formatWon(localIncomeTax)}`];
  } else {
    const w = computeLineWithholding(base, { personalService: opts.personalService });
    if (w.source === 'calculated') {
      incomeTax = w.incomeTax;
      localIncomeTax = w.localIncomeTax;
    }
    basis = w.basis;
    for (const i of w.issues) if (i.severity !== 'info') issues.push(i.message);
  }
  const netPay = grossPay - incomeTax - localIncomeTax - base.otherDeductions;
  return { line: { ...base, incomeTax, localIncomeTax, netPay }, basis, issues };
}

export function sameAmounts(a: LineAmounts, b: LineAmounts): boolean {
  return (
    a.taxablePay === b.taxablePay &&
    a.nonTaxablePay === b.nonTaxablePay &&
    a.grossPay === b.grossPay &&
    a.incomeTax === b.incomeTax &&
    a.localIncomeTax === b.localIncomeTax &&
    a.otherDeductions === b.otherDeductions &&
    a.netPay === b.netPay &&
    (a.workDays ?? null) === (b.workDays ?? null) &&
    (a.paymentDate ?? null) === (b.paymentDate ?? null)
  );
}

export interface MoneyTotals {
  headcount: number;
  taxablePay: Won;
  nonTaxablePay: Won;
  grossPay: Won;
  incomeTax: Won;
  localIncomeTax: Won;
  otherDeductions: Won;
  netPay: Won;
}

export function emptyMoneyTotals(): MoneyTotals {
  return { headcount: 0, taxablePay: 0, nonTaxablePay: 0, grossPay: 0, incomeTax: 0, localIncomeTax: 0, otherDeductions: 0, netPay: 0 };
}

export function sumLines(lines: ReadonlyArray<PayrollLine | ItemRowLike>): MoneyTotals & { byIncomeType: Record<IncomeType, MoneyTotals> } {
  const t = emptyMoneyTotals();
  const by: Record<IncomeType, MoneyTotals> = { earned: emptyMoneyTotals(), business: emptyMoneyTotals(), daily: emptyMoneyTotals() };
  for (const l of lines) {
    for (const x of [t, by[l.incomeType]]) {
      x.headcount += 1;
      x.taxablePay += l.taxablePay;
      x.nonTaxablePay += l.nonTaxablePay;
      x.grossPay += l.grossPay;
      x.incomeTax += l.incomeTax;
      x.localIncomeTax += l.localIncomeTax;
      x.otherDeductions += l.otherDeductions;
      x.netPay += l.netPay;
    }
  }
  return { ...t, byIncomeType: by };
}

/** 급여행 금액 지문 — 파일 생성 이후 변경 감지용 (주민번호 등 민감정보 미포함) */
export function itemsDigest(items: ReadonlyArray<{ id: string } & ItemRowLike>): string {
  const lines = [...items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((i) =>
      [i.id, i.employeeId, i.incomeType, i.taxablePay, i.nonTaxablePay, i.grossPay, i.incomeTax, i.localIncomeTax, i.otherDeductions, i.netPay, i.workDays ?? '', i.paymentDate ?? ''].join('|'),
    );
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

// ────────────────────────────── 라벨 ──────────────────────────────

export const CHANGE_KIND_LABELS: Record<PayrollChangeKind, string> = {
  unchanged: '변동 없음',
  pay_changed: '급여 변경',
  pay_changed_large: '큰 변동',
  new_hire: '신규 입사',
  missing_this_month: '이번 달 명단 없음',
  resigned: '퇴사',
  zero_pay: '0원 지급',
  missing_id: '주민번호 없음',
  income_type_changed: '소득구분 변경',
};

export const PAYROLL_STATUS_LABELS: Record<string, string> = {
  draft: '작성 중',
  reviewing: '검토 중',
  confirmed: '확정',
  exported: '파일 전달',
  filed: '신고 완료',
};

export const WIZARD_STEP_LABELS = ['기준 확인', '자료 반영', '변경분 검토', '세액 계산', '파일 생성', '신고 요약', '확정·신고 연계'] as const;

export function incomeTypeLabel(t: IncomeType): string {
  return INCOME_TYPE_LABELS[t];
}

/** 확정 이후 상태 (행 잠금) */
export const LOCKED_STATUSES = new Set(['confirmed', 'exported', 'filed']);

export function payrollHref(clientId: string, period: string): string {
  return `/payroll/${clientId}/${period}`;
}

export function employeesHref(clientId: string): string {
  return `/payroll/${clientId}/setup`;
}

export function filingHref(period: string): string {
  return `/filing?period=${period}`;
}

/** "김민수 과세급여 3,300,000원 → 3,630,000원, 소득세 …" */
export function describeAmountChange(name: string, before: Partial<LineAmounts>, after: Partial<LineAmounts>): string {
  const labels: Array<[keyof LineAmounts, string]> = [
    ['taxablePay', '과세급여'],
    ['nonTaxablePay', '비과세'],
    ['grossPay', '지급총액'],
    ['incomeTax', '소득세'],
    ['localIncomeTax', '지방소득세'],
    ['otherDeductions', '기타공제'],
    ['workDays', '근무일수'],
    ['paymentDate', '지급일'],
  ];
  const parts: string[] = [];
  for (const [k, label] of labels) {
    const a = before[k];
    const b = after[k];
    if (a === b || b === undefined) continue;
    if (k === 'workDays') parts.push(`${label} ${a ?? '-'}일 → ${b ?? '-'}일`);
    else if (k === 'paymentDate') parts.push(`${label} ${a ?? '-'} → ${b ?? '-'}`);
    else parts.push(`${label} ${typeof a === 'number' ? formatWon(a) : '-'} → ${typeof b === 'number' ? formatWon(b) : '-'}`);
  }
  return parts.length ? `${name} ${parts.join(', ')}` : `${name} 변경 없음`;
}

/** WEHAGO 사원코드 자동 부여 (수임처 내 순번, 4자리) */
export function nextEmployeeCode(existing: Iterable<string>): string {
  let max = 1000;
  for (const c of existing) {
    if (/^\d{1,9}$/.test(c)) max = Math.max(max, Number(c));
  }
  return String(max + 1);
}
