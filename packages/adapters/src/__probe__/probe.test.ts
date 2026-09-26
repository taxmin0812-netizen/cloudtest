import { describe, it, expect } from 'vitest';
import { detectFormat } from '../format/detect';
import { normalizeRows } from '../normalize/normalize-rows';
import { CLIENT, taxInvoiceRows, cardPurchaseRows, CARD_HEADER, VENDOR_A, dashed, toXlsxBuffer } from '../__fixtures__/builders';
import { readTabularFile } from '../file/read';
import { previewImport, importTabularFile } from '../pipeline';
import { WEHAGO_PURCHASE_SALES_TEMPLATE } from '../wehago/templates';
import { writeWehagoExport, verifyExportFile, computeExportTotals } from '../wehago/export';

const ctx = { clientId: CLIENT.id, businessNumber: CLIENT.businessNumber, channel: 'hometax_file' as const };

describe('probe', () => {
  it('tax invoice file named 계산서 → which profile?', () => {
    const d = detectFormat(taxInvoiceRows(), { fileName: '매입_계산서_202609.xlsx' });
    console.log('PROFILE(계산서 name):', d.profile.id, d.confidence, d.candidates);
  });
  it('unsafe-integer card number in free column', () => {
    const rows = [CARD_HEADER.concat(['메모번호']), ['2026-09-01', 'BC', '9410-1234-5678-9012', dashed(VENDOR_A.bizno), VENDOR_A.name, 1000, 100, 0, 1100, '', '', '', '공제', '', 9410123456789012]];
    const d = detectFormat(rows);
    const r = normalizeRows(d, rows, ctx);
    console.log('RAW:', JSON.stringify(r.transactions[0]?.rawData));
  });
  it('USD integer amount', () => {
    const rows = [CARD_HEADER.concat(['통화']), ['2026-09-01', 'BC', '9410-1234-5678-9012', '', 'AWS', '', '', '', 25, '', '', '', '공제', '', 'USD']];
    const d = detectFormat(rows);
    const r = normalizeRows(d, rows, ctx);
    console.log('USD:', r.transactions.map((t) => [t.totalAmount, t.currency, t.isForeign]), r.failures.map((f) => f.reason));
  });
  it('multi sheet', async () => {
    const buf = await toXlsxBuffer([{ name: 'A', rows: cardPurchaseRows() }, { name: 'B', rows: cardPurchaseRows() }]);
    const p = await previewImport(buf, 'x.xlsx');
    console.log('SHEETS:', p.sheetName, p.file.sheetNames, p.file.warnings);
  });
  it('html entity crash', async () => {
    const html = '<table><tr><td>a&#99999999;</td></tr></table>';
    try { await readTabularFile(Buffer.from(html), 'x.xls'); console.log('HTML ok'); } catch (e) { console.log('HTML ERR:', (e as Error).name, (e as Error).message); }
  });
});
