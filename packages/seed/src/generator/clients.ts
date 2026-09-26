import type { BusinessType, IndustryKey, VatTaxpayerType } from '@mintax/core';
import { CARD_COMPANIES, makeAddress, makeBusinessNumber, makeEmail, makeMaskedCard, makePersonName, makePlate, type BizNoKind } from './ids';
import { rngFor } from './prng';
import type { SyntheticCard, SyntheticClient, SyntheticVehicle } from './types';

/**
 * 가상 수임처 24곳. 이름·번호·차량·카드는 모두 합성값이다.
 *
 * 시나리오
 * - C001 "A거래처" (주)에이플러스디자인: 디자인 + 온라인 판매 겸업, 법인카드 사용량 많음 (2026-09 카드 약 500건)
 * - C002 시나리오상사: docs/06-mvp-plan.md 시나리오 1(카드 500건)·시나리오 2(직원 10명 급여)
 * - C004 (주)대한종합건설: 접대비 급증 (3개월 평균 240만원 → 이번달 890만원)
 */

export interface ClientVolume {
  /** 월평균 사업용카드 매입 건수 */
  card: number;
  /** 월평균 현금영수증 매입 건수 */
  cash: number;
  /** 월평균 세금계산서 매입 (정기 청구분 제외) */
  taxInvoice: number;
  /** 월평균 계산서(면세) 매입 */
  exemptInvoice: number;
  /** 월평균 세금계산서 매출 */
  salesTaxInvoice: number;
  /** 월평균 계산서(면세) 매출 */
  salesExemptInvoice: number;
  /** 카드매출(일자·카드사별 집계) 여부 */
  cardSales: boolean;
  /** 월평균 현금영수증 매출 */
  cashSales: number;
  /** 주말 영업 (카드사용 주말 비중) */
  weekendActive: boolean;
}

export interface ClientSpec {
  code: string;
  name: string;
  businessType: BusinessType;
  vatType: VatTaxpayerType;
  industry: IndustryKey;
  industryName: string;
  deemedInputTaxEligible: boolean;
  vehicles: Array<Omit<SyntheticVehicle, 'plate'>>;
  cardCount: number;
  withholdingSemiannual: boolean;
  tags: string[];
  notes: string;
  volume: ClientVolume;
}

const V = (v: Partial<ClientVolume> & Pick<ClientVolume, 'card'>): ClientVolume => ({
  cash: 5,
  taxInvoice: 2,
  exemptInvoice: 0,
  salesTaxInvoice: 0,
  salesExemptInvoice: 0,
  cardSales: false,
  cashSales: 0,
  weekendActive: false,
  ...v,
});

const SEDAN = (model: string, nonDeductible = true): Omit<SyntheticVehicle, 'plate'> => ({ kind: 'passenger', model, nonDeductible });
const TRUCK = (model: string): Omit<SyntheticVehicle, 'plate'> => ({ kind: 'truck', model, nonDeductible: false });
const VAN = (model: string): Omit<SyntheticVehicle, 'plate'> => ({ kind: 'van', model, nonDeductible: false });

export const SCENARIO_A_CODE = 'C001';
export const SCENARIO_PAYROLL_CODE = 'C002';
export const SPIKE_CLIENT_CODE = 'C004';

export const CLIENT_SPECS: readonly ClientSpec[] = [
  {
    code: 'C001', name: '(주)에이플러스디자인', businessType: 'corporation', vatType: 'general', industry: 'design',
    industryName: '시각디자인 · 온라인 디자인소품 판매', deemedInputTaxEligible: false,
    vehicles: [SEDAN('제네시스 G80 3.5')], cardCount: 4, withholdingSemiannual: false,
    tags: ['scenario_a', 'design_ecommerce_hybrid'],
    notes: 'A거래처 — 디자인 용역 + 자사몰 소품 판매 겸업. 법인카드 사용량이 많다(월 약 500건).',
    volume: V({ card: 492, cash: 12, taxInvoice: 6, salesTaxInvoice: 14, cardSales: true }),
  },
  {
    code: 'C002', name: '시나리오상사', businessType: 'individual', vatType: 'general', industry: 'service',
    industryName: '사업지원 서비스', deemedInputTaxEligible: false,
    vehicles: [], cardCount: 2, withholdingSemiannual: false,
    tags: ['scenario_payroll', 'scenario1_card500'],
    notes: 'docs/06-mvp-plan.md 시나리오 1(카드 500건)·시나리오 2(직원 10명) 픽스처.',
    volume: V({ card: 470, cash: 0, taxInvoice: 0, salesTaxInvoice: 8 }),
  },
  {
    code: 'C003', name: '한우마을정육식당', businessType: 'individual', vatType: 'general', industry: 'meat_restaurant',
    industryName: '정육식당(한식 육류구이)', deemedInputTaxEligible: true,
    vehicles: [TRUCK('포터2 냉장탑')], cardCount: 2, withholdingSemiannual: false, tags: [],
    notes: '축산물 면세 매입(계산서) 비중 높음 — 의제매입세액공제 대상.',
    volume: V({ card: 150, cash: 10, exemptInvoice: 18, cardSales: true, cashSales: 20, weekendActive: true }),
  },
  {
    code: 'C004', name: '(주)대한종합건설', businessType: 'corporation', vatType: 'general', industry: 'construction',
    industryName: '종합건설(건축)', deemedInputTaxEligible: false,
    vehicles: [TRUCK('봉고3 화물'), TRUCK('25톤 덤프'), SEDAN('그랜저 2.5')], cardCount: 3, withholdingSemiannual: false,
    tags: ['spike_entertainment'], notes: '접대비 3개월 평균 240만원 → 2026-09 890만원 (급증 시나리오).',
    volume: V({ card: 180, cash: 6, taxInvoice: 20, salesTaxInvoice: 6 }),
  },
  {
    code: 'C005', name: '스마일쇼핑몰', businessType: 'individual', vatType: 'general', industry: 'ecommerce',
    industryName: '전자상거래 소매(생활용품)', deemedInputTaxEligible: false,
    vehicles: [VAN('스타리아 11인승')], cardCount: 2, withholdingSemiannual: false, tags: [],
    notes: '오픈마켓 상품 매입 + 택배 운반비 비중 높음.',
    volume: V({ card: 340, cash: 8, taxInvoice: 10, cardSales: true, weekendActive: true }),
  },
  {
    code: 'C006', name: '(주)모던인테리어', businessType: 'corporation', vatType: 'general', industry: 'interior',
    industryName: '실내건축 공사', deemedInputTaxEligible: false,
    vehicles: [TRUCK('포터2')], cardCount: 2, withholdingSemiannual: false, tags: [], notes: '',
    volume: V({ card: 120, cash: 6, taxInvoice: 14, salesTaxInvoice: 5 }),
  },
  {
    code: 'C007', name: '해피수학학원', businessType: 'individual', vatType: 'exempt', industry: 'academy',
    industryName: '입시·보습학원(면세)', deemedInputTaxEligible: false,
    vehicles: [VAN('카니발 11인승 (학원차량)')], cardCount: 1, withholdingSemiannual: false, tags: [],
    notes: '면세사업자 — 매입세액 불공제.',
    volume: V({ card: 60, cash: 5, exemptInvoice: 2, cardSales: true, cashSales: 15 }),
  },
  {
    code: 'C008', name: '밝은내과의원', businessType: 'individual', vatType: 'exempt', industry: 'clinic',
    industryName: '내과 의원(면세)', deemedInputTaxEligible: false,
    vehicles: [], cardCount: 1, withholdingSemiannual: false, tags: [], notes: '면세사업자 — 매입세액 불공제.',
    volume: V({ card: 90, cash: 4, taxInvoice: 6, exemptInvoice: 4, cardSales: true, cashSales: 10 }),
  },
  {
    code: 'C009', name: '(주)가나유통', businessType: 'corporation', vatType: 'general', industry: 'wholesale_retail',
    industryName: '생활용품 도매', deemedInputTaxEligible: false,
    vehicles: [TRUCK('1톤 탑차'), SEDAN('K5 2.0')], cardCount: 3, withholdingSemiannual: false, tags: [], notes: '',
    volume: V({ card: 200, cash: 8, taxInvoice: 24, salesTaxInvoice: 30 }),
  },
  {
    code: 'C010', name: '청솔빌딩', businessType: 'individual', vatType: 'general', industry: 'rental',
    industryName: '비주거용 건물 임대', deemedInputTaxEligible: false,
    vehicles: [SEDAN('레이 (경차)', false)], cardCount: 1, withholdingSemiannual: false, tags: [],
    notes: '임대료 세금계산서 매출(임차인별 월 1건). 경차는 불공제 대상 아님.',
    volume: V({ card: 50, cash: 3, taxInvoice: 3, salesTaxInvoice: 6 }),
  },
  {
    code: 'C011', name: '(주)한빛정밀', businessType: 'corporation', vatType: 'general', industry: 'manufacturing',
    industryName: '금속 정밀가공 제조', deemedInputTaxEligible: false,
    vehicles: [TRUCK('마이티 2.5톤')], cardCount: 2, withholdingSemiannual: false, tags: [], notes: '',
    volume: V({ card: 150, cash: 5, taxInvoice: 22, salesTaxInvoice: 12 }),
  },
  {
    code: 'C012', name: '(주)코드웨이브', businessType: 'corporation', vatType: 'general', industry: 'it_service',
    industryName: '소프트웨어 개발·공급', deemedInputTaxEligible: false,
    vehicles: [SEDAN('아이오닉5 (전기승용)')], cardCount: 3, withholdingSemiannual: false, tags: [],
    notes: '해외 SaaS(USD) 정기결제 다수.',
    volume: V({ card: 150, cash: 4, taxInvoice: 4, salesTaxInvoice: 8 }),
  },
  {
    code: 'C013', name: '카페온더코너', businessType: 'individual', vatType: 'general', industry: 'cafe',
    industryName: '커피전문점', deemedInputTaxEligible: true,
    vehicles: [], cardCount: 1, withholdingSemiannual: false, tags: [], notes: '원두(과세)·우유(면세) 매입.',
    volume: V({ card: 130, cash: 6, taxInvoice: 4, exemptInvoice: 6, cardSales: true, cashSales: 20, weekendActive: true }),
  },
  {
    code: 'C014', name: '골목분식', businessType: 'individual', vatType: 'simplified', industry: 'restaurant',
    industryName: '분식 음식점(간이과세)', deemedInputTaxEligible: false,
    vehicles: [], cardCount: 1, withholdingSemiannual: true, tags: [],
    notes: '간이과세자 — 의제매입 불가, 매입세액은 공급대가 0.5% 공제 방식.',
    volume: V({ card: 55, cash: 4, cardSales: true, cashSales: 10, weekendActive: true }),
  },
  {
    code: 'C015', name: '소담한식당', businessType: 'individual', vatType: 'general', industry: 'restaurant',
    industryName: '한식 음식점', deemedInputTaxEligible: true,
    vehicles: [], cardCount: 2, withholdingSemiannual: false, tags: [], notes: '',
    volume: V({ card: 160, cash: 8, exemptInvoice: 10, cardSales: true, cashSales: 15, weekendActive: true }),
  },
  {
    code: 'C016', name: '뷰티라인피부과의원', businessType: 'individual', vatType: 'mixed', industry: 'clinic',
    industryName: '피부과 의원(과세 미용 + 면세 진료 겸영)', deemedInputTaxEligible: false,
    vehicles: [], cardCount: 1, withholdingSemiannual: false, tags: [],
    notes: '겸영 — 공통매입세액 안분 대상. 합성 정답은 과세 미용 사업 귀속분만 공제로 둔다.',
    volume: V({ card: 90, cash: 4, taxInvoice: 6, cardSales: true, cashSales: 10 }),
  },
  {
    code: 'C017', name: '(주)스마트교육', businessType: 'corporation', vatType: 'mixed', industry: 'academy',
    industryName: '온라인 교육(면세) + 교구 판매(과세) 겸영', deemedInputTaxEligible: false,
    vehicles: [], cardCount: 2, withholdingSemiannual: false, tags: [], notes: '',
    volume: V({ card: 110, cash: 4, taxInvoice: 6, exemptInvoice: 3, salesTaxInvoice: 6, salesExemptInvoice: 6, cardSales: true }),
  },
  {
    code: 'C018', name: '동네문구', businessType: 'individual', vatType: 'simplified', industry: 'wholesale_retail',
    industryName: '문구 소매(간이과세)', deemedInputTaxEligible: false,
    vehicles: [], cardCount: 1, withholdingSemiannual: true, tags: [], notes: '',
    volume: V({ card: 55, cash: 3, taxInvoice: 6, cardSales: true, weekendActive: true }),
  },
  {
    code: 'C019', name: '(주)그린에너지설비', businessType: 'corporation', vatType: 'general', industry: 'construction',
    industryName: '태양광·전기설비 공사', deemedInputTaxEligible: false,
    vehicles: [TRUCK('포터2'), SEDAN('쏘렌토 2.2 디젤')], cardCount: 2, withholdingSemiannual: false, tags: [], notes: '',
    volume: V({ card: 130, cash: 5, taxInvoice: 16, salesTaxInvoice: 4 }),
  },
  {
    code: 'C020', name: '(주)브릿지컨설팅', businessType: 'corporation', vatType: 'general', industry: 'service',
    industryName: '경영 컨설팅', deemedInputTaxEligible: false,
    vehicles: [SEDAN('BMW 520i')], cardCount: 3, withholdingSemiannual: false, tags: [], notes: '',
    volume: V({ card: 90, cash: 4, taxInvoice: 3, salesTaxInvoice: 6 }),
  },
  {
    code: 'C021', name: '오렌지네일', businessType: 'individual', vatType: 'simplified', industry: 'service',
    industryName: '네일아트(간이과세)', deemedInputTaxEligible: false,
    vehicles: [], cardCount: 1, withholdingSemiannual: true, tags: [], notes: '',
    volume: V({ card: 50, cash: 3, cardSales: true, weekendActive: true }),
  },
  {
    code: 'C022', name: '(주)픽셀스튜디오', businessType: 'corporation', vatType: 'general', industry: 'design',
    industryName: '영상·모션 디자인', deemedInputTaxEligible: false,
    vehicles: [], cardCount: 2, withholdingSemiannual: false, tags: [], notes: '',
    volume: V({ card: 120, cash: 4, taxInvoice: 3, salesTaxInvoice: 6 }),
  },
  {
    code: 'C023', name: '(주)제일식품제조', businessType: 'corporation', vatType: 'general', industry: 'manufacturing',
    industryName: '반찬·소스 제조', deemedInputTaxEligible: true,
    vehicles: [TRUCK('냉동탑차 1톤')], cardCount: 2, withholdingSemiannual: false, tags: [],
    notes: '농산물 면세 매입(계산서) — 의제매입 대상.',
    volume: V({ card: 110, cash: 4, taxInvoice: 14, exemptInvoice: 12, salesTaxInvoice: 12 }),
  },
  {
    code: 'C024', name: '메가피트니스', businessType: 'individual', vatType: 'general', industry: 'other',
    industryName: '체력단련장(헬스장)', deemedInputTaxEligible: false,
    vehicles: [], cardCount: 1, withholdingSemiannual: false, tags: [], notes: '',
    volume: V({ card: 60, cash: 3, taxInvoice: 3, cardSales: true, weekendActive: true }),
  },
];

export function clientSpecOf(code: string): ClientSpec {
  const s = CLIENT_SPECS.find((c) => c.code === code);
  if (!s) throw new Error(`알 수 없는 거래처 코드: ${code}`);
  return s;
}

function bizKindOf(spec: ClientSpec): BizNoKind {
  if (spec.businessType === 'corporation') return 'corporation';
  return spec.vatType === 'exempt' ? 'individual_exempt' : 'individual';
}

/**
 * 거래처 목록 생성. usedBusinessNumbers 는 가맹점·고객과 공유해 번호가 겹치지 않게 한다.
 */
export function generateClients(seed: number, usedBusinessNumbers: Set<string>, usedNames: Set<string>): SyntheticClient[] {
  const usedCards = new Set<string>();
  const usedPlates = new Set<string>();
  return CLIENT_SPECS.map((spec) => {
    const rng = rngFor(seed, 'client', spec.code);
    const businessNumber = makeBusinessNumber(rng, bizKindOf(spec), usedBusinessNumbers);
    const representativeName = makePersonName(rng, usedNames);
    const vehicles: SyntheticVehicle[] = spec.vehicles.map((v) => ({ ...v, plate: makePlate(rng, usedPlates) }));
    const cards: SyntheticCard[] = Array.from({ length: spec.cardCount }, (_, i) => {
      const holderType: SyntheticCard['holderType'] =
        spec.businessType === 'corporation' ? (i === spec.cardCount - 1 && i > 0 ? 'employee' : 'corporate') : 'owner';
      const alias =
        holderType === 'corporate' ? `법인카드${i + 1}` : holderType === 'employee' ? `직원 사업용카드${i + 1}` : `대표 사업용카드${i + 1}`;
      return { masked: makeMaskedCard(rng, usedCards), company: rng.pick(CARD_COMPANIES), alias, holderType };
    });
    return {
      code: spec.code,
      name: spec.name,
      representativeName,
      businessNumber,
      businessType: spec.businessType,
      vatType: spec.vatType,
      industry: spec.industry,
      industryName: spec.industryName,
      industryCode: null,
      deemedInputTaxEligible: spec.deemedInputTaxEligible && spec.vatType !== 'simplified',
      vehicles,
      nonDeductibleVehicles: vehicles.filter((v) => v.nonDeductible).map((v) => v.plate),
      cards,
      withholdingSemiannual: spec.withholdingSemiannual,
      address: makeAddress(rng),
      email: makeEmail(`tax-${spec.code}`),
      tags: [...spec.tags],
      notes: spec.notes,
    };
  });
}
