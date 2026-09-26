import { formatBusinessNumber, type ExceptionBucket, type Won } from '@mintax/core';
import { SPIKE_CLIENT_CODE } from './clients';
import { makeAddress, makeBusinessNumber, makeCardApproval, makeEmail, makePersonName } from './ids';
import { cardPurchaseRaw, deductibleLabel, merchantTypeLabel } from './layouts';
import { rngFor, type Rng } from './prng';
import {
  CURRENT_MONTH,
  SPIKE_PLAN,
  buildPurchase,
  dateOf,
  finalizeInjected,
  merchantNamed,
  nextWeekday,
  type PurchaseParams,
  type TxContext,
  type TxDraft,
} from './transactions';
import type {
  AnomalyEntry,
  AnomalyKind,
  AnomalyManifest,
  LedgerAnomalyExpectation,
  MerchantKind,
  SyntheticClient,
  SyntheticFailureRow,
  SyntheticMerchant,
  SyntheticTransaction,
} from './types';

/**
 * 의도적 이상치 (2026-09 당월 자료에만 주입). 종류별 건수는 아래 ANOMALY_SPECS 가 문서이자 테스트 기준이다.
 * 모든 이상치 거래는 anomalies[] 와 truth.expectedBuckets 로 표시되어 엔진 회귀 검사에 쓸 수 있다.
 */
export const ANOMALY_SPECS: Readonly<Record<AnomalyKind, { count: number; label: string; description: string; clients: readonly string[] }>> = {
  exact_duplicate: {
    count: 7, label: '완전중복', clients: ['C001', 'C001', 'C004', 'C004', 'C009', 'C009', 'C012'],
    description: '같은 승인번호 거래가 Desktop Bridge 로 다시 들어옴 (fingerprint 동일) → duplicate 로 보관, 삭제 금지',
  },
  possible_duplicate: {
    count: 4, label: '중복 의심', clients: ['C003', 'C005', 'C013', 'C015'],
    description: '같은 날·같은 가맹점·같은 금액이지만 승인번호가 다른 별개 거래 → 중복 의심 버킷, 자동 중복처리 금지',
  },
  unclassifiable_merchant: {
    count: 6, label: '분류 불가 신규 가맹점', clients: ['C001', 'C006', 'C009', 'C011', 'C012', 'C020'],
    description: '가맹점 우주·이력에 없는 상호 + 업종 정보 없음',
  },
  asset_purchase: {
    count: 3, label: '고액 자산 구입', clients: ['C001', 'C012', 'C022'],
    description: '노트북 2,300,000원 등 100만원 이상 비품 구입 → 212 비품 (자산 가능성)',
  },
  entertainment: {
    count: 5, label: '접대 관련', clients: ['C011', 'C020', 'C009', 'C020', 'C006'],
    description: '골프장 2건, 유흥주점·단란주점·가라오케 3건 → 813 접대비, 매입세액 불공제',
  },
  personal_use: {
    count: 5, label: '개인사용 의심', clients: ['C001', 'C005', 'C013', 'C015', 'C009'],
    description: '주말 대형마트·백화점 결제 → 법인 134 가지급금 / 개인 338 인출금, 불공제',
  },
  foreign_saas: {
    count: 4, label: '해외 SaaS (USD)', clients: ['C001', 'C012', 'C022', 'C020'],
    description: '처음 보는 해외 SaaS 달러 결제 → 831 지급수수료, 부가세 무관 (일반전표)',
  },
  vat_mismatch: {
    count: 4, label: '부가세 오류', clients: ['C009', 'C011', 'C015', 'C003'],
    description: '세금계산서 세액 ≠ 공급가액의 10% (2건), 카드 공급가액+세액 ≠ 합계 (2건)',
  },
  new_merchant_high_amount: {
    count: 2, label: '신규 거래처 고액', clients: ['C004', 'C019'],
    description: '처음 보는 거래처의 수백만원 세금계산서',
  },
  account_spike: {
    count: 1, label: '계정 급증', clients: ['C004'],
    description: '접대비 3개월 평균 2,400,000원 → 이번달 8,900,000원 (거래 6건)',
  },
  parse_failure: {
    count: 1, label: '파싱 실패 행', clients: ['C009'],
    description: "카드 파일 합계 칸 '3,2OO' (숫자 0 대신 영문 O) → 정규화 실패로 남아야 함",
  },
  cancel_negative: {
    count: 3, label: '취소(음수)', clients: ['C001', 'C005', 'C015'],
    description: '당월 카드 2건·현금영수증 1건의 취소 — 금액 음수, 원거래 계정 그대로',
  },
  treatment_changed: {
    count: 1, label: '처리 변경', clients: ['C001'],
    description: '쿠팡: 이력은 소모품비(소액)였으나 이번 건은 1,450,000원 비품급 → 212 비품',
  },
  correction_target: {
    count: 4, label: '정정 대상 (시나리오 1)', clients: ['C002', 'C002', 'C002', 'C002'],
    description: '시나리오상사: 쿠팡 3건 정답 829 사무용품비(이력 830/829 혼재), 다이소 1건 정답 811 (이력 830)',
  },
};

export const ANOMALY_KINDS = Object.keys(ANOMALY_SPECS) as AnomalyKind[];

export interface AnomalyInjection {
  added: SyntheticTransaction[];
  failures: SyntheticFailureRow[];
  ledgerAnomalies: LedgerAnomalyExpectation[];
}

interface AdHocSpec {
  name: string;
  kind: MerchantKind;
  corporate: boolean;
  bizType: string;
  category: string;
  items?: string[];
}

function adHocMerchant(rng: Rng, spec: AdHocSpec, usedBusinessNumbers: Set<string>, usedNames: Set<string>): SyntheticMerchant {
  return {
    id: '',
    name: spec.name,
    brand: spec.name,
    kind: spec.kind,
    businessNumber: makeBusinessNumber(rng, spec.corporate ? 'corporation' : 'individual', usedBusinessNumbers),
    taxType: 'general',
    corporate: spec.corporate,
    bizType: spec.bizType,
    category: spec.category,
    evidence: 'card',
    foreign: false,
    currency: 'KRW',
    amount: { median: 100_000, sigma: 0.5, min: 1_000, max: 10_000_000, unit: 10 },
    items: spec.items ?? [],
    representativeName: makePersonName(rng, usedNames),
    address: makeAddress(rng),
    email: makeEmail(`new-${rng.int(1000, 9999)}`),
  };
}

/** 이상치 주입 — currentBase 는 변경하지 않고 새 거래만 만든다 */
export function injectAnomalies(
  ctx: TxContext,
  currentBase: readonly SyntheticTransaction[],
  usedBusinessNumbers: Set<string>,
  usedNames: Set<string>,
): AnomalyInjection {
  const clientByCode = new Map(ctx.clients.map((c) => [c.code, c]));
  const client = (code: string): SyntheticClient => {
    const c = clientByCode.get(code);
    if (!c) throw new Error(`알 수 없는 거래처: ${code}`);
    return c;
  };
  const baseByClient = new Map<string, SyntheticTransaction[]>();
  for (const t of currentBase) {
    const arr = baseByClient.get(t.clientCode) ?? [];
    arr.push(t);
    baseByClient.set(t.clientCode, arr);
  }
  const seqByClient = new Map<string, number>();
  const added: SyntheticTransaction[] = [];
  const push = (d: TxDraft): SyntheticTransaction => {
    const seq = (seqByClient.get(d.clientCode) ?? 0) + 1;
    seqByClient.set(d.clientCode, seq);
    const t = finalizeInjected(d, seq);
    added.push(t);
    return t;
  };
  const rngOf = (kind: string, code: string, i = 0) => rngFor(ctx.seed, 'anomaly', kind, code, i);
  const common = (c: SyntheticClient, rng: Rng) =>
    ({ client: c, period: CURRENT_MONTH, channel: 'hometax_file', status: 'imported', withRaw: true, rng }) as const;
  /** 이상치 원본 후보: 해당 거래처 당월 카드(또는 현금영수증) 매입, 양수, 국내 */
  const pickBase = (code: string, evidence: 'card' | 'cash_receipt', rng: Rng, exclude: Set<string>): SyntheticTransaction => {
    const pool = (baseByClient.get(code) ?? []).filter(
      (t) => t.direction === 'purchase' && t.evidenceType === evidence && t.totalAmount > 0 && !t.isForeign && t.anomalies.length === 0 && !exclude.has(t.id),
    );
    if (pool.length === 0) throw new Error(`${code}: 이상치 원본으로 쓸 ${evidence} 거래가 없습니다`);
    const t = rng.pick(pool);
    exclude.add(t.id);
    return t;
  };
  const used = new Set<string>();

  // 1) 완전중복 — 같은 승인번호가 다른 채널로 재수신
  ANOMALY_SPECS.exact_duplicate.clients.forEach((code, i) => {
    const orig = pickBase(code, 'card', rngOf('dup', code, i), used);
    const { id: _id, fingerprint: _fp, ...rest } = orig;
    push({
      ...rest,
      channel: 'desktop_bridge',
      rawData: { ...orig.rawData, 승인번호: orig.approvalNumber },
      truth: { ...orig.truth, expectedStatus: 'duplicate', duplicateOf: orig.id, expectedBuckets: ['duplicate'] },
      anomalies: ['exact_duplicate'],
      scenarioTags: [],
    });
  });

  // 2) 중복 의심 — 같은 날·가맹점·금액, 다른 승인번호 (실제로는 별개 거래)
  ANOMALY_SPECS.possible_duplicate.clients.forEach((code, i) => {
    const rng = rngOf('possible-dup', code, i);
    const orig = pickBase(code, 'card', rng, used);
    const { id: _id, fingerprint: _fp, ...rest } = orig;
    push({
      ...rest,
      approvalNumber: makeCardApproval(rng, ctx.approvals.get(code)!),
      rawData: { ...orig.rawData },
      truth: { ...orig.truth, possibleDuplicateOf: orig.id, expectedBuckets: ['duplicate'] },
      anomalies: ['possible_duplicate'],
      scenarioTags: [],
    });
  });

  // 3) 분류 불가 신규 가맹점
  const unknowns: Array<{ code: string; name: string; total: Won; account: string; corporate: boolean }> = [
    { code: 'C001', name: '(주)케이디엠에스', total: 187_000, account: '831', corporate: true },
    { code: 'C006', name: '엘엔제이트레이딩', total: 264_000, account: '830', corporate: false },
    { code: 'C009', name: '제이에스앤코', total: 99_000, account: '830', corporate: false },
    { code: 'C011', name: '(주)오로라엑스', total: 418_000, account: '831', corporate: true },
    { code: 'C012', name: '티에이치글로벌', total: 55_000, account: '831', corporate: false },
    { code: 'C020', name: '에이치엠피솔루션', total: 330_000, account: '831', corporate: false },
  ];
  unknowns.forEach((u, i) => {
    const rng = rngOf('unknown', u.code, i);
    const c = client(u.code);
    const m = adHocMerchant(rng, { name: u.name, kind: 'unknown', corporate: u.corporate, bizType: '', category: '' }, usedBusinessNumbers, usedNames);
    push(
      buildPurchase(ctx, {
        ...common(c, rng),
        date: nextWeekday(dateOf(CURRENT_MONTH, 4 + i * 3)),
        evidence: 'card',
        merchant: m,
        adHoc: true,
        total: u.total,
        card: c.cards[0],
        accountCode: u.account,
        anomalies: ['unclassifiable_merchant'],
        truthExtra: { expectedBuckets: ['new_merchant', 'unclassified'], note: '사람이 거래 내용 확인 후 확정한 계정' },
      }),
    );
  });

  // 4) 고액 자산 구입
  const assets: Array<{ code: string; merchant: string; evidence: 'card' | 'tax_invoice'; amount: Won; description: string; day: number }> = [
    { code: 'C001', merchant: '롯데하이마트 역삼점', evidence: 'card', amount: 2_300_000, description: '노트북', day: 9 },
    { code: 'C012', merchant: '삼성디지털프라자 판교점', evidence: 'tax_invoice', amount: 3_500_000, description: '서버 랙 장비', day: 14 },
    { code: 'C022', merchant: '전자랜드 가산점', evidence: 'card', amount: 1_980_000, description: '모니터 4대', day: 21 },
  ];
  assets.forEach((a, i) => {
    const rng = rngOf('asset', a.code, i);
    const c = client(a.code);
    push(
      buildPurchase(ctx, {
        ...common(c, rng),
        date: nextWeekday(dateOf(CURRENT_MONTH, a.day)),
        evidence: a.evidence,
        merchant: merchantNamed(ctx, a.merchant),
        ...(a.evidence === 'card' ? { total: a.amount, card: c.cards[0] } : { supply: a.amount }),
        description: a.description,
        accountCode: '212',
        anomalies: ['asset_purchase'],
        truthExtra: { expectedBuckets: ['possible_asset', 'high_amount'] },
      }),
    );
  });

  // 5) 접대 관련 (골프장·주점)
  const ents: Array<{ code: string; merchant: string; total: Won; serviceCharge?: Won; day: number }> = [
    { code: 'C011', merchant: '샘플힐스 골프클럽', total: 1_650_000, day: 5 },
    { code: 'C020', merchant: '레이크사이드CC 가상점', total: 2_280_000, day: 12 },
    { code: 'C009', merchant: '로얄 유흥주점', total: 1_280_000, serviceCharge: 120_000, day: 17 },
    { code: 'C020', merchant: '별빛 단란주점', total: 760_000, day: 18 },
    { code: 'C006', merchant: '샘플 가라오케', total: 540_000, day: 23 },
  ];
  ents.forEach((e, i) => {
    const rng = rngOf('ent', e.code, i);
    const c = client(e.code);
    push(
      buildPurchase(ctx, {
        ...common(c, rng),
        date: dateOf(CURRENT_MONTH, e.day),
        evidence: 'card',
        merchant: merchantNamed(ctx, e.merchant),
        total: e.total,
        serviceCharge: e.serviceCharge,
        card: c.cards[0],
        accountCode: '813',
        anomalies: ['entertainment'],
        truthExtra: { expectedBuckets: ['entertainment'] },
      }),
    );
  });

  // 6) 개인사용 의심 — 주말 마트·백화점
  const personal: Array<{ code: string; merchant: string; total: Won; day: number }> = [
    { code: 'C001', merchant: '신세계백화점 강남점', total: 486_000, day: 12 },
    { code: 'C005', merchant: '이마트 성수점', total: 238_400, day: 13 },
    { code: 'C013', merchant: '홈플러스 가산점', total: 156_800, day: 19 },
    { code: 'C015', merchant: '롯데마트 판교점', total: 187_300, day: 20 },
    { code: 'C009', merchant: '롯데백화점 본점', total: 920_000, day: 27 },
  ];
  personal.forEach((p, i) => {
    const rng = rngOf('personal', p.code, i);
    const c = client(p.code);
    push(
      buildPurchase(ctx, {
        ...common(c, rng),
        date: dateOf(CURRENT_MONTH, p.day),
        evidence: 'card',
        merchant: merchantNamed(ctx, p.merchant),
        total: p.total,
        card: c.cards[c.cards.length - 1],
        accountCode: c.businessType === 'corporation' ? '134' : '338',
        anomalies: ['personal_use'],
        truthExtra: { expectedBuckets: ['personal_use'], note: '주말 생활용품 결제 — 대표자 개인사용 확인' },
      }),
    );
  });

  // 7) 해외 SaaS (신규, USD)
  const foreign: Array<{ code: string; merchant: string; day: number }> = [
    { code: 'C001', merchant: 'FIGMA.COM', day: 2 },
    { code: 'C012', merchant: 'NOTION LABS INC', day: 7 },
    { code: 'C022', merchant: 'MIDJOURNEY INC', day: 15 },
    { code: 'C020', merchant: 'ZOOM.US', day: 24 },
  ];
  foreign.forEach((f, i) => {
    const rng = rngOf('foreign', f.code, i);
    const c = client(f.code);
    const m = merchantNamed(ctx, f.merchant);
    push(
      buildPurchase(ctx, {
        ...common(c, rng),
        date: dateOf(CURRENT_MONTH, f.day),
        evidence: 'card',
        merchant: m,
        total: m.amount.median,
        card: c.cards[0],
        accountCode: '831',
        anomalies: ['foreign_saas'],
        truthExtra: { expectedBuckets: ['foreign', 'new_merchant'] },
      }),
    );
  });

  // 8) 부가세 오류
  const vatErrs: Array<{ code: string; merchant: string; evidence: 'card' | 'tax_invoice'; supply: Won; vat: Won; total: Won; day: number; note: string }> = [
    { code: 'C009', merchant: '가나상사', evidence: 'tax_invoice', supply: 1_500_000, vat: 15_000, total: 1_515_000, day: 10, note: '세액이 공급가액의 1% (10% 아님)' },
    { code: 'C011', merchant: '대성정밀부품', evidence: 'tax_invoice', supply: 2_340_000, vat: 243_000, total: 2_583_000, day: 16, note: '세액 243,000 ≠ 공급가액 10% 234,000' },
    { code: 'C015', merchant: '롯데마트 판교점', evidence: 'card', supply: 45_455, vat: 4_545, total: 51_000, day: 8, note: '공급가액+세액 50,000 ≠ 합계 51,000' },
    { code: 'C003', merchant: '이마트 성수점', evidence: 'card', supply: 90_909, vat: 9_091, total: 99_000, day: 22, note: '공급가액+세액 100,000 ≠ 합계 99,000' },
  ];
  vatErrs.forEach((v, i) => {
    const rng = rngOf('vat', v.code, i);
    const c = client(v.code);
    const m = merchantNamed(ctx, v.merchant);
    const params: PurchaseParams = {
      ...common(c, rng),
      date: nextWeekday(dateOf(CURRENT_MONTH, v.day)),
      evidence: v.evidence,
      merchant: m,
      amounts: { supply: v.supply, vat: v.vat, serviceCharge: 0, total: v.total },
      card: c.cards[0],
      description: v.evidence === 'tax_invoice' ? m.items[0] : undefined,
      anomalies: ['vat_mismatch'],
      truthExtra: { expectedBuckets: ['vat_review'], note: v.note },
    };
    push(buildPurchase(ctx, params));
  });

  // 9) 신규 거래처 고액 (세금계산서)
  const newHigh: Array<{ code: string; name: string; supply: Won; account: string; item: string; category: string; day: number }> = [
    { code: 'C004', name: '(주)한결중장비', supply: 6_000_000, account: '819', item: '굴삭기 임차 (9월)', category: '건설장비 임대', day: 15 },
    { code: 'C019', name: '(주)동방기술산업', supply: 4_500_000, account: '831', item: '설비 설계 기술용역', category: '엔지니어링 서비스', day: 25 },
  ];
  newHigh.forEach((h, i) => {
    const rng = rngOf('new-high', h.code, i);
    const c = client(h.code);
    const m = adHocMerchant(rng, { name: h.name, kind: 'unknown', corporate: true, bizType: '서비스업', category: h.category, items: [h.item] }, usedBusinessNumbers, usedNames);
    push(
      buildPurchase(ctx, {
        ...common(c, rng),
        date: nextWeekday(dateOf(CURRENT_MONTH, h.day)),
        evidence: 'tax_invoice',
        merchant: m,
        adHoc: true,
        supply: h.supply,
        description: h.item,
        accountCode: h.account,
        anomalies: ['new_merchant_high_amount'],
        truthExtra: { expectedBuckets: ['new_merchant', 'high_amount'] },
      }),
    );
  });

  // 10) 계정 급증 — C004 접대비 890만원
  const spikeClient = client(SPIKE_CLIENT_CODE);
  const spikeIds: string[] = [];
  SPIKE_PLAN.current.forEach((s, i) => {
    const rng = rngOf('spike', SPIKE_CLIENT_CODE, i);
    const t = push(
      buildPurchase(ctx, {
        ...common(spikeClient, rng),
        date: nextWeekday(dateOf(CURRENT_MONTH, s.day)),
        evidence: 'card',
        merchant: merchantNamed(ctx, s.merchant),
        total: s.total,
        card: spikeClient.cards[0],
        accountCode: SPIKE_PLAN.accountCode,
        anomalies: ['account_spike'],
        truthExtra: { expectedBuckets: ['spike'] },
      }),
    );
    spikeIds.push(t.id);
  });
  const ledgerAnomalies: LedgerAnomalyExpectation[] = [
    {
      code: 'ACCOUNT_SPIKE',
      clientCode: SPIKE_CLIENT_CODE,
      accountCode: SPIKE_PLAN.accountCode,
      title: '접대비(기업업무추진비) 급증',
      baseline: SPIKE_PLAN.baseline3m,
      current: SPIKE_PLAN.currentTotal,
      transactionIds: spikeIds,
    },
  ];

  // 11) 취소(음수)
  const cancels: Array<{ code: string; evidence: 'card' | 'cash_receipt' }> = [
    { code: 'C001', evidence: 'card' },
    { code: 'C005', evidence: 'card' },
    { code: 'C015', evidence: 'cash_receipt' },
  ];
  cancels.forEach((x, i) => {
    const rng = rngOf('cancel', x.code, i);
    const c = client(x.code);
    const orig = pickBase(x.code, x.evidence, rng, used);
    const day = Math.min(Number(orig.transactionDate.slice(8)) + rng.int(1, 3), 30);
    const card = c.cards.find((k) => k.masked === orig.cardNumberMasked);
    push(
      buildPurchase(ctx, {
        ...common(c, rng),
        date: dateOf(CURRENT_MONTH, day),
        evidence: x.evidence,
        merchant: merchantNamed(ctx, orig.merchantName),
        amounts: { supply: -orig.supplyAmount, vat: -orig.vatAmount, serviceCharge: -orig.serviceCharge, total: -orig.totalAmount },
        card,
        cancel: true,
        approvalNumber: x.evidence === 'card' ? (orig.approvalNumber ?? undefined) : undefined,
        hint: orig.sourceDeductibleHint,
        description: orig.description,
        accountCode: orig.truth.accountCode,
        anomalies: ['cancel_negative'],
        truthExtra: { note: `취소 — 원거래 ${orig.id} 상쇄` },
      }),
    );
  });

  // 12) 처리 변경 — 쿠팡 소모품비 이력 → 비품급 금액
  {
    const rng = rngOf('treatment', 'C001');
    const c = client('C001');
    push(
      buildPurchase(ctx, {
        ...common(c, rng),
        date: nextWeekday(dateOf(CURRENT_MONTH, 18)),
        evidence: 'card',
        merchant: merchantNamed(ctx, '쿠팡'),
        total: 1_450_000,
        card: c.cards[0],
        accountCode: '212',
        anomalies: ['treatment_changed'],
        truthExtra: { expectedBuckets: ['changed_from_history', 'possible_asset', 'high_amount'], note: '모니터암·조명 세트 — 이력(소모품비)과 달리 비품' },
      }),
    );
  }

  // 13) 파싱 실패 행 — 합계 '3,2OO'
  const failures: SyntheticFailureRow[] = [];
  {
    const c = client('C009');
    const m = merchantNamed(ctx, 'CU 선릉역점');
    const card = c.cards[0]!;
    failures.push({
      id: `C009-${CURRENT_MONTH}-F01`,
      clientCode: 'C009',
      period: CURRENT_MONTH,
      fileKind: 'card_purchase',
      rawData: cardPurchaseRaw({
        date: `${CURRENT_MONTH}-17`,
        cardCompany: card.company,
        cardMasked: card.masked,
        merchantBusinessNumber: formatBusinessNumber(m.businessNumber!),
        merchantName: m.name,
        supply: 2_909,
        vat: 291,
        serviceCharge: 0,
        total: '3,2OO',
        merchantTypeLabel: merchantTypeLabel(m),
        bizType: m.bizType,
        category: m.category,
        deductibleLabel: deductibleLabel(true),
        note: '',
      }),
      failedField: '합계',
      expectedReason: "합계 금액 '3,2OO' 을(를) 숫자로 읽을 수 없습니다 (영문 O 포함)",
      anomalies: ['parse_failure'],
    });
  }

  return { added, failures, ledgerAnomalies };
}

/** 당월 거래·실패행에서 이상치 매니페스트를 만든다 (account_spike 는 사건 1건으로 묶음) */
export function buildManifest(
  current: readonly SyntheticTransaction[],
  failures: readonly SyntheticFailureRow[],
  ledgerAnomalies: readonly LedgerAnomalyExpectation[],
): AnomalyManifest {
  const entries: AnomalyEntry[] = [];
  for (const t of current) {
    for (const kind of t.anomalies) {
      if (kind === 'account_spike') continue;
      entries.push({ kind, clientCode: t.clientCode, transactionIds: [t.id], description: describe(kind, t) });
    }
  }
  for (const f of failures) {
    for (const kind of f.anomalies) entries.push({ kind, clientCode: f.clientCode, transactionIds: [f.id], description: f.expectedReason });
  }
  for (const l of ledgerAnomalies) {
    entries.push({
      kind: 'account_spike',
      clientCode: l.clientCode,
      transactionIds: [...l.transactionIds],
      description: `${l.title}: 3개월 평균 ${l.baseline.toLocaleString('ko-KR')}원 → 이번달 ${l.current.toLocaleString('ko-KR')}원`,
      metric: { current: l.current, baseline: l.baseline, changeRate: Math.round(((l.current - l.baseline) / l.baseline) * 1000) / 10 },
    });
  }
  const counts = Object.fromEntries(ANOMALY_KINDS.map((k) => [k, 0])) as Record<AnomalyKind, number>;
  for (const e of entries) counts[e.kind] += 1;
  return { entries, counts };
}

function describe(kind: AnomalyKind, t: SyntheticTransaction): string {
  const amt = `${t.totalAmount.toLocaleString('ko-KR')}원`;
  return `${ANOMALY_SPECS[kind].label} — ${t.transactionDate} ${t.merchantName} ${amt}`;
}

/** 이상치별 기대 버킷 (문서용) */
export const EXPECTED_BUCKETS_BY_ANOMALY: Readonly<Partial<Record<AnomalyKind, ExceptionBucket[]>>> = {
  exact_duplicate: ['duplicate'],
  possible_duplicate: ['duplicate'],
  unclassifiable_merchant: ['new_merchant', 'unclassified'],
  asset_purchase: ['possible_asset', 'high_amount'],
  entertainment: ['entertainment'],
  personal_use: ['personal_use'],
  foreign_saas: ['foreign', 'new_merchant'],
  vat_mismatch: ['vat_review'],
  new_merchant_high_amount: ['new_merchant', 'high_amount'],
  account_spike: ['spike'],
  treatment_changed: ['changed_from_history', 'possible_asset', 'high_amount'],
};
