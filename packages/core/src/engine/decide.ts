import type {
  AccountClassification,
  ConfidencePolicy,
  ExceptionBucket,
  NormalizedTransaction,
  RiskFlag,
  TransactionDecision,
  VatClassification,
} from '../types';
import { DEFAULT_CONFIDENCE_POLICY, reviewLevelFor } from '../policy';

export interface DecideOptions {
  /** 대안 계정 신뢰도가 (1순위 − 이 값) 이상이면 account_conflict (기본 10) */
  conflictMargin?: number;
  /**
   * 신규 거래처 여부. 모르면 생략 → 계정 근거로 추정
   * (이력 기반 분류가 아니고 참조 이력 0건이면 신규).
   */
  isNewMerchant?: boolean;
}

/** Exception Inbox 표시 순서 (types.ts ExceptionBucket 선언 순서) */
const BUCKET_ORDER: readonly ExceptionBucket[] = [
  'low_confidence', 'new_merchant', 'vat_review', 'account_conflict', 'changed_from_history', 'high_amount', 'duplicate',
  'unclassified', 'possible_asset', 'personal_use', 'entertainment', 'vehicle', 'foreign', 'spike', 'export_error',
];

const HISTORY_SOURCES = new Set(['exact_history', 'name_history', 'correction_memory']);
/** 이 수임처 자신의 근거(규칙·이력·수정)에서 나온 후보만 '계정 충돌'로 본다. 업종·사전·AI 후보는 수임처 이력을 이기지 못한다. */
const CLIENT_SOURCES = new Set(['user_rule', 'exact_history', 'name_history', 'correction_memory', 'manual']);

/**
 * 부가세 판단불가(deductible=null)면 빠른검토로도 넘기지 않도록 신뢰도를 quickReviewMin 미만으로 낮춘다.
 */
export function adjustedVatConfidence(vat: VatClassification, policy: ConfidencePolicy): number {
  return vat.deductible === null ? Math.min(vat.confidence, policy.quickReviewMin - 1) : vat.confidence;
}

function inferNewMerchant(account: AccountClassification): boolean {
  if (HISTORY_SOURCES.has(account.source)) return false;
  // 업종 패턴의 historyCount 는 '다른 수임처' 이력 건수라 이 수임처의 거래 경험이 아니다
  if (account.source === 'industry_pattern') return true;
  return !((account.evidence.historyCount ?? 0) > 0);
}

/**
 * 한 거래의 최종 판단.
 * - score = min(계정 신뢰도, 부가세 신뢰도(보정))
 * - 자동승인 차단: blocksAutoApproval 플래그, severity 'high' 플래그(설정과 무관하게 항상), 계정 미분류, 부가세 판단불가,
 *   수임처 근거 간 계정 충돌, 금액 역산(추정) 거래
 * - severity 'high' 가 있으면 신뢰도와 무관하게 반드시 검토(must_review)
 */
export function decide(
  tx: (Pick<NormalizedTransaction, 'transactionDate'> & { rawData?: Record<string, unknown> | null }) | null,
  account: AccountClassification,
  vat: VatClassification,
  risks: readonly RiskFlag[],
  policy: ConfidencePolicy = DEFAULT_CONFIDENCE_POLICY,
  opts: DecideOptions = {},
): TransactionDecision {
  const unclassified = !account.accountCode;
  const accountConf = unclassified ? 0 : account.confidence;
  const score = Math.min(accountConf, adjustedVatConfidence(vat, policy));
  const highRisk = risks.some((r) => r.severity === 'high');
  const margin = opts.conflictMargin ?? 10;
  // 계정 충돌: 이 수임처 근거끼리 1순위와 근접한 다른 계정이 있으면 자동승인하지 않는다 (예: 이력이 소모품비 6건/비품 4건)
  // 1순위가 수임처 근거면 수임처 근거 후보만 충돌로 보고, 1순위가 사전·업종·AI 면 모든 근접 후보가 충돌이다
  const topIsClient = CLIENT_SOURCES.has(account.source);
  const conflict =
    !unclassified &&
    account.alternatives.some(
      (a) =>
        a.accountCode !== account.accountCode &&
        a.confidence >= account.confidence - margin &&
        (!topIsClient || CLIENT_SOURCES.has(a.source)),
    );
  // 합계만 있어 공급가액·세액을 역산한 거래(adapters rawData.__derived)는 원본 증빙 확인 전 자동승인 금지
  const estimatedAmounts = Array.isArray(tx?.rawData?.__derived) && (tx!.rawData!.__derived as unknown[]).length > 0;
  const blocking =
    unclassified || vat.deductible === null || highRisk || conflict || estimatedAmounts || risks.some((r) => r.blocksAutoApproval);

  let reviewLevel = reviewLevelFor(score, policy, blocking);
  if (highRisk) reviewLevel = 'must_review';

  const set = new Set<ExceptionBucket>();
  for (const r of risks) set.add(r.bucket);
  if (unclassified) set.add('unclassified');
  if (vat.deductible === null) set.add('vat_review');
  if (conflict) set.add('account_conflict');
  if (estimatedAmounts) set.add('vat_review');
  if (opts.isNewMerchant ?? inferNewMerchant(account)) set.add('new_merchant');
  if (score < policy.quickReviewMin) set.add('low_confidence');
  else if (reviewLevel !== 'auto' && set.size === 0) set.add('low_confidence');

  return {
    account,
    vat,
    risks: [...risks],
    reviewLevel,
    status: reviewLevel === 'auto' ? 'auto_approved' : 'needs_review',
    buckets: BUCKET_ORDER.filter((b) => set.has(b)),
  };
}
