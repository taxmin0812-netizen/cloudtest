/**
 * export_jobs 행 → ExportJobDTO, 조회 서비스.
 */
import { and, desc, eq } from 'drizzle-orm';
import { clients, exportJobs, users } from '@mintax/db';
import { NotFoundError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { EXPORT_KIND_LABELS, EXPORT_STATUS_LABELS, assertPeriod, assertUuid, isUuid } from './helpers';
import type { ExportBlockReason, ExportComparisonDTO, ExportJobDTO, WehagoExportKind } from './types';

/** export_jobs.validation 저장 형식 */
export interface ExportValidationJson {
  attempt?: 'prepare';
  version?: number;
  fileName?: string;
  fileSha256?: string;
  fileRowCount?: number;
  template?: { key: string; version: string; name: string; status: string; verified: boolean; source: 'default' | 'office'; headerHash: string };
  comparison?: ExportComparisonDTO;
  verify?: { ok: boolean; summary: string; traceFound: boolean; diffs: Array<{ code: string; message: string; blocking: boolean }> };
  reasons?: ExportBlockReason[];
  warnings?: string[];
  preReconciliationId?: string | null;
  reconciliationId?: string | null;
  scope?: { excludedEvidenceTypes: string[]; configured: boolean };
  otherKindCount?: number;
  supersedes?: string[];
  supersededBy?: string;
  replacedInWehagoBy?: string;
  previousVersionDeleted?: { confirmedBy: string; confirmedAt: string; versions: string[] };
}

export type ExportJobRow = typeof exportJobs.$inferSelect;

export function validationOf(row: Pick<ExportJobRow, 'validation'>): ExportValidationJson {
  return (row.validation ?? {}) as ExportValidationJson;
}

export function isSuperseded(row: Pick<ExportJobRow, 'validation'>): boolean {
  return !!validationOf(row).supersededBy;
}

export function toExportJobDTO(row: ExportJobRow, client: { name: string; code: string }, createdBy: string | null): ExportJobDTO {
  const v = validationOf(row);
  const kind = row.kind as WehagoExportKind;
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: client.name,
    clientCode: client.code,
    period: row.period,
    kind: row.kind,
    kindLabel: EXPORT_KIND_LABELS[kind] ?? row.kind,
    version: v.version ?? null,
    status: row.status,
    statusLabel: v.supersededBy && row.status !== 'blocked' ? `${EXPORT_STATUS_LABELS[row.status] ?? row.status} (새 버전으로 대체됨)` : (EXPORT_STATUS_LABELS[row.status] ?? row.status),
    fileName: row.fileId ? (v.fileName ?? null) : null,
    templateKey: row.templateKey,
    templateVersion: row.templateVersion,
    templateVerified: v.template?.verified ?? null,
    rowCount: row.rowCount,
    fileRowCount: v.fileRowCount ?? null,
    totals: { count: row.rowCount, supplyAmount: row.supplyAmount, vatAmount: row.vatAmount, totalAmount: row.totalAmount },
    blockedReason: row.blockedReason,
    reasons: v.reasons ?? [],
    warnings: v.warnings ?? [],
    comparison: v.comparison ?? null,
    supersededBy: v.supersededBy ?? null,
    reconciliationId: v.reconciliationId ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy,
    downloadedAt: row.downloadedAt ? row.downloadedAt.toISOString() : null,
    uploadConfirmedAt: row.uploadConfirmedAt ? row.uploadConfirmedAt.toISOString() : null,
    integrationStatus: 'FILE_BASED',
  };
}

export async function loadExportJob(ctx: Pick<ServiceContext, 'db'>, id: string): Promise<{ row: ExportJobRow; client: { id: string; name: string; code: string }; createdBy: string | null }> {
  if (!isUuid(id)) throw new NotFoundError('전송파일');
  const [r] = await ctx.db
    .select({ row: exportJobs, clientName: clients.name, clientCode: clients.code, createdBy: users.name })
    .from(exportJobs)
    .innerJoin(clients, eq(clients.id, exportJobs.clientId))
    .leftJoin(users, eq(users.id, exportJobs.createdBy))
    .where(eq(exportJobs.id, id));
  if (!r) throw new NotFoundError('전송파일');
  return { row: r.row, client: { id: r.row.clientId, name: r.clientName, code: r.clientCode }, createdBy: r.createdBy ?? null };
}

export async function getExportJob(ctx: ServiceContext, exportJobId: string): Promise<ExportJobDTO> {
  requirePermission(ctx, 'export.create');
  const { row, client, createdBy } = await loadExportJob(ctx, exportJobId);
  return toExportJobDTO(row, client, createdBy);
}

export async function listExportJobs(ctx: ServiceContext, input: { clientId?: string; period?: string; kind?: string; limit?: number } = {}): Promise<ExportJobDTO[]> {
  requirePermission(ctx, 'export.create');
  const conds = [];
  if (input.clientId) conds.push(eq(exportJobs.clientId, assertUuid(input.clientId, 'clientId', '거래처')));
  if (input.period) conds.push(eq(exportJobs.period, assertPeriod(input.period)));
  if (input.kind) conds.push(eq(exportJobs.kind, input.kind));
  const limit = Math.min(Math.max(1, input.limit ?? 50), 500);
  const rows = await ctx.db
    .select({ row: exportJobs, clientName: clients.name, clientCode: clients.code, createdBy: users.name })
    .from(exportJobs)
    .innerJoin(clients, eq(clients.id, exportJobs.clientId))
    .leftJoin(users, eq(users.id, exportJobs.createdBy))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(exportJobs.createdAt))
    .limit(limit);
  return rows.map((r) => toExportJobDTO(r.row, { name: r.clientName, code: r.clientCode }, r.createdBy ?? null));
}
