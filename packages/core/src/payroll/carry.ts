import type { EmployeeSnapshot, LocalDate, PayrollLine, Won, YearMonth } from '../types';
import { nextYearMonth, yearMonthOf } from '../normalize';
import { lastDayOfMonth } from './calendar';
import { mergeEmployeeLines } from './diff';
import { computeLineWithholding, INCOME_TYPE_LABELS, type WithholdingParamsOverride } from './withholding';

/**
 * 이번달 인건비 초안 생성 — "전월 복사"가 아니라 "변동분 확인"의 출발점.
 * - 전월 지급행이 있으면 금액을 이어받고, 없으면 직원 마스터(기본급+수당+비과세)로 새로 만든다.
 * - 퇴사(퇴사일 < 이번달 1일)·미입사(입사일 > 이번달 말일)·비활성 직원은 제외한다.
 * - 사업소득·일용근로 세액은 산식으로 다시 계산하고, 근로소득 세액은 전월값을 유지한다(신규는 0 → WEHAGO 계산 필요).
 * - 입사·퇴사월 일할계산은 하지 않는다 (diffPayroll 에서 new_hire/resigned 로 검토 대상이 된다).
 * - 직원당 1행 (payroll_items 는 월·직원 unique). 전월 행이 여러 건이면 합산하고 notes 로 알린다 — 조용히 버리지 않는다.
 */

/** 직원 마스터 (db employees 테이블 중 초안 생성에 필요한 부분). 민감정보 원문은 포함하지 않는다. */
export interface EmployeeMaster extends EmployeeSnapshot {
  baseSalary: Won;
  /** 정기 과세 수당 (항목명 → 금액) */
  allowances: Record<string, Won>;
  /** 비과세 (식대 등) 항목명 → 금액 */
  nonTaxable: Record<string, Won>;
  /** 일용직 일당 */
  dailyWage?: Won | null;
  /** 사업소득 업종코드 (예: 940909) */
  businessIncomeCode?: string | null;
  /** 급여 지급일 (1~31) */
  paymentDay?: number | null;
  active?: boolean;
}

export type CarryOrigin = 'carried_forward' | 'master';

export interface CarryForwardReport {
  lines: PayrollLine[];
  /** employeeId → 생성 근거 (payroll_items.origin) */
  origins: Record<string, CarryOrigin>;
  excluded: Array<{ employeeId: string; name: string; reason: string }>;
  notes: string[];
}

export interface CarryForwardOptions {
  params?: WithholdingParamsOverride;
  /** 사업소득 인적용역 여부 (기본 true) */
  personalService?: boolean;
}

function sumValues(r: Record<string, Won>): Won {
  let t = 0;
  for (const v of Object.values(r)) t += v;
  return t;
}

/** 날짜를 한 달 뒤 같은 일로 (말일 초과 시 말일) */
export function shiftDateOneMonth(date: LocalDate): LocalDate {
  const ym = nextYearMonth(yearMonthOf(date));
  const last = lastDayOfMonth(ym);
  const day = Math.min(Number(date.slice(8, 10)), Number(last.slice(8, 10)));
  return `${ym}-${String(day).padStart(2, '0')}`;
}

function dateInMonth(period: YearMonth, day: number): LocalDate {
  const last = lastDayOfMonth(period);
  const d = Math.min(Math.max(1, Math.trunc(day)), Number(last.slice(8, 10)));
  return `${period}-${String(d).padStart(2, '0')}`;
}

function withTaxes(line: PayrollLine, opts: CarryForwardOptions): PayrollLine {
  const w = computeLineWithholding(line, { params: opts.params, personalService: opts.personalService });
  const incomeTax = w.incomeTax;
  const localIncomeTax = w.localIncomeTax;
  return {
    ...line,
    incomeTax,
    localIncomeTax,
    netPay: line.grossPay - incomeTax - localIncomeTax - line.otherDeductions,
  };
}

export function carryForwardWithReport(
  prevLines: PayrollLine[],
  employees: EmployeeMaster[],
  period: YearMonth,
  opts: CarryForwardOptions = {},
): CarryForwardReport {
  const periodStart = `${period}-01`;
  const periodEnd = lastDayOfMonth(period);
  const merged = mergeEmployeeLines(prevLines);
  const masterIds = new Set(employees.map((e) => e.employeeId));
  const lines: PayrollLine[] = [];
  const origins: Record<string, CarryOrigin> = {};
  const excluded: CarryForwardReport['excluded'] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const e of employees) {
    if (seen.has(e.employeeId)) {
      notes.push(`${e.name}: 직원 마스터 중복 (${e.employeeId}) — 첫 항목만 사용`);
      continue;
    }
    seen.add(e.employeeId);
    if (e.active === false) {
      excluded.push({ employeeId: e.employeeId, name: e.name, reason: '비활성 직원' });
      continue;
    }
    if (e.resignDate && e.resignDate < periodStart) {
      excluded.push({ employeeId: e.employeeId, name: e.name, reason: `퇴사 (퇴사일 ${e.resignDate})` });
      continue;
    }
    if (e.hireDate && e.hireDate > periodEnd) {
      excluded.push({ employeeId: e.employeeId, name: e.name, reason: `입사 전 (입사일 ${e.hireDate})` });
      continue;
    }

    const m = e.employeeId ? merged.get(`id:${e.employeeId}`) : undefined;
    let draft: PayrollLine;
    if (m) {
      const prev = m.line;
      if (m.count > 1) {
        notes.push(`${e.name}: 전월 지급 ${m.count}건 합산해 이어받음 — 상여 등 일회성 지급 포함 여부 확인`);
      }
      draft = {
        ...prev,
        allowances: { ...prev.allowances },
        name: e.name,
        incomeType: e.incomeType,
        paymentDate: carriedPaymentDate(prev.paymentDate, period, e.paymentDay, e.name, notes),
      };
      const typeChanged = m.incomeTypes.size > 1 || prev.incomeType !== e.incomeType;
      if (typeChanged) {
        const from = [...m.incomeTypes].map((t) => INCOME_TYPE_LABELS[t]).join('·');
        notes.push(`${e.name}: 소득구분 ${from} → ${INCOME_TYPE_LABELS[e.incomeType]} (마스터 기준 적용, 세액 재확인 필요)`);
        // 이전 소득구분의 세액을 이어받지 않는다 (사업·일용은 아래에서 재계산, 근로는 WEHAGO 값 필요)
        draft = { ...draft, incomeTax: 0, localIncomeTax: 0 };
        if (e.incomeType === 'daily' && !draft.workDays) notes.push(`${e.name}: 일용직 근무일수 미입력 — 세액 계산 불가`);
      }
      origins[e.employeeId] = 'carried_forward';
    } else {
      let taxablePay: Won;
      let nonTaxablePay: Won;
      let workDays: number | undefined;
      if (e.incomeType === 'daily') {
        // 일용직 신규: 근무일수를 알 수 없으므로 0일로 두고 입력을 기다린다 (zero_pay 로 검토 대상)
        workDays = 0;
        taxablePay = 0;
        nonTaxablePay = 0;
        if (!e.dailyWage) notes.push(`${e.name}: 일용직 일당 미등록`);
      } else {
        taxablePay = e.baseSalary + sumValues(e.allowances);
        nonTaxablePay = sumValues(e.nonTaxable);
      }
      draft = {
        employeeId: e.employeeId,
        name: e.name,
        incomeType: e.incomeType,
        taxablePay,
        nonTaxablePay,
        grossPay: taxablePay + nonTaxablePay,
        allowances: e.incomeType === 'daily' ? {} : mergeAllowanceDetail(e.allowances, e.nonTaxable),
        ...(workDays !== undefined ? { workDays } : {}),
        incomeTax: 0,
        localIncomeTax: 0,
        otherDeductions: 0,
        netPay: 0,
        paymentDate: e.paymentDay ? dateInMonth(period, e.paymentDay) : null,
      };
      if (e.incomeType === 'earned' && taxablePay > 0) {
        notes.push(`${e.name}: 신규 근로소득자 — 소득세는 WEHAGO 간이세액표 계산값으로 입력 필요`);
      }
      origins[e.employeeId] = 'master';
    }
    lines.push(withTaxes(draft, opts));
  }

  // 이어받지 못한 전월 행은 모두 사유와 함께 남긴다 (조용한 누락 방지)
  for (const [key, { line: l, count }] of merged) {
    const suffix = count > 1 ? ` (${count}건)` : '';
    if (!key.startsWith('id:')) {
      excluded.push({ employeeId: '', name: l.name, reason: '직원 ID 없음 — 직원 마스터와 연결 불가' });
    } else if (!masterIds.has(l.employeeId)) {
      excluded.push({ employeeId: l.employeeId, name: l.name, reason: `직원 마스터에 없음${suffix}` });
    }
  }
  return { lines, origins, excluded, notes };
}

/** 과세 수당 + 비과세 항목 상세. 같은 항목명이 양쪽에 있으면 비과세 쪽에 '(비과세)'를 붙여 덮어쓰기를 막는다 */
function mergeAllowanceDetail(taxable: Record<string, Won>, nonTaxable: Record<string, Won>): Record<string, Won> {
  const out: Record<string, Won> = { ...taxable };
  for (const [k, v] of Object.entries(nonTaxable)) out[k in out ? `${k}(비과세)` : k] = v;
  return out;
}

/**
 * 전월 지급일을 한 달 뒤로 옮긴다 (귀속월과 지급월의 차이를 유지).
 * 전월 자료가 두 달 이상 전 것이라 이번달 시작보다 이르면, 같은 일자를 이번달로 옮기고 안내한다.
 */
function carriedPaymentDate(
  prevDate: LocalDate | null,
  period: YearMonth,
  paymentDay: number | null | undefined,
  name: string,
  notes: string[],
): LocalDate | null {
  if (!prevDate) return paymentDay ? dateInMonth(period, paymentDay) : null;
  const shifted = shiftDateOneMonth(prevDate);
  if (shifted >= `${period}-01`) return shifted;
  const moved = dateInMonth(period, Number(prevDate.slice(8, 10)));
  notes.push(`${name}: 전월 지급일(${prevDate})이 ${period} 직전 달이 아님 — 지급일 ${moved}로 설정, 확인 필요`);
  return moved;
}

/** 이번달 초안 PayrollLine[] (상세 근거가 필요하면 carryForwardWithReport) */
export function carryForward(
  prevLines: PayrollLine[],
  employees: EmployeeMaster[],
  period: YearMonth,
  opts: CarryForwardOptions = {},
): PayrollLine[] {
  return carryForwardWithReport(prevLines, employees, period, opts).lines;
}
