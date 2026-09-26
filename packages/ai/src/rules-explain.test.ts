import { describe, expect, it } from 'vitest';
import { evaluateCondition, type AccountClassification, type CorrectionRecord, type VatClassification } from '@mintax/core';
import { explainClassificationText } from './explain';
import { HeuristicProvider } from './heuristic';
import { suggestRulesFromCorrections } from './rules';

let seq = 0;
function corr(over: Partial<CorrectionRecord> = {}): CorrectionRecord {
  seq += 1;
  return {
    clientId: 'c1',
    merchantKey: 'SK에너지',
    merchantBusinessNumber: '1208147521',
    field: 'account',
    before: '830',
    after: '822',
    userId: 'u1',
    transactionId: `t${seq}`,
    createdAt: `2026-09-${String(10 + (seq % 15)).padStart(2, '0')}T09:00:00Z`,
    ...over,
  };
}

describe('suggestRule (수정 이력 → 규칙 제안)', () => {
  it('같은 수정 3회 → 사업자번호 조건 규칙', async () => {
    const r = await new HeuristicProvider().suggestRule({ corrections: [corr(), corr(), corr({ before: null })] });
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      name: 'SK에너지 → 차량유지비',
      condition: { field: 'merchantBusinessNumber', op: 'eq', value: '1208147521' },
      accountCode: '822',
      rationale:
        '최근 사업자번호 120-81-47521 (SK에너지) 거래를 3회 차량유지비(822)로 수정했습니다 (이전 판단: 소모품비(830) 2회, 미분류 1회). 같은 거래를 자동 분류하도록 규칙을 제안합니다.',
      clientId: 'c1',
      supportCount: 3,
    });
    expect(evaluateCondition(r[0]!.condition, { merchantBusinessNumber: '1208147521' })).toBe(true);
  });

  it('2회는 제안하지 않음 (기본 임계 3), 임계값 조정 가능', () => {
    expect(suggestRulesFromCorrections([corr(), corr()])).toEqual([]);
    expect(suggestRulesFromCorrections([corr(), corr()], { threshold: 2 })).toHaveLength(1);
  });

  it('수정이 엇갈리면(최다 비율 < 80%) 제안하지 않음', () => {
    expect(suggestRulesFromCorrections([corr(), corr(), corr(), corr({ after: '811' }), corr({ after: '811' })])).toEqual([]);
  });

  it('사업자번호가 없는 수정이 섞이면 상호키 조건', () => {
    const r = suggestRulesFromCorrections([corr(), corr({ merchantBusinessNumber: null }), corr()]);
    expect(r[0]!.condition).toEqual({ field: 'merchantKey', op: 'eq', value: 'SK에너지' });
    expect(r[0]!.rationale).toContain('상호 SK에너지');
  });

  it('부가세 수정·다른 수임처는 따로 본다, 건수 많은 순 정렬', () => {
    const list = [
      corr({ field: 'vat', after: 'false' }),
      corr({ clientId: 'c2', merchantKey: '쿠팡', merchantBusinessNumber: null, after: '830', before: '848' }),
      corr({ clientId: 'c2', merchantKey: '쿠팡', merchantBusinessNumber: null, after: '830', before: '848' }),
      corr({ clientId: 'c2', merchantKey: '쿠팡', merchantBusinessNumber: null, after: '830', before: '848' }),
      corr({ clientId: 'c2', merchantKey: '쿠팡', merchantBusinessNumber: null, after: '830', before: '848' }),
      corr(),
      corr(),
      corr(),
    ];
    const r = suggestRulesFromCorrections(list);
    expect(r.map((x) => [x.clientId, x.accountCode, x.supportCount])).toEqual([
      ['c2', '830', 4],
      ['c1', '822', 3],
    ]);
  });

  it('원래 판단과 같은 계정으로의 "수정"은 규칙이 아님', () => {
    expect(suggestRulesFromCorrections([corr({ before: '822' }), corr({ before: '822' }), corr({ before: '822' })])).toEqual([]);
  });
});

describe('suggestRule 중복 조건 (검수 보강)', () => {
  it('같은 사업자번호가 상호키 두 개로 들어오면 규칙 하나로 합친다 (근거 건수 합산)', () => {
    const r = suggestRulesFromCorrections([
      corr({ merchantKey: 'SK에너지' }),
      corr({ merchantKey: 'SK에너지' }),
      corr({ merchantKey: 'SK에너지' }),
      corr({ merchantKey: 'SK에너지강남' }),
      corr({ merchantKey: 'SK에너지강남' }),
      corr({ merchantKey: 'SK에너지강남' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ condition: { field: 'merchantBusinessNumber', op: 'eq', value: '1208147521' }, accountCode: '822', supportCount: 6 });
  });

  it('같은 조건에 계정이 엇갈리면 모호하므로 제안하지 않는다 (다른 수임처는 별개)', () => {
    const r = suggestRulesFromCorrections([
      ...[1, 2, 3].map(() => corr({ merchantKey: 'A상사', after: '822' })),
      ...[1, 2, 3].map(() => corr({ merchantKey: 'A상사본점', after: '830', before: '822' })),
      ...[1, 2, 3].map(() => corr({ clientId: 'c2', merchantKey: 'A상사', after: '822' })),
    ]);
    expect(r.map((x) => [x.clientId, x.accountCode])).toEqual([['c2', '822']]);
  });
});

describe('explainClassification', () => {
  const classification: AccountClassification = {
    accountCode: '822',
    accountName: '차량유지비',
    confidence: 88,
    source: 'system_rule',
    summary: '주유소 → 차량유지비',
    reasons: ['시스템 사전: 주유소 (SYS-CAR-01)', '가맹점 업종 주유소'],
    evidence: {},
    alternatives: [{ accountCode: '830', accountName: '소모품비', confidence: 40, source: 'ai' }],
  };
  const vatCls: VatClassification = {
    vatType: 'purchase_card',
    deductible: true,
    nonDeductibleReasonCode: null,
    confidence: 90,
    summary: '카드 세액 구분 기재',
    reasons: [],
    ruleIds: [],
  };
  const tx = { merchantName: 'SK에너지', transactionDate: '2026-09-12', totalAmount: 55_000, vatAmount: 5_000, evidenceType: 'card' as const, direction: 'purchase' as const };

  it('계정·근거·부가세·대안을 한국어로 설명', async () => {
    const text = await new HeuristicProvider().explainClassification({ tx, classification, vat: vatCls });
    expect(text).toBe(
      [
        '2026-09-12 SK에너지 55,000원(카드 매입) 거래를 차량유지비(822)로 분류했습니다. 판단 출처: 시스템 기본 사전, 신뢰도 88 (빠른검토).',
        '근거: 1) 시스템 사전: 주유소 (SYS-CAR-01) 2) 가맹점 업종 주유소',
        '부가세: 카드과세매입 · 공제, 세액 5,000원 (신뢰도 90) — 카드 세액 구분 기재.',
        '대안 계정: 소모품비(830) 40.',
      ].join('\n'),
    );
  });

  it('미분류·판단불가·AI 출처', () => {
    const text = explainClassificationText({
      tx: { ...tx, merchantName: '카드 1234-5678-9012-3456', transactionDate: undefined },
      classification: { ...classification, accountCode: null, accountName: null, source: 'none', confidence: 0, reasons: [], alternatives: [] },
      vat: { ...vatCls, deductible: null, summary: '' },
    });
    expect(text).toContain('계정과목을 판단하지 못했습니다(미분류)');
    expect(text).toContain('공제 여부 판단 불가(검토 필요)');
    expect(text).not.toContain('5678-9012'); // 카드번호 스크럽
    const ai = explainClassificationText({ tx, classification: { ...classification, source: 'ai', confidence: 70 }, vat: vatCls });
    expect(ai).toContain('AI 추론, 신뢰도 70 (검토 필요)');
    expect(ai).toContain('AI 추천은 참고용');
  });
});
