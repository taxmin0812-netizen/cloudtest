import type { EmployeeSnapshot, IncomeType, LocalDate, PayrollLine, UUID, Won, YearMonth } from '../types';
import { formatWon } from '../money';
import { yearMonthOf } from '../normalize';
import {
  firstDayOfMonth,
  lastDayOfMonth,
  simplifiedStatementDueDetail,
  withholdingDueDetail,
  type CalendarOptions,
  type StatementCalendarOptions,
  type StatementDueDetail,
  type StatementKind,
} from './calendar';
import {
  computeLineWithholding,
  earnedZeroTaxIssue,
  invalidMoneyFields,
  localIncomeTaxOf,
  resolveWithholdingParams,
  type WithholdingParamsOverride,
} from './withholding';

/**
 * 원천징수이행상황신고서 요약 / 간이지급명세서·일용근로소득 지급명세서 행 생성.
 *
 * MIN TAX OPS 는 신고 파일을 만들지 않는다 (FILE_BASED: WEHAGO 생성 → 사람이 홈택스 업로드).
 * 여기서 만드는 값은 WEHAGO 마감값과 대조하기 위한 "신고 전 검증용 집계"다. (research 4.1, U1)
 */

// ────────────────────────────── 원천징수이행상황신고서 ──────────────────────────────

/**
 * 원천징수이행상황신고서(소득세법 시행규칙 별지 제21호서식) 소득코드.
 * 검증필요: 코드·라벨은 현행 서식 작성요령 원문과 대조 필요 (research B7 — 현행 서식 개정일 미확인).
 */
export const WITHHOLDING_RETURN_CODES = {
  A01: { label: '근로소득 간이세액', group: 'earned' },
  A02: { label: '근로소득 중도퇴사', group: 'earned' },
  A03: { label: '근로소득 일용근로', group: 'earned' },
  A04: { label: '근로소득 연말정산', group: 'earned' },
  A10: { label: '근로소득 가감계', group: 'earned' },
  A20: { label: '퇴직소득 가감계', group: 'retirement' },
  A25: { label: '사업소득 매월징수', group: 'business' },
  A26: { label: '사업소득 연말정산', group: 'business' },
  A30: { label: '사업소득 가감계', group: 'business' },
  A99: { label: '총합계', group: 'total' },
} as const;

export type WithholdingReturnCode = keyof typeof WITHHOLDING_RETURN_CODES;

export interface WithholdingReturnRow {
  code: WithholdingReturnCode;
  label: string;
  /** 인원 (소득자 수, 중복 제거) */
  persons: number;
  /** 총지급액 */
  totalPay: Won;
  /** 징수세액(소득세 등) */
  incomeTax: Won;
  isSubtotal: boolean;
}

export interface LocalIncomeTaxSummary {
  /** 특별징수 세율 (소득세의 10%) */
  rate: number;
  /** 급여행 입력 지방소득세 합계 */
  declared: Won;
  /** 행별 소득세 × 10% 재계산 합계 */
  expected: Won;
  byIncomeType: Record<IncomeType, Won>;
  matches: boolean;
  dueDate: LocalDate;
}

export interface WithholdingReturnSummary {
  /** 지급연월 */
  paymentPeriod: YearMonth;
  /** 귀속연월 (알 때만) */
  attributionPeriod: YearMonth | null;
  semiannual: boolean;
  rows: WithholdingReturnRow[];
  total: WithholdingReturnRow;
  localIncomeTax: LocalIncomeTaxSummary;
  dueDate: LocalDate;
  dueNote: string | null;
  warnings: string[];
  /** 금액 형식 오류로 집계에서 제외한 행 — 0건이 아니면 신고 전 반드시 수정 */
  excludedLines: ExcludedLine[];
  /** 이 요약이 다루지 않는 항목 (WEHAGO 값 확인) */
  notCovered: string[];
}

export interface ExcludedLine {
  employeeId: UUID;
  name: string;
  reason: string;
}

export interface WithholdingReturnOptions extends CalendarOptions {
  semiannual?: boolean;
  attributionPeriod?: YearMonth;
  /**
   * 총지급액에 비과세 포함 여부 (기본 true).
   * 검증필요: 작성요령상 일부 비과세(지급명세서 작성 제외 비과세 등)는 제외 — 항목 구분이 없어 전액 포함.
   */
  includeNonTaxableInTotalPay?: boolean;
  /** 사업소득 인적용역 여부 (기본 true — 소액부징수 배제). 의료보건용역 등은 false */
  personalService?: boolean;
  params?: WithholdingParamsOverride;
}

/** 원 단위 정수가 아닌 금액이 있는 행을 분리한다 (합계에 섞이면 신고값 전체가 틀어진다) */
function splitInvalid(lines: PayrollLine[]): { valid: PayrollLine[]; excluded: ExcludedLine[] } {
  const valid: PayrollLine[] = [];
  const excluded: ExcludedLine[] = [];
  for (const l of lines) {
    const bad = invalidMoneyFields(l);
    if (bad.length) excluded.push({ employeeId: l.employeeId, name: l.name, reason: `원 단위 정수가 아닌 금액(${bad.join(', ')})` });
    else valid.push(l);
  }
  return { valid, excluded };
}

function excludedWarning(excluded: ExcludedLine[]): string[] {
  return excluded.length ? [`금액 형식 오류 ${excluded.length}건 집계 제외 — 수정 후 다시 집계해야 합니다 (${excluded.map((e) => e.name).join(', ')})`] : [];
}

function payOf(l: PayrollLine, includeNonTaxable: boolean): Won {
  return includeNonTaxable ? l.grossPay : l.taxablePay;
}

function isPaid(l: PayrollLine): boolean {
  return l.grossPay !== 0 || l.incomeTax !== 0;
}

function row(code: WithholdingReturnCode, lines: PayrollLine[], includeNonTaxable: boolean): WithholdingReturnRow {
  const paid = lines.filter(isPaid);
  const persons = new Set(paid.map((l) => l.employeeId || `name:${l.name}`)).size;
  return {
    code,
    label: WITHHOLDING_RETURN_CODES[code].label,
    persons,
    totalPay: paid.reduce((t, l) => t + payOf(l, includeNonTaxable), 0),
    incomeTax: paid.reduce((t, l) => t + l.incomeTax, 0),
    isSubtotal: false,
  };
}

function subtotal(code: WithholdingReturnCode, parts: WithholdingReturnRow[]): WithholdingReturnRow {
  return {
    code,
    label: WITHHOLDING_RETURN_CODES[code].label,
    persons: parts.reduce((t, r) => t + r.persons, 0),
    totalPay: parts.reduce((t, r) => t + r.totalPay, 0),
    incomeTax: parts.reduce((t, r) => t + r.incomeTax, 0),
    isSubtotal: true,
  };
}

/**
 * 원천징수이행상황신고서 요약 (A01 / A03 / A10 / A25 / A30 / A99).
 * @param lines 해당 지급연월(반기납부는 반기 전체)의 급여행
 * @param period 지급연월 'YYYY-MM' (반기납부는 반기 중 아무 달)
 */
export function buildWithholdingReturn(
  allLines: PayrollLine[],
  period: YearMonth,
  opts: WithholdingReturnOptions = {},
): WithholdingReturnSummary {
  const includeNonTaxable = opts.includeNonTaxableInTotalPay ?? true;
  const semiannual = opts.semiannual ?? false;
  const p = resolveWithholdingParams(opts.params);
  const { valid: lines, excluded } = splitInvalid(allLines);
  const warnings: string[] = excludedWarning(excluded);

  // 지급연월 범위 점검 (조용히 제외하지 않고 경고)
  const [y, m] = period.split('-').map(Number) as [number, number];
  const range = semiannual
    ? { from: m <= 6 ? `${y}-01` : `${y}-07`, to: m <= 6 ? `${y}-06` : `${y}-12` }
    : { from: period, to: period };
  const outOfRange = lines.filter((l) => l.paymentDate && (yearMonthOf(l.paymentDate) < range.from || yearMonthOf(l.paymentDate) > range.to));
  if (outOfRange.length) {
    warnings.push(`지급일이 신고 지급연월(${range.from === range.to ? range.from : `${range.from}~${range.to}`})과 다른 내역 ${outOfRange.length}건 — 지급연월 확인`);
  }
  const noDate = lines.filter((l) => !l.paymentDate).length;
  if (noDate) warnings.push(`지급일 미입력 ${noDate}건 — 원천세는 지급일 기준으로 신고합니다`);

  const earned = lines.filter((l) => l.incomeType === 'earned');
  const daily = lines.filter((l) => l.incomeType === 'daily');
  const business = lines.filter((l) => l.incomeType === 'business');

  const rows: WithholdingReturnRow[] = [];
  const subtotals: WithholdingReturnRow[] = [];
  if (earned.length || daily.length) {
    const parts: WithholdingReturnRow[] = [];
    if (earned.length) parts.push(row('A01', earned, includeNonTaxable));
    if (daily.length) parts.push(row('A03', daily, includeNonTaxable));
    const a10 = subtotal('A10', parts);
    rows.push(...parts, a10);
    subtotals.push(a10);
  }
  if (business.length) {
    const a25 = row('A25', business, includeNonTaxable);
    const a30 = subtotal('A30', [a25]);
    rows.push(a25, a30);
    subtotals.push(a30);
  }
  const total = subtotal('A99', subtotals);
  rows.push(total);

  // 세액 정합성 (사업·일용은 재계산, 근로는 입력값) + 행 단위 경고(근무일수 누락, 지급총액 불일치 등)
  for (const l of lines) {
    if (!isPaid(l)) continue;
    const w = computeLineWithholding(l, { params: opts.params, personalService: opts.personalService });
    for (const issue of w.issues) {
      if (issue.severity !== 'info') warnings.push(`${l.name}: ${issue.message}`);
    }
    if (w.source === 'calculated' && l.incomeType !== 'earned' && w.incomeTax !== l.incomeTax) {
      warnings.push(`${l.name}: 소득세 입력 ${formatWon(l.incomeTax)} ≠ 계산 ${formatWon(w.incomeTax)}`);
    }
    const zero = earnedZeroTaxIssue(l, { params: opts.params });
    if (zero) warnings.push(`${l.name}: ${zero.message}`);
  }
  const negative = lines.filter((l) => l.incomeTax < 0);
  if (negative.length) warnings.push(`음수 소득세 ${negative.length}건 — 환급/조정 내역은 WEHAGO 신고서에서 확인`);

  // 지방소득세 특별징수
  const byIncomeType: Record<IncomeType, Won> = { earned: 0, business: 0, daily: 0 };
  let declared = 0;
  let expected = 0;
  for (const l of lines) {
    declared += l.localIncomeTax;
    expected += localIncomeTaxOf(l.incomeTax, opts.params);
    byIncomeType[l.incomeType] += l.localIncomeTax;
  }
  if (declared !== expected) {
    warnings.push(`지방소득세 합계 불일치: 입력 ${formatWon(declared)}, 소득세×10% 재계산 ${formatWon(expected)}`);
  }

  if (semiannual) {
    warnings.push('반기납부: 인원은 반기 중 지급 대상자 실인원으로 집계 — 서식 작성요령과 대조 필요(검증필요)');
  }

  const due = withholdingDueDetail(semiannual ? range.to : period, semiannual, opts);
  if (due.outsideHolidayCoverage) warnings.push('기한이 공휴일 목록 범위 밖 — 주말만 보정됨, 공휴일 확인 필요');

  return {
    paymentPeriod: period,
    attributionPeriod: opts.attributionPeriod ?? null,
    semiannual,
    rows,
    total,
    localIncomeTax: {
      rate: p.localIncomeTaxRate,
      declared,
      expected,
      byIncomeType,
      matches: declared === expected,
      dueDate: due.dueDate,
    },
    dueDate: due.dueDate,
    dueNote: due.shiftNote,
    warnings,
    excludedLines: excluded,
    notCovered: [
      'A02 중도퇴사·A04 연말정산 (연말정산 결과는 WEHAGO 값 사용)',
      'A20 퇴직소득, A40 기타소득 등 인건비 외 소득',
      '전월 미환급세액·당월 조정환급세액·가산세',
    ],
  };
}

// ────────────────────────────── 간이지급명세서 / 일용근로소득 지급명세서 ──────────────────────────────

/** 지급명세서 작성용 직원 정보 (주민번호는 마스킹본만) */
export type StatementEmployee = EmployeeSnapshot & { businessIncomeCode?: string | null };

export interface StatementPerson {
  /** 참조 ID — 제출 파일 생성 시 서버가 권한 확인 후 복호화하는 키 (원문 주민번호 아님) */
  employeeId: UUID;
  name: string;
  /** 마스킹된 주민번호 (예: 900101-1******). 원문은 절대 담지 않는다 */
  idNumberMasked: string | null;
  hasIdNumber: boolean;
}

export interface BusinessStatementRow extends StatementPerson {
  paymentPeriod: YearMonth;
  /** 업종코드 (예: 940909) */
  industryCode: string | null;
  paidAmount: Won;
  /** 세율 (%) */
  taxRatePct: number;
  incomeTax: Won;
  localIncomeTax: Won;
}

export interface EarnedStatementRow extends StatementPerson {
  paymentPeriod: YearMonth;
  /** 제출단위(반기/월) 안에서의 근무기간 */
  workPeriodFrom: LocalDate;
  workPeriodTo: LocalDate;
  taxablePay: Won;
  nonTaxablePay: Won;
}

export interface DailyStatementRow extends StatementPerson {
  paymentPeriod: YearMonth;
  workDays: number;
  taxablePay: Won;
  nonTaxablePay: Won;
  incomeTax: Won;
  localIncomeTax: Won;
}

export interface StatementBundle<R> {
  kind: StatementKind;
  label: string;
  rows: R[];
  totals: { persons: number; paidAmount: Won; incomeTax: Won; localIncomeTax: Won };
  due: StatementDueDetail;
}

export interface SimplifiedStatements {
  paymentPeriod: YearMonth;
  business: StatementBundle<BusinessStatementRow>;
  earned: StatementBundle<EarnedStatementRow>;
  daily: StatementBundle<DailyStatementRow>;
  warnings: string[];
  /** 금액 형식 오류로 제외한 행 — 0건이 아니면 제출 전 반드시 수정 */
  excludedLines: ExcludedLine[];
}

export interface SimplifiedStatementOptions extends StatementCalendarOptions {
  /** 사업소득 인적용역 여부 (기본 true — 소액부징수 배제). 의료보건용역 등은 false */
  personalService?: boolean;
  params?: WithholdingParamsOverride;
}

/** 허용 마스킹 형식: 앞 6자리 + 뒷자리 첫 자리(또는 *) + ****** */
const CANONICAL_MASK = /^\d{6}-[\d*]\*{6}$/;
const FULL_MASK = '******-*******';

/**
 * 주민(외국인)등록번호 마스킹본만 내보낸다.
 * 원문·부분 마스킹('900101-12345**')·자릿수 이상 등 어떤 입력이 와도 뒷자리 첫 자리 이후 숫자는 절대 노출하지 않는다.
 * - 표준 마스킹 형식이면 그대로
 * - 앞 6자리(생년월일)로 시작하면 앞 6자리 + 뒷자리 첫 자리만 남겨 재마스킹
 * - 그 외(앞자리 가림·형식 불명)는 전체 마스킹 — 뒷자리 숫자를 앞자리로 오인해 노출하지 않도록
 */
export function safeMaskedId(masked: string | null | undefined): string | null {
  if (!masked) return null;
  const s = masked.replace(/\s/g, '');
  if (CANONICAL_MASK.test(s)) return s;
  const withGender = s.match(/^(\d{6})-?(\d)/);
  if (withGender) return `${withGender[1]}-${withGender[2]}******`;
  const front = s.match(/^(\d{6})(?!\d)/);
  if (front) return `${front[1]}-*******`;
  return FULL_MASK;
}

function person(line: PayrollLine, emp: StatementEmployee | undefined): StatementPerson {
  return {
    employeeId: line.employeeId,
    name: emp?.name ?? line.name,
    idNumberMasked: safeMaskedId(emp?.idNumberMasked),
    hasIdNumber: emp?.hasIdNumber ?? false,
  };
}

function bundle<R extends StatementPerson>(
  kind: StatementKind,
  label: string,
  rows: R[],
  amounts: (r: R) => { paid: Won; tax: Won; local: Won },
  due: StatementDueDetail,
): StatementBundle<R> {
  const totals = { persons: new Set(rows.map((r) => r.employeeId || r.name)).size, paidAmount: 0, incomeTax: 0, localIncomeTax: 0 };
  for (const r of rows) {
    const a = amounts(r);
    totals.paidAmount += a.paid;
    totals.incomeTax += a.tax;
    totals.localIncomeTax += a.local;
  }
  return { kind, label, rows, totals, due };
}

function maxD(a: LocalDate, b: LocalDate): LocalDate {
  return a >= b ? a : b;
}
function minD(a: LocalDate, b: LocalDate): LocalDate {
  return a <= b ? a : b;
}

/**
 * 간이지급명세서(사업·근로) / 일용근로소득 지급명세서 행 생성.
 * @param period 지급연월 'YYYY-MM'
 * 제출주기·기한은 calendar.SUBMISSION_CADENCE_RULES(데이터)로 결정된다.
 */
export function buildSimplifiedStatements(
  allLines: PayrollLine[],
  employees: StatementEmployee[],
  period: YearMonth,
  opts: SimplifiedStatementOptions = {},
): SimplifiedStatements {
  const p = resolveWithholdingParams(opts.params);
  const empById = new Map(employees.map((e) => [e.employeeId, e]));
  const { valid: lines, excluded } = splitInvalid(allLines);
  const warnings: string[] = excludedWarning(excluded);
  const businessRows: BusinessStatementRow[] = [];
  const earnedRows: EarnedStatementRow[] = [];
  const dailyRows: DailyStatementRow[] = [];

  const earnedDue = simplifiedStatementDueDetail('earned', period, opts);
  let outOfPeriod = 0;

  for (const l of lines) {
    if (!isPaid(l)) continue;
    if (l.paymentDate && yearMonthOf(l.paymentDate) !== period) outOfPeriod++;
    const emp = empById.get(l.employeeId);
    const who = person(l, emp);
    if (!emp) warnings.push(`${l.name}: 직원 마스터 없음 — 인적사항 확인 필요`);
    else if (!emp.hasIdNumber) warnings.push(`${who.name}: 주민(외국인)등록번호 미등록 — 제출 전 등록 필요`);

    switch (l.incomeType) {
      case 'business': {
        const code = emp?.businessIncomeCode ?? null;
        if (!code) warnings.push(`${who.name}: 사업소득 업종코드 미등록`);
        const calc = computeLineWithholding(l, { params: opts.params, personalService: opts.personalService });
        if (calc.incomeTax !== l.incomeTax) {
          warnings.push(`${who.name}: 사업소득세 입력 ${formatWon(l.incomeTax)} ≠ 계산 ${formatWon(calc.incomeTax)}`);
        }
        businessRows.push({
          ...who,
          paymentPeriod: period,
          industryCode: code,
          paidAmount: l.grossPay,
          taxRatePct: Math.round(p.business.incomeTaxRate * 1000) / 10,
          incomeTax: l.incomeTax,
          localIncomeTax: l.localIncomeTax,
        });
        break;
      }
      case 'daily': {
        if (!l.workDays) warnings.push(`${who.name}: 일용직 근무일수 미입력`);
        dailyRows.push({
          ...who,
          paymentPeriod: period,
          workDays: l.workDays ?? 0,
          taxablePay: l.taxablePay,
          nonTaxablePay: l.nonTaxablePay,
          incomeTax: l.incomeTax,
          localIncomeTax: l.localIncomeTax,
        });
        break;
      }
      case 'earned': {
        const from = firstDayOfMonth(earnedDue.submissionPeriod.from);
        const to = lastDayOfMonth(earnedDue.submissionPeriod.to);
        const workPeriodFrom = emp?.hireDate ? maxD(emp.hireDate, from) : from;
        const workPeriodTo = emp?.resignDate ? minD(emp.resignDate, to) : to;
        if (workPeriodFrom > workPeriodTo) {
          warnings.push(`${who.name}: 근무기간 역전(${workPeriodFrom} > ${workPeriodTo}) — 입사일·퇴사일과 지급연월 확인`);
        }
        earnedRows.push({
          ...who,
          paymentPeriod: period,
          workPeriodFrom,
          workPeriodTo,
          taxablePay: l.taxablePay,
          nonTaxablePay: l.nonTaxablePay,
        });
        break;
      }
    }
  }
  if (outOfPeriod) warnings.push(`지급일이 지급연월(${period})과 다른 내역 ${outOfPeriod}건 — 지급연월 확인`);

  const business = bundle('business', '사업소득 간이지급명세서', businessRows, (r) => ({ paid: r.paidAmount, tax: r.incomeTax, local: r.localIncomeTax }), simplifiedStatementDueDetail('business', period, opts));
  const earned = bundle('earned', '근로소득 간이지급명세서', earnedRows, (r) => ({ paid: r.taxablePay + r.nonTaxablePay, tax: 0, local: 0 }), earnedDue);
  const daily = bundle('daily', '일용근로소득 지급명세서', dailyRows, (r) => ({ paid: r.taxablePay + r.nonTaxablePay, tax: r.incomeTax, local: r.localIncomeTax }), simplifiedStatementDueDetail('daily', period, opts));

  if (earned.due.cycle === 'semiannual' && earnedRows.length) {
    warnings.push(
      `근로소득 간이지급명세서는 반기 제출(${earned.due.submissionPeriod.from}~${earned.due.submissionPeriod.to}, 기한 ${earned.due.dueDate}) — 월별 행을 반기 합산해 제출`,
    );
  }
  if (earned.due.status === 'enacted_recheck' && earnedRows.length) {
    warnings.push('근로소득 간이지급명세서 월별 제출은 2026년 세법개정 결과 재확인 필요');
  }

  return { paymentPeriod: period, business, earned, daily, warnings, excludedLines: excluded };
}

/**
 * 반기 제출용: 여러 달의 근로소득 간이지급명세서 행을 직원별로 합산한다.
 */
export function aggregateEarnedStatementRows(rows: EarnedStatementRow[]): EarnedStatementRow[] {
  const map = new Map<string, EarnedStatementRow>();
  for (const r of rows) {
    const key = r.employeeId || `name:${r.name}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...r });
      continue;
    }
    prev.taxablePay += r.taxablePay;
    prev.nonTaxablePay += r.nonTaxablePay;
    prev.workPeriodFrom = minD(prev.workPeriodFrom, r.workPeriodFrom);
    prev.workPeriodTo = maxD(prev.workPeriodTo, r.workPeriodTo);
    if (r.paymentPeriod > prev.paymentPeriod) prev.paymentPeriod = r.paymentPeriod;
  }
  return [...map.values()];
}
