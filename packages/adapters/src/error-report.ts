/**
 * "Error Item 다운로드" — 정규화 실패 행 엑셀.
 * 원본데이터는 한 셀에 "제목: 값" 형태로 요약하며, 카드번호·주민번호는 다시 한 번 마스킹한다.
 */
import ExcelJS from 'exceljs';
import type { NormalizationFailure } from '@mintax/core';
import { fieldLabel } from './format/fields';
import { looksLikeResidentNumber, maskResidentLike, scrubFreeText } from './util/sensitive';

export const ERROR_REPORT_HEADERS = ['행번호', '사유', '필드', '원본데이터'] as const;

export interface ErrorReportOptions {
  /** 시트 위 제목 (예: "카드사용내역_202609.xlsx 오류 항목") — 없으면 제목행 없이 바로 표 */
  title?: string;
  generatedAt?: Date;
}

function rawSummary(raw: Record<string, unknown>): string {
  return Object.entries(raw)
    .filter(([k, v]) => !k.startsWith('__') && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' ? JSON.stringify(v) : String(v);
      const safe = looksLikeResidentNumber(s) ? maskResidentLike(s) : scrubFreeText(s);
      return `${k}: ${safe}`;
    })
    .join(' | ');
}

export async function buildErrorReportXlsx(failures: readonly NormalizationFailure[], opts: ErrorReportOptions = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MIN TAX OPS';
  const now = opts.generatedAt ?? new Date();
  wb.created = now;
  wb.modified = now;
  const ws = wb.addWorksheet('오류 항목');
  let r = 1;
  if (opts.title) {
    ws.getCell('A1').value = opts.title;
    ws.getCell('A1').font = { bold: true, size: 12 };
    r = 3;
  }
  const header = ws.getRow(r);
  ERROR_REPORT_HEADERS.forEach((h, i) => {
    const c = header.getCell(i + 1);
    c.value = h;
    c.font = { bold: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  });
  ws.views = [{ state: 'frozen', ySplit: r }];
  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 60;
  ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 100;

  const sorted = [...failures].sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
  for (const f of sorted) {
    r++;
    const row = ws.getRow(r);
    // 행번호: 원본 파일에서 바로 찾을 수 있도록 실제 엑셀 행(rawData.__row)을 우선 표시
    const excelRow = typeof f.rawData?.__row === 'number' ? (f.rawData.__row as number) : f.sourceRowNumber;
    row.getCell(1).value = excelRow;
    row.getCell(2).value = f.reason;
    row.getCell(3).value = f.field ? fieldLabel(f.field) : '';
    const raw = rawSummary(f.rawData ?? {});
    row.getCell(4).value = raw;
    row.getCell(4).alignment = { wrapText: false };
  }
  if (sorted.length === 0) {
    ws.getRow(r + 1).getCell(2).value = '오류 항목이 없습니다.';
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
