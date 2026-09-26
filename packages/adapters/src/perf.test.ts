import { describe, expect, it } from 'vitest';
import { CARD_HEADER, CLIENT, dashed, makeBizNo, toCsvBuffer, toXlsxBuffer } from './__fixtures__/builders';
import { readTabularFile } from './file/read';
import { detectFormatInFile } from './format/detect';
import { normalizeRows } from './normalize/normalize-rows';
import { computeExportTotals, verifyExportFile, writeWehagoExport, type ExportRow } from './wehago/export';
import { WEHAGO_PURCHASE_SALES_TEMPLATE } from './wehago/templates';

const N = 20_000;

function bigCardRows(): unknown[][] {
  const merchants = Array.from({ length: 200 }, (_, i) => ({ name: `가맹점${i} 강남점`, bizno: dashed(makeBizNo(String(100000000 + i * 7919).slice(0, 9))) }));
  const rows: unknown[][] = [['총 사용금액 : -'], CARD_HEADER];
  for (let i = 0; i < N; i++) {
    const m = merchants[i % merchants.length]!;
    const supply = 1000 + (i % 977) * 10;
    const vat = Math.trunc(supply / 10);
    const day = String((i % 28) + 1).padStart(2, '0');
    rows.push([`2026-09-${day}`, '비씨카드 (주)', '4111-1111-1111-1111', m.bizno, m.name, supply, vat, 0, supply + vat, '일반과세자', '음식', '한식', i % 5 === 0 ? '불공제' : '공제', '']);
  }
  return rows;
}

describe('성능 (20,000행)', () => {
  const ctx = { clientId: CLIENT.id, businessNumber: CLIENT.businessNumber, channel: 'hometax_file' as const };

  it('CP949 CSV: 읽기 + 판정 + 정규화 < 5초, 행 회계 정확', async () => {
    const buf = toCsvBuffer(bigCardRows(), 'cp949');
    const t0 = performance.now();
    const file = await readTabularFile(buf, 'big.csv');
    const { sheetIndex, detection } = detectFormatInFile(file);
    const res = normalizeRows(detection, file.sheets[sheetIndex]!.rows, ctx);
    const ms = performance.now() - t0;
    expect(file.encoding).toBe('cp949');
    expect(res.stats.dataRows).toBe(N);
    expect(res.transactions.length + res.failures.length).toBe(N);
    expect(res.failures).toHaveLength(0);
    expect(ms).toBeLessThan(5000);
  }, 30_000);

  it('XLSX (스트리밍 리더): 읽기 + 판정 + 정규화 < 5초', async () => {
    const buf = await toXlsxBuffer([{ name: '카드', rows: bigCardRows() }]);
    const t0 = performance.now();
    const file = await readTabularFile(buf, 'big.xlsx', { streamingThresholdBytes: 0 });
    const { sheetIndex, detection } = detectFormatInFile(file);
    const res = normalizeRows(detection, file.sheets[sheetIndex]!.rows, ctx);
    const ms = performance.now() - t0;
    expect(file.streamed).toBe(true);
    expect(res.transactions).toHaveLength(N);
    expect(ms).toBeLessThan(5000);
  }, 60_000);

  it('WEHAGO 전송 파일 20,000행 생성 + 재검증 < 10초', async () => {
    const rows: ExportRow[] = Array.from({ length: N }, (_, i) => {
      const supply = 1000 + (i % 977) * 10;
      const vat = Math.trunc(supply / 10);
      return {
        transactionId: `tx-${i}`,
        date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
        direction: 'purchase',
        evidenceType: 'card',
        vatType: 'purchase_card',
        deductible: true,
        counterpartyCode: String(10000 + (i % 200)),
        counterpartyName: `가맹점${i % 200}`,
        supplyAmount: supply,
        vatAmount: vat,
        totalAmount: supply + vat,
        accountCode: '811',
        accountName: '복리후생비',
      };
    });
    const t0 = performance.now();
    const buf = await writeWehagoExport(WEHAGO_PURCHASE_SALES_TEMPLATE, rows, { period: '2026-09' });
    const v = await verifyExportFile(buf, WEHAGO_PURCHASE_SALES_TEMPLATE, computeExportTotals(rows));
    const ms = performance.now() - t0;
    expect(v.ok).toBe(true);
    expect(v.actual.count).toBe(N);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);
});
