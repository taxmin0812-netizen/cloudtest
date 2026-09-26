import { isValidBusinessNumber, type NormalizedTransaction } from '@mintax/core';
import { describe, expect, it } from 'vitest';
import {
  CLIENT,
  cardPurchaseRows,
  cardSalesRows,
  cashReceiptRows,
  CUSTOMER_A,
  exemptInvoiceRows,
  genericRows,
  makeBizNo,
  taxInvoiceRows,
  toCsvBuffer,
  toXlsxBuffer,
  VENDOR_A,
  VENDOR_B,
  wehagoLedgerRows,
} from '../__fixtures__/builders';
import { AdapterError } from '../errors';
import { readTabularFile } from '../file/read';
import { confirmColumnMapping, detectFormat } from '../format/detect';
import { GENERIC_V1, HOMETAX_CARD_PURCHASE_V1, WEHAGO_LEDGER_PURCHASE_SALES_V1 } from '../format/profiles';
import { isBlankRow } from '../util/text';
import { deductibleHintOf, normalizeRows, parseAccountCell, taxTypeOf, toWehagoLedgerRows, type NormalizeContext, type NormalizeResult } from './normalize-rows';

const ctx: NormalizeContext = { clientId: CLIENT.id, businessNumber: CLIENT.businessNumber, channel: 'hometax_file' };

function dataRowCount(rows: unknown[][], headerRowIndex: number): number {
  return rows.slice(headerRowIndex + 1).filter((r) => !isBlankRow(r)).length;
}

function expectExactAccounting(res: NormalizeResult, rows: unknown[][]): void {
  const dataRows = dataRowCount(rows, res.headerRowIndex);
  expect(res.stats.dataRows).toBe(dataRows);
  expect(res.transactions.length + res.failures.length + res.mergedRows.length).toBe(dataRows);
  // 행 번호는 겹치지 않고 모두 설명된다
  const nums = [...res.transactions.map((t) => t.sourceRowNumber!), ...res.failures.map((f) => f.sourceRowNumber), ...res.mergedRows.map((m) => m.sourceRowNumber)];
  expect(new Set(nums).size).toBe(dataRows);
}

function byRow(res: NormalizeResult, n: number): NormalizedTransaction {
  const t = res.transactions.find((x) => x.sourceRowNumber === n);
  if (!t) throw new Error(`row ${n} not a transaction`);
  return t;
}

describe('사업용 신용카드 정규화', () => {
  const rows = cardPurchaseRows();
  const res = normalizeRows(detectFormat(rows), rows, ctx);

  it('모든 데이터 행이 거래 또는 실패 하나로 설명된다 (tx + failures === dataRows)', () => {
    expect(res.mergedRows).toEqual([]);
    expect(res.transactions.length + res.failures.length).toBe(dataRowCount(rows, 1));
    expectExactAccounting(res, rows);
    expect(res.transactions).toHaveLength(8);
    expect(res.failures.map((f) => [f.sourceRowNumber, f.code])).toEqual([
      [7, 'amount_mismatch'],
      [8, 'invalid_date'],
      [9, 'invalid_amount'],
      [12, 'non_data_row'],
    ]);
  });

  it('기본 필드 매핑', () => {
    const t = byRow(res, 1);
    expect(t).toMatchObject({
      clientId: CLIENT.id,
      businessNumber: CLIENT.businessNumber,
      source: 'business_card',
      channel: 'hometax_file',
      direction: 'purchase',
      evidenceType: 'card',
      transactionDate: '2026-09-01',
      merchantName: VENDOR_B.name,
      merchantBusinessNumber: VENDOR_B.bizno,
      merchantCategory: '음식 / 커피전문점',
      merchantTaxType: 'general',
      supplyAmount: 9091,
      vatAmount: 909,
      serviceCharge: 0,
      totalAmount: 10000,
      currency: 'KRW',
      isForeign: false,
      sourceDeductibleHint: true,
      approvalNumber: null,
      sourceRowNumber: 1,
    });
    expect(t.merchantKey).toBe('스타벅스커피강남점');
    expect(t.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(t.rawData.__row).toBe(3);
  });

  it('비과세는 serviceCharge 로, 검산식 공급가액+세액+비과세=합계', () => {
    const t = byRow(res, 2);
    expect([t.supplyAmount, t.vatAmount, t.serviceCharge, t.totalAmount]).toEqual([20000, 2000, 1000, 23000]);
  });

  it('간이과세자·불공제 힌트', () => {
    const t = byRow(res, 3);
    expect(t.merchantTaxType).toBe('simplified');
    expect(t.sourceDeductibleHint).toBe(false);
  });

  it('취소(음수) 거래는 음수 유지 + 적요 "취소"', () => {
    const t = byRow(res, 4);
    expect(t.totalAmount).toBe(-10000);
    expect(t.supplyAmount).toBe(-9091);
    expect(t.description.startsWith('취소')).toBe(true);
    expect(res.stats.cancelledRows).toBe(1);
  });

  it('승인번호 없는 동일 결제 2건은 순번 원천ID로 구분 + 중복 의심 경고', () => {
    const a = byRow(res, 5);
    const b = byRow(res, 6);
    expect(a.originalSourceId).toMatch(/#1$/);
    expect(b.originalSourceId).toMatch(/#2$/);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(res.warnings.some((w) => w.code === 'possible_duplicate' && w.sourceRowNumber === 6)).toBe(true);
  });

  it('카드번호는 마스킹되고 rawData 어디에도 전체 번호가 남지 않는다', () => {
    const t = byRow(res, 1);
    expect(t.cardNumberMasked).toBe('4111-****-****-1111');
    expect(t.rawData['카드번호']).toBe('4111-****-****-1111');
    const all = JSON.stringify([res.transactions, res.failures]);
    expect(all).not.toContain('4111-1111-1111-1111');
    expect(all).not.toContain('4111111111111111');
    expect(all).not.toContain('5555-5555-5555-4444');
    // 비고 자유 텍스트 안의 카드번호도 마스킹
    expect(byRow(res, 10).rawData['비고']).toBe('선택불공제 카드 4111-****-****-1111 참고');
  });

  it('합계만 있는 행은 10% 포함가로 역산하고 __derived 에 기록', () => {
    const t = byRow(res, 11);
    expect([t.supplyAmount, t.vatAmount, t.totalAmount]).toEqual([8000, 800, 8800]);
    expect(t.merchantBusinessNumber).toBeNull();
    const d = t.rawData.__derived as Array<{ method: string; fields: string[] }>;
    expect(d[0]!.method).toBe('vat_inclusive_10pct');
    expect(d[0]!.fields).toEqual(['supplyAmount', 'vatAmount']);
    expect(res.stats.derivedRows).toBe(1);
  });

  it('실패 사유는 한국어, 필드 표시, 파싱 가능한 금액 보존', () => {
    const mismatch = res.failures.find((f) => f.code === 'amount_mismatch')!;
    expect(mismatch.reason).toContain('차이 100원');
    expect(mismatch.field).toBe('totalAmount');
    expect(mismatch.amounts).toEqual({ supplyAmount: 1000, vatAmount: 100, totalAmount: 1200 });
    const badDate = res.failures.find((f) => f.code === 'invalid_date')!;
    expect(badDate.reason).toContain('2026-13-45');
    expect(badDate.field).toBe('transactionDate');
    const badAmt = res.failures.find((f) => f.code === 'invalid_amount')!;
    expect(badAmt.reason).toContain('"abc"');
    expect(badAmt.field).toBe('supplyAmount');
    const sum = res.failures.find((f) => f.code === 'non_data_row')!;
    expect(sum.amounts).toBeNull();
  });

  it('원본 합계(sourceTotals)와 파일 합계행 비교', () => {
    const txTotal = res.transactions.reduce((s, t) => s + t.totalAmount, 0);
    const failTotal = res.failures.reduce((s, f) => s + (f.amounts?.totalAmount ?? 0), 0);
    expect(res.sourceTotals.totalAmount).toBe(txTotal + failTotal);
    expect(res.sourceTotals.count).toBe(8 + 3);
    expect(res.declaredTotals).toMatchObject({ supplyAmount: 94692, vatAmount: 9108, totalAmount: 110200 });
    expect(res.warnings.some((w) => w.code === 'declared_total_mismatch')).toBe(true);
  });

  it('같은 파일이 다른 채널로 들어와도 fingerprint 가 같다', () => {
    const again = normalizeRows(detectFormat(rows), rows, { ...ctx, channel: 'desktop_bridge' });
    expect(again.transactions.map((t) => t.fingerprint)).toEqual(res.transactions.map((t) => t.fingerprint));
    expect(again.transactions[0]!.channel).toBe('desktop_bridge');
  });
});

describe('CP949 CSV → 읽기 → 판정 → 정규화 (문자열 금액)', () => {
  it('xlsx 결과와 동일한 금액·지문', async () => {
    const rows = cardPurchaseRows();
    const csv = await readTabularFile(toCsvBuffer(rows, 'cp949'), '카드사용내역.csv');
    expect(csv.encoding).toBe('cp949');
    const fromCsv = normalizeRows(detectFormat(csv.sheets[0]!.rows), csv.sheets[0]!.rows, ctx);
    const xlsx = await readTabularFile(await toXlsxBuffer([{ name: '카드', rows }]), '카드.xlsx');
    const fromXlsx = normalizeRows(detectFormat(xlsx.sheets[0]!.rows), xlsx.sheets[0]!.rows, ctx);
    const pick = (r: NormalizeResult) => r.transactions.map((t) => [t.transactionDate, t.merchantName, t.supplyAmount, t.vatAmount, t.totalAmount, t.fingerprint]);
    expect(pick(fromCsv)).toEqual(pick(fromXlsx));
    expect(fromCsv.sourceTotals).toEqual(fromXlsx.sourceTotals);
    expect(fromCsv.transactions[0]!.merchantName).toBe('스타벅스커피 강남점');
  });
});

describe('전자세금계산서 정규화', () => {
  const rows = taxInvoiceRows();
  const res = normalizeRows(detectFormat(rows), rows, ctx);

  it('행 회계: 거래 5 + 품목병합 2 + 실패 2 = 데이터행 9', () => {
    expectExactAccounting(res, rows);
    expect(res.transactions).toHaveLength(5);
    expect(res.mergedRows.map((m) => [m.sourceRowNumber, m.intoSourceRowNumber])).toEqual([
      [5, 4],
      [6, 4],
    ]);
    expect(res.failures.map((f) => f.code).sort()).toEqual(['amount_mismatch', 'client_mismatch']);
  });

  it('수임처 사업자번호 위치로 매입/매출 판정, 상대방은 반대편', () => {
    const p = byRow(res, 1);
    expect(p.direction).toBe('purchase');
    expect(p.merchantName).toBe(VENDOR_A.name);
    expect(p.merchantBusinessNumber).toBe(VENDOR_A.bizno);
    expect(p.approvalNumber).toBe('20260910-41000012-00000001');
    expect(p.transactionDate).toBe('2026-09-10');
    expect(p.description).toBe('A4 용지');
    expect(p.evidenceType).toBe('tax_invoice');
    const s = byRow(res, 2);
    expect(s.direction).toBe('sales');
    expect(s.merchantName).toBe(CUSTOMER_A.name);
  });

  it('음수 세금계산서는 음수 + 취소 적요', () => {
    const t = byRow(res, 3);
    expect(t.totalAmount).toBe(-22000);
    expect(t.description).toBe('취소 · 반품');
  });

  it('같은 승인번호 품목 행은 하나로 묶고 rawData.__items 에 보존', () => {
    const t = byRow(res, 4);
    expect(t.totalAmount).toBe(33000);
    const items = t.rawData.__items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.itemName)).toEqual(['토너', '드럼', '케이블']);
    expect(res.warnings.some((w) => w.code === 'item_sum_mismatch')).toBe(false);
  });

  it('개인(주민번호) 공급받는자: 사업자번호 null, rawData 마스킹', () => {
    const t = byRow(res, 8);
    expect(t.direction).toBe('sales');
    expect(t.merchantBusinessNumber).toBeNull();
    expect(t.rawData['공급받는자사업자등록번호']).toBe('900101-1******');
    expect(JSON.stringify(res)).not.toContain('1234567');
    // 24자리 승인번호는 카드번호로 오인해 마스킹하지 않는다
    expect(t.rawData['승인번호']).toBe('20260915-41000012-00000006');
  });

  it('다른 수임처 자료는 실패', () => {
    const f = res.failures.find((x) => x.code === 'client_mismatch')!;
    expect(f.reason).toContain('수임처');
    expect(f.amounts).toEqual({ supplyAmount: 1000, vatAmount: 100, totalAmount: 1100 });
  });

  it('중복 헤더는 rawData 키에 (2) 접미사', () => {
    const t = byRow(res, 1);
    expect(t.rawData['상호']).toBe(VENDOR_A.name);
    expect(t.rawData['상호(2)']).toBe(CLIENT.name);
  });

  it('동일 승인번호인데 금액이 다르면 해당 행 모두 실패', () => {
    const r = taxInvoiceRows().slice(0, 6);
    const base = taxInvoiceRows()[6]!;
    const variant = [...base];
    variant[15] = 90000;
    variant[16] = 9000;
    variant[14] = 99000;
    r.push(base, variant);
    const out = normalizeRows(detectFormat(r), r, ctx);
    expect(out.transactions).toHaveLength(0);
    expect(out.failures.map((f) => f.code)).toEqual(['invoice_group_conflict', 'invoice_group_conflict']);
    expectExactAccounting(out, r);
  });

  it('수임처 사업자번호 없으면 INVALID_CONTEXT', () => {
    expect(() => normalizeRows(detectFormat(rows), rows, { ...ctx, businessNumber: '' })).toThrowError(AdapterError);
  });
});

describe('전자계산서(면세)', () => {
  it('세액 0, 합계≠공급가액이면 실패', () => {
    const rows = exemptInvoiceRows();
    const res = normalizeRows(detectFormat(rows), rows, ctx);
    expectExactAccounting(res, rows);
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]).toMatchObject({ evidenceType: 'invoice_exempt', supplyAmount: 300000, vatAmount: 0, totalAmount: 300000, direction: 'purchase' });
    expect(res.failures[0]!.code).toBe('amount_mismatch');
  });
});

describe('현금영수증 매입', () => {
  const rows = cashReceiptRows();
  const res = normalizeRows(detectFormat(rows), rows, ctx);

  it('회계·기본값', () => {
    expectExactAccounting(res, rows);
    expect(res.transactions).toHaveLength(4);
    const t = byRow(res, 1);
    expect(t).toMatchObject({ evidenceType: 'cash_receipt', source: 'cash_receipt', transactionDate: '2026-09-01', approvalNumber: 'C0000001', merchantCategory: '분식' });
  });

  it('거래구분 "취소거래" + 양수 금액 → 음수로 바꾸고 기록', () => {
    const t = byRow(res, 2);
    expect(t.totalAmount).toBe(-10000);
    expect(t.vatAmount).toBe(-909);
    expect(t.description).toBe('취소');
    expect((t.rawData.__derived as Array<{ method: string }>)[0]!.method).toBe('cancel_negated');
  });

  it('매입금액만 있으면 역산', () => {
    const t = byRow(res, 3);
    expect([t.supplyAmount, t.vatAmount, t.totalAmount]).toEqual([30000, 3000, 33000]);
  });

  it('봉사료 포함 검산 + 불공제 힌트', () => {
    const t = byRow(res, 4);
    expect([t.supplyAmount, t.vatAmount, t.serviceCharge, t.totalAmount]).toEqual([18182, 1818, 2000, 22000]);
    expect(t.sourceDeductibleHint).toBe(false);
  });
});

describe('카드매출', () => {
  it('합계만 있으면 과세 역산, 취소는 음수', () => {
    const rows = cardSalesRows();
    const res = normalizeRows(detectFormat(rows), rows, ctx);
    expectExactAccounting(res, rows);
    expect(res.transactions.map((t) => [t.direction, t.merchantName, t.supplyAmount, t.vatAmount, t.totalAmount])).toEqual([
      ['sales', '국민카드', 10000, 1000, 11000],
      ['sales', '삼성카드', 50000, 5000, 55000],
      ['sales', '국민카드', -10000, -1000, -11000],
    ]);
    expect(res.transactions[0]!.cardNumberMasked).toBe('9410-****-****-3456');
  });

  it('면세사업자 수임처면 합계=공급가액', () => {
    const rows = cardSalesRows();
    const res = normalizeRows(detectFormat(rows), rows, { ...ctx, clientVatType: 'exempt' });
    expect(res.transactions[0]).toMatchObject({ supplyAmount: 11000, vatAmount: 0 });
    expect((res.transactions[0]!.rawData.__derived as Array<{ method: string }>)[0]!.method).toBe('exempt_total_as_supply');
  });
});

describe('WEHAGO 매입매출장 역수입', () => {
  const rows = wehagoLedgerRows();

  it('유형코드로 방향·증빙 결정, 약칭만 있고 구분이 없으면 실패', () => {
    const res = normalizeRows(detectFormat(rows), rows, { ...ctx, channel: 'manual_upload' });
    expectExactAccounting(res, rows);
    expect(res.transactions.map((t) => [t.direction, t.evidenceType, t.source])).toEqual([
      ['purchase', 'card', 'wehago'],
      ['purchase', 'tax_invoice', 'wehago'],
      ['sales', 'tax_invoice', 'wehago'],
    ]);
    expect(res.failures[0]!.code).toBe('vat_type_unknown');
    expect(res.failures[0]!.reason).toContain('카과');
    expect(res.transactions[0]!.originalSourceId).toBe('wehago|M1');
    const led = toWehagoLedgerRows(res.transactions);
    expect(led[0]).toEqual({ date: '2026-09-01', merchantName: VENDOR_B.name, supplyAmount: 9091, vatAmount: 909, totalAmount: 10000, accountCode: '811' });
    expect(led[2]!.accountCode).toBe('401');
  });

  it('매입/매출을 지정하면 약칭도 해석', () => {
    const res = normalizeRows(WEHAGO_LEDGER_PURCHASE_SALES_V1, rows, { ...ctx, direction: 'purchase' });
    expect(res.transactions).toHaveLength(4);
    expect((res.transactions[3]!.rawData.__ledger as { vatTypeCode: string }).vatTypeCode).toBe('57');
  });
});

describe('generic (사용자 열 매핑)', () => {
  const rows = genericRows();

  it('사용자 확인 전에는 적재 거부', () => {
    const d = detectFormat(rows);
    expect(() => normalizeRows(d, rows, { ...ctx, direction: 'purchase' })).toThrowError(/열 확인이 필요/);
    expect(() => normalizeRows(GENERIC_V1, rows, { ...ctx, direction: 'purchase' })).toThrowError(AdapterError);
  });

  it('방향 미지정이면 거부, 매핑 확인 후 적재', () => {
    const d = confirmColumnMapping(GENERIC_V1, rows, 0, { transactionDate: 0, merchantName: 1, totalAmount: 2, description: 3 });
    expect(() => normalizeRows(d, rows, ctx)).toThrowError(/매입\/매출/);
    const res = normalizeRows(d, rows, { ...ctx, direction: 'purchase', evidenceType: 'other', channel: 'manual_upload' });
    expectExactAccounting(res, rows);
    expect(res.transactions[0]).toMatchObject({ source: 'manual', evidenceType: 'other', supplyAmount: 20000, vatAmount: 2000, description: '공구' });
  });

  it('ctx.columnMap 직접 지정', () => {
    const res = normalizeRows(GENERIC_V1, rows, {
      ...ctx,
      direction: 'purchase',
      headerRowIndex: 0,
      columnMap: { transactionDate: 0, merchantName: 1, totalAmount: 2 },
    });
    expect(res.transactions).toHaveLength(2);
  });
});

describe('해외결제 / 통화', () => {
  const header = ['승인일자', '카드번호', '가맹점사업자번호', '가맹점명', '합계', '통화', '현지금액', '공제여부결정'];
  it('원화 환산 금액이면 isForeign, 소수 금액이면 실패', () => {
    const rows = [
      header,
      ['2026-09-01', '4111-1111-1111-1111', '', 'NETFLIX.COM', 17000, 'USD', '12.99', '공제'],
      ['2026-09-02', '4111-1111-1111-1111', '', 'GITHUB', '10.50', 'USD', '10.50', '공제'],
      ['2026-09-03', '4111-1111-1111-1111', '', '국내가맹점', 1100, 'KRW', '', '공제'],
    ];
    const res = normalizeRows(detectFormat(rows), rows, ctx);
    expectExactAccounting(res, rows);
    expect(res.transactions[0]).toMatchObject({ isForeign: true, currency: 'USD', totalAmount: 17000 });
    expect(res.transactions[1]).toMatchObject({ isForeign: false, currency: 'KRW' });
    expect(res.failures[0]!.code).toBe('foreign_amount_not_won');
    expect(res.stats.foreignRows).toBe(1);
  });
});

describe('기타 규칙', () => {
  it('부호가 섞이면 실패, 공급가액만 있고 세액·합계 없으면 실패', () => {
    const rows = [
      ['승인일자', '가맹점사업자번호', '가맹점명', '공급가액', '세액', '합계', '공제여부결정'],
      ['2026-09-01', '', '가게', 1000, -100, 900, '공제'],
      ['2026-09-02', '', '가게', 1000, '', '', '공제'],
      ['2026-09-03', '', '', 1000, 100, 1100, '공제'],
      ['2026-09-04', '', '가게', '', '', '', '공제'],
    ];
    const res = normalizeRows(detectFormat(rows), rows, ctx);
    expect(res.failures.map((f) => f.code)).toEqual(['sign_mismatch', 'missing_amount', 'missing_counterparty', 'missing_amount']);
    expectExactAccounting(res, rows);
  });

  it('반복된 제목 행·안내 문구·빈 행', () => {
    const rows = [
      ['승인일자', '가맹점사업자번호', '가맹점명', '합계', '공제여부결정'],
      ['2026-09-01', '', '가게', 1100, '공제'],
      [],
      ['승인일자', '가맹점사업자번호', '가맹점명', '합계', '공제여부결정'],
      ['※ 이 자료는 참고용입니다'],
      ['소계', '', '', 1100, ''],
    ];
    const res = normalizeRows(detectFormat(rows), rows, ctx);
    expect(res.stats.blankRows).toBe(1);
    expect(res.stats.nonDataRows).toBe(3);
    expect(res.transactions).toHaveLength(1);
    expectExactAccounting(res, rows);
    expect(res.warnings.some((w) => w.code === 'declared_total_mismatch')).toBe(false);
  });

  it('사업자번호 검증번호 오류는 경고', () => {
    const valid = makeBizNo('123456789');
    const invalid = valid.slice(0, 9) + String((Number(valid[9]) + 1) % 10);
    const rows = [
      ['승인일자', '가맹점사업자번호', '가맹점명', '합계', '공제여부결정'],
      ['2026-09-01', invalid, '가게', 1100, '공제'],
    ];
    expect(isValidBusinessNumber(invalid)).toBe(false);
    const res = normalizeRows(detectFormat(rows), rows, ctx);
    expect(res.warnings.map((w) => w.code)).toContain('business_number_checksum');
  });

  it('자유 텍스트 안 띄어쓴 카드번호·주민번호, 숫자형 카드번호 셀도 마스킹', () => {
    const rows = [
      ['승인일자', '가맹점사업자번호', '가맹점명', '합계', '공제여부결정', '비고', '회원번호'],
      ['2026-09-01', '', '가게', 1100, '공제', '카드 4111 1111 1111 1111 / 900101 1234567 본인', 5555555555554444],
    ];
    const res = normalizeRows(detectFormat(rows), rows, ctx);
    const raw = res.transactions[0]!.rawData;
    expect(raw['비고']).toBe('카드 4111-****-****-1111 / 900101-1****** 본인');
    expect(raw['회원번호']).toBe('5555-****-****-4444');
  });

  it('헤더를 못 찾으면 HEADER_NOT_FOUND', () => {
    expect(() => normalizeRows(HOMETAX_CARD_PURCHASE_V1, [['a'], ['b']], ctx)).toThrowError(/제목\(헤더\) 행/);
  });

  it('헬퍼', () => {
    expect(taxTypeOf('간이과세자')).toBe('simplified');
    expect(taxTypeOf('면세사업자')).toBe('exempt');
    expect(taxTypeOf('법인사업자')).toBe('general');
    expect(taxTypeOf('')).toBe('unknown');
    expect(deductibleHintOf('불공제')).toBe(false);
    expect(deductibleHintOf('공제')).toBe(true);
    expect(deductibleHintOf('Y')).toBe(true);
    expect(deductibleHintOf('')).toBeNull();
    expect(parseAccountCell('830 소모품비')).toEqual({ code: '830', name: '소모품비' });
    expect(parseAccountCell('83000.소모품비')).toEqual({ code: '83000', name: '소모품비' });
    expect(parseAccountCell('소모품비')).toEqual({ code: null, name: '소모품비' });
    expect(parseAccountCell('')).toBeNull();
  });
});
