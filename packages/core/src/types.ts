/**
 * MIN TAX OPS — 도메인 공통 타입 (Contract).
 *
 * 모든 패키지(db / adapters / server / web / worker)는 이 타입을 기준으로 동작한다.
 * 금액은 항상 "원" 단위 정수(number, safe integer)로 다룬다. 소수/부동소수 금액 금지.
 * 날짜는 'YYYY-MM-DD' 문자열(LocalDate)로 다룬다. (한국 세무 실무는 KST 일자 기준)
 */

// ────────────────────────────── 기본 값 타입 ──────────────────────────────

/** 원 단위 정수 금액 */
export type Won = number;
/** 'YYYY-MM-DD' */
export type LocalDate = string;
/** 'YYYY-MM' */
export type YearMonth = string;
export type UUID = string;

// ────────────────────────────── 수집 / 원천 ──────────────────────────────

/** 스펙상의 source (증빙 원천). */
export type TransactionSource =
  | 'tax_invoice' // 전자세금계산서 / 계산서
  | 'cash_receipt' // 현금영수증
  | 'business_card' // 사업용 신용카드
  | 'bank' // 통장 거래
  | 'manual' // 수기 입력
  | 'wehago' // WEHAGO 에서 역수입된 전표 (대사용)
  | 'wemembers'; // 위멤버스 (원천 미상 일괄자료)

/** 자료가 들어온 경로 (Integration Adapter). */
export type IngestChannel =
  | 'wemembers_api' // Adapter A
  | 'wemembers_file' // Adapter B
  | 'download_watch' // Adapter C
  | 'cloud_folder' // Adapter D
  | 'desktop_bridge' // Adapter E
  | 'hometax_file' // 홈택스 원본 다운로드 파일
  | 'manual_upload';

/** 증빙 유형 */
export type EvidenceType =
  | 'tax_invoice' // 세금계산서 (과세)
  | 'invoice_exempt' // 계산서 (면세)
  | 'card' // 신용/체크카드 매출전표
  | 'cash_receipt' // 현금영수증 (지출증빙)
  | 'bank' // 통장
  | 'other'; // 기타 (간이영수증 등)

export type Direction = 'purchase' | 'sales';

/**
 * 거래 상태 (Transaction lifecycle)
 *
 * imported → classified → (auto_approved | needs_review) → approved → exported → reconciled
 *             ↘ duplicate (삭제하지 않음) / excluded (사용자 제외) / failed (정규화 실패)
 */
export type TransactionStatus =
  | 'imported'
  | 'classified'
  | 'auto_approved'
  | 'needs_review'
  | 'approved'
  | 'excluded'
  | 'duplicate'
  | 'failed'
  | 'exported'
  | 'reconciled';

/** 분류 결정 주체 */
export type ClassificationSource =
  | 'user_rule' // Rule Studio 사용자 승인 규칙
  | 'exact_history' // 동일 거래처 + 동일 상대방 사업자번호 과거 처리
  | 'name_history' // 동일 거래처 + 동일 상호(정규화) 과거 처리
  | 'correction_memory' // 최근 직원 수정 이력
  | 'industry_pattern' // 동일 업종 타 거래처 반복 패턴
  | 'system_rule' // 시스템 기본 사전 (KT→통신비 등)
  | 'ai' // AI Provider 추론
  | 'manual' // 사람이 직접 지정
  | 'none'; // 미분류

// ────────────────────────────── 정규화 거래 ──────────────────────────────

/** Accounting Data Normalizer 의 출력. 어떤 원천이든 이 구조로 변환된다. */
export interface NormalizedTransaction {
  clientId: UUID;
  /** 거래처(=세무사무소의 고객사) 사업자번호, 숫자 10자리 */
  businessNumber: string;
  source: TransactionSource;
  channel: IngestChannel;
  direction: Direction;
  transactionDate: LocalDate;
  evidenceType: EvidenceType;
  /** 상대방 상호 (원문) */
  merchantName: string;
  /** 상대방 상호 (정규화 키) — normalizeMerchantName() */
  merchantKey: string;
  /** 상대방 사업자번호 숫자 10자리, 없으면 null */
  merchantBusinessNumber: string | null;
  /** 가맹점 업종/과세유형 등 원천자료가 제공하는 부가정보 */
  merchantCategory: string | null;
  /** 상대방 과세유형 (원천자료가 제공할 때만): general(일반) / simplified(간이) / exempt(면세) / unknown */
  merchantTaxType: 'general' | 'simplified' | 'exempt' | 'unknown';
  description: string;
  supplyAmount: Won;
  vatAmount: Won;
  /** 봉사료 등 공급가액·부가세 외 금액 */
  serviceCharge: Won;
  totalAmount: Won;
  /** 카드번호 마스킹 (앞 4, 뒤 4만 남김) */
  cardNumberMasked: string | null;
  /** 세금계산서 승인번호 / 현금영수증 승인번호 / 카드 승인번호 */
  approvalNumber: string | null;
  /** 원천 시스템 고유 ID (있으면 fingerprint 보다 우선) */
  originalSourceId: string | null;
  /** 해외결제 여부 / 통화 */
  currency: string;
  isForeign: boolean;
  /** 원천자료가 제시한 공제여부 (홈택스 카드 '공제/불공제' 등) — 참고용 */
  sourceDeductibleHint: boolean | null;
  /** 원본 행 전체 (감사·재처리용) */
  rawData: Record<string, unknown>;
  /** 원본 파일 내 행 번호 (1-base, 헤더 제외) */
  sourceRowNumber: number | null;
  fingerprint: string;
}

/** 정규화 실패 행 — 절대 조용히 버리지 않는다. */
export interface NormalizationFailure {
  sourceRowNumber: number;
  rawData: Record<string, unknown>;
  /** 사용자에게 보여줄 한국어 사유 */
  reason: string;
  field?: string;
}

// ────────────────────────────── 거래처 (고객사) ──────────────────────────────

export type BusinessType = 'corporation' | 'individual';
export type VatTaxpayerType = 'general' | 'simplified' | 'exempt' | 'mixed';

export interface ClientProfile {
  id: UUID;
  name: string;
  businessNumber: string;
  businessType: BusinessType;
  vatType: VatTaxpayerType;
  /** 업종 대분류 키 (INDUSTRIES 참고) */
  industry: IndustryKey;
  /** 업종코드 (국세청 6자리) */
  industryCode: string | null;
  /** 의제매입세액공제 대상 업종 여부 */
  deemedInputTaxEligible: boolean;
  /** 업무용승용차 (부가세 불공제 대상 차량) 번호 목록 */
  nonDeductibleVehicles: string[];
}

export type IndustryKey =
  | 'restaurant' // 음식점
  | 'meat_restaurant' // 정육식당
  | 'construction' // 건설업
  | 'ecommerce' // 전자상거래
  | 'interior' // 인테리어
  | 'service' // 서비스업
  | 'academy' // 학원 (면세)
  | 'clinic' // 병·의원 (면세)
  | 'wholesale_retail' // 도소매
  | 'rental' // 임대업
  | 'manufacturing' // 제조업
  | 'it_service' // IT·소프트웨어
  | 'design' // 디자인
  | 'cafe' // 카페
  | 'other';

// ────────────────────────────── 계정과목 ──────────────────────────────

export interface AccountCode {
  /** WEHAGO(더존) 계정코드 문자열, 예: '830' */
  code: string;
  name: string;
  /** asset | liability | equity | revenue | expense | cogs */
  category: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'cogs';
  /** 자산 계정 여부 (고정자산 가능성 판단용) */
  isFixedAsset?: boolean;
  /** 이 계정 사용 시 부가세 불공제 가능성이 높음 (예: 접대비) */
  vatNonDeductibleHint?: boolean;
  active: boolean;
}

// ────────────────────────────── 조건 DSL ──────────────────────────────

export type ConditionOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'regex'
  | 'in'
  | 'not_in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'is_empty'
  | 'is_not_empty';

/** DSL 이 참조할 수 있는 거래 필드 */
export type ConditionField =
  | 'merchantName'
  | 'merchantKey'
  | 'merchantBusinessNumber'
  | 'merchantCategory'
  | 'merchantTaxType'
  | 'description'
  | 'evidenceType'
  | 'direction'
  | 'supplyAmount'
  | 'vatAmount'
  | 'totalAmount'
  | 'cardNumberMasked'
  | 'isForeign'
  | 'currency'
  | 'weekday' // 0(일)~6(토)
  | 'dayOfMonth'
  | 'accountCode' // 분류 결과 계정 (VAT/Risk 규칙용)
  | 'industry'; // 거래처 업종

export interface ConditionLeaf {
  field: ConditionField;
  op: ConditionOperator;
  value?: string | number | boolean | Array<string | number>;
  /** 문자열 비교 시 대소문자 무시 (기본 true) */
  ignoreCase?: boolean;
}

export type Condition = ConditionLeaf | { all: Condition[] } | { any: Condition[] } | { not: Condition };

// ────────────────────────────── 분류 결과 ──────────────────────────────

export interface ClassificationEvidence {
  /** 적용된 규칙 ID (user_rule / system_rule) */
  ruleId?: UUID | string;
  ruleName?: string;
  /** 참조한 과거 거래 수 */
  historyCount?: number;
  /** 그 중 동일 계정으로 처리된 수 */
  consistentCount?: number;
  lastUsedDate?: LocalDate;
  averageAmount?: Won;
  /** 최근 수정 이력 수 */
  correctionCount?: number;
  /** 참조한 타 거래처 수 (업종 패턴) */
  peerClientCount?: number;
  aiProvider?: string;
  aiModel?: string;
}

export interface AccountClassification {
  accountCode: string | null;
  accountName: string | null;
  /** 0 ~ 100 정수 */
  confidence: number;
  source: ClassificationSource;
  /** 사람이 읽는 한 줄 근거 (Grid 에 노출) */
  summary: string;
  /** 상세 근거 목록 (Explainability 패널) */
  reasons: string[];
  evidence: ClassificationEvidence;
  /** 1순위와 경쟁하는 다른 후보 (계정 충돌 판단용) */
  alternatives: Array<{ accountCode: string; accountName: string; confidence: number; source: ClassificationSource }>;
}

/**
 * 부가세 유형 — WEHAGO(더존) 매입매출전표 유형코드와 매핑된다.
 * 실제 코드값 매핑은 adapters/wehago 의 템플릿이 관리한다 (하드코딩 금지).
 */
export type VatType =
  | 'purchase_taxable' // 과세매입 (세금계산서)
  | 'purchase_exempt' // 면세매입 (계산서)
  | 'purchase_card' // 카드과세매입
  | 'purchase_card_exempt' // 카드면세매입
  | 'purchase_cash_receipt' // 현금영수증 과세매입
  | 'purchase_cash_receipt_exempt'
  | 'purchase_non_deductible' // 불공제 (세금계산서 수취분)
  | 'purchase_no_evidence' // 적격증빙 아님 / 부가세 무관 (일반전표 처리)
  | 'sales_taxable'
  | 'sales_exempt'
  | 'sales_card'
  | 'sales_cash_receipt'
  | 'sales_other';

export interface VatClassification {
  vatType: VatType;
  /** true 공제 / false 불공제 / null 판단불가(검토필요) */
  deductible: boolean | null;
  /** 불공제 사유 코드 (vat rule id) */
  nonDeductibleReasonCode: string | null;
  confidence: number;
  summary: string;
  reasons: string[];
  ruleIds: string[];
}

// ────────────────────────────── 고위험 / 예외 ──────────────────────────────

export type RiskSeverity = 'info' | 'warning' | 'high';

/** Exception Inbox 필터 버킷 */
export type ExceptionBucket =
  | 'low_confidence' // 저신뢰도
  | 'new_merchant' // 신규거래처
  | 'vat_review' // 공제/불공제 검토
  | 'account_conflict' // 계정과목 충돌
  | 'changed_from_history' // 전월과 다른 분개
  | 'high_amount' // 고액거래
  | 'duplicate' // 중복
  | 'unclassified' // 미분류
  | 'possible_asset' // 자산 가능성
  | 'personal_use' // 개인사용 가능성
  | 'entertainment' // 접대 관련 가능
  | 'vehicle' // 업무용승용차 관련
  | 'foreign' // 해외결제
  | 'spike' // 전월 대비 급증
  | 'export_error'; // WEHAGO 전송오류

export interface RiskFlag {
  ruleCode: string;
  ruleName: string;
  bucket: ExceptionBucket;
  severity: RiskSeverity;
  /** 이 플래그가 있으면 confidence 와 무관하게 자동승인 금지 */
  blocksAutoApproval: boolean;
  message: string;
}

// ────────────────────────────── 정책 ──────────────────────────────

export interface ConfidencePolicy {
  /** 이 값 이상 → 자동승인 (기본 95) */
  autoApproveMin: number;
  /** 이 값 이상 → 빠른검토 (기본 80), 미만 → 반드시 검토 */
  quickReviewMin: number;
  /** 동일 수정 N회 이상 → 영구규칙 제안 (기본 3) */
  ruleSuggestionThreshold: number;
}

export type ReviewLevel = 'auto' | 'quick_review' | 'must_review';

/** 한 거래에 대한 전체 판단 결과 (분류 파이프라인 출력) */
export interface TransactionDecision {
  account: AccountClassification;
  vat: VatClassification;
  risks: RiskFlag[];
  reviewLevel: ReviewLevel;
  /** 최종 상태 제안: auto_approved | needs_review */
  status: Extract<TransactionStatus, 'auto_approved' | 'needs_review'>;
  buckets: ExceptionBucket[];
}

// ────────────────────────────── 학습 (Correction) ──────────────────────────────

export interface CorrectionRecord {
  clientId: UUID;
  merchantKey: string;
  merchantBusinessNumber: string | null;
  field: 'account' | 'vat';
  before: string | null;
  after: string;
  userId: UUID;
  transactionId: UUID;
  createdAt: string; // ISO
  reason?: string;
}

export type MappingRuleStatus = 'suggested' | 'active' | 'disabled' | 'rejected';
export type MappingRuleOrigin = 'user' | 'system_suggested' | 'system_default';

export interface MappingRule {
  id: UUID | string;
  /** null = 전 거래처 공통 (system_default 전용) */
  clientId: UUID | null;
  name: string;
  condition: Condition;
  accountCode: string;
  accountName: string;
  /** 규칙이 VAT 판단도 지정하는 경우 */
  vatOverride?: { deductible: boolean; reasonCode?: string } | null;
  confidence: number;
  /** 높을수록 먼저 평가 */
  priority: number;
  status: MappingRuleStatus;
  origin: MappingRuleOrigin;
}

// ────────────────────────────── 과거 처리 이력 (Level 1~3 조회용) ──────────────────────────────

export interface HistoryEntry {
  clientId: UUID;
  merchantKey: string;
  merchantBusinessNumber: string | null;
  accountCode: string;
  accountName: string;
  transactionDate: LocalDate;
  totalAmount: Won;
  /** 이 이력이 사람의 수정으로 확정되었는지 */
  corrected: boolean;
  industry: IndustryKey;
}

// ────────────────────────────── 분개 (Journal) ──────────────────────────────

export interface JournalLine {
  side: 'debit' | 'credit';
  accountCode: string;
  accountName: string;
  amount: Won;
  counterpartyName?: string;
  counterpartyBusinessNumber?: string | null;
  memo?: string;
}

export interface JournalEntry {
  transactionId: UUID;
  date: LocalDate;
  lines: JournalLine[];
}

// ────────────────────────────── 대사 (Reconciliation) ──────────────────────────────

export interface AmountTotals {
  count: number;
  supplyAmount: Won;
  vatAmount: Won;
  totalAmount: Won;
}

export type ReconStage = 'source' | 'processed' | 'export' | 'wehago';

export interface ReconDiscrepancy {
  kind:
    | 'duplicate_excluded'
    | 'user_excluded'
    | 'parse_failed'
    | 'pending_review'
    | 'missing_in_export'
    | 'extra_in_export'
    | 'amount_mismatch'
    | 'missing_in_wehago'
    | 'extra_in_wehago'
    | 'unexplained';
  transactionId?: UUID;
  sourceRowNumber?: number;
  date?: LocalDate;
  merchantName?: string;
  amount?: Won;
  /** 사용자에게 보여줄 완결된 한국어 설명 */
  message: string;
  /** 대사 차단 여부 (설명된 차이는 false) */
  blocking: boolean;
}

export interface ReconciliationReport {
  stages: Partial<Record<ReconStage, AmountTotals>>;
  byEvidenceType: Record<string, Partial<Record<ReconStage, AmountTotals>>>;
  byAccount: Record<string, Partial<Record<ReconStage, AmountTotals>>>;
  discrepancies: ReconDiscrepancy[];
  /** 모든 단계 합계가 1원 단위까지 설명되었는가 */
  balanced: boolean;
  /** WEHAGO 전송 가능 여부 (balanced && 미검토 0 && blocking 0) */
  exportAllowed: boolean;
  summary: string;
}

// ────────────────────────────── 인건비 ──────────────────────────────

export type IncomeType = 'earned' | 'business' | 'daily';

export interface EmployeeSnapshot {
  employeeId: UUID;
  name: string;
  incomeType: IncomeType;
  /** 식별번호 존재 여부만 (원문 사용 금지) */
  hasIdNumber: boolean;
  idNumberMasked: string | null;
  hireDate: LocalDate | null;
  resignDate: LocalDate | null;
}

export interface PayrollLine {
  employeeId: UUID;
  name: string;
  incomeType: IncomeType;
  /** 과세 급여/지급액 합계 */
  taxablePay: Won;
  /** 비과세 합계 */
  nonTaxablePay: Won;
  /** 지급총액 = taxable + nonTaxable */
  grossPay: Won;
  /** 수당 상세 */
  allowances: Record<string, Won>;
  /** 일용직: 근무일수 */
  workDays?: number;
  incomeTax: Won;
  localIncomeTax: Won;
  /** 4대보험 등 기타 공제 */
  otherDeductions: Won;
  netPay: Won;
  paymentDate: LocalDate | null;
}

export type PayrollChangeKind =
  | 'unchanged'
  | 'pay_changed'
  | 'pay_changed_large' // ±임계치(기본 20%) 이상
  | 'new_hire'
  | 'missing_this_month' // 전월 있었는데 이번달 없음 → 퇴사 확인
  | 'resigned'
  | 'zero_pay'
  | 'missing_id'
  | 'income_type_changed';

export interface PayrollChange {
  employeeId: UUID;
  name: string;
  incomeType: IncomeType;
  kinds: PayrollChangeKind[];
  previous: PayrollLine | null;
  current: PayrollLine | null;
  /** 증감률 (%) */
  changeRate: number | null;
  /** 검토 필요 여부 (unchanged 만 false) */
  needsReview: boolean;
  severity: RiskSeverity;
  messages: string[];
}

// ────────────────────────────── 통합 상태 (환각 방지) ──────────────────────────────

export type IntegrationStatus = 'LIVE' | 'FILE_BASED' | 'RPA' | 'MOCK' | 'NOT_AVAILABLE';

export interface IntegrationDescriptor {
  key: string;
  name: string;
  status: IntegrationStatus;
  /** 상태의 근거 (문서 / 미확인 사유) */
  statusReason: string;
  capabilities: string[];
  docsRef?: string;
}

// ────────────────────────────── 파이프라인 상태 ──────────────────────────────

export type ClientPipelineStage =
  | 'collected' // 수집완료
  | 'auto_classified' // 자동분개완료
  | 'needs_review' // 예외검토필요
  | 'reviewed' // 검토완료
  | 'export_ready' // WEHAGO 전송준비
  | 'exported' // WEHAGO 전송(파일생성/업로드)
  | 'reconciled'; // 대사완료

export type FilingStep =
  | 'payroll_input' // 인건비 입력
  | 'earned_confirmed' // 급여확정
  | 'business_confirmed' // 사업소득확정
  | 'daily_confirmed' // 일용직확정
  | 'withholding_ready' // 원천세 준비
  | 'simplified_statement_ready' // 간이지급명세서 준비
  | 'local_tax_ready' // 지방소득세 준비
  | 'filed' // 신고완료
  | 'receipt_collected' // 접수증 수집
  | 'payment_slip_collected'; // 납부서 수집

// ────────────────────────────── 권한 ──────────────────────────────

export type Role = 'admin' | 'manager' | 'staff' | 'viewer';

export type Permission =
  | 'transactions.read'
  | 'transactions.review' // 승인/수정/제외
  | 'rules.read'
  | 'rules.write'
  | 'rules.approve' // System Suggested → User Approved
  | 'export.create'
  | 'export.download'
  | 'payroll.read'
  | 'payroll.write'
  | 'payroll.sensitive' // 주민번호 등 복호화 열람
  | 'filing.write'
  | 'clients.read'
  | 'clients.write'
  | 'imports.create'
  | 'audit.read'
  | 'audit.revert'
  | 'settings.write'
  | 'users.manage'
  | 'integrations.developer';

// ────────────────────────────── Job ──────────────────────────────

export type JobType =
  | 'import_file'
  | 'classify_batch'
  | 'export_wehago'
  | 'reconcile'
  | 'payroll_prepare'
  | 'ai_review'
  | 'kpi_snapshot';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

// ────────────────────────────── AI Review ──────────────────────────────

export interface LedgerAnomaly {
  code: string;
  clientId: UUID;
  title: string;
  /** 예: "접대비 3개월 평균 240만원 → 이번달 890만원" */
  detail: string;
  severity: RiskSeverity;
  metric?: { current: number; baseline: number; changeRate: number };
  /** 클릭 시 이동할 필터 */
  action?: { label: string; href: string };
}

// ────────────────────────────── AI Provider 입출력 (packages/ai 구현) ──────────────────────────────

export interface AIClassificationInput {
  /** 개인식별정보(주민번호/카드 전체번호/계좌) 절대 포함 금지 */
  merchantName: string;
  merchantCategory: string | null;
  description: string;
  totalAmount: Won;
  evidenceType: EvidenceType;
  direction: Direction;
  industry: IndustryKey;
  candidateAccounts: Array<{ code: string; name: string }>;
  /** 같은 거래처의 유사 과거 처리 예시 (최대 10) */
  similarExamples: Array<{ merchantName: string; accountCode: string; accountName: string; count: number }>;
}

export interface AIClassificationSuggestion {
  accountCode: string;
  accountName: string;
  /** Provider 가 낸 값과 무관하게 엔진이 상한(기본 85)을 적용한다 */
  confidence: number;
  rationale: string;
  provider: string;
  model: string | null;
}
