import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { cardPurchaseRows, CARD_HEADER, toCsvBuffer, toXlsxBuffer } from '../__fixtures__/builders';
import { AdapterError, LEGACY_XLS_MESSAGE } from '../errors';
import { decodeText, normalizeCellValue, parseDelimited, parseHtmlTables, readTabularFile, sniffFileKind } from './read';

async function expectAdapterError(p: Promise<unknown>, code: string): Promise<AdapterError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as AdapterError).code).toBe(code);
    return e as AdapterError;
  }
  throw new Error(`expected AdapterError ${code}`);
}

describe('sniffFileKind', () => {
  it('매직바이트로 형식을 판별한다', async () => {
    expect(sniffFileKind(Buffer.alloc(0))).toBe('empty');
    expect(sniffFileKind(await toXlsxBuffer([{ name: 'a', rows: [['x']] }]))).toBe('xlsx');
    expect(sniffFileKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]))).toBe('ole');
    expect(sniffFileKind(Buffer.from('%PDF-1.7\n...'))).toBe('pdf');
    expect(sniffFileKind(Buffer.from('<html><body><table><tr><td>1</td></tr></table>'))).toBe('html');
    expect(sniffFileKind(Buffer.from('a,b\n1,2'))).toBe('text');
    expect(sniffFileKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBe('zip');
  });

  it('암호 걸린 xlsx(OLE + EncryptedPackage)를 구분한다', () => {
    const b = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(100),
      Buffer.from('EncryptedPackage', 'utf16le'),
    ]);
    expect(sniffFileKind(b)).toBe('encrypted_ooxml');
  });
});

describe('readTabularFile — 거부', () => {
  it('구형 .xls 는 명확한 한국어 오류', async () => {
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    const e = await expectAdapterError(readTabularFile(xls, '카드내역.xls'), 'LEGACY_XLS');
    expect(e.message).toBe(LEGACY_XLS_MESSAGE);
    expect(e.message).toBe('구형 .xls 형식입니다. Excel에서 .xlsx로 저장 후 올려주세요.');
  });

  it('빈 파일·PDF·ZIP·바이너리·암호파일', async () => {
    await expectAdapterError(readTabularFile(Buffer.alloc(0), 'a.csv'), 'EMPTY_FILE');
    await expectAdapterError(readTabularFile(Buffer.from('%PDF-1.4 xx'), '접수증.pdf'), 'PDF_NOT_TABULAR');
    await expectAdapterError(readTabularFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'a.zip'), 'UNSUPPORTED_FORMAT');
    await expectAdapterError(readTabularFile(Buffer.from([0x00, 0x01, 0x02, 0x00]), 'a.bin'), 'UNSUPPORTED_FORMAT');
    const enc = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('EncryptedPackage', 'utf16le')]);
    const e = await expectAdapterError(readTabularFile(enc, '비번.xlsx'), 'ENCRYPTED_FILE');
    expect(e.message).toContain('암호');
  });

  it('손상된 xlsx 는 CORRUPT_FILE', async () => {
    const good = await toXlsxBuffer([{ name: 'a', rows: [['x']] }]);
    const broken = Buffer.concat([good.subarray(0, 60), Buffer.from('xl/workbook.xml'), Buffer.alloc(50)]);
    await expectAdapterError(readTabularFile(broken, 'broken.xlsx'), 'CORRUPT_FILE');
  });

  it('행 수 제한', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [String(i)]);
    await expectAdapterError(readTabularFile(toCsvBuffer(rows), 'big.csv', { maxRowsPerSheet: 10 }), 'TOO_MANY_ROWS');
  });
});

describe('readTabularFile — CSV 인코딩', () => {
  const rows = cardPurchaseRows();

  it('CP949(EUC-KR) CSV 를 자동 감지해 한글을 복원한다', async () => {
    const buf = toCsvBuffer(rows, 'cp949');
    // UTF-8 로 읽으면 깨지는 바이트열인지 확인
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(buf)).toThrow();
    const f = await readTabularFile(buf, '카드_cp949.csv');
    expect(f.format).toBe('csv');
    expect(f.encoding).toBe('cp949');
    expect(f.sheets[0]!.rows[1]).toEqual(CARD_HEADER);
    expect(f.sheets[0]!.rows[2]![4]).toBe('스타벅스커피 강남점');
  });

  it('UTF-8 BOM / UTF-8', async () => {
    const a = await readTabularFile(toCsvBuffer(rows, 'utf8bom'), 'a.csv');
    expect(a.encoding).toBe('utf-8-bom');
    expect(a.sheets[0]!.rows[1]![0]).toBe('승인일자');
    const b = await readTabularFile(toCsvBuffer(rows, 'utf8'), 'b.csv');
    expect(b.encoding).toBe('utf-8');
    expect(b.sheets[0]!.rows.length).toBe(rows.length);
  });

  it('UTF-16LE BOM 텍스트', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('가,나\n1,2', 'utf16-le')]);
    expect(decodeText(buf)).toEqual({ text: '가,나\n1,2', encoding: 'utf-16le' });
  });

  it('탭 구분 텍스트(TSV), 인용부호, ="..." 텍스트 강제 표기', async () => {
    const tsv = '매출일시\t공급가액\t비고\n2026-09-01\t1,000\t="0012"\n';
    const f = await readTabularFile(Buffer.from(tsv), '현금영수증.txt');
    expect(f.format).toBe('tsv');
    expect(f.sheets[0]!.rows).toEqual([
      ['매출일시', '공급가액', '비고'],
      ['2026-09-01', '1,000', '0012'],
    ]);
    const { rows: r } = parseDelimited('a,b\n"x, y","say ""hi"""\n\n1,2\n');
    expect(r).toEqual([['a', 'b'], ['x, y', 'say "hi"'], [], ['1', '2']]);
  });

  it('인코딩 강제 지정', async () => {
    const f = await readTabularFile(iconv.encode('가,나\n', 'cp949'), 'x.csv', { encoding: 'cp949' });
    expect(f.sheets[0]!.rows[0]).toEqual(['가', '나']);
  });
});

describe('readTabularFile — XLSX', () => {
  async function richWorkbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('내역');
    ws.getCell('A1').value = { richText: [{ text: '공급' }, { text: '가액', font: { bold: true } }] };
    ws.getCell('B1').value = '일자';
    ws.getCell('C1').value = '링크';
    ws.getCell('D1').value = '계산';
    ws.getCell('A2').value = 1000;
    ws.getCell('B2').value = new Date(Date.UTC(2026, 8, 12));
    ws.getCell('C2').value = { text: '홈택스', hyperlink: 'https://www.hometax.go.kr' };
    ws.getCell('D2').value = { formula: 'A2*1.1', result: 1100 };
    ws.getCell('A4').value = 'gap';
    const hidden = wb.addWorksheet('숨김');
    hidden.state = 'hidden';
    hidden.getCell('A1').value = 'x';
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }

  it('리치텍스트·수식 결과·날짜·하이퍼링크를 원시값으로, 빈 행은 [] 로', async () => {
    const f = await readTabularFile(await richWorkbook(), 'a.xlsx');
    expect(f.format).toBe('xlsx');
    expect(f.streamed).toBe(false);
    const rows = f.sheets[0]!.rows;
    expect(rows[0]).toEqual(['공급가액', '일자', '링크', '계산']);
    expect(rows[1]![0]).toBe(1000);
    expect(rows[1]![1]).toBeInstanceOf(Date);
    expect((rows[1]![1] as Date).toISOString().slice(0, 10)).toBe('2026-09-12');
    expect(rows[1]![2]).toBe('홈택스');
    expect(rows[1]![3]).toBe(1100);
    expect(rows[2]).toEqual([]);
    expect(rows[3]).toEqual(['gap']);
    expect(f.sheets[1]!.hidden).toBe(true);
  });

  it('스트리밍 리더(임계값 초과)도 같은 결과를 낸다', async () => {
    const buf = await richWorkbook();
    const mem = await readTabularFile(buf, 'a.xlsx');
    const str = await readTabularFile(buf, 'a.xlsx', { streamingThresholdBytes: 0 });
    expect(str.streamed).toBe(true);
    expect(str.sheets[0]!.name).toBe('내역');
    expect(str.sheets[0]!.rows.map((r) => r.map((c) => (c instanceof Date ? c.toISOString() : c)))).toEqual(
      mem.sheets[0]!.rows.map((r) => r.map((c) => (c instanceof Date ? c.toISOString() : c))),
    );
  });

  it('카드내역 xlsx 왕복', async () => {
    const buf = await toXlsxBuffer([{ name: '카드', rows: cardPurchaseRows() }]);
    const f = await readTabularFile(buf, '카드.xlsx');
    expect(f.sheets[0]!.rows[1]).toEqual(CARD_HEADER);
    expect(f.sheets[0]!.rows[2]![5]).toBe(9091);
  });

  it('normalizeCellValue: 오류값·공유수식', () => {
    expect(normalizeCellValue({ error: '#REF!' })).toBe('#REF!');
    expect(normalizeCellValue({ sharedFormula: 'A1', result: 5 })).toBe(5);
    expect(normalizeCellValue({ formula: 'A1' })).toBe(null);
    expect(normalizeCellValue({ text: { richText: [{ text: 'a' }, { text: 'b' }] }, hyperlink: 'x' })).toBe('ab');
  });
});

describe('HTML 표 (위장 xls)', () => {
  it('확장자가 .xls 여도 HTML 이면 표로 읽고 경고한다', async () => {
    const html = `<html><head><meta charset="utf-8"></head><body>
      <table><tr><th>승인일자</th><th colspan="2">가맹점</th><th>합계</th></tr>
      <tr><td>2026-09-01</td><td>스타&amp;벅스</td><td>강남</td><td>1,000</td></tr></table></body></html>`;
    const f = await readTabularFile(Buffer.from(html), '홈택스.xls');
    expect(f.format).toBe('html');
    expect(f.warnings[0]).toContain('HTML');
    expect(f.sheets[0]!.rows).toEqual([
      ['승인일자', '가맹점', '', '합계'],
      ['2026-09-01', '스타&벅스', '강남', '1,000'],
    ]);
  });

  it('CP949 HTML 도 디코딩한다', () => {
    const buf = iconv.encode('<table><tr><td>가맹점명</td></tr></table>', 'cp949');
    expect(sniffFileKind(buf)).toBe('html');
    expect(parseHtmlTables(decodeText(buf).text)[0]!.rows[0]).toEqual(['가맹점명']);
  });
});
