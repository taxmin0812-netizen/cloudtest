import { describe, expect, it } from 'vitest';
import type { AccountClassification, ClientProfile, Condition, NormalizedTransaction } from '../types';
import { evaluateCondition, type ConditionContext } from '../dsl';
import { computeFingerprint } from '../fingerprint';
import { normalizeMerchantName } from '../normalize';
import { DEFAULT_VAT_RULES, type VatRuleDef } from '../data/vat-rules';
import {
  FactView,
  buildRuleFacts,
  classifyVat,
  compileCondition,
  extractHour,
  matchesClientVehicle,
  purchaseVatType,
  resolveRulesForClient,
  validateRuleCondition,
} from './vat';

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
    merchantTaxType: 'unknown',
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
    sourceRowNumber: 1,
    fingerprint: '',
    ...o,
  };
  if (o.merchantName && !o.merchantKey) t.merchantKey = normalizeMerchantName(o.merchantName);
  t.fingerprint = o.fingerprint ?? computeFingerprint(t);
  return t;
}

function mkClient(o: Partial<ClientProfile> = {}): ClientProfile {
  return {
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
  };
}

function acc(code: string | null, name: string | null = code ? `계정${code}` : null, confidence = 97): AccountClassification {
  return { accountCode: code, accountName: name, confidence, source: 'exact_history', summary: '', reasons: [], evidence: {}, alternatives: [] };
}

const ctx = (client = mkClient(), rules: readonly VatRuleDef[] = DEFAULT_VAT_RULES) => ({ client, rules });

describe('compileCondition — evaluateCondition 과 동등', () => {
  const conds: Condition[] = [
    { field: 'merchantName', op: 'contains', value: '마트' },
    { field: 'merchantName', op: 'contains', value: ['택시', '버스'] },
    { field: 'merchantName', op: 'not_contains', value: ['택시', '버스'] },
    { field: 'merchantName', op: 'eq', value: 'abc마트', ignoreCase: true },
    { field: 'merchantName', op: 'eq', value: 'abc마트', ignoreCase: false },
    { field: 'merchantName', op: 'neq', value: 'ABC마트' },
    { field: 'merchantName', op: 'starts_with', value: 'abc' },
    { field: 'merchantName', op: 'ends_with', value: '마트' },
    { field: 'merchantName', op: 'regex', value: '^ABC' },
    { field: 'merchantName', op: 'regex', value: '([' },
    { field: 'evidenceType', op: 'in', value: ['card', 'cash_receipt'] },
    { field: 'evidenceType', op: 'not_in', value: ['card'] },
    { field: 'evidenceType', op: 'in', value: 'card' as never },
    { field: 'totalAmount', op: 'gt', value: 10000 },
    { field: 'totalAmount', op: 'gte', value: '11000' },
    { field: 'totalAmount', op: 'lt', value: 11000 },
    { field: 'totalAmount', op: 'lte', value: 11000 },
    { field: 'totalAmount', op: 'between', value: [10000, 12000] },
    { field: 'totalAmount', op: 'between', value: [1] },
    { field: 'totalAmount', op: 'eq', value: '11000' },
    { field: 'weekday', op: 'in', value: [0, 6] },
    { field: 'isForeign', op: 'eq', value: true },
    { field: 'isForeign', op: 'eq', value: 'false' },
    { field: 'isForeign', op: 'neq', value: true },
    { field: 'merchantBusinessNumber', op: 'is_empty' },
    { field: 'merchantBusinessNumber', op: 'is_not_empty' },
    { field: 'description', op: 'contains', value: '' },
    { field: 'merchantCategory', op: 'eq', value: '' },
    { all: [] },
    { any: [] },
    { all: [{ field: 'merchantName', op: 'contains', value: '마트' }, { not: { field: 'totalAmount', op: 'lt', value: 5000 } }] },
    { any: [{ field: 'merchantName', op: 'contains', value: 'X' }, { field: 'currency', op: 'eq', value: 'krw' }] },
    { field: 'merchantName', op: 'unknown_op' as never, value: 'x' },
  ];
  const contexts: ConditionContext[] = [
    { merchantName: 'ABC마트', evidenceType: 'card', totalAmount: 11000, weekday: 6, isForeign: false, currency: 'KRW', description: '', merchantBusinessNumber: null },
    { merchantName: 'abc마트', evidenceType: 'cash_receipt', totalAmount: 9999, weekday: 2, isForeign: true, currency: 'USD', description: '택시비', merchantBusinessNumber: '1208147521', merchantCategory: '소매' },
    { merchantName: '서울택시', evidenceType: 'bank', totalAmount: 12000, weekday: 0 },
    { merchantName: 'ＡＢＣ마트', totalAmount: 11000 },
    {},
  ];
  it('모든 조건 × 컨텍스트에서 같은 결과', () => {
    for (const c of conds) {
      const p = compileCondition(c);
      for (const x of contexts) {
        expect(p(new FactView(x)), JSON.stringify({ c, x })).toBe(evaluateCondition(c, x));
      }
    }
  });
});

describe('기본 VAT 규칙 데이터', () => {
  it('code 가 유일하고 조건·신뢰도가 유효하다', () => {
    const codes = DEFAULT_VAT_RULES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of DEFAULT_VAT_RULES) {
      expect(validateRuleCondition(r.condition), r.code).toEqual([]);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
      expect(r.reasonText.length).toBeGreaterThan(5);
      expect(r.legalBasis).toBeTruthy();
    }
  });
  it('validateRuleCondition: 가상 필드 허용, 모르는 필드·연산자 거부', () => {
    expect(validateRuleCondition({ field: 'clientVatType', op: 'eq', value: 'exempt' })).toEqual([]);
    expect(validateRuleCondition({ field: 'nope', op: 'eq', value: 1 })[0]).toContain('알 수 없는 필드');
    expect(validateRuleCondition({ field: 'searchText', op: 'zz', value: 1 })[0]).toContain('알 수 없는 연산자');
    expect(validateRuleCondition({ all: [] })[0]).toContain('하위 조건');
  });
});

describe('classifyVat — 매입', () => {
  it('세금계산서 수취분은 기본 공제', () => {
    const v = classifyVat(mkTx({ evidenceType: 'tax_invoice', approvalNumber: '2026091541000000' }), acc('830'), ctx());
    expect(v.deductible).toBe(true);
    expect(v.vatType).toBe('purchase_taxable');
    expect(v.confidence).toBe(97);
    expect(v.nonDeductibleReasonCode).toBeNull();
    expect(v.ruleIds).toContain('VAT-DEF-TI');
    expect(v.reasons[0]).toContain('제38조');
  });

  it('접대비(813) 세금계산서 → 불공제(54), 제39조①6호', () => {
    const v = classifyVat(mkTx({ evidenceType: 'tax_invoice' }), acc('813', '접대비(기업업무추진비)'), ctx());
    expect(v.deductible).toBe(false);
    expect(v.vatType).toBe('purchase_non_deductible');
    expect(v.nonDeductibleReasonCode).toBe('VAT-ENT-01');
    expect(v.confidence).toBe(95);
    expect(v.summary).toContain('불공제');
    expect(v.reasons.join('\n')).toContain('제39조①6호');
  });

  it('접대비 카드 → 불공제, 일반전표(부가세 포함 비용)', () => {
    const v = classifyVat(mkTx({ merchantName: '한우명가', merchantTaxType: 'general' }), acc('813'), ctx());
    expect(v.deductible).toBe(false);
    expect(v.vatType).toBe('purchase_no_evidence');
    expect(v.nonDeductibleReasonCode).toBe('VAT-ENT-01');
    expect(v.reasons.join('\n')).toContain('일반전표');
    // 기본 공제 규칙도 일치했지만 우선순위가 낮아 참고로만 표시
    expect(v.ruleIds[0]).toBe('VAT-ENT-01');
    expect(v.ruleIds).toContain('VAT-DEF-CARD-GEN');
  });

  it('택시 카드 → 불공제 (시행령 제88조⑤2호), 힌트 일치 시 자동확정 구간', () => {
    const base = { merchantName: '서울개인택시', merchantCategory: '택시운송업' };
    const v = classifyVat(mkTx(base), acc('812', '여비교통비'), ctx());
    expect(v.deductible).toBe(false);
    expect(v.nonDeductibleReasonCode).toBe('VAT-CARD-03');
    expect(v.confidence).toBe(88);
    expect(v.reasons[0]).toContain('제88조⑤2호');

    const agree = classifyVat(mkTx({ ...base, sourceDeductibleHint: false }), acc('812'), ctx());
    expect(agree.deductible).toBe(false);
    expect(agree.confidence).toBe(95);

    const disagree = classifyVat(mkTx({ ...base, sourceDeductibleHint: true }), acc('812'), ctx());
    expect(disagree.deductible).toBe(false);
    expect(disagree.confidence).toBe(88);
    expect(disagree.reasons.join('\n')).toContain('홈택스)는 공제로 표시');
  });

  it('KTX·항공·미용실·영화관 카드 불공제', () => {
    const cases: Array<[string, string]> = [
      ['코레일 KTX', 'VAT-CARD-03'],
      ['대한항공', 'VAT-CARD-03'],
      ['준오헤어 강남점', 'VAT-CARD-02'],
      ['CGV 용산', 'VAT-CARD-05'],
      ['○○운전학원', 'VAT-CARD-08'],
      ['강남 유흥주점', 'VAT-CARD-11'],
    ];
    for (const [name, code] of cases) {
      const v = classifyVat(mkTx({ merchantName: name }), acc('812'), ctx());
      expect(v.deductible, name).toBe(false);
      expect(v.nonDeductibleReasonCode, name).toBe(code);
    }
  });

  it('공급자 업종 규칙은 적요가 아니라 상호·업종으로 판정', () => {
    const v = classifyVat(mkTx({ merchantName: '대성건자재', merchantTaxType: 'general', description: '미용실 인테리어 자재' }), acc('830'), ctx());
    expect(v.deductible).toBe(true);
    const w = classifyVat(mkTx({ merchantName: '뷰티랩', merchantCategory: '미용업' }), acc('830'), ctx());
    expect(w.nonDeductibleReasonCode).toBe('VAT-CARD-02');
  });

  it('전세버스는 여객운송 불공제의 예외 → 공제', () => {
    const v = classifyVat(mkTx({ merchantName: '○○관광 전세버스운송' }), acc('812'), ctx());
    expect(v.deductible).toBe(true);
    expect(v.ruleIds[0]).toBe('VAT-CARD-04');
    expect(v.ruleIds).toContain('VAT-CARD-03');
    expect(v.reasons.join('\n')).toContain('참고(우선순위 낮음, 불공제)');
  });

  it('전세버스 공제 판단 ↔ 원천 불공제 힌트 충돌 → 판단불가', () => {
    const v = classifyVat(mkTx({ merchantName: '○○전세버스', sourceDeductibleHint: false }), acc('812'), ctx());
    expect(v.deductible).toBeNull();
    expect(v.confidence).toBeLessThanOrEqual(70);
    expect(v.summary).toContain('다릅니다');
  });

  it('상대방 간이과세자 → 검토 (영수증 발급대상 여부 미상), 홈택스 공제 표시면 공제', () => {
    const v = classifyVat(mkTx({ merchantTaxType: 'simplified' }), acc('830'), ctx());
    expect(v.deductible).toBeNull();
    expect(v.vatType).toBe('purchase_card');
    expect(v.ruleIds[0]).toBe('VAT-CARD-09');

    const h = classifyVat(mkTx({ merchantTaxType: 'simplified', sourceDeductibleHint: true }), acc('830'), ctx());
    expect(h.deductible).toBe(true);
    expect(h.confidence).toBe(87);
  });

  it('간이과세자 세액 없음 → 불공제 일반전표', () => {
    const v = classifyVat(mkTx({ merchantTaxType: 'simplified', supplyAmount: 11000, vatAmount: 0 }), acc('830'), ctx());
    expect(v.deductible).toBe(false);
    expect(v.vatType).toBe('purchase_no_evidence');
    expect(v.nonDeductibleReasonCode).toBeNull();
  });

  it('카드 세액 0 → 카드면세, 현금영수증 세액 0 → 현금면세', () => {
    const c = classifyVat(mkTx({ supplyAmount: 11000, vatAmount: 0 }), acc('830'), ctx());
    expect(c.vatType).toBe('purchase_card_exempt');
    expect(c.deductible).toBe(false);
    expect(c.nonDeductibleReasonCode).toBeNull();
    expect(c.ruleIds[0]).toBe('VAT-CARD-00');
    const r = classifyVat(mkTx({ evidenceType: 'cash_receipt', supplyAmount: 11000, vatAmount: 0 }), acc('830'), ctx());
    expect(r.vatType).toBe('purchase_cash_receipt_exempt');
  });

  it('면세사업자 가맹점 → 불공제(면세)', () => {
    const v = classifyVat(mkTx({ merchantTaxType: 'exempt', supplyAmount: 11000, vatAmount: 0 }), acc('830'), ctx());
    expect(v.deductible).toBe(false);
    expect(v.vatType).toBe('purchase_card_exempt');
  });

  it('해외결제 → 불공제, 부가세 없음(purchase_no_evidence)', () => {
    const v = classifyVat(mkTx({ merchantName: 'AMAZON WEB SERVICES', isForeign: true, currency: 'USD', supplyAmount: 55000, vatAmount: 0, totalAmount: 55000 }), acc('831'), ctx());
    expect(v.deductible).toBe(false);
    expect(v.vatType).toBe('purchase_no_evidence');
    expect(v.ruleIds[0]).toBe('VAT-FOR-01');
    expect(v.nonDeductibleReasonCode).toBeNull();
    expect(v.confidence).toBe(95);
  });

  it('면세사업자 수임처 → 불공제 (제39조①7호), 세금계산서면 54', () => {
    const client = mkClient({ vatType: 'exempt', industry: 'academy' });
    const v = classifyVat(mkTx({ evidenceType: 'tax_invoice' }), acc('830'), ctx(client));
    expect(v.deductible).toBe(false);
    expect(v.vatType).toBe('purchase_non_deductible');
    expect(v.nonDeductibleReasonCode).toBe('VAT-EXM-01');
    expect(v.reasons[0]).toContain('제39조①7호');
  });

  it('겸영 수임처 → 검토', () => {
    const v = classifyVat(mkTx({ evidenceType: 'tax_invoice' }), acc('830'), ctx(mkClient({ vatType: 'mixed', industry: 'clinic' })));
    expect(v.deductible).toBeNull();
    expect(v.ruleIds[0]).toBe('VAT-EXM-02');
  });

  it('면세업종인데 일반과세로 등록 → 검토', () => {
    const v = classifyVat(mkTx({ evidenceType: 'tax_invoice' }), acc('830'), ctx(mkClient({ industry: 'academy' })));
    expect(v.deductible).toBeNull();
    expect(v.ruleIds[0]).toBe('VAT-EXM-03');
  });

  it('계산서(면세) 수취 → 면세매입', () => {
    const v = classifyVat(mkTx({ evidenceType: 'invoice_exempt', supplyAmount: 50000, vatAmount: 0, totalAmount: 50000 }), acc('153'), ctx());
    expect(v.vatType).toBe('purchase_exempt');
    expect(v.deductible).toBe(false);
    expect(v.nonDeductibleReasonCode).toBeNull();
  });

  it('통장·기타 → 적격 증빙 아님', () => {
    const v = classifyVat(mkTx({ evidenceType: 'bank', vatAmount: 0, supplyAmount: 11000 }), acc('819'), ctx());
    expect(v.vatType).toBe('purchase_no_evidence');
    expect(v.deductible).toBe(false);
  });

  it('카드 일반과세자 가맹점 → 공제 95, 원천 공제 힌트 → 97', () => {
    const v = classifyVat(mkTx({ merchantTaxType: 'general' }), acc('830'), ctx());
    expect(v.deductible).toBe(true);
    expect(v.vatType).toBe('purchase_card');
    expect(v.confidence).toBe(95);
    expect(classifyVat(mkTx({ merchantTaxType: 'general', sourceDeductibleHint: true }), acc('830'), ctx()).confidence).toBe(97);
    const unknown = classifyVat(mkTx(), acc('830'), ctx());
    expect(unknown.confidence).toBe(90);
    expect(classifyVat(mkTx({ sourceDeductibleHint: true }), acc('830'), ctx()).confidence).toBe(97);
  });

  it('원천 불공제 힌트만 있음 → 검토', () => {
    const v = classifyVat(mkTx({ evidenceType: 'tax_invoice', sourceDeductibleHint: false }), acc('830'), ctx());
    expect(v.deductible).toBeNull();
    expect(v.ruleIds[0]).toBe('VAT-HINT-01');
  });

  it('등록된 불공제 차량 → 불공제(제39조①5호), 미식별 차량 지출 → 검토', () => {
    const client = mkClient({ nonDeductibleVehicles: ['12가3456'] });
    const matched = classifyVat(mkTx({ merchantName: 'SK에너지 강남주유소', description: '12가 3456 주유' }), acc('822', '차량유지비'), ctx(client));
    expect(matched.deductible).toBe(false);
    expect(matched.nonDeductibleReasonCode).toBe('VAT-CAR-01');
    expect(matched.reasons[0]).toContain('제39조①5호');

    const byRaw = classifyVat(mkTx({ merchantName: '오일뱅크', rawData: { 비고: '차량 12가-3456' } }), acc('822'), ctx(client));
    expect(byRaw.nonDeductibleReasonCode).toBe('VAT-CAR-01');

    const unknown = classifyVat(mkTx({ merchantName: 'GS칼텍스 역삼' }), acc('822'), ctx(client));
    expect(unknown.deductible).toBeNull();
    expect(unknown.ruleIds[0]).toBe('VAT-CAR-05');
  });

  it('골프장·상품권 → 검토', () => {
    expect(classifyVat(mkTx({ merchantName: '레이크사이드 컨트리클럽' }), acc('811'), ctx()).deductible).toBeNull();
    expect(classifyVat(mkTx({ merchantName: '○○백화점', description: '상품권 구입' }), acc('811'), ctx()).deductible).toBeNull();
  });

  it('규칙이 없으면 판단불가', () => {
    const v = classifyVat(mkTx(), acc('830'), ctx(mkClient(), []));
    expect(v.deductible).toBeNull();
    expect(v.confidence).toBe(40);
    expect(v.summary).toContain('검토 필요');
  });

  it('사람 승인 규칙(vat_override) 은 규칙 결론을 뒤집되 데이터 사실 규칙은 못 뒤집는다', () => {
    const client = mkClient();
    const ov = classifyVat(mkTx({ merchantName: '현대오일뱅크' }), acc('822'), { ...ctx(client), override: { deductible: true, ruleId: 'r1', ruleName: '화물차 주유' } });
    expect(ov.deductible).toBe(true);
    expect(ov.confidence).toBe(97);
    expect(ov.ruleIds[0]).toBe('r1');

    const ent = classifyVat(mkTx(), acc('813'), { ...ctx(client), override: { deductible: true } });
    expect(ent.deductible).toBe(false);
    expect(ent.nonDeductibleReasonCode).toBe('VAT-ENT-01');
  });

  it('수임처 전용 규칙이 같은 code 공통 규칙을 덮어쓰고, 비활성 규칙은 무시', () => {
    const custom: VatRuleDef[] = [
      ...DEFAULT_VAT_RULES,
      { ...DEFAULT_VAT_RULES.find((r) => r.code === 'VAT-CAR-05')!, clientId: 'c1', active: false },
      { ...DEFAULT_VAT_RULES.find((r) => r.code === 'VAT-ENT-01')!, clientId: 'other', outcome: 'deductible' },
    ];
    const v = classifyVat(mkTx({ merchantName: 'GS칼텍스', merchantTaxType: 'general' }), acc('822'), ctx(mkClient(), custom));
    expect(v.deductible).toBe(true);
    expect(v.ruleIds).not.toContain('VAT-CAR-05');
    const e = classifyVat(mkTx(), acc('813'), ctx(mkClient(), custom));
    expect(e.deductible).toBe(false);
    expect(resolveRulesForClient(custom, 'c1').filter((r) => r.code === 'VAT-CAR-05')).toHaveLength(0);
  });

  it('DB 행 id 가 있으면 ruleIds 에 id 를 쓴다', () => {
    const rules = DEFAULT_VAT_RULES.map((r, i) => ({ ...r, id: `uuid-${i}` }));
    const v = classifyVat(mkTx({ evidenceType: 'tax_invoice' }), acc('830'), ctx(mkClient(), rules));
    expect(v.ruleIds[0]).toMatch(/^uuid-/);
  });
});

describe('classifyVat — 매출', () => {
  it('증빙별 매출 유형', () => {
    const s = (o: Partial<NormalizedTransaction>) => classifyVat(mkTx({ direction: 'sales', ...o }), acc('401'), ctx());
    expect(s({ evidenceType: 'tax_invoice' }).vatType).toBe('sales_taxable');
    expect(s({ evidenceType: 'invoice_exempt' }).vatType).toBe('sales_exempt');
    expect(s({ evidenceType: 'card' }).vatType).toBe('sales_card');
    expect(s({ evidenceType: 'cash_receipt' }).vatType).toBe('sales_cash_receipt');
    expect(s({ evidenceType: 'bank' }).vatType).toBe('sales_other');
    expect(s({ evidenceType: 'tax_invoice' }).deductible).toBe(true);
    // 매출에는 매입 규칙(접대비 등)이 적용되지 않는다
    expect(classifyVat(mkTx({ direction: 'sales' }), acc('813'), ctx()).deductible).toBe(true);
  });
});

describe('보조 함수', () => {
  it('purchaseVatType 매핑표', () => {
    const p = (o: Partial<NormalizedTransaction>, d: boolean | null) => purchaseVatType({ evidenceType: 'card', vatAmount: 1000, isForeign: false, merchantTaxType: 'unknown', ...o }, d);
    expect(p({ evidenceType: 'tax_invoice' }, true)).toBe('purchase_taxable');
    expect(p({ evidenceType: 'tax_invoice' }, false)).toBe('purchase_non_deductible');
    expect(p({ evidenceType: 'tax_invoice' }, null)).toBe('purchase_taxable');
    expect(p({ evidenceType: 'tax_invoice', vatAmount: 0 }, false)).toBe('purchase_taxable');
    expect(p({}, true)).toBe('purchase_card');
    expect(p({}, false)).toBe('purchase_no_evidence');
    expect(p({ evidenceType: 'cash_receipt' }, true)).toBe('purchase_cash_receipt');
    expect(p({ evidenceType: 'other' }, true)).toBe('purchase_no_evidence');
    expect(p({ isForeign: true }, true)).toBe('purchase_no_evidence');
  });

  it('extractHour', () => {
    expect(extractHour({ 승인시간: '23:10:05' })).toBe(23);
    expect(extractHour({ 승인일시: '2026-09-12 07:05' })).toBe(7);
    expect(extractHour({ 거래시간: '231000' })).toBe(23);
    expect(extractHour({ 거래시간: '0930' })).toBe(9);
    expect(extractHour({ 승인일자: '2026-09-12' })).toBeNull();
    expect(extractHour({})).toBeNull();
    expect(extractHour({ 승인시간: '25:00' })).toBeNull();
  });

  it('matchesClientVehicle — 공백·하이픈 무시, 4자 미만 번호 무시', () => {
    expect(matchesClientVehicle({ description: '12 가 3456', merchantName: '', rawData: {} }, ['12가3456'])).toBe(true);
    expect(matchesClientVehicle({ description: '3456', merchantName: '', rawData: {} }, ['12가3456'])).toBe(false);
    expect(matchesClientVehicle({ description: '아무거나', merchantName: '', rawData: {} }, ['가1'])).toBe(false);
  });

  it('matchesClientVehicle — 숫자만 등록된 번호는 적요·상호의 독립 숫자열일 때만 (승인번호·금액·카드번호 오탐 방지)', () => {
    const plate = ['3456'];
    expect(matchesClientVehicle({ description: '주유 3456', merchantName: '', rawData: {} }, plate)).toBe(true);
    expect(matchesClientVehicle({ description: '12가 3456', merchantName: '', rawData: {} }, plate)).toBe(true);
    expect(matchesClientVehicle({ description: '승인 71345612', merchantName: '', rawData: {} }, plate)).toBe(false);
    expect(matchesClientVehicle({ description: '', merchantName: '', rawData: { 승인번호: '71345612', 카드번호: '1234-****-****-3456', 금액: '134560' } }, plate)).toBe(false);
    // 정식 번호는 원본 행에서도 찾는다
    expect(matchesClientVehicle({ description: '', merchantName: '', rawData: { 비고: '12가-3456 주유' } }, ['12가3456'])).toBe(true);
  });

  it('숫자만 등록된 차량번호가 승인번호에 섞여도 불공제 차량으로 판정하지 않는다', () => {
    const client = mkClient({ nonDeductibleVehicles: ['3456'] });
    const v = classifyVat(mkTx({ merchantName: '알파문구', merchantTaxType: 'general', rawData: { 승인번호: '71345612' } }), acc('830'), ctx(client));
    expect(v.deductible).toBe(true);
    expect(v.ruleIds).not.toContain('VAT-CAR-01');
  });

  it('buildRuleFacts: 요일·검색텍스트·수임처 사실', () => {
    const f = buildRuleFacts(mkTx({ transactionDate: '2026-09-12', merchantCategory: '소매', description: '비품' }), acc('830'), mkClient());
    expect(f.weekday).toBe(6);
    expect(f.dayOfMonth).toBe(12);
    expect(f.searchText).toContain('소매');
    expect(f.clientVatType).toBe('general');
    expect(f.vatType).toBeNull();
  });
});

describe('classifyVat — 리뷰 보강 (자동승인 안전장치)', () => {
  it('사람 규칙이 공제로 지정해도 원천자료가 불공제면 판단불가(검토)', () => {
    const v = classifyVat(mkTx({ merchantTaxType: 'general', sourceDeductibleHint: false }), acc('830'), {
      ...ctx(),
      override: { deductible: true, ruleId: 'r1', ruleName: '문구점 소모품' },
    });
    expect(v.deductible).toBeNull();
    expect(v.confidence).toBeLessThanOrEqual(70);
    expect(v.summary).toContain('원천자료 공제여부(불공제)가 다릅니다');
    expect(v.ruleIds[0]).toBe('r1');
  });

  it('사람 규칙이 불공제로 지정 + 원천 공제 표시 → 불공제 유지 (보수적)', () => {
    const v = classifyVat(mkTx({ merchantTaxType: 'general', sourceDeductibleHint: true }), acc('830'), {
      ...ctx(),
      override: { deductible: false, reasonCode: 'U-1' },
    });
    expect(v.deductible).toBe(false);
    expect(v.nonDeductibleReasonCode).toBe('U-1');
  });

  it('간이과세자 수임처: 매입은 검토, 사람 규칙(공제)으로도 전액 공제 자동확정 안 됨', () => {
    const simp = mkClient({ vatType: 'simplified' });
    const plain = classifyVat(mkTx({ merchantTaxType: 'general' }), acc('830'), ctx(simp));
    expect(plain.deductible).toBeNull();
    expect(plain.ruleIds[0]).toBe('VAT-SIMP-01');
    expect(plain.reasons[0]).toContain('0.5%');

    const ov = classifyVat(mkTx({ merchantTaxType: 'general' }), acc('830'), { ...ctx(simp), override: { deductible: true, ruleId: 'r9' } });
    expect(ov.deductible).toBeNull();
    expect(ov.ruleIds[0]).toBe('VAT-SIMP-01');

    const ti = classifyVat(mkTx({ evidenceType: 'tax_invoice' }), acc('830'), ctx(simp));
    expect(ti.deductible).toBeNull();
  });

  it('간이과세자 수임처라도 접대비는 불공제 (같은 priority 에서 불공제 우선)', () => {
    const v = classifyVat(mkTx({ evidenceType: 'tax_invoice' }), acc('813'), ctx(mkClient({ vatType: 'simplified' })));
    expect(v.deductible).toBe(false);
    expect(v.nonDeductibleReasonCode).toBe('VAT-ENT-01');
    expect(v.vatType).toBe('purchase_non_deductible');
  });

  it('간이과세자 수임처 택시 → 검토 (공급자 업종 불공제는 참고 근거)', () => {
    const v = classifyVat(mkTx({ merchantName: '서울개인택시' }), acc('812'), ctx(mkClient({ vatType: 'simplified' })));
    expect(v.deductible).toBeNull();
    expect(v.ruleIds).toEqual(expect.arrayContaining(['VAT-SIMP-01', 'VAT-CARD-03']));
    expect(v.reasons.join('\n')).toContain('참고(우선순위 낮음, 불공제)');
  });

  it('간이과세자 수임처 세액 0 카드 → 불공제(세액 없음) 사실 규칙이 먼저', () => {
    const v = classifyVat(mkTx({ supplyAmount: 11000, vatAmount: 0 }), acc('830'), ctx(mkClient({ vatType: 'simplified' })));
    expect(v.deductible).toBe(false);
    expect(v.ruleIds[0]).toBe('VAT-CARD-00');
  });
});
