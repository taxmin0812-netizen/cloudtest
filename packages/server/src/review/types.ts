/**
 * 예외 검토 (review area) DTO — 모두 JSON 직렬화 가능 (금액 number, 시각 ISO 문자열).
 */
import type {
  AccountClassification,
  ClassificationSource,
  Direction,
  ExceptionBucket,
  ReviewLevel,
  RiskSeverity,
  TransactionStatus,
  VatClassification,
  VatType,
} from '@mintax/core';
import type { ExceptionSort } from './helpers';

export type { ExceptionSort } from './helpers';

// ────────────────────────────── 상태 스냅샷 (감사로그 before/after · 되돌리기) ──────────────────────────────

/** 사람 처리로 바뀌는 거래 필드 전부. 감사로그 before/after 와 되돌리기가 이 모양을 쓴다. 민감정보 없음. */
export interface TxState {
  status: TransactionStatus;
  accountCode: string | null;
  accountName: string | null;
  accountConfidence: number | null;
  classificationSource: ClassificationSource | null;
  classificationSummary: string | null;
  vatType: string | null;
  deductible: boolean | null;
  vatConfidence: number | null;
  vatReasonCode: string | null;
  confidenceScore: number | null;
  reviewedBy: string | null;
  /** ISO */
  reviewedAt: string | null;
  excludedReason: string | null;
  buckets: ExceptionBucket[];
  exportJobId: string | null;
}

// ────────────────────────────── 예외함 목록 ──────────────────────────────

export interface RiskFlagShort {
  code: string;
  label: string;
  bucket: ExceptionBucket;
  severity: RiskSeverity;
  blocksAutoApproval: boolean;
  message: string;
}

export interface AlternativeDto {
  accountCode: string;
  accountName: string;
  confidence: number;
  source: ClassificationSource;
}

export interface ExceptionRow {
  id: string;
  clientId: string;
  clientName: string;
  period: string;
  /** 'YYYY-MM-DD' */
  date: string;
  direction: Direction;
  merchantName: string;
  merchantBusinessNumber: string | null;
  description: string;
  supplyAmount: number;
  vatAmount: number;
  totalAmount: number;
  evidenceType: string;
  accountCode: string | null;
  accountName: string | null;
  classificationSource: ClassificationSource | null;
  vatType: string | null;
  deductible: boolean | null;
  /** 계정·부가세 신뢰도 중 낮은 값 (confidence_score) */
  confidence: number | null;
  accountConfidence: number | null;
  vatConfidence: number | null;
  /** 한 줄 근거 (엔진 요약) */
  summary: string;
  buckets: ExceptionBucket[];
  /** 심각도 높은 순 */
  riskFlags: RiskFlagShort[];
  reviewLevel: ReviewLevel | null;
  status: TransactionStatus;
  /** 다른 후보 최대 3개 (최신 분류 결과) */
  alternatives: AlternativeDto[];
  touchCount: number;
  reviewedAt: string | null;
}

export interface ExceptionFilters {
  period: string;
  clientId?: string | null;
  /** 여러 개면 "하나라도 해당" (OR) */
  buckets?: ExceptionBucket[] | null;
  reviewLevel?: ReviewLevel | ReviewLevel[] | null;
  /** 상호·적요·계정명·수임처명·사업자번호 일부·금액(정확히) */
  search?: string | null;
  evidenceTypes?: string[] | null;
  direction?: Direction | null;
  /** confidence_score 범위 (포함) */
  confidenceMin?: number | null;
  confidenceMax?: number | null;
  /** pending(기본): 검토 필요 + 전송오류 / processed_today: 오늘(KST) 사람이 처리한 거래 */
  view?: 'pending' | 'processed_today';
}

export interface ListExceptionsInput extends ExceptionFilters {
  /** 기본 'risk' (위험 심각도 → 신뢰도 오름차순 → 금액 내림차순) */
  sort?: ExceptionSort;
  cursor?: string | null;
  /** 기본 200, 최대 1000 */
  limit?: number;
}

export interface ListExceptionsResult {
  rows: ExceptionRow[];
  nextCursor: string | null;
  /** 필터 조건 전체 건수 (커서 무관) */
  total: number;
  /** 필터 조건 전체 합계금액 */
  totalAmount: number;
}

export interface ExceptionCounts {
  period: string;
  clientId: string | null;
  /** 예외함 전체 (검토 필요 + 전송오류) */
  total: number;
  totalAmount: number;
  needsReview: number;
  exportErrors: number;
  /** 오늘(KST) 사람이 처리한 거래 수 */
  processedToday: number;
  byBucket: Record<ExceptionBucket, number>;
  amountByBucket: Record<ExceptionBucket, number>;
  /** 필터 칩용: 건수 있는 버킷만, 건수 내림차순 */
  bucketChips: Array<{ bucket: ExceptionBucket; label: string; count: number; amount: number }>;
  byReviewLevel: Record<ReviewLevel, number>;
  byClient: Array<{ clientId: string; clientName: string; count: number; amount: number; mustReview: number; quickReview: number; exportErrors: number }>;
}

export interface NextExceptionInput {
  currentId: string;
  filters: ExceptionFilters & { sort?: ExceptionSort };
}

export interface NextExceptionResult {
  next: ExceptionRow | null;
  /** 현재 거래를 뺀 남은 예외 건수 */
  remaining: number;
  /** 목록 끝에서 처음으로 돌아갔는가 */
  wrapped: boolean;
}

// ────────────────────────────── 빠른 검토 ──────────────────────────────

export interface QuickReviewGroup {
  /** 묶음 키: 수임처|상호키|계정|부가세유형|공제여부 */
  key: string;
  clientId: string;
  clientName: string;
  merchantKey: string;
  merchantName: string;
  accountCode: string | null;
  accountName: string | null;
  vatType: string | null;
  deductible: boolean | null;
  count: number;
  totalAmount: number;
  minConfidence: number | null;
  avgConfidence: number | null;
  summary: string;
  /** 이상치를 뺀 묶음 승인 대상 */
  approvableIds: string[];
  approvableAmount: number;
  outliers: Array<{ id: string; date: string; totalAmount: number; reason: string }>;
  /** 펼치기용 (최대 50) */
  items: Array<{ id: string; date: string; totalAmount: number; description: string; outlier: boolean }>;
}

export interface QuickReviewResult {
  period: string;
  groups: QuickReviewGroup[];
  totalTransactions: number;
  totalGroups: number;
  outlierRatio: number;
}

// ────────────────────────────── 처리 결과 ──────────────────────────────

export interface SkippedItem {
  id: string;
  reason: string;
}

export interface ApproveInput {
  ids: string[];
  note?: string | null;
  /** true 면 자동확정 차단 위험이 있는 거래는 건너뛴다 (일괄 승인 사전 점검의 기본 선택) */
  excludeBlockingRisks?: boolean;
}

export interface ApproveResult {
  approved: number;
  approvedIds: string[];
  skipped: SkippedItem[];
  /** 되돌리기(Ctrl+Z) 핸들: 1건이면 그 거래의 감사로그, 여러 건이면 묶음 감사로그 */
  auditLogId: string | null;
}

export interface ApprovalPreview {
  selected: number;
  approvable: { count: number; amount: number; ids: string[] };
  blockedByRisk: Array<{ id: string; merchantName: string; totalAmount: number; buckets: ExceptionBucket[]; reason: string }>;
  ineligible: SkippedItem[];
  /** "선택 42건 중 39건을 승인합니다. 3건은 자동확정 차단 위험(고액 2, 자산 가능성 1)이 있어 제외했습니다." */
  message: string;
}

export interface CorrectInput {
  id: string;
  accountCode?: string | null;
  vatDeductible?: boolean | null;
  vatType?: VatType | null;
  reason?: string | null;
}

export interface RuleSuggestionDto {
  id: string;
  name: string;
  accountCode: string;
  accountName: string;
  correctionCount: number;
  suggestionReason: string;
  /** "동일 수정 3회 — '쿠팡 → 상품'을 영구 규칙으로 등록하시겠습니까?" */
  message: string;
}

export interface CorrectResult {
  transaction: ExceptionRow;
  /** 실제로 계정·부가세가 바뀌었는가 (그대로 확정이면 false = 승인과 같음) */
  changed: boolean;
  correctionIds: string[];
  auditLogId: string | null;
  /** 계정 변경으로 부가세 판단을 엔진이 다시 한 결과 (사람이 부가세를 직접 지정하지 않은 경우) */
  vatReevaluated: { before: string; after: string; summary: string } | null;
  /** 매입인데 부가세 공제여부가 정해지지 않아 검토 상태로 남겼는가 */
  needsVatDecision: boolean;
  ruleSuggestion: RuleSuggestionDto | null;
  /** 같은 가맹점 미검토 건 — "같은 가맹점 미검토 5건에도 적용할까요?" */
  similarPending: { count: number; message: string } | null;
  warnings: string[];
}

export interface BulkCorrectInput {
  ids: string[];
  accountCode?: string | null;
  vatDeductible?: boolean | null;
  vatType?: VatType | null;
  reason?: string | null;
}

export interface BulkCorrectResult {
  count: number;
  updatedIds: string[];
  skipped: SkippedItem[];
  auditLogId: string | null;
  ruleSuggestion: RuleSuggestionDto | null;
  warnings: string[];
}

export type SimilarScope = 'period' | 'all_pending';

export interface ApplySimilarInput {
  transactionId: string;
  /** period(기본): 같은 기간 / all_pending: 모든 기간의 미검토 */
  scope?: SimilarScope;
}

export interface ExcludeInput {
  ids: string[];
  reason: string;
}

export interface ExcludeResult {
  excluded: number;
  excludedIds: string[];
  skipped: SkippedItem[];
  auditLogId: string | null;
}

export interface RevertResult {
  revertAuditLogId: string;
  reverted: number;
  revertedTransactionIds: string[];
  skipped: Array<{ transactionId: string; reason: string }>;
  summary: string;
}

// ────────────────────────────── 상세 (Explainability) ──────────────────────────────

export interface TransactionDetail {
  transaction: {
    id: string;
    clientId: string;
    clientName: string;
    clientCode: string;
    period: string;
    date: string;
    direction: Direction;
    source: string;
    channel: string;
    evidenceType: string;
    merchantName: string;
    merchantKey: string;
    merchantBusinessNumber: string | null;
    merchantCategory: string | null;
    merchantTaxType: string;
    description: string;
    supplyAmount: number;
    vatAmount: number;
    serviceCharge: number;
    totalAmount: number;
    currency: string;
    isForeign: boolean;
    cardLast4: string | null;
    approvalNumber: string | null;
    status: TransactionStatus;
    statusLabel: string;
    touchCount: number;
    reviewedBy: { id: string; name: string } | null;
    reviewedAt: string | null;
    excludedReason: string | null;
    duplicateOfId: string | null;
    duplicateReason: string | null;
    exportJob: { id: string; status: string } | null;
  };
  classification: {
    /** 현재 확정값 (사람 수정 반영) */
    current: {
      accountCode: string | null;
      accountName: string | null;
      confidence: number | null;
      source: ClassificationSource | null;
      sourceLabel: string;
      summary: string;
      vatType: string | null;
      vatTypeLabel: string | null;
      deductible: boolean | null;
      vatConfidence: number | null;
      vatReasonCode: string | null;
      confidenceScore: number | null;
      reviewLevel: ReviewLevel | null;
    };
    /** 엔진의 최신 판단 그대로 (없으면 null — 아직 분류 전) */
    engine: { account: AccountClassification; vat: VatClassification; engineVersion: string; classifiedAt: string | null; runs: number } | null;
    /** 사람이 엔진 판단을 바꿨는가 */
    overriddenByHuman: boolean;
    buckets: Array<{ bucket: ExceptionBucket; label: string }>;
  };
  vatRules: Array<{ code: string; name: string; outcome: string; reasonText: string; legalBasis: string | null }>;
  riskFlags: RiskFlagShort[];
  merchantHistory: Array<{
    id: string;
    period: string;
    date: string;
    totalAmount: number;
    accountCode: string | null;
    accountName: string | null;
    status: TransactionStatus;
    corrected: boolean;
    processedBy: 'human' | 'auto' | 'pending';
  }>;
  corrections: Array<{
    id: string;
    transactionId: string;
    field: 'account' | 'vat';
    before: string | null;
    beforeLabel: string | null;
    after: string;
    afterLabel: string | null;
    beforeSource: string | null;
    beforeConfidence: number | null;
    reason: string | null;
    bulk: boolean;
    userName: string | null;
    createdAt: string;
    suggestedRuleId: string | null;
  }>;
  applicableRules: Array<{
    id: string;
    name: string;
    accountCode: string;
    accountName: string;
    status: string;
    origin: string;
    priority: number;
    confidence: number;
    scope: 'client' | 'global';
    usedByEngine: boolean;
    suggestionReason: string | null;
  }>;
  sourceRow: {
    fileName: string | null;
    importJobId: string | null;
    formatProfile: string | null;
    rowNumber: number | null;
    rawData: Record<string, unknown>;
  } | null;
  auditTrail: Array<{
    id: string;
    action: string;
    actorName: string;
    summary: string;
    createdAt: string;
    revertible: boolean;
    reverted: boolean;
    revertOfId: string | null;
    canRevert: boolean;
  }>;
  similarPending: number;
}

// ────────────────────────────── 학습 요약 ──────────────────────────────

export interface LearningSummary {
  period: string;
  userId: string | null;
  corrections: number;
  correctedTransactions: number;
  accountCorrections: number;
  vatCorrections: number;
  merchants: number;
  bulkOperations: number;
  rulesSuggested: number;
  rulesApproved: number;
  rulesPending: number;
  rulesRejected: number;
  topCorrections: Array<{ merchantName: string; fromLabel: string; toLabel: string; count: number }>;
  /** "수정한 38건을 다음 처리에 학습했습니다" */
  message: string;
}
