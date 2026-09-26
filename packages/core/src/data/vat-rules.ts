import type { Condition, ConditionOperator } from '../types';
import type { RuleFactField } from '../engine/vat';

/**
 * 부가세 공제/불공제 기본 규칙 (vat_rules 테이블 시드).
 *
 * - 근거: docs/research/04-vat-and-account-rules.md §2·§4.3 (법령 미러 원문 확인, 2026-09-26 기준)
 * - 조문 근거(legalBasis)는 [법령] 등급이지만, 업종·상호 키워드 목록은 전부 [추론]이다 → 검증필요.
 * - 평가 방식: priority 가 높은 규칙부터 조건을 평가해 **처음 일치한 규칙이 결론**을 낸다 (방화벽 규칙과 같은 방식).
 *   나머지 일치 규칙은 참고 근거로만 표시된다. 예외 규칙(전세버스 등)은 원칙 규칙보다 priority 를 높게 둔다.
 * - 우선순위 구간 (관례)
 *   950 이상  데이터 사실 (해외결제, 증빙 없음, 세액 0, 면세 가맹점, 면세사업자·간이과세자 수임처, 기업업무추진비) — 사람 규칙(vat_override)으로도 뒤집지 않음
 *   800~949  용도·업종 기반 불공제/검토
 *   300      원천자료(홈택스 공제여부결정) 힌트
 *   10~20    증빙별 기본 공제
 * - 사무소는 DB 에서 조건·결과·신뢰도·우선순위를 바꿀 수 있고, clientId 를 지정한 같은 code 의 규칙으로 수임처별 덮어쓰기를 한다.
 */

export type VatRuleOutcome = 'non_deductible' | 'deductible' | 'review';

/** vat_rules 행과 같은 모양 (id 는 DB 행일 때만) */
export interface VatRuleDef {
  id?: string;
  code: string;
  name: string;
  condition: Condition;
  outcome: VatRuleOutcome;
  /** 사용자에게 보여줄 한국어 근거 문장 */
  reasonText: string;
  legalBasis: string | null;
  /** 0~100 */
  confidence: number;
  /** 높을수록 먼저 평가 */
  priority: number;
  /** null/undefined = 전 수임처 공통 */
  clientId?: string | null;
  active?: boolean;
}

/** 엔진 조정값 — 법정 기준값이 아니라 신뢰도 보정값. settings 로 덮어쓸 수 있다. */
export interface VatEngineOptions {
  /** 원천 공제여부 힌트가 엔진 결론과 같을 때 가산점 (키워드 규칙이 힌트와 일치할 때만 자동확정 구간에 들어가도록) */
  hintAgreementBonus: number;
  /** 가산 후 상한 */
  hintAgreementMaxConfidence: number;
  /** 엔진은 '공제'인데 원천 힌트가 '불공제'일 때 → 판단불가(null) + 이 값으로 신뢰도 상한 */
  hintConflictMaxConfidence: number;
  /** 일치하는 규칙이 없을 때 신뢰도 */
  noRuleConfidence: number;
  /** 이 priority 이상 규칙(데이터 사실)은 사람 규칙의 vat_override 로도 뒤집지 않는다 */
  factPriorityMin: number;
  /** 사람 승인 규칙(vat_override) 적용 시 기본 신뢰도 */
  overrideConfidence: number;
}

export const DEFAULT_VAT_ENGINE_OPTIONS: Readonly<VatEngineOptions> = Object.freeze({
  hintAgreementBonus: 7,
  hintAgreementMaxConfidence: 97,
  hintConflictMaxConfidence: 70,
  noRuleConfidence: 40,
  factPriorityMin: 950,
  overrideConfidence: 97,
});

// ─────────────────────────── 키워드 (전부 [추론] — 검증필요) ───────────────────────────
// 주 신호는 홈택스 카드 엑셀의 업태/업종(merchantCategory) 텍스트와 상호. research/04 §4.4
// 공급자 업종 규칙(시행령 제88조⑤)은 merchantText(상호+업종)만, 용도 규칙은 searchText(+적요)를 본다.

/** 시행령 제88조⑤1호 목욕·이발·미용업 */
export const KW_BATH_BARBER_BEAUTY = ['목욕', '욕탕', '사우나', '찜질', '이발', '이용원', '미용', '헤어'];
/** 시행령 제88조⑤2호 여객운송업 (전세버스 제외) */
export const KW_PASSENGER_TRANSPORT = [
  '택시', '고속버스', '시외버스', '시내버스', '버스운송', '여객자동차', '철도', '코레일', 'KORAIL', 'KTX', 'SRT',
  '항공', '진에어', '에어부산', '에어서울', '티웨이', '여객선', '여객운송',
];
export const KW_CHARTER_BUS = ['전세버스'];
/** 시행령 제88조⑤3호 입장권 발행 사업 */
export const KW_ADMISSION = ['영화관', '극장', '시네마', 'CGV', '메가박스', '공연장', '놀이공원', '테마파크', '에버랜드', '롯데월드', '워터파크', '경기장'];
/** 시행령 제88조⑤4호 과세 미용의료 (세액 > 0 조건과 함께) */
export const KW_COSMETIC_MEDICAL = ['성형외과', '피부과'];
/** 시행령 제88조⑤5호 과세 동물진료 */
export const KW_VETERINARY = ['동물병원', '수의'];
/** 시행령 제88조⑤6호 무도학원·자동차운전학원 */
export const KW_DANCE_DRIVING_SCHOOL = ['무도학원', '댄스학원', '운전학원', '자동차학원', '자동차운전'];
/** 과세유흥장소 (개별소비세법 제1조④) */
export const KW_ENTERTAINMENT_VENUE = ['유흥주점', '룸살롱', '룸싸롱', '단란주점', '나이트클럽', '가라오케', '호스트바'];
export const KW_GOLF = ['골프', 'GOLF', '컨트리클럽', 'C.C'];
export const KW_GIFT_CARD = ['상품권', '기프트카드', '기프티콘'];
/** 네일·피부관리 등 미용 유사 서비스 (제73조와 제88조⑤ 문언 차이 → 검토) */
export const KW_BEAUTY_LIKE = ['네일', '피부관리', '마사지', '에스테틱', '왁싱', '태닝'];
/** 차량 구입·임차·유지 관련 */
export const KW_VEHICLE = [
  '주유', '충전소', '오일뱅크', 'GS칼텍스', 'SK에너지', 'S-OIL', '에쓰오일', '현대오일',
  '주차', '세차', '카센터', '자동차정비', '정비소', '타이어', '렌터카', '렌트카', '오토리스', '자동차리스', '자동차보험',
];
/** 차량 관련 계정: 822 차량유지비, 208 차량운반구 */
export const VEHICLE_ACCOUNT_CODES = ['822', '208'];
/** 토지 관련 */
export const KW_LAND = ['토지', '형질변경', '부지조성', '택지조성', '철거'];
/** 사업무관(가사) 신호 */
export const KW_NON_BUSINESS = ['개인용', '가사용', '자택', '가족여행', '자녀', '사적'];

const CARD_LIKE = ['card', 'cash_receipt'];

/** 조건 잎 생성 헬퍼 — RuleFactField(엔진 가상 필드 포함)를 허용한다 */
function f(field: RuleFactField, op: ConditionOperator, value?: string | number | boolean | Array<string | number>): Condition {
  return (value === undefined ? { field, op } : { field, op, value }) as unknown as Condition;
}
const all = (...c: Condition[]): Condition => ({ all: c });
const any = (...c: Condition[]): Condition => ({ any: c });

const cardLike = f('evidenceType', 'in', CARD_LIKE);
const withVat = f('vatAmount', 'gt', 0);

export const DEFAULT_VAT_RULES: readonly VatRuleDef[] = Object.freeze<VatRuleDef[]>([
  // ── ① 데이터 사실 ──
  {
    code: 'VAT-FOR-01',
    name: '해외결제',
    condition: f('isForeign', 'eq', true),
    outcome: 'non_deductible',
    reasonText: '해외 가맹점 결제는 국내 부가가치세가 거래징수되지 않아 공제할 매입세액이 없습니다 (일반전표 처리).',
    legalBasis: '국외 공급 — 국내 부가가치세 없음 (research/04 U8 [추론], 검증필요)',
    confidence: 95,
    priority: 1000,
  },
  {
    code: 'VAT-EVD-01',
    name: '적격 매입세액 증빙 아님 (통장·간이영수증 등)',
    condition: f('evidenceType', 'in', ['bank', 'other']),
    outcome: 'non_deductible',
    reasonText: '세금계산서·카드전표·현금영수증이 아닌 자료는 매입세액 공제 증빙이 되지 않습니다.',
    legalBasis: '부가가치세법 제39조①2호',
    confidence: 90,
    priority: 990,
  },
  {
    code: 'VAT-EXI-01',
    name: '계산서(면세) 수취분',
    condition: f('evidenceType', 'eq', 'invoice_exempt'),
    outcome: 'non_deductible',
    reasonText: '계산서(면세) 수취분은 부가가치세가 없어 공제할 매입세액이 없습니다 (면세매입).',
    legalBasis: '부가가치세법 제26조 (면세 재화·용역)',
    confidence: 97,
    priority: 985,
  },
  {
    code: 'VAT-CARD-00',
    name: '카드·현금영수증 세액 없음',
    condition: all(cardLike, f('vatAmount', 'eq', 0)),
    outcome: 'non_deductible',
    reasonText: '부가가치세액이 별도로 구분되지 않은 카드전표·현금영수증이라 공제할 매입세액이 없습니다.',
    legalBasis: '부가가치세법 제46조③ (부가가치세액이 별도로 구분되는 신용카드매출전표등)',
    confidence: 95,
    priority: 980,
  },
  {
    code: 'VAT-CARD-01',
    name: '면세사업자 가맹점',
    condition: all(cardLike, f('merchantTaxType', 'eq', 'exempt')),
    outcome: 'non_deductible',
    reasonText: '면세사업자에게 받은 전표는 부가가치세가 없어 공제할 매입세액이 없습니다.',
    legalBasis: '부가가치세법 제46조③, 제26조',
    confidence: 93,
    priority: 970,
  },
  {
    code: 'VAT-EXM-01',
    name: '면세사업자(수임처) 매입',
    condition: f('clientVatType', 'eq', 'exempt'),
    outcome: 'non_deductible',
    reasonText: '면세사업자인 수임처의 매입세액은 면세사업 관련 매입세액으로 공제되지 않습니다.',
    legalBasis: '부가가치세법 제39조①7호',
    confidence: 95,
    priority: 960,
  },
  {
    code: 'VAT-ENT-01',
    name: '기업업무추진비(접대비) 관련',
    condition: f('accountCode', 'eq', '813'),
    outcome: 'non_deductible',
    reasonText: '기업업무추진비(접대비) 및 이와 유사한 비용의 매입세액은 공제되지 않습니다.',
    legalBasis: '부가가치세법 제39조①6호, 시행령 제79조',
    confidence: 95,
    priority: 950,
  },
  {
    // 수임처 과세유형(사실) 규칙 → 950. 같은 priority 에서는 불공제 결론이 먼저라 접대비(VAT-ENT-01)는 그대로 불공제.
    // 사람 규칙의 vat_override('공제')로 일반과세자식 전액 공제가 자동확정되지 않도록 사실 구간에 둔다.
    code: 'VAT-SIMP-01',
    name: '간이과세자(수임처) 매입',
    condition: all(withVat, f('clientVatType', 'eq', 'simplified')),
    outcome: 'review',
    reasonText: '간이과세자 수임처는 매입세액 전액이 아니라 세금계산서등 수취 공급대가의 0.5%를 공제합니다. 처리 방식을 확인하세요.',
    legalBasis: '부가가치세법 제63조③1호 (WEHAGO 처리방식 검증필요)',
    confidence: 75,
    priority: 950,
  },
  // ── ② 용도 ──
  {
    code: 'VAT-CAR-01',
    name: '불공제 차량(개별소비세 과세 승용차) 구입·임차·유지',
    condition: f('vehicleMatched', 'eq', true),
    outcome: 'non_deductible',
    reasonText: '수임처에 등록된 불공제 차량(비영업용 소형승용차)과 연결된 지출입니다.',
    legalBasis: '부가가치세법 제39조①5호, 개별소비세법 제1조②3호',
    confidence: 90,
    priority: 940,
  },
  {
    code: 'VAT-LAND-01',
    name: '토지 관련 매입 (토지 계정)',
    condition: f('accountCode', 'eq', '201'),
    outcome: 'non_deductible',
    reasonText: '토지의 취득·조성 등 토지 관련 매입세액은 공제되지 않습니다.',
    legalBasis: '부가가치세법 제39조①7호, 시행령 제80조',
    confidence: 92,
    priority: 935,
  },
  {
    code: 'VAT-BIZ-01',
    name: '사업무관 지출 (가지급금·인출금)',
    condition: f('accountCode', 'in', ['134', '338']),
    outcome: 'non_deductible',
    reasonText: '가지급금·인출금으로 처리된 지출은 사업과 직접 관련 없는 지출로 보아 공제하지 않습니다.',
    legalBasis: '부가가치세법 제39조①4호, 시행령 제77조',
    confidence: 88,
    priority: 930,
  },
  // ── ③ 카드·현금영수증 공제 제외 업종 (시행령 제88조⑤) ──
  {
    code: 'VAT-CARD-04',
    name: '전세버스 (여객운송 공제제외의 예외)',
    condition: all(cardLike, withVat, f('merchantText', 'contains', KW_CHARTER_BUS)),
    outcome: 'deductible',
    reasonText: '전세버스운송사업은 카드 공제 제외 업종(여객운송업)에서 빠지므로 공제 대상입니다.',
    legalBasis: '부가가치세법 시행령 제88조⑤2호 괄호',
    confidence: 85,
    priority: 900,
  },
  {
    code: 'VAT-CARD-02',
    name: '목욕·이발·미용업 카드 매입',
    condition: all(cardLike, withVat, f('merchantText', 'contains', KW_BATH_BARBER_BEAUTY)),
    outcome: 'non_deductible',
    reasonText: '목욕·이발·미용업자에게 받은 카드전표·현금영수증은 매입세액 공제 대상이 아닙니다.',
    legalBasis: '부가가치세법 제46조③, 시행령 제88조⑤1호',
    confidence: 88,
    priority: 890,
  },
  {
    code: 'VAT-CARD-03',
    name: '여객운송업(택시·버스·철도·항공 등) 카드 매입',
    condition: all(cardLike, withVat, f('merchantText', 'contains', KW_PASSENGER_TRANSPORT)),
    outcome: 'non_deductible',
    reasonText: '여객운송업(택시·고속버스·철도·항공 등, 전세버스 제외)의 카드전표는 매입세액 공제 대상이 아닙니다.',
    legalBasis: '부가가치세법 제46조③, 시행령 제88조⑤2호',
    confidence: 88,
    priority: 889,
  },
  {
    code: 'VAT-CARD-05',
    name: '입장권 발행 사업 카드 매입',
    condition: all(cardLike, withVat, f('merchantText', 'contains', KW_ADMISSION)),
    outcome: 'non_deductible',
    reasonText: '입장권을 발행하는 사업(영화관·공연장·놀이공원 등)의 카드전표는 매입세액 공제 대상이 아닙니다.',
    legalBasis: '부가가치세법 제46조③, 시행령 제88조⑤3호',
    confidence: 85,
    priority: 888,
  },
  {
    code: 'VAT-CARD-06',
    name: '과세 미용의료(성형·피부과) 카드 매입',
    condition: all(cardLike, withVat, f('merchantText', 'contains', KW_COSMETIC_MEDICAL)),
    outcome: 'non_deductible',
    reasonText: '과세되는 미용목적 의료용역의 카드전표는 매입세액 공제 대상이 아닙니다.',
    legalBasis: '부가가치세법 시행령 제88조⑤4호, 제35조1호 단서',
    confidence: 85,
    priority: 887,
  },
  {
    code: 'VAT-CARD-07',
    name: '과세 동물진료 카드 매입',
    condition: all(cardLike, withVat, f('merchantText', 'contains', KW_VETERINARY)),
    outcome: 'non_deductible',
    reasonText: '과세되는 동물 진료용역의 카드전표는 매입세액 공제 대상이 아닙니다.',
    legalBasis: '부가가치세법 시행령 제88조⑤5호, 제35조5호',
    confidence: 85,
    priority: 886,
  },
  {
    code: 'VAT-CARD-08',
    name: '무도학원·자동차운전학원 카드 매입',
    condition: all(cardLike, withVat, f('merchantText', 'contains', KW_DANCE_DRIVING_SCHOOL)),
    outcome: 'non_deductible',
    reasonText: '무도학원·자동차운전학원의 카드전표는 매입세액 공제 대상이 아닙니다.',
    legalBasis: '부가가치세법 시행령 제88조⑤6호, 제36조②',
    confidence: 85,
    priority: 885,
  },
  {
    code: 'VAT-CARD-11',
    name: '과세유흥장소 카드 매입',
    condition: all(cardLike, withVat, f('merchantText', 'contains', KW_ENTERTAINMENT_VENUE)),
    outcome: 'non_deductible',
    reasonText: '유흥주점 등 과세유흥장소 지출은 접대 또는 사업무관 지출로 보아 불공제로 추정합니다.',
    legalBasis: '부가가치세법 제39조①4·6호 (용도 추정), 개별소비세법 제1조④',
    confidence: 85,
    priority: 884,
  },
  // ── ④ 상대방 간이과세자 ──
  {
    code: 'VAT-CARD-09A',
    name: '간이과세자 가맹점 + 원천 공제 표시',
    condition: all(cardLike, withVat, f('merchantTaxType', 'eq', 'simplified'), f('sourceDeductibleHint', 'eq', true)),
    outcome: 'deductible',
    reasonText: '간이과세자 가맹점이지만 원천자료(홈택스)가 공제로 표시해 세금계산서 발급 가능 간이과세자로 봅니다.',
    legalBasis: '부가가치세법 제46조③3호, 제36조①2호',
    confidence: 80,
    priority: 870,
  },
  {
    code: 'VAT-CARD-09',
    name: '간이과세자 가맹점',
    condition: all(cardLike, withVat, f('merchantTaxType', 'eq', 'simplified')),
    outcome: 'review',
    reasonText: '간이과세자 중 영수증 발급 대상자(직전연도 공급대가 4,800만원 미만 등)에게 받은 전표는 공제되지 않습니다. 발급 대상 여부를 확인하세요.',
    legalBasis: '부가가치세법 제46조③3호, 제36조①2호, 시행령 제88조⑤',
    confidence: 60,
    priority: 869,
  },
  // ── ⑤ 검토 (용도·해석 미확인) ──
  {
    code: 'VAT-CARD-12',
    name: '골프장 이용',
    condition: all(withVat, f('searchText', 'contains', KW_GOLF)),
    outcome: 'review',
    reasonText: '골프장 지출은 접대·사업무관 가능성이 높아 용도 확인이 필요합니다.',
    legalBasis: '부가가치세법 제39조①4·6호 (용도 검토)',
    confidence: 60,
    priority: 860,
  },
  {
    code: 'VAT-CARD-13',
    name: '상품권 구입',
    condition: all(withVat, f('searchText', 'contains', KW_GIFT_CARD)),
    outcome: 'review',
    reasonText: '상품권 구입은 통상 부가가치세가 없고 접대·복리후생 용도 확인이 필요합니다.',
    legalBasis: '부가가치세법 시행령 제28조① (상품권 공급시기) — 검증필요',
    confidence: 60,
    priority: 859,
  },
  {
    code: 'VAT-CARD-15',
    name: '미용 유사 서비스(네일·피부관리·마사지)',
    condition: all(cardLike, withVat, f('merchantText', 'contains', KW_BEAUTY_LIKE)),
    outcome: 'review',
    reasonText: '네일·피부관리 등이 공제 제외 업종(미용업)에 해당하는지 확인이 필요합니다.',
    legalBasis: '부가가치세법 시행령 제73조①4호, 제88조⑤1호 (해석 미확인)',
    confidence: 60,
    priority: 858,
  },
  {
    code: 'VAT-CAR-05',
    name: '차량 관련 지출 (차량 미식별)',
    condition: all(withVat, any(f('accountCode', 'in', VEHICLE_ACCOUNT_CODES), f('searchText', 'contains', KW_VEHICLE))),
    outcome: 'review',
    reasonText: '차량 관련 지출이지만 어떤 차량인지 식별되지 않았습니다. 개별소비세 과세 승용차(비영업용 소형승용차)이면 불공제입니다.',
    legalBasis: '부가가치세법 제39조①5호',
    confidence: 65,
    priority: 850,
  },
  {
    code: 'VAT-LAND-02',
    name: '토지 관련 가능성 (키워드)',
    condition: all(withVat, f('searchText', 'contains', KW_LAND)),
    outcome: 'review',
    reasonText: '토지 취득·조성·철거 관련 지출이면 매입세액이 공제되지 않습니다. 용도를 확인하세요.',
    legalBasis: '부가가치세법 제39조①7호, 시행령 제80조',
    confidence: 60,
    priority: 840,
  },
  {
    code: 'VAT-BIZ-02',
    name: '사업무관 가능성 (키워드)',
    condition: all(withVat, f('searchText', 'contains', KW_NON_BUSINESS)),
    outcome: 'review',
    reasonText: '사업과 직접 관련 없는 지출(가사·개인 사용)이면 매입세액이 공제되지 않습니다.',
    legalBasis: '부가가치세법 제39조①4호, 시행령 제77조',
    confidence: 60,
    priority: 830,
  },
  {
    code: 'VAT-EXM-02',
    name: '겸영사업자 공통매입',
    condition: all(withVat, f('clientVatType', 'eq', 'mixed')),
    outcome: 'review',
    reasonText: '과세·면세 겸영 수임처입니다. 면세사업 귀속분은 불공제, 공통매입세액은 안분 계산이 필요합니다.',
    legalBasis: '부가가치세법 제39조①7호, 제40조, 시행령 제81조',
    confidence: 60,
    priority: 800,
  },
  {
    code: 'VAT-EXM-03',
    name: '면세업종(학원·병의원) 수임처 과세유형 확인',
    condition: all(withVat, f('industry', 'in', ['academy', 'clinic']), f('clientVatType', 'in', ['general', 'simplified'])),
    outcome: 'review',
    reasonText: '업종은 면세업종(학원·병의원)인데 과세유형이 일반/간이로 등록되어 있습니다. 면세사업 관련 매입이면 불공제입니다.',
    legalBasis: '부가가치세법 제39조①7호',
    confidence: 60,
    priority: 790,
  },
  // ── ⑥ 원천 힌트 ──
  {
    code: 'VAT-HINT-01',
    name: '원천자료 불공제 표시',
    condition: f('sourceDeductibleHint', 'eq', false),
    outcome: 'review',
    reasonText: '원천자료(홈택스 공제여부결정)가 불공제로 표시했지만 사유가 확인되지 않았습니다.',
    legalBasis: '부가가치세법 제46조③ (홈택스 판정은 참고용)',
    confidence: 60,
    priority: 300,
  },
  // ── ⑦ 증빙별 기본 공제 ──
  {
    code: 'VAT-DEF-TI',
    name: '세금계산서 수취분 기본 공제',
    condition: f('evidenceType', 'eq', 'tax_invoice'),
    outcome: 'deductible',
    reasonText: '사업을 위해 세금계산서를 받은 매입세액은 공제됩니다.',
    legalBasis: '부가가치세법 제38조①',
    confidence: 97,
    priority: 20,
  },
  {
    code: 'VAT-DEF-CARD-GEN',
    name: '일반과세자 카드·현금영수증 기본 공제',
    condition: all(cardLike, withVat, f('merchantTaxType', 'eq', 'general')),
    outcome: 'deductible',
    reasonText: '일반과세자에게 세액이 구분된 카드전표·현금영수증을 받은 매입세액은 공제됩니다.',
    legalBasis: '부가가치세법 제46조③',
    confidence: 95,
    priority: 15,
  },
  {
    code: 'VAT-DEF-CARD',
    name: '카드·현금영수증 기본 공제 (가맹점 과세유형 미상)',
    condition: all(cardLike, withVat),
    outcome: 'deductible',
    reasonText: '세액이 구분된 카드전표·현금영수증의 매입세액은 공제됩니다 (가맹점 과세유형은 원천자료에 없음).',
    legalBasis: '부가가치세법 제46조③',
    confidence: 90,
    priority: 10,
  },
]);
