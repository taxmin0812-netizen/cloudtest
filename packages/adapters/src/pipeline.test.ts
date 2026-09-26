import { describe, expect, it } from 'vitest';
import { CLIENT, OTHER_CLIENT, taxInvoiceRows, toCsvBuffer, toXlsxBuffer, cardPurchaseRows, wehagoLedgerRows } from './__fixtures__/builders';
import { AdapterError } from './errors';
import { importTabularFile, previewImport } from './pipeline';

const clients = [
  { id: CLIENT.id, businessNumber: CLIENT.businessNumber, name: CLIENT.name },
  { id: OTHER_CLIENT.id, businessNumber: OTHER_CLIENT.businessNumber, name: OTHER_CLIENT.name },
];

describe('가져오기 파이프라인', () => {
  it('미리보기: 형식·시트·수임처 후보', async () => {
    const buf = await toXlsxBuffer([{ name: '목록', rows: taxInvoiceRows() }]);
    const p = await previewImport(buf, '세금계산서.xlsx', { clients });
    expect(p.detection.profile.id).toBe('hometax_tax_invoice_v1');
    expect(p.sheetName).toBe('목록');
    expect(p.client?.best?.clientId).toBe(CLIENT.id);
    expect(p.file.format).toBe('xlsx');
  });

  it('정규화까지 수행하고 rawData 에 시트명 기록', async () => {
    const buf = toCsvBuffer(cardPurchaseRows(), 'cp949');
    const { preview, result } = await importTabularFile(buf, '카드.csv', { clientId: CLIENT.id, businessNumber: CLIENT.businessNumber, channel: 'hometax_file' }, { clients });
    expect(preview.file.encoding).toBe('cp949');
    expect(result.transactions.length + result.failures.length).toBe(result.stats.dataRows);
    expect(result.transactions[0]!.rawData.__sheet).toBe('카드');
  });

  it('파일 속 수임처와 선택한 수임처가 다르면 적재 거부 (명시적으로 허용 가능)', async () => {
    const buf = await toXlsxBuffer([{ name: '목록', rows: taxInvoiceRows() }]);
    const ctx = { clientId: OTHER_CLIENT.id, businessNumber: OTHER_CLIENT.businessNumber, channel: 'hometax_file' as const };
    await expect(importTabularFile(buf, 'x.xlsx', ctx, { clients })).rejects.toThrowError(AdapterError);
    await expect(importTabularFile(buf, 'x.xlsx', ctx, { clients })).rejects.toThrowError(/선택한 수임처/);
    const { result } = await importTabularFile(buf, 'x.xlsx', ctx, { clients, allowClientConflict: true });
    // 행 단위로도 수임처 불일치가 실패로 남는다
    expect(result.transactions).toHaveLength(0);
    expect(result.failures.every((f) => f.code === 'client_mismatch' || f.code === 'amount_mismatch' || f.code === 'missing_amount')).toBe(true);
  });

  it('다른 시트에 거래자료가 더 있으면 조용히 버리지 않고 경고, 시트를 지정해 따로 적재', async () => {
    const buf = await toXlsxBuffer([
      { name: '카드', rows: cardPurchaseRows() },
      { name: '카드2', rows: cardPurchaseRows() },
    ]);
    const ctx = { clientId: CLIENT.id, businessNumber: CLIENT.businessNumber, channel: 'hometax_file' as const };
    const first = await importTabularFile(buf, 'x.xlsx', ctx, { clients });
    expect(first.preview.sheetName).toBe('카드');
    expect(first.preview.otherDataSheets.map((o) => o.sheetName)).toEqual(['카드2']);
    expect(first.preview.file.warnings.join(' ')).toContain('시트 "카드2"');
    expect(first.result.warnings.find((w) => w.code === 'other_sheet_not_imported')?.message).toContain('카드2');

    const second = await importTabularFile(buf, 'x.xlsx', ctx, { clients, sheetIndex: 1 });
    expect(second.preview.sheetName).toBe('카드2');
    expect(second.result.transactions[0]!.rawData.__sheet).toBe('카드2');
    expect(second.preview.otherDataSheets.map((o) => o.sheetName)).toEqual(['카드']);
  });

  it('WEHAGO 매입매출장(역수입)은 거래로 적재하지 않는다 (이중 계상 방지) — 대사 용도로만', async () => {
    const buf = await toXlsxBuffer([{ name: '매입매출장', rows: wehagoLedgerRows() }]);
    const ctx = { clientId: CLIENT.id, businessNumber: CLIENT.businessNumber, channel: 'manual_upload' as const, direction: 'purchase' as const };
    await expect(importTabularFile(buf, '매입매출장.xlsx', ctx, { clients })).rejects.toThrowError(/이중 계상/);
    const { result } = await importTabularFile(buf, '매입매출장.xlsx', ctx, { clients, purpose: 'reconciliation' });
    expect(result.profileId).toBe('wehago_ledger_purchase_sales_v1');
    expect(result.transactions.length + result.failures.length).toBe(result.stats.dataRows);
    // 반대로 거래 파일을 대사 용도로 올리면 거부
    const card = await toXlsxBuffer([{ name: '카드', rows: cardPurchaseRows() }]);
    await expect(importTabularFile(card, '카드.xlsx', ctx, { clients, purpose: 'reconciliation' })).rejects.toThrowError(/대사용 파일이 아닙니다/);
  });
});

