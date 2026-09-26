import { describe, expect, it } from 'vitest';
import type { AccountClassification, RiskFlag, VatClassification } from '../types';
import { DEFAULT_CONFIDENCE_POLICY } from '../policy';
import { adjustedVatConfidence, decide } from './decide';

function acc(o: Partial<AccountClassification> = {}): AccountClassification {
  return {
    accountCode: '830',
    accountName: '소모품비',
    confidence: 99,
    source: 'exact_history',
    summary: '',
    reasons: [],
    evidence: { historyCount: 12 },
    alternatives: [],
    ...o,
  };
}
function vat(o: Partial<VatClassification> = {}): VatClassification {
  return { vatType: 'purchase_card', deductible: true, nonDeductibleReasonCode: null, confidence: 97, summary: '', reasons: [], ruleIds: [], ...o };
}
function flag(o: Partial<RiskFlag> = {}): RiskFlag {
  return { ruleCode: 'R', ruleName: 'r', bucket: 'high_amount', severity: 'warning', blocksAutoApproval: true, message: 'm', ...o };
}
const P = DEFAULT_CONFIDENCE_POLICY;

describe('decide', () => {
  it('고신뢰 + 위험 없음 → 자동승인, 버킷 없음', () => {
    const d = decide(null, acc(), vat(), [], P);
    expect(d.reviewLevel).toBe('auto');
    expect(d.status).toBe('auto_approved');
    expect(d.buckets).toEqual([]);
  });

  it('score = min(계정, 부가세)', () => {
    expect(decide(null, acc({ confidence: 99 }), vat({ confidence: 90 }), [], P).reviewLevel).toBe('quick_review');
    expect(decide(null, acc({ confidence: 94 }), vat({ confidence: 99 }), [], P).reviewLevel).toBe('quick_review');
  });

  it('빠른검토: 다른 버킷이 없을 때만 low_confidence', () => {
    const d = decide(null, acc({ confidence: 88 }), vat(), [], P);
    expect(d.reviewLevel).toBe('quick_review');
    expect(d.status).toBe('needs_review');
    expect(d.buckets).toEqual(['low_confidence']);
    const e = decide(null, acc({ confidence: 88 }), vat(), [flag({ bucket: 'vehicle', blocksAutoApproval: false })], P);
    expect(e.buckets).toEqual(['vehicle']);
  });

  it('반드시검토: low_confidence', () => {
    const d = decide(null, acc({ confidence: 70 }), vat(), [], P);
    expect(d.reviewLevel).toBe('must_review');
    expect(d.buckets).toContain('low_confidence');
  });

  it('미분류 → unclassified + low_confidence, must_review', () => {
    const d = decide(null, acc({ accountCode: null, accountName: null, confidence: 0, source: 'none' }), vat(), [], P);
    expect(d.reviewLevel).toBe('must_review');
    expect(d.buckets).toEqual(expect.arrayContaining(['unclassified', 'low_confidence']));
  });

  it('부가세 판단불가 → vat_review, 신뢰도가 높아도 반드시검토', () => {
    const v = vat({ deductible: null, confidence: 90 });
    expect(adjustedVatConfidence(v, P)).toBe(79);
    const d = decide(null, acc(), v, [], P);
    expect(d.reviewLevel).toBe('must_review');
    expect(d.buckets).toEqual(['low_confidence', 'vat_review']);
  });

  it('계정 충돌: 대안이 1순위 − 10 이내', () => {
    const alt = (confidence: number) => [{ accountCode: '811', accountName: '복리후생비', confidence, source: 'ai' as const }];
    expect(decide(null, acc({ source: 'system_rule', confidence: 90, alternatives: alt(80) }), vat(), [], P).buckets).toContain('account_conflict');
    expect(decide(null, acc({ source: 'system_rule', confidence: 90, alternatives: alt(79) }), vat(), [], P).buckets).not.toContain('account_conflict');
    // 같은 코드 대안은 충돌 아님
    expect(decide(null, acc({ source: 'system_rule', confidence: 90, alternatives: [{ accountCode: '830', accountName: '소모품비', confidence: 90, source: 'ai' }] }), vat(), [], P).buckets).not.toContain('account_conflict');
    expect(decide(null, acc({ source: 'system_rule', confidence: 90, alternatives: alt(75) }), vat(), [], P, { conflictMargin: 20 }).buckets).toContain('account_conflict');
  });

  it('계정 충돌: 수임처 이력 1순위는 사전·AI 후보에 흔들리지 않고, 수임처 이력끼리 근접하면 자동승인 금지', () => {
    const top = { source: 'exact_history' as const, confidence: 99 };
    const sys = [{ accountCode: '830', accountName: '소모품비', confidence: 90, source: 'system_rule' as const }];
    const own = [{ accountCode: '212', accountName: '비품', confidence: 92, source: 'exact_history' as const }];
    const a1 = decide(null, acc({ ...top, accountCode: '146', accountName: '상품', alternatives: sys }), vat(), [], P);
    expect(a1.buckets).not.toContain('account_conflict');
    expect(a1.reviewLevel).toBe('auto');
    const a2 = decide(null, acc({ ...top, accountCode: '146', accountName: '상품', alternatives: own }), vat(), [], P);
    expect(a2.buckets).toContain('account_conflict');
    expect(a2.reviewLevel).not.toBe('auto');
  });

  it('금액 역산(추정) 거래는 자동승인 금지', () => {
    const d = decide({ transactionDate: '2026-09-01', rawData: { __derived: ['supply_vat_from_total'] } }, acc(), vat(), [], P);
    expect(d.reviewLevel).not.toBe('auto');
    expect(d.buckets).toContain('vat_review');
  });

  it('신규 거래처: 이력 없는 분류면 new_merchant, 옵션으로 지정 가능', () => {
    expect(decide(null, acc({ source: 'ai', confidence: 70, evidence: {} }), vat(), [], P).buckets).toContain('new_merchant');
    expect(decide(null, acc({ source: 'system_rule', confidence: 90, evidence: {} }), vat(), [], P).buckets).toContain('new_merchant');
    expect(decide(null, acc({ source: 'ai', evidence: {} }), vat(), [], P, { isNewMerchant: false }).buckets).not.toContain('new_merchant');
    expect(decide(null, acc(), vat(), [], P, { isNewMerchant: true }).buckets).toContain('new_merchant');
  });

  it('차단 위험(warning) → 신뢰도 99여도 자동승인 금지 (quick_review)', () => {
    const d = decide(null, acc(), vat(), [flag()], P);
    expect(d.reviewLevel).toBe('quick_review');
    expect(d.status).toBe('needs_review');
    expect(d.buckets).toEqual(['high_amount']);
  });

  it('severity high 는 차단 설정이 꺼져 있어도 반드시검토', () => {
    const d = decide(null, acc(), vat(), [flag({ severity: 'high', blocksAutoApproval: false, bucket: 'entertainment' })], P);
    expect(d.reviewLevel).toBe('must_review');
    expect(d.status).toBe('needs_review');
  });

  it('비차단 info 위험만 있으면 자동승인, 버킷은 남긴다', () => {
    const d = decide(null, acc(), vat(), [flag({ bucket: 'spike', blocksAutoApproval: false, severity: 'info' })], P);
    expect(d.status).toBe('auto_approved');
    expect(d.buckets).toEqual(['spike']);
  });

  it('버킷은 중복 없이 표준 순서', () => {
    const d = decide(
      null,
      acc({ confidence: 60 }),
      vat({ deductible: null }),
      [flag({ bucket: 'foreign' }), flag({ bucket: 'high_amount' }), flag({ bucket: 'foreign' })],
      P,
    );
    expect(d.buckets).toEqual(['low_confidence', 'vat_review', 'high_amount', 'foreign']);
    expect(d.risks).toHaveLength(3);
  });

  it('사무소 정책 변경 반영', () => {
    const policy = { ...P, autoApproveMin: 90, quickReviewMin: 70 };
    expect(decide(null, acc({ confidence: 91 }), vat(), [], policy).status).toBe('auto_approved');
    expect(decide(null, acc({ confidence: 75 }), vat(), [], policy).reviewLevel).toBe('quick_review');
  });
});

describe('decide — 신규 거래처 추정 보강', () => {
  it('업종 패턴 분류의 historyCount 는 다른 수임처 이력이라 신규 거래처로 본다', () => {
    const d = decide(null, acc({ source: 'industry_pattern', evidence: { historyCount: 40, peerClientCount: 6 } }), vat(), []);
    expect(d.buckets).toContain('new_merchant');
  });
  it('사용자 규칙 + 이 수임처 이력 있음 → 신규 아님, 이력 없음 → 신규', () => {
    expect(decide(null, acc({ source: 'user_rule', evidence: { historyCount: 3 } }), vat(), []).buckets).not.toContain('new_merchant');
    expect(decide(null, acc({ source: 'user_rule', evidence: { historyCount: 0 } }), vat(), []).buckets).toContain('new_merchant');
  });
});
