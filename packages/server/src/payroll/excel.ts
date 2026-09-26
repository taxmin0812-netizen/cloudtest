/**
 * exceljs 로더.
 * exceljs 는 @mintax/adapters 의 의존성이고 server 패키지에는 직접 선언되어 있지 않다 (package.json 수정 금지).
 * 그래서 adapters 패키지 위치를 기준으로 require 해서 같은 사본을 쓴다. 타입은 이 파일이 쓰는 부분만 선언한다.
 */
import { createRequire } from 'node:module';

export interface XCell {
  value: unknown;
  font?: Record<string, unknown>;
  fill?: Record<string, unknown>;
  numFmt?: string;
  alignment?: Record<string, unknown>;
  border?: Record<string, unknown>;
}
export interface XRow {
  getCell(i: number): XCell;
  font?: Record<string, unknown>;
  height?: number;
}
export interface XColumn {
  width?: number;
  numFmt?: string;
}
export interface XWorksheet {
  name: string;
  getRow(i: number): XRow;
  getColumn(i: number): XColumn;
  getCell(ref: string): XCell;
  mergeCells(range: string): void;
  views: Array<Record<string, unknown>>;
  rowCount: number;
  eachRow(cb: (row: XRow & { values: unknown[] }, rowNumber: number) => void): void;
}
export interface XWorkbook {
  creator: string;
  created: Date;
  modified: Date;
  addWorksheet(name: string): XWorksheet;
  getWorksheet(name: string): XWorksheet | undefined;
  worksheets: XWorksheet[];
  xlsx: { writeBuffer(): Promise<ArrayBuffer>; load(data: Buffer | ArrayBuffer): Promise<unknown> };
}
export interface ExcelJSModule {
  Workbook: new () => XWorkbook;
}

let cached: ExcelJSModule | null = null;

export function loadExcelJS(): ExcelJSModule {
  if (cached) return cached;
  const req = createRequire(import.meta.url);
  let mod: unknown;
  try {
    mod = req('exceljs');
  } catch {
    const adaptersEntry = req.resolve('@mintax/adapters');
    mod = createRequire(adaptersEntry)('exceljs');
  }
  const m = mod as ExcelJSModule & { default?: ExcelJSModule };
  cached = typeof m.Workbook === 'function' ? m : (m.default as ExcelJSModule);
  return cached;
}
