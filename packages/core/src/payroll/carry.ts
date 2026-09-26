import type { EmployeeSnapshot, LocalDate, PayrollLine, Won, YearMonth } from '../types';
import { nextYearMonth, yearMonthOf } from '../normalize';
import { lastDayOfMonth } from './calendar';
import { computeLineWithholding, type WithholdingParamsOverride } from './withholding';

/**
 * 이번달 인건비 초안 생성 — "전월 복사"가 아니라 "변동분 확인"의 출발점.
 * - 전월 지급행이 있으면 금액을 이어받고, 없으면 직원 마스터(기본급+수당+비과세)로 새로 만든다.
 * - 퇴사(퇴사일 < 이번달 1일)·미입사(입사일 > 이번달 말일)·비활성 직원은 제외한다.
 * - 사업소득·일용근로 세액은 산식으로 다시 계산하고, 근로소득 세액은 전월값을 유지한다(신규는 0 → WEHAGO 계산 필요).
 * - 입사·퇴사월 일할계산은 하지 않는다 (diffPayroll 에서 new_hire/resigned 로 검토 대상이 된다).
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
  const prevById = new Map<string, PayrollLine>();
  for (const l of prevLines) {
    if (!l.employeeId) continue;
    if (!prevById.has(l.employeeId)) prevById.set(l.employeeId, l);
  }
  const masterIds = new Set(employees.map((e) => e.employeeId));
  const lines: PayrollLine[] = [];
  const origins: Record<string, CarryOrigin> = {};
  const excluded: CarryForwardReport['excluded'] = [];
  const notes: string[] = [];

  for (const e of employees) {
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

    const prev = prevById.get(e.employeeId);
    let draft: PayrollLine;
    if (prev) {
      draft = {
        ...prev,
        allowances: { ...prev.allowances },
        name: e.name,
        incomeType: e.incomeType,
        paymentDate: prev.paymentDate ? shiftDateOneMonth(prev.paymentDate) : e.paymentDay ? dateInMonth(period, e.paymentDay) : null,
      };
      if (prev.incomeType !== e.incomeType) {
        notes.push(`${e.name}: 소득구분 ${prev.incomeType} → ${e.incomeType} (마스터 기준 적용, 세액 재확인 필요)`);
        if (e.incomeType === 'earned') draft = { ...draft, incomeTax: 0, localIncomeTax: 0 };
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
        allowances: e.incomeType === 'daily' ? {} : { ...e.allowances, ...e.nonTaxable },
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

  for (const l of prevLines) {
    if (l.employeeId && !masterIds.has(l.employeeId)) {
      excluded.push({ employeeId: l.employeeId, name: l.name, reason: '직원 마스터에 없음' });
    }
  }
  return { lines, origins, excluded, notes };
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
