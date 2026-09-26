import { describe, expect, it } from 'vitest';
import type {
  AccountClassification,
  ClientProfile,
  HistoryEntry,
  NormalizedTransaction,
  RiskFlag,
  VatClassification,
} from '../types';
import { computeFingerprint } from '../fingerprint';
import { normalizeMerchantName } from '../normalize';
import { DEFAULT_CONFIDENCE_POLICY } from '../policy';
import { DEFAULT_REVIEW_RULES, type ReviewRuleDef } from '../data/review-rules';
import { DEFAULT_VAT_RULES } from '../data/vat-rules';
import {
  bindParams,
  buildClientHistoryIndex,
  evaluateRisks,
  fillTemplate,
  prepareRiskBatch,
  resolveRuleParams,
  validateReviewRule,
  type RiskContext,
} from './risk';
import { classifyVat } from './vat';
import { decide } from './decide';

function mkTx(o: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  const merchantName = o.merchantName ?? '테스트상점';
  const t: NormalizedTransaction = {
    clientId: 'c1',
    businessNumber: '1234567890',
    source: 'business_card',
    channel: 'manual_upload',
    direction: 'purchase',
    transactionDate: '2026-09-15', // 화요일
    evidenceType: 'card',
    merchantName,
    merchantKey: normalizeMerchantName(merchantName),
    merchantBusinessNumber: null,
    merchantCategory: null,
    merchantTaxType: 'general',
    description: '',
    supplyAmount: 10000,
    vatAmount: 1000,
    serviceCharge: 0,
    totalAmount: 11000,
    cardNumberMasked: '1234-****-****-5678',
    approvalNumber: null,
    originalSourceId: null,
    currency: 'KRW',
    isForeign: false,
    sourceDeductibleHint: null,
    rawData: {},
    sourceRowNumber: null,
    fingerprint: '',
    ...o,
  };
  t.fingerprint = computeFingerprint(t);
  return t;
}

/** 합계로 공급가액/세액을 맞춘 거래 */
function amt(total: number, o: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  const supply = Math.round(total / 1.1);
  return mkTx({ supplyAmount: supply, vatAmount: total - supply, totalAmount: total, ...o });
}

const client = (o: Partial<ClientProfile> = {}): ClientProfile => ({
  id: 'c1',
  name: '테스트상사',
  businessNumber: '1234567890',
  businessType: 'corporation',
  vatType: 'general',
  industry: 'service',
  industryCode: null,
  deemedInputTaxEligible: false,
  nonDeductibleVehicles: [],
  ...o,
});

function acc(code: string | null, name: string | null = code ? `계정${code}` : null, o: Partial<AccountClassification> = {}): AccountClassification {
  return { accountCode: code, accountName: name, confidence: 99, source: 'exact_history', summary: '', reasons: [], evidence: { historyCount: 12 }, alternatives: [], ...o };
}

const vatOk: VatClassification = { vatType: 'purchase_card', deductible: true, nonDeductibleReasonCode: null, confidence: 97, summary: '공제', reasons: [], ruleIds: [] };

function ctxOf(batch: NormalizedTransaction[], o: Partial<RiskContext> = {}): RiskContext {
  return { client: client(), rules: DEFAULT_REVIEW_RULES, batch, clientHistoryIndex: buildClientHistoryIndex([]), ...o };
}

/** 단건 평가 (그 거래만 들어 있는 배치). 신규거래처 규칙을 피하려면 이력을 준다 */
function risksOf(tx: NormalizedTransaction, account = acc('830'), vat: VatClassification | null = vatOk, o: Partial<RiskContext> = {}): RiskFlag[] {
  const history = o.clientHistoryIndex ?? buildClientHistoryIndex([hist(tx.merchantKey, account.accountCode ?? '830')]);
  const flags = evaluateRisks(tx, account, vat, prepareRiskBatch(ctxOf([tx], { clientHistoryIndex: history, ...o })));
  for (const f of flags) expect(f.message, `${f.ruleCode} 치환 누락`).not.toMatch(/\{\w+\}/);
  return flags;
}
const codes = (fs: RiskFlag[]) => fs.map((f) => f.ruleCode).sort();

function hist(merchantKey: string, accountCode: string, o: Partial<HistoryEntry> = {}): HistoryEntry {
  return { clientId: 'c1', merchantKey, merchantBusinessNumber: null, accountCode, accountName: `계정${accountCode}`, transactionDate: '2026-06-10', totalAmount: 5000, corrected: false, industry: 'service', ...o };
}

describe('기본 위험 규칙 데이터', () => {
  it('모든 기본 규칙이 검증을 통과하고 code 가 유일하다', () => {
    const cs = DEFAULT_REVIEW_RULES.map((r) => r.code);
    expect(new Set(cs).size).toBe(cs.length);
    for (const r of DEFAULT_REVIEW_RULES) expect(validateReviewRule(r), r.code).toEqual([]);
  });
  it('검증: 빠진 파라미터·잘못된 kind', () => {
    const bad: ReviewRuleDef = { ...DEFAULT_REVIEW_RULES.find((r) => r.code === 'RISK-HIGH-AMOUNT')!, params: {} };
    expect(validateReviewRule(bad).join()).toContain('params.threshold');
    const bad2: ReviewRuleDef = { ...DEFAULT_REVIEW_RULES.find((r) => r.code === 'RISK-ENT-KW')!, params: {} };
    expect(validateReviewRule(bad2).join()).toContain("파라미터 'keywords'");
    expect(validateReviewRule({ ...bad2, kind: 'zz' as never }).join()).toContain('알 수 없는 규칙 종류');
  });
  it('수임처 rule_params 덮어쓰기 (숫자·배열·불리언 변환)', () => {
    const r = DEFAULT_REVIEW_RULES.find((x) => x.code === 'RISK-ENT-KW')!;
    const p = resolveRuleParams(r, { 'RISK-ENT-KW.keywords': '골프, 요트', 'OTHER.threshold': 1 });
    expect(p.keywords).toEqual(['골프', '요트']);
    const h = resolveRuleParams({ code: 'X', params: { threshold: 1, flag: false } }, { 'X.threshold': '3000000', 'X.flag': 'true' });
    expect(h).toEqual({ threshold: 3000000, flag: true });
  });
  it('bindParams: $이름 치환', () => {
    const c = bindParams({ all: [{ field: 'totalAmount', op: 'gt', value: '$threshold' }, { field: 'merchantName', op: 'contains', value: '$kw' }] }, { threshold: 5, kw: ['a', 'b'] });
    expect(c).toEqual({ all: [{ field: 'totalAmount', op: 'gt', value: 5 }, { field: 'merchantName', op: 'contains', value: ['a', 'b'] }] });
  });
  it('fillTemplate: 없는 값은 그대로 둔다', () => {
    expect(fillTemplate('{a} {b}', { a: 1 })).toBe('1 {b}');
  });
});

describe('evaluateRisks — 규칙별', () => {
  it('정상 거래는 플래그 없음', () => {
    expect(risksOf(mkTx({ merchantName: '알파문구' }))).toEqual([]);
  });

  it('접대 키워드 (골프·주점·상품권) → entertainment/high/차단', () => {
    for (const name of ['○○컨트리클럽', '강남 이자카야 주점', '신세계 상품권']) {
      const f = risksOf(mkTx({ merchantName: name }), acc('811')).find((x) => x.ruleCode === 'RISK-ENT-KW');
      expect(f, name).toBeDefined();
      expect(f!.bucket).toBe('entertainment');
      expect(f!.severity).toBe('high');
      expect(f!.blocksAutoApproval).toBe(true);
    }
  });

  it('접대비 적격증빙 없음: 3만원 초과만, 경조금은 20만원 초과', () => {
    const bank = (total: number, description = '') => amt(total, { evidenceType: 'bank', vatAmount: 0, supplyAmount: total, description });
    expect(codes(risksOf(bank(50000), acc('813')))).toContain('RISK-ENT-EVD');
    expect(codes(risksOf(bank(30000), acc('813')))).not.toContain('RISK-ENT-EVD');
    expect(codes(risksOf(bank(150000, '거래처 축의금'), acc('813')))).not.toContain('RISK-ENT-EVD');
    expect(codes(risksOf(bank(150000, '거래처 축의금'), acc('813')))).not.toContain('RISK-ENT-EVD-COND');
    const f = risksOf(bank(250000, '거래처 축의금'), acc('813')).find((x) => x.ruleCode === 'RISK-ENT-EVD-COND');
    expect(f?.message).toContain('200,000원');
    expect(codes(risksOf(amt(50000), acc('813')))).not.toContain('RISK-ENT-EVD'); // 카드는 적격증빙
  });

  it('차량 관련 → vehicle, 비차단', () => {
    const f = risksOf(mkTx({ merchantName: 'GS칼텍스 역삼주유소' }), acc('822')).find((x) => x.ruleCode === 'RISK-VEHICLE');
    expect(f?.bucket).toBe('vehicle');
    expect(f?.blocksAutoApproval).toBe(false);
  });

  it('고액거래: 기준 이상, 수임처별 기준 덮어쓰기', () => {
    const f = risksOf(amt(1000000)).find((x) => x.ruleCode === 'RISK-HIGH-AMOUNT');
    expect(f?.bucket).toBe('high_amount');
    expect(f?.message).toContain('1,000,000원');
    expect(codes(risksOf(amt(999999)))).not.toContain('RISK-HIGH-AMOUNT');
    expect(codes(risksOf(amt(1500000), acc('830'), vatOk, { ruleParams: { 'RISK-HIGH-AMOUNT.threshold': 3000000 } }))).not.toContain('RISK-HIGH-AMOUNT');
    expect(codes(risksOf(amt(1500000, { direction: 'sales' }), acc('401')))).not.toContain('RISK-HIGH-AMOUNT');
  });

  it('자산 가능성: 비용 계정 즉시상각 기준 초과, 품목 키워드, 수선비 600만원', () => {
    expect(codes(risksOf(amt(1320000), acc('830')))).toContain('RISK-ASSET-EXPENSE');
    expect(codes(risksOf(amt(1100000), acc('830')))).not.toContain('RISK-ASSET-EXPENSE'); // 공급가 1,000,000 은 초과 아님
    const kw = risksOf(amt(1500000, { merchantName: '하이마트', description: '노트북' }), acc('830'));
    expect(kw.find((x) => x.ruleCode === 'RISK-ASSET-KW')?.bucket).toBe('possible_asset');
    expect(codes(risksOf(amt(1500000, { description: '노트북' }), acc('212')))).not.toContain('RISK-ASSET-KW');
    expect(codes(risksOf(amt(6600000), acc('820')))).toContain('RISK-ASSET-REPAIR');
  });

  it('개인사용: 주말·심야 생활업종', () => {
    const sat = risksOf(mkTx({ merchantName: '롯데백화점', transactionDate: '2026-09-12' }), acc('811'));
    expect(sat.find((x) => x.ruleCode === 'RISK-PERSONAL')?.message).toContain('토요일');
    expect(codes(risksOf(mkTx({ merchantName: '롯데백화점' }), acc('811')))).not.toContain('RISK-PERSONAL');
    const night = risksOf(mkTx({ merchantName: '온누리약국', rawData: { 승인시간: '23:40:00' } }), acc('811'));
    expect(night.find((x) => x.ruleCode === 'RISK-PERSONAL')?.message).toContain('23시');
    expect(codes(risksOf(mkTx({ merchantName: '온누리약국', rawData: { 승인시간: '14:00' } }), acc('811')))).not.toContain('RISK-PERSONAL');
  });

  it('주말 마트: 음식점 수임처는 제외', () => {
    const tx = mkTx({ merchantName: '이마트 성수점', transactionDate: '2026-09-13' });
    expect(codes(risksOf(tx, acc('811')))).toContain('RISK-PERSONAL-MART');
    expect(codes(risksOf(tx, acc('811'), vatOk, { client: client({ industry: 'restaurant' }) }))).not.toContain('RISK-PERSONAL-MART');
  });

  it('사업무관(가지급금) → personal_use/high', () => {
    const f = risksOf(mkTx(), acc('134', '가지급금')).find((x) => x.ruleCode === 'RISK-NON-BUSINESS');
    expect(f?.bucket).toBe('personal_use');
    expect(f?.severity).toBe('high');
  });

  it('불공(54) 전표 → 사람 확인', () => {
    const tx = mkTx({ evidenceType: 'tax_invoice' });
    const vat = classifyVat(tx, acc('813'), { client: client(), rules: DEFAULT_VAT_RULES });
    const f = risksOf(tx, acc('813'), vat).find((x) => x.ruleCode === 'RISK-VAT-54');
    expect(f?.bucket).toBe('vat_review');
    expect(f?.message).toContain('제39조①6호');
  });

  it('불공제 가능성: 공제로 판단됐지만 차량 계정', () => {
    expect(codes(risksOf(mkTx({ merchantName: '현대오일뱅크' }), acc('822'), vatOk))).toContain('RISK-NON-DEDUCTIBLE-POSSIBLE');
    expect(codes(risksOf(mkTx({ merchantName: '현대오일뱅크' }), acc('822'), { ...vatOk, deductible: false }))).not.toContain('RISK-NON-DEDUCTIBLE-POSSIBLE');
  });

  it('면세사업 관련 매입을 공제로 처리 → 경고', () => {
    const f = risksOf(mkTx(), acc('830'), vatOk, { client: client({ industry: 'clinic', vatType: 'mixed' }) });
    expect(codes(f)).toContain('RISK-EXEMPT-BIZ');
    expect(codes(risksOf(mkTx(), acc('830'), { ...vatOk, deductible: false }, { client: client({ vatType: 'exempt' }) }))).not.toContain('RISK-EXEMPT-BIZ');
  });

  it('토지 관련', () => {
    expect(codes(risksOf(mkTx({ description: '공장부지 형질변경 설계' }), acc('831')))).toContain('RISK-LAND');
    expect(codes(risksOf(mkTx(), acc('201', '토지')))).toContain('RISK-LAND');
  });

  it('해외결제 → foreign', () => {
    const f = risksOf(mkTx({ isForeign: true, currency: 'USD', merchantName: 'GOOGLE ADS' }), acc('833')).find((x) => x.ruleCode === 'RISK-FOREIGN');
    expect(f?.bucket).toBe('foreign');
    expect(f?.message).toContain('USD');
  });

  it('신규 거래처 고액: 이력 없음 + 30만원 이상', () => {
    const empty = buildClientHistoryIndex([]);
    const tx = amt(300000, { merchantName: '처음보는상사' });
    expect(codes(risksOf(tx, acc('830'), vatOk, { clientHistoryIndex: empty }))).toContain('RISK-NEW-MERCHANT');
    expect(codes(risksOf(amt(299999, { merchantName: '처음보는상사' }), acc('830'), vatOk, { clientHistoryIndex: empty }))).not.toContain('RISK-NEW-MERCHANT');
    expect(codes(risksOf(tx, acc('830'), vatOk, { clientHistoryIndex: buildClientHistoryIndex([hist(tx.merchantKey, '830')]) }))).not.toContain('RISK-NEW-MERCHANT');
    // 사업자번호로도 조회
    const withBiz = amt(500000, { merchantName: '표기다른상호', merchantBusinessNumber: '1208147521' });
    const idx = buildClientHistoryIndex([hist('옛상호', '830', { merchantBusinessNumber: '1208147521' })]);
    expect(codes(risksOf(withBiz, acc('830'), vatOk, { clientHistoryIndex: idx }))).not.toContain('RISK-NEW-MERCHANT');
  });

  it('같은 날 같은 가맹점 N회 이상', () => {
    const batch = [1, 2, 3].map((i) => mkTx({ merchantName: '김밥천국', approvalNumber: `A${i}`, totalAmount: 11000 + i, supplyAmount: 10000 + i }));
    const ctx = prepareRiskBatch(ctxOf(batch, { clientHistoryIndex: buildClientHistoryIndex([hist(batch[0]!.merchantKey, '811')]) }));
    for (const t of batch) {
      const f = evaluateRisks(t, acc('811'), vatOk, ctx).find((x) => x.ruleCode === 'RISK-REPEAT-SAMEDAY');
      expect(f?.message).toContain('3건');
    }
    const two = prepareRiskBatch(ctxOf(batch.slice(0, 2)));
    expect(codes(evaluateRisks(batch[0]!, acc('811'), vatOk, two))).not.toContain('RISK-REPEAT-SAMEDAY');
  });

  it('같은 날·상대방·금액 중복 의심: 배치 안, 기존 이력', () => {
    const a = mkTx({ merchantName: 'ABC마트', approvalNumber: '111' });
    const b = mkTx({ merchantName: 'ABC마트', approvalNumber: '222' });
    const ctx = prepareRiskBatch(ctxOf([a, b]));
    const f = evaluateRisks(a, acc('830'), vatOk, ctx).find((x) => x.ruleCode === 'RISK-DUP-AMOUNT');
    expect(f?.bucket).toBe('duplicate');
    expect(f?.message).toContain('2건');
    expect(f?.message).toContain('이번 자료 2건');

    const idx = buildClientHistoryIndex([hist(a.merchantKey, '830', { transactionDate: a.transactionDate, totalAmount: a.totalAmount })]);
    const g = risksOf(a, acc('830'), vatOk, { clientHistoryIndex: idx }).find((x) => x.ruleCode === 'RISK-DUP-AMOUNT');
    expect(g?.message).toContain('기존 등록 1건');
    expect(codes(risksOf(a))).not.toContain('RISK-DUP-AMOUNT');
  });

  it('배치에 없는 거래를 평가해도 배치 안 동일 건과 비교', () => {
    const a = mkTx({ merchantName: 'ABC마트', approvalNumber: '111' });
    const b = mkTx({ merchantName: 'ABC마트', approvalNumber: '222' });
    expect(codes(evaluateRisks(b, acc('830'), vatOk, prepareRiskBatch(ctxOf([a]))))).toContain('RISK-DUP-AMOUNT');
  });

  it('과거와 다른 계정 (지배 계정과 다름), 사람 지정은 제외', () => {
    const tx = mkTx({ merchantName: '스타벅스 역삼점' });
    const idx = buildClientHistoryIndex([
      hist(tx.merchantKey, '811', { accountName: '복리후생비', transactionDate: '2026-06-01' }),
      hist(tx.merchantKey, '811', { accountName: '복리후생비', transactionDate: '2026-07-01' }),
      hist(tx.merchantKey, '811', { accountName: '복리후생비', transactionDate: '2026-08-01' }),
      hist(tx.merchantKey, '813', { transactionDate: '2026-08-05' }),
    ]);
    const f = risksOf(tx, acc('830', '소모품비'), vatOk, { clientHistoryIndex: idx }).find((x) => x.ruleCode === 'RISK-CHANGED');
    expect(f?.message).toBe('스타벅스 역삼점은(는) 과거 4건 중 3건을 복리후생비(811)로 처리했는데 이번에는 소모품비(830)입니다.');
    expect(codes(risksOf(tx, acc('811'), vatOk, { clientHistoryIndex: idx }))).not.toContain('RISK-CHANGED');
    expect(codes(risksOf(tx, acc('830', '소모품비', { source: 'manual' }), vatOk, { clientHistoryIndex: idx }))).not.toContain('RISK-CHANGED');
  });

  it('계정 월합계 급증: 최근 3개월 평균 대비 2배 이상', () => {
    const batch = [amt(1500000, { approvalNumber: '1' }), amt(1000000, { approvalNumber: '2', merchantName: '다른상점' })];
    const totals = { '830': [{ period: '2026-06', total: 1000000 }, { period: '2026-07', total: 1000000 }, { period: '2026-08', total: 1000000 }] };
    const ctx = prepareRiskBatch(ctxOf(batch, { accountMonthlyTotals: totals, batchAccountCodes: ['830', '830'] }));
    const f = evaluateRisks(batch[0]!, acc('830', '소모품비'), vatOk, ctx).find((x) => x.ruleCode === 'RISK-SPIKE');
    expect(f?.message).toBe('소모품비 이번 달 합계 2,500,000원이(가) 최근 3개월 평균 1,000,000원의 2.5배입니다.');
    expect(f?.blocksAutoApproval).toBe(false);
    // 1.5배는 급증 아님
    const ctx2 = prepareRiskBatch(ctxOf(batch.slice(0, 1), { accountMonthlyTotals: totals, batchAccountCodes: ['830'] }));
    expect(codes(evaluateRisks(batch[0]!, acc('830'), vatOk, ctx2))).not.toContain('RISK-SPIKE');
    // 기준 이력이 없으면 판단하지 않음
    const ctx3 = prepareRiskBatch(ctxOf(batch, { batchAccountCodes: ['830', '830'] }));
    expect(codes(evaluateRisks(batch[0]!, acc('830'), vatOk, ctx3))).not.toContain('RISK-SPIKE');
  });

  it('금액 구성 불일치 → high', () => {
    const f = risksOf(mkTx({ supplyAmount: 10000, vatAmount: 1000, totalAmount: 11001 })).find((x) => x.ruleCode === 'RISK-UNBALANCED');
    expect(f?.severity).toBe('high');
    expect(f?.message).toContain('1원 차이');
    expect(codes(risksOf(mkTx({ supplyAmount: 10000, vatAmount: 1000, serviceCharge: 500, totalAmount: 11500 })))).not.toContain('RISK-UNBALANCED');
  });

  it('비활성·타 수임처 규칙은 평가하지 않는다', () => {
    const rules = DEFAULT_REVIEW_RULES.map((r) => (r.code === 'RISK-FOREIGN' ? { ...r, active: false } : r.code === 'RISK-HIGH-AMOUNT' ? { ...r, clientId: 'other' } : r));
    const f = risksOf(amt(2000000, { isForeign: true }), acc('830'), vatOk, { rules });
    expect(codes(f)).not.toContain('RISK-FOREIGN');
    expect(codes(f)).not.toContain('RISK-HIGH-AMOUNT');
  });

  it('준비 안 된 컨텍스트도 평가 가능 (첫 호출에 준비·캐시)', () => {
    const tx = amt(2000000);
    const ctx = ctxOf([tx], { clientHistoryIndex: buildClientHistoryIndex([hist(tx.merchantKey, '830')]) });
    expect(codes(evaluateRisks(tx, acc('830'), vatOk, ctx))).toContain('RISK-HIGH-AMOUNT');
    expect(codes(evaluateRisks(tx, acc('830'), vatOk, ctx))).toContain('RISK-HIGH-AMOUNT');
  });
});

describe('고위험 거래는 신뢰도와 무관하게 자동승인 금지', () => {
  it('신뢰도 99/97 이어도 차단 플래그가 있으면 needs_review', () => {
    for (const tx of [amt(5000000), mkTx({ merchantName: '○○컨트리클럽' }), mkTx({ isForeign: true, currency: 'USD' })]) {
      const risks = risksOf(tx, acc('830'), vatOk);
      expect(risks.some((r) => r.blocksAutoApproval)).toBe(true);
      const d = decide(tx, acc('830'), vatOk, risks, DEFAULT_CONFIDENCE_POLICY);
      expect(d.status).toBe('needs_review');
      expect(d.reviewLevel).not.toBe('auto');
    }
  });
});

describe('성능', () => {
  it('1만 건 위험 평가 < 1500ms (배치 준비 포함)', () => {
    const merchants = ['GS25 역삼점', '이마트 성수점', '서울개인택시', 'SK에너지 주유소', '롯데백화점', '스타벅스', '알파문구', '하이마트', '김밥천국', '쿠팡'];
    const batch: NormalizedTransaction[] = [];
    for (let i = 0; i < 10000; i++) {
      const total = 1000 + ((i * 7919) % 2000000);
      const supply = Math.round(total / 1.1);
      batch.push(
        mkTx({
          merchantName: merchants[i % merchants.length]!,
          merchantKey: normalizeMerchantName(merchants[i % merchants.length]!),
          transactionDate: `2026-09-${String((i % 30) + 1).padStart(2, '0')}`,
          approvalNumber: String(100000 + i),
          supplyAmount: supply,
          vatAmount: total - supply,
          totalAmount: total,
          rawData: { 승인시간: `${String(i % 24).padStart(2, '0')}:10:00` },
        }),
      );
    }
    const history: HistoryEntry[] = [];
    for (let i = 0; i < 5000; i++) history.push(hist(normalizeMerchantName(merchants[i % merchants.length]!), i % 3 ? '811' : '830', { transactionDate: `2026-0${6 + (i % 3)}-10` }));
    const accounts = batch.map((_, i) => acc(i % 2 ? '811' : '830'));
    const start = performance.now();
    const ctx = prepareRiskBatch({
      client: client(),
      rules: DEFAULT_REVIEW_RULES,
      batch,
      clientHistoryIndex: buildClientHistoryIndex(history),
      accountMonthlyTotals: { '811': [{ period: '2026-08', total: 5000000 }], '830': [{ period: '2026-07', total: 100 }] },
      batchAccountCodes: accounts.map((a) => a.accountCode),
    });
    let flagged = 0;
    for (let i = 0; i < batch.length; i++) flagged += evaluateRisks(batch[i]!, accounts[i]!, vatOk, ctx).length > 0 ? 1 : 0;
    const ms = performance.now() - start;
    expect(flagged).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1500);
  });
});

describe('리뷰 보강 — 파라미터·배치 경계', () => {
  const high = DEFAULT_REVIEW_RULES.find((r) => r.code === 'RISK-HIGH-AMOUNT')!;

  it('rule_params 숫자: 쉼표·₩·원 허용, 빈 값은 0원이 아니라 기본값 유지 + 검증 오류', () => {
    expect(resolveRuleParams(high, { 'RISK-HIGH-AMOUNT.threshold': '3,000,000' }).threshold).toBe(3000000);
    expect(resolveRuleParams(high, { 'RISK-HIGH-AMOUNT.threshold': '₩500,000원' }).threshold).toBe(500000);
    expect(resolveRuleParams(high, { 'RISK-HIGH-AMOUNT.threshold': '' }).threshold).toBe(1000000);
    expect(resolveRuleParams(high, { 'RISK-HIGH-AMOUNT.threshold': '백만' }).threshold).toBe(1000000);
    expect(validateReviewRule(high, { 'RISK-HIGH-AMOUNT.threshold': '' })).toEqual([
      "rule_params.RISK-HIGH-AMOUNT.threshold: 숫자로 해석할 수 없는 값 '' — 기본값을 사용합니다",
    ]);
    expect(validateReviewRule(high, { 'RISK-HIGH-AMOUNT.threshold': '2,000,000' })).toEqual([]);
    // 빈 값 덮어쓰기로 모든 매입이 고액거래가 되지 않는다
    expect(codes(risksOf(amt(11000), acc('830'), vatOk, { ruleParams: { 'RISK-HIGH-AMOUNT.threshold': '' } }))).not.toContain('RISK-HIGH-AMOUNT');
  });

  it('배치를 복제한 객체로 평가할 때 inBatch 로 자기 자신을 빼고 센다', () => {
    const a = mkTx({ merchantName: 'ABC마트', approvalNumber: '111' });
    const b = mkTx({ merchantName: '다른상점', approvalNumber: '222' });
    const ctx = prepareRiskBatch(ctxOf([a, b], { clientHistoryIndex: buildClientHistoryIndex([hist(a.merchantKey, '830'), hist(b.merchantKey, '830')]) }));
    const clone = { ...a };
    // 동일성으로는 배치 밖 거래로 보여 자기 자신과 중복 판정됨 → 옵션으로 바로잡는다
    expect(codes(evaluateRisks(clone, acc('830'), vatOk, ctx))).toContain('RISK-DUP-AMOUNT');
    expect(codes(evaluateRisks(clone, acc('830'), vatOk, ctx, { inBatch: true }))).not.toContain('RISK-DUP-AMOUNT');
  });

  it('계정 배열 길이가 배치와 다르면 이번 달 배치 합계를 쓰지 않는다 (어긋난 합계 방지)', () => {
    const batch = [amt(1500000, { approvalNumber: '1' }), amt(1000000, { approvalNumber: '2', merchantName: '다른상점' })];
    const totals = { '830': [{ period: '2026-06', total: 1000000 }, { period: '2026-07', total: 1000000 }, { period: '2026-08', total: 1000000 }, { period: '2026-09', total: 500000 }] };
    const bad = prepareRiskBatch(ctxOf(batch, { accountMonthlyTotals: totals, batchAccountCodes: ['830'] }));
    expect(bad.prepared.hasBatchAccounts).toBe(false);
    expect(bad.prepared.batchAccountTotals.size).toBe(0);
    // 저장된 이번 달 50만원만으로는 급증 아님 (배치 150만원이 잘못 더해지면 2배가 된다)
    expect(codes(evaluateRisks(batch[0]!, acc('830'), vatOk, bad))).not.toContain('RISK-SPIKE');
  });

  it('상호·사업자번호가 없는 거래끼리는 같은 가맹점 반복으로 묶지 않는다', () => {
    const batch = [1, 2, 3].map((i) => mkTx({ merchantName: '', merchantKey: '', approvalNumber: `N${i}`, totalAmount: 11000 + i, supplyAmount: 10000 + i }));
    const ctx = prepareRiskBatch(ctxOf(batch));
    expect(codes(evaluateRisks(batch[0]!, acc('830'), vatOk, ctx))).not.toContain('RISK-REPEAT-SAMEDAY');
  });

  it('카드·현금영수증 매출의 같은 날 같은 금액 반복은 중복·반복 의심이 아니다, 매출 세금계산서는 중복 의심', () => {
    const sale = (i: number, evidenceType: NormalizedTransaction['evidenceType'] = 'card') =>
      mkTx({ direction: 'sales', evidenceType, merchantName: '', merchantKey: '', approvalNumber: `S${i}`, supplyAmount: 4091, vatAmount: 409, totalAmount: 4500 });
    const sales = [1, 2, 3, 4].map((i) => sale(i));
    const ctx = prepareRiskBatch(ctxOf(sales));
    const c = codes(evaluateRisks(sales[0]!, acc('401'), vatOk, ctx));
    expect(c).not.toContain('RISK-DUP-AMOUNT');
    expect(c).not.toContain('RISK-REPEAT-SAMEDAY');

    const inv = [1, 2].map((i) => mkTx({ direction: 'sales', evidenceType: 'tax_invoice', merchantName: '거래처A', approvalNumber: `T${i}` }));
    const ctx2 = prepareRiskBatch(ctxOf(inv));
    expect(codes(evaluateRisks(inv[0]!, acc('401'), vatOk, ctx2))).toContain('RISK-DUP-AMOUNT');
  });

  it('안내 문구: 파라미터·거래 변수·요일/시각 치환이 정확하다', () => {
    const t = amt(1200000, { merchantName: '하이마트 강남점', transactionDate: '2026-09-13', rawData: { 승인시간: '23:40:00' } });
    const fs = risksOf(t, acc('830', '소모품비'));
    expect(fs.find((x) => x.ruleCode === 'RISK-HIGH-AMOUNT')!.message).toBe('하이마트 강남점 1,200,000원: 고액거래 기준(1,000,000원) 이상입니다.');
    expect(fs.find((x) => x.ruleCode === 'RISK-ASSET-EXPENSE')!.message).toBe(
      '소모품비 1,200,000원: 공급가액이 즉시상각 기준(1,000,000원)을 넘습니다. 비품·기계장치 등 자산 계상 여부를 확인하세요.',
    );
    const p = risksOf(amt(50000, { merchantName: '올리브영', transactionDate: '2026-09-13', rawData: { 승인시간: '23:40:00' } })).find((x) => x.ruleCode === 'RISK-PERSONAL');
    expect(p!.message).toBe('올리브영 50,000원 (일요일 23시): 주말·심야 생활업종 결제로 개인사용 가능성이 있습니다.');
  });
});
