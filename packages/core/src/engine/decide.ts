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
 * - 자동승인 차단: blocksAutoApproval 플래그, severity 'high' 플래그(설정과 무관하게 항상), 계정 미분류, 부가세 판단불가
 * - severity 'high' 가 있으면 신뢰도와 무관하게 반드시 검토(must_review)
 */
export function decide(
  _tx: Pick<NormalizedTransaction, 'transactionDate'> | null,
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
  const blocking = unclassified || vat.deductible === null || highRisk || risks.some((r) => r.blocksAutoApproval);

  let reviewLevel = reviewLevelFor(score, policy, blocking);
  if (highRisk) reviewLevel = 'must_review';

  const set = new Set<ExceptionBucket>();
  for (const r of risks) set.add(r.bucket);
  if (unclassified) set.add('unclassified');
  if (vat.deductible === null) set.add('vat_review');
  const margin = opts.conflictMargin ?? 10;
  if (
    !unclassified &&
    account.alternatives.some((a) => a.accountCode !== account.accountCode && a.confidence >= account.confidence - margin)
  ) {
    set.add('account_conflict');
  }
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
