import { describe, expect, it } from 'vitest';
import type {
  AccountCode,
  ClientProfile,
  CorrectionRecord,
  HistoryEntry,
  MappingRule,
  NormalizedTransaction,
} from '../types';
import { normalizeMerchantName } from '../normalize';
import { DEFAULT_CONFIDENCE_POLICY } from '../policy';
import { DEFAULT_ACCOUNT_CODES } from '../data/accounts';
import {
  buildClassificationContext,
  classifyAccount,
  classifyAccounts,
  CLASSIFY_PARAMS,
  compilePrefilter,
  hasAccountConflict,
  transactionConditionContext,
  type ClassificationContextInput,
} from './classify';
import { UNCLASSIFIED_SUMMARY } from './explain';

// ────────────────────────────── fixtures ──────────────────────────────

function client(id: string, industry: ClientProfile['industry'], name = id): ClientProfile {
  return {
    id,
    name,
    businessNumber: '1234567890',
    businessType: 'corporation',
    vatType: 'general',
    industry,
    industryCode: null,
    deemedInputTaxEligible: false,
    nonDeductibleVehicles: [],
  };
}

const A = client('client-a', 'construction', 'A건설');
const B = client('client-b', 'ecommerce', 'B커머스');

const COUPANG_BIZNO = '1208800767';
const ABC_BIZNO = '2208162517';

function mkTx(p: Partial<NormalizedTransaction> & { merchantName: string }): NormalizedTransaction {
  const total = p.totalAmount ?? 33_000;
  const supply = Math.round(total / 1.1);
  return {
    clientId: A.id,
    businessNumber: A.businessNumber,
    source: 'business_card',
    channel: 'wemembers_file',
    direction: 'purchase',
    transactionDate: '2026-09-10',
    evidenceType: 'card',
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

const ACC = new Map(DEFAULT_ACCOUNT_CODES.map((a) => [a.code, a]));
const nameOf = (code: string) => ACC.get(code)?.name ?? code;

/** n건 이력: 2026-08-01 부터 과거로 7일 간격 */
function mkHist(
  n: number,
  p: Partial<HistoryEntry> & { merchantName: string; accountCode: string },
  start = '2026-08-01',
): HistoryEntry[] {
  const { merchantName, ...rest } = p;
  const out: HistoryEntry[] = [];
  const base = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  for (let i = 0; i < n; i++) {
    const d = new Date(base - i * 7 * 86_400_000).toISOString().slice(0, 10);
    out.push({
      clientId: A.id,
      merchantKey: normalizeMerchantName(merchantName),
      merchantBusinessNumber: null,
      accountName: nameOf(p.accountCode),
      transactionDate: d,
      totalAmount: 32_000,
      corrected: false,
      industry: 'construction',
      ...rest,
    });
  }
  return out;
}

function mkRule(p: Partial<MappingRule> & { id: string; accountCode: string; condition: MappingRule['condition'] }): MappingRule {
  return {
    clientId: A.id,
    name: p.id,
    accountName: nameOf(p.accountCode),
    vatOverride: null,
    confidence: 99,
    priority: 100,
    status: 'active',
    origin: 'user',
    ...p,
  };
}

function mkCorr(p: Partial<CorrectionRecord> & { merchantName: string; after: string }, i = 0): CorrectionRecord {
  const { merchantName, ...rest } = p;
  return {
    clientId: A.id,
    merchantKey: normalizeMerchantName(merchantName),
    merchantBusinessNumber: null,
    field: 'account',
    before: '830',
    userId: 'user-1',
    transactionId: `tx-corr-${i}`,
    createdAt: `2026-09-0${1 + (i % 9)}T02:00:00Z`,
    ...rest,
  };
}

function ctxFor(p: Partial<ClassificationContextInput> = {}) {
  return buildClassificationContext({
    client: A,
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

// ────────────────────────────── Level 7: none ──────────────────────────────

describe('none (미분류)', () => {
  it('returns null account with fixed summary when nothing applies', () => {
    const r = classifyAccount(mkTx({ merchantName: '알수없는상호' }), ctxFor());
    expect(r.accountCode).toBeNull();
    expect(r.accountName).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.source).toBe('none');
    expect(r.summary).toBe(UNCLASSIFIED_SUMMARY);
    expect(r.summary).toBe('미분류: 과거 처리·규칙·사전 모두 해당 없음');
    expect(r.alternatives).toEqual([]);
    expect(r.evidence.historyCount).toBe(0);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('throws when transaction belongs to another client', () => {
    expect(() => classifyAccount(mkTx({ merchantName: 'x', clientId: 'other' }), ctxFor())).toThrow(/clientId/);
  });
});

// ────────────────────────────── Level 6: system_rule ──────────────────────────────

describe('system_rule (시스템 기본사전)', () => {
  const cases: Array<[string, string]> = [
    ['(주)케이티', '814'],
    ['KT 통신요금', '814'],
    ['SK텔레콤', '814'],
    ['LG U+', '814'],
    ['한국전력공사', '815'],
    ['서울도시가스', '815'],
    ['ADOBE *CREATIVE CLOUD', '831'],
    ['AWS AMAZON.COM', '831'],
    ['GOOGLE*WORKSPACE', '831'],
    ['쿠팡(주)', '830'],
    ['아성다이소 강남점', '830'],
    ['GS칼텍스 역삼주유소', '822'],
    ['SK에너지 대치', '822'],
    ['카카오T 택시', '812'],
    ['KTX 코레일', '812'],
    ['스타벅스 강남R점', '811'],
    ['우체국', '824'],
    ['CJ대한통운', '824'],
    ['교보문고', '826'],
    ['YES24', '826'],
    ['네이버광고', '833'],
    ['FACEBK *ADS', '833'],
    ['국민건강보험공단', '817'],
    ['역삼세무서', '817'],
    ['카페24', '831'],
    ['쿠팡이츠', '811'],
    ['KT텔레캅', '831'],
  ];
  for (const [name, code] of cases) {
    it(`${name} → ${code}`, () => {
      const r = classifyAccount(mkTx({ merchantName: name }), ctxFor());
      expect(r.accountCode).toBe(code);
      expect(r.source).toBe('system_rule');
      expect(r.confidence).toBeLessThanOrEqual(90);
      expect(r.summary).toContain('시스템 기본사전');
      expect(r.evidence.ruleId).toMatch(/^SYS-/);
    });
  }

  it('generic restaurant → 811 with low confidence (must review)', () => {
    const r = classifyAccount(mkTx({ merchantName: '할매국밥' }), ctxFor());
    expect(r.accountCode).toBe('811');
    expect(r.confidence).toBeLessThan(DEFAULT_CONFIDENCE_POLICY.quickReviewMin);
    const byCategory = classifyAccount(mkTx({ merchantName: '행복한집', merchantCategory: '일반음식점' }), ctxFor());
    expect(byCategory.accountCode).toBe('811');
  });

  it('does not treat KT&G / DESKTOP as telecom', () => {
    expect(classifyAccount(mkTx({ merchantName: 'KT&G' }), ctxFor()).accountCode).not.toBe('814');
    expect(classifyAccount(mkTx({ merchantName: 'DESKTOP MALL' }), ctxFor()).accountCode).not.toBe('814');
  });

  it('dictionary applies to purchases only', () => {
    const r = classifyAccount(mkTx({ merchantName: '(주)케이티', direction: 'sales' }), ctxFor());
    expect(r.source).toBe('none');
  });

  it('shadowed dictionary matches do not create a conflict', () => {
    const r = classifyAccount(mkTx({ merchantName: '카페24' }), ctxFor());
    expect(r.accountCode).toBe('831');
    expect(hasAccountConflict(r)).toBe(false);
  });

  it('DB system_default rule overrides built-in entry with the same id; disabled turns it off', () => {
    const override = mkRule({
      id: 'SYS-SUP-01',
      clientId: null,
      origin: 'system_default',
      accountCode: '829',
      confidence: 99, // 상한 90 적용
      condition: { field: 'merchantKey', op: 'contains', value: '쿠팡' },
    });
    const r = classifyAccount(mkTx({ merchantName: '쿠팡' }), ctxFor({ rules: [override] }));
    expect(r.accountCode).toBe('829');
    expect(r.confidence).toBe(90);

    const off = { ...override, status: 'disabled' as const };
    expect(classifyAccount(mkTx({ merchantName: '쿠팡' }), ctxFor({ rules: [off] })).source).toBe('none');
  });

  it('useBuiltinDictionary=false disables built-in dictionary', () => {
    const r = classifyAccount(mkTx({ merchantName: '(주)케이티' }), ctxFor({ useBuiltinDictionary: false }));
    expect(r.source).toBe('none');
  });
});

// ────────────────────────────── Level 1: user_rule ──────────────────────────────

describe('user_rule (사용자 승인 규칙)', () => {
  const coupangCond = { field: 'merchantKey', op: 'contains', value: '쿠팡' } as const;

  it('active client rule wins over history and dictionary', () => {
    const history = mkHist(12, { merchantName: '쿠팡', accountCode: '830' });
    const rules = [mkRule({ id: 'r1', name: '쿠팡 → 상품', accountCode: '146', condition: coupangCond, confidence: 100 })];
    const r = classifyAccount(mkTx({ merchantName: '쿠팡' }), ctxFor({ rules, history }));
    expect(r.source).toBe('user_rule');
    expect(r.accountCode).toBe('146');
    expect(r.confidence).toBe(100);
    expect(r.evidence.ruleId).toBe('r1');
    expect(r.summary).toBe('사용자 규칙 「쿠팡 → 상품」 적용 → 상품');
    expect(r.evidence.historyCount).toBe(12);
    expect(r.evidence.consistentCount).toBe(0);
    // 승인 규칙은 의도된 결정 → 이력과 달라도 충돌로 올리지 않는다
    expect(r.alternatives.map((a) => a.accountCode)).toContain('830');
    expect(hasAccountConflict(r)).toBe(false);
  });

  it('higher priority first; shadowed rule becomes a quiet alternative', () => {
    const rules = [
      mkRule({ id: 'general', accountCode: '830', condition: coupangCond, priority: 100 }),
      mkRule({
        id: 'big',
        accountCode: '212',
        priority: 200,
        condition: { all: [coupangCond, { field: 'totalAmount', op: 'gt', value: 1_000_000 }] },
      }),
    ];
    const small = classifyAccount(mkTx({ merchantName: '쿠팡', totalAmount: 50_000 }), ctxFor({ rules }));
    expect(small.evidence.ruleId).toBe('general');
    const big = classifyAccount(mkTx({ merchantName: '쿠팡', totalAmount: 2_500_000 }), ctxFor({ rules }));
    expect(big.evidence.ruleId).toBe('big');
    expect(big.accountCode).toBe('212');
    expect(hasAccountConflict(big)).toBe(false);
  });

  it('ignores suggested / disabled / other-client rules; accepts approved system_suggested', () => {
    const base = { accountCode: '146', condition: coupangCond };
    const ignored = [
      mkRule({ id: 's', status: 'suggested', origin: 'system_suggested', ...base }),
      mkRule({ id: 'd', status: 'disabled', ...base }),
      mkRule({ id: 'o', clientId: 'client-other', ...base }),
    ];
    const r = classifyAccount(mkTx({ merchantName: '쿠팡' }), ctxFor({ rules: ignored }));
    expect(r.source).toBe('system_rule');
    const approved = mkRule({ id: 'ok', status: 'active', origin: 'system_suggested', ...base });
    const r2 = classifyAccount(mkTx({ merchantName: '쿠팡' }), ctxFor({ rules: [...ignored, approved] }));
    expect(r2.source).toBe('user_rule');
    expect(r2.evidence.ruleId).toBe('ok');
  });

  it('priority ties are broken deterministically (confidence, then id)', () => {
    const rules = [
      mkRule({ id: 'b', accountCode: '830', condition: coupangCond, confidence: 99 }),
      mkRule({ id: 'a', accountCode: '146', condition: coupangCond, confidence: 99 }),
    ];
    expect(classifyAccount(mkTx({ merchantName: '쿠팡' }), ctxFor({ rules })).evidence.ruleId).toBe('a');
    expect(classifyAccount(mkTx({ merchantName: '쿠팡' }), ctxFor({ rules: [...rules].reverse() })).evidence.ruleId).toBe('a');
  });

  it('malformed rule condition is treated as non-matching', () => {
    const bad = mkRule({ id: 'bad', accountCode: '146', condition: { all: 'x' } as unknown as MappingRule['condition'] });
    const r = classifyAccount(mkTx({ merchantName: '쿠팡' }), ctxFor({ rules: [bad] }));
    expect(r.source).toBe('system_rule');
  });

  it('rule mapping to an expense account is skipped for sales transactions', () => {
    const rules = [mkRule({ id: 'r', accountCode: '830', condition: coupangCond })];
    const r = classifyAccount(mkTx({ merchantName: '쿠팡', direction: 'sales' }), ctxFor({ rules }));
    expect(r.source).toBe('none');
  });
});

// ────────────────────────────── Level 2: exact_history ──────────────────────────────

describe('exact_history (동일 사업자번호)', () => {
  const ladder: Array<[number, number]> = [
    [1, 92],
    [2, 95],
    [3, 97],
    [4, 97],
    [5, 98],
    [9, 98],
    [10, 99],
    [25, 99],
  ];
  for (const [n, conf] of ladder) {
    it(`${n}건 일관 → ${conf}`, () => {
      const history = mkHist(n, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' });
      const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ history }));
      expect(r.source).toBe('exact_history');
      expect(r.accountCode).toBe('830');
      expect(r.confidence).toBe(conf);
      expect(r.evidence.historyCount).toBe(n);
      expect(r.evidence.consistentCount).toBe(n);
    });
  }

  it('produces the spec-style summary and reasons', () => {
    const history = mkHist(14, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' });
    const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, totalAmount: 30_000 }), ctxFor({ history }));
    expect(r.summary).toBe('ABC쇼핑의 전기 14건 모두 소모품비 처리');
    expect(r.reasons).toContain('동일 거래처 전기 14건 동일처리');
    expect(r.reasons).toContain('동일 상대방(사업자번호 일치)');
    expect(r.reasons).toContain('평균금액 유사 (평균 32,000원)');
    expect(r.reasons).toContain('최근 수정이력 없음');
    expect(r.evidence.lastUsedDate).toBe('2026-08-01');
    expect(r.evidence.averageAmount).toBe(32_000);
    expect(r.evidence.correctionCount).toBe(0);
  });

  it('matches on business number even if the name changed', () => {
    const history = mkHist(5, { merchantName: '에이비씨쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' });
    const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑 신사점', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ history }));
    expect(r.source).toBe('exact_history');
    expect(r.confidence).toBe(98);
  });

  it('split history → dominant account, reduced confidence, alternatives', () => {
    const history = [
      ...mkHist(9, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' }),
      ...mkHist(1, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '212' }, '2025-12-01'),
    ];
    const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ history }));
    expect(r.accountCode).toBe('830');
    expect(r.confidence).toBeLessThan(98);
    expect(r.confidence).toBeGreaterThanOrEqual(95);
    expect(r.summary).toBe('ABC쇼핑의 전기 10건 중 9건 소모품비 처리');
    expect(r.alternatives[0]?.accountCode).toBe('212');
    expect(hasAccountConflict(r)).toBe(false);
  });

  it('evenly split history → account conflict (must review)', () => {
    const history = [
      ...mkHist(4, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' }),
      ...mkHist(4, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '146' }, '2026-07-30'),
    ];
    const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ history }));
    expect(r.confidence).toBeLessThan(DEFAULT_CONFIDENCE_POLICY.quickReviewMin);
    expect(hasAccountConflict(r)).toBe(true);
    expect(r.alternatives.length).toBe(1);
    expect(r.alternatives[0]!.confidence).toBeLessThanOrEqual(r.confidence);
  });

  it('recent entries outweigh old ones when choosing the dominant account', () => {
    const history = [
      ...mkHist(3, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' }, '2023-01-01'),
      ...mkHist(3, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '146' }, '2026-08-01'),
    ];
    const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ history }));
    expect(r.accountCode).toBe('146');
    expect(r.alternatives[0]!.accountCode).toBe('830');
    expect(r.alternatives[0]!.confidence).toBeLessThan(r.confidence);
  });

  it('amount far above the client-merchant average lowers confidence', () => {
    const history = mkHist(12, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830', totalAmount: 30_000 });
    const ctx = ctxFor({ history });
    const normal = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, totalAmount: 35_000 }), ctx);
    const big = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, totalAmount: 1_500_000 }), ctx);
    expect(normal.confidence).toBe(99);
    expect(big.confidence).toBe(99 - CLASSIFY_PARAMS.amountDeviationPenalty);
    expect(big.reasons.some((x) => x.startsWith('금액 이례적'))).toBe(true);
    // 경계: 정확히 3배는 이상치 아님
    const edge = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, totalAmount: 90_000 }), ctx);
    expect(edge.confidence).toBe(99);
  });

  it('ignores history whose account is incompatible with the transaction direction', () => {
    const history = mkHist(5, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' });
    const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, direction: 'sales' }), ctxFor({ history }));
    expect(r.source).toBe('none');
    const salesHistory = mkHist(3, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '401' });
    const r2 = classifyAccount(
      mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, direction: 'sales' }),
      ctxFor({ history: [...history, ...salesHistory] }),
    );
    expect(r2.accountCode).toBe('401');
    expect(r2.confidence).toBe(97);
  });

  it('caps confidence and warns when the account is not in the chart', () => {
    const history = mkHist(10, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '83001', accountName: '소모품비-사무' });
    const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ history }));
    expect(r.accountCode).toBe('83001');
    expect(r.accountName).toBe('소모품비-사무');
    expect(r.confidence).toBe(CLASSIFY_PARAMS.unknownAccountCap);
    expect(r.reasons.some((x) => x.includes('계정과목표에 없는 코드'))).toBe(true);
  });

  it('uses the office chart name for the account', () => {
    const accounts: AccountCode[] = [...DEFAULT_ACCOUNT_CODES.filter((a) => a.code !== '830'), { code: '830', name: '소모품비(사무)', category: 'expense', active: true }];
    const history = mkHist(3, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830', accountName: '옛이름' });
    const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ history, accounts }));
    expect(r.accountName).toBe('소모품비(사무)');
  });
});

// ────────────────────────────── Level 3: name_history ──────────────────────────────

describe('name_history (동일 상호)', () => {
  it('uses merchantKey when no business number match (max 97)', () => {
    const history = mkHist(20, { merchantName: '동네철물점', accountCode: '830' });
    const r = classifyAccount(mkTx({ merchantName: '동네 철물점' }), ctxFor({ history }));
    expect(r.source).toBe('name_history');
    expect(r.confidence).toBe(97);
    expect(r.summary).toContain('(상호 일치)');
    expect(r.reasons).toContain('상호 일치 (사업자번호 없음)');
  });

  it('lower confidence for fewer repeats', () => {
    const one = classifyAccount(mkTx({ merchantName: '동네철물점' }), ctxFor({ history: mkHist(1, { merchantName: '동네철물점', accountCode: '830' }) }));
    const two = classifyAccount(mkTx({ merchantName: '동네철물점' }), ctxFor({ history: mkHist(2, { merchantName: '동네철물점', accountCode: '830' }) }));
    expect(one.confidence).toBe(90);
    expect(two.confidence).toBe(94);
  });

  it('exact bizno history takes precedence over name history', () => {
    const history = [
      ...mkHist(10, { merchantName: '동네철물점', accountCode: '830' }),
      ...mkHist(3, { merchantName: '동네철물점', merchantBusinessNumber: ABC_BIZNO, accountCode: '820' }),
    ];
    const r = classifyAccount(mkTx({ merchantName: '동네철물점', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ history }));
    expect(r.source).toBe('exact_history');
    expect(r.accountCode).toBe('820');
  });

  it('notes when same-name history has a different business number', () => {
    const history = mkHist(3, { merchantName: '김밥나라', merchantBusinessNumber: '1111111119', accountCode: '811' });
    const r = classifyAccount(mkTx({ merchantName: '김밥나라', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ history }));
    expect(r.source).toBe('name_history');
    expect(r.reasons.some((x) => x.includes('사업자번호 상이'))).toBe(true);
  });

  it('client history beats the system dictionary', () => {
    const history = mkHist(3, { merchantName: '(주)케이티', accountCode: '831' });
    const r = classifyAccount(mkTx({ merchantName: '(주)케이티' }), ctxFor({ history }));
    expect(r.accountCode).toBe('831');
    expect(r.source).toBe('name_history');
    expect(hasAccountConflict(r)).toBe(false);
  });
});

// ────────────────────────────── Level 4: correction_memory ──────────────────────────────

describe('correction_memory (최근 수정 우선)', () => {
  const coupangHist = () => mkHist(10, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, accountCode: '830' });
  const coupangTx = () => mkTx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO });

  it('after staff corrected 쿠팡 소모품비 → 상품, next time recommends 상품', () => {
    const corrections = [mkCorr({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, before: '830', after: '146' }, 4)];
    const r = classifyAccount(coupangTx(), ctxFor({ history: coupangHist(), corrections }));
    expect(r.accountCode).toBe('146');
    expect(r.source).toBe('correction_memory');
    expect(r.confidence).toBe(90);
    expect(r.confidence).toBeLessThan(DEFAULT_CONFIDENCE_POLICY.autoApproveMin);
    expect(r.summary).toBe('최근 수정 반영: 쿠팡 소모품비 → 상품 (1회)');
    expect(r.evidence.correctionCount).toBe(1);
    expect(r.evidence.historyCount).toBe(10);
    expect(r.reasons.some((x) => x.includes('수정 이전 이력 10건 제외'))).toBe(true);
  });

  it('repeated corrections raise confidence up to 94 (never auto-approve)', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => mkCorr({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, before: '830', after: '146' }, i));
    expect(classifyAccount(coupangTx(), ctxFor({ history: coupangHist(), corrections: mk(2) })).confidence).toBe(93);
    expect(classifyAccount(coupangTx(), ctxFor({ history: coupangHist(), corrections: mk(3) })).confidence).toBe(94);
    expect(classifyAccount(coupangTx(), ctxFor({ history: coupangHist(), corrections: mk(7) })).confidence).toBe(94);
  });

  it('works for a merchant with no finalized history yet', () => {
    const corrections = [mkCorr({ merchantName: '신규상사', before: null, after: '153' })];
    const r = classifyAccount(mkTx({ merchantName: '신규상사' }), ctxFor({ corrections }));
    expect(r.source).toBe('correction_memory');
    expect(r.accountCode).toBe('153');
    expect(r.summary).toBe('최근 수정 반영: 신규상사 → 원재료 (1회)');
  });

  it('history recorded after the correction is trusted again (repeat → exact_history)', () => {
    const corrections = [mkCorr({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, before: '830', after: '146' }, 0)]; // 2026-09-01
    const after = mkHist(3, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, accountCode: '146' }, '2026-09-15'); // 09-15, 09-08, 09-01
    const r = classifyAccount(coupangTx(), ctxFor({ history: [...coupangHist(), ...after], corrections }));
    expect(r.source).toBe('exact_history');
    expect(r.accountCode).toBe('146');
    expect(r.confidence).toBe(97);
    expect(r.evidence.historyCount).toBe(3);
    expect(r.reasons.some((x) => x.includes('수정 이전 이력 10건 제외'))).toBe(true);
  });

  it('corrected history entries alone override older uncorrected entries', () => {
    const history = [
      ...mkHist(5, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, accountCode: '830' }, '2026-06-01'),
      ...mkHist(1, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, accountCode: '146', corrected: true }, '2026-08-20'),
    ];
    const r = classifyAccount(coupangTx(), ctxFor({ history }));
    expect(r.accountCode).toBe('146');
    expect(r.confidence).toBeLessThan(95);
    expect(r.confidence).toBeGreaterThanOrEqual(90);
  });

  it('a correction that agrees with the majority does not discard history', () => {
    const corrections = [mkCorr({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, before: '831', after: '830' })];
    const r = classifyAccount(coupangTx(), ctxFor({ history: coupangHist(), corrections }));
    expect(r.source).toBe('exact_history');
    expect(r.confidence).toBe(99);
    expect(r.evidence.correctionCount).toBe(1);
  });

  it('corrections outside the window are ignored', () => {
    const corrections = [
      mkCorr({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, before: '830', after: '146', createdAt: '2025-01-05T00:00:00Z' }),
    ];
    const r = classifyAccount(coupangTx(), ctxFor({ history: coupangHist(), corrections }));
    expect(r.accountCode).toBe('830');
    expect(r.source).toBe('exact_history');
  });

  it('corrections of other clients or vat field are ignored', () => {
    const corrections = [
      mkCorr({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, after: '146', clientId: B.id }),
      mkCorr({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, after: 'non_deductible', field: 'vat' }),
    ];
    const r = classifyAccount(coupangTx(), ctxFor({ history: coupangHist(), corrections }));
    expect(r.accountCode).toBe('830');
    expect(r.evidence.correctionCount).toBe(0);
  });

  it('newer history that disagrees with an older correction wins, with the correction as a conflicting alternative', () => {
    const corrections = [mkCorr({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, before: '830', after: '146' }, 0)]; // 09-01
    const later = mkHist(4, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, accountCode: '830' }, '2026-09-14').map((e, i) => ({
      ...e,
      transactionDate: `2026-09-1${i}`,
    }));
    const r = classifyAccount(coupangTx(), ctxFor({ history: [...coupangHist(), ...later], corrections }));
    expect(r.accountCode).toBe('830');
    expect(r.source).toBe('exact_history');
    expect(r.alternatives[0]).toMatchObject({ accountCode: '146', source: 'correction_memory' });
    expect(hasAccountConflict(r)).toBe(true);
  });
});

// ────────────────────────────── Level 5: industry_pattern ──────────────────────────────

describe('industry_pattern & per-client divergence', () => {
  const peers = (clientIds: string[], industry: HistoryEntry['industry'], accountCode: string, merchantName = '쿠팡', bizno: string | null = COUPANG_BIZNO) =>
    clientIds.flatMap((cid) =>
      mkHist(2, { merchantName, merchantBusinessNumber: bizno, accountCode, clientId: cid, industry }),
    );

  it('쿠팡: construction client A → 소모품비, ecommerce client B → 상품 (own history always wins)', () => {
    const histA = mkHist(6, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, accountCode: '830' });
    const histB = mkHist(6, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, accountCode: '146', clientId: B.id, industry: 'ecommerce' });
    const all = [...histA, ...histB];
    const ctxA = ctxFor({ client: A, history: all, peerHistory: all });
    const ctxB = ctxFor({ client: B, history: all, peerHistory: all });
    const rA = classifyAccount(mkTx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO }), ctxA);
    const rB = classifyAccount(mkTx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, clientId: B.id }), ctxB);
    expect(rA.accountCode).toBe('830');
    expect(rB.accountCode).toBe('146');
    expect(rA.source).toBe('exact_history');
    expect(rB.source).toBe('exact_history');
  });

  it('peer data never overrides client-specific history, and does not raise a conflict', () => {
    const own = mkHist(1, { merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, accountCode: '830' });
    const peerHistory = peers(['p1', 'p2', 'p3', 'p4', 'p5'], 'construction', '146');
    const r = classifyAccount(mkTx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO }), ctxFor({ history: own, peerHistory }));
    expect(r.accountCode).toBe('830');
    expect(r.confidence).toBe(92);
    expect(hasAccountConflict(r)).toBe(false);
    expect(r.alternatives.find((a) => a.accountCode === '146')!.source).toBe('industry_pattern');
  });

  it('≥3 same-industry clients with ≥80% agreement → 93 and beats the dictionary', () => {
    const peerHistory = [...peers(['p1', 'p2', 'p3', 'p4'], 'ecommerce', '146'), ...peers(['p5'], 'ecommerce', '830')];
    const r = classifyAccount(
      mkTx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO, clientId: B.id }),
      ctxFor({ client: B, peerHistory }),
    );
    expect(r.source).toBe('industry_pattern');
    expect(r.accountCode).toBe('146');
    expect(r.confidence).toBe(93);
    expect(r.evidence.peerClientCount).toBe(5);
    expect(r.summary).toBe('동일 업종(전자상거래) 거래처 5곳 중 4곳이 쿠팡을(를) 상품 처리');
  });

  it('new construction client follows construction peers (소모품비), not ecommerce peers', () => {
    const peerHistory = [...peers(['p1', 'p2', 'p3'], 'construction', '830'), ...peers(['e1', 'e2', 'e3', 'e4'], 'ecommerce', '146')];
    const r = classifyAccount(mkTx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO }), ctxFor({ peerHistory }));
    expect(r.accountCode).toBe('830');
    expect(r.source).toBe('industry_pattern');
    expect(r.confidence).toBe(93);
  });

  it('weak peer evidence ranks after the dictionary', () => {
    const peerHistory = peers(['p1'], 'construction', '146');
    const r = classifyAccount(mkTx({ merchantName: '쿠팡', merchantBusinessNumber: COUPANG_BIZNO }), ctxFor({ peerHistory }));
    expect(r.source).toBe('system_rule');
    expect(r.accountCode).toBe('830');
  });

  it('weak peer evidence is used when nothing else applies', () => {
    const two = peers(['p1', 'p2'], 'construction', '820', '동네설비', null);
    const r = classifyAccount(mkTx({ merchantName: '동네설비' }), ctxFor({ peerHistory: two }));
    expect(r.source).toBe('industry_pattern');
    expect(r.confidence).toBe(CLASSIFY_PARAMS.industryTwoClients);
    const one = peers(['p1'], 'construction', '820', '동네설비', null);
    expect(classifyAccount(mkTx({ merchantName: '동네설비' }), ctxFor({ peerHistory: one })).confidence).toBe(CLASSIFY_PARAMS.industryOneClient);
  });

  it('split peers below agreement threshold get lower confidence', () => {
    const peerHistory = [...peers(['p1', 'p2'], 'construction', '820', '동네설비', null), ...peers(['p3', 'p4'], 'construction', '830', '동네설비', null)];
    const r = classifyAccount(mkTx({ merchantName: '동네설비' }), ctxFor({ peerHistory }));
    expect(r.confidence).toBeLessThan(CLASSIFY_PARAMS.industryStrongConfidence);
    expect(hasAccountConflict(r)).toBe(true);
  });

  it('cross-industry peers are a capped fallback', () => {
    const peerHistory = peers(['e1', 'e2', 'e3'], 'ecommerce', '820', '동네설비', null);
    const r = classifyAccount(mkTx({ merchantName: '동네설비' }), ctxFor({ peerHistory }));
    expect(r.source).toBe('industry_pattern');
    expect(r.confidence).toBeLessThanOrEqual(CLASSIFY_PARAMS.crossIndustryCap);
    expect(r.summary).toContain('타 업종 포함');
  });

  it('one vote per peer client (a big client cannot dominate)', () => {
    const big = mkHist(50, { merchantName: '동네설비', accountCode: '830', clientId: 'big', industry: 'construction' });
    const small = peers(['p1', 'p2', 'p3'], 'construction', '820', '동네설비', null);
    const r = classifyAccount(mkTx({ merchantName: '동네설비' }), ctxFor({ peerHistory: [...big, ...small] }));
    expect(r.accountCode).toBe('820');
  });

  it('peers with a different business number are a different merchant', () => {
    const peerHistory = peers(['p1', 'p2', 'p3'], 'construction', '820', '우리식당', '1111111119');
    const r = classifyAccount(mkTx({ merchantName: '우리식당', merchantBusinessNumber: ABC_BIZNO }), ctxFor({ peerHistory }));
    expect(r.source).toBe('system_rule'); // 식당 → 811 (사전)
  });

  it("the client's own entries in peerHistory are ignored", () => {
    const own = mkHist(3, { merchantName: '동네설비', accountCode: '820' });
    const r = classifyAccount(mkTx({ merchantName: '동네설비' }), ctxFor({ peerHistory: own }));
    expect(r.source).toBe('none');
  });
});

// ────────────────────────────── 기타 ──────────────────────────────

describe('determinism & helpers', () => {
  function shuffle<T>(arr: T[], seed: number): T[] {
    const a = [...arr];
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  it('same result regardless of input ordering', () => {
    const history = [
      ...mkHist(4, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' }),
      ...mkHist(4, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '146' }, '2026-07-30'),
      ...mkHist(3, { merchantName: '동네철물점', accountCode: '830' }),
    ];
    const peerHistory = [
      ...mkHist(2, { merchantName: '동네설비', accountCode: '820', clientId: 'p1' }),
      ...mkHist(2, { merchantName: '동네설비', accountCode: '830', clientId: 'p2' }),
    ];
    const corrections = [0, 1, 2].map((i) => mkCorr({ merchantName: '쿠팡', after: i === 2 ? '153' : '146' }, i));
    const rules = [
      mkRule({ id: 'r2', accountCode: '830', condition: { field: 'merchantKey', op: 'eq', value: '철물' } }),
      mkRule({ id: 'r1', accountCode: '146', condition: { field: 'merchantKey', op: 'eq', value: '철물' } }),
    ];
    const txs = ['ABC쇼핑', '동네철물점', '동네설비', '쿠팡', '철물', '미상'].map((n) =>
      mkTx({ merchantName: n, merchantBusinessNumber: n === 'ABC쇼핑' ? ABC_BIZNO : null }),
    );
    const base = classifyAccounts(txs, ctxFor({ history, peerHistory, corrections, rules }));
    for (const seed of [1, 7, 42]) {
      const again = classifyAccounts(
        txs,
        ctxFor({ history: shuffle(history, seed), peerHistory: shuffle(peerHistory, seed), corrections: shuffle(corrections, seed), rules: shuffle(rules, seed) }),
      );
      expect(again).toEqual(base);
    }
    // 같은 컨텍스트로 반복 호출해도 동일 (캐시 영향 없음)
    const ctx = ctxFor({ history, peerHistory, corrections, rules });
    expect(classifyAccounts(txs, ctx)).toEqual(classifyAccounts(txs, ctx));
  });

  it('confidence is always an integer in [0, 100]', () => {
    const history = mkHist(7, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' });
    for (const amount of [1, 1000, 32_000, 10_000_000, -50_000]) {
      const r = classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, totalAmount: amount }), ctxFor({ history }));
      expect(Number.isInteger(r.confidence)).toBe(true);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('params can be overridden per context (office settings)', () => {
    const history = mkHist(3, { merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO, accountCode: '830' });
    const ctx = ctxFor({
      history,
      params: { exactHistoryLadder: [{ min: 1, confidence: 80 }, { min: 3, confidence: 96 }], correctionWindowDays: undefined },
    });
    expect(classifyAccount(mkTx({ merchantName: 'ABC쇼핑', merchantBusinessNumber: ABC_BIZNO }), ctx).confidence).toBe(96);
    expect(ctx.params.correctionWindowDays).toBe(CLASSIFY_PARAMS.correctionWindowDays);
    expect(Object.isFrozen(CLASSIFY_PARAMS.exactHistoryLadder)).toBe(true);
  });

  it('transactionConditionContext exposes DSL fields', () => {
    const cc = transactionConditionContext(mkTx({ merchantName: '쿠팡', transactionDate: '2026-09-13' }), A, '830');
    expect(cc.weekday).toBe(0);
    expect(cc.dayOfMonth).toBe(13);
    expect(cc.industry).toBe('construction');
    expect(cc.accountCode).toBe('830');
  });

  it('compilePrefilter extracts required tokens conservatively', () => {
    expect(compilePrefilter({ field: 'merchantKey', op: 'contains', value: ['kt', '쿠팡'] })).toEqual([
      { field: 'merchantKey', token: 'KT' },
      { field: 'merchantKey', token: '쿠팡' },
    ]);
    expect(compilePrefilter({ field: 'totalAmount', op: 'gt', value: 1 })).toBeNull();
    expect(compilePrefilter({ not: { field: 'merchantKey', op: 'contains', value: 'a' } })).toBeNull();
    expect(compilePrefilter({ any: [{ field: 'merchantKey', op: 'contains', value: 'a' }, { field: 'totalAmount', op: 'gt', value: 1 }] })).toBeNull();
    expect(
      compilePrefilter({ all: [{ field: 'direction', op: 'eq', value: 'purchase' }, { field: 'description', op: 'eq', value: '월세' }] }),
    ).toEqual([{ field: 'description', token: '월세' }]);
    expect(compilePrefilter({ field: 'merchantKey', op: 'regex', value: '^KT' })).toBeNull();
    expect(compilePrefilter({ field: 'merchantKey', op: 'contains', value: '' })).toBeNull();
  });

  it('prefilter never changes rule results (user rules with mixed conditions)', () => {
    const rules = [
      mkRule({ id: 'amt', accountCode: '212', condition: { field: 'totalAmount', op: 'gte', value: 1_000_000 } }),
      mkRule({ id: 'case', accountCode: '826', condition: { field: 'merchantName', op: 'contains', value: 'book', ignoreCase: false } }),
    ];
    const ctx = ctxFor({ rules, useBuiltinDictionary: false });
    expect(classifyAccount(mkTx({ merchantName: '아무거나', totalAmount: 1_200_000 }), ctx).evidence.ruleId).toBe('amt');
    expect(classifyAccount(mkTx({ merchantName: 'my book store' }), ctx).evidence.ruleId).toBe('case');
    expect(classifyAccount(mkTx({ merchantName: 'MY BOOK STORE' }), ctx).source).toBe('none');
  });
});

// ────────────────────────────── 성능 ──────────────────────────────

describe('performance', () => {
  it('classifies 10,000 transactions with 2,000 history entries in < 1500ms', () => {
    const merchants = Array.from({ length: 800 }, (_, i) => `거래처${i}상사`);
    const dictNames = ['(주)케이티', '스타벅스 역삼점', 'GS칼텍스', '쿠팡', '교보문고', '할매국밥', '카카오T', '우체국', '미상가맹점'];
    const codes = ['830', '811', '822', '146', '831', '826', '812'];
    const history: HistoryEntry[] = [];
    for (let i = 0; i < 2000; i++) {
      const m = merchants[i % 400]!;
      history.push({
        clientId: A.id,
        merchantKey: normalizeMerchantName(m),
        merchantBusinessNumber: i % 3 === 0 ? String(1000000000 + (i % 400)) : null,
        accountCode: codes[(i * 7) % codes.length]!,
        accountName: '',
        transactionDate: `2026-0${1 + (i % 8)}-${String(1 + (i % 28)).padStart(2, '0')}`,
        totalAmount: 10_000 + (i % 50) * 1_000,
        corrected: i % 17 === 0,
        industry: 'construction',
      });
    }
    const peerHistory: HistoryEntry[] = [];
    for (let i = 0; i < 3000; i++) {
      peerHistory.push({
        clientId: `peer-${i % 30}`,
        merchantKey: normalizeMerchantName(merchants[(i * 3) % 800]!),
        merchantBusinessNumber: null,
        accountCode: codes[i % codes.length]!,
        accountName: '',
        transactionDate: '2026-07-01',
        totalAmount: 20_000,
        corrected: false,
        industry: i % 2 === 0 ? 'construction' : 'ecommerce',
      });
    }
    const corrections = Array.from({ length: 200 }, (_, i) => mkCorr({ merchantName: merchants[i * 2]!, after: codes[i % codes.length]! }, i));
    const rules = Array.from({ length: 30 }, (_, i) =>
      mkRule({ id: `u${i}`, accountCode: '830', condition: { field: 'merchantKey', op: 'contains', value: `특수${i}` }, priority: i }),
    );
    const txs: NormalizedTransaction[] = [];
    for (let i = 0; i < 10_000; i++) {
      const name = i % 5 === 0 ? dictNames[i % dictNames.length]! : merchants[i % 800]!;
      txs.push(
        mkTx({
          merchantName: name,
          merchantBusinessNumber: i % 3 === 0 && i % 5 !== 0 ? String(1000000000 + (i % 400)) : null,
          description: i % 11 === 0 ? '통신요금 자동이체' : '',
          totalAmount: 5_000 + (i % 300) * 1_000,
        }),
      );
    }
    const t0 = performance.now();
    const ctx = ctxFor({ history, peerHistory, corrections, rules });
    const t1 = performance.now();
    const results = classifyAccounts(txs, ctx);
    const t2 = performance.now();
    expect(results).toHaveLength(10_000);
    expect(results.filter((r) => r.source === 'none').length).toBeLessThan(10_000);
    // eslint-disable-next-line no-console
    console.info(`[perf] context ${(t1 - t0).toFixed(0)}ms, classify 10k ${(t2 - t1).toFixed(0)}ms`);
    expect(t2 - t0).toBeLessThan(1500);
  });
});
