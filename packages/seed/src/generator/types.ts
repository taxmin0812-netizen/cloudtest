import type {
  BusinessType,
  ExceptionBucket,
  IncomeType,
  IndustryKey,
  LocalDate,
  NormalizedTransaction,
  PayrollChangeKind,
  PayrollLine,
  TransactionStatus,
  VatTaxpayerType,
  VatType,
  Won,
  YearMonth,
} from '@mintax/core';

/**
 * 합성 데이터 생성기의 출력 타입.
 * UUID 는 만들지 않는다 — 거래처는 코드('C001'), 직원은 참조('C002-E01')로 가리키고 로더가 UUID 로 바꾼다.
 */

// ────────────────────────────── 거래처 ──────────────────────────────

export interface SyntheticVehicle {
  plate: string;
  /** 승용(passenger)·승합(van)·화물(truck) */
  kind: 'passenger' | 'van' | 'truck';
  model: string;
  /** 개별소비세 과세 승용차 → 매입세액 불공제 (부가세법 제39조①5호) */
  nonDeductible: boolean;
}

export interface SyntheticCard {
  masked: string;
  company: string;
  alias: string;
  /** 법인카드 / 대표자 개인카드(사업용 등록) 구분 */
  holderType: 'corporate' | 'owner' | 'employee';
}

export interface SyntheticClient {
  code: string;
  name: string;
  representativeName: string;
  businessNumber: string;
  businessType: BusinessType;
  vatType: VatTaxpayerType;
  industry: IndustryKey;
  industryName: string;
  /** 국세청 업종코드 — 합성 데이터에는 넣지 않는다 (실제 코드는 검증필요) */
  industryCode: string | null;
  deemedInputTaxEligible: boolean;
  vehicles: SyntheticVehicle[];
  /** ClientProfile.nonDeductibleVehicles 와 같은 값 (vehicles 중 nonDeductible 차량번호) */
  nonDeductibleVehicles: string[];
  cards: SyntheticCard[];
  withholdingSemiannual: boolean;
  address: string;
  email: string;
  /** 시나리오 표식 (예: 'scenario_a', 'scenario_payroll') */
  tags: string[];
  notes: string;
}

// ────────────────────────────── 가맹점 / 상대방 ──────────────────────────────

export type MerchantTaxType = 'general' | 'simplified' | 'exempt';

export type EvidenceKind = 'card' | 'cash_receipt' | 'tax_invoice' | 'invoice_exempt';

export interface SyntheticMerchant {
  id: string;
  name: string;
  /** 브랜드(정규화 전) — 같은 브랜드 여러 지점을 묶는다 */
  brand: string;
  kind: MerchantKind;
  businessNumber: string | null;
  taxType: MerchantTaxType;
  /** 법인 가맹점 여부 (홈택스 가맹점유형 '법인사업자') */
  corporate: boolean;
  /** 업태 */
  bizType: string;
  /** 업종 (홈택스 카드 엑셀 '업종' — merchantCategory) */
  category: string;
  /** 주 증빙 */
  evidence: EvidenceKind;
  /** 해외 가맹점 (USD) */
  foreign: boolean;
  currency: string;
  /** 합계금액 분포 (원) — 해외는 USD 센트 단위가 아니라 원화 환산 후 금액 */
  amount: { median: Won; sigma: number; min: Won; max: Won; unit: Won };
  /** 세금계산서·계산서 품목명 후보 */
  items: string[];
  representativeName: string;
  address: string;
  email: string;
}

export type MerchantKind =
  | 'coffee'
  | 'restaurant_meal'
  | 'fine_dining'
  | 'convenience'
  | 'delivery_app'
  | 'telecom'
  | 'utility_power'
  | 'utility_gas'
  | 'fuel'
  | 'toll'
  | 'parking'
  | 'taxi'
  | 'train'
  | 'airline'
  | 'lodging'
  | 'ecommerce_market'
  | 'office_supply'
  | 'daiso'
  | 'mart'
  | 'dept_store'
  | 'electronics'
  | 'furniture'
  | 'saas_foreign'
  | 'saas_domestic'
  | 'advertising'
  | 'courier'
  | 'packaging'
  | 'printing'
  | 'bookstore'
  | 'golf'
  | 'bar'
  | 'flowers'
  | 'food_wholesale_exempt'
  | 'meat_supplier'
  | 'coffee_beans'
  | 'dairy_supplier'
  | 'building_materials'
  | 'hardware_tools'
  | 'machine_parts'
  | 'goods_supplier'
  | 'medical_supplies'
  | 'education_materials'
  | 'rent'
  | 'building_mgmt'
  | 'professional_fee'
  | 'security_service'
  | 'rental_equipment'
  | 'waste_disposal'
  | 'government_fee'
  | 'insurance'
  | 'unknown';

/** 매출 상대방 (가상 B2B 고객) */
export interface SyntheticCustomer {
  id: string;
  name: string;
  businessNumber: string;
  representativeName: string;
  address: string;
  email: string;
}

// ────────────────────────────── 거래 ──────────────────────────────

/** 정답 레이블 (사람이 최종 확정한 값) */
export interface GroundTruth {
  accountCode: string;
  accountName: string;
  /** 확정 공제여부. 매출은 엔진 관례대로 true */
  deductible: boolean;
  vatType: VatType;
  /** 실제 부가세가 있는데 불공제일 때만 사유 코드 (vat rule code) */
  nonDeductibleReasonCode: string | null;
  /** 이 거래가 Exception Inbox 에서 걸려야 하는 버킷 (의도적 이상치·시나리오 거래만 지정) */
  expectedBuckets?: ExceptionBucket[];
  /** 기대 최종 상태 (중복 → 'duplicate') */
  expectedStatus?: TransactionStatus;
  /** 완전중복 원거래 id */
  duplicateOf?: string;
  /** 중복 의심 상대 id (실제로는 별개 거래) */
  possibleDuplicateOf?: string;
  /** 이력: 사람이 엔진 추천을 수정해 확정한 거래 */
  corrected?: boolean;
  note?: string;
}

export type AnomalyKind =
  | 'exact_duplicate'
  | 'possible_duplicate'
  | 'unclassifiable_merchant'
  | 'asset_purchase'
  | 'entertainment'
  | 'personal_use'
  | 'foreign_saas'
  | 'vat_mismatch'
  | 'new_merchant_high_amount'
  | 'account_spike'
  | 'parse_failure'
  | 'cancel_negative'
  | 'treatment_changed'
  | 'correction_target';

/**
 * NormalizedTransaction 과 같은 모양 + 합성 메타. clientId(UUID) 대신 clientCode.
 * fingerprint 는 clientId 자리에 clientCode 를 넣어 계산한 값이다 → 로더는 toNormalizedTransaction() 으로 재계산.
 */
export interface SyntheticTransaction extends Omit<NormalizedTransaction, 'clientId'> {
  /** 안정 ID: 'C001-2026-09-0001' */
  id: string;
  clientCode: string;
  period: YearMonth;
  /** 이력: approved/exported, 당월: imported */
  status: TransactionStatus;
  /** 가맹점 우주 참조 (신규·미상 가맹점은 null) */
  merchantId: string | null;
  truth: GroundTruth;
  anomalies: AnomalyKind[];
  /** 시나리오 표식 (예: 'scenario1:new_merchant') */
  scenarioTags: string[];
}

/** 정규화 실패로 남아야 하는 원본 행 (절대 조용히 버리지 않는다) */
export interface SyntheticFailureRow {
  id: string;
  clientCode: string;
  period: YearMonth;
  fileKind: SyntheticFileKind;
  /** 헤더 → 값 */
  rawData: Record<string, unknown>;
  failedField: string;
  expectedReason: string;
  anomalies: AnomalyKind[];
}

export type SyntheticFileKind =
  | 'card_purchase'
  | 'card_purchase_resend'
  | 'cash_receipt_purchase'
  | 'tax_invoice_purchase'
  | 'tax_invoice_sales'
  | 'invoice_exempt_purchase'
  | 'invoice_exempt_sales'
  | 'card_sales'
  | 'cash_receipt_sales';

// ────────────────────────────── 이상치 매니페스트 ──────────────────────────────

export interface AnomalyEntry {
  kind: AnomalyKind;
  clientCode: string;
  /** 관련 거래 id (실패행은 SyntheticFailureRow.id) */
  transactionIds: string[];
  description: string;
  metric?: { current: Won; baseline: Won; changeRate: number };
}

export interface AnomalyManifest {
  entries: AnomalyEntry[];
  counts: Record<AnomalyKind, number>;
}

// ────────────────────────────── 인건비 ──────────────────────────────

export interface SyntheticEmployee {
  /** 'C002-E01' */
  ref: string;
  clientCode: string;
  name: string;
  incomeType: IncomeType;
  /** 가짜 주민번호 평문 — 로더가 암호화·마스킹한다. 없으면 null (missing_id 시나리오) */
  residentNumber: string | null;
  isForeigner: boolean;
  hireDate: LocalDate | null;
  /** 사무소 마스터 기준 퇴사일 (생성 시점에 사무소가 아는 값) */
  resignDate: LocalDate | null;
  baseSalary: Won;
  allowances: Record<string, Won>;
  nonTaxable: Record<string, Won>;
  dailyWage: Won | null;
  /** 사업소득 업종코드 — 합성 기본값, 검증필요 */
  businessIncomeCode: string | null;
  paymentDay: number;
  dependents: number;
  /** 이번 달(2026-09) 신규 입사자 — 마스터에는 9월에 등록됨 */
  joinedInCurrentMonth: boolean;
  /** 정답: 실제 퇴사일 (마스터에는 아직 반영 안 됨) */
  truthResignDate: LocalDate | null;
}

export interface SyntheticPayrollLine extends Omit<PayrollLine, 'employeeId'> {
  employeeRef: string;
  clientCode: string;
  /** 귀속월 */
  period: YearMonth;
}

export interface ExpectedPayrollChange {
  clientCode: string;
  employeeRef: string;
  name: string;
  kinds: PayrollChangeKind[];
  /** 지급총액 증감률 (%) 소수 1자리 */
  changeRate: number | null;
}

export interface SyntheticPayroll {
  employees: SyntheticEmployee[];
  /** 2026-03 ~ 2026-08 확정분 */
  history: SyntheticPayrollLine[];
  /** 2026-09 수임처 제출분 (변동 포함, 미확정) */
  current: SyntheticPayrollLine[];
  /** 2026-08 → 2026-09 기대 변동 (needsReview 대상만) */
  expectedChanges: ExpectedPayrollChange[];
  /** 거래처별 기대 요약 (unchanged 포함) */
  expectedSummary: Record<string, Partial<Record<PayrollChangeKind, number>>>;
}

// ────────────────────────────── 데이터셋 ──────────────────────────────

export interface LedgerAnomalyExpectation {
  code: string;
  clientCode: string;
  accountCode: string;
  title: string;
  baseline: Won;
  current: Won;
  transactionIds: string[];
}

export interface DatasetStats {
  clients: number;
  merchants: number;
  customers: number;
  historyTransactions: number;
  currentTransactions: number;
  failureRows: number;
  historyByMonth: Record<YearMonth, number>;
  currentByEvidence: Record<string, number>;
  currentByClient: Record<string, number>;
  cardPurchasesByClientCurrent: Record<string, number>;
  employees: number;
  payrollHistoryLines: number;
  payrollCurrentLines: number;
  anomalies: Record<AnomalyKind, number>;
}

export interface SyntheticDataset {
  seed: number;
  historyMonths: YearMonth[];
  currentMonth: YearMonth;
  clients: SyntheticClient[];
  merchants: SyntheticMerchant[];
  customers: SyntheticCustomer[];
  /** 확정 이력 (정답 = 확정값) */
  history: SyntheticTransaction[];
  /** 당월 미분류 원천자료 */
  current: SyntheticTransaction[];
  /** 당월 정규화 실패 행 */
  failures: SyntheticFailureRow[];
  payroll: SyntheticPayroll;
  anomalies: AnomalyManifest;
  ledgerAnomalies: LedgerAnomalyExpectation[];
  stats: DatasetStats;
}
