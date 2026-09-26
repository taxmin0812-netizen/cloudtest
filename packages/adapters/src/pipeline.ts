/**
 * 가져오기 파이프라인 편의 함수 (서버 import_file 작업용).
 * 읽기 → 시트/형식 판정 → 수임처 확인 → 정규화. DB 쓰기는 하지 않는다.
 */
import { formatBusinessNumber, normalizeBusinessNumber } from '@mintax/core';
import { detectClientFromFile, type ClientMatchResult, type ClientRef } from './client-match';
import { AdapterError } from './errors';
import { readTabularFile, type CellValue, type ReadOptions, type TabularFile } from './file/read';
import { detectFormatInFile, type DetectOptions, type FormatDetection, type OtherDataSheet } from './format/detect';
import { getFormatProfile } from './format/profiles';
import { normalizeRows, type NormalizeContext, type NormalizeResult } from './normalize/normalize-rows';

export interface ImportPreview {
  file: Pick<TabularFile, 'format' | 'encoding' | 'streamed' | 'warnings'> & { sheetNames: string[] };
  sheetIndex: number;
  sheetName: string;
  detection: FormatDetection;
  client: ClientMatchResult | null;
  /** 선택 시트의 행 (사용자 열 매핑 화면용) */
  rows: CellValue[][];
  /** 선택 시트 외에 거래자료로 보이는 시트 — 이번 적재에서 빠진다 (file.warnings 에도 안내) */
  otherDataSheets: OtherDataSheet[];
}

function otherSheetMessage(o: OtherDataSheet): string {
  const name = getFormatProfile(o.profileId)?.name ?? o.profileId;
  return `시트 "${o.sheetName}"${o.hidden ? '(숨김)' : ''}에도 거래자료(${name})로 보이는 표가 있지만 이번 적재 대상이 아닙니다 — 필요하면 그 시트를 따로 적재하세요.`;
}

export async function previewImport(
  buffer: Buffer,
  fileName: string,
  opts: { clients?: readonly ClientRef[]; read?: ReadOptions; detect?: DetectOptions; sheetIndex?: number } = {},
): Promise<ImportPreview> {
  const file = await readTabularFile(buffer, fileName, opts.read);
  const { sheetIndex, sheetName, detection, otherDataSheets } = detectFormatInFile(file, {
    fileName,
    ...opts.detect,
    ...(opts.sheetIndex !== undefined ? { sheetIndex: opts.sheetIndex } : {}),
  });
  const rows = sheetIndex >= 0 ? file.sheets[sheetIndex]!.rows : [];
  const client = opts.clients && opts.clients.length > 0 ? detectClientFromFile({ rows, fileName, detection }, opts.clients) : null;
  return {
    file: {
      format: file.format,
      encoding: file.encoding,
      streamed: file.streamed,
      warnings: [...file.warnings, ...otherDataSheets.map(otherSheetMessage)],
      sheetNames: file.sheets.map((s) => s.name),
    },
    sheetIndex,
    sheetName,
    detection,
    client,
    rows,
    otherDataSheets,
  };
}

export interface ImportOptions {
  clients?: readonly ClientRef[];
  read?: ReadOptions;
  /** 사용자가 확정한 판정 (열 매핑 확인 후). sheetIndex 와 같은 시트 기준이어야 한다 */
  detection?: FormatDetection;
  /** 적재할 시트 번호 (기본: 자동 선택) */
  sheetIndex?: number;
  /** 파일 속 수임처와 선택한 수임처가 달라도 진행 (기본 false → 오류) */
  allowClientConflict?: boolean;
}

/**
 * 파일 한 개를 정규화까지 수행한다.
 * 파일 안 근거(사업자번호)가 가리키는 수임처가 ctx.clientId 와 다르면 적재하지 않고 INVALID_CONTEXT 를 던진다.
 */
export async function importTabularFile(
  buffer: Buffer,
  fileName: string,
  ctx: NormalizeContext,
  opts: ImportOptions = {},
): Promise<{ preview: ImportPreview; result: NormalizeResult }> {
  const preview = await previewImport(buffer, fileName, {
    clients: opts.clients,
    read: opts.read,
    ...(opts.sheetIndex !== undefined ? { sheetIndex: opts.sheetIndex } : {}),
  });
  const best = preview.client?.best;
  if (best && !preview.client!.ambiguous && best.confidence >= 90 && best.clientId !== ctx.clientId && !opts.allowClientConflict) {
    const selected = normalizeBusinessNumber(ctx.businessNumber);
    throw new AdapterError(
      'INVALID_CONTEXT',
      `파일 속 수임처는 ${best.name}(${formatBusinessNumber(normalizeBusinessNumber(best.businessNumber))})로 보이는데, 선택한 수임처(${formatBusinessNumber(selected)})와 다릅니다. 수임처를 확인해 주세요.`,
      { detectedClientId: best.clientId, reasons: best.reasons },
    );
  }
  const detection = opts.detection ?? preview.detection;
  const result = normalizeRows(detection, preview.rows, { ...ctx, sheetName: ctx.sheetName ?? preview.sheetName });
  for (const o of preview.otherDataSheets) {
    result.warnings.push({ sourceRowNumber: null, code: 'other_sheet_not_imported', message: otherSheetMessage(o) });
  }
  return { preview, result };
}
