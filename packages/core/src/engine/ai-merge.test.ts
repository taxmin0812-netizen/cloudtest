import { describe, expect, it } from 'vitest';
import type { AccountClassification, AIClassificationSuggestion, ClientProfile, HistoryEntry, NormalizedTransaction } from '../types';
import { DEFAULT_CONFIDENCE_POLICY } from '../policy';
import { normalizeMerchantName } from '../normalize';
import { DEFAULT_ACCOUNT_CODES } from '../data/accounts';
import { buildClassificationContext, classifyAccount, hasAccountConflict } from './classify';
import { AI_CAP_AI_ONLY, AI_CAP_WITH_HISTORY, buildAiClassificationInput, hasSimilarHistory, mergeAiSuggestion } from './ai-merge';

const none: AccountClassification = {
  accountCode: null,
  accountName: null,
  confidence: 0,
  source: 'none',
  summary: '미분류: 과거 처리·규칙·사전 모두 해당 없음',
  reasons: [],
  evidence: { historyCount: 0, peerClientCount: 0 },
  alternatives: [],
};

const ai = (p: Partial<AIClassificationSuggestion> = {}): AIClassificationSuggestion => ({
  accountCode: '830',
  accountName: '소모품비',
  confidence: 95,
  rationale: '생활용품 판매점',
  provider: 'heuristic',
  model: null,
  ...p,
});

const cur = (p: Partial<AccountClassification>): AccountClassification => ({ ...none, ...p });

describe('mergeAiSuggestion', () => {
  it('returns current unchanged when AI has nothing', () => {
    expect(mergeAiSuggestion(none, null)).toBe(none);
  });

  it('fills an unclassified result, capped at 70 without similar history', () => {
    const r = mergeAiSuggestion(none, ai());
    expect(r.accountCode).toBe('830');
    expect(r.accountName).toBe('소모품비');
    expect(r.source).toBe('ai');
    expect(r.confidence).toBe(AI_CAP_AI_ONLY);
    expect(r.evidence.aiProvider).toBe('heuristic');
    expect(r.summary).toContain('AI 추천');
    expect(r.reasons).toContain('AI 근거: 생활용품 판매점');
    expect(r.reasons.some((x) => x.includes('상한 70'))).toBe(true);
  });

  it('cap 85 with similar history; explicit cap wins; lower AI confidence is kept', () => {
    expect(mergeAiSuggestion(none, ai(), { hasSimilarHistory: true }).confidence).toBe(AI_CAP_WITH_HISTORY);
    expect(mergeAiSuggestion(cur({ evidence: { historyCount: 3 } }), ai()).confidence).toBe(AI_CAP_WITH_HISTORY);
    expect(mergeAiSuggestion(none, ai(), { cap: 60 }).confidence).toBe(60);
    expect(mergeAiSuggestion(none, ai({ confidence: 42 })).confidence).toBe(42);
    expect(mergeAiSuggestion(none, ai({ confidence: 999 }), { hasSimilarHistory: true }).confidence).toBe(85);
  });

  it('never lets AI alone reach auto-approval', () => {
    const r = mergeAiSuggestion(none, ai({ confidence: 100 }), { hasSimilarHistory: true });
    expect(r.confidence).toBeLessThan(DEFAULT_CONFIDENCE_POLICY.autoApproveMin);
  });

  it('discards unknown or inactive accounts with a reason', () => {
    const r = mergeAiSuggestion(none, ai({ accountCode: '99999', accountName: '없는계정' }));
    expect(r.accountCode).toBeNull();
    expect(r.reasons.at(-1)).toBe('AI 추천 무시: 99999 없는계정 — 계정과목표에 없는 코드');
    const accounts = DEFAULT_ACCOUNT_CODES.map((a) => (a.code === '830' ? { ...a, active: false } : a));
    const r2 = mergeAiSuggestion(none, ai(), { accounts });
    expect(r2.source).toBe('none');
    expect(r2.reasons.at(-1)).toContain('비활성 계정');
  });

  it('does not override a confident classification; adds a quiet alternative', () => {
    const strong = cur({ accountCode: '146', accountName: '상품', confidence: 97, source: 'exact_history', evidence: { historyCount: 3 } });
    const r = mergeAiSuggestion(strong, ai({ confidence: 85 }));
    expect(r.accountCode).toBe('146');
    expect(r.confidence).toBe(97);
    expect(r.alternatives[0]).toMatchObject({ accountCode: '830', source: 'ai' });
    expect(hasAccountConflict(r)).toBe(false);
  });

  it('replaces a low classification when AI is more confident, moving the old one to alternatives', () => {
    const low = cur({ accountCode: '811', accountName: '복리후생비', confidence: 60, source: 'system_rule', evidence: { historyCount: 0 } });
    const r = mergeAiSuggestion(low, ai({ confidence: 90 }));
    expect(r.source).toBe('ai');
    expect(r.accountCode).toBe('830');
    expect(r.confidence).toBe(70);
    expect(r.alternatives[0]).toMatchObject({ accountCode: '811', confidence: 60, source: 'system_rule' });
  });

  it('keeps a low classification when AI is even lower', () => {
    const low = cur({ accountCode: '811', accountName: '복리후생비', confidence: 75, source: 'system_rule' });
    const r = mergeAiSuggestion(low, ai({ confidence: 50 }));
    expect(r.accountCode).toBe('811');
    expect(r.alternatives[0]).toMatchObject({ accountCode: '830', confidence: 50, source: 'ai' });
  });

  it('agreement raises a low classification up to the AI cap but keeps its source', () => {
    const low = cur({ accountCode: '830', accountName: '소모품비', confidence: 60, source: 'system_rule' });
    const r = mergeAiSuggestion(low, ai({ confidence: 99 }));
    expect(r.source).toBe('system_rule');
    expect(r.confidence).toBe(70);
    expect(r.reasons.at(-1)).toContain('AI 추천도 동일 계정');
  });

  it('lowThreshold follows context policy', () => {
    const mid = cur({ accountCode: '811', accountName: '복리후생비', confidence: 84, source: 'industry_pattern', evidence: { peerClientCount: 2 } });
    const ctx = { accounts: new Map(DEFAULT_ACCOUNT_CODES.map((a) => [a.code, a])), policy: { ...DEFAULT_CONFIDENCE_POLICY, quickReviewMin: 90 } };
    const r = mergeAiSuggestion(mid, ai({ confidence: 99 }), { context: ctx });
    expect(r.source).toBe('ai');
    expect(r.confidence).toBe(85);
  });
});

describe('AI input', () => {
  const client: ClientProfile = {
    id: 'c1',
    name: 'A',
    businessNumber: '1234567890',
    businessType: 'corporation',
    vatType: 'general',
    industry: 'construction',
    industryCode: null,
    deemedInputTaxEligible: false,
    nonDeductibleVehicles: [],
  };
  const h = (merchant: string, code: string, n: number): HistoryEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      clientId: 'c1',
      merchantKey: normalizeMerchantName(merchant),
      merchantBusinessNumber: null,
      accountCode: code,
      accountName: '',
      transactionDate: `2026-08-0${1 + i}`,
      totalAmount: 10_000,
      corrected: false,
      industry: 'construction',
    }));
  const ctx = buildClassificationContext({
    client,
    rules: [],
    history: [...h('스타벅스강남점', '811', 3), ...h('스타벅스역삼점', '813', 1), ...h('다른가게', '830', 5)],
    peerHistory: [{ ...h('미지상사', '820', 1)[0]!, clientId: 'c9' }],
    corrections: [],
    accounts: [...DEFAULT_ACCOUNT_CODES],
    policy: DEFAULT_CONFIDENCE_POLICY,
  });
  const tx = {
    clientId: 'c1',
    merchantName: '스타벅스 역삼점',
    merchantKey: normalizeMerchantName('스타벅스 역삼점'),
    merchantBusinessNumber: null,
    merchantCategory: '커피전문점',
    description: '법인카드 5409-1234-5678-9012 결제, 담당 900101-1234567',
    totalAmount: 12_000,
    evidenceType: 'card',
    direction: 'purchase',
    transactionDate: '2026-09-10',
    cardNumberMasked: '5409-****-****-9012',
  } as unknown as NormalizedTransaction;

  it('builds a scrubbed input with candidates and similar examples', () => {
    const input = buildAiClassificationInput(tx, ctx);
    expect(input.description).not.toContain('1234567');
    expect(input.description).not.toContain('5678');
    expect(input.description).not.toContain('5409-1234-5678-9012');
    expect('cardNumberMasked' in input).toBe(false);
    expect(input.industry).toBe('construction');
    expect(input.candidateAccounts.some((a) => a.code === '830')).toBe(true);
    expect(input.candidateAccounts.some((a) => a.code === '401')).toBe(false);
    expect(input.candidateAccounts.some((a) => a.code === '251')).toBe(false);
    expect(input.similarExamples[0]).toMatchObject({ merchantName: '스타벅스 역삼점', accountCode: '813', count: 1 });
    expect(input.similarExamples[1]).toMatchObject({ merchantName: '스타벅스강남점', accountCode: '811', count: 3 });
    expect(input.similarExamples.some((x) => x.accountCode === '830')).toBe(false);
    const sales = buildAiClassificationInput({ ...tx, direction: 'sales' }, ctx);
    expect(sales.candidateAccounts.every((a) => DEFAULT_ACCOUNT_CODES.find((d) => d.code === a.code)!.category === 'revenue')).toBe(true);
  });

  it('hasSimilarHistory', () => {
    expect(hasSimilarHistory(tx, ctx)).toBe(true);
    expect(hasSimilarHistory({ ...tx, merchantName: '미지상사', merchantKey: '미지상사' }, ctx)).toBe(true);
    expect(hasSimilarHistory({ ...tx, merchantName: '완전신규', merchantKey: '완전신규' }, ctx)).toBe(false);
  });

  it('end-to-end: none → AI fills at cap 70', () => {
    const t = { ...tx, merchantName: '완전신규', merchantKey: '완전신규', merchantCategory: null, description: '' };
    const c = classifyAccount(t, ctx);
    expect(c.source).toBe('none');
    const r = mergeAiSuggestion(c, ai(), { context: ctx, hasSimilarHistory: hasSimilarHistory(t, ctx) });
    expect(r.confidence).toBe(70);
    expect(r.source).toBe('ai');
  });
});
