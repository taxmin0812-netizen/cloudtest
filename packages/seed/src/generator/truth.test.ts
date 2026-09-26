import { describe, expect, it } from 'vitest';
import { accountNameOf, hometaxDeductibleHint, purchaseVatTypeOf, vatTruthFor, type VatTruthInput } from './truth';

const general = { vatType: 'general' as const, nonDeductibleVehicles: ['123가4567'] };
const base: VatTruthInput = {
  direction: 'purchase',
  evidenceType: 'card',
  vatAmount: 909,
  isForeign: false,
  merchantTaxType: 'general',
  merchantKind: 'coffee',
  sourceDeductibleHint: true,
  description: '',
  accountCode: '811',
};

describe('vatTruthFor', () => {
  it('일반 카드 매입 → 카드과세매입 공제', () => {
    expect(vatTruthFor(base, general)).toEqual({ vatType: 'purchase_card', deductible: true, nonDeductibleReasonCode: null });
    expect(vatTruthFor({ ...base, evidenceType: 'tax_invoice' }, general).vatType).toBe('purchase_taxable');
    expect(vatTruthFor({ ...base, evidenceType: 'cash_receipt' }, general).vatType).toBe('purchase_cash_receipt');
  });

  it('부가세 없는 불공제는 사유 코드가 없다 (해외·계산서·세액 0)', () => {
    expect(vatTruthFor({ ...base, isForeign: true, merchantTaxType: 'unknown', vatAmount: 0 }, general)).toEqual({
      vatType: 'purchase_no_evidence', deductible: false, nonDeductibleReasonCode: null,
    });
    expect(vatTruthFor({ ...base, evidenceType: 'invoice_exempt', vatAmount: 0 }, general)).toEqual({
      vatType: 'purchase_exempt', deductible: false, nonDeductibleReasonCode: null,
    });
    expect(vatTruthFor({ ...base, vatAmount: 0, merchantTaxType: 'exempt' }, general).vatType).toBe('purchase_card_exempt');
    expect(vatTruthFor({ ...base, vatAmount: 0, merchantTaxType: 'simplified' }, general).vatType).toBe('purchase_no_evidence');
    expect(vatTruthFor({ ...base, evidenceType: 'cash_receipt', vatAmount: 0, merchantTaxType: 'exempt' }, general).vatType).toBe('purchase_cash_receipt_exempt');
  });

  it('불공제 사유 우선순위', () => {
    expect(vatTruthFor(base, { vatType: 'exempt', nonDeductibleVehicles: [] }).nonDeductibleReasonCode).toBe('VAT-EXM-01');
    expect(vatTruthFor({ ...base, accountCode: '813' }, general).nonDeductibleReasonCode).toBe('VAT-ENT-01');
    expect(vatTruthFor({ ...base, merchantKind: 'fuel', accountCode: '822', description: '차량 123가4567' }, general).nonDeductibleReasonCode).toBe('VAT-CAR-01');
    expect(vatTruthFor({ ...base, merchantKind: 'fuel', accountCode: '822', description: '차량 99다1111' }, general).deductible).toBe(true);
    expect(vatTruthFor({ ...base, accountCode: '134' }, general).nonDeductibleReasonCode).toBe('VAT-BIZ-01');
    expect(vatTruthFor({ ...base, accountCode: '338' }, general).nonDeductibleReasonCode).toBe('VAT-BIZ-01');
    expect(vatTruthFor({ ...base, merchantKind: 'taxi', accountCode: '812' }, general).nonDeductibleReasonCode).toBe('VAT-CARD-03');
    expect(vatTruthFor({ ...base, merchantTaxType: 'simplified', sourceDeductibleHint: false }, general).nonDeductibleReasonCode).toBe('VAT-CARD-09');
    expect(vatTruthFor({ ...base, merchantTaxType: 'simplified', sourceDeductibleHint: null }, general).deductible).toBe(true);
    expect(vatTruthFor({ ...base, merchantKind: 'medical_supplies', evidenceType: 'tax_invoice' }, { vatType: 'mixed', nonDeductibleVehicles: [] })).toEqual({
      vatType: 'purchase_non_deductible', deductible: false, nonDeductibleReasonCode: 'VAT-EXM-01',
    });
    // 접대비가 면세사업자보다 뒤: 면세 수임처면 EXM-01
    expect(vatTruthFor({ ...base, accountCode: '813' }, { vatType: 'exempt', nonDeductibleVehicles: [] }).nonDeductibleReasonCode).toBe('VAT-EXM-01');
  });

  it('카드 불공제는 일반전표(purchase_no_evidence), 세금계산서 불공제는 purchase_non_deductible', () => {
    expect(vatTruthFor({ ...base, accountCode: '813' }, general).vatType).toBe('purchase_no_evidence');
    expect(vatTruthFor({ ...base, evidenceType: 'tax_invoice', accountCode: '813' }, general).vatType).toBe('purchase_non_deductible');
  });

  it('매출은 증빙별 유형, 공제 true', () => {
    const s = (e: VatTruthInput['evidenceType']) => vatTruthFor({ ...base, direction: 'sales', evidenceType: e }, general);
    expect(s('tax_invoice')).toEqual({ vatType: 'sales_taxable', deductible: true, nonDeductibleReasonCode: null });
    expect(s('invoice_exempt').vatType).toBe('sales_exempt');
    expect(s('card').vatType).toBe('sales_card');
    expect(s('cash_receipt').vatType).toBe('sales_cash_receipt');
    expect(s('bank').vatType).toBe('sales_other');
  });

  it('purchaseVatTypeOf 경계', () => {
    expect(purchaseVatTypeOf({ evidenceType: 'tax_invoice', vatAmount: 0, isForeign: false, merchantTaxType: 'general' }, false)).toBe('purchase_taxable');
    expect(purchaseVatTypeOf({ evidenceType: 'bank', vatAmount: 0, isForeign: false, merchantTaxType: 'general' }, true)).toBe('purchase_no_evidence');
  });
});

describe('hometaxDeductibleHint / accountNameOf', () => {
  it('가맹점 기준 공제여부', () => {
    expect(hometaxDeductibleHint({ kind: 'coffee', taxType: 'general', foreign: false }, 909)).toBe(true);
    expect(hometaxDeductibleHint({ kind: 'coffee', taxType: 'exempt', foreign: false }, 0)).toBe(false);
    expect(hometaxDeductibleHint({ kind: 'taxi', taxType: 'general', foreign: false }, 1000)).toBe(false);
    expect(hometaxDeductibleHint({ kind: 'restaurant_meal', taxType: 'simplified', foreign: false }, 2000)).toBeNull();
    expect(hometaxDeductibleHint({ kind: 'saas_foreign', taxType: 'general', foreign: true }, 0)).toBeNull();
    expect(hometaxDeductibleHint(null, 100)).toBe(true);
  });

  it('계정명', () => {
    expect(accountNameOf('813')).toBe('접대비(기업업무추진비)');
    expect(() => accountNameOf('999')).toThrow();
  });
});
