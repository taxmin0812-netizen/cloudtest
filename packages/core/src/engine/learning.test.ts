import { describe, expect, it } from 'vitest';
import type { AccountClassification, CorrectionRecord, MappingRule } from '../types';
import { DEFAULT_CONFIDENCE_POLICY } from '../policy';
import { evaluateCondition } from '../dsl';
import { analyzeCorrections, buildCorrection } from './learning';

const BIZ = '1208800767';

function corr(i: number, p: Partial<CorrectionRecord> = {}): CorrectionRecord {
  return {
    clientId: 'c1',
    merchantKey: '쿠팡',
    merchantBusinessNumber: BIZ,
    field: 'account',
    before: '830',
    after: '146',
    userId: 'u1',
    transactionId: `t${i}`,
    createdAt: `2026-09-${String(10 + i).padStart(2, '0')}T01:00:00Z`,
    ...p,
  };
}

const three = [corr(1), corr(2), corr(3)];

function rule(p: Partial<MappingRule>): MappingRule {
  return {
    id: 'r1',
    clientId: 'c1',
    name: 'r',
    condition: { field: 'merchantBusinessNumber', op: 'eq', value: BIZ },
    accountCode: '146',
    accountName: '상품',
    confidence: 99,
    priority: 100,
    status: 'active',
    origin: 'user',
    ...p,
  };
}

describe('analyzeCorrections', () => {
  it('suggests a rule after the same correction repeats 3 times', () => {
    const [s, ...rest] = analyzeCorrections(three, [], DEFAULT_CONFIDENCE_POLICY);
    expect(rest).toHaveLength(0);
    expect(s!.suggestionReason).toBe('동일 수정 3회: 소모품비 → 상품');
    expect(s!.rule).toMatchObject({
      clientId: 'c1',
      accountCode: '146',
      accountName: '상품',
      status: 'suggested',
      origin: 'system_suggested',
      // 매입 거래에만 적용되도록 방향 조건을 함께 건다 (소모품비 → 상품: 수정 전 계정이 비용 → 매입)
      condition: {
        all: [
          { field: 'direction', op: 'eq', value: 'purchase' },
          { field: 'merchantBusinessNumber', op: 'eq', value: BIZ },
        ],
      },
      name: '쿠팡 (매입) → 상품',
    });
    expect(s!.direction).toBe('purchase');
    expect(s!.correctionCount).toBe(3);
    expect(s!.transactionIds).toEqual(['t1', 't2', 't3']);
    expect(s!.firstCorrectedAt).toBe(three[0]!.createdAt);
    expect(s!.lastCorrectedAt).toBe(three[2]!.createdAt);
    // 제안 규칙 조건이 실제 상대방의 매입에 매칭되고 매출에는 매칭되지 않는다
    expect(evaluateCondition(s!.rule.condition, { merchantBusinessNumber: BIZ, direction: 'purchase' })).toBe(true);
    expect(evaluateCondition(s!.rule.condition, { merchantBusinessNumber: BIZ, direction: 'sales' })).toBe(false);
  });

  it('does not suggest below the threshold; threshold comes from policy', () => {
    expect(analyzeCorrections(three.slice(0, 2), [], DEFAULT_CONFIDENCE_POLICY)).toHaveLength(0);
    expect(analyzeCorrections(three.slice(0, 2), [], { ...DEFAULT_CONFIDENCE_POLICY, ruleSuggestionThreshold: 2 })).toHaveLength(1);
  });

  it('uses merchantKey condition when no business number is known', () => {
    const list = [1, 2, 3].map((i) => corr(i, { merchantBusinessNumber: null, merchantKey: '동네철물점', before: null, after: '830' }));
    const [s] = analyzeCorrections(list, [], DEFAULT_CONFIDENCE_POLICY);
    expect(s!.rule.condition).toEqual({
      all: [
        { field: 'direction', op: 'eq', value: 'purchase' },
        { field: 'merchantKey', op: 'eq', value: '동네철물점' },
      ],
    });
    expect(s!.suggestionReason).toBe('동일 수정 3회: 미분류 → 소모품비');
  });

  it('groups key-only records with the bizno of the same merchant', () => {
    const list = [corr(1), corr(2), corr(3, { merchantBusinessNumber: null })];
    const s = analyzeCorrections(list, [], DEFAULT_CONFIDENCE_POLICY);
    expect(s).toHaveLength(1);
    expect(s[0]!.merchantBusinessNumber).toBe(BIZ);
  });

  it('only suggests when the latest correction agrees', () => {
    const list = [...three, corr(4, { before: '146', after: '153' })];
    expect(analyzeCorrections(list, [], DEFAULT_CONFIDENCE_POLICY)).toHaveLength(0);
  });

  it('keeps clients separate and ignores vat / no-op corrections', () => {
    const list = [
      corr(1),
      corr(2),
      corr(3, { clientId: 'c2' }),
      corr(4, { field: 'vat', after: 'non_deductible' }),
      corr(5, { before: '146', after: '146' }),
    ];
    expect(analyzeCorrections(list, [], DEFAULT_CONFIDENCE_POLICY)).toHaveLength(0);
  });

  it('skips when an active / suggested / rejected rule already yields the same account', () => {
    for (const status of ['active', 'suggested', 'rejected', 'disabled'] as const) {
      expect(analyzeCorrections(three, [rule({ status })], DEFAULT_CONFIDENCE_POLICY)).toHaveLength(0);
    }
    // 다른 거래처의 규칙은 영향 없음
    expect(analyzeCorrections(three, [rule({ clientId: 'c2' })], DEFAULT_CONFIDENCE_POLICY)).toHaveLength(1);
    // 방향 조건이 있는 규칙도 덮는 것으로 본다
    const dirRule = rule({ condition: { all: [{ field: 'direction', op: 'eq', value: 'purchase' }, { field: 'merchantKey', op: 'contains', value: '쿠팡' }] } });
    expect(analyzeCorrections(three, [dirRule], DEFAULT_CONFIDENCE_POLICY)).toHaveLength(0);
  });

  it('flags an active rule that maps the merchant to a different account', () => {
    const [s] = analyzeCorrections(three, [rule({ id: 'old', accountCode: '830' })], DEFAULT_CONFIDENCE_POLICY);
    expect(s!.conflictingRuleIds).toEqual(['old']);
    expect(s!.suggestionReason).toContain('대체 검토');
    expect(s!.rule.status).toBe('suggested');
  });

  it('is deterministic (stable id, order-independent)', () => {
    const a = analyzeCorrections([...three, ...[1, 2, 3].map((i) => corr(i, { clientId: 'c0' }))], [], DEFAULT_CONFIDENCE_POLICY);
    const b = analyzeCorrections([...three, ...[1, 2, 3].map((i) => corr(i, { clientId: 'c0' }))].reverse(), [], DEFAULT_CONFIDENCE_POLICY);
    expect(a).toEqual(b);
    expect(a.map((x) => x.clientId)).toEqual(['c0', 'c1']);
    expect(a[0]!.rule.id).not.toBe(a[1]!.rule.id);
    expect(a[0]!.rule.id).toMatch(/^suggested-[0-9a-f]{24}$/);
  });
});

describe('buildCorrection', () => {
  const before: AccountClassification = {
    accountCode: '830',
    accountName: '소모품비',
    confidence: 97,
    source: 'exact_history',
    summary: '',
    reasons: [],
    evidence: {},
    alternatives: [],
  };
  const meta = {
    tx: { clientId: 'c1', merchantKey: '쿠팡', merchantBusinessNumber: BIZ },
    transactionId: 'tx1',
    userId: 'u1',
    createdAt: '2026-09-26T01:00:00Z',
  };

  it('builds a correction record with labels', () => {
    const c = buildCorrection(before, '146', { ...meta, reason: '온라인 판매 상품' });
    expect(c).toEqual({
      clientId: 'c1',
      merchantKey: '쿠팡',
      merchantBusinessNumber: BIZ,
      field: 'account',
      before: '830',
      after: '146',
      userId: 'u1',
      transactionId: 'tx1',
      createdAt: '2026-09-26T01:00:00Z',
      beforeLabel: '소모품비',
      afterLabel: '상품',
      beforeSource: 'exact_history',
      beforeConfidence: 97,
      reason: '온라인 판매 상품',
    });
  });

  it('returns null when nothing changed and throws on empty code', () => {
    expect(buildCorrection(before, '830', meta)).toBeNull();
    expect(() => buildCorrection(before, ' ', meta)).toThrow();
  });

  it('works from an unclassified result', () => {
    const c = buildCorrection({ ...before, accountCode: null, accountName: null, source: 'none', confidence: 0 }, '999', meta);
    expect(c!.before).toBeNull();
    expect(c!.afterLabel).toBeNull();
  });

  it('round-trips into analyzeCorrections', () => {
    const list = [1, 2, 3].map((i) => buildCorrection(before, '146', { ...meta, transactionId: `x${i}`, createdAt: `2026-09-2${i}T00:00:00Z` })!);
    expect(analyzeCorrections(list, [], DEFAULT_CONFIDENCE_POLICY)).toHaveLength(1);
  });

  it('carries the transaction direction when given, and the suggestion uses it', () => {
    const unclassified: AccountClassification = { ...before, accountCode: null, accountName: null, source: 'none', confidence: 0 };
    const list = [1, 2, 3].map(
      (i) =>
        buildCorrection(unclassified, '108', {
          ...meta,
          tx: { ...meta.tx, direction: 'sales' as const },
          transactionId: `s${i}`,
          createdAt: `2026-09-2${i}T00:00:00Z`,
        })!,
    );
    expect(list[0]!.direction).toBe('sales');
    const [s] = analyzeCorrections(list, [], DEFAULT_CONFIDENCE_POLICY);
    expect(s!.direction).toBe('sales');
    expect(s!.rule.name).toBe('쿠팡 (매출) → 외상매출금');
  });
});

describe('analyzeCorrections — direction-aware rule overlap', () => {
  it('a sales-only rule for the same merchant neither blocks nor conflicts with a purchase suggestion', () => {
    const salesRule = rule({
      id: 'sales-rule',
      accountCode: '401',
      condition: { all: [{ field: 'direction', op: 'eq', value: 'sales' }, { field: 'merchantBusinessNumber', op: 'eq', value: BIZ }] },
    });
    const [s] = analyzeCorrections(three, [salesRule], DEFAULT_CONFIDENCE_POLICY);
    expect(s!.direction).toBe('purchase');
    expect(s!.conflictingRuleIds).toEqual([]);
  });

  it('mixed explicit directions leave the rule unscoped and ask for review', () => {
    const list = [corr(1), corr(2), corr(3)].map((c, i) => ({ ...c, direction: i === 0 ? ('sales' as const) : ('purchase' as const) }));
    const [s] = analyzeCorrections(list, [], DEFAULT_CONFIDENCE_POLICY);
    expect(s!.direction).toBeNull();
    expect(s!.rule.condition).toEqual({ field: 'merchantBusinessNumber', op: 'eq', value: BIZ });
    expect(s!.suggestionReason).toContain('매입/매출 방향 미확인');
  });
});
