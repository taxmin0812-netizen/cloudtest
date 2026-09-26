import type { LocalDate, YearMonth } from '../types';
import { nextYearMonth, weekdayOf } from '../normalize';

/**
 * 원천세·간이지급명세서 기한 캘린더.
 *
 * - 원천세: 징수일이 속하는 달의 다음 달 10일 (소득세법 제128조 ①)
 *   반기납부 특례: 1~6월분 → 7월 10일, 7~12월분 → 다음 해 1월 10일 (제128조 ②, 시행령 제186조)
 * - 지방소득세 특별징수: 원천세와 동일 기한 (지방세법 제103조의13 ② 및 단서)
 * - 기한이 토·일·공휴일(대체공휴일·노동절 포함)이면 다음 날 (국세기본법 제5조 ①, 지방세기본법 제24조 ①)
 *   다음 날도 공휴일이면 연쇄 적용 [추론 — research U13]
 *
 * 근거: docs/research/03-hometax-wetax-filing.md 2.5.1, 2.5.3, 4.3, 4.5
 */

// ────────────────────────────── 공휴일 (설정 데이터) ──────────────────────────────

export interface HolidayEntry {
  date: LocalDate;
  name: string;
}

/**
 * 관공서 공휴일 목록 (공휴일에 관한 법률 제2조, 관공서의 공휴일에 관한 규정 제2조·제3조 — 2026.4.30 개정 반영).
 * - 2026년부터 노동절(5/1)·제헌절(7/17) 공휴일 (공휴일법 개정 2026.2.10, 2026.4.9)
 * - 음력 명절은 한국 음력(dangi) 기준으로 산출
 * - 2026-06-03: 제9회 전국동시지방선거일 (공휴일법 제2조 제10호)
 * 검증필요: 정부가 수시 지정하는 임시공휴일은 반영되지 않음 → 관리자가 설정에서 추가해야 한다.
 */
export const KR_HOLIDAYS: HolidayEntry[] = [
  // 2026
  { date: '2026-01-01', name: '1월 1일' },
  { date: '2026-02-16', name: '설날 전날' },
  { date: '2026-02-17', name: '설날' },
  { date: '2026-02-18', name: '설날 다음 날' },
  { date: '2026-03-01', name: '3·1절' },
  { date: '2026-03-02', name: '대체공휴일(3·1절)' },
  { date: '2026-05-01', name: '노동절' },
  { date: '2026-05-05', name: '어린이날' },
  { date: '2026-05-24', name: '부처님 오신 날' },
  { date: '2026-05-25', name: '대체공휴일(부처님 오신 날)' },
  { date: '2026-06-03', name: '전국동시지방선거일' },
  { date: '2026-06-06', name: '현충일' },
  { date: '2026-07-17', name: '제헌절' },
  { date: '2026-08-15', name: '광복절' },
  { date: '2026-08-17', name: '대체공휴일(광복절)' },
  { date: '2026-09-24', name: '추석 전날' },
  { date: '2026-09-25', name: '추석' },
  { date: '2026-09-26', name: '추석 다음 날' },
  { date: '2026-10-03', name: '개천절' },
  { date: '2026-10-05', name: '대체공휴일(개천절)' },
  { date: '2026-10-09', name: '한글날' },
  { date: '2026-12-25', name: '기독탄신일' },
  // 2027 (검증필요: 공식 달력 발표 후 재확인)
  { date: '2027-01-01', name: '1월 1일' },
  { date: '2027-02-06', name: '설날 전날' },
  { date: '2027-02-07', name: '설날' },
  { date: '2027-02-08', name: '설날 다음 날' },
  { date: '2027-02-09', name: '대체공휴일(설날)' },
  { date: '2027-03-01', name: '3·1절' },
  { date: '2027-05-01', name: '노동절' },
  { date: '2027-05-03', name: '대체공휴일(노동절)' },
  { date: '2027-05-05', name: '어린이날' },
  { date: '2027-05-13', name: '부처님 오신 날' },
  { date: '2027-06-06', name: '현충일' },
  { date: '2027-07-17', name: '제헌절' },
  { date: '2027-07-19', name: '대체공휴일(제헌절)' },
  { date: '2027-08-15', name: '광복절' },
  { date: '2027-08-16', name: '대체공휴일(광복절)' },
  { date: '2027-09-14', name: '추석 전날' },
  { date: '2027-09-15', name: '추석' },
  { date: '2027-09-16', name: '추석 다음 날' },
  { date: '2027-10-03', name: '개천절' },
  { date: '2027-10-04', name: '대체공휴일(개천절)' },
  { date: '2027-10-09', name: '한글날' },
  { date: '2027-10-11', name: '대체공휴일(한글날)' },
  { date: '2027-12-25', name: '기독탄신일' },
  { date: '2027-12-27', name: '대체공휴일(기독탄신일)' },
];

/** 공휴일 목록이 신뢰할 수 있는 범위. 범위 밖 기한은 주말만 보정하고 경고한다. */
export const KR_HOLIDAY_COVERAGE = { from: '2026-01-01', to: '2027-12-31' } as const;

export interface CalendarOptions {
  /** 공휴일 목록 (기본 KR_HOLIDAYS). 임시공휴일 추가 시 전체 목록을 넘긴다 */
  holidays?: ReadonlyArray<HolidayEntry | LocalDate>;
  coverage?: { from: LocalDate; to: LocalDate };
}

function holidayMap(holidays: CalendarOptions['holidays']): Map<LocalDate, string> {
  const m = new Map<LocalDate, string>();
  for (const h of holidays ?? KR_HOLIDAYS) {
    if (typeof h === 'string') m.set(h, '공휴일');
    else m.set(h.date, h.name);
  }
  return m;
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

export function weekdayLabel(date: LocalDate): string {
  return WEEKDAY_KO[weekdayOf(date)]!;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** 'YYYY-MM' 의 말일 */
export function lastDayOfMonth(ym: YearMonth): LocalDate {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const dt = new Date(Date.UTC(y, m, 0));
  return dt.toISOString().slice(0, 10);
}

export function firstDayOfMonth(ym: YearMonth): LocalDate {
  return `${ym}-01`;
}

/** 토·일·공휴일이 아니면 영업일 */
export function isBusinessDay(date: LocalDate, opts: CalendarOptions = {}): boolean {
  const wd = weekdayOf(date);
  if (wd === 0 || wd === 6) return false;
  return !holidayMap(opts.holidays).has(date);
}

export interface DueDateDetail {
  /** 보정된 실제 기한 */
  dueDate: LocalDate;
  /** 법정 원래 기한 */
  statutoryDate: LocalDate;
  shifted: boolean;
  /** 예: "2026-10-10(토) 휴일 → 2026-10-12(월)" */
  shiftNote: string | null;
  /** 공휴일 목록 범위 밖 → 주말만 보정됨 */
  outsideHolidayCoverage: boolean;
  basis: string;
}

/** 기한이 토·일·공휴일이면 다음 영업일로 (연쇄 적용) */
export function shiftToBusinessDay(date: LocalDate, opts: CalendarOptions = {}): { date: LocalDate; skipped: string[] } {
  const map = holidayMap(opts.holidays);
  const skipped: string[] = [];
  let d = date;
  for (let i = 0; i < 31; i++) {
    const wd = weekdayOf(d);
    const holiday = map.get(d);
    if (wd !== 0 && wd !== 6 && !holiday) return { date: d, skipped };
    skipped.push(`${d}(${WEEKDAY_KO[wd]}${holiday ? `·${holiday}` : ''})`);
    d = addDays(d, 1);
  }
  return { date: d, skipped };
}

function buildDetail(statutory: LocalDate, basis: string, opts: CalendarOptions): DueDateDetail {
  const { date, skipped } = shiftToBusinessDay(statutory, opts);
  const cov = opts.coverage ?? KR_HOLIDAY_COVERAGE;
  const outside = !opts.holidays && (statutory < cov.from || date > cov.to);
  return {
    dueDate: date,
    statutoryDate: statutory,
    shifted: date !== statutory,
    shiftNote: date !== statutory ? `${skipped.join(', ')} 휴일 → ${date}(${weekdayLabel(date)})` : null,
    outsideHolidayCoverage: outside,
    basis,
  };
}

function assertYearMonth(ym: string, label: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error(`${label} 형식은 YYYY-MM 이어야 합니다: ${ym}`);
}

// ────────────────────────────── 원천세 / 지방소득세 ──────────────────────────────

/** 원천세 신고·납부 기한 상세. paymentPeriod = 지급(징수)연월 */
export function withholdingDueDetail(paymentPeriod: YearMonth, semiannual = false, opts: CalendarOptions = {}): DueDateDetail {
  assertYearMonth(paymentPeriod, '지급연월');
  const [y, m] = paymentPeriod.split('-').map(Number) as [number, number];
  if (!semiannual) {
    return buildDetail(`${nextYearMonth(paymentPeriod)}-10`, '징수일이 속하는 달의 다음 달 10일 (소득세법 제128조 ①)', opts);
  }
  const statutory = m <= 6 ? `${y}-07-10` : `${y + 1}-01-10`;
  return buildDetail(statutory, `반기납부 특례: ${m <= 6 ? '1~6월분 7월 10일' : '7~12월분 다음 해 1월 10일'} (소득세법 제128조 ②, 시행령 제186조)`, opts);
}

/** 원천세 신고·납부 기한 (휴일 보정 후) */
export function withholdingDueDate(paymentPeriod: YearMonth, semiannual = false, opts: CalendarOptions = {}): LocalDate {
  return withholdingDueDetail(paymentPeriod, semiannual, opts).dueDate;
}

/** 지방소득세 특별징수 납부기한 = 원천세와 동일 (지방세법 제103조의13 ② 및 단서) */
export function localIncomeTaxDueDate(paymentPeriod: YearMonth, semiannual = false, opts: CalendarOptions = {}): LocalDate {
  return withholdingDueDate(paymentPeriod, semiannual, opts);
}

// ────────────────────────────── 지급명세서 제출주기 (설정 데이터) ──────────────────────────────

/** earned: 근로소득 간이지급명세서 / business: 사업소득 간이지급명세서 / daily: 일용근로소득 지급명세서 / other_personal_service: 인적용역 기타소득 간이지급명세서 */
export type StatementKind = 'earned' | 'business' | 'daily' | 'other_personal_service';

export const STATEMENT_KIND_LABELS: Record<StatementKind, string> = {
  earned: '근로소득 간이지급명세서',
  business: '사업소득 간이지급명세서',
  daily: '일용근로소득 지급명세서',
  other_personal_service: '기타소득(인적용역) 간이지급명세서',
};

export type SubmissionCycle = 'monthly' | 'semiannual';

export interface CadenceRule {
  id: string;
  kind: StatementKind;
  /** 적용 시작 지급연월 (포함) */
  effectiveFrom: YearMonth;
  /** 적용 종료 지급연월 (포함), null = 계속 */
  effectiveTo: YearMonth | null;
  cycle: SubmissionCycle;
  /** monthly: 지급월 다음 달 말일 / semiannual: 반기 마지막 달의 다음 달 말일 */
  due: 'next_month_end' | 'half_next_month_end';
  legalBasis: string;
  /** confirmed: 현행 법령 확인 / enacted_recheck: 법률 확정이나 개정 여부 재확인 필요 */
  status: 'confirmed' | 'enacted_recheck';
  note?: string;
}

/**
 * 제출주기 규칙 — 코드가 아니라 데이터로 관리한다 (세법 개정 시 이 배열만 교체).
 * 근거: research 2.5.1, 2.5.2, 4.3
 */
export const SUBMISSION_CADENCE_RULES: CadenceRule[] = [
  {
    id: 'earned_semiannual_until_2026',
    kind: 'earned',
    effectiveFrom: '2019-01',
    effectiveTo: '2026-12',
    cycle: 'semiannual',
    due: 'half_next_month_end',
    legalBasis: '종전 소득세법 제164조의3 ① 1호, 부칙<제19196호> 제6조 ⑤',
    status: 'confirmed',
    note: '기한 후 3개월 이내 제출 시 가산세 0.125% (종전 제81조의11)',
  },
  {
    id: 'earned_monthly_from_2027',
    kind: 'earned',
    effectiveFrom: '2027-01',
    effectiveTo: null,
    cycle: 'monthly',
    due: 'next_month_end',
    legalBasis: '소득세법 제164조의3 ① 1호, 부칙<제19196호> 제1조 5호 (개정 2025.12.23)',
    status: 'enacted_recheck',
    note: '2026년 세법개정안 재유예 여부 재확인 필요. 2027년 지급분(반기납부자 2028년)은 종전 반기 기한 내 제출 시 미제출가산세 면제 (제81조의11 ③ 1호)',
  },
  {
    id: 'business_monthly_from_2021_07',
    kind: 'business',
    effectiveFrom: '2021-07',
    effectiveTo: null,
    cycle: 'monthly',
    due: 'next_month_end',
    legalBasis: '소득세법 제164조의3 ① 2호, 부칙<제17925호>',
    status: 'confirmed',
    note: '제출분은 지급명세서 제출로 간주 (제164조 ⑦, 연말정산 사업소득 제외)',
  },
  {
    id: 'daily_monthly_from_2021_07',
    kind: 'daily',
    effectiveFrom: '2021-07',
    effectiveTo: null,
    cycle: 'monthly',
    due: 'next_month_end',
    legalBasis: '소득세법 제164조 ① 단서',
    status: 'confirmed',
  },
  {
    id: 'other_personal_service_monthly_from_2024_01',
    kind: 'other_personal_service',
    effectiveFrom: '2024-01',
    effectiveTo: null,
    cycle: 'monthly',
    due: 'next_month_end',
    legalBasis: '소득세법 제164조의3 ① 3호, 부칙<제19196호> 제1조 3호',
    status: 'confirmed',
  },
];

export function findCadenceRule(
  kind: StatementKind,
  paymentPeriod: YearMonth,
  rules: ReadonlyArray<CadenceRule> = SUBMISSION_CADENCE_RULES,
): CadenceRule | null {
  return (
    rules.find(
      (r) => r.kind === kind && r.effectiveFrom <= paymentPeriod && (r.effectiveTo === null || paymentPeriod <= r.effectiveTo),
    ) ?? null
  );
}

export interface StatementDueDetail extends DueDateDetail {
  kind: StatementKind;
  cycle: SubmissionCycle;
  /** 이번 제출에 포함되는 지급연월 범위 */
  submissionPeriod: { from: YearMonth; to: YearMonth };
  ruleId: string;
  status: CadenceRule['status'];
  note: string | null;
}

export interface StatementCalendarOptions extends CalendarOptions {
  rules?: ReadonlyArray<CadenceRule>;
}

/** 지급명세서 제출기한 상세. period = 지급연월 */
export function simplifiedStatementDueDetail(
  kind: StatementKind,
  period: YearMonth,
  opts: StatementCalendarOptions = {},
): StatementDueDetail {
  assertYearMonth(period, '지급연월');
  const rule = findCadenceRule(kind, period, opts.rules);
  if (!rule) throw new Error(`${STATEMENT_KIND_LABELS[kind]}: ${period} 지급분에 적용할 제출주기 규칙이 없습니다`);
  const [y, m] = period.split('-').map(Number) as [number, number];
  let from: YearMonth;
  let to: YearMonth;
  if (rule.cycle === 'semiannual') {
    from = m <= 6 ? `${y}-01` : `${y}-07`;
    to = m <= 6 ? `${y}-06` : `${y}-12`;
  } else {
    from = period;
    to = period;
  }
  const statutory = lastDayOfMonth(nextYearMonth(to));
  const basis =
    rule.cycle === 'semiannual'
      ? `반기 제출: ${from}~${to} 지급분 → 다음 달 말일 (${rule.legalBasis})`
      : `매월 제출: 지급월의 다음 달 말일 (${rule.legalBasis})`;
  const detail = buildDetail(statutory, basis, opts);
  return {
    ...detail,
    kind,
    cycle: rule.cycle,
    submissionPeriod: { from, to },
    ruleId: rule.id,
    status: rule.status,
    note: rule.note ?? null,
  };
}

/** 지급명세서 제출기한 (휴일 보정 후) */
export function simplifiedStatementDueDate(kind: StatementKind, period: YearMonth, opts: StatementCalendarOptions = {}): LocalDate {
  return simplifiedStatementDueDetail(kind, period, opts).dueDate;
}
