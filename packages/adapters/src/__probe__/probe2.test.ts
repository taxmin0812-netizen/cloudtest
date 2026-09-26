import { describe, it } from 'vitest';
import { detectFormat } from '../format/detect';
import { normalizeRows } from '../normalize/normalize-rows';
import { CLIENT, taxInvoiceRows, exemptInvoiceRows } from '../__fixtures__/builders';

const ctx = { clientId: CLIENT.id, businessNumber: CLIENT.businessNumber, channel: 'hometax_file' as const };
describe('probe2', () => {
  it('tax invoice w/o preamble named 계산서', () => {
    const rows = taxInvoiceRows().slice(5);
    const d = detectFormat(rows, { fileName: '매입_계산서_202609.xlsx' });
    console.log('P2:', d.profile.id, d.confidence, JSON.stringify(d.candidates));
    const r = normalizeRows(d, rows, ctx);
    console.log('P2 res:', r.transactions.length, r.failures.map((f) => f.code));
    const d2 = detectFormat(rows, { fileName: '면세.xlsx' });
    console.log('P2b:', d2.profile.id, JSON.stringify(d2.candidates));
    const e = exemptInvoiceRows().slice(5);
    const d3 = detectFormat(e, { fileName: '세금계산서.xlsx' });
    console.log('P3:', d3.profile.id, JSON.stringify(d3.candidates));
  });
});
