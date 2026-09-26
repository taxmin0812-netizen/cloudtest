import type { ConfidencePolicy, ReviewLevel } from './types';

/** 기본 신뢰도 정책 — DB settings 로 덮어쓸 수 있다. */
export const DEFAULT_CONFIDENCE_POLICY: ConfidencePolicy = {
  autoApproveMin: 95,
  quickReviewMin: 80,
  ruleSuggestionThreshold: 3,
};

export function reviewLevelFor(confidence: number, policy: ConfidencePolicy, blockedByRisk: boolean): ReviewLevel {
  if (!blockedByRisk && confidence >= policy.autoApproveMin) return 'auto';
  if (confidence >= policy.quickReviewMin) return 'quick_review';
  return 'must_review';
}

/** 신뢰도 기준표 (Explainability 문구와 동기화) */
export const CONFIDENCE_LADDER = [
  { min: 99, label: '동일 거래처 + 동일 사업자번호 + 과거 동일처리 10회 이상' },
  { min: 97, label: '동일 거래처 + 동일 상호 + 반복거래' },
  { min: 93, label: '동일 업종에서 반복되는 명확한 거래' },
  { min: 85, label: 'AI 추천 + 과거 유사거래' },
  { min: 70, label: 'AI 추론만 존재' },
] as const;
