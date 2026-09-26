import type {
  AccountClassification,
  AIClassificationInput,
  AIClassificationSuggestion,
  Condition,
  CorrectionRecord,
  Direction,
  EvidenceType,
  ExceptionBucket,
  IndustryKey,
  IntegrationDescriptor,
  LedgerAnomaly,
  LocalDate,
  UUID,
  VatClassification,
  VatTaxpayerType,
  Won,
  YearMonth,
} from '@mintax/core';

/**
 * @mintax/ai — AI Provider 추상화 계약.
 *
 * - 기본 Provider 는 로컬 휴리스틱(외부 전송 없음). LLM Provider 는 선택 사항이다.
 * - 어떤 Provider 도 파이프라인을 막지 않는다: 실패 시 null / 빈 배열 / 결정적 설명으로 대체한다.
 * - 신뢰도 상한은 Provider 가 1차로, core 엔진(mergeAiSuggestion)이 2차로 적용한다.
 */

// ────────────────────────────── 장부 검토 입력 ──────────────────────────────

/** 월별 장부 요약 (계정별 합계는 해당 월 발생액, 원 단위 정수) */
export interface MonthlyLedgerSummary {
  period: YearMonth;
  sales: Won;
  purchases: Won;
  /** 계정코드 → { 계정명, 월 합계 } */
  byAccount: Record<string, { name: string; total: Won }>;
}

/**
 * 원천 vs 처리 건수 키: 증빙유형 단독('tax_invoice') 또는 증빙유형:방향('tax_invoice:purchase').
 * 방향을 붙이면 메시지가 "세금계산서 매입"처럼 구체적으로 나온다.
 */
export type SourceCountKey = EvidenceType | `${EvidenceType}:${Direction}`;

export interface SourceCounts {
  /** 위멤버스(원천) 수집 건수 */
  wemembers: Partial<Record<SourceCountKey, number>>;
  /** MIN TAX OPS 처리(분류 완료·제외 사유 기록) 건수 */
  processed: Partial<Record<SourceCountKey, number>>;
}

/** 원천 합계 vs 장부 반영 합계 (공급대가, VAT 포함) */
export interface SalesSourceComparison {
  source: Won;
  reported: Won;
}

export interface InputVatSplit {
  deductible: Won;
  nonDeductible: Won;
}

export interface FixedAssetPurchase {
  accountCode: string;
  accountName: string;
  merchantName: string;
  supplyAmount: Won;
  vatAmount: Won;
  evidenceType: EvidenceType;
  date: LocalDate;
}

export interface ExemptPurchase {
  merchantName: string;
  description?: string;
  merchantCategory?: string | null;
  /** 매입가액 (면세이므로 공급가액 = 합계) */
  amount: Won;
  evidenceType: EvidenceType;
  /** 이미 의제매입 대상으로 반영했는지 */
  claimedAsDeemed?: boolean;
}

/** 부가세 과세기간 검토 입력 (없는 항목은 해당 검사를 건너뛴다) */
export interface VatPeriodReviewInput {
  /** 표시용 라벨, 예: '2026년 2기 예정' */
  label: string;
  vatType: VatTaxpayerType;
  deemedInputTaxEligible: boolean;
  /** 신용카드 매출: 원천(카드사·홈택스 신용카드매출자료) vs 장부 반영 */
  cardSales?: SalesSourceComparison | null;
  /** 현금영수증 매출: 원천(홈택스) vs 장부 반영 */
  cashReceiptSales?: SalesSourceComparison | null;
  /** 매입세액 공제/불공제 (이번 기간 + 직전 기간) */
  inputVat?: { current: InputVatSplit; previous?: InputVatSplit | null } | null;
  /** 이번 기간 고정자산(자산 계정) 매입 */
  fixedAssetPurchases?: FixedAssetPurchase[];
  /** 이번 기간 면세 매입 (의제매입 후보 탐색용) */
  exemptPurchases?: ExemptPurchase[];
}

export interface LedgerReviewInput {
  clientId: UUID;
  clientName: string;
  industry: IndustryKey;
  /** 검토 대상 월 'YYYY-MM' */
  period: YearMonth;
  /** 검토 월 + 과거 월 요약 (순서 무관, 과거 3개월 이상 권장) */
  monthly: MonthlyLedgerSummary[];
  sourceCounts?: SourceCounts;
  /** 이번 달 처음 등장한 계정코드 (생략 시 monthly 로 추정) */
  newAccounts?: string[];
  /** 부가세 과세기간 검토 (신고월에만) */
  vat?: VatPeriodReviewInput;
}

/** 범용 시계열 지표 (거래처별 매입, 특정 비용 묶음 등) */
export interface MetricSeries {
  key: string;
  /** 사용자에게 보여줄 지표명, 예: '쿠팡 매입' */
  label: string;
  points: Array<{ period: YearMonth; value: Won }>;
  /** 이상 시 연결할 Inbox 버킷 (기본 spike) */
  bucket?: ExceptionBucket;
  /** 이상 시 이동할 링크 (기본 Inbox 필터) */
  href?: string;
}

export interface AnomalyInput {
  clientId: UUID;
  clientName?: string;
  industry?: IndustryKey;
  period: YearMonth;
  series?: MetricSeries[];
  sourceCounts?: SourceCounts;
  vat?: VatPeriodReviewInput;
}

// ────────────────────────────── 설명 / 규칙 제안 ──────────────────────────────

/** 설명 생성에 필요한 거래 요약 (개인식별정보 제외) */
export interface ExplainTransactionSummary {
  merchantName: string;
  transactionDate?: LocalDate;
  totalAmount: Won;
  supplyAmount?: Won;
  vatAmount?: Won;
  evidenceType: EvidenceType;
  direction: Direction;
  description?: string;
}

export interface ExplainInput {
  tx: ExplainTransactionSummary;
  classification: AccountClassification;
  vat: VatClassification;
}

export interface RuleSuggestion {
  name: string;
  condition: Condition;
  accountCode: string;
  rationale: string;
  /** 규칙을 저장할 수임처 */
  clientId?: UUID;
  /** 근거가 된 수정 건수 */
  supportCount?: number;
}

// ────────────────────────────── Provider ──────────────────────────────

export interface AIProvider {
  readonly name: string;
  readonly model: string | null;
  status(): IntegrationDescriptor;
  /** 후보 계정 중 하나를 추천. 신호가 없거나 실패하면 null (파이프라인을 막지 않는다) */
  classifyTransaction(input: AIClassificationInput): Promise<AIClassificationSuggestion | null>;
  /** 월 장부 검토 (Smart Tax Review Agent) */
  reviewLedger(input: LedgerReviewInput): Promise<LedgerAnomaly[]>;
  /** 지표 시계열·원천 건수·부가세 기간 이상 탐지 */
  detectAnomaly(input: AnomalyInput): Promise<LedgerAnomaly[]>;
  explainClassification(input: ExplainInput): Promise<string>;
  suggestRule(input: { corrections: CorrectionRecord[] }): Promise<RuleSuggestion[]>;
}

export type { AIClassificationInput, AIClassificationSuggestion, LedgerAnomaly };
