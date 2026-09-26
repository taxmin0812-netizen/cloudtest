import { describe, expect, it } from 'vitest';
import type { IncomeType, PayrollLine } from '../types';
import {
  aggregateEarnedStatementRows,
  buildSimplifiedStatements,
  buildWithholdingReturn,
  safeMaskedId,
  WITHHOLDING_RETURN_CODES,
  type StatementEmployee,
} from './filing';

function pl(id: string, incomeType: IncomeType, taxablePay: number, over: Partial<PayrollLine> = {}): PayrollLine {
  const nonTaxablePay = over.nonTaxablePay ?? 0;
  return {
    employeeId: id,
    name: `직원${id}`,
    incomeType,
    taxablePay,
    nonTaxablePay,
    grossPay: taxablePay + nonTaxablePay,
    allowances: {},
    incomeTax: 0,
    localIncomeTax: 0,
    otherDeductions: 0,
    netPay: 0,
    paymentDate: '2026-09-25',
    ...over,
  };
}

function emp(id: string, incomeType: IncomeType, over: Partial<StatementEmployee> = {}): StatementEmployee {
  return {
    employeeId: id,
    name: `직원${id}`,
    incomeType,
    hasIdNumber: true,
    idNumberMasked: '900101-1******',
    hireDate: '2024-01-02',
    resignDate: null,
    ...over,
  };
}

// 근로 3명(1명 비과세 포함), 일용 2명, 사업 2명
const LINES: PayrollLine[] = [
  pl('E1', 'earned', 3_000_000, { nonTaxablePay: 200_000, incomeTax: 74_350, localIncomeTax: 7_430 }),
  pl('E2', 'earned', 2_500_000, { incomeTax: 36_000, localIncomeTax: 3_600 }),
  pl('E3', 'earned', 4_000_000, { incomeTax: 200_000, localIncomeTax: 20_000 }),
  pl('D1', 'daily', 1_000_000, { workDays: 5, incomeTax: 6_750, localIncomeTax: 670 }),
  pl('D2', 'daily', 187_000, { workDays: 1, incomeTax: 0, localIncomeTax: 0 }),
  pl('B1', 'business', 1_000_000, { incomeTax: 30_000, localIncomeTax: 3_000 }),
  pl('B2', 'business', 500_000, { incomeTax: 15_000, localIncomeTax: 1_500 }),
];

describe('buildWithholdingReturn — 원천징수이행상황신고서 요약', () => {
  it('A01/A03/A10/A25/A30/A99 집계', () => {
    const r = buildWithholdingReturn(LINES, '2026-09');
    const byCode = Object.fromEntries(r.rows.map((x) => [x.code, x]));
    expect(r.rows.map((x) => x.code)).toEqual(['A01', 'A03', 'A10', 'A25', 'A30', 'A99']);
    expect(byCode.A01).toMatchObject({ label: '근로소득 간이세액', persons: 3, totalPay: 9_700_000, incomeTax: 310_350, isSubtotal: false });
    expect(byCode.A03).toMatchObject({ persons: 2, totalPay: 1_187_000, incomeTax: 6_750 });
    expect(byCode.A10).toMatchObject({ persons: 5, totalPay: 10_887_000, incomeTax: 317_100, isSubtotal: true });
    expect(byCode.A25).toMatchObject({ label: '사업소득 매월징수', persons: 2, totalPay: 1_500_000, incomeTax: 45_000 });
    expect(byCode.A30).toMatchObject({ persons: 2, totalPay: 1_500_000, incomeTax: 45_000 });
    expect(r.total).toMatchObject({ code: 'A99', persons: 7, totalPay: 12_387_000, incomeTax: 362_100 });
    expect(r.warnings).toEqual([]);
    expect(r.notCovered.length).toBeGreaterThan(0);
  });

  it('지방소득세 특별징수 요약 (10%) + 기한 (10-10 토 → 10-12)', () => {
    const r = buildWithholdingReturn(LINES, '2026-09');
    expect(r.localIncomeTax).toMatchObject({
      rate: 0.1,
      declared: 36_200,
      expected: 36_200,
      matches: true,
      byIncomeType: { earned: 31_030, daily: 670, business: 4_500 },
      dueDate: '2026-10-12',
    });
    expect(r.dueDate).toBe('2026-10-12');
    expect(r.dueNote).toContain('2026-10-10(토)');
  });

  it('비과세 제외 옵션', () => {
    const r = buildWithholdingReturn(LINES, '2026-09', { includeNonTaxableInTotalPay: false });
    expect(r.rows.find((x) => x.code === 'A01')!.totalPay).toBe(9_500_000);
  });

  it('해당 소득만 행 생성 (사업소득만 → A25/A30/A99)', () => {
    const r = buildWithholdingReturn(LINES.filter((l) => l.incomeType === 'business'), '2026-09');
    expect(r.rows.map((x) => x.code)).toEqual(['A25', 'A30', 'A99']);
    expect(buildWithholdingReturn([], '2026-09').rows.map((x) => x.code)).toEqual(['A99']);
  });

  it('인원: 동일 직원 중복 1명, 무급 행 제외', () => {
    const r = buildWithholdingReturn(
      [pl('E1', 'earned', 3_000_000), pl('E1', 'earned', 500_000), pl('E2', 'earned', 0)],
      '2026-09',
    );
    expect(r.rows[0]).toMatchObject({ code: 'A01', persons: 1, totalPay: 3_500_000 });
  });

  it('세액·지방세 불일치, 지급연월 불일치, 지급일 누락 경고', () => {
    const r = buildWithholdingReturn(
      [
        pl('B1', 'business', 1_000_000, { incomeTax: 33_000, localIncomeTax: 3_300 }),
        pl('E1', 'earned', 3_000_000, { incomeTax: 74_350, localIncomeTax: 8_000, paymentDate: '2026-10-05' }),
        pl('E2', 'earned', 2_000_000, { paymentDate: null }),
      ],
      '2026-09',
    );
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        '지급일이 신고 지급연월(2026-09)과 다른 내역 1건 — 지급연월 확인',
        '지급일 미입력 1건 — 원천세는 지급일 기준으로 신고합니다',
        '직원B1: 소득세 입력 33,000원 ≠ 계산 30,000원',
        '지방소득세 합계 불일치: 입력 11,300원, 소득세×10% 재계산 10,730원',
      ]),
    );
    expect(r.localIncomeTax.matches).toBe(false);
  });

  it('반기납부: 반기 범위 점검 + 7/10 기한', () => {
    const lines = [pl('E1', 'earned', 3_000_000, { paymentDate: '2026-02-25' }), pl('E1', 'earned', 3_000_000, { paymentDate: '2026-06-25' })];
    const r = buildWithholdingReturn(lines, '2026-06', { semiannual: true, attributionPeriod: '2026-06' });
    expect(r.dueDate).toBe('2026-07-10');
    expect(r.semiannual).toBe(true);
    expect(r.attributionPeriod).toBe('2026-06');
    expect(r.rows[0]).toMatchObject({ persons: 1, totalPay: 6_000_000 });
    expect(r.warnings.some((w) => w.includes('지급연월'))).toBe(false);
    expect(r.warnings.some((w) => w.includes('반기납부'))).toBe(true);
  });

  it('코드 라벨 테이블', () => {
    expect(WITHHOLDING_RETURN_CODES.A03.label).toBe('근로소득 일용근로');
    expect(WITHHOLDING_RETURN_CODES.A99.label).toBe('총합계');
  });
});

describe('buildSimplifiedStatements — 간이지급명세서 / 일용근로소득 지급명세서', () => {
  const employees: StatementEmployee[] = [
    emp('E1', 'earned', { hireDate: '2026-08-10' }),
    emp('E2', 'earned'),
    emp('E3', 'earned', { resignDate: '2026-11-20' }),
    emp('D1', 'daily'),
    emp('D2', 'daily'),
    emp('B1', 'business', { businessIncomeCode: '940909', idNumberMasked: '8501012345678' }), // 원문이 잘못 저장된 경우
    emp('B2', 'business', { businessIncomeCode: null, hasIdNumber: false, idNumberMasked: null }),
  ];

  it('사업소득 행: 성명·마스킹 주민번호·업종코드·지급액·세율·세액, 원문 주민번호 미노출', () => {
    const s = buildSimplifiedStatements(LINES, employees, '2026-09');
    expect(s.business.rows).toHaveLength(2);
    expect(s.business.rows[0]).toEqual({
      employeeId: 'B1',
      name: '직원B1',
      idNumberMasked: '850101-2******',
      hasIdNumber: true,
      paymentPeriod: '2026-09',
      industryCode: '940909',
      paidAmount: 1_000_000,
      taxRatePct: 3,
      incomeTax: 30_000,
      localIncomeTax: 3_000,
    });
    expect(JSON.stringify(s)).not.toContain('8501012345678');
    expect(s.business.totals).toEqual({ persons: 2, paidAmount: 1_500_000, incomeTax: 45_000, localIncomeTax: 4_500 });
    expect(s.business.due).toMatchObject({ cycle: 'monthly', dueDate: '2026-11-02' });
    expect(s.warnings).toEqual(
      expect.arrayContaining(['직원B2: 주민(외국인)등록번호 미등록 — 제출 전 등록 필요', '직원B2: 사업소득 업종코드 미등록']),
    );
  });

  it('근로소득 행: 2026년은 반기 — 근무기간을 반기·입퇴사일로 제한', () => {
    const s = buildSimplifiedStatements(LINES, employees, '2026-09');
    expect(s.earned.due).toMatchObject({ cycle: 'semiannual', dueDate: '2027-02-01', submissionPeriod: { from: '2026-07', to: '2026-12' } });
    const byId = Object.fromEntries(s.earned.rows.map((r) => [r.employeeId, r]));
    expect(byId.E1).toMatchObject({ workPeriodFrom: '2026-08-10', workPeriodTo: '2026-12-31', taxablePay: 3_000_000, nonTaxablePay: 200_000 });
    expect(byId.E3).toMatchObject({ workPeriodFrom: '2026-07-01', workPeriodTo: '2026-11-20' });
    expect(s.earned.totals.paidAmount).toBe(9_700_000);
    expect(s.warnings.some((w) => w.includes('반기 제출'))).toBe(true);
  });

  it('근로소득 2027년 지급분: 매월 + 재확인 경고', () => {
    const s = buildSimplifiedStatements([pl('E2', 'earned', 2_500_000, { paymentDate: '2027-01-25' })], employees, '2027-01');
    expect(s.earned.due.cycle).toBe('monthly');
    expect(s.earned.rows[0]).toMatchObject({ workPeriodFrom: '2027-01-01', workPeriodTo: '2027-01-31' });
    expect(s.warnings).toContain('근로소득 간이지급명세서 월별 제출은 2026년 세법개정 결과 재확인 필요');
  });

  it('일용근로 행: 근무일수·과세·세액, 매월 제출', () => {
    const s = buildSimplifiedStatements(LINES, employees, '2026-09');
    expect(s.daily.rows).toEqual([
      expect.objectContaining({ employeeId: 'D1', workDays: 5, taxablePay: 1_000_000, incomeTax: 6_750, localIncomeTax: 670 }),
      expect.objectContaining({ employeeId: 'D2', workDays: 1, taxablePay: 187_000, incomeTax: 0 }),
    ]);
    expect(s.daily.due).toMatchObject({ cycle: 'monthly', dueDate: '2026-11-02' });
    expect(s.daily.label).toBe('일용근로소득 지급명세서');
  });

  it('마스터 없는 직원·사업소득 세액 불일치·일용 근무일수 누락 경고', () => {
    const s = buildSimplifiedStatements(
      [pl('X1', 'business', 100_000, { incomeTax: 0 }), pl('D9', 'daily', 300_000)],
      [],
      '2026-09',
    );
    expect(s.warnings).toEqual(
      expect.arrayContaining([
        '직원X1: 직원 마스터 없음 — 인적사항 확인 필요',
        '직원X1: 사업소득세 입력 0원 ≠ 계산 3,000원',
        '직원D9: 일용직 근무일수 미입력',
      ]),
    );
    expect(s.business.rows[0]!.idNumberMasked).toBeNull();
  });

  it('반기 합산 (aggregateEarnedStatementRows)', () => {
    const jul = buildSimplifiedStatements([pl('E2', 'earned', 2_500_000, { paymentDate: '2026-07-25' })], employees, '2026-07').earned.rows;
    const aug = buildSimplifiedStatements([pl('E2', 'earned', 2_600_000, { paymentDate: '2026-08-25', nonTaxablePay: 100_000 })], employees, '2026-08').earned.rows;
    const agg = aggregateEarnedStatementRows([...jul, ...aug]);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ taxablePay: 5_100_000, nonTaxablePay: 100_000, paymentPeriod: '2026-08' });
  });

  it('safeMaskedId', () => {
    expect(safeMaskedId('900101-1******')).toBe('900101-1******');
    expect(safeMaskedId('900101-1234567')).toBe('900101-1******');
    expect(safeMaskedId(null)).toBeNull();
  });
});

describe('리뷰 보완 — 주민번호 마스킹 (부분 원문 노출 차단)', () => {
  it('부분 마스킹·자릿수 이상 입력도 뒷자리 첫 자리 이후는 노출하지 않음', () => {
    expect(safeMaskedId('900101-12345**')).toBe('900101-1******');
    expect(safeMaskedId('900101-123456')).toBe('900101-1******');
    expect(safeMaskedId('9001011******')).toBe('900101-1******');
    expect(safeMaskedId(' 900101 - 1234567 ')).toBe('900101-1******');
    expect(safeMaskedId('900101-*******')).toBe('900101-*******');
    expect(safeMaskedId('900101')).toBe('900101-*******');
    // 앞자리가 가려진 경우: 뒷자리 숫자를 앞자리로 오인해 내보내지 않음
    expect(safeMaskedId('******-1234567')).toBe('******-*******');
    expect(safeMaskedId('unknown')).toBe('******-*******');
  });
  it('지급명세서 결과 JSON 에 원문 뒷자리가 남지 않음', () => {
    const s = buildSimplifiedStatements(
      [pl('B1', 'business', 1_000_000, { incomeTax: 30_000, localIncomeTax: 3_000 })],
      [emp('B1', 'business', { businessIncomeCode: '940909', idNumberMasked: '850101-23456**' })],
      '2026-09',
    );
    expect(s.business.rows[0]!.idNumberMasked).toBe('850101-2******');
    expect(JSON.stringify(s)).not.toContain('23456');
  });
});

describe('리뷰 보완 — 신고 요약의 조용한 누락 방지', () => {
  it('일용 근무일수 누락·지급총액 불일치·근로소득세 0원 → 경고', () => {
    const r = buildWithholdingReturn(
      [
        pl('D1', 'daily', 600_000, { incomeTax: 0 }),
        pl('E1', 'earned', 3_000_000, { grossPay: 3_100_000, incomeTax: 74_350, localIncomeTax: 7_430 }),
        pl('E2', 'earned', 3_000_000, { incomeTax: 0 }),
      ],
      '2026-09',
    );
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        '직원D1: 일용직 근무일수가 없어 세액을 계산할 수 없습니다',
        '직원E1: 지급총액 3,100,000원 ≠ 과세 3,000,000원 + 비과세 0원',
        expect.stringMatching(/^직원E2: 과세급여 3,000,000원인데 소득세 0원/),
      ]),
    );
  });

  it('정수가 아닌 금액 행은 합계에서 제외하고 excludedLines·경고로 명시 (예외로 중단하지 않음)', () => {
    const r = buildWithholdingReturn(
      [pl('B1', 'business', 1_000_000, { incomeTax: 30_000, localIncomeTax: 3_000 }), pl('B2', 'business', 500_000.5, { incomeTax: 15_000, localIncomeTax: 1_500 })],
      '2026-09',
    );
    expect(r.total).toMatchObject({ persons: 1, totalPay: 1_000_000, incomeTax: 30_000 });
    expect(Number.isSafeInteger(r.total.totalPay)).toBe(true);
    expect(r.excludedLines).toEqual([{ employeeId: 'B2', name: '직원B2', reason: '원 단위 정수가 아닌 금액(taxablePay, grossPay)' }]);
    expect(r.warnings[0]).toContain('금액 형식 오류 1건 집계 제외');
    const s = buildSimplifiedStatements([pl('B2', 'business', 500_000.5)], [], '2026-09');
    expect(s.business.rows).toEqual([]);
    expect(s.excludedLines).toHaveLength(1);
  });

  it('의료보건용역(personalService=false) 소액 사업소득은 0원이 정상 → 불일치 경고 없음', () => {
    const lines = [pl('B1', 'business', 20_000, { incomeTax: 0 })];
    expect(buildWithholdingReturn(lines, '2026-09').warnings.some((w) => w.includes('계산 600원'))).toBe(true);
    expect(buildWithholdingReturn(lines, '2026-09', { personalService: false }).warnings).toEqual([]);
    expect(buildSimplifiedStatements(lines, [emp('B1', 'business', { businessIncomeCode: '851101' })], '2026-09', { personalService: false }).warnings).toEqual([]);
  });

  it('간이지급명세서: 지급연월 밖 지급일·근무기간 역전 경고', () => {
    const s = buildSimplifiedStatements(
      [pl('E1', 'earned', 3_000_000, { incomeTax: 74_350, localIncomeTax: 7_430, paymentDate: '2026-10-05' })],
      [emp('E1', 'earned', { resignDate: '2026-06-30' })],
      '2026-09',
    );
    expect(s.warnings).toEqual(
      expect.arrayContaining(['지급일이 지급연월(2026-09)과 다른 내역 1건 — 지급연월 확인', expect.stringContaining('근무기간 역전(2026-07-01 > 2026-06-30)')]),
    );
  });

  it('성능: 10,000행 집계', () => {
    const lines = Array.from({ length: 10_000 }, (_, i) =>
      i % 3 === 0
        ? pl(`B${i}`, 'business', 1_000_000, { incomeTax: 30_000, localIncomeTax: 3_000 })
        : i % 3 === 1
          ? pl(`D${i}`, 'daily', 1_000_000, { workDays: 5, incomeTax: 6_750, localIncomeTax: 670 })
          : pl(`E${i}`, 'earned', 3_000_000, { incomeTax: 74_350, localIncomeTax: 7_430 }),
    );
    const t0 = performance.now();
    const r = buildWithholdingReturn(lines, '2026-09');
    const s = buildSimplifiedStatements(lines, [], '2026-09');
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(r.total.persons).toBe(10_000);
    expect(r.total.incomeTax).toBe(3_334 * 30_000 + 3_333 * 6_750 + 3_333 * 74_350);
    expect(s.business.rows).toHaveLength(3_334);
  });
});
