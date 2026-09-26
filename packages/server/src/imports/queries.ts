/**
 * 자료 수집 조회 — 목록·상세·실패 행·오류 리포트·판정 미리보기.
 * 모든 집계는 SQL 에서 하고, 목록은 한 번의 조인 + 작업 상태 1회 조회로 끝낸다 (N+1 없음).
 */
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { scrubSensitive, type IngestChannel, type NormalizationFailure } from '@mintax/core';
import { clients, files, importJobs, jobs, transactionSources, transactions, users } from '@mintax/db';
import { buildErrorReportXlsx, cellText, fieldLabel, getFormatProfile, previewImport, isAdapterError } from '@mintax/adapters';
import { NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { readStoredFile } from '../infra/storage';
import { fromAdapterError, importHref } from './errors';
import { INGEST_CHANNEL_LABELS, WEHAGO_DUPLICATE_REASON, buildImportSummary, deriveImportState, isValidPeriod, stripExtension } from './helpers';
import { detectionDTO, loadClientRefs } from './shared';
import type { ImportDownloadFile, ImportDetectionDTO, ImportFailuresDTO, ImportJobDTO, ImportJobDetailDTO, ListImportJobsInput } from './types';

const MAX_FAILURES_LISTED = 5000;

const baseSelect = {
  id: importJobs.id,
  clientId: importJobs.clientId,
  clientName: clients.name,
  clientCode: clients.code,
  fileId: importJobs.fileId,
  fileName: files.originalName,
  fileSizeBytes: files.sizeBytes,
  fileSha256: files.sha256,
  channel: importJobs.channel,
  formatProfile: importJobs.formatProfile,
  source: importJobs.source,
  period: importJobs.period,
  status: importJobs.status,
  totalRows: importJobs.totalRows,
  importedRows: importJobs.importedRows,
  duplicateRows: importJobs.duplicateRows,
  failedRows: importJobs.failedRows,
  sourceSupplyAmount: importJobs.sourceSupplyAmount,
  sourceVatAmount: importJobs.sourceVatAmount,
  sourceTotalAmount: importJobs.sourceTotalAmount,
  message: importJobs.message,
  createdById: importJobs.createdBy,
  createdByName: users.name,
  createdAt: importJobs.createdAt,
  finishedAt: importJobs.finishedAt,
};

function baseQuery(ctx: ServiceContext) {
  return ctx.db
    .select(baseSelect)
    .from(importJobs)
    .leftJoin(clients, eq(clients.id, importJobs.clientId))
    .leftJoin(files, eq(files.id, importJobs.fileId))
    .leftJoin(users, eq(users.id, importJobs.createdBy));
}

type BaseRow = Awaited<ReturnType<typeof baseQuery>>[number];

interface JobInfo {
  id: string;
  status: string;
  progress: number;
  errorMessage: string | null;
}

/** import_job id → 최신 import_file 작업 (한 번의 쿼리) */
async function latestJobsFor(ctx: ServiceContext, importJobIds: string[]): Promise<Map<string, JobInfo>> {
  const out = new Map<string, JobInfo>();
  if (importJobIds.length === 0) return out;
  const rows = await ctx.db
    .select({
      id: jobs.id,
      status: jobs.status,
      progress: jobs.progress,
      errorMessage: jobs.errorMessage,
      importJobId: sql<string>`${jobs.payload}->>'importJobId'`,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(and(eq(jobs.type, 'import_file'), inArray(sql`${jobs.payload}->>'importJobId'`, importJobIds)))
    .orderBy(asc(jobs.createdAt));
  for (const r of rows) out.set(r.importJobId, { id: r.id, status: r.status, progress: r.progress, errorMessage: r.errorMessage });
  return out;
}

function toDTO(r: BaseRow, job: JobInfo | undefined): ImportJobDTO {
  const state = deriveImportState(r.status, r.clientId, r.message);
  const profile = r.formatProfile ? getFormatProfile(r.formatProfile) : undefined;
  const message = r.message ? r.message.replace(/^\[[^\]]+\]\s*/, '') : null;
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    clientCode: r.clientCode,
    fileId: r.fileId,
    fileName: r.fileName,
    fileSizeBytes: r.fileSizeBytes,
    channel: r.channel as IngestChannel,
    channelLabel: INGEST_CHANNEL_LABELS[r.channel as IngestChannel] ?? r.channel,
    formatProfile: r.formatProfile,
    formatProfileName: profile?.name ?? null,
    source: r.source,
    period: r.period,
    status: r.status,
    state,
    totalRows: r.totalRows,
    importedRows: r.importedRows,
    duplicateRows: r.duplicateRows,
    failedRows: r.failedRows,
    sourceSupplyAmount: r.sourceSupplyAmount,
    sourceVatAmount: r.sourceVatAmount,
    sourceTotalAmount: r.sourceTotalAmount,
    summary: buildImportSummary(r, state),
    message,
    notes: message ? message.split('\n').filter(Boolean) : [],
    createdById: r.createdById,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    jobId: job?.id ?? null,
    jobStatus: job?.status ?? null,
    progress: job ? job.progress : null,
    jobErrorMessage: job?.errorMessage ?? null,
    href: importHref(r.id),
  };
}

async function loadBase(ctx: ServiceContext, importJobId: string): Promise<BaseRow> {
  const [row] = await baseQuery(ctx).where(eq(importJobs.id, importJobId));
  if (!row) throw new NotFoundError('가져오기');
  return row;
}

/**
 * 가져오기 상세. 권한: imports.create (자료 수집 화면)
 */
export async function getImportJob(ctx: ServiceContext, importJobId: string): Promise<ImportJobDetailDTO> {
  requirePermission(ctx, 'imports.create');
  const row = await loadBase(ctx, importJobId);
  const jobMap = await latestJobsFor(ctx, [row.id]);
  const statusRows = await ctx.db
    .select({
      status: transactions.status,
      n: sql<number>`count(*)::int`,
      wehago: sql<number>`count(*) filter (where ${transactions.duplicateReason} = ${WEHAGO_DUPLICATE_REASON})::int`,
    })
    .from(transactions)
    .where(eq(transactions.importJobId, row.id))
    .groupBy(transactions.status);
  const transactionStatusCounts: Record<string, number> = {};
  let wehagoDuplicateRows = 0;
  for (const s of statusRows) {
    transactionStatusCounts[s.status] = s.n;
    wehagoDuplicateRows += s.wehago;
  }
  return { ...toDTO(row, jobMap.get(row.id)), wehagoDuplicateRows, transactionStatusCounts, fileSha256: row.fileSha256 };
}

/**
 * 가져오기 목록 (최신순). 권한: imports.create
 */
export async function listImportJobs(ctx: ServiceContext, input: ListImportJobsInput = {}): Promise<ImportJobDTO[]> {
  requirePermission(ctx, 'imports.create');
  if (input.period && !isValidPeriod(input.period)) throw new ValidationError('기간은 YYYY-MM 형식이어야 합니다.', [{ field: 'period', message: '형식 오류' }]);
  const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 50)));
  const conds: SQL[] = [];
  if (input.clientId) conds.push(eq(importJobs.clientId, input.clientId));
  if (input.period) conds.push(eq(importJobs.period, input.period));
  if (input.before) {
    const d = new Date(input.before);
    if (Number.isNaN(d.getTime())) throw new ValidationError('목록 커서가 올바르지 않습니다.', [{ field: 'before', message: '형식 오류' }]);
    conds.push(lt(importJobs.createdAt, d));
  }
  const rows = await baseQuery(ctx)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
    .limit(limit);
  const jobMap = await latestJobsFor(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toDTO(r, jobMap.get(r.id)));
}

async function loadFailures(ctx: ServiceContext, importJobId: string, limit: number) {
  return ctx.db
    .select({
      id: transactionSources.id,
      rowNumber: transactionSources.rowNumber,
      rawData: transactionSources.rawData,
      errorReason: transactionSources.errorReason,
      errorField: transactionSources.errorField,
      supplyAmount: transactionSources.supplyAmount,
      vatAmount: transactionSources.vatAmount,
      totalAmount: transactionSources.totalAmount,
    })
    .from(transactionSources)
    .where(and(eq(transactionSources.importJobId, importJobId), eq(transactionSources.outcome, 'failed')))
    .orderBy(asc(transactionSources.rowNumber))
    .limit(limit);
}

/**
 * 처리실패 행 목록 (사유·필드·원본). 권한: imports.create
 */
export async function getImportFailures(ctx: ServiceContext, importJobId: string): Promise<ImportFailuresDTO> {
  requirePermission(ctx, 'imports.create');
  const row = await loadBase(ctx, importJobId);
  const items = await loadFailures(ctx, importJobId, MAX_FAILURES_LISTED + 1);
  const truncated = items.length > MAX_FAILURES_LISTED;
  return {
    importJobId,
    fileName: row.fileName,
    total: row.failedRows,
    truncated,
    items: items.slice(0, MAX_FAILURES_LISTED).map((f) => ({
      sourceId: f.id,
      rowNumber: f.rowNumber,
      excelRow: typeof f.rawData.__row === 'number' ? (f.rawData.__row as number) : null,
      reason: f.errorReason ?? '사유 미상',
      field: f.errorField,
      fieldLabel: f.errorField ? fieldLabel(f.errorField) : null,
      supplyAmount: f.supplyAmount,
      vatAmount: f.vatAmount,
      totalAmount: f.totalAmount,
      rawData: f.rawData,
    })),
  };
}

/**
 * "오류 항목 다운로드" 엑셀. 감사로그 category 'download'. 권한: imports.create
 */
export async function downloadImportErrorReport(ctx: ServiceContext, importJobId: string): Promise<ImportDownloadFile> {
  requirePermission(ctx, 'imports.create');
  const row = await loadBase(ctx, importJobId);
  const failures = await loadFailures(ctx, importJobId, 1_000_000);
  const list: NormalizationFailure[] = failures.map((f) => ({
    sourceRowNumber: f.rowNumber,
    rawData: f.rawData,
    reason: f.errorReason ?? '사유 미상',
    ...(f.errorField ? { field: f.errorField } : {}),
  }));
  const base = stripExtension(row.fileName ?? '가져오기');
  const data = await buildErrorReportXlsx(list, { title: `${row.fileName ?? '가져오기'} 오류 항목 (${list.length}건)`, generatedAt: ctx.now() });
  const fileName = `${base}_오류항목.xlsx`;
  await writeAudit(ctx, {
    action: 'import.error_report.download',
    category: 'download',
    entityType: 'import_job',
    entityId: importJobId,
    clientId: row.clientId,
    summary: `${row.clientName ?? '수임처 미정'} · ${row.fileName ?? '가져오기'} 오류 항목 ${list.length}건 엑셀 다운로드`,
    before: null,
    after: { fileName, rows: list.length },
  });
  return { fileName, data, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

export interface ImportDetectionPreviewDTO {
  importJobId: string;
  detection: ImportDetectionDTO;
  sheetNames: string[];
  sheetIndex: number;
  headerRowIndex: number;
  /** 제목 행 셀 (열 매핑 화면용) */
  headerRow: string[];
  /** 제목 아래 최대 5행 (카드번호·주민번호는 가림) */
  sampleRows: string[][];
  warnings: string[];
}

/**
 * 수임처·서식 확인 화면용 — 보관된 원본을 다시 읽어 판정 결과를 보여준다. 권한: imports.create
 */
export async function getImportDetection(ctx: ServiceContext, importJobId: string, opts: { sheetIndex?: number } = {}): Promise<ImportDetectionPreviewDTO> {
  requirePermission(ctx, 'imports.create');
  const row = await loadBase(ctx, importJobId);
  if (!row.fileId) throw new NotFoundError('원본 파일');
  const { data, row: fileRow } = await readStoredFile(ctx, row.fileId);
  const clientRefs = await loadClientRefs(ctx.db);
  let preview;
  try {
    preview = await previewImport(data, fileRow.originalName, { clients: clientRefs, ...(opts.sheetIndex !== undefined ? { sheetIndex: opts.sheetIndex } : {}) });
  } catch (e) {
    if (isAdapterError(e)) throw fromAdapterError(e);
    throw e;
  }
  const h = preview.detection.headerRowIndex;
  const headerRow = h >= 0 ? (preview.rows[h] ?? []).map((c) => cellText(c)) : [];
  const sampleRows: string[][] = [];
  for (let r = Math.max(0, h + 1); r < preview.rows.length && sampleRows.length < 5; r++) {
    const cells = preview.rows[r] ?? [];
    if (cells.length === 0) continue;
    sampleRows.push(cells.map((c) => scrubSensitive(cellText(c))));
  }
  return {
    importJobId,
    detection: detectionDTO(preview, preview.detection, row.clientId, false),
    sheetNames: preview.file.sheetNames,
    sheetIndex: preview.sheetIndex,
    headerRowIndex: h,
    headerRow,
    sampleRows,
    warnings: preview.file.warnings,
  };
}
