import { describe, expect, it } from 'vitest';
import type { PayrollLine } from '../types';
import {
  applyRate,
  checkLineWithholding,
  computeBusinessWithholding,
  computeDailyWorkerWithholding,
  computeLineWithholding,
  dailyWagesOfLine,
  estimateEarnedIncomeTaxRough,
  localIncomeTaxOf,
  resolveWithholdingParams,
  ROUGH_ESTIMATE_LABEL,
  truncateToUnit,
  validateEarnedWithholding,
  WITHHOLDING_PARAMS,
} from './withholding';

function line(over: Partial<PayrollLine> = {}): PayrollLine {
  const taxablePay = over.taxablePay ?? 3_000_000;
  const nonTaxablePay = over.nonTaxablePay ?? 0;
  return {
    employeeId: 'e1',
    name: '김철수',
    incomeType: 'earned',
    taxablePay,
    nonTaxablePay,
    grossPay: taxablePay + nonTaxablePay,
    allowances: {},
    incomeTax: 74_350,
    localIncomeTax: 7_430,
    otherDeductions: 0,
    netPay: 0,
    paymentDate: '2026-09-25',
    ...over,
  };
}

describe('산술 헬퍼', () => {
  it('applyRate 는 부동소수 오차 없이 원 미만 절사', () => {
    expect(applyRate(1_234_567, 0.03)).toBe(37_037);
    expect(applyRate(100, 0.07)).toBe(7); // 100*0.07 = 7.000000000000001
    expect(applyRate(58_000_000_000, 0.03)).toBe(1_740_000_000);
    expect(applyRate(-1_000, 0.03)).toBe(-30);
  });
  it('truncateToUnit', () => {
    expect(truncateToUnit(99_999, 10)).toBe(99_990);
    expect(truncateToUnit(135, 1)).toBe(135);
    expect(truncateToUnit(-135, 10)).toBe(-130);
  });
  it('지방소득세 = 소득세 × 10%, 10원 미만 절사 (단위 설정 가능)', () => {
    expect(localIncomeTaxOf(30_000)).toBe(3_000);
    expect(localIncomeTaxOf(1_350)).toBe(130);
    expect(localIncomeTaxOf(1_350, { localTaxTruncateUnit: 1 })).toBe(135);
    expect(localIncomeTaxOf(0)).toBe(0);
  });
  it('파라미터 부분 덮어쓰기 — 중첩 객체 병합', () => {
    const p = resolveWithholdingParams({ daily: { dailyDeduction: 200_000 } });
    expect(p.daily.dailyDeduction).toBe(200_000);
    expect(p.daily.incomeTaxRate).toBe(0.06);
    expect(p.business).toEqual(WITHHOLDING_PARAMS.business);
    expect(resolveWithholdingParams()).toBe(WITHHOLDING_PARAMS);
  });
});

describe('사업소득 3.3%', () => {
  it('1,000,000원 → 소득세 30,000 / 지방 3,000', () => {
    const r = computeBusinessWithholding(1_000_000);
    expect(r.incomeTax).toBe(30_000);
    expect(r.localIncomeTax).toBe(3_000);
    expect(r.incomeTax + r.localIncomeTax).toBe(33_000);
    expect(r.smallAmountExempted).toBe(false);
  });
  it('10원 미만 절사', () => {
    const r = computeBusinessWithholding(3_333_333); // 99,999.99
    expect(r.incomeTax).toBe(99_990);
    expect(r.localIncomeTax).toBe(9_990);
    expect(computeBusinessWithholding(1_234_567).incomeTax).toBe(37_030);
  });
  it('인적용역 사업소득은 1,000원 미만이어도 징수 (2024-07-01 이후 지급분)', () => {
    const r = computeBusinessWithholding(20_000, { paymentDate: '2026-09-10' });
    expect(r.incomeTax).toBe(600);
    expect(r.localIncomeTax).toBe(60);
    expect(r.smallAmountExempted).toBe(false);
    // 지급일 미상 → 배제(징수)로 본다
    expect(computeBusinessWithholding(20_000).incomeTax).toBe(600);
  });
  it('인적용역 아님(의료보건용역) 또는 2024-07-01 전 지급분 → 소액부징수', () => {
    const med = computeBusinessWithholding(20_000, { personalService: false });
    expect(med.incomeTax).toBe(0);
    expect(med.localIncomeTax).toBe(0);
    expect(med.smallAmountExempted).toBe(true);
    expect(computeBusinessWithholding(20_000, { paymentDate: '2024-06-30' }).incomeTax).toBe(0);
    expect(computeBusinessWithholding(20_000, { paymentDate: '2024-07-01' }).incomeTax).toBe(600);
  });
  it('0원 이하 지급액 → 세액 없음', () => {
    expect(computeBusinessWithholding(0).incomeTax).toBe(0);
    expect(computeBusinessWithholding(-5_000).incomeTax).toBe(0);
  });
});

describe('일용근로 2.7%', () => {
  it('일당 200,000 × 5일 → 1일 1,350 → 6,750', () => {
    const r = computeDailyWorkerWithholding({ dailyWage: 200_000, workDays: 5 });
    expect(r.perDay).toEqual([{ dailyWage: 200_000, days: 5, taxablePerDay: 50_000, taxPerDay: 1_350 }]);
    expect(r.incomeTax).toBe(6_750);
    expect(r.localIncomeTax).toBe(670); // 675 → 10원 미만 절사
    expect(computeDailyWorkerWithholding({ dailyWage: 200_000, workDays: 5 }, { localTaxTruncateUnit: 1 }).localIncomeTax).toBe(675);
    expect(r.workDays).toBe(5);
    expect(r.totalWage).toBe(1_000_000);
  });
  it('1일 200,000 → 1,350 (research T1)', () => {
    const r = computeDailyWorkerWithholding({ dailyWages: [200_000] });
    expect(r.incomeTax).toBe(1_350);
    expect(r.localIncomeTax).toBe(130);
  });
  it('1,000원 미만 → 소액부징수 0원 (research T2: 일당 187,000 → 999)', () => {
    const r = computeDailyWorkerWithholding({ dailyWages: [187_000] });
    expect(r.computedIncomeTax).toBe(990); // 999 → 10원 미만 절사
    expect(r.incomeTax).toBe(0);
    expect(r.localIncomeTax).toBe(0);
    expect(r.smallAmountExempted).toBe(true);
    expect(r.basis.join(' ')).toContain('소액부징수');
  });
  it('일괄지급은 일별 세액 합계로 소액부징수 판단 (research T3: 180,000 × 5일 → 4,050)', () => {
    const r = computeDailyWorkerWithholding({ dailyWage: 180_000, workDays: 5 });
    expect(r.incomeTax).toBe(4_050);
    expect(r.localIncomeTax).toBe(400);
    expect(r.smallAmountExempted).toBe(false);
  });
  it('일당 150,000 이하 → 과세대상 없음 (소액부징수 아님)', () => {
    const r = computeDailyWorkerWithholding({ dailyWage: 150_000, workDays: 20 });
    expect(r.incomeTax).toBe(0);
    expect(r.smallAmountExempted).toBe(false);
    expect(computeDailyWorkerWithholding({ dailyWage: 100_000, workDays: 3 }).perDay[0]!.taxablePerDay).toBe(0);
  });
  it('일당이 다른 날 혼합', () => {
    const r = computeDailyWorkerWithholding({ dailyWages: [200_000, 187_000] });
    expect(r.incomeTax).toBe(2_340); // 1,350 + 999 = 2,349 → 2,340
    expect(r.localIncomeTax).toBe(230);
    expect(r.perDay).toHaveLength(2);
  });
  it('일별 끝수 처리 설정: won(일별 원 미만 절사) vs none', () => {
    // 과세 40,500 × 2.7% = 1,093.5/일
    expect(computeDailyWorkerWithholding({ dailyWage: 190_500, workDays: 3 }).incomeTax).toBe(3_270); // 1,093×3=3,279
    expect(computeDailyWorkerWithholding({ dailyWage: 190_500, workDays: 3 }, { daily: { perDayRounding: 'none' } }).incomeTax).toBe(3_280); // 3,280.5
  });
  it('근무일수 0 → 0원', () => {
    expect(computeDailyWorkerWithholding({ dailyWage: 200_000, workDays: 0 }).incomeTax).toBe(0);
  });
});

describe('급여행 단위 계산', () => {
  it('일용직 행: 과세급여/근무일수로 일당 복원', () => {
    const l = line({ incomeType: 'daily', taxablePay: 1_000_000, workDays: 5, incomeTax: 0, localIncomeTax: 0 });
    const w = computeLineWithholding(l);
    expect(w.source).toBe('calculated');
    expect(w.incomeTax).toBe(6_750);
    expect(w.issues).toEqual([]);
  });
  it('일당이 나누어떨어지지 않으면 근사 + 경고', () => {
    expect(dailyWagesOfLine({ taxablePay: 1_000_001, workDays: 5 })).toEqual({ wages: [200_001, 200_000, 200_000, 200_000, 200_000], even: false });
    const w = computeLineWithholding(line({ incomeType: 'daily', taxablePay: 1_000_001, workDays: 5 }));
    expect(w.issues.map((i) => i.code)).toContain('daily_uneven_wage');
    expect(w.incomeTax).toBe(6_750);
  });
  it('일용직 근무일수 없음 → 계산 불가(high)', () => {
    const w = computeLineWithholding(line({ incomeType: 'daily', taxablePay: 600_000, workDays: undefined, incomeTax: 999, localIncomeTax: 99 }));
    expect(w.source).toBe('unavailable');
    expect(w.incomeTax).toBe(999);
    expect(w.issues[0]).toMatchObject({ code: 'daily_missing_days', severity: 'high' });
  });
  it('사업소득 행', () => {
    const w = computeLineWithholding(line({ incomeType: 'business', taxablePay: 2_000_000, incomeTax: 0, localIncomeTax: 0 }));
    expect(w).toMatchObject({ incomeTax: 60_000, localIncomeTax: 6_000, source: 'calculated' });
  });
  it('사업소득 비과세 입력·지급총액 불일치 경고', () => {
    const w = computeLineWithholding(line({ incomeType: 'business', taxablePay: 1_000_000, nonTaxablePay: 100_000, grossPay: 1_000_000 }));
    expect(w.issues.map((i) => i.code).sort()).toEqual(['business_non_taxable', 'gross_mismatch']);
  });
  it('근로소득 행: 소득세는 입력값 유지, 지방세만 재계산', () => {
    const w = computeLineWithholding(line({ incomeTax: 84_850, localIncomeTax: 0 }));
    expect(w).toMatchObject({ incomeTax: 84_850, localIncomeTax: 8_480, source: 'imported' });
  });
  it('checkLineWithholding: 사업소득 세액 불일치·지방세 불일치', () => {
    const issues = checkLineWithholding(line({ incomeType: 'business', taxablePay: 1_000_000, incomeTax: 33_000, localIncomeTax: 3_000 }));
    expect(issues.map((i) => i.code)).toEqual(['tax_mismatch', 'local_tax_mismatch']);
    expect(issues[0]!.message).toBe('소득세 불일치: 계산 30,000원, 입력 33,000원');
    expect(checkLineWithholding(line({ incomeType: 'business', taxablePay: 1_000_000, incomeTax: 30_000, localIncomeTax: 3_000 }))).toEqual([]);
  });
  it('checkLineWithholding: 근로소득은 validateEarnedWithholding 위임', () => {
    const prev = line();
    const curr = line({ incomeTax: 80_000, localIncomeTax: 8_000 });
    expect(checkLineWithholding(curr, prev).map((i) => i.code)).toEqual(['pay_same_tax_changed']);
  });
});

describe('근로소득 정합성 검증 (validateEarnedWithholding)', () => {
  it('정상: 급여·세액 동일', () => {
    expect(validateEarnedWithholding(line(), line())).toEqual([]);
  });
  it('급여 동일인데 소득세 변경 → warning', () => {
    const issues = validateEarnedWithholding(line({ incomeTax: 90_000, localIncomeTax: 9_000 }), line());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'pay_same_tax_changed', severity: 'warning' });
    expect(issues[0]!.message).toContain('소득세 74,350원 → 90,000원');
  });
  it('급여 변경(≥2만원)인데 소득세 동일 → warning', () => {
    const issues = validateEarnedWithholding(line({ taxablePay: 3_300_000 }), line());
    expect(issues.map((i) => i.code)).toEqual(['pay_changed_tax_same']);
    expect(issues[0]!.message).toContain('과세급여 3,000,000원 → 3,300,000원');
  });
  it('소폭 변경(2만원 미만)·세액 0원 구간은 경고하지 않음', () => {
    expect(validateEarnedWithholding(line({ taxablePay: 3_010_000 }), line())).toEqual([]);
    const low = line({ taxablePay: 900_000, incomeTax: 0, localIncomeTax: 0 });
    expect(validateEarnedWithholding({ ...low, taxablePay: 950_000, grossPay: 950_000 }, low)).toEqual([]);
  });
  it('급여 증가인데 소득세 감소 → 방향 불일치', () => {
    const issues = validateEarnedWithholding(line({ taxablePay: 3_500_000, incomeTax: 60_000, localIncomeTax: 6_000 }), line());
    expect(issues.map((i) => i.code)).toEqual(['pay_tax_direction']);
  });
  it('지방소득세: 끝수 차이는 info, 그 외 불일치는 warning', () => {
    const rounding = validateEarnedWithholding(line({ incomeTax: 84_850, localIncomeTax: 8_485 }));
    expect(rounding).toEqual([expect.objectContaining({ code: 'local_tax_rounding', severity: 'info' })]);
    const wrong = validateEarnedWithholding(line({ incomeTax: 84_850, localIncomeTax: 9_000 }));
    expect(wrong).toEqual([expect.objectContaining({ code: 'local_tax_mismatch', severity: 'warning' })]);
    const nearButWrong = validateEarnedWithholding(line({ incomeTax: 84_850, localIncomeTax: 8_489 }));
    expect(nearButWrong).toEqual([expect.objectContaining({ code: 'local_tax_mismatch' })]);
    // 원 단위 설정일 때 10원 절사값 입력 → info
    const unit1 = validateEarnedWithholding(line({ incomeTax: 84_850, localIncomeTax: 8_480 }), null, { params: { localTaxTruncateUnit: 1 } });
    expect(unit1).toEqual([expect.objectContaining({ code: 'local_tax_rounding' })]);
  });
  it('과세급여 0원에 소득세 → high, 음수 세액 → warning', () => {
    const issues = validateEarnedWithholding(line({ taxablePay: 0, incomeTax: 10_000, localIncomeTax: 1_000 }));
    expect(issues[0]).toMatchObject({ code: 'tax_without_pay', severity: 'high' });
    expect(validateEarnedWithholding(line({ incomeTax: -5_000, localIncomeTax: -500 })).map((i) => i.code)).toEqual(['negative_tax']);
  });
  it('근로소득이 아니면 검증 대상 아님', () => {
    expect(validateEarnedWithholding(line({ incomeType: 'business' }))).toEqual([]);
  });
  it('검증용 추정과 큰 차이 → info (옵션)', () => {
    const issues = validateEarnedWithholding(line({ incomeTax: 500_000, localIncomeTax: 50_000 }), null, { useRoughEstimate: true });
    expect(issues).toEqual([expect.objectContaining({ code: 'rough_estimate_gap', severity: 'info' })]);
    expect(issues[0]!.message).toContain(ROUGH_ESTIMATE_LABEL);
    expect(validateEarnedWithholding(line(), null, { useRoughEstimate: true })).toEqual([]);
  });
});

describe('검증용 추정(간이세액표 아님)', () => {
  it('라벨이 명확하고 0원 급여는 0원', () => {
    const e = estimateEarnedIncomeTaxRough(0);
    expect(e.label).toBe('검증용 추정(간이세액표 아님)');
    expect(e.incomeTax).toBe(0);
  });
  it('급여 증가 → 세액 비감소, 부양가족 증가 → 세액 비증가', () => {
    let last = -1;
    for (const pay of [1_000_000, 2_000_000, 3_000_000, 5_000_000, 8_000_000, 12_000_000]) {
      const t = estimateEarnedIncomeTaxRough(pay).incomeTax;
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
      expect(estimateEarnedIncomeTaxRough(pay, { dependents: 4 }).incomeTax).toBeLessThanOrEqual(t);
    }
  });
  it('월 300만원 1인 → 간이세액표와 같은 자릿수(대략 5~13만원), 10원 단위', () => {
    const e = estimateEarnedIncomeTaxRough(3_000_000);
    expect(e.incomeTax).toBeGreaterThan(50_000);
    expect(e.incomeTax).toBeLessThan(130_000);
    expect(e.incomeTax % 10).toBe(0);
    expect(e.localIncomeTax).toBe(localIncomeTaxOf(e.incomeTax));
    // 총급여 3,600만원: 750만원 + (3,600만 − 1,500만) × 15% = 1,065만원 (소득세법 제47조 ①)
    expect(e.breakdown.earnedIncomeDeduction).toBe(10_650_000);
  });
  it('저소득(월 100만원) → 0원', () => {
    expect(estimateEarnedIncomeTaxRough(1_000_000).incomeTax).toBe(0);
  });
});
