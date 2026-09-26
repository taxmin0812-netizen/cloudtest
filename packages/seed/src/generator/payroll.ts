import type { IncomeType, LocalDate, PayrollChangeKind, Won, YearMonth } from '@mintax/core';
import { SCENARIO_PAYROLL_CODE } from './clients';
import { makeFakeResidentNumber, makePersonName } from './ids';
import { rngFor, type Rng } from './prng';
import { CURRENT_MONTH, HISTORY_MONTHS } from './transactions';
import type { ExpectedPayrollChange, SyntheticClient, SyntheticEmployee, SyntheticPayroll, SyntheticPayrollLine } from './types';

/**
 * 인건비 합성 데이터 — 직원 마스터 + 2026-03~08 확정 급여 + 2026-09 수임처 제출분.
 *
 * 세액은 합성 근사값이다.
 * - 사업소득 3%·지방소득세 10%, 일용근로 (일당−150,000)×6%×(1−55%) 는 법정 산식 (core payroll/withholding 과 같은 끝수 처리)
 * - 근로소득 소득세는 간이세액표가 아닌 합성 근사식 (검증필요 — 실제 세액은 WEHAGO 계산값 사용)
 * - 4대보험 근로자 부담 합계는 과세급여 × 9.4% 근사 (검증필요)
 *
 * 시나리오 (docs/06-mvp-plan.md §3.2): 시나리오상사 직원 10명, 9월에 김민수 3,300,000 → 3,630,000 (+10%), 최지훈 명단 없음(8/31 퇴사).
 */

export const PAYROLL_SCENARIO_NAMES = { raised: '김민수', missing: '최지훈' } as const;

/** 비과세 식대 월 한도 (소득세법 시행령 제17조의2, 2023년~ 20만원) — 검증필요 */
export const MEAL_ALLOWANCE_NONTAXABLE: Won = 200_000;
/** 자가운전보조금 비과세 월 한도 20만원 — 검증필요 */
export const CAR_ALLOWANCE_NONTAXABLE: Won = 200_000;
/** 4대보험 근로자 부담 근사율 (국민연금 4.75% + 건강 3.595% + 장기요양 + 고용 0.9% ≈ 9.4%) — 검증필요 */
export const SOCIAL_INSURANCE_APPROX_RATE_PERMILLE = 94;
/** 사업소득 업종코드 합성 기본값 — 실제 코드는 검증필요 */
export const DEFAULT_BUSINESS_INCOME_CODE = '940909';

type SeptChange = 'same' | 'missing' | 'zero' | 'new' | { raisePct: number };

interface EmployeePlan {
  name?: string;
  incomeType: IncomeType;
  /** 근로: 월 기본급 / 사업: 월 지급액 / 일용: 일당 */
  amount: Won;
  /** 과세 수당 */
  allowances?: Record<string, Won>;
  meal?: boolean;
  car?: boolean;
  /** 일용 근무일수 범위 */
  days?: [number, number];
  hire?: LocalDate;
  /** 마스터에 이미 반영된 퇴사일 */
  resign?: LocalDate;
  /** 실제 퇴사일 (마스터 미반영) */
  truthResign?: LocalDate;
  sept?: SeptChange;
  noId?: boolean;
  foreigner?: boolean;
}

const E = (amount: Won, extra: Partial<EmployeePlan> = {}): EmployeePlan => ({ incomeType: 'earned', amount, meal: true, ...extra });
const B = (amount: Won, extra: Partial<EmployeePlan> = {}): EmployeePlan => ({ incomeType: 'business', amount, ...extra });
const D = (wage: Won, days: [number, number], extra: Partial<EmployeePlan> = {}): EmployeePlan => ({ incomeType: 'daily', amount: wage, days, ...extra });

interface ClientPayrollPlan {
  paymentDay: number;
  /** true 면 다음 달 paymentDay 에 지급 */
  nextMonth: boolean;
  employees: EmployeePlan[];
}

export const PAYROLL_PLANS: Readonly<Record<string, ClientPayrollPlan>> = {
  C001: {
    paymentDay: 25, nextMonth: false,
    employees: [
      E(4_200_000, { allowances: { 직책수당: 300_000 }, car: true }), E(3_600_000), E(3_300_000), E(3_100_000), E(2_900_000), E(2_800_000),
      E(2_600_000), E(2_500_000, { hire: '2026-04-01' }), E(2_700_000, { sept: 'new', hire: '2026-09-01' }),
      B(1_500_000), B(2_200_000),
    ],
  },
  [SCENARIO_PAYROLL_CODE]: {
    paymentDay: 25, nextMonth: false,
    employees: [
      E(3_300_000, { name: PAYROLL_SCENARIO_NAMES.raised, meal: false, sept: { raisePct: 10 } }),
      E(2_900_000, { name: PAYROLL_SCENARIO_NAMES.missing, truthResign: '2026-08-31', sept: 'missing' }),
      E(2_600_000), E(2_800_000), E(3_000_000, { allowances: { 직책수당: 200_000 } }), E(3_200_000), E(3_500_000),
      E(3_800_000, { allowances: { 직책수당: 300_000 } }), E(4_200_000, { car: true }), E(4_800_000, { allowances: { 직책수당: 500_000 }, car: true }),
    ],
  },
  C003: { paymentDay: 10, nextMonth: true, employees: [E(3_000_000), E(2_600_000), E(2_400_000), D(130_000, [8, 16]), D(140_000, [10, 20]), D(160_000, [6, 12])] },
  C004: {
    paymentDay: 10, nextMonth: true,
    employees: [
      E(4_500_000, { allowances: { 직책수당: 400_000 }, car: true }), E(3_800_000), E(3_400_000), E(3_100_000), E(2_900_000),
      D(180_000, [12, 22]), D(200_000, [10, 20]), D(220_000, [8, 18]), D(250_000, [10, 20]), D(190_000, [12, 22]),
      D(210_000, [10, 15], { sept: 'new', hire: '2026-09-07', noId: true }),
    ],
  },
  C005: { paymentDay: 25, nextMonth: false, employees: [E(2_700_000), E(2_500_000)] },
  C006: { paymentDay: 25, nextMonth: false, employees: [E(3_600_000), E(3_000_000), E(2_700_000), D(200_000, [8, 16]), D(180_000, [6, 14])] },
  C007: { paymentDay: 25, nextMonth: false, employees: [E(2_600_000), E(2_300_000), B(2_200_000), B(1_800_000), B(2_600_000)] },
  C008: { paymentDay: 25, nextMonth: false, employees: [E(3_400_000), E(3_000_000), E(2_800_000), E(2_600_000)] },
  C009: {
    paymentDay: 25, nextMonth: false,
    employees: [
      E(3_900_000, { allowances: { 직책수당: 300_000 } }), E(3_200_000, { meal: false, sept: { raisePct: 25 } }), E(3_000_000), E(2_800_000),
      E(2_600_000), E(2_500_000), E(2_700_000, { resign: '2026-06-30' }),
    ],
  },
  C011: { paymentDay: 10, nextMonth: true, employees: [E(3_800_000), E(3_300_000), E(3_000_000, { sept: 'zero' }), E(2_800_000), E(2_700_000)] },
  C012: {
    paymentDay: 25, nextMonth: false,
    employees: [
      E(5_200_000, { allowances: { 직책수당: 500_000 } }), E(4_600_000), E(4_100_000), E(3_800_000), E(3_500_000, { hire: '2026-05-02' }),
      E(3_300_000), E(3_600_000, { sept: 'new', hire: '2026-09-14' }), B(3_000_000),
    ],
  },
  C013: { paymentDay: 25, nextMonth: false, employees: [E(2_400_000), D(120_000, [8, 14]), D(120_000, [6, 12])] },
  C014: { paymentDay: 25, nextMonth: false, employees: [D(110_000, [8, 14])] },
  C015: { paymentDay: 10, nextMonth: true, employees: [E(2_900_000), E(2_600_000), E(2_400_000), D(130_000, [10, 18]), D(130_000, [8, 16])] },
  C016: { paymentDay: 25, nextMonth: false, employees: [E(3_600_000), E(3_100_000), E(2_800_000), E(2_600_000)] },
  C017: { paymentDay: 25, nextMonth: false, employees: [E(3_700_000), E(3_100_000), E(2_900_000), B(2_000_000), B(1_600_000)] },
  C019: { paymentDay: 25, nextMonth: false, employees: [E(3_900_000), E(3_300_000), E(2_900_000), D(210_000, [10, 18]), D(200_000, [8, 16])] },
  C020: { paymentDay: 25, nextMonth: false, employees: [E(5_000_000, { car: true }), E(4_000_000), E(3_400_000), B(2_500_000)] },
  C022: { paymentDay: 25, nextMonth: false, employees: [E(3_700_000), E(3_200_000), E(2_900_000)] },
  C023: {
    paymentDay: 10, nextMonth: true,
    employees: [E(3_600_000), E(3_100_000), E(2_900_000), E(2_700_000), E(2_600_000), E(2_500_000), D(140_000, [10, 20]), D(140_000, [10, 20])],
  },
  C024: { paymentDay: 25, nextMonth: false, employees: [E(2_600_000), E(2_400_000), B(1_500_000), B(1_200_000)] },
};

// ────────────────────────────── 세액 (합성 근사) ──────────────────────────────

const trunc10 = (v: number): Won => Math.trunc(v / 10) * 10;

/** 근로소득 월 소득세 — 합성 근사식 (간이세액표 아님, 검증필요) */
export function syntheticEarnedIncomeTax(taxableMonthly: Won, dependents: number): Won {
  const base = Math.max(0, taxableMonthly - 1_000_000 - dependents * 150_000);
  const t1 = Math.min(base, 1_500_000);
  const t2 = Math.min(Math.max(0, base - 1_500_000), 2_000_000);
  const t3 = Math.max(0, base - 3_500_000);
  return trunc10((t1 * 3) / 100 + (t2 * 6) / 100 + (t3 * 10) / 100);
}

/** 사업소득 3% (10원 미만 절사) */
export function businessIncomeTax(amount: Won): Won {
  return amount > 0 ? trunc10((amount * 3) / 100) : 0;
}

/** 일용근로 소득세: 일별 (일당 − 150,000) × 2.7% 원 미만 절사 → 합계 10원 미만 절사 → 1,000원 미만 소액부징수 */
export function dailyIncomeTax(dailyWage: Won, workDays: number): Won {
  const perDay = Math.max(0, Math.trunc(((dailyWage - 150_000) * 27) / 1000));
  const total = trunc10(perDay * workDays);
  return total < 1_000 ? 0 : total;
}

/** 지방소득세 = 소득세 × 10% (10원 미만 절사) */
export function localIncomeTaxOf(incomeTax: Won): Won {
  return trunc10(incomeTax / 10);
}

// ────────────────────────────── 생성 ──────────────────────────────

function paymentDateOf(period: YearMonth, plan: ClientPayrollPlan, incomeType: IncomeType): LocalDate {
  const [y, m] = period.split('-').map(Number) as [number, number];
  if (incomeType === 'daily') {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${period}-${String(last).padStart(2, '0')}`;
  }
  if (!plan.nextMonth) return `${period}-${String(plan.paymentDay).padStart(2, '0')}`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(plan.paymentDay).padStart(2, '0')}`;
}

function hireDateOf(rng: Rng, plan: EmployeePlan): LocalDate {
  if (plan.hire) return plan.hire;
  const y = rng.int(2018, 2025);
  return `${y}-${String(rng.int(1, 12)).padStart(2, '0')}-01`;
}

function monthlyAmountFor(plan: EmployeePlan, period: YearMonth): Won {
  if (period !== CURRENT_MONTH || !plan.sept || typeof plan.sept === 'string') return plan.amount;
  return Math.round((plan.amount * (100 + plan.sept.raisePct)) / 100);
}

function buildLine(
  emp: SyntheticEmployee,
  plan: EmployeePlan,
  clientPlan: ClientPayrollPlan,
  period: YearMonth,
  rng: Rng,
): SyntheticPayrollLine {
  const paymentDate = paymentDateOf(period, clientPlan, emp.incomeType);
  const zero = period === CURRENT_MONTH && plan.sept === 'zero';
  const base = { employeeRef: emp.ref, clientCode: emp.clientCode, period, name: emp.name, incomeType: emp.incomeType, paymentDate };
  if (zero) {
    return { ...base, taxablePay: 0, nonTaxablePay: 0, grossPay: 0, allowances: {}, incomeTax: 0, localIncomeTax: 0, otherDeductions: 0, netPay: 0 };
  }
  if (emp.incomeType === 'business') {
    const amt = monthlyAmountFor(plan, period);
    const it = businessIncomeTax(amt);
    const lit = localIncomeTaxOf(it);
    return { ...base, taxablePay: amt, nonTaxablePay: 0, grossPay: amt, allowances: { 사업소득: amt }, incomeTax: it, localIncomeTax: lit, otherDeductions: 0, netPay: amt - it - lit };
  }
  if (emp.incomeType === 'daily') {
    const wage = monthlyAmountFor(plan, period);
    const [lo, hi] = plan.days ?? [10, 20];
    const workDays = rng.int(lo, hi);
    const gross = wage * workDays;
    const it = dailyIncomeTax(wage, workDays);
    const lit = localIncomeTaxOf(it);
    const other = trunc10((gross * 9) / 1000); // 고용보험 0.9% 근사 (검증필요)
    return {
      ...base, taxablePay: gross, nonTaxablePay: 0, grossPay: gross, allowances: { 일당: wage }, workDays,
      incomeTax: it, localIncomeTax: lit, otherDeductions: other, netPay: gross - it - lit - other,
    };
  }
  const salary = monthlyAmountFor(plan, period);
  const allowances: Record<string, Won> = { 기본급: salary, ...(plan.allowances ?? {}) };
  const taxable = salary + Object.values(plan.allowances ?? {}).reduce((a, b) => a + b, 0);
  let nonTaxable = 0;
  if (plan.meal) {
    allowances['식대'] = MEAL_ALLOWANCE_NONTAXABLE;
    nonTaxable += MEAL_ALLOWANCE_NONTAXABLE;
  }
  if (plan.car) {
    allowances['자가운전보조금'] = CAR_ALLOWANCE_NONTAXABLE;
    nonTaxable += CAR_ALLOWANCE_NONTAXABLE;
  }
  const it = syntheticEarnedIncomeTax(taxable, emp.dependents);
  const lit = localIncomeTaxOf(it);
  const other = trunc10((taxable * SOCIAL_INSURANCE_APPROX_RATE_PERMILLE) / 1000);
  const gross = taxable + nonTaxable;
  return { ...base, taxablePay: taxable, nonTaxablePay: nonTaxable, grossPay: gross, allowances, incomeTax: it, localIncomeTax: lit, otherDeductions: other, netPay: gross - it - lit - other };
}

/** 이 달에 지급행이 있는가 */
function activeIn(plan: EmployeePlan, emp: SyntheticEmployee, period: YearMonth): boolean {
  if (period === CURRENT_MONTH) {
    if (plan.sept === 'missing') return false;
    if (emp.resignDate && emp.resignDate < `${period}-01`) return false;
    return !emp.hireDate || emp.hireDate.slice(0, 7) <= period;
  }
  if (plan.sept === 'new') return false;
  if (emp.hireDate && emp.hireDate.slice(0, 7) > period) return false;
  if (emp.resignDate && emp.resignDate < `${period}-01`) return false;
  return true;
}

export function generatePayroll(seed: number, clients: readonly SyntheticClient[], usedNames: Set<string>): SyntheticPayroll {
  const employees: SyntheticEmployee[] = [];
  const history: SyntheticPayrollLine[] = [];
  const current: SyntheticPayrollLine[] = [];
  const expectedChanges: ExpectedPayrollChange[] = [];
  const expectedSummary: SyntheticPayroll['expectedSummary'] = {};
  const usedRrn = new Set<string>();

  for (const client of clients) {
    const clientPlan = PAYROLL_PLANS[client.code];
    if (!clientPlan) continue;
    const summary: Partial<Record<PayrollChangeKind, number>> = {};
    const bump = (k: PayrollChangeKind) => (summary[k] = (summary[k] ?? 0) + 1);
    clientPlan.employees.forEach((plan, idx) => {
      const rng = rngFor(seed, 'employee', client.code, idx);
      const ref = `${client.code}-E${String(idx + 1).padStart(2, '0')}`;
      const name = plan.name ?? makePersonName(rng, usedNames);
      const birthYear = rng.int(1965, 2003);
      const gender = rng.chance(0.5) ? 'M' : 'F';
      const emp: SyntheticEmployee = {
        ref,
        clientCode: client.code,
        name,
        incomeType: plan.incomeType,
        residentNumber: plan.noId ? null : makeFakeResidentNumber(rng, birthYear, gender, usedRrn),
        isForeigner: !!plan.foreigner,
        hireDate: hireDateOf(rng, plan),
        resignDate: plan.resign ?? null,
        baseSalary: plan.incomeType === 'earned' ? plan.amount : 0,
        allowances: { ...(plan.allowances ?? {}) },
        nonTaxable: {
          ...(plan.meal ? { 식대: MEAL_ALLOWANCE_NONTAXABLE } : {}),
          ...(plan.car ? { 자가운전보조금: CAR_ALLOWANCE_NONTAXABLE } : {}),
        },
        dailyWage: plan.incomeType === 'daily' ? plan.amount : null,
        businessIncomeCode: plan.incomeType === 'business' ? DEFAULT_BUSINESS_INCOME_CODE : null,
        paymentDay: clientPlan.paymentDay,
        dependents: plan.incomeType === 'earned' ? rng.int(1, 4) : 1,
        joinedInCurrentMonth: plan.sept === 'new',
        truthResignDate: plan.truthResign ?? plan.resign ?? null,
      };
      employees.push(emp);

      let aug: SyntheticPayrollLine | null = null;
      for (const period of HISTORY_MONTHS) {
        if (!activeIn(plan, emp, period)) continue;
        const line = buildLine(emp, plan, clientPlan, period, rngFor(seed, 'payroll', ref, period));
        history.push(line);
        if (period === HISTORY_MONTHS[HISTORY_MONTHS.length - 1]) aug = line;
      }
      let sep: SyntheticPayrollLine | null = null;
      if (activeIn(plan, emp, CURRENT_MONTH)) {
        sep = buildLine(emp, plan, clientPlan, CURRENT_MONTH, rngFor(seed, 'payroll', ref, CURRENT_MONTH));
        current.push(sep);
      }
      // 기대 변동 (core payroll/diff 규칙과 같은 판정)
      if (!aug && !sep) return;
      const kinds = expectedKinds(plan, emp, aug, sep);
      for (const k of kinds) bump(k);
      if (!(kinds.length === 1 && kinds[0] === 'unchanged')) {
        const rate = aug && sep && aug.grossPay !== 0 ? Math.round(((sep.grossPay - aug.grossPay) / aug.grossPay) * 1000) / 10 : null;
        expectedChanges.push({ clientCode: client.code, employeeRef: ref, name, kinds, changeRate: rate });
      }
    });
    if (Object.keys(summary).length > 0) expectedSummary[client.code] = summary;
  }
  return { employees, history, current, expectedChanges, expectedSummary };
}

function expectedKinds(plan: EmployeePlan, emp: SyntheticEmployee, aug: SyntheticPayrollLine | null, sep: SyntheticPayrollLine | null): PayrollChangeKind[] {
  if (aug && !sep) return ['missing_this_month'];
  const kinds: PayrollChangeKind[] = [];
  if (!emp.residentNumber) kinds.push('missing_id');
  if (!aug) {
    kinds.push('new_hire');
    return kinds;
  }
  if (sep && aug.grossPay !== sep.grossPay && !(emp.incomeType === 'daily' && plan.sept === undefined)) {
    kinds.push('pay_changed');
    if (Math.abs(sep.grossPay - aug.grossPay) * 100 >= 20 * Math.abs(aug.grossPay)) kinds.push('pay_changed_large');
  }
  if (sep && sep.grossPay === 0) kinds.push('zero_pay');
  return kinds.length ? kinds : ['unchanged'];
}
