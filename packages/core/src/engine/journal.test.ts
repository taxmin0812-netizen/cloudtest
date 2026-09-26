import { describe, expect, it } from 'vitest';
import type { NormalizedTransaction } from '../types';
import { normalizeMerchantName } from '../normalize';
import { buildJournalEntry, buildSalesJournalWithDefault, validateBalanced } from './journal';

function mkTx(o: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  const merchantName = o.merchantName ?? 'ABC마트';
  return {
    clientId: 'c1',
    businessNumber: '1234567890',
    source: 'business_card',
    channel: 'manual_upload',
    direction: 'purchase',
    transactionDate: '2026-09-12',
    evidenceType: 'card',
    merchantName,
    merchantKey: normalizeMerchantName(merchantName),
    merchantBusinessNumber: '1208147521',
    merchantCategory: null,
    merchantTaxType: 'general',
    description: '사무용품',
    supplyAmount: 29545,
    vatAmount: 2955,
    serviceCharge: 0,
    totalAmount: 32500,
    cardNumberMasked: null,
    approvalNumber: null,
    originalSourceId: null,
    currency: 'KRW',
    isForeign: false,
    sourceDeductibleHint: null,
    rawData: {},
    sourceRowNumber: 1,
    fingerprint: 'fp1',
    ...o,
  };
}

const simple = (lines: Array<{ side: string; accountCode: string; amount: number }>) => lines.map((l) => [l.side, l.accountCode, l.amount]);

describe('buildJournalEntry — 매입', () => {
  it('공제 카드: 차) 비용(공급가) + 135 부가세대급금 / 대) 253 미지급금(합계)', () => {
    const e = buildJournalEntry(mkTx(), { accountCode: '830', accountName: '소모품비', deductible: true }, { transactionId: 'tx-1' });
    expect(e.transactionId).toBe('tx-1');
    expect(e.date).toBe('2026-09-12');
    expect(simple(e.lines)).toEqual([
      ['debit', '830', 29545],
      ['debit', '135', 2955],
      ['credit', '253', 32500],
    ]);
    expect(e.lines[0]!.counterpartyName).toBe('ABC마트');
    expect(e.lines[0]!.counterpartyBusinessNumber).toBe('1208147521');
    expect(validateBalanced(e)).toEqual({ balanced: true, debit: 32500, credit: 32500, diff: 0, invalidLines: [] });
  });

  it('불공제(접대비 세금계산서): 세액을 비용에 합산, 대) 251 외상매입금', () => {
    const tx = mkTx({ evidenceType: 'tax_invoice', supplyAmount: 100000, vatAmount: 10000, totalAmount: 110000 });
    const e = buildJournalEntry(tx, { accountCode: '813', accountName: '접대비(기업업무추진비)', deductible: false, vatType: 'purchase_non_deductible' });
    expect(simple(e.lines)).toEqual([
      ['debit', '813', 110000],
      ['credit', '251', 110000],
    ]);
    expect(e.lines[0]!.memo).toContain('불공제 세액 포함');
    expect(validateBalanced(e).balanced).toBe(true);
    expect(e.transactionId).toBe('fp1');
  });

  it('현금영수증: 기본 101 현금, 옵션으로 253 미지급금', () => {
    const tx = mkTx({ evidenceType: 'cash_receipt' });
    expect(buildJournalEntry(tx, { accountCode: '830', accountName: '소모품비', deductible: true }).lines.at(-1)!.accountCode).toBe('101');
    expect(buildJournalEntry(tx, { accountCode: '830', accountName: '소모품비', deductible: true }, { cashReceiptCredit: 'payable' }).lines.at(-1)!.accountCode).toBe('253');
  });

  it('통장·기타 증빙 상대계정, 사용자 지정 상대계정', () => {
    const bank = buildJournalEntry(mkTx({ evidenceType: 'bank', vatAmount: 0, supplyAmount: 32500 }), { accountCode: '819', accountName: '지급임차료', deductible: false });
    expect(simple(bank.lines)).toEqual([
      ['debit', '819', 32500],
      ['credit', '103', 32500],
    ]);
    const custom = buildJournalEntry(mkTx(), { accountCode: '830', accountName: '소모품비', deductible: true }, { payableAccounts: { card: { code: '262', name: '미지급비용' } } });
    expect(custom.lines.at(-1)!.accountCode).toBe('262');
  });

  it('봉사료: 공제분이면 비용에 합산, 부가세는 따로', () => {
    const tx = mkTx({ supplyAmount: 100000, vatAmount: 10000, serviceCharge: 10000, totalAmount: 120000 });
    const e = buildJournalEntry(tx, { accountCode: '811', accountName: '복리후생비', deductible: true });
    expect(simple(e.lines)).toEqual([
      ['debit', '811', 110000],
      ['debit', '135', 10000],
      ['credit', '253', 120000],
    ]);
    const n = buildJournalEntry(tx, { accountCode: '813', accountName: '접대비', deductible: false });
    expect(simple(n.lines)).toEqual([
      ['debit', '813', 120000],
      ['credit', '253', 120000],
    ]);
    expect(validateBalanced(e).balanced && validateBalanced(n).balanced).toBe(true);
  });

  it('세액 0 이면 부가세대급금 줄을 만들지 않는다', () => {
    const e = buildJournalEntry(mkTx({ vatAmount: 0, supplyAmount: 32500 }), { accountCode: '830', accountName: '소모품비', deductible: false });
    expect(e.lines).toHaveLength(2);
  });

  it('공제여부 미확정은 공제 기준 잠정 분개 + 메모', () => {
    const e = buildJournalEntry(mkTx(), { accountCode: '830', accountName: '소모품비', deductible: null });
    expect(e.lines[1]!.accountCode).toBe('135');
    expect(e.lines[1]!.memo).toContain('공제여부 검토 필요');
  });

  it('취소(음수) 거래도 차대 균형', () => {
    const e = buildJournalEntry(mkTx({ supplyAmount: -29545, vatAmount: -2955, totalAmount: -32500 }), { accountCode: '830', accountName: '소모품비', deductible: true });
    expect(validateBalanced(e)).toMatchObject({ balanced: true, debit: -32500, credit: -32500 });
  });

  it('합계 ≠ 구성요소면 억지로 맞추지 않고 차이를 드러낸다', () => {
    const e = buildJournalEntry(mkTx({ totalAmount: 32501 }), { accountCode: '830', accountName: '소모품비', deductible: true });
    expect(validateBalanced(e)).toMatchObject({ balanced: false, diff: -1 });
  });

  it('계정 미지정이면 한국어 오류', () => {
    expect(() => buildJournalEntry(mkTx(), { accountCode: null, accountName: null, deductible: true })).toThrow('계정과목이 지정되지 않아');
  });
});

describe('buildJournalEntry — 매출', () => {
  it('세금계산서 매출: 차) 108 / 대) 401 + 255', () => {
    const tx = mkTx({ direction: 'sales', evidenceType: 'tax_invoice', supplyAmount: 1000000, vatAmount: 100000, totalAmount: 1100000 });
    const e = buildJournalEntry(tx, { accountCode: '404', accountName: '제품매출', deductible: true });
    expect(simple(e.lines)).toEqual([
      ['debit', '108', 1100000],
      ['credit', '404', 1000000],
      ['credit', '255', 100000],
    ]);
    expect(validateBalanced(e).balanced).toBe(true);
  });

  it('현금영수증 매출 101, 봉사료 별도 계정 옵션, 기본 매출계정', () => {
    const tx = mkTx({ direction: 'sales', evidenceType: 'cash_receipt', supplyAmount: 100000, vatAmount: 10000, serviceCharge: 5000, totalAmount: 115000 });
    const e = buildJournalEntry(tx, { accountCode: '401', accountName: '상품매출', deductible: true }, { salesServiceChargeAccount: { code: '254', name: '예수금' } });
    expect(simple(e.lines)).toEqual([
      ['debit', '101', 115000],
      ['credit', '401', 100000],
      ['credit', '254', 5000],
      ['credit', '255', 10000],
    ]);
    const d = buildSalesJournalWithDefault(tx, { accountCode: null, accountName: null, deductible: true });
    expect(d.lines[1]!.accountCode).toBe('401');
    expect(validateBalanced(d).balanced).toBe(true);
  });
});

describe('validateBalanced', () => {
  it('정수가 아닌 금액은 불균형', () => {
    const r = validateBalanced({ lines: [
      { side: 'debit', accountCode: '830', accountName: 'x', amount: 100.5 },
      { side: 'credit', accountCode: '253', accountName: 'y', amount: 100.5 },
    ] });
    expect(r.balanced).toBe(false);
    expect(r.invalidLines).toEqual([0, 1]);
  });
});
