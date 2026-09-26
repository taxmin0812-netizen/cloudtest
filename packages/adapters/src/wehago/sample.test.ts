import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { toXlsxBuffer, VENDOR_B } from '../__fixtures__/builders';
import { AdapterError } from '../errors';
import { readTabularFile } from '../file/read';
import { computeExportTotals, verifyExportFile, writeWehagoExport, type ExportRow } from './export';
import { buildTemplateFromSample, buildTemplateFromSampleFile } from './sample';
import { validateTemplate } from './templates';

const row: ExportRow = {
  transactionId: 'tx-1',
  date: '2026-09-01',
  direction: 'purchase',
  evidenceType: 'card',
  vatType: 'purchase_card',
  deductible: true,
  counterpartyCode: '00101',
  counterpartyName: VENDOR_B.name,
  counterpartyBusinessNumber: VENDOR_B.bizno,
  description: '커피',
  supplyAmount: 9091,
  vatAmount: 909,
  totalAmount: 10000,
  accountCode: '811',
  accountName: '복리후생비',
  cardCompany: '비씨카드',
};

// 사무소가 WEHAGO 에서 내려받았다고 가정한 서식 (열 순서·제목이 표준과 다름, 모르는 열 포함)
const OFFICE_HEADER = ['전표일자', '유형코드', '코드', '거래처', '사업자등록번호', '품명', '공급가액', '세액', '합계금액', '분개', '계정과목코드', '계정과목명', '부서', '프로젝트'];

describe('buildTemplateFromSample', () => {
  it('제목행을 표준 항목에 매핑하고 모르는 열은 빈칸으로 유지', () => {
    const r = buildTemplateFromSample(OFFICE_HEADER, { version: '20260926' });
    expect(r.base.kind).toBe('purchase_sales');
    expect(r.columns.map((c) => c.field)).toEqual([
      'date',
      'vatTypeCode',
      'counterpartyCode',
      'counterpartyName',
      'counterpartyBusinessNumber',
      'description',
      'supplyAmount',
      'vatAmount',
      'totalAmount',
      'journalTypeCode',
      'accountCode',
      'accountName',
      null,
      null,
    ]);
    expect(r.unmatchedHeaders).toEqual(['부서', '프로젝트']);
    expect(r.missingRequired).toEqual([]);
    expect(r.confidence).toBe(100);
    expect(r.template.status).toBe('office_sample');
    expect(r.template.verified).toBe(true);
    expect(r.template.version).toBe('20260926');
    expect(r.template.columns.map((c) => c.header)).toEqual(OFFICE_HEADER);
    expect(validateTemplate(r.template)).toEqual([]);
  });

  it('사무소 서식으로 생성 → 재검증 통과, 열 순서·제목 그대로', async () => {
    const { template } = buildTemplateFromSample(OFFICE_HEADER);
    const buf = await writeWehagoExport(template, [row]);
    const v = await verifyExportFile(buf, template, computeExportTotals([row]));
    expect(v.ok).toBe(true);
    const f = await readTabularFile(buf, 'office.xlsx');
    expect(f.sheets[0]!.rows[0]).toEqual(OFFICE_HEADER);
    expect(f.sheets[0]!.rows[1]!.slice(0, 4)).toEqual(['2026-09-01', '57', '00101', VENDOR_B.name]);
  });

  it('필수 항목이 없으면 verified=false + 경고', () => {
    const r = buildTemplateFromSample(['일자', '거래처명', '공급가액', '부가세', '합계']);
    expect(r.template.verified).toBe(false);
    expect(r.missingRequired).toEqual(expect.arrayContaining(['vatTypeCode', 'counterpartyCode', 'accountCode', 'journalTypeCode']));
    expect(r.warnings.join(' ')).toContain('필수 항목');
    expect(r.confidence).toBeLessThan(100);
  });

  it('일반전표 제목이면 일반전표 기준으로 매핑', () => {
    const r = buildTemplateFromSample(['월', '일', '구분', '계정코드', '계정명', '거래처', '적요', '차변', '대변']);
    expect(r.base.kind).toBe('general_journal');
    expect(r.missingRequired).toEqual([]);
  });

  it('빈 제목행은 거부', () => {
    expect(() => buildTemplateFromSample(['', ''])).toThrowError(AdapterError);
  });
});

describe('buildTemplateFromSampleFile', () => {
  it('안내문·제목행·샘플행이 있는 서식 파일 → 안내문과 샘플행을 재현하고 검증은 샘플행을 건너뜀', async () => {
    const sample = await toXlsxBuffer([
      {
        name: '매입매출',
        rows: [
          ['※ 매입매출전표 엑셀 업로드 서식 — 첫 행은 샘플입니다'],
          OFFICE_HEADER,
          ['2026-01-01', '51', '00001', '샘플상사', '1234567890', '샘플', 1000, 100, 1100, '2', '830', '소모품비', '', ''],
        ],
      },
    ]);
    const r = await buildTemplateFromSampleFile(sample, 'WEHAGO_매입매출_서식.xlsx', { version: '20260926' });
    expect(r.headerRowIndex).toBe(1);
    expect(r.template.preambleRows).toEqual([['※ 매입매출전표 엑셀 업로드 서식 — 첫 행은 샘플입니다']]);
    expect(r.template.sampleRow?.[3]).toBe('샘플상사');
    expect(r.warnings.join(' ')).toContain('샘플 행');
    expect(r.template.name).toContain('WEHAGO_매입매출_서식.xlsx');

    const buf = await writeWehagoExport(r.template, [row]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).getCell(1).value).toContain('서식');
    expect(ws.getRow(3).getCell(4).value).toBe('샘플상사');
    expect(ws.getRow(4).getCell(4).value).toBe(VENDOR_B.name);
    const v = await verifyExportFile(buf, r.template, computeExportTotals([row]));
    expect(v.ok).toBe(true);
    expect(v.actual.count).toBe(1);
  });

  it('제목행을 못 찾으면 거부', async () => {
    const buf = await toXlsxBuffer([{ name: 'x', rows: [['안녕하세요'], ['a', 'b']] }]);
    await expect(buildTemplateFromSampleFile(buf, 'x.xlsx')).rejects.toThrowError(/제목행을 찾지 못했습니다/);
  });
});
