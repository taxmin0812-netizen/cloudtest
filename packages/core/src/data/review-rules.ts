import type { Condition, ConditionOperator, ExceptionBucket, RiskSeverity } from '../types';
import type { RuleFactField } from '../engine/vat';
import { KW_GOLF, KW_LAND, KW_NON_BUSINESS, KW_VEHICLE, VEHICLE_ACCOUNT_CODES } from './vat-rules';

/**
 * 고위험 거래 기본 규칙 (review_rules 테이블 시드).
 *
 * - 금액 기준·키워드는 전부 params 에 둔다 (하드코딩 금지). 조건 안의 '$이름' 은 평가 직전에 params 값으로 바뀐다.
 * - 수임처별 조정: 같은 code + clientId 규칙으로 통째로 덮어쓰거나,
 *   client_business_profiles.rule_params 에 `'<code>.<param>'` 키로 값만 덮어쓴다.
 *   예) { "RISK-HIGH-AMOUNT.threshold": 3000000, "RISK-ENT-KW.keywords": "골프,유흥,주점" }
 * - kind 가 condition 이 아닌 규칙도 condition 이 있으면 추가 필터로 먼저 적용된다 (예: 매입만).
 * - 법정 금액 기준(3만원·20만원·100만원·600만원)의 근거: docs/research/04 §1·§4.3 F (법령 미러 원문, law.go.kr 대조 필요)
 * - 키워드 목록은 전부 [추론] — 검증필요.
 */

export type ReviewRuleKind =
  | 'condition'
  | 'high_amount'
  | 'new_merchant_high_amount'
  | 'duplicate_amount'
  | 'changed_from_history'
  | 'account_spike'
  | 'unbalanced'
  | 'repeated_abnormal';

export const REVIEW_RULE_KINDS: readonly ReviewRuleKind[] = [
  'condition',
  'high_amount',
  'new_merchant_high_amount',
  'duplicate_amount',
  'changed_from_history',
  'account_spike',
  'unbalanced',
  'repeated_abnormal',
];

export type RuleParamValue = number | string | boolean | string[];

/** review_rules 행과 같은 모양 */
export interface ReviewRuleDef {
  id?: string;
  code: string;
  name: string;
  kind: ReviewRuleKind;
  condition?: Condition | null;
  params: Record<string, RuleParamValue>;
  bucket: ExceptionBucket;
  severity: RiskSeverity;
  blocksAutoApproval: boolean;
  /** {merchantName} {date} {amount} {accountName} {threshold} 등 치환 */
  messageTemplate: string;
  clientId?: string | null;
  active?: boolean;
}

function f(field: RuleFactField, op: ConditionOperator, value?: string | number | boolean | Array<string | number>): Condition {
  return (value === undefined ? { field, op } : { field, op, value }) as unknown as Condition;
}
const all = (...c: Condition[]): Condition => ({ all: c });
const any = (...c: Condition[]): Condition => ({ any: c });
const not = (c: Condition): Condition => ({ not: c });

const purchase = f('direction', 'eq', 'purchase');
/** 주말(일·토) 또는 심야 */
const weekendOrNight = any(f('weekday', 'in', [0, 6]), f('hour', 'gte', '$nightStartHour'), f('hour', 'lt', '$nightEndHour'));

/** 자산 계정 (이미 자산으로 분류된 거래는 자산 가능성 플래그 불필요) — accounts.ts 기본표 기준, 검증필요 */
const ASSET_ACCOUNT_CODES = ['201', '202', '204', '206', '208', '210', '212', '214', '219', '226', '227'];

export const DEFAULT_REVIEW_RULES: readonly ReviewRuleDef[] = Object.freeze<ReviewRuleDef[]>([
  // ── 접대 ──
  {
    code: 'RISK-ENT-KW',
    name: '접대 관련 가능성',
    kind: 'condition',
    condition: all(purchase, f('searchText', 'contains', '$keywords')),
    params: {
      keywords: [...KW_GOLF, '유흥', '룸살롱', '룸싸롱', '단란주점', '주점', '노래', '가라오케', '나이트', '상품권', '선물', '기프트', '화환', '꽃배달'],
    },
    bucket: 'entertainment',
    severity: 'high',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName} {amount}: 접대(기업업무추진비) 관련 가능성이 있습니다. 용도와 증빙을 확인하세요.',
  },
  {
    code: 'RISK-ENT-EVD',
    name: '기업업무추진비 적격증빙 없음 (3만원 초과)',
    kind: 'condition',
    condition: all(
      purchase,
      f('accountCode', 'eq', '813'),
      f('evidenceType', 'in', ['bank', 'other']),
      f('totalAmount', 'gt', '$threshold'),
      not(f('searchText', 'contains', '$condolenceKeywords')),
    ),
    params: { threshold: 30000, condolenceKeywords: ['경조', '조의', '축의', '부의', '화환', '근조'] },
    bucket: 'entertainment',
    severity: 'high',
    blocksAutoApproval: true,
    messageTemplate: '기업업무추진비 {amount}을(를) 적격증빙 없이 지출했습니다. 1회 {threshold} 초과분은 손금불산입 대상입니다 (법인세법 제25조②, 소득세법 제35조②).',
  },
  {
    code: 'RISK-ENT-EVD-COND',
    name: '경조금 적격증빙 없음 (20만원 초과)',
    kind: 'condition',
    condition: all(
      purchase,
      f('accountCode', 'eq', '813'),
      f('evidenceType', 'in', ['bank', 'other']),
      f('totalAmount', 'gt', '$threshold'),
      f('searchText', 'contains', '$condolenceKeywords'),
    ),
    params: { threshold: 200000, condolenceKeywords: ['경조', '조의', '축의', '부의', '화환', '근조'] },
    bucket: 'entertainment',
    severity: 'high',
    blocksAutoApproval: true,
    messageTemplate: '경조금 {amount}이(가) 적격증빙 없이 {threshold}을(를) 넘습니다. 손금불산입 대상인지 확인하세요 (법인세법 시행령 제41조①).',
  },
  // ── 차량 ──
  {
    code: 'RISK-VEHICLE',
    name: '차량 관련 지출',
    kind: 'condition',
    condition: all(purchase, any(f('accountCode', 'in', '$accountCodes'), f('searchText', 'contains', '$keywords'))),
    params: { accountCodes: [...VEHICLE_ACCOUNT_CODES], keywords: [...KW_VEHICLE] },
    bucket: 'vehicle',
    severity: 'warning',
    blocksAutoApproval: false,
    messageTemplate: '{merchantName} {amount}: 차량 관련 지출입니다. 업무용승용차 해당 여부(부가세 불공제·운행기록)를 확인하세요.',
  },
  // ── 금액 / 자산 ──
  {
    code: 'RISK-HIGH-AMOUNT',
    name: '고액거래',
    kind: 'high_amount',
    condition: purchase,
    params: { threshold: 1000000 },
    bucket: 'high_amount',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName} {amount}: 고액거래 기준({threshold}) 이상입니다.',
  },
  {
    code: 'RISK-ASSET-EXPENSE',
    name: '즉시상각 기준 초과 비용',
    kind: 'condition',
    condition: all(purchase, f('accountCode', 'in', '$expenseAccounts'), f('supplyAmount', 'gt', '$threshold')),
    params: { threshold: 1000000, expenseAccounts: ['830', '829', '848', '811', '826'] },
    bucket: 'possible_asset',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{accountName} {amount}: 공급가액이 즉시상각 기준({threshold})을 넘습니다. 비품·기계장치 등 자산 계상 여부를 확인하세요.',
  },
  {
    code: 'RISK-ASSET-REPAIR',
    name: '자본적 지출 가능성 (수선비)',
    kind: 'condition',
    condition: all(purchase, f('accountCode', 'eq', '820'), f('supplyAmount', 'gte', '$threshold')),
    params: { threshold: 6000000 },
    bucket: 'possible_asset',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '수선비 {amount}: {threshold} 이상 수선은 자본적 지출(자산) 여부를 확인해야 합니다 (법인세법 시행령 제31조③).',
  },
  {
    code: 'RISK-ASSET-KW',
    name: '고정자산 후보 품목',
    kind: 'condition',
    condition: all(
      purchase,
      f('searchText', 'contains', '$keywords'),
      f('totalAmount', 'gte', '$threshold'),
      not(f('accountCode', 'in', '$assetAccounts')),
    ),
    params: {
      threshold: 1000000,
      assetAccounts: ASSET_ACCOUNT_CODES,
      keywords: [
        '컴퓨터', '노트북', '데스크탑', 'PC', '모니터', '서버', '에어컨', '냉난방', '냉장고', '가구', '책상', '의자', '소파',
        '복합기', '프린터', '카메라', '태블릿', '아이패드', '맥북', '세탁기', '건조기', 'TV', '텔레비전', '기계', '설비',
        '하이마트', '전자랜드',
      ],
    },
    bucket: 'possible_asset',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName} {amount}: 고정자산 후보 품목입니다. 자산(비품) 계상 또는 즉시상각 여부를 확인하세요.',
  },
  // ── 개인사용 ──
  {
    code: 'RISK-PERSONAL',
    name: '개인사용 가능성 (주말·심야 생활업종)',
    kind: 'condition',
    condition: all(purchase, weekendOrNight, f('searchText', 'contains', '$keywords')),
    params: {
      nightStartHour: 22,
      nightEndHour: 6,
      keywords: ['백화점', '아울렛', '병원', '의원', '약국', '학원', '미용', '헤어', '네일', '쇼핑', '무신사', '올리브영', '키즈', '영화관', 'CGV', '메가박스'],
    },
    bucket: 'personal_use',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName} {amount} ({when}): 주말·심야 생활업종 결제로 개인사용 가능성이 있습니다.',
  },
  {
    code: 'RISK-PERSONAL-MART',
    name: '개인사용 가능성 (주말·심야 마트)',
    kind: 'condition',
    condition: all(purchase, weekendOrNight, f('searchText', 'contains', '$keywords'), not(f('industry', 'in', '$excludeIndustries'))),
    params: {
      nightStartHour: 22,
      nightEndHour: 6,
      keywords: ['마트', '코스트코', '트레이더스', '홈플러스'],
      excludeIndustries: ['restaurant', 'meat_restaurant', 'cafe'],
    },
    bucket: 'personal_use',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName} {amount} ({when}): 주말·심야 마트 결제로 개인사용 가능성이 있습니다.',
  },
  {
    code: 'RISK-NON-BUSINESS',
    name: '사업무관 지출 가능성',
    kind: 'condition',
    condition: all(purchase, any(f('accountCode', 'in', ['134', '338']), f('searchText', 'contains', '$keywords'))),
    params: { keywords: [...KW_NON_BUSINESS] },
    bucket: 'personal_use',
    severity: 'high',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName} {amount}: 사업과 직접 관련 없는 지출(가사·개인)일 수 있습니다. 매입세액 불공제·필요경비 불산입 대상인지 확인하세요.',
  },
  // ── 부가세 ──
  {
    code: 'RISK-VAT-54',
    name: '불공(54) 전표 사람 확인',
    kind: 'condition',
    condition: f('vatType', 'eq', 'purchase_non_deductible'),
    params: {},
    bucket: 'vat_review',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '불공(54) 전표입니다. WEHAGO에서 불공제사유를 선택해야 하므로 사람 확인이 필요합니다. ({vatSummary})',
  },
  {
    code: 'RISK-NON-DEDUCTIBLE-POSSIBLE',
    name: '불공제 가능성 (공제로 판단됨)',
    kind: 'condition',
    condition: all(
      purchase,
      f('deductible', 'eq', true),
      f('vatAmount', 'gt', 0),
      any(f('accountCode', 'in', '$accountCodes'), f('searchText', 'contains', '$keywords')),
    ),
    params: { accountCodes: ['813', '822', '208', '134', '338', '201'], keywords: [...KW_GOLF, '유흥', '상품권', '선물'] },
    bucket: 'vat_review',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName} {amount}: 공제로 판단했지만 불공제 가능성이 있는 거래입니다 ({accountName}). 공제 여부를 확인하세요.',
  },
  {
    code: 'RISK-EXEMPT-BIZ',
    name: '면세사업 관련 매입을 공제로 처리',
    kind: 'condition',
    condition: all(
      purchase,
      f('deductible', 'eq', true),
      f('vatAmount', 'gt', 0),
      any(f('clientVatType', 'in', ['exempt', 'mixed']), f('industry', 'in', '$exemptIndustries')),
    ),
    params: { exemptIndustries: ['academy', 'clinic'] },
    bucket: 'vat_review',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '면세(겸영) 사업 수임처의 매입세액 {vatAmount}을(를) 공제로 처리했습니다. 면세사업 관련분은 불공제입니다 (부가가치세법 제39조①7호).',
  },
  {
    code: 'RISK-LAND',
    name: '토지 관련 지출',
    kind: 'condition',
    condition: all(purchase, any(f('accountCode', 'eq', '201'), f('searchText', 'contains', '$keywords'))),
    params: { keywords: [...KW_LAND] },
    bucket: 'vat_review',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName} {amount}: 토지 관련 지출이면 매입세액이 공제되지 않고 토지 원가에 포함됩니다. 용도를 확인하세요.',
  },
  {
    code: 'RISK-FOREIGN',
    name: '해외결제',
    kind: 'condition',
    condition: f('isForeign', 'eq', true),
    params: {},
    bucket: 'foreign',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName} {amount} ({currency}): 해외결제입니다. 원화 환산액과 대리납부·원천징수 대상 여부를 확인하세요.',
  },
  // ── 이력·패턴 ──
  {
    code: 'RISK-NEW-MERCHANT',
    name: '신규 거래처 고액',
    kind: 'new_merchant_high_amount',
    condition: purchase,
    params: { threshold: 300000 },
    bucket: 'new_merchant',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName}은(는) 처음 거래하는 상대방인데 금액이 {amount}로 기준({threshold}) 이상입니다.',
  },
  {
    code: 'RISK-REPEAT-SAMEDAY',
    name: '같은 날 같은 가맹점 반복 결제',
    kind: 'repeated_abnormal',
    // 매출(소매·음식점 카드매출)은 같은 날 반복이 정상이므로 매입만
    condition: purchase,
    params: { count: 3 },
    bucket: 'duplicate',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName}에서 같은 날({date}) {sameDayCount}건 결제되었습니다. 분할결제·중복 여부를 확인하세요.',
  },
  {
    code: 'RISK-DUP-AMOUNT',
    name: '같은 날·상대방·금액 거래',
    kind: 'duplicate_amount',
    // 매출은 세금계산서·계산서만 (같은 날 같은 금액 카드·현금영수증 매출은 소매업에서 정상)
    condition: any(purchase, f('evidenceType', 'in', ['tax_invoice', 'invoice_exempt'])),
    params: { includeHistory: true },
    bucket: 'duplicate',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{date} {merchantName} {amount} 거래가 {duplicateCount}건 있습니다 (같은 날·상대방·금액{duplicateSource}). 중복 여부를 확인하세요.',
  },
  {
    code: 'RISK-CHANGED',
    name: '과거와 다른 계정',
    kind: 'changed_from_history',
    condition: null,
    params: { minHistory: 2, minShare: 0.6, skipManual: true },
    bucket: 'changed_from_history',
    severity: 'warning',
    blocksAutoApproval: true,
    messageTemplate: '{merchantName}은(는) 과거 {historyCount}건 중 {dominantCount}건을 {dominantAccountName}({dominantAccountCode})로 처리했는데 이번에는 {accountName}({accountCode})입니다.',
  },
  {
    code: 'RISK-SPIKE',
    name: '계정 월합계 급증',
    kind: 'account_spike',
    condition: null,
    params: { ratio: 2, minAmount: 1000000, lookbackMonths: 3 },
    bucket: 'spike',
    severity: 'warning',
    blocksAutoApproval: false,
    messageTemplate: '{accountName} 이번 달 합계 {monthTotal}이(가) 최근 {lookbackMonths}개월 평균 {averageTotal}의 {changeRatio}배입니다.',
  },
  {
    code: 'RISK-UNBALANCED',
    name: '금액 구성 불일치 (분개 차대 불일치)',
    kind: 'unbalanced',
    condition: null,
    params: {},
    bucket: 'vat_review',
    severity: 'high',
    blocksAutoApproval: true,
    messageTemplate: '합계금액 {amount}이(가) 공급가액+부가세+봉사료 {componentsTotal}과(와) {diff} 차이가 나서 분개 차대가 맞지 않습니다.',
  },
]);
