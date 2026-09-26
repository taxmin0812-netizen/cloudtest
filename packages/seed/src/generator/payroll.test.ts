import { maskResidentNumber, type EmployeeSnapshot, type PayrollLine } from '@mintax/core';
import { diffPayroll } from '@mintax/core/payroll/diff';
import { describe, expect, it } from 'vitest';
import { SCENARIO_PAYROLL_CODE } from './clients';
import { isSyntheticResidentNumber } from './ids';
import { generateDataset } from './index';
import {
  PAYROLL_SCENARIO_NAMES,
  businessIncomeTax,
  dailyIncomeTax,
  localIncomeTaxOf,
  syntheticEarnedIncomeTax,
} from './payroll';
import { CURRENT_MONTH, HISTORY_MONTHS } from './transactions';
import type { SyntheticEmployee, SyntheticPayrollLine } from './types';

const ds = generateDataset();
const { payroll } = ds;

describe('세액 헬퍼', () => {
  it('사업소득 3% / 지방 10% (MVP 부정 테스트: 1,000,000 → 30,000 / 3,000)', () => {
    expect(businessIncomeTax(1_000_000)).toBe(30_000);
    expect(localIncomeTaxOf(30_000)).toBe(3_000);
    expect(businessIncomeTax(0)).toBe(0);
    expect(businessIncomeTax(333_333)).toBe(9_990);
  });

  it('일용근로: (일당−150,000)×2.7% 일별 절사 → 합계 10원 절사 → 1,000원 미만 소액부징수', () => {
    expect(dailyIncomeTax(200_000, 10)).toBe(13_500);
    expect(dailyIncomeTax(187_000, 1)).toBe(0); // 999원 → 소액부징수
    expect(dailyIncomeTax(187_100, 1)).toBe(1_000); // 1,001원 → 1,000원
    expect(dailyIncomeTax(150_000, 20)).toBe(0);
    expect(dailyIncomeTax(120_000, 20)).toBe(0);
  });

  it('근로소득 합성 근사식은 단조 증가·10원 단위', () => {
    let prev = -1;
    for (let pay = 1_000_000; pay <= 8_000_000; pay += 250_000) {
      const t = syntheticEarnedIncomeTax(pay, 1);
      expect(t % 10).toBe(0);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    expect(syntheticEarnedIncomeTax(3_000_000, 1)).toBeGreaterThan(syntheticEarnedIncomeTax(3_000_000, 4));
  });
});

describe('직원 마스터', () => {
  it('근로·사업·일용 모두 있고, 가짜 주민번호는 형식만 맞고 고유', () => {
    expect(new Set(payroll.employees.map((e) => e.incomeType))).toEqual(new Set(['earned', 'business', 'daily']));
    const rrns = payroll.employees.map((e) => e.residentNumber).filter((x): x is string => x !== null);
    expect(new Set(rrns).size).toBe(rrns.length);
    for (const r of rrns) {
      expect(isSyntheticResidentNumber(r)).toBe(true);
      expect(maskResidentNumber(r)).toMatch(/^\d{6}-[1-4]\*{6}$/);
    }
    expect(payroll.employees.filter((e) => e.residentNumber === null)).toHaveLength(1);
    expect(new Set(payroll.employees.map((e) => e.ref)).size).toBe(payroll.employees.length);
  });

  it('소득구분별 필드', () => {
    for (const e of payroll.employees) {
      if (e.incomeType === 'daily') expect(e.dailyWage).toBeGreaterThan(0);
      else expect(e.dailyWage).toBeNull();
      if (e.incomeType === 'business') expect(e.businessIncomeCode).toBe('940909');
      if (e.incomeType === 'earned') expect(e.baseSalary).toBeGreaterThan(0);
    }
  });
});

describe('급여 행', () => {
  const lines = [...payroll.history, ...payroll.current];

  it('검산: 지급총액 = 과세 + 비과세, 차인지급 = 총액 − 소득세 − 지방세 − 공제, 모두 정수', () => {
    for (const l of lines) {
      for (const v of [l.taxablePay, l.nonTaxablePay, l.grossPay, l.incomeTax, l.localIncomeTax, l.otherDeductions, l.netPay]) expect(Number.isSafeInteger(v)).toBe(true);
      expect(l.grossPay).toBe(l.taxablePay + l.nonTaxablePay);
      expect(l.netPay).toBe(l.grossPay - l.incomeTax - l.localIncomeTax - l.otherDeductions);
      expect(l.localIncomeTax).toBe(localIncomeTaxOf(l.incomeTax));
      if (l.incomeType === 'business') expect(l.incomeTax).toBe(businessIncomeTax(l.grossPay));
      if (l.incomeType === 'daily' && l.grossPay > 0) expect(l.incomeTax).toBe(dailyIncomeTax(l.allowances['일당']!, l.workDays!));
    }
  });

  it('이력은 2026-03~08, 당월은 2026-09', () => {
    expect(new Set(payroll.history.map((l) => l.period))).toEqual(new Set(HISTORY_MONTHS));
    expect(payroll.current.every((l) => l.period === CURRENT_MONTH)).toBe(true);
    expect(new Set(lines.map((l) => `${l.employeeRef}|${l.period}`)).size).toBe(lines.length);
  });
});

describe('시나리오 2 — 시나리오상사 직원 10명', () => {
  const emps = payroll.employees.filter((e) => e.clientCode === SCENARIO_PAYROLL_CODE);
  const aug = payroll.history.filter((l) => l.clientCode === SCENARIO_PAYROLL_CODE && l.period === '2026-08');
  const sep = payroll.current.filter((l) => l.clientCode === SCENARIO_PAYROLL_CODE);

  it('근로소득 10명, 6개월 모두 10명', () => {
    expect(emps).toHaveLength(10);
    expect(emps.every((e) => e.incomeType === 'earned')).toBe(true);
    for (const m of HISTORY_MONTHS) expect(payroll.history.filter((l) => l.clientCode === SCENARIO_PAYROLL_CODE && l.period === m), m).toHaveLength(10);
  });

  it('9월: 김민수 3,300,000 → 3,630,000 (+10%), 최지훈 없음, 나머지 8명 동일', () => {
    const kim = emps.find((e) => e.name === PAYROLL_SCENARIO_NAMES.raised)!;
    const choi = emps.find((e) => e.name === PAYROLL_SCENARIO_NAMES.missing)!;
    expect(aug.find((l) => l.employeeRef === kim.ref)!.grossPay).toBe(3_300_000);
    expect(sep.find((l) => l.employeeRef === kim.ref)!.grossPay).toBe(3_630_000);
    expect(sep.find((l) => l.employeeRef === choi.ref)).toBeUndefined();
    expect(choi.resignDate).toBeNull();
    expect(choi.truthResignDate).toBe('2026-08-31');
    expect(sep).toHaveLength(9);
    for (const l of sep.filter((x) => x.employeeRef !== kim.ref)) {
      const a = aug.find((x) => x.employeeRef === l.employeeRef)!;
      expect({ ...l, period: a.period, paymentDate: a.paymentDate }).toEqual(a);
    }
    expect(sep.every((l) => l.paymentDate === '2026-09-25')).toBe(true);
  });

  it('기대 변동: 급여변경 1 + 퇴사(미지급) 1, 요약 {unchanged 8, pay_changed 1, missing_this_month 1}', () => {
    const changes = payroll.expectedChanges.filter((c) => c.clientCode === SCENARIO_PAYROLL_CODE);
    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.name === '김민수')).toMatchObject({ kinds: ['pay_changed'], changeRate: 10 });
    expect(changes.find((c) => c.name === '최지훈')).toMatchObject({ kinds: ['missing_this_month'], changeRate: null });
    expect(payroll.expectedSummary[SCENARIO_PAYROLL_CODE]).toEqual({ unchanged: 8, pay_changed: 1, missing_this_month: 1 });
  });
});

describe('다른 거래처 9월 변동', () => {
  const kindsOf = (k: string) => payroll.expectedChanges.filter((c) => c.kinds.includes(k as never));

  it('신규입사·주민번호 누락·무급·25% 인상이 모두 있다', () => {
    expect(kindsOf('new_hire').length).toBeGreaterThanOrEqual(3);
    expect(kindsOf('missing_id')).toHaveLength(1);
    expect(kindsOf('missing_id')[0]!.kinds).toEqual(['missing_id', 'new_hire']);
    expect(kindsOf('zero_pay')).toHaveLength(1);
    expect(kindsOf('zero_pay')[0]).toMatchObject({ kinds: ['pay_changed', 'pay_changed_large', 'zero_pay'], changeRate: -100 });
    const large = kindsOf('pay_changed_large').filter((c) => !c.kinds.includes('zero_pay'));
    expect(large).toHaveLength(1);
    expect(large[0]!.changeRate).toBe(25);
  });

  it('신규입사자는 9월 마스터에만 있고 이력 급여가 없다', () => {
    const newbies = payroll.employees.filter((e) => e.joinedInCurrentMonth);
    expect(newbies.length).toBeGreaterThanOrEqual(3);
    for (const e of newbies) {
      expect(e.hireDate!.startsWith(CURRENT_MONTH)).toBe(true);
      expect(payroll.history.some((l) => l.employeeRef === e.ref)).toBe(false);
      expect(payroll.current.some((l) => l.employeeRef === e.ref)).toBe(true);
    }
  });

  it('과거 퇴사자(마스터 반영)는 퇴사 후 급여가 없다', () => {
    for (const e of payroll.employees.filter((x) => x.resignDate)) {
      for (const l of [...payroll.history, ...payroll.current].filter((x) => x.employeeRef === e.ref)) {
        expect(`${l.period}-01` <= e.resignDate!).toBe(true);
      }
    }
  });
});

describe('core diffPayroll 과 기대 변동 일치 (계약 점검)', () => {
  const snapshot = (e: SyntheticEmployee): EmployeeSnapshot => ({
    employeeId: e.ref,
    name: e.name,
    incomeType: e.incomeType,
    hasIdNumber: e.residentNumber !== null,
    idNumberMasked: maskResidentNumber(e.residentNumber),
    hireDate: e.hireDate,
    resignDate: e.resignDate,
  });
  const toLine = (l: SyntheticPayrollLine): PayrollLine => {
    const { employeeRef, clientCode: _c, period: _p, ...rest } = l;
    return { ...rest, employeeId: employeeRef };
  };

  it('거래처별 needsReview 대상·종류가 expectedChanges 와 같다', () => {
    for (const client of ds.clients) {
      const emps = payroll.employees.filter((e) => e.clientCode === client.code);
      if (emps.length === 0) continue;
      const prevEmps = emps.filter((e) => !e.joinedInCurrentMonth).map(snapshot);
      const result = diffPayroll(
        { employees: prevEmps, lines: payroll.history.filter((l) => l.clientCode === client.code && l.period === '2026-08').map(toLine) },
        { employees: emps.map(snapshot), lines: payroll.current.filter((l) => l.clientCode === client.code).map(toLine) },
        { period: CURRENT_MONTH },
      );
      const actual = result.changes
        .filter((c) => c.needsReview)
        .map((c) => ({ ref: c.employeeId, kinds: [...c.kinds].sort(), rate: c.changeRate }))
        .sort((a, b) => (a.ref < b.ref ? -1 : 1));
      const expected = payroll.expectedChanges
        .filter((c) => c.clientCode === client.code)
        .map((c) => ({ ref: c.employeeRef, kinds: [...c.kinds].sort(), rate: c.changeRate }))
        .sort((a, b) => (a.ref < b.ref ? -1 : 1));
      expect(actual.map(({ ref, kinds }) => ({ ref, kinds })), client.code).toEqual(expected.map(({ ref, kinds }) => ({ ref, kinds })));
      for (const e of expected) {
        const a = actual.find((x) => x.ref === e.ref)!;
        if (e.rate !== null && a.rate !== null) expect(a.rate).toBe(e.rate);
      }
      expect(result.summary.unchanged, client.code).toBe(payroll.expectedSummary[client.code]?.unchanged ?? 0);
    }
  });
});
