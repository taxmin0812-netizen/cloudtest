/**
 * 템플릿 기반 xlsx 쓰기/다시 읽기 (전표·급여 공통).
 *
 * - 사업자번호·코드·일자는 텍스트 셀(서식 '@')로 써서 엑셀의 숫자 변환(앞자리 0 손실, 지수표기)을 막는다.
 * - 금액은 원 단위 정수 숫자 셀.
 * - 숨김(veryHidden) 추적 시트 MINTAX_TRACE 에 거래ID ↔ 행 범위 ↔ 금액을 남겨 재검증에 쓴다.
 */
import ExcelJS from 'exceljs';
import { normalizeDate, sha256Hex } from '@mintax/core';
import { normalizeCellValue, type CellValue } from '../file/read';
import { normalizeHeader, sanitizeText } from '../util/text';
import { templateHeaderHash, type ExportField, type TemplateColumn, type WehagoTemplate } from './templates';

export type CellOut = string | number | null;
export type FieldRecord = Partial<Record<ExportField, CellOut>>;

export const TRACE_SHEET_NAME = 'MINTAX_TRACE';
const TRACE_MARKER = 'MINTAX_TRACE';
const TRACE_VERSION = 'v2';
const DIGEST_COLUMN = 'digest';

export interface TraceEntry {
  id: string;
  /** 데이터 시트의 엑셀 행 번호 (1-base, 포함) */
  firstRow: number;
  lastRow: number;
  /** traceColumns 순서의 금액 */
  amounts: number[];
  /** 서식 열 전체 값(일자·유형·코드·거래처 등)의 sha256 — v1 추적 시트에는 없다 */
  digest: string | null;
}

/** 셀 값 → 비교용 문자열 (쓴 값과 다시 읽은 값이 같은 규칙으로 바뀌어야 한다) */
export function canonicalCell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  return String(v);
}

/** 여러 행(서식 열 순서의 셀 배열)의 내용 지문 */
export function rowsDigest(rows: ReadonlyArray<readonly unknown[]>, width: number): string {
  const lines = rows.map((cells) => {
    const out: string[] = [];
    for (let i = 0; i < width; i++) out.push(canonicalCell(cells[i]));
    return out.join('\u001f');
  });
  return sha256Hex(lines.join('\u001e'));
}

export interface WriteTemplateOptions {
  generatedAt?: Date;
  includeTraceSheet: boolean;
  traceColumns: string[];
  /** 레코드 index → 추적 ID. 같은 ID 의 연속 레코드는 한 범위로 묶인다 */
  traceIdOf: (recordIndex: number) => string;
  traceAmountsOf: (id: string) => number[];
  /** 템플릿 열 뒤에 붙일 동적 열 (급여 수당 등) */
  extraColumns?: Array<{ header: string; valueOf: (recordIndex: number) => CellOut }>;
}

export function formatDateForTemplate(date: string, format: WehagoTemplate['dateFormat']): string {
  const d = normalizeDate(date) ?? date;
  if (format === 'YYYYMMDD') return d.replace(/-/g, '');
  if (format === 'YYYY.MM.DD') return d.replace(/-/g, '.');
  return d;
}

function cellFor(col: TemplateColumn, v: CellOut, t: WehagoTemplate): { value: ExcelJS.CellValue; numFmt: string } {
  if (v === null || v === undefined || v === '') return { value: null, numFmt: col.type === 'amount' ? '#,##0' : '@' };
  switch (col.type) {
    case 'amount':
    case 'integer':
      return { value: typeof v === 'number' ? v : Number(v), numFmt: col.type === 'amount' ? '#,##0' : '0' };
    case 'percent':
      return { value: typeof v === 'number' ? v : Number(v), numFmt: '0.##' };
    case 'date':
      return { value: formatDateForTemplate(String(v), t.dateFormat), numFmt: '@' };
    case 'code':
      return { value: String(v).trim(), numFmt: '@' };
    case 'text':
    default:
      return { value: sanitizeText(String(v), t.forbiddenChars), numFmt: '@' };
  }
}

export async function writeTemplateWorkbook(template: WehagoTemplate, records: readonly FieldRecord[], opts: WriteTemplateOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const now = opts.generatedAt ?? new Date();
  wb.creator = 'MIN TAX OPS';
  wb.created = now;
  wb.modified = now;
  const ws = wb.addWorksheet(template.sheetName);
  const extras = opts.extraColumns ?? [];

  template.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width ?? 14;
    if (c.type !== 'amount' && c.type !== 'integer' && c.type !== 'percent') col.numFmt = '@';
  });
  extras.forEach((_, j) => {
    ws.getColumn(template.columns.length + j + 1).width = 12;
  });

  let r = 1;
  for (const pre of template.preambleRows) {
    const row = ws.getRow(r++);
    pre.forEach((v, j) => {
      row.getCell(j + 1).value = v;
    });
  }
  const headerRow = ws.getRow(r++);
  [...template.columns.map((c) => c.header), ...extras.map((e) => e.header)].forEach((h, j) => {
    const cell = headerRow.getCell(j + 1);
    cell.value = h;
    cell.font = { bold: true };
  });
  if (template.sampleRow) {
    const row = ws.getRow(r++);
    template.sampleRow.forEach((v, j) => {
      row.getCell(j + 1).value = v;
    });
  }

  const ranges = new Map<string, { firstRow: number; lastRow: number }>();
  const order: string[] = [];
  const written = new Map<string, unknown[][]>();
  records.forEach((rec, idx) => {
    const excelRow = r++;
    const row = ws.getRow(excelRow);
    const values: unknown[] = [];
    template.columns.forEach((c, j) => {
      const { value, numFmt } = cellFor(c, rec[c.field] ?? null, template);
      const cell = row.getCell(j + 1);
      cell.value = value;
      cell.numFmt = numFmt;
      values.push(value);
    });
    extras.forEach((e, j) => {
      const v = e.valueOf(idx);
      const cell = row.getCell(template.columns.length + j + 1);
      cell.value = v;
      if (typeof v === 'number') cell.numFmt = '#,##0';
    });
    const id = opts.traceIdOf(idx);
    const range = ranges.get(id);
    if (range && range.lastRow === excelRow - 1) range.lastRow = excelRow;
    else if (!range) {
      ranges.set(id, { firstRow: excelRow, lastRow: excelRow });
      order.push(id);
    } else {
      // 같은 ID 가 떨어져 있으면 추적 불가 → 작성 측 버그
      throw new Error(`추적 ID ${id} 의 행이 연속되지 않습니다.`);
    }
    const w = written.get(id);
    if (w) w.push(values);
    else written.set(id, [values]);
  });

  if (opts.includeTraceSheet) {
    const tr = wb.addWorksheet(TRACE_SHEET_NAME);
    tr.state = 'veryHidden';
    tr.addRow([TRACE_MARKER, TRACE_VERSION, template.key, template.version, templateHeaderHash(template), now.toISOString()]);
    tr.addRow(['id', 'firstRow', 'lastRow', ...opts.traceColumns, DIGEST_COLUMN]);
    for (const id of order) {
      const { firstRow, lastRow } = ranges.get(id)!;
      tr.addRow([id, firstRow, lastRow, ...opts.traceAmountsOf(id), rowsDigest(written.get(id)!, template.columns.length)]);
    }
    tr.getColumn(1).numFmt = '@';
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

// ────────────────────────────── 다시 읽기 ──────────────────────────────

export interface ParsedTemplateFile {
  sheetName: string | null;
  headerExcelRow: number;
  /** 첫 데이터 행 (샘플 행 다음) */
  dataStartExcelRow: number;
  /** 데이터 시트의 마지막 행 번호 (없으면 0) */
  lastExcelRow: number;
  headerCells: string[];
  headerMismatches: string[];
  /** 템플릿 열 순서대로 읽은 데이터 행 (빈 행 제외). cells 는 서식 열 위치 그대로 */
  dataRows: Array<{ excelRow: number; values: Partial<Record<ExportField, CellValue>>; cells: CellValue[] }>;
  /** 서식 샘플 행이 있는 템플릿이면 그 자리에서 읽은 값 */
  sampleRowCells: CellValue[] | null;
  trace: {
    templateKey: string;
    templateVersion: string;
    headerHash: string;
    columns: string[];
    entries: TraceEntry[];
  } | null;
}

export async function readTemplateWorkbook(buffer: Buffer, template: WehagoTemplate): Promise<ParsedTemplateFile> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws =
    wb.getWorksheet(template.sheetName) ?? wb.worksheets.find((s) => s.name !== TRACE_SHEET_NAME && s.state === 'visible') ?? null;
  const headerExcelRow = template.preambleRows.length + 1;
  const start = headerExcelRow + 1 + (template.sampleRow ? 1 : 0);
  const result: ParsedTemplateFile = {
    sheetName: ws?.name ?? null,
    headerExcelRow,
    dataStartExcelRow: start,
    lastExcelRow: 0,
    headerCells: [],
    headerMismatches: [],
    dataRows: [],
    sampleRowCells: null,
    trace: null,
  };
  if (!ws) return result;

  const cellsOf = (rowNo: number): CellValue[] => {
    const vals = ws.getRow(rowNo).values as unknown[];
    const out: CellValue[] = [];
    for (let i = 1; i < (Array.isArray(vals) ? vals.length : 0); i++) out.push(normalizeCellValue(vals[i]));
    return out;
  };

  const header = cellsOf(headerExcelRow).map((v) => (v === null ? '' : String(v)));
  result.headerCells = header;
  template.columns.forEach((c, i) => {
    if (normalizeHeader(header[i] ?? '') !== normalizeHeader(c.header)) {
      result.headerMismatches.push(`${i + 1}번째 열 제목이 "${header[i] ?? ''}" 입니다 (서식: "${c.header}").`);
    }
  });

  if (template.sampleRow) result.sampleRowCells = cellsOf(headerExcelRow + 1);
  const last = ws.actualRowCount > 0 ? ws.lastRow?.number ?? 0 : 0;
  result.lastExcelRow = last;
  for (let rn = start; rn <= last; rn++) {
    const cells = cellsOf(rn);
    if (cells.every((c) => c === null || c === '')) continue;
    const values: Partial<Record<ExportField, CellValue>> = {};
    const positional: CellValue[] = [];
    template.columns.forEach((c, i) => {
      values[c.field] = cells[i] ?? null;
      positional.push(cells[i] ?? null);
    });
    result.dataRows.push({ excelRow: rn, values, cells: positional });
  }

  const tr = wb.getWorksheet(TRACE_SHEET_NAME);
  if (tr) {
    const first = (tr.getRow(1).values as unknown[]).slice(1).map(normalizeCellValue);
    if (first[0] === TRACE_MARKER) {
      const cols = (tr.getRow(2).values as unknown[]).slice(1).map((v) => String(normalizeCellValue(v) ?? ''));
      const digestIdx = cols.indexOf(DIGEST_COLUMN);
      const amountEnd = digestIdx >= 0 ? digestIdx : cols.length;
      const entries: TraceEntry[] = [];
      for (let rn = 3; rn <= tr.rowCount; rn++) {
        const v = (tr.getRow(rn).values as unknown[]).slice(1).map(normalizeCellValue);
        if (v.length === 0 || v[0] === null) continue;
        entries.push({
          id: String(v[0]),
          firstRow: Number(v[1]),
          lastRow: Number(v[2]),
          amounts: v.slice(3, amountEnd).map((x) => Number(x)),
          digest: digestIdx >= 0 ? canonicalCell(v[digestIdx]) || null : null,
        });
      }
      result.trace = {
        templateKey: String(first[2] ?? ''),
        templateVersion: String(first[3] ?? ''),
        headerHash: String(first[4] ?? ''),
        columns: cols.slice(3, amountEnd),
        entries,
      };
    }
  }
  return result;
}

// ────────────────────────────── 재검증 공용 검사 ──────────────────────────────

export interface TraceIntegrityIssue {
  code: 'trace_invalid' | 'row_content_mismatch' | 'sample_row_changed';
  message: string;
  excelRow?: number;
  transactionId?: string;
}

/** 추적 범위가 읽을 수 있는 데이터 행 범위인지. 아니면 사유, 맞으면 null */
export function traceRangeProblem(e: TraceEntry, parsed: ParsedTemplateFile): string | null {
  if (!Number.isInteger(e.firstRow) || !Number.isInteger(e.lastRow) || e.firstRow > e.lastRow) {
    return `추적 정보의 행 범위가 올바르지 않습니다 (${String(e.firstRow)}~${String(e.lastRow)}).`;
  }
  if (e.firstRow < parsed.dataStartExcelRow) return `추적 행 ${e.firstRow} 이(가) 데이터 시작 행(${parsed.dataStartExcelRow}) 앞입니다.`;
  return null;
}

/**
 * 금액 외 내용(일자·유형·코드·거래처 등) 무결성과 샘플 행을 확인한다.
 * - 추적 지문(digest)과 다시 읽은 셀 값이 다르면: 쓰기/읽기 과정에서 값이 바뀐 것(숫자 변환·앞자리 0 손실 등) 또는 사후 수정
 * - 샘플 행이 서식 원본과 다르면: 생성 오류
 */
export function checkTraceIntegrity(parsed: ParsedTemplateFile, template: WehagoTemplate): TraceIntegrityIssue[] {
  const issues: TraceIntegrityIssue[] = [];
  const width = template.columns.length;
  if (template.sampleRow) {
    const expected = template.sampleRow.slice(0, width);
    if (rowsDigest([parsed.sampleRowCells ?? []], width) !== rowsDigest([expected], width)) {
      issues.push({ code: 'sample_row_changed', message: `${parsed.headerExcelRow + 1}행(서식 샘플 행)이 등록된 서식과 다릅니다.`, excelRow: parsed.headerExcelRow + 1 });
    }
  }
  if (!parsed.trace) return issues;
  const byRow = new Map(parsed.dataRows.map((d) => [d.excelRow, d.cells]));
  for (const e of parsed.trace.entries) {
    const problem = traceRangeProblem(e, parsed);
    if (problem) {
      issues.push({ code: 'trace_invalid', message: problem, transactionId: e.id });
      continue;
    }
    if (!e.digest) continue;
    // 파일 끝보다 뒤를 가리키면 행이 잘린 것 — 범위를 끝까지 돌지 않는다 (조작된 추적 정보로 인한 과도한 반복 방지)
    let same = e.lastRow <= parsed.lastExcelRow;
    if (same) {
      const rows: CellValue[][] = [];
      for (let rn = e.firstRow; rn <= e.lastRow; rn++) rows.push(byRow.get(rn) ?? []);
      same = rowsDigest(rows, width) === e.digest;
    }
    if (!same) {
      issues.push({
        code: 'row_content_mismatch',
        message: `${e.firstRow}${e.lastRow > e.firstRow ? `~${e.lastRow}` : ''}행(${e.id}): 파일 내용(일자·유형·코드·거래처·금액 등)이 생성 당시와 다릅니다.`,
        excelRow: e.firstRow,
        transactionId: e.id,
      });
    }
  }
  return issues;
}
