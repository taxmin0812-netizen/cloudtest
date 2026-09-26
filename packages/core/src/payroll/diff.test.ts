import { describe, expect, it } from 'vitest';
import type { EmployeeSnapshot, IncomeType, PayrollLine } from '../types';
import { changeRatePct, diffPayroll, formatDiffSummary } from './diff';

function emp(id: string, over: Partial<EmployeeSnapshot> = {}): EmployeeSnapshot {
  return {
    employeeId: id,
    name: `직원${id}`,
    incomeType: 'earned',
    hasIdNumber: true,
    idNumberMasked: '900101-1******',
    hireDate: '2024-01-02',
    resignDate: null,
    ...over,
  };
}

function pl(id: string, grossPay: number, over: Partial<PayrollLine> = {}): PayrollLine {
  const incomeType: IncomeType = over.incomeType ?? 'earned';
  const nonTaxablePay = over.nonTaxablePay ?? 0;
  return {
    employeeId: id,
    name: `직원${id}`,
    incomeType,
    taxablePay: grossPay - nonTaxablePay,
    nonTaxablePay,
    grossPay,
    allowances: {},
    incomeTax: 0,
    localIncomeTax: 0,
    otherDeductions: 0,
    netPay: grossPay,
    paymentDate: '2026-09-25',
    ...over,
  };
}

const PREV_DATE = { paymentDate: '2026-08-25' };

function month(ids: string[], pay = 3_000_000, over: Partial<PayrollLine> = {}): PayrollLine[] {
  return ids.map((id) => pl(id, pay, over));
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(2, '0'));

describe('diffPayroll — 스펙 시나리오', () => {
  it('10명 중 급여변경 1명 + 퇴사(누락) 1명 → 검토 대상 정확히 2명', () => {
    const all = ids(10);
    const employees = all.map((id) => emp(id));
    const prevLines = month(all, 3_000_000, PREV_DATE);
    const currLines = month(all.slice(0, 9)).map((l) => (l.employeeId === '03' ? pl('03', 3_300_000) : l));
    const r = diffPayroll({ employees, lines: prevLines }, { employees, lines: currLines }, { period: '2026-09' });

    expect(r.summary.needsReview).toBe(2);
    expect(r.summary.unchanged).toBe(8);
    expect(r.summary.payChanged).toBe(1);
    expect(r.summary.missing).toBe(1);
    expect(r.summary.total).toBe(10);
    const review = r.changes.filter((c) => c.needsReview);
    expect(review.map((c) => c.employeeId).sort()).toEqual(['03', '10']);
    const changed = r.changes.find((c) => c.employeeId === '03')!;
    expect(changed.messages[0]).toBe('급여 3,000,000원 → 3,300,000원 (+10.0%)');
    expect(changed.changeRate).toBe(10);
    expect(changed.kinds).toEqual(['pay_changed']);
    const missing = r.changes.find((c) => c.employeeId === '10')!;
    expect(missing.kinds).toEqual(['missing_this_month']);
    expect(missing.messages[0]).toContain('퇴사 여부 확인');
    expect(missing.current).toBeNull();
    // 검토 대상이 먼저 정렬
    expect(r.changes.slice(0, 2).every((c) => c.needsReview)).toBe(true);
  });

  it('10명 중 급여변경 1명 + 이번달 퇴사(퇴사월 급여 지급) 1명 → 검토 2명', () => {
    const all = ids(10);
    const employees = all.map((id) => (id === '07' ? emp(id, { resignDate: '2026-09-15' }) : emp(id)));
    const prevLines = month(all, 3_000_000, PREV_DATE);
    const currLines = month(all).map((l) => (l.employeeId === '02' ? pl('02', 2_800_000) : l));
    const r = diffPayroll({ employees, lines: prevLines }, { employees, lines: currLines }, { period: '2026-09' });
    expect(r.summary.needsReview).toBe(2);
    expect(r.summary.resigned).toBe(1);
    const resigned = r.changes.find((c) => c.employeeId === '07')!;
    expect(resigned.kinds).toEqual(['resigned']);
    expect(resigned.messages.join(' ')).toContain('퇴사일 2026-09-15');
    expect(r.changes.find((c) => c.employeeId === '02')!.messages[0]).toBe('급여 3,000,000원 → 2,800,000원 (-6.7%)');
  });

  it('이번달 퇴사자가 지급내역 없음 → resigned + 검토', () => {
    const employees = [emp('01'), emp('02', { resignDate: '2026-09-10' })];
    const r = diffPayroll(
      { employees, lines: month(['01', '02'], 3_000_000, PREV_DATE) },
      { employees, lines: month(['01']) },
      { period: '2026-09' },
    );
    const c = r.changes.find((x) => x.employeeId === '02')!;
    expect(c.kinds).toEqual(['resigned']);
    expect(c.needsReview).toBe(true);
    expect(c.messages[0]).toContain('퇴사월 급여 누락');
  });

  it('전월 8명 → 이번달 8명: "변동 없음 6명 / 급여변경 1명 / 신규입사 1명" (전월 퇴사자는 검토 불필요)', () => {
    const prevIds = ids(8);
    const currIds = [...prevIds.slice(0, 7), '09'];
    const employees = [
      ...prevIds.map((id) => (id === '08' ? emp(id, { resignDate: '2026-08-31' }) : emp(id))),
      emp('09', { hireDate: '2026-09-01' }),
    ];
    const prevLines = month(prevIds, 3_000_000, PREV_DATE);
    const currLines = month(currIds).map((l) => (l.employeeId === '01' ? pl('01', 3_100_000) : l));
    const r = diffPayroll({ employees, lines: prevLines }, { employees, lines: currLines }, { period: '2026-09' });

    expect(r.summary).toMatchObject({ unchanged: 6, payChanged: 1, newHire: 1, resigned: 1, missing: 0, needsReview: 2, total: 9 });
    expect(formatDiffSummary(r.summary)).toBe('변동 없음 6명 / 급여변경 1명 / 신규입사 1명 / 퇴사 1명');
    const left = r.changes.find((c) => c.employeeId === '08')!;
    expect(left).toMatchObject({ kinds: ['resigned'], needsReview: false, severity: 'info' });
    const hire = r.changes.find((c) => c.employeeId === '09')!;
    expect(hire.kinds).toEqual(['new_hire']);
    expect(hire.messages[0]).toBe('신규입사 (입사일 2026-09-01)');
    expect(hire.previous).toBeNull();
  });
});

describe('diffPayroll — 증감률 임계치 (기본 20%, 경계 포함)', () => {
  const employees = [emp('01')];
  const run = (prev: number, curr: number, pct?: number) =>
    diffPayroll(
      { employees, lines: [pl('01', prev, PREV_DATE)] },
      { employees, lines: [pl('01', curr)] },
      { period: '2026-09', ...(pct !== undefined ? { largeChangePct: pct } : {}) },
    ).changes[0]!;

  it('+20.0% 정확히 → pay_changed_large (warning)', () => {
    const c = run(3_000_000, 3_600_000);
    expect(c.kinds).toEqual(['pay_changed', 'pay_changed_large']);
    expect(c.severity).toBe('warning');
    expect(c.changeRate).toBe(20);
    expect(c.messages[0]).toBe('급여 3,000,000원 → 3,600,000원 (+20.0%)');
  });
  it('+19.99% → pay_changed 만', () => {
    const c = run(3_000_000, 3_599_990);
    expect(c.kinds).toEqual(['pay_changed']);
    expect(c.severity).toBe('info');
  });
  it('−20% 감소도 large', () => {
    expect(run(3_000_000, 2_400_000).kinds).toContain('pay_changed_large');
    expect(run(3_000_000, 2_400_010).kinds).not.toContain('pay_changed_large');
  });
  it('임계치 옵션 변경', () => {
    expect(run(3_000_000, 3_300_000, 10).kinds).toContain('pay_changed_large');
    expect(run(3_000_000, 3_300_000).kinds).not.toContain('pay_changed_large');
  });
  it('changeRatePct', () => {
    expect(changeRatePct(3_000_000, 3_300_000)).toBe(10);
    expect(changeRatePct(3_000_000, 2_000_000)).toBe(-33.3);
    expect(changeRatePct(0, 100)).toBeNull();
  });
});

describe('diffPayroll — 규칙별', () => {
  it('주민번호 없음 → missing_id (high), 마스터 없음도 missing_id', () => {
    const employees = [emp('01', { hasIdNumber: false, idNumberMasked: null })];
    const r = diffPayroll(
      { employees, lines: [pl('01', 3_000_000, PREV_DATE)] },
      { employees, lines: [pl('01', 3_000_000), pl('99', 1_000_000)] },
      { period: '2026-09' },
    );
    const a = r.changes.find((c) => c.employeeId === '01')!;
    expect(a.kinds).toEqual(['missing_id']);
    expect(a.severity).toBe('high');
    expect(a.needsReview).toBe(true);
    const b = r.changes.find((c) => c.employeeId === '99')!;
    expect(b.kinds).toEqual(['missing_id', 'new_hire']);
    expect(b.messages[0]).toContain('직원 마스터에 없는 직원');
    expect(r.summary.missingId).toBe(2);
    // high 가 먼저
    expect(r.changes[0]!.severity).toBe('high');
  });
  it('직원 ID 가 비어 있는 행', () => {
    const r = diffPayroll({ employees: [], lines: [] }, { employees: [], lines: [pl('', 500_000, { name: '미상' })] }, { period: '2026-09' });
    expect(r.changes[0]!.kinds).toContain('missing_id');
    expect(r.changes[0]!.messages[0]).toContain('직원 ID 없음');
  });
  it('지급액 0원 → zero_pay', () => {
    const employees = [emp('01')];
    const r = diffPayroll({ employees, lines: [pl('01', 3_000_000, PREV_DATE)] }, { employees, lines: [pl('01', 0)] }, { period: '2026-09' });
    const c = r.changes[0]!;
    expect(c.kinds).toEqual(['pay_changed', 'pay_changed_large', 'zero_pay']);
    expect(r.summary.zeroPay).toBe(1);
    expect(c.changeRate).toBe(-100);
  });
  it('소득구분 변경 → income_type_changed (high)', () => {
    const employees = [emp('01', { incomeType: 'earned' })];
    const r = diffPayroll(
      { employees, lines: [pl('01', 3_000_000, { ...PREV_DATE, incomeType: 'business' })] },
      { employees, lines: [pl('01', 3_000_000, { incomeType: 'earned' })] },
      { period: '2026-09' },
    );
    expect(r.changes[0]!.kinds).toEqual(['income_type_changed']);
    expect(r.changes[0]!.severity).toBe('high');
    expect(r.changes[0]!.messages[0]).toBe('소득구분 변경: 사업소득 → 근로소득 — 원천징수 방식 확인');
  });
  it('지급총액 동일·과세/비과세 구성 변경 → pay_changed', () => {
    const employees = [emp('01')];
    const r = diffPayroll(
      { employees, lines: [pl('01', 3_000_000, PREV_DATE)] },
      { employees, lines: [pl('01', 3_000_000, { nonTaxablePay: 200_000 })] },
      { period: '2026-09' },
    );
    expect(r.changes[0]!.kinds).toEqual(['pay_changed']);
    expect(r.changes[0]!.messages[0]).toContain('과세/비과세 구성 변경');
  });
  it('수당 항목 변동 설명', () => {
    const employees = [emp('01')];
    const r = diffPayroll(
      { employees, lines: [pl('01', 3_000_000, { ...PREV_DATE, allowances: { 식대: 200_000 } })] },
      { employees, lines: [pl('01', 3_300_000, { allowances: { 식대: 200_000, 직책수당: 300_000 } })] },
      { period: '2026-09' },
    );
    expect(r.changes[0]!.messages).toContain('항목 변동: 직책수당 신규 300,000원');
  });
  it('퇴사일 이후 급여 지급 → resigned 경고', () => {
    const employees = [emp('01', { resignDate: '2026-07-31' })];
    const r = diffPayroll({ employees, lines: [pl('01', 3_000_000, PREV_DATE)] }, { employees, lines: [pl('01', 3_000_000)] }, { period: '2026-09' });
    expect(r.changes[0]!.kinds).toEqual(['resigned']);
    expect(r.changes[0]!.messages[0]).toContain('이후 급여 지급');
  });
  it('퇴사 예정(다음 달 이후) → 종류 변화 없음, 메시지만', () => {
    const employees = [emp('01', { resignDate: '2026-10-15' })];
    const r = diffPayroll({ employees, lines: [pl('01', 3_000_000, PREV_DATE)] }, { employees, lines: [pl('01', 3_000_000)] }, { period: '2026-09' });
    expect(r.changes[0]!.kinds).toEqual(['unchanged']);
    expect(r.changes[0]!.needsReview).toBe(false);
    expect(r.changes[0]!.messages).toContain('퇴사 예정 (퇴사일 2026-10-15)');
  });
  it('전월 지급 없던 기존 직원 → new_hire(복귀 확인)', () => {
    const employees = [emp('01', { hireDate: '2025-03-01' })];
    const r = diffPayroll({ employees, lines: [] }, { employees, lines: [pl('01', 1_000_000)] }, { period: '2026-09' });
    expect(r.changes[0]!.kinds).toEqual(['new_hire']);
    expect(r.changes[0]!.messages[0]).toContain('재입사/복귀');
  });
  it('동일 직원 2건 → 합산 비교', () => {
    const employees = [emp('01')];
    const r = diffPayroll(
      { employees, lines: [pl('01', 3_000_000, PREV_DATE)] },
      { employees, lines: [pl('01', 2_000_000), pl('01', 1_000_000, { paymentDate: '2026-09-30' })] },
      { period: '2026-09' },
    );
    const c = r.changes[0]!;
    expect(c.kinds).toEqual(['unchanged']);
    expect(c.current!.grossPay).toBe(3_000_000);
    expect(c.current!.paymentDate).toBe('2026-09-30');
    expect(c.messages).toContain('동일 직원 지급내역 2건 합산');
  });
  it('귀속연월 미지정 → 이번달 지급일 최빈 연월로 추정', () => {
    const employees = [emp('01'), emp('02', { resignDate: '2026-08-20' })];
    const r = diffPayroll(
      { employees, lines: month(['01', '02'], 3_000_000, PREV_DATE) },
      { employees, lines: month(['01']) },
    );
    expect(r.period).toBe('2026-09');
    expect(r.changes.find((c) => c.employeeId === '02')!.needsReview).toBe(false);
  });
});

describe('diffPayroll — 일용직', () => {
  const employees = [emp('D1', { incomeType: 'daily' })];
  const daily = (gross: number, days: number, over: Partial<PayrollLine> = {}) => pl('D1', gross, { incomeType: 'daily', workDays: days, ...over });

  it('일당 동일·근무일수만 변동 → unchanged (검토 불필요)', () => {
    const r = diffPayroll(
      { employees, lines: [daily(150_000 * 20, 20, PREV_DATE)] },
      { employees, lines: [daily(150_000 * 12, 12)] },
      { period: '2026-09' },
    );
    const c = r.changes[0]!;
    expect(c.kinds).toEqual(['unchanged']);
    expect(c.needsReview).toBe(false);
    expect(c.messages[0]).toBe('근무일수 20일 → 12일 (일당 150,000원 동일), 지급액 3,000,000원 → 1,800,000원');
    expect(c.changeRate).toBe(-40);
  });
  it('일당 변경(+33.3%) → pay_changed_large', () => {
    const r = diffPayroll(
      { employees, lines: [daily(150_000 * 10, 10, PREV_DATE)] },
      { employees, lines: [daily(200_000 * 10, 10)] },
      { period: '2026-09' },
    );
    const c = r.changes[0]!;
    expect(c.kinds).toEqual(['pay_changed', 'pay_changed_large']);
    expect(c.messages[0]).toBe('일당 150,000원 → 200,000원 (+33.3%)');
  });
  it('일당 소폭 변경 + 근무일수 변동 → pay_changed 만 (일수 변화로 large 판정하지 않음)', () => {
    const r = diffPayroll(
      { employees, lines: [daily(150_000 * 20, 20, PREV_DATE)] },
      { employees, lines: [daily(160_000 * 5, 5)] },
      { period: '2026-09' },
    );
    const c = r.changes[0]!;
    expect(c.kinds).toEqual(['pay_changed']);
    expect(c.changeRate).toBe(6.7);
    expect(c.messages).toEqual(['일당 150,000원 → 160,000원 (+6.7%)', '근무일수 20일 → 5일']);
  });
  it('근무일수 미입력이면 지급액으로 비교', () => {
    const r = diffPayroll(
      { employees, lines: [daily(1_000_000, 5, PREV_DATE)] },
      { employees, lines: [pl('D1', 1_500_000, { incomeType: 'daily' })] },
      { period: '2026-09' },
    );
    expect(r.changes[0]!.kinds).toEqual(['pay_changed', 'pay_changed_large']);
    expect(r.changes[0]!.messages[0]).toBe('지급액 1,000,000원 → 1,500,000원 (+50.0%)');
  });
});

describe('formatDiffSummary', () => {
  it('0명 항목 생략 / 대상 없음', () => {
    const r = diffPayroll({ employees: [], lines: [] }, { employees: [], lines: [] });
    expect(formatDiffSummary(r.summary)).toBe('대상 없음');
    expect(r.period).toBeNull();
  });
});
