import { describe, expect, it } from 'vitest';
import {
  checkAccountSpikes,
  checkDeemedInputTax,
  checkFixedAssetPurchases,
  checkMonthlyTotals,
  checkNewAccounts,
  checkNonDeductibleShift,
  checkSalesOmission,
  checkSeriesSpikes,
  checkSourceGaps,
  detectNewAccounts,
  mergeReviewParams,
  priorMonths,
  REVIEW_PARAMS,
  reviewHref,
  runAnomalyDetection,
  runLedgerReview,
  sourceCountLabel,
} from './review';
import { HeuristicProvider } from './heuristic';
import type { LedgerReviewInput, MonthlyLedgerSummary, SourceCounts, VatPeriodReviewInput } from './types';

const CID = 'c1';
const PERIOD = '2026-09';

function month(period: string, sales: number, purchases: number, accounts: Record<string, [string, number]> = {}): MonthlyLedgerSummary {
  return {
    period,
    sales,
    purchases,
    byAccount: Object.fromEntries(Object.entries(accounts).map(([code, [name, total]]) => [code, { name, total }])),
  };
}

function ledger(monthly: MonthlyLedgerSummary[], over: Partial<LedgerReviewInput> = {}): LedgerReviewInput {
  return { clientId: CID, clientName: '(주)테스트', industry: 'restaurant', period: PERIOD, monthly, ...over };
}

function vat(over: Partial<VatPeriodReviewInput> = {}): VatPeriodReviewInput {
  return { label: '2026년 2기 예정', vatType: 'general', deemedInputTaxEligible: true, ...over };
}

describe('1. 전월 대비 매출/매입', () => {
  it('매입 +47% vs 매출 +12% → 매입 급증 확인', () => {
    const r = checkMonthlyTotals(ledger([month('2026-08', 50_000_000, 32_000_000), month(PERIOD, 56_000_000, 47_040_000)]));
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      code: 'REV-PURCHASE-SPIKE',
      clientId: CID,
      title: '매입 급증 확인',
      detail:
        '전월 대비 매입 +47% (3,200만원 → 4,704만원), 매출 +12% (5,000만원 → 5,600만원). 매입 증가가 매출보다 35%p 큽니다. 재고·자산 매입, 선급 거래, 중복 입력 여부를 확인하세요.',
      severity: 'warning',
      metric: { current: 47_040_000, baseline: 32_000_000, changeRate: 47 },
      action: { label: '매입 거래 보기', href: '/inbox?client=c1&period=2026-09&direction=purchase' },
    });
  });

  it('매입·매출이 같이 늘면 급증으로 보지 않는다', () => {
    expect(checkMonthlyTotals(ledger([month('2026-08', 50_000_000, 32_000_000), month(PERIOD, 75_000_000, 47_040_000)]))).toEqual([]);
  });

  it('매입 +100% 이상이면 high', () => {
    const r = checkMonthlyTotals(ledger([month('2026-08', 50_000_000, 10_000_000), month(PERIOD, 50_000_000, 21_000_000)]));
    expect(r[0]).toMatchObject({ code: 'REV-PURCHASE-SPIKE', severity: 'high' });
  });

  it('매출 급감 → 매출 누락 확인 (-35% warning / -65% high)', () => {
    const w = checkMonthlyTotals(ledger([month('2026-08', 50_000_000, 30_000_000), month(PERIOD, 32_500_000, 30_000_000)]));
    expect(w.map((a) => a.code)).toEqual(['REV-SALES-DROP']);
    expect(w[0]!.severity).toBe('warning');
    expect(w[0]!.detail).toBe('전월 대비 매출 -35% (5,000만원 → 3,250만원). 카드·현금영수증 매출 누락이나 기간 귀속 오류가 없는지 확인하세요.');
    const h = checkMonthlyTotals(ledger([month('2026-08', 50_000_000, 30_000_000), month(PERIOD, 17_500_000, 30_000_000)]));
    expect(h.find((a) => a.code === 'REV-SALES-DROP')?.severity).toBe('high');
  });

  it('매출 급증 + 매입 정체 → 매입 증빙 누락 안내 (info)', () => {
    const r = checkMonthlyTotals(ledger([month('2026-08', 40_000_000, 20_000_000), month(PERIOD, 64_000_000, 21_000_000)]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: 'REV-SALES-SPIKE', severity: 'info', metric: { changeRate: 60 } });
    expect(r[0]!.detail).toContain('매입 증빙 누락');
  });

  it('매입 급감 (info)', () => {
    const r = checkMonthlyTotals(ledger([month('2026-08', 40_000_000, 20_000_000), month(PERIOD, 40_000_000, 10_000_000)]));
    expect(r.map((a) => [a.code, a.severity])).toEqual([['REV-PURCHASE-DROP', 'info']]);
  });

  it('전월 자료가 없거나 소액이면 판단하지 않는다', () => {
    expect(checkMonthlyTotals(ledger([month(PERIOD, 56_000_000, 47_000_000)]))).toEqual([]);
    expect(checkMonthlyTotals(ledger([month('2026-08', 500_000, 500_000), month(PERIOD, 5_000_000, 5_000_000)]))).toEqual([]);
  });

  it('임계값은 REVIEW_PARAMS 로 조정한다', () => {
    const params = mergeReviewParams({ totals: { purchaseSpikeRate: 60 } });
    expect(params.totals.divergenceGap).toBe(REVIEW_PARAMS.totals.divergenceGap);
    expect(checkMonthlyTotals(ledger([month('2026-08', 50_000_000, 32_000_000), month(PERIOD, 56_000_000, 47_040_000)]), params)).toEqual([]);
  });
});

describe('2. 계정 3개월 평균 대비', () => {
  const history = [
    month('2026-06', 0, 0, { '813': ['접대비(기업업무추진비)', 2_400_000], '830': ['소모품비', 500_000] }),
    month('2026-07', 0, 0, { '813': ['접대비(기업업무추진비)', 2_200_000], '830': ['소모품비', 400_000] }),
    month('2026-08', 0, 0, { '813': ['접대비(기업업무추진비)', 2_600_000], '830': ['소모품비', 600_000] }),
  ];

  it('접대비 240만 → 890만', () => {
    const r = checkAccountSpikes(
      ledger([...history, month(PERIOD, 0, 0, { '813': ['접대비(기업업무추진비)', 8_900_000], '830': ['소모품비', 700_000] })]),
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      code: 'REV-ACCOUNT-SPIKE',
      clientId: CID,
      title: '접대비(기업업무추진비) 급증',
      detail: '접대비(기업업무추진비)(813) 3개월 평균 240만원 → 이번달 890만원 (3.7배, +650만원). 거래 내용과 계정 분류를 확인하세요.',
      severity: 'high',
      metric: { current: 8_900_000, baseline: 2_400_000, changeRate: 270.8 },
      action: { label: '접대비(기업업무추진비) 거래 보기', href: '/inbox?client=c1&period=2026-09&bucket=spike&account=813' },
    });
  });

  it('2배 이상 3배 미만이면 warning, 소액(100만원 미만)은 무시', () => {
    const r = checkAccountSpikes(
      ledger([...history, month(PERIOD, 0, 0, { '813': ['접대비(기업업무추진비)', 5_000_000], '830': ['소모품비', 990_000] })]),
    );
    expect(r.map((a) => [a.metric?.current, a.severity])).toEqual([[5_000_000, 'warning']]);
  });

  it('과거 1개월만 있으면 "전월" 로 표기', () => {
    const r = checkAccountSpikes(
      ledger([month('2026-08', 0, 0, { '822': ['차량유지비', 800_000] }), month(PERIOD, 0, 0, { '822': ['차량유지비', 2_000_000] })]),
    );
    expect(r[0]!.detail).toBe('차량유지비(822) 전월 80만원 → 이번달 200만원 (2.5배, +120만원). 거래 내용과 계정 분류를 확인하세요.');
  });

  it('결제·대체 계정(보통예금 등)은 제외', () => {
    const r = checkAccountSpikes(
      ledger([month('2026-08', 0, 0, { '103': ['보통예금', 1_000_000] }), month(PERIOD, 0, 0, { '103': ['보통예금', 9_000_000] })]),
    );
    expect(r).toEqual([]);
  });

  it('과거 월 누락은 평균에서 빼고, 과거 월에 계정이 없으면 0 으로 본다', () => {
    // 07 요약 없음 → 06·08 두 달 평균 (0 + 3,000,000)/2 = 150만원
    const r = checkAccountSpikes(
      ledger([
        month('2026-06', 0, 0, {}),
        month('2026-08', 0, 0, { '831': ['지급수수료', 3_000_000] }),
        month(PERIOD, 0, 0, { '831': ['지급수수료', 4_500_000] }),
      ]),
    );
    expect(r[0]!.detail).toContain('2개월 평균 150만원 → 이번달 450만원 (3배');
  });
});

describe('3. 신규 계정', () => {
  const hist = [month('2026-07', 0, 0, { '811': ['복리후생비', 300_000] }), month('2026-08', 0, 0, { '811': ['복리후생비', 300_000] })];

  it('차량유지비 신규 → 차량등록정보 확인', () => {
    const input = ledger([...hist, month(PERIOD, 0, 0, { '811': ['복리후생비', 300_000], '822': ['차량유지비', 450_000] })]);
    expect(detectNewAccounts(input)).toEqual(['822']);
    const r = checkNewAccounts(input);
    expect(r).toEqual([
      {
        code: 'REV-NEW-ACCOUNT',
        clientId: CID,
        title: '차량유지비 신규 발생',
        detail:
          '차량유지비(822)이(가) 이번 달 처음 발생했습니다 (45만원). 차량등록정보(차종·정원·배기량)를 확인하세요. 개별소비세 과세 승용차면 매입세액 불공제·운행기록부 대상입니다.',
        severity: 'warning',
        action: { label: '차량 관련 거래 확인', href: '/inbox?client=c1&period=2026-09&bucket=vehicle&account=822' },
      },
    ]);
  });

  it('newAccounts 를 직접 주면 그대로 쓴다 (금액 기준 없음), 급여는 급여 화면으로', () => {
    const input = ledger([...hist, month(PERIOD, 0, 0, { '801': ['급여', 10_000] })], { newAccounts: ['801', '801', '134'] });
    const r = checkNewAccounts(input);
    expect(r.map((a) => [a.title, a.severity, a.action?.href])).toEqual([
      ['급여 신규 발생', 'warning', '/payroll/c1/2026-09'],
      ['가지급금 신규 발생', 'high', '/inbox?client=c1&period=2026-09&bucket=personal_use&account=134'],
    ]);
  });

  it('고정자산 계정 기본 후속조치, 모르는 계정은 info', () => {
    const input = ledger([...hist, month(PERIOD, 0, 0, { '212': ['비품', 3_000_000], '848': ['잡비', 60_000] })]);
    const r = checkNewAccounts(input);
    expect(r.map((a) => [a.title, a.severity])).toEqual([
      ['비품 신규 발생', 'warning'],
      ['잡비 신규 발생', 'info'],
    ]);
    expect(r[0]!.action?.href).toContain('bucket=possible_asset');
  });

  it('과거 자료가 없으면 신규 판단을 하지 않고, 소액(5만원 미만)은 무시', () => {
    expect(detectNewAccounts(ledger([month(PERIOD, 0, 0, { '822': ['차량유지비', 450_000] })]))).toEqual([]);
    expect(detectNewAccounts(ledger([...hist, month(PERIOD, 0, 0, { '822': ['차량유지비', 40_000] })]))).toEqual([]);
  });
});

describe('4. 원천 vs 처리 건수', () => {
  it('세금계산서 매입 위멤버스 192건 vs 처리 190건 → 미처리 2건', () => {
    const r = checkSourceGaps(CID, PERIOD, { wemembers: { 'tax_invoice:purchase': 192, card: 50 }, processed: { 'tax_invoice:purchase': 190, card: 50 } });
    expect(r).toEqual([
      {
        code: 'REV-SOURCE-GAP',
        clientId: CID,
        title: '세금계산서 매입 미처리 2건',
        detail: '세금계산서 매입 위멤버스 192건 vs 처리 190건 → 미처리 2건 확인. 정규화 실패·중복 제외·수집 누락 여부를 확인하세요.',
        severity: 'warning',
        metric: { current: 190, baseline: 192, changeRate: -1 },
        action: { label: '미처리 자료 확인', href: '/imports?client=c1&period=2026-09&evidence=tax_invoice&direction=purchase' },
      },
    ]);
  });

  it('차이 10건 이상 high, 처리 건수 초과도 알린다', () => {
    const r = checkSourceGaps(CID, PERIOD, { wemembers: { card: 300, cash_receipt: 10 }, processed: { card: 280, cash_receipt: 12 } });
    expect(r.map((a) => [a.code, a.title, a.severity])).toEqual([
      ['REV-SOURCE-GAP', '카드 미처리 20건', 'high'],
      ['REV-SOURCE-EXCESS', '현금영수증 처리 건수 초과 2건', 'warning'],
    ]);
  });

  it('라벨', () => {
    expect(sourceCountLabel('invoice_exempt:sales')).toBe('계산서 매출');
    expect(sourceCountLabel('bank')).toBe('통장');
  });
});

describe('5. 부가세 과세기간', () => {
  it('매출 누락 가능성: 카드매출 원천 5,500만원 vs 반영 5,120만원', () => {
    const r = checkSalesOmission(CID, PERIOD, vat({ cardSales: { source: 55_000_000, reported: 51_200_000 } }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: 'VAT-SALES-OMISSION', title: '매출 누락 가능성', severity: 'warning' });
    expect(r[0]!.detail).toBe(
      '2026년 2기 예정 신용카드 매출 원천자료 5,500만원 vs 장부 반영 5,120만원 → 380만원(6.9%) 적게 반영되었습니다. 매출 누락·기간 귀속을 확인하세요.',
    );
    expect(r[0]!.action?.href).toBe('/inbox?client=c1&period=2026-09&direction=sales&evidence=card');
  });

  it('매출 차이가 작으면 무시, 과다 반영은 info, 10% 이상 누락은 high', () => {
    expect(checkSalesOmission(CID, PERIOD, vat({ cardSales: { source: 55_000_000, reported: 54_950_000 } }))).toEqual([]);
    const r = checkSalesOmission(
      CID,
      PERIOD,
      vat({ cardSales: { source: 10_000_000, reported: 12_000_000 }, cashReceiptSales: { source: 5_000_000, reported: 4_000_000 } }),
    );
    expect(r.map((a) => [a.code, a.severity])).toEqual([
      ['VAT-SALES-EXCESS', 'info'],
      ['VAT-SALES-OMISSION', 'high'],
    ]);
  });

  it('불공제 비율 8% → 27% (+19%p)', () => {
    const r = checkNonDeductibleShift(
      CID,
      PERIOD,
      vat({ inputVat: { current: { deductible: 1_095_000, nonDeductible: 405_000 }, previous: { deductible: 920_000, nonDeductible: 80_000 } } }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe('불공제 비율 급변');
    expect(r[0]!.detail).toContain('직전 기간 8% → 이번 기간 27% (+19%p)로 늘었습니다');
    expect(r[0]!.metric).toEqual({ current: 27, baseline: 8, changeRate: 19 });
    expect(r[0]!.action?.href).toContain('bucket=vat_review');
  });

  it('불공제 비율 변화가 작거나 직전 기간이 없으면 무시', () => {
    expect(
      checkNonDeductibleShift(CID, PERIOD, vat({ inputVat: { current: { deductible: 900_000, nonDeductible: 100_000 }, previous: { deductible: 950_000, nonDeductible: 50_000 } } })),
    ).toEqual([]);
    expect(checkNonDeductibleShift(CID, PERIOD, vat({ inputVat: { current: { deductible: 0, nonDeductible: 900_000 } } }))).toEqual([]);
  });

  it('고정자산 매입: 자산 계정 매입은 금액과 무관하게 모두 집계, 100만원 이하는 즉시상각 가능 안내, 조기환급 문구', () => {
    const r = checkFixedAssetPurchases(
      CID,
      PERIOD,
      vat({
        fixedAssetPurchases: [
          { accountCode: '206', accountName: '기계장치', merchantName: '(주)대성기계', supplyAmount: 12_000_000, vatAmount: 1_200_000, evidenceType: 'tax_invoice', date: '2026-09-03' },
          { accountCode: '212', accountName: '비품', merchantName: '하이마트', supplyAmount: 1_000_000, vatAmount: 100_000, evidenceType: 'card', date: '2026-09-10' },
        ],
      }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe('고정자산 매입 2건');
    expect(r[0]!.metric).toEqual({ current: 13_000_000, baseline: 0, changeRate: 0 });
    expect(r[0]!.detail).toBe(
      '2026년 2기 예정 고정자산 매입 2건 공급가액 1,300만원(세액 130만원): 2026-09-03 (주)대성기계 기계장치 1,200만원, 2026-09-10 하이마트 비품 100만원. 신고서 고정자산매입분 구분과 건물등감가상각자산취득명세서 작성을 확인하세요. 이 중 1건(100만원)은 거래단위 100만원 이하로 즉시상각(비용 처리)도 가능합니다. 자산으로 유지하면 고정자산매입분에 포함하세요. 사업설비 취득분은 조기환급 대상인지도 검토하세요.',
    );
  });

  it('고정자산 매입: 소액만 있어도 누락하지 않고, 반품(음수)은 순액 반영, 0원은 무시', () => {
    const r = checkFixedAssetPurchases(
      CID,
      PERIOD,
      vat({
        fixedAssetPurchases: [
          { accountCode: '212', accountName: '비품', merchantName: '오피스가구', supplyAmount: 800_000, vatAmount: 80_000, evidenceType: 'tax_invoice', date: '2026-08-01' },
          { accountCode: '212', accountName: '비품', merchantName: '오피스가구', supplyAmount: -300_000, vatAmount: -30_000, evidenceType: 'tax_invoice', date: '2026-08-05' },
          { accountCode: '212', accountName: '비품', merchantName: '무상', supplyAmount: 0, vatAmount: 0, evidenceType: 'other', date: '2026-08-06' },
        ],
      }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe('고정자산 매입 2건');
    expect(r[0]!.detail).toContain('공급가액 50만원(세액 50,000원)');
    expect(r[0]!.detail).toContain('-30만원');
    expect(r[0]!.detail).not.toContain('조기환급');
    expect(checkFixedAssetPurchases(CID, PERIOD, vat({ fixedAssetPurchases: [] }))).toEqual([]);
  });

  describe('의제매입', () => {
    const exemptPurchases = [
      { merchantName: '농협하나로마트', amount: 1_200_000, evidenceType: 'invoice_exempt' as const },
      { merchantName: '대박상회', description: '쌀 20kg', amount: 300_000, evidenceType: 'card' as const },
      { merchantName: '정육도매', amount: 500_000, evidenceType: 'bank' as const }, // 증빙 없음 → 제외
      { merchantName: '수협', amount: 700_000, evidenceType: 'invoice_exempt' as const, claimedAsDeemed: true }, // 이미 반영
      { merchantName: '문구센터', amount: 900_000, evidenceType: 'invoice_exempt' as const }, // 농산물 아님
    ];

    it('대상 업종·일반과세 → 의제매입 검토 2건 150만원', () => {
      const r = checkDeemedInputTax(CID, PERIOD, 'restaurant', vat({ exemptPurchases }));
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ code: 'VAT-DEEMED-CANDIDATE', title: '의제매입세액공제 검토', severity: 'warning', metric: { current: 1_500_000 } });
      expect(r[0]!.detail).toContain('면세 농·축·수산물 매입 2건 150만원');
      expect(r[0]!.detail).toContain('8/108');
      expect(r[0]!.detail).toContain('9/109');
    });

    it('간이과세자 → 의제매입 불가 안내', () => {
      const r = checkDeemedInputTax(CID, PERIOD, 'restaurant', vat({ vatType: 'simplified', exemptPurchases }));
      expect(r.map((a) => a.code)).toEqual(['VAT-DEEMED-SIMPLIFIED']);
      expect(r[0]!.detail).toContain('2021-07-01');
    });

    it('대상 업종인데 설정이 꺼져 있으면 설정 확인, 면세사업자·비대상 업종은 없음', () => {
      expect(checkDeemedInputTax(CID, PERIOD, 'restaurant', vat({ deemedInputTaxEligible: false, exemptPurchases })).map((a) => a.code)).toEqual([
        'VAT-DEEMED-SETTING',
      ]);
      expect(checkDeemedInputTax(CID, PERIOD, 'it_service', vat({ deemedInputTaxEligible: false, exemptPurchases }))).toEqual([]);
      expect(checkDeemedInputTax(CID, PERIOD, 'academy', vat({ vatType: 'exempt', exemptPurchases }))).toEqual([]);
    });
  });
});

describe('6. 시계열 · 조합', () => {
  it('거래처별 시계열 급증', () => {
    const r = checkSeriesSpikes(CID, PERIOD, [
      {
        key: 'merchant:coupang',
        label: '쿠팡 매입',
        points: [
          { period: '2026-06', value: 1_000_000 },
          { period: '2026-07', value: 1_200_000 },
          { period: '2026-08', value: 800_000 },
          { period: PERIOD, value: 4_000_000 },
        ],
      },
      { key: 'flat', label: '평탄', points: [{ period: '2026-08', value: 1_000_000 }, { period: PERIOD, value: 1_100_000 }] },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: 'ANOM-SERIES-SPIKE', title: '쿠팡 매입 급증', severity: 'high' });
    expect(r[0]!.detail).toBe('쿠팡 매입 3개월 평균 100만원 → 이번달 400만원 (4배, +300만원).');
    expect(r[0]!.action?.href).toBe('/inbox?client=c1&period=2026-09&bucket=spike');
  });

  it('runLedgerReview: 심각도 순 정렬 + 전체 검사', async () => {
    const input = ledger(
      [
        month('2026-06', 50_000_000, 30_000_000, { '813': ['접대비(기업업무추진비)', 2_400_000] }),
        month('2026-07', 50_000_000, 30_000_000, { '813': ['접대비(기업업무추진비)', 2_200_000] }),
        month('2026-08', 50_000_000, 32_000_000, { '813': ['접대비(기업업무추진비)', 2_600_000] }),
        month(PERIOD, 56_000_000, 47_040_000, { '813': ['접대비(기업업무추진비)', 8_900_000], '822': ['차량유지비', 450_000] }),
      ],
      {
        sourceCounts: { wemembers: { 'tax_invoice:purchase': 192 }, processed: { 'tax_invoice:purchase': 190 } },
        vat: vat({ cardSales: { source: 55_000_000, reported: 51_200_000 } }),
      },
    );
    const r = await new HeuristicProvider().reviewLedger(input);
    expect(r.map((a) => [a.code, a.severity])).toEqual([
      ['REV-ACCOUNT-SPIKE', 'high'],
      ['REV-PURCHASE-SPIKE', 'warning'],
      ['REV-NEW-ACCOUNT', 'warning'],
      ['REV-SOURCE-GAP', 'warning'],
      ['VAT-SALES-OMISSION', 'warning'],
    ]);
    expect(r.every((a) => a.clientId === CID)).toBe(true);
    expect(runLedgerReview(input)).toEqual(r);
  });

  it('runAnomalyDetection / HeuristicProvider.detectAnomaly', async () => {
    const input = {
      clientId: CID,
      period: PERIOD,
      industry: 'restaurant' as const,
      sourceCounts: { wemembers: { card: 5 }, processed: { card: 4 } },
    };
    const r = await new HeuristicProvider().detectAnomaly(input);
    expect(r.map((a) => a.code)).toEqual(['REV-SOURCE-GAP']);
    expect(runAnomalyDetection({ clientId: CID, period: PERIOD })).toEqual([]);
  });

  it('HeuristicProvider 는 생성 시 임계값을 덮어쓸 수 있다', async () => {
    const p = new HeuristicProvider({ reviewParams: { sourceGap: { tolerance: 5 } } });
    expect(await p.detectAnomaly({ clientId: CID, period: PERIOD, sourceCounts: { wemembers: { card: 5 }, processed: { card: 4 } } })).toEqual([]);
  });

  it('유틸: priorMonths / reviewHref', () => {
    expect(priorMonths('2026-02', 3)).toEqual(['2026-01', '2025-12', '2025-11']);
    expect(reviewHref('/inbox', { client: 'a b', bucket: undefined, period: '2026-09' })).toBe('/inbox?client=a+b&period=2026-09');
    expect(reviewHref('/clients/x', {})).toBe('/clients/x');
  });
});

describe('리뷰 보강 (검수)', () => {
  it('매출이 전월 비교 불가(소액)면 "매출보다 N%p" 비교 문구를 만들지 않는다', () => {
    const r = checkMonthlyTotals(ledger([month('2026-08', 0, 10_000_000), month(PERIOD, 3_000_000, 15_000_000)]));
    expect(r.map((a) => a.code)).toEqual(['REV-PURCHASE-SPIKE']);
    expect(r[0]!.detail).toBe(
      '전월 대비 매입 +50% (1,000만원 → 1,500만원), 매출은 전월 비교 불가. 재고·자산 매입, 선급 거래, 중복 입력 여부를 확인하세요.',
    );
    expect(r[0]!.detail).not.toContain('%p');
  });

  it('mergeReviewParams: undefined·null·문자열·NaN·모르는 키는 무시하고 기본값 유지', () => {
    const params = mergeReviewParams({
      totals: { purchaseSpikeRate: undefined, divergenceGap: null as unknown as number, minBaseline: '0' as unknown as number, highRate: Number.NaN },
      accountSpike: { ratio: 4 },
      bogus: { x: 1 },
    } as unknown as Parameters<typeof mergeReviewParams>[0]);
    expect(params.totals).toEqual(REVIEW_PARAMS.totals);
    expect(params.accountSpike.ratio).toBe(4);
    expect(params.accountSpike.minAmount).toBe(REVIEW_PARAMS.accountSpike.minAmount);
    expect((params as unknown as Record<string, unknown>).bogus).toBeUndefined();
    // 잘못된 설정으로도 검사가 꺼지지 않는다
    const r = checkMonthlyTotals(ledger([month('2026-08', 50_000_000, 32_000_000), month(PERIOD, 56_000_000, 47_040_000)]), params);
    expect(r.map((a) => a.code)).toEqual(['REV-PURCHASE-SPIKE']);
  });

  it('mergeReviewParams: followUps 는 키 단위 병합, 원본 REVIEW_PARAMS 는 바뀌지 않는다', () => {
    const before = JSON.stringify(REVIEW_PARAMS);
    const params = mergeReviewParams({ newAccount: { followUps: { '999': { check: '확인', actionLabel: '보기' } } } });
    expect(params.newAccount.followUps['999']).toEqual({ check: '확인', actionLabel: '보기' });
    expect(params.newAccount.followUps['822']).toEqual(REVIEW_PARAMS.newAccount.followUps['822']);
    expect(JSON.stringify(REVIEW_PARAMS)).toBe(before);
  });

  it('의제매입: 성씨 "김" 이 들어간 면세 매입(병원·학원)은 후보가 아니다, 마른김은 후보', () => {
    const r = checkDeemedInputTax(
      CID,
      PERIOD,
      'restaurant',
      vat({
        exemptPurchases: [
          { merchantName: '김안과의원', amount: 400_000, evidenceType: 'card' },
          { merchantName: '김철수수학학원', amount: 300_000, evidenceType: 'card' },
          { merchantName: '완도상회', description: '마른김 100속', amount: 200_000, evidenceType: 'invoice_exempt' },
        ],
      }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.detail).toContain('면세 농·축·수산물 매입 1건 20만원');
  });

  it('형식이 깨진 입력(monthly 누락·byAccount 누락·건수 한쪽 누락)에도 예외 없이 검토한다', () => {
    const broken = {
      clientId: CID,
      clientName: 'x',
      industry: 'service',
      period: PERIOD,
      monthly: [{ period: '2026-08', sales: 1, purchases: 1 }, { period: PERIOD, sales: 1, purchases: 1 }, { period: '2026/07', sales: 1, purchases: 1, byAccount: {} }],
      sourceCounts: { wemembers: { tax_invoice: 3 } },
    } as unknown as LedgerReviewInput;
    const r = runLedgerReview(broken);
    expect(r.map((a) => a.code)).toEqual(['REV-SOURCE-GAP']);
    expect(runLedgerReview({ ...broken, monthly: undefined } as unknown as LedgerReviewInput).map((a) => a.code)).toEqual(['REV-SOURCE-GAP']);
    expect(checkSourceGaps(CID, PERIOD, { wemembers: { card: Number.NaN }, processed: { card: 2 } } as unknown as SourceCounts).map((a) => a.code)).toEqual([
      'REV-SOURCE-EXCESS',
    ]);
  });
});
