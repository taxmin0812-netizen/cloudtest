/**
 * 표 형식 파일 읽기 — xlsx / csv / tsv / txt / HTML 표(위장 xls).
 *
 * - 형식 판별은 매직바이트가 우선이고 확장자는 참고만 한다.
 * - 구형 .xls(BIFF/OLE)는 지원하는 척하지 않는다 → 명확한 한국어 오류.
 * - 텍스트 인코딩: BOM → UTF-8 엄격 디코딩 → 실패 시 CP949(EUC-KR 상위집합). 홈택스 CSV 는 CP949 가 흔하다.
 * - 대용량 xlsx(기본 5MB 초과)는 exceljs 스트리밍 리더로 읽는다.
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import Papa from 'papaparse';
import { AdapterError, LEGACY_XLS_MESSAGE } from '../errors';

export type TabularFormat = 'xlsx' | 'csv' | 'tsv' | 'html';
export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'cp949';
export type FileKind = 'xlsx' | 'zip' | 'ole' | 'encrypted_ooxml' | 'pdf' | 'html' | 'text' | 'empty' | 'binary';

/** 셀 값: 문자열 / 숫자 / 불리언 / Date(UTC 자정 기준) / null */
export type CellValue = string | number | boolean | Date | null;

export interface TabularSheet {
  name: string;
  /** 0-base 행 배열. rows[i] 는 엑셀 (i+1)행. 빈 행은 [] */
  rows: CellValue[][];
  hidden?: boolean;
}

export interface TabularFile {
  sheets: TabularSheet[];
  format: TabularFormat;
  /** 텍스트 형식일 때 감지된 인코딩 */
  encoding: TextEncoding | null;
  /** 스트리밍 리더 사용 여부 */
  streamed: boolean;
  warnings: string[];
}

export interface ReadOptions {
  /** 이 크기(byte) 초과 xlsx 는 스트리밍으로 읽는다. 기본 5MB */
  streamingThresholdBytes?: number;
  /** 시트당 최대 행 수. 기본 300,000 */
  maxRowsPerSheet?: number;
  /** 텍스트 인코딩 강제 지정 (자동 감지 무시) */
  encoding?: TextEncoding;
}

export const DEFAULT_STREAMING_THRESHOLD = 5 * 1024 * 1024;
export const DEFAULT_MAX_ROWS = 300_000;

// ────────────────────────────── 형식 판별 ──────────────────────────────

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** BIFF8(Excel 97~2003) 'Workbook', BIFF5 'Book' 스트림 이름 (OLE 디렉터리는 UTF-16LE) */
const OLE_WORKBOOK_STREAM = Buffer.from('Workbook', 'utf16le');
const OLE_BOOK_STREAM = Buffer.from('Book\u0000', 'utf16le');

export function sniffFileKind(buffer: Buffer): FileKind {
  if (buffer.length === 0) return 'empty';
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05)) {
    return buffer.includes('xl/workbook.xml') ? 'xlsx' : 'zip';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(OLE_MAGIC)) {
    // 암호가 걸린 xlsx 는 OLE 컨테이너 안에 EncryptedPackage 스트림을 가진다
    return buffer.includes(Buffer.from('EncryptedPackage', 'utf16le')) ? 'encrypted_ooxml' : 'ole';
  }
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const head = buffer.subarray(0, 4096);
  const hasUtf16Bom = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  if (!hasUtf16Bom) {
    let nul = 0;
    for (const b of head) if (b === 0) nul++;
    if (nul > 0) return 'binary';
  }
  const probe = (hasUtf16Bom ? decodeText(head).text : head.toString('latin1')).toLowerCase();
  if (/<\s*(table|html)[\s>]/.test(probe)) return 'html';
  return 'text';
}

// ────────────────────────────── 인코딩 ──────────────────────────────

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

export function decodeText(buf: Buffer, forced?: TextEncoding): { text: string; encoding: TextEncoding } {
  if (forced) {
    switch (forced) {
      case 'utf-8':
      case 'utf-8-bom':
        return { text: stripBom(buf.toString('utf8')), encoding: forced };
      case 'utf-16le':
        return { text: stripBom(iconv.decode(buf, 'utf16-le')), encoding: forced };
      case 'utf-16be':
        return { text: stripBom(iconv.decode(buf, 'utf16-be')), encoding: forced };
      case 'cp949':
        return { text: iconv.decode(buf, 'cp949'), encoding: forced };
    }
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.subarray(2), 'utf16-le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.subarray(2), 'utf16-be'), encoding: 'utf-16be' };
  }
  try {
    return { text: utf8Strict.decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: iconv.decode(buf, 'cp949'), encoding: 'cp949' };
  }
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ────────────────────────────── 진입점 ──────────────────────────────

function extOf(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : '';
}

export async function readTabularFile(buffer: Buffer, fileName: string, opts: ReadOptions = {}): Promise<TabularFile> {
  const kind = sniffFileKind(buffer);
  const ext = extOf(fileName);
  const maxRows = opts.maxRowsPerSheet ?? DEFAULT_MAX_ROWS;
  switch (kind) {
    case 'empty':
      throw new AdapterError('EMPTY_FILE', '빈 파일입니다. 파일을 다시 내려받아 올려주세요.');
    case 'ole':
      // OLE 컨테이너는 .xls 외에 .doc·.hwp 도 있다 — 엑셀 통합문서 스트림(Workbook/Book)이 있거나 확장자가 .xls 일 때만 구형 xls 안내
      if (ext === 'xls' || buffer.includes(OLE_WORKBOOK_STREAM) || buffer.includes(OLE_BOOK_STREAM)) {
        throw new AdapterError('LEGACY_XLS', LEGACY_XLS_MESSAGE, { fileName });
      }
      throw new AdapterError('UNSUPPORTED_FORMAT', '엑셀 파일이 아닌 문서(한글·워드 등)로 보입니다. 엑셀(.xlsx) 또는 CSV 파일을 올려주세요.', { fileName });
    case 'encrypted_ooxml':
      throw new AdapterError('ENCRYPTED_FILE', '암호가 설정된 엑셀 파일입니다. Excel에서 암호를 해제하고 .xlsx로 저장 후 올려주세요.', { fileName });
    case 'pdf':
      throw new AdapterError('PDF_NOT_TABULAR', 'PDF 파일은 거래자료로 읽을 수 없습니다. 엑셀(.xlsx) 또는 CSV로 내려받아 올려주세요.', { fileName });
    case 'zip':
      throw new AdapterError(
        'UNSUPPORTED_FORMAT',
        ext === 'xlsb'
          ? '바이너리 엑셀(.xlsb)은 지원하지 않습니다. Excel에서 .xlsx로 저장 후 올려주세요.'
          : 'ZIP 파일입니다. 압축을 풀어 엑셀(.xlsx) 또는 CSV 파일을 올려주세요.',
        { fileName },
      );
    case 'binary':
      throw new AdapterError('UNSUPPORTED_FORMAT', '읽을 수 없는 파일 형식입니다. 엑셀(.xlsx) 또는 CSV 파일을 올려주세요.', { fileName });
    case 'xlsx': {
      const threshold = opts.streamingThresholdBytes ?? DEFAULT_STREAMING_THRESHOLD;
      const streamed = buffer.length > threshold;
      try {
        const sheets = streamed ? await readXlsxStreaming(buffer, maxRows) : await readXlsxInMemory(buffer, maxRows);
        return { sheets, format: 'xlsx', encoding: null, streamed, warnings: [] };
      } catch (e) {
        if (e instanceof AdapterError) throw e;
        throw new AdapterError('CORRUPT_FILE', '엑셀 파일을 여는 중 오류가 발생했습니다. 파일이 손상되지 않았는지 확인 후 다시 저장해 올려주세요.', {
          fileName,
          cause: e instanceof Error ? e.message : String(e),
        });
      }
    }
    case 'html': {
      const { text, encoding } = decodeText(buffer, opts.encoding);
      const sheets = parseHtmlTables(text, maxRows);
      if (sheets.length === 0) {
        throw new AdapterError('UNSUPPORTED_FORMAT', 'HTML 파일에서 표를 찾지 못했습니다. 엑셀(.xlsx)로 저장 후 올려주세요.', { fileName });
      }
      const warnings = ext === 'xls' ? ['확장자는 .xls 이지만 실제 내용은 HTML 표입니다 (홈택스 등에서 흔한 형식) — 표로 읽었습니다.'] : [];
      return { sheets, format: 'html', encoding, streamed: false, warnings };
    }
    case 'text': {
      const { text, encoding } = decodeText(buffer, opts.encoding);
      const { rows, delimiter } = parseDelimited(text, ext);
      if (rows.length > maxRows) throw tooManyRows(rows.length, maxRows);
      const warnings = ext === 'xls' || ext === 'xlsx' ? [`확장자는 .${ext} 이지만 실제 내용은 텍스트(구분자 '${delimiter === '\t' ? 'TAB' : delimiter}')입니다 — 텍스트로 읽었습니다.`] : [];
      return {
        sheets: [{ name: baseName(fileName), rows }],
        format: delimiter === '\t' ? 'tsv' : 'csv',
        encoding,
        streamed: false,
        warnings,
      };
    }
  }
}

function tooManyRows(n: number, max: number): AdapterError {
  return new AdapterError('TOO_MANY_ROWS', `행이 너무 많습니다 (${n.toLocaleString('ko-KR')}행, 최대 ${max.toLocaleString('ko-KR')}행). 기간을 나누어 올려주세요.`, {
    rows: n,
    max,
  });
}

function baseName(fileName: string): string {
  const b = fileName.split(/[\\/]/).pop() ?? fileName;
  return b.replace(/\.[^.]+$/, '') || 'Sheet1';
}

// ────────────────────────────── CSV / TSV ──────────────────────────────

/** ="0012" 형태(엑셀 텍스트 강제 표기) 벗기기 */
function unwrapExcelText(s: string): string {
  const m = /^="(.*)"$/.exec(s);
  return m ? m[1]! : s;
}

export function parseDelimited(text: string, ext = ''): { rows: CellValue[][]; delimiter: string } {
  const forcedTab = ext === 'tsv';
  const result = Papa.parse<string[]>(text, {
    delimiter: forcedTab ? '\t' : '',
    delimitersToGuess: ['\t', ',', ';', '|'],
    skipEmptyLines: false,
  });
  const delimiter = forcedTab ? '\t' : result.meta.delimiter || ',';
  const rows: CellValue[][] = result.data.map((r) => (Array.isArray(r) ? r.map((c) => unwrapExcelText(String(c ?? ''))) : []));
  // 마지막 개행으로 생기는 빈 행 제거
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c === '' || c === null)) rows.pop();
  return { rows: rows.map((r) => (r.every((c) => c === '') ? [] : r)), delimiter };
}

// ────────────────────────────── XLSX ──────────────────────────────

/** exceljs 셀 값 → 원시 값 (리치텍스트 연결, 수식은 캐시 결과, 하이퍼링크는 표시 텍스트) */
export function normalizeCellValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
    if ('formula' in o || 'sharedFormula' in o) return 'result' in o ? normalizeCellValue(o.result) : null;
    if (typeof o.error === 'string') return o.error;
    if ('text' in o) return normalizeCellValue(o.text);
    if ('hyperlink' in o) return String(o.hyperlink);
  }
  return String(v);
}

function rowToArray(values: unknown): CellValue[] {
  if (!Array.isArray(values)) return [];
  const out: CellValue[] = [];
  // exceljs row.values 는 1-base 희소배열
  for (let i = 1; i < values.length; i++) out.push(normalizeCellValue(values[i]));
  while (out.length > 0 && (out[out.length - 1] === null || out[out.length - 1] === '')) out.pop();
  return out;
}

function fillHoles(rows: CellValue[][]): CellValue[][] {
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

async function readXlsxInMemory(buffer: Buffer, maxRows: number): Promise<TabularSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheets: TabularSheet[] = [];
  for (const ws of wb.worksheets) {
    const rows: CellValue[][] = [];
    if (ws.rowCount > maxRows) throw tooManyRows(ws.rowCount, maxRows);
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      rows[rowNumber - 1] = rowToArray(row.values);
    });
    sheets.push({ name: ws.name, rows: fillHoles(rows), hidden: ws.state !== 'visible' });
  }
  return sheets;
}

async function readXlsxStreaming(buffer: Buffer, maxRows: number): Promise<TabularSheet[]> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(buffer), {
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'cache', // 날짜 서식 판별에 필요
    hyperlinks: 'ignore',
    entries: 'ignore',
  });
  const sheets: TabularSheet[] = [];
  let idx = 0;
  for await (const wsReader of reader) {
    idx++;
    const rows: CellValue[][] = [];
    let count = 0;
    for await (const row of wsReader) {
      if (++count > maxRows) throw tooManyRows(count, maxRows);
      rows[row.number - 1] = rowToArray(row.values);
    }
    const meta = wsReader as unknown as { name?: string; id?: number; state?: string };
    sheets.push({ name: meta.name ?? `Sheet${meta.id ?? idx}`, rows: fillHoles(rows), hidden: meta.state !== undefined && meta.state !== 'visible' });
  }
  return sheets;
}

// ────────────────────────────── HTML 표 (위장 xls) ──────────────────────────────

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith('#')) {
      const cp = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      // 잘못된 코드포인트(범위 밖·서로게이트)는 원문 유지 — RangeError 로 읽기 전체가 실패하지 않게
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[lower] ?? m;
  });
}

export function parseHtmlTables(html: string, maxRows = DEFAULT_MAX_ROWS): TabularSheet[] {
  const sheets: TabularSheet[] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm: RegExpExecArray | null;
  let n = 0;
  while ((tm = tableRe.exec(html))) {
    n++;
    const rows: CellValue[][] = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>|$)/gi;
    let rm: RegExpExecArray | null;
    while ((rm = trRe.exec(tm[1]!))) {
      const cells: CellValue[] = [];
      const tdRe = /<t([dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr>|$)/gi;
      let cm: RegExpExecArray | null;
      while ((cm = tdRe.exec(rm[1]!))) {
        const inner = cm[3]!.replace(/<\/t[dh]>\s*$/i, '');
        const text = decodeEntities(inner.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        cells.push(text);
        const span = /colspan\s*=\s*["']?(\d+)/i.exec(cm[2]!);
        const extra = span ? Math.min(Number(span[1]) - 1, 100) : 0;
        for (let k = 0; k < extra; k++) cells.push('');
      }
      rows.push(cells.every((c) => c === '') ? [] : cells);
      if (rows.length > maxRows) throw tooManyRows(rows.length, maxRows);
    }
    if (rows.some((r) => r.length > 0)) sheets.push({ name: `표${n}`, rows });
  }
  return sheets;
}
