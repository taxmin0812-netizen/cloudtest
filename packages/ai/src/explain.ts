import {
  DEFAULT_CONFIDENCE_POLICY,
  formatWon,
  reviewLevelFor,
  scrubSensitive,
  type ClassificationSource,
  type ConfidencePolicy,
  type EvidenceType,
  type ReviewLevel,
  type VatType,
} from '@mintax/core';
import type { ExplainInput } from './types';

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  tax_invoice: '세금계산서',
  invoice_exempt: '계산서',
  card: '카드',
  cash_receipt: '현금영수증',
  bank: '통장',
  other: '기타 증빙',
};

export const CLASSIFICATION_SOURCE_LABELS: Record<ClassificationSource, string> = {
  user_rule: '사용자 규칙',
  exact_history: '동일 사업자번호 과거 처리',
  name_history: '동일 상호 과거 처리',
  correction_memory: '최근 수정 이력',
  industry_pattern: '동일 업종 반복 패턴',
  system_rule: '시스템 기본 사전',
  ai: 'AI 추론',
  manual: '담당자 직접 지정',
  none: '미분류',
};

export const VAT_TYPE_LABELS: Record<VatType, string> = {
  purchase_taxable: '과세매입(세금계산서)',
  purchase_exempt: '면세매입(계산서)',
  purchase_card: '카드과세매입',
  purchase_card_exempt: '카드면세매입',
  purchase_cash_receipt: '현금영수증 과세매입',
  purchase_cash_receipt_exempt: '현금영수증 면세매입',
  purchase_non_deductible: '불공제 매입',
  purchase_no_evidence: '적격증빙 아님(일반전표)',
  sales_taxable: '과세매출',
  sales_exempt: '면세매출',
  sales_card: '카드매출',
  sales_cash_receipt: '현금영수증 매출',
  sales_other: '기타매출',
};

export const REVIEW_LEVEL_LABELS: Record<ReviewLevel, string> = {
  auto: '자동승인 가능',
  quick_review: '빠른검토',
  must_review: '검토 필요',
};

/**
 * 분류 결과를 한국어 문단으로 설명한다 (결정적, 외부 전송 없음).
 * 계정·부가세 판단 근거와 대안을 그대로 풀어 쓴다. 새로운 사실을 만들지 않는다.
 */
export function explainClassificationText(input: ExplainInput, policy: ConfidencePolicy = DEFAULT_CONFIDENCE_POLICY): string {
  const { tx, classification: c, vat } = input;
  const date = tx.transactionDate ? `${tx.transactionDate} ` : '';
  const dir = tx.direction === 'purchase' ? '매입' : '매출';
  const head = `${date}${scrubSensitive(tx.merchantName || '(상호 없음)')} ${formatWon(tx.totalAmount)}(${EVIDENCE_TYPE_LABELS[tx.evidenceType]} ${dir})`;
  const lines: string[] = [];

  if (!c.accountCode || c.source === 'none') {
    lines.push(`${head} 거래의 계정과목을 판단하지 못했습니다(미분류). 담당자 지정이 필요합니다.`);
  } else {
    const level = reviewLevelFor(c.confidence, policy, false);
    lines.push(
      `${head} 거래를 ${c.accountName ?? c.accountCode}(${c.accountCode})로 분류했습니다. 판단 출처: ${CLASSIFICATION_SOURCE_LABELS[c.source]}, 신뢰도 ${c.confidence} (${REVIEW_LEVEL_LABELS[level]}).`,
    );
  }
  const reasons = c.reasons.filter((r) => r && r.trim()).map((r) => scrubSensitive(r.trim()));
  if (reasons.length > 0) lines.push(`근거: ${reasons.map((r, i) => `${i + 1}) ${r}`).join(' ')}`);

  const deduct = vat.deductible === true ? '공제' : vat.deductible === false ? '불공제' : '공제 여부 판단 불가(검토 필요)';
  const vatReason = vat.summary ? ` — ${scrubSensitive(vat.summary)}` : '';
  const vatAmount = tx.vatAmount !== undefined ? `, 세액 ${formatWon(tx.vatAmount)}` : '';
  lines.push(`부가세: ${VAT_TYPE_LABELS[vat.vatType]} · ${deduct}${vatAmount} (신뢰도 ${vat.confidence})${vatReason}.`);

  if (c.alternatives.length > 0) {
    const alts = c.alternatives
      .slice(0, 3)
      .map((a) => `${a.accountName}(${a.accountCode}) ${a.confidence}`)
      .join(', ');
    lines.push(`대안 계정: ${alts}.`);
  }
  if (c.source === 'ai') lines.push('AI 추천은 참고용이며 자동승인 기준에 도달하지 않습니다.');
  return lines.join('\n');
}
