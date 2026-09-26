import { describe, expect, it } from 'vitest';
import type { PayrollLine } from '../types';
import { carryForward, carryForwardWithReport, shiftDateOneMonth, type EmployeeMaster } from './carry';
import { diffPayroll, formatDiffSummary } from './diff';

function master(id: string, over: Partial<EmployeeMaster> = {}): EmployeeMaster {
  return {
    employeeId: id,
    name: `직원${id}`,
    incomeType: 'earned',
    hasIdNumber: true,
    idNumberMasked: '900101-1******',
    hireDate: '2024-01-02',
    resignDate: null,
    baseSalary: 2_800_000,
    allowances: { 직책수당: 200_000 },
    nonTaxable: { 식대: 200_000 },
    paymentDay: 25,
    ...over,
  };
}

function prevLine(id: string, over: Partial<PayrollLine> = {}): PayrollLine {
  return {
    employeeId: id,
    name: `직원${id}`,
    incomeType: 'earned',
    taxablePay: 3_000_000,
    nonTaxablePay: 200_000,
    grossPay: 3_200_000,
    allowances: { 직책수당: 200_000, 식대: 200_000 },
    incomeTax: 74_350,
    localIncomeTax: 7_430,
    otherDeductions: 300_000,
    netPay: 3_200_000 - 74_350 - 7_430 - 300_000,
    paymentDate: '2026-08-25',
    ...over,
  };
}

describe('shiftDateOneMonth', () => {
  it('같은 일자, 말일 초과 시 말일', () => {
    expect(shiftDateOneMonth('2026-08-25')).toBe('2026-09-25');
    expect(shiftDateOneMonth('2026-01-31')).toBe('2026-02-28');
    expect(shiftDateOneMonth('2026-12-10')).toBe('2027-01-10');
  });
});

describe('carryForward', () => {
  it('전월 지급행 이어받기: 금액·공제 유지, 지급일 +1개월, netPay 재계산', () => {
    const [l] = carryForward([prevLine('01')], [master('01')], '2026-09');
    expect(l).toMatchObject({
      employeeId: '01',
      taxablePay: 3_000_000,
      nonTaxablePay: 200_000,
      grossPay: 3_200_000,
      incomeTax: 74_350, // 근로소득: 전월값 유지
      localIncomeTax: 7_430,
      otherDeductions: 300_000,
      netPay: 3_200_000 - 74_350 - 7_430 - 300_000,
      paymentDate: '2026-09-25',
    });
    expect(l!.allowances).toEqual({ 직책수당: 200_000, 식대: 200_000 });
  });

  it('신규입사: 마스터(기본급+수당+비과세)로 생성, 근로소득세는 0 + 안내', () => {
    const rep = carryForwardWithReport([], [master('02', { hireDate: '2026-09-01' })], '2026-09');
    const [l] = rep.lines;
    expect(l).toMatchObject({ taxablePay: 3_000_000, nonTaxablePay: 200_000, grossPay: 3_200_000, incomeTax: 0, paymentDate: '2026-09-25' });
    expect(l!.allowances).toEqual({ 직책수당: 200_000, 식대: 200_000 });
    expect(rep.origins['02']).toBe('master');
    expect(rep.notes[0]).toContain('WEHAGO 간이세액표');
  });

  it('퇴사자(퇴사일 < 이번달 1일)·입사 전·비활성 제외, 이번달 퇴사자는 포함', () => {
    const rep = carryForwardWithReport(
      [prevLine('01'), prevLine('02'), prevLine('03')],
      [
        master('01', { resignDate: '2026-08-31' }),
        master('02', { resignDate: '2026-09-15' }),
        master('03', { active: false }),
        master('04', { hireDate: '2026-10-01' }),
      ],
      '2026-09',
    );
    expect(rep.lines.map((l) => l.employeeId)).toEqual(['02']);
    expect(rep.excluded.map((e) => [e.employeeId, e.reason])).toEqual([
      ['01', '퇴사 (퇴사일 2026-08-31)'],
      ['03', '비활성 직원'],
      ['04', '입사 전 (입사일 2026-10-01)'],
    ]);
  });

  it('직원 마스터에 없는 전월 행은 제외하고 사유 기록', () => {
    const rep = carryForwardWithReport([prevLine('99')], [], '2026-09');
    expect(rep.lines).toEqual([]);
    expect(rep.excluded).toEqual([{ employeeId: '99', name: '직원99', reason: '직원 마스터에 없음' }]);
  });

  it('사업소득: 3.3% 재계산 (전월 세액이 틀렸어도 산식 적용)', () => {
    const [l] = carryForward(
      [prevLine('B1', { incomeType: 'business', taxablePay: 1_000_000, nonTaxablePay: 0, grossPay: 1_000_000, allowances: {}, incomeTax: 33_000, localIncomeTax: 3_300, otherDeductions: 0 })],
      [master('B1', { incomeType: 'business' })],
      '2026-09',
    );
    expect(l).toMatchObject({ incomeTax: 30_000, localIncomeTax: 3_000, netPay: 967_000 });
  });

  it('일용직: 전월 일당·일수 이어받아 세액 재계산 / 신규 일용직은 0일 초안', () => {
    const rep = carryForwardWithReport(
      [prevLine('D1', { incomeType: 'daily', taxablePay: 1_000_000, nonTaxablePay: 0, grossPay: 1_000_000, allowances: {}, workDays: 5, incomeTax: 0, localIncomeTax: 0, otherDeductions: 0 })],
      [master('D1', { incomeType: 'daily', dailyWage: 200_000 }), master('D2', { incomeType: 'daily', dailyWage: null, hireDate: '2026-09-03' })],
      '2026-09',
    );
    expect(rep.lines[0]).toMatchObject({ workDays: 5, incomeTax: 6_750, localIncomeTax: 670 });
    expect(rep.lines[1]).toMatchObject({ employeeId: 'D2', workDays: 0, grossPay: 0, incomeTax: 0 });
    expect(rep.notes).toContain('직원D2: 일용직 일당 미등록');
  });

  it('소득구분이 마스터에서 바뀌면 마스터 기준 + 근로소득 세액 초기화', () => {
    const rep = carryForwardWithReport([prevLine('01', { incomeType: 'business', incomeTax: 90_000, localIncomeTax: 9_000 })], [master('01')], '2026-09');
    expect(rep.lines[0]).toMatchObject({ incomeType: 'earned', incomeTax: 0, localIncomeTax: 0 });
    expect(rep.notes[0]).toContain('소득구분');
  });

  it('지급일 정보가 없으면 마스터 지급일(말일 보정) 또는 null', () => {
    const [a] = carryForward([prevLine('01', { paymentDate: null })], [master('01', { paymentDay: 31 })], '2026-09');
    expect(a!.paymentDate).toBe('2026-09-30');
    const [b] = carryForward([], [master('02', { paymentDay: null })], '2026-09');
    expect(b!.paymentDate).toBeNull();
  });

  it('초안 → diffPayroll: 이어받은 직원은 unchanged, 신규만 검토', () => {
    const employees = [master('01'), master('02'), master('03', { hireDate: '2026-09-01' }), master('04', { resignDate: '2026-08-31' })];
    const prev = [prevLine('01'), prevLine('02'), prevLine('04')];
    const draft = carryForward(prev, employees, '2026-09');
    const r = diffPayroll({ employees, lines: prev }, { employees, lines: draft }, { period: '2026-09' });
    expect(r.summary).toMatchObject({ unchanged: 2, newHire: 1, resigned: 1, needsReview: 1 });
    expect(formatDiffSummary(r.summary)).toBe('변동 없음 2명 / 신규입사 1명 / 퇴사 1명');
  });
});
