import { describe, expect, it } from 'vitest';
import type {
  AccountCode,
  AIClassificationSuggestion,
  ClientProfile,
  CorrectionRecord,
  HistoryEntry,
  NormalizedTransaction,
} from '../types';
import { normalizeMerchantName } from '../normalize';
import { DEFAULT_CONFIDENCE_POLICY } from '../policy';
import { accountDirection, buildAccountMap, DEFAULT_ACCOUNT_CODES } from '../data/accounts';
import {
  buildClassificationContext,
  classifyAccount,
  classifyAccounts,
  CLASSIFY_PARAMS,
  hasAccountConflict,
  validateClassifyParams,
  type ClassificationContextInput,
} from './classify';
import { compareCorrection, isoToKstDate, parseInstant, type DirectedHistoryEntry } from './history';
import { buildAiClassificationInput, mergeAiSuggestion, scrubForAi } from './ai-merge';
import { analyzeCorrections } from './learning';

/**
 * 리뷰 회귀 테스트 — 회계 안전성(자동승인 오판) · 결정성 · 개인정보.
 */

const AUTO = DEFAULT_CONFIDENCE_POLICY.autoApproveMin;

function client(id: string, industry: ClientProfile['industry']): ClientProfile {
  return {
    id,
    name: id,
    businessNumber: '1234567890',
    businessType: 'corporation',
    vatType: 'general',
    industry,
    industryCode: null,
    deemedInputTaxEligible: false,
    nonDeductibleVehicles: [],
  };
}

const B = client('client-b', 'ecommerce');
const COUPANG = '1208800767';
const nameOf = (code: string) => DEFAULT_ACCOUNT_CODES.find((a) => a.code === code)?.name ?? code;

function tx(p: Partial<NormalizedTransaction> & { merchantName: string }): NormalizedTransaction {
  const total = p.totalAmount ?? 33_000;
  const supply = Math.round(total / 1.1);
  return {
    clientId: B.id,
    businessNumber: B.businessNumber,
    source: 'tax_invoice',
    channel: 'wemembers_file',
    direction: 'purchase',
    transactionDate: '2026-09-10',
    evidenceType: 'tax_invoice',
    merchantKey: normalizeMerchantName(p.merchantName),
    merchantBusinessNumber: null,
    merchantCategory: null,
    merchantTaxType: 'general',
    description: '',
    supplyAmount: supply,
    vatAmount: total - supply,
    serviceCharge: 0,
    totalAmount: total,
    cardNumberMasked: null,
    approvalNumber: null,
    originalSourceId: null,
    currency: 'KRW',
    isForeign: false,
    sourceDeductibleHint: null,
    rawData: {},
    sourceRowNumber: null,
    fingerprint: 'fp',
    ...p,
  };
}

/** n건 이력: start 부터 과거로 7일 간격 */
function hist(n: number, p: Partial<DirectedHistoryEntry> & { merchantName: string; accountCode: string }, start = '2026-08-01'): DirectedHistoryEntry[] {
  const { merchantName, ...rest } = p;
  const base = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  return Array.from({ length: n }, (_, i) => ({
    clientId: B.id,
    merchantKey: normalizeMerchantName(merchantName),
    merchantBusinessNumber: null,
    accountName: nameOf(p.accountCode),
    transactionDate: new Date(base - i * 7 * 86_400_000).toISOString().slice(0, 10),
    totalAmount: 32_000,
    corrected: false,
    industry: 'ecommerce' as const,
    ...rest,
  }));
}

function corr(p: Partial<CorrectionRecord> & { after: string }, i = 0): CorrectionRecord {
  return {
    clientId: B.id,
    merchantKey: normalizeMerchantName('쿠팡'),
    merchantBusinessNumber: COUPANG,
    field: 'account',
    before: '830',
    userId: 'u1',
    transactionId: `t-${i}`,
    createdAt: `2026-09-0${1 + (i % 9)}T02:00:00Z`,
    ...p,
  };
}

function ctx(p: Partial<ClassificationContextInput> = {}) {
  return buildClassificationContext({
    client: B,
    rules: [],
    history: [],
    peerHistory: [],
    corrections: [],
    accounts: DEFAULT_ACCOUNT_CODES as AccountCode[],
    policy: DEFAULT_CONFIDENCE_POLICY,
    asOfDate: '2026-09-15',
    ...p,
  });
}

// ────────────────────────────── 매입/매출 방향 ──────────────────────────────

describe('direction safety (이력에 매입/매출 구분이 없음)', () => {
  const coupangPurchases = () => hist(12, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG, accountCode: '146' });

  it('a first SALE to a supplier is never auto-approved as the purchase-side asset account (상품)', () => {
    const r = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG, direction: 'sales' }), ctx({ history: coupangPurchases() }));
    expect(r.confidence).toBeLessThan(DEFAULT_CONFIDENCE_POLICY.quickReviewMin);
    expect(r.confidence).toBe(CLASSIFY_PARAMS.unconfirmedSalesDirectionCap);
    if (r.accountCode === '146') expect(r.reasons.some((x) => x.includes('매입/매출 방향'))).toBe(true);
  });

  it('purchases of inventory from a pure supplier stay auto-approvable (no regression)', () => {
    const r = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG }), ctx({ history: coupangPurchases() }));
    expect(r.accountCode).toBe('146');
    expect(r.confidence).toBe(99);
  });

  it('a purchase from a counterparty that is also a customer is not auto-approved on an asset account', () => {
    const history = [
      ...hist(10, { merchantName: '한빛상사', merchantBusinessNumber: '2208162517', accountCode: '108' }),
      ...hist(3, { merchantName: '한빛상사', merchantBusinessNumber: '2208162517', accountCode: '401' }),
    ];
    const r = classifyAccount(tx({ merchantName: '한빛상사', merchantBusinessNumber: '2208162517' }), ctx({ history }));
    expect(r.accountCode).toBe('108');
    expect(r.confidence).toBe(CLASSIFY_PARAMS.unconfirmedDirectionCap);
    expect(r.reasons.some((x) => x.includes('매입/매출 방향'))).toBe(true);
  });

  it('explicit direction on history entries is honoured strictly and restores full confidence', () => {
    const history = [
      ...hist(10, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG, accountCode: '146', direction: 'purchase' }),
      ...hist(4, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG, accountCode: '108', direction: 'sales' }),
    ];
    const sale = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG, direction: 'sales' }), ctx({ history }));
    expect(sale.accountCode).toBe('108');
    expect(sale.confidence).toBe(97);
    expect(sale.alternatives.some((a) => a.accountCode === '146')).toBe(false);
    const buy = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG }), ctx({ history }));
    expect(buy.accountCode).toBe('146');
    expect(buy.confidence).toBe(99);
  });

  it('corrections with an explicit opposite direction are ignored', () => {
    const corrections = [{ ...corr({ after: '146' }), direction: 'purchase' as const }];
    const r = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG, direction: 'sales' }), ctx({ corrections }));
    expect(r.accountCode).toBeNull();
  });

  it('peer purchase patterns on asset accounts do not become sales classifications silently', () => {
    const peerHistory = ['p1', 'p2', 'p3'].flatMap((cid) =>
      hist(2, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG, accountCode: '146', clientId: cid }),
    );
    const r = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG, direction: 'sales' }), ctx({ peerHistory }));
    if (r.accountCode === '146') expect(r.reasons.some((x) => x.includes('매입/매출 방향'))).toBe(true);
    expect(r.confidence).toBeLessThan(AUTO);
  });
});

describe('direction safety for user rules without a direction condition', () => {
  const rule = (condition: import('../types').Condition, accountCode: string) => ({
    id: 'r1',
    clientId: B.id,
    name: '쿠팡 규칙',
    condition,
    accountCode,
    accountName: nameOf(accountCode),
    vatOverride: null,
    confidence: 99,
    priority: 100,
    status: 'active' as const,
    origin: 'user' as const,
  });
  const byBizno = { field: 'merchantBusinessNumber' as const, op: 'eq' as const, value: COUPANG };

  it('an unscoped rule to an asset account still wins on a sale but is not auto-approved', () => {
    const c = ctx({ rules: [rule(byBizno, '146')] });
    const sale = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG, direction: 'sales' }), c);
    expect(sale.source).toBe('user_rule');
    expect(sale.confidence).toBeLessThan(DEFAULT_CONFIDENCE_POLICY.quickReviewMin);
    expect(sale.reasons.some((x) => x.includes('방향 조건 추가 권장'))).toBe(true);
    const buy = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG }), c);
    expect(buy.confidence).toBe(99);
  });

  it('a rule scoped to sales, or mapping to a revenue account, keeps full confidence', () => {
    const scoped = rule({ all: [{ field: 'direction', op: 'eq', value: 'sales' }, byBizno] }, '108');
    const s1 = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG, direction: 'sales' }), ctx({ rules: [scoped] }));
    expect(s1.confidence).toBe(99);
    const revenue = classifyAccount(
      tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG, direction: 'sales' }),
      ctx({ rules: [rule(byBizno, '401')] }),
    );
    expect(revenue.confidence).toBe(99);
  });
});

// ────────────────────────────── 수정 우선 원칙 vs 가중 다수 ──────────────────────────────

describe('correction priority uses what history would actually recommend', () => {
  it('a recent correction is not overridden by recency-weighted stale history', () => {
    // 1년 전 146 ×5 (건수 다수) + 최근 830 ×4 (가중 다수) → 직원이 830 → 146 으로 수정
    const history = [
      ...hist(5, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG, accountCode: '146' }, '2025-06-01'),
      ...hist(4, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG, accountCode: '830' }, '2026-08-20'),
    ];
    const corrections = [corr({ before: '830', after: '146' }, 4)];
    const r = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG }), ctx({ history, corrections }));
    expect(r.accountCode).toBe('146');
    expect(r.source).toBe('correction_memory');
    for (const a of r.alternatives) expect(a.confidence).toBeLessThanOrEqual(r.confidence);
  });
});

// ────────────────────────────── 상호 일치 + 사업자번호 상이 ──────────────────────────────

describe('name history with a conflicting business number', () => {
  it('is never auto-approved when every same-name entry belongs to a different business number', () => {
    const history = hist(12, { merchantName: '한결상사', merchantBusinessNumber: '1111111119', accountCode: '830' });
    const r = classifyAccount(tx({ merchantName: '한결상사', merchantBusinessNumber: '2208162517' }), ctx({ history }));
    expect(r.source).toBe('name_history');
    expect(r.accountCode).toBe('830');
    expect(r.confidence).toBeLessThan(AUTO);
    expect(r.reasons.some((x) => x.includes('사업자번호 상이'))).toBe(true);
  });

  it('entries of a different business are excluded when same-name entries without a number exist', () => {
    const history = [
      ...hist(5, { merchantName: '한결상사', accountCode: '830' }),
      ...hist(8, { merchantName: '한결상사', merchantBusinessNumber: '1111111119', accountCode: '813' }),
    ];
    const r = classifyAccount(tx({ merchantName: '한결상사', merchantBusinessNumber: '2208162517' }), ctx({ history }));
    expect(r.accountCode).toBe('830');
    expect(r.evidence.historyCount).toBe(5);
    expect(r.reasons.some((x) => x.includes('사업자번호가 다른 동명 이력 8건 제외'))).toBe(true);
  });
});

// ────────────────────────────── 수정 반복 횟수 = 거래 수 ──────────────────────────────

describe('repeated edits of the same transaction count once', () => {
  it('engine: toggling one transaction three times is one correction', () => {
    const corrections = [
      corr({ before: '830', after: '146', transactionId: 'same', createdAt: '2026-09-01T01:00:00Z' }),
      corr({ before: '146', after: '830', transactionId: 'same', createdAt: '2026-09-01T02:00:00Z' }),
      corr({ before: '830', after: '146', transactionId: 'same', createdAt: '2026-09-01T03:00:00Z' }),
    ];
    const r = classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG }), ctx({ corrections }));
    expect(r.accountCode).toBe('146');
    expect(r.confidence).toBe(90);
  });

  it('learning: edits of one transaction never reach the suggestion threshold', () => {
    const corrections = [1, 2, 3].map((h) => corr({ after: '146', transactionId: 'same', createdAt: `2026-09-01T0${h}:00:00Z` }));
    expect(analyzeCorrections(corrections, [], DEFAULT_CONFIDENCE_POLICY)).toEqual([]);
  });

  it('learning: a transaction corrected to 146 and then back to 830 does not count toward 146', () => {
    const corrections = [
      corr({ after: '146', transactionId: 'a' }, 1),
      corr({ after: '146', transactionId: 'b' }, 2),
      corr({ after: '146', transactionId: 'c' }, 3),
      corr({ before: '146', after: '830', transactionId: 'c' }, 4),
      corr({ after: '146', transactionId: 'd' }, 5),
    ];
    const s = analyzeCorrections(corrections, [], DEFAULT_CONFIDENCE_POLICY);
    expect(s).toHaveLength(1);
    expect(s[0]!.correctionCount).toBe(3);
    expect(s[0]!.transactionIds).toEqual(['a', 'b', 'd']);
  });
});

// ────────────────────────────── 학습 제안의 방향 조건 ──────────────────────────────

describe('suggested rules are scoped to the transaction direction', () => {
  it('adds a purchase direction condition when the accounts imply it', () => {
    const corrections = [1, 2, 3].map((i) => corr({ before: '830', after: '146' }, i));
    const [s] = analyzeCorrections(corrections, [], DEFAULT_CONFIDENCE_POLICY);
    expect(s!.rule.condition).toEqual({
      all: [
        { field: 'direction', op: 'eq', value: 'purchase' },
        { field: 'merchantBusinessNumber', op: 'eq', value: COUPANG },
      ],
    });
    expect(s!.direction).toBe('purchase');
  });

  it('the suggested rule does not fire on a sale once approved', () => {
    const corrections = [1, 2, 3].map((i) => corr({ before: '830', after: '146' }, i));
    const [s] = analyzeCorrections(corrections, [], DEFAULT_CONFIDENCE_POLICY);
    const approved = { ...s!.rule, status: 'active' as const };
    const c = ctx({ rules: [approved] });
    expect(classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG }), c).source).toBe('user_rule');
    expect(classifyAccount(tx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG, direction: 'sales' }), c).source).not.toBe('user_rule');
  });

  it('explicit direction on correction records wins; unknown direction is flagged for review', () => {
    const sales = [1, 2, 3].map((i) => ({ ...corr({ before: null, after: '108' }, i), direction: 'sales' as const }));
    expect(analyzeCorrections(sales, [], DEFAULT_CONFIDENCE_POLICY)[0]!.direction).toBe('sales');
    const unknown = [1, 2, 3].map((i) => corr({ before: null, after: '146' }, i));
    const [u] = analyzeCorrections(unknown, [], DEFAULT_CONFIDENCE_POLICY);
    expect(u!.direction).toBeNull();
    expect(u!.suggestionReason).toContain('매입/매출 방향 미확인');
  });
});

// ────────────────────────────── AI 병합 안전장치 ──────────────────────────────

describe('AI merge safety', () => {
  const ai = (p: Partial<AIClassificationSuggestion> = {}): AIClassificationSuggestion => ({
    accountCode: '830',
    accountName: '소모품비',
    confidence: 100,
    rationale: 'x',
    provider: 'p',
    model: null,
    ...p,
  });
  const none = classifyAccount(tx({ merchantName: '알수없음' }), ctx());

  it('an explicit cap can lower but never raise AI above the with-history ceiling', () => {
    expect(mergeAiSuggestion(none, ai(), { cap: 100, hasSimilarHistory: true }).confidence).toBe(85);
    expect(mergeAiSuggestion(none, ai(), { cap: 100 }).confidence).toBeLessThan(AUTO);
  });

  it('rejects an AI account that contradicts the transaction direction', () => {
    const r = mergeAiSuggestion(none, ai({ accountCode: '401', accountName: '상품매출' }), { direction: 'purchase' });
    expect(r.accountCode).toBeNull();
    expect(r.reasons.at(-1)).toContain('매입/매출 방향');
  });

  it('never replaces a user rule or a manual decision, even a low-confidence one', () => {
    const userRule = { ...none, accountCode: '811', accountName: '복리후생비', confidence: 70, source: 'user_rule' as const };
    const r = mergeAiSuggestion(userRule, ai({ confidence: 99 }), { hasSimilarHistory: true });
    expect(r.accountCode).toBe('811');
    expect(r.source).toBe('user_rule');
    expect(r.alternatives.some((a) => a.source === 'ai')).toBe(true);
  });

  it('AI input masks phone, account and e-mail patterns and the merchant name in examples', () => {
    const history = hist(2, { merchantName: '홍길동 010-1234-5678', accountCode: '830' });
    const c = ctx({ history });
    const input = buildAiClassificationInput(
      tx({
        merchantName: '홍길동 010-1234-5678',
        merchantKey: history[0]!.merchantKey,
        description: '이체 110-123-456789 hong@example.com 01012345678',
      }),
      c,
    );
    const blob = JSON.stringify(input);
    expect(blob).not.toContain('1234-5678');
    expect(blob).not.toContain('01012345678');
    expect(blob).not.toContain('110-123-456789');
    expect(blob).not.toContain('hong@example.com');
    expect(input.similarExamples[0]!.merchantName).not.toContain('5678');
  });
});

// ────────────────────────────── 결정성: 시간대 ──────────────────────────────

describe('timestamps without an offset are read as KST regardless of the machine timezone', () => {
  it('isoToKstDate / compareCorrection', () => {
    expect(isoToKstDate('2026-09-05T20:00:00')).toBe('2026-09-05');
    expect(isoToKstDate('2026-09-05 23:59:59')).toBe('2026-09-05');
    expect(isoToKstDate('2026-09-05T20:00:00Z')).toBe('2026-09-06');
    expect(isoToKstDate('2026-09-05 11:00:00+00')).toBe('2026-09-05');
    const a = corr({ after: '146', createdAt: '2026-09-05T10:00:00' }); // KST 10시 = 01:00Z
    const b = corr({ after: '830', createdAt: '2026-09-05T02:00:00Z' });
    expect(compareCorrection(a, b)).toBeLessThan(0);
  });
});

// ────────────────────────────── 파라미터 검증 ──────────────────────────────

describe('params validation', () => {
  it('rejects out-of-range office settings instead of silently mis-classifying', () => {
    expect(() => ctx({ params: { industryMinAgreement: 80 } })).toThrow(/industryMinAgreement/);
    expect(() => ctx({ params: { exactHistoryLadder: [] } })).toThrow(/exactHistoryLadder/);
    expect(() => ctx({ params: { amountDeviationPenalty: Number.NaN } })).toThrow(/amountDeviationPenalty/);
    expect(() => ctx({ params: { correctionWindowDays: null } })).not.toThrow();
  });
});

describe('helpers added in review', () => {
  it('accountDirection: only expense/cogs and revenue are unambiguous', () => {
    const m = buildAccountMap(DEFAULT_ACCOUNT_CODES);
    expect(accountDirection('830', m)).toBe('purchase');
    expect(accountDirection('451', m)).toBe('purchase');
    expect(accountDirection('401', m)).toBe('sales');
    expect(accountDirection('146', m)).toBeNull();
    expect(accountDirection('253', m)).toBeNull();
    expect(accountDirection('99999', m)).toBeNull();
    expect(accountDirection(null, m)).toBeNull();
  });

  it('scrubForAi keeps amounts, dates and short approval numbers', () => {
    expect(scrubForAi('3월 사무용품 32,000원 2026-09-10 승인 12345678')).toBe('3월 사무용품 32,000원 2026-09-10 승인 12345678');
    expect(scrubForAi('대표 02-123-4567')).toBe('대표 [전화번호]');
    expect(scrubForAi('카드 1234-5678-9012-3456')).toBe('카드 1234-****-****-3456');
    expect(scrubForAi('주민 900101-1234567')).toBe('주민 900101-1******');
    expect(scrubForAi(null)).toBe('');
  });

  it('parseInstant accepts DB-style offsets', () => {
    expect(parseInstant('2026-09-05 11:00:00+00')).toBe(Date.parse('2026-09-05T11:00:00Z'));
    expect(parseInstant('2026-09-05T20:00:00+09:00')).toBe(Date.parse('2026-09-05T11:00:00Z'));
    expect(parseInstant('2026-09-05')).toBe(Date.parse('2026-09-04T15:00:00Z'));
    expect(Number.isNaN(parseInstant('not a date'))).toBe(true);
  });

  it('AI never reaches a lowered auto-approval threshold', () => {
    const none = classifyAccount(tx({ merchantName: '알수없음' }), ctx());
    const c = { accounts: buildAccountMap(DEFAULT_ACCOUNT_CODES), policy: { ...DEFAULT_CONFIDENCE_POLICY, autoApproveMin: 80, quickReviewMin: 70 } };
    const r = mergeAiSuggestion(none, { accountCode: '830', accountName: '소모품비', confidence: 99, rationale: '', provider: 'p', model: null }, { context: c, hasSimilarHistory: true });
    expect(r.confidence).toBe(79);
  });

  it('validateClassifyParams accepts defaults and rejects a system cap that could auto-approve', () => {
    expect(() => validateClassifyParams({ ...CLASSIFY_PARAMS })).not.toThrow();
    expect(() => validateClassifyParams({ ...CLASSIFY_PARAMS, systemRuleCap: 99 })).toThrow(/systemRuleCap/);
  });

  it('hasAccountConflict is exported for the decision pipeline', () => {
    expect(typeof hasAccountConflict).toBe('function');
  });
});

// ────────────────────────────── 최악의 경우 성능 ──────────────────────────────

describe('performance — no cache hits', () => {
  it('10,000 distinct counterparties with 2,000 own + 20,000 peer history entries < 1500ms', () => {
    const history: DirectedHistoryEntry[] = [];
    for (let i = 0; i < 2000; i++) {
      history.push({
        clientId: B.id,
        merchantKey: `상대${i}`,
        merchantBusinessNumber: String(2000000000 + i),
        accountCode: ['830', '146', '811', '108'][i % 4]!,
        accountName: '',
        transactionDate: `2026-0${1 + (i % 8)}-10`,
        totalAmount: 10_000 + i,
        corrected: i % 13 === 0,
        industry: 'ecommerce',
        direction: i % 7 === 0 ? 'sales' : undefined,
      });
    }
    const peerHistory: DirectedHistoryEntry[] = [];
    for (let i = 0; i < 20_000; i++) {
      peerHistory.push({
        clientId: `peer-${i % 50}`,
        merchantKey: `상대${i % 10_000}`,
        merchantBusinessNumber: null,
        accountCode: ['830', '146', '401'][i % 3]!,
        accountName: '',
        transactionDate: '2026-07-01',
        totalAmount: 20_000,
        corrected: false,
        industry: i % 2 === 0 ? 'ecommerce' : 'construction',
      });
    }
    const corrections = Array.from({ length: 500 }, (_, i) =>
      corr({ merchantKey: `상대${i * 3}`, merchantBusinessNumber: String(2000000000 + i * 3), after: '146', transactionId: `c${i}` }, i),
    );
    const txs = Array.from({ length: 10_000 }, (_, i) =>
      tx({
        merchantName: `상대${i}`,
        merchantKey: `상대${i}`,
        merchantBusinessNumber: i % 2 === 0 ? String(2000000000 + i) : null,
        direction: i % 5 === 0 ? 'sales' : 'purchase',
        description: i % 9 === 0 ? '통신요금' : '',
      }),
    );
    const t0 = performance.now();
    const c = ctx({ history, peerHistory, corrections });
    const results = classifyAccounts(txs, c);
    const t1 = performance.now();
    expect(results).toHaveLength(10_000);
    for (const r of results) {
      expect(Number.isInteger(r.confidence)).toBe(true);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
    }
    // eslint-disable-next-line no-console
    console.info(`[perf worst-case] ${(t1 - t0).toFixed(0)}ms`);
    expect(t1 - t0).toBeLessThan(1500);
  });
});

// 타입 전용 사용 (HistoryEntry 호환성)
const _compat: HistoryEntry = hist(1, { merchantName: 'x', accountCode: '830' })[0]!;
void _compat;
