/**
 * 대사 실행 · 조회.
 *
 * - pre_export(ready): 전송 전. 승인 거래 = 전송준비. 검토 대기·수집 실패·설명 안 되는 차이를 찾는다.
 * - pre_export(file): 전송파일(export_items = 생성 파일을 다시 읽은 금액) 기준. 1원 차이도 드러난다.
 * - post_export: WEHAGO 매입매출장 역수입 행과 비교. 전부 일치하면 거래 → reconciled.
 * 결과는 reconciliation_jobs 에 이력으로 추가한다 (덮어쓰지 않음).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ReconDiscrepancy } from '@mintax/core';
import { reconcile, type ReconcileResult } from '@mintax/core/engine/vat-risk-index';
import { clients, exportJobs, reconciliationJobs, transactions, users } from '@mintax/db';
import { AppError, NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { loadClientProfile } from '../infra/clients';
import { notifyProblem, resolveProblem } from '../infra/notify';
import { readStoredFile } from '../infra/storage';
import { EXPORT_KIND_LABELS, EXPORT_LOCK_NAMESPACE, assertPeriod, assertUuid, isUuid, parseExportScope, reconciliationHref, transferHref } from '../export/helpers';
import { loadActiveTemplate, recordTemplateVerification } from '../export/templates';
import type { WehagoExportKind } from '../export/types';
import { breakdownDTOs, discrepancyDTOs, evidenceLabel, mismatchBody, mismatchDiscrepancies, stageDTOs, stageLine, wehagoMatched } from './helpers';
import { parseWehagoLedger, type ParsedLedgerRow } from './ledger';
import { loadReconInput } from './load';
import type { ReconMode, ReconPhase, ReconciliationDTO, ReconciliationListItemDTO } from './types';

export interface WehagoReconInput {
  rows: ParsedLedgerRow[];
  fileId: string | null;
  fileName: string | null;
  failures: Array<{ rowNumber: number; reason: string }>;
  outOfPeriod: number;
}

export interface ExecuteReconOptions {
  clientId: string;
  period: string;
  phase: ReconPhase;
  mode: ReconMode;
  /** file 모드에서 비교할 전송파일들 */
  exportJobIds?: string[];
  /** reconciliation_jobs.export_job_id 로 기록할 전송파일 */
  exportJobId?: string | null;
  scopeKind?: WehagoExportKind | null;
  wehago?: WehagoReconInput | null;
}

/** reconciliation_jobs.report.meta */
export interface ReconReportMeta {
  mode: ReconMode;
  scopeKind: WehagoExportKind | null;
  exportJobIds: string[];
  excludedEvidenceTypes: string[];
  excludedByScope: number;
  excludedOtherKind: number;
  coreExportAllowed: boolean;
  wehagoMatched: boolean | null;
  stageLine: string;
  extraDiscrepancies: number;
  wehago: {
    fileId: string | null;
    fileName: string | null;
    rows: number;
    failures: number;
    outOfPeriod: number;
    excludedByScope: number;
  } | null;
}

export interface ExecutedRecon {
  id: string;
  result: ReconcileResult;
  /** core 차이 + 서버 추가 차이(역수입 파일 읽기 실패 등) */
  discrepancies: ReconDiscrepancy[];
  exportAllowed: boolean;
  wehagoMatched: boolean | null;
  meta: ReconReportMeta;
}

async function lockClientPeriod(ctx: ServiceContext, clientId: string, period: string): Promise<void> {
  await ctx.db.execute(sql`select pg_advisory_xact_lock(${EXPORT_LOCK_NAMESPACE}::int, hashtext(${clientId + period}))`);
}

/**
 * 대사 실행 + 기록 (내부용: 권한 검사·트랜잭션은 호출자가 한다).
 */
export async function executeReconciliation(ctx: ServiceContext, o: ExecuteReconOptions): Promise<ExecutedRecon> {
  const client = await loadClientProfile(ctx, o.clientId);
  const scope = parseExportScope(client.ruleParams);
  const ps = await loadActiveTemplate(ctx, 'wehago_purchase_sales');
  const loaded = await loadReconInput(ctx.db, {
    clientId: o.clientId,
    period: o.period,
    excludedEvidenceTypes: scope.excludedEvidenceTypes,
    scopeKind: o.scopeKind ?? null,
    psTemplate: ps.template,
    exportJobIds: o.mode === 'file' ? (o.exportJobIds ?? []) : null,
  });

  let wehagoExcluded = 0;
  let wehagoRows = o.wehago?.rows;
  if (wehagoRows && scope.excludedEvidenceTypes.length > 0) {
    const ex = new Set(scope.excludedEvidenceTypes);
    const kept = wehagoRows.filter((r) => !(r.evidenceType && ex.has(r.evidenceType)));
    wehagoExcluded = wehagoRows.length - kept.length;
    wehagoRows = kept;
  }

  const result = reconcile({
    source: { rows: loaded.sourceRows },
    transactions: loaded.transactions,
    exportRows: loaded.exportRows,
    wehagoRows: wehagoRows?.map((r) => ({ date: r.date, merchantName: r.merchantName, supplyAmount: r.supplyAmount, vatAmount: r.vatAmount, totalAmount: r.totalAmount, accountCode: r.accountCode ?? null })),
    scope: { period: o.period, clientName: client.name },
  });

  const extra: ReconDiscrepancy[] = [];
  for (const f of o.wehago?.failures ?? []) {
    extra.push({
      kind: 'unexplained',
      sourceRowNumber: f.rowNumber,
      blocking: true,
      message: `WEHAGO 매입매출장 ${f.rowNumber}행을 읽을 수 없어 대사하지 못했습니다: ${f.reason}`,
    });
  }
  const discrepancies = [...result.discrepancies, ...extra];
  const exportAllowed = result.exportAllowed && extra.length === 0;
  const matched = o.wehago ? wehagoMatched(result, extra, o.mode === 'file') : null;
  const line = stageLine(result.stages, o.mode);
  const summary =
    extra.length > 0 ? `${result.summary} WEHAGO 매입매출장에서 읽지 못한 행 ${extra.length}건이 있습니다.` : result.summary;

  const meta: ReconReportMeta = {
    mode: o.mode,
    scopeKind: o.scopeKind ?? null,
    exportJobIds: o.exportJobIds ?? [],
    excludedEvidenceTypes: scope.excludedEvidenceTypes,
    excludedByScope: loaded.meta.excludedByScope,
    excludedOtherKind: loaded.meta.excludedOtherKind,
    coreExportAllowed: result.exportAllowed,
    wehagoMatched: matched,
    stageLine: line,
    extraDiscrepancies: extra.length,
    wehago: o.wehago
      ? {
          fileId: o.wehago.fileId,
          fileName: o.wehago.fileName,
          rows: o.wehago.rows.length,
          failures: o.wehago.failures.length,
          outOfPeriod: o.wehago.outOfPeriod,
          excludedByScope: wehagoExcluded,
        }
      : null,
  };

  const report = { ...result, discrepancies, exportAllowed, summary, meta } as unknown as Record<string, unknown>;
  const [row] = await ctx.db
    .insert(reconciliationJobs)
    .values({
      clientId: o.clientId,
      period: o.period,
      exportJobId: o.exportJobId ?? null,
      phase: o.phase,
      balanced: result.balanced,
      exportAllowed,
      report,
      summary,
      createdBy: ctx.actor.userId,
      createdAt: sql`clock_timestamp()`,
    })
    .returning({ id: reconciliationJobs.id });

  const blocking = discrepancies.filter((d) => d.blocking).length;
  await writeAudit(ctx, {
    action: 'reconciliation.run',
    category: 'system',
    entityType: 'reconciliation_job',
    entityId: row!.id,
    clientId: o.clientId,
    summary: `${client.name} ${o.period} 대사(${o.phase === 'pre_export' ? (o.mode === 'file' ? '전송파일' : '전송 전') : 'WEHAGO 역수입'}${o.scopeKind ? ` · ${EXPORT_KIND_LABELS[o.scopeKind]}` : ''}): ${line} — ${exportAllowed ? '일치' : `차단 ${blocking}건`}`,
    before: null,
    after: { balanced: result.balanced, exportAllowed, blocking, mode: o.mode, exportJobId: o.exportJobId ?? null },
  });
  return { id: row!.id, result, discrepancies, exportAllowed, wehagoMatched: matched, meta };
}

// ────────────────────────────── 전송 후(역수입) 결과 반영 ──────────────────────────────

export interface PostExportOutcome {
  matched: boolean;
  transactionsReconciled: number;
  uploadInferred: boolean;
  templateVerified: boolean;
}

/**
 * WEHAGO 역수입 대사 결과 반영.
 * - 일치: 파일 거래 → reconciled, 업로드 확인 전이면 업로드 확인으로 기록(WEHAGO 장부가 증거), 서식 검증 기록, 알림 해소
 * - 불일치: recon_mismatch 알림 (설명 포함). 거래 상태는 되돌리지 않는다 (docs/03 §4.2)
 */
export async function applyPostExportOutcome(ctx: ServiceContext, rec: ExecutedRecon, input: { clientId: string; clientName: string; period: string; exportJobId: string | null }): Promise<PostExportOutcome> {
  const dedupeKey = `recon_mismatch:${input.clientId}:${input.period}`;
  const out: PostExportOutcome = { matched: rec.wehagoMatched === true, transactionsReconciled: 0, uploadInferred: false, templateVerified: false };
  if (!out.matched) {
    const mism = mismatchDiscrepancies(rec.discrepancies);
    if (mism.length > 0) {
      await notifyProblem(ctx, {
        kind: 'recon_mismatch',
        severity: 'high',
        title: `${input.clientName} ${input.period} WEHAGO 대사 불일치 ${mism.length}건`,
        body: mismatchBody(rec.discrepancies),
        href: reconciliationHref(rec.id),
        clientId: input.clientId,
        dedupeKey,
      });
    }
    return out;
  }
  await resolveProblem(ctx, dedupeKey);
  if (!input.exportJobId) return out;

  const [job] = await ctx.db.select().from(exportJobs).where(eq(exportJobs.id, input.exportJobId));
  if (!job) return out;
  if (job.status === 'downloaded') {
    await ctx.db
      .update(exportJobs)
      .set({ status: 'uploaded_confirmed', uploadConfirmedAt: ctx.now(), uploadConfirmedBy: ctx.actor.userId })
      .where(eq(exportJobs.id, job.id));
    out.uploadInferred = true;
    await writeAudit(ctx, {
      action: 'export.upload_inferred',
      category: 'data_change',
      entityType: 'export_job',
      entityId: job.id,
      clientId: input.clientId,
      summary: `${input.clientName} ${input.period} WEHAGO 매입매출장이 전송파일과 1원 단위까지 일치 → 업로드 완료로 기록`,
      before: { status: job.status },
      after: { status: 'uploaded_confirmed', evidence: 'wehago_ledger', reconciliationId: rec.id },
    });
  }
  const upd = await ctx.db
    .update(transactions)
    .set({ status: 'reconciled', updatedAt: ctx.now() })
    .where(and(eq(transactions.exportJobId, job.id), inArray(transactions.status, ['approved', 'auto_approved', 'exported'])))
    .returning({ id: transactions.id });
  out.transactionsReconciled = upd.length;
  if (upd.length > 0) {
    await writeAudit(ctx, {
      action: 'transaction.reconcile',
      category: 'data_change',
      entityType: 'export_job',
      entityId: job.id,
      clientId: input.clientId,
      summary: `${input.clientName} ${input.period} WEHAGO 반영 확인: 거래 ${upd.length}건 → 대사완료`,
      before: { status: 'exported' },
      after: { status: 'reconciled', count: upd.length, reconciliationId: rec.id },
    });
  }
  // 이 파일을 만든 서식이 현재 서식이고 아직 미검증이면: WEHAGO 장부 1원 일치 = 서식이 제대로 읽혔다는 증거
  const kind = job.kind as WehagoExportKind;
  if (kind === 'wehago_purchase_sales' || kind === 'wehago_general_journal') {
    const active = await loadActiveTemplate(ctx, kind);
    if (!active.template.verified && active.template.key === job.templateKey && active.template.version === job.templateVersion) {
      await recordTemplateVerification(ctx, active, 'wehago_reimport', job.id);
      out.templateVerified = true;
    }
  }
  return out;
}

/**
 * WEHAGO 역수입 대사의 기준 전송파일: 최신 업로드 확인 → 받은 파일 (대체되지 않은 매입매출).
 * 아무도 받지 않은(ready) 파일은 WEHAGO 에 있을 수 없으므로 기준이 아니다 (그때는 원본 ↔ WEHAGO 검증 대사).
 */
export async function latestTakenExport(ctx: Pick<ServiceContext, 'db'>, clientId: string, period: string, kind: WehagoExportKind = 'wehago_purchase_sales') {
  const rows = await ctx.db
    .select()
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.clientId, clientId),
        eq(exportJobs.period, period),
        eq(exportJobs.kind, kind),
        inArray(exportJobs.status, ['uploaded_confirmed', 'downloaded']),
        sql`${exportJobs.fileId} is not null`,
        sql`not (${exportJobs.validation} ? 'supersededBy')`,
      ),
    )
    .orderBy(desc(exportJobs.createdAt));
  const rank = (s: string) => (s === 'uploaded_confirmed' ? 0 : 1);
  return [...rows].sort((a, b) => rank(a.status) - rank(b.status) || b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

// ────────────────────────────── 공개 API ──────────────────────────────

export interface RunReconciliationInput {
  clientId: string;
  period: string;
  exportJobId?: string | null;
  phase: ReconPhase;
}

/**
 * 대사 실행 (화면의 [대사 실행]/[다시 대사]).
 * - pre_export: exportJobId 가 있으면 그 전송파일 기준(file), 없으면 전송 전(ready)
 * - post_export: 가장 최근에 올린 WEHAGO 매입매출장을 다시 읽어 비교. 일치하면 거래 → reconciled
 */
export async function runReconciliation(ctx: ServiceContext, input: RunReconciliationInput): Promise<ReconciliationDTO> {
  requirePermission(ctx, 'transactions.read');
  const clientId = assertUuid(input.clientId, 'clientId', '거래처');
  const period = assertPeriod(input.period);
  if (input.phase !== 'pre_export' && input.phase !== 'post_export') {
    throw new ValidationError('대사 단계는 pre_export 또는 post_export 여야 합니다.', [{ field: 'phase', message: 'pre_export | post_export' }]);
  }
  if (input.exportJobId && !isUuid(input.exportJobId)) throw new ValidationError('전송파일 식별자가 올바르지 않습니다.', [{ field: 'exportJobId', message: 'uuid' }]);
  const client = await loadClientProfile(ctx, clientId);

  const id = await ctx.db.transaction(async (tx) => {
    const tctx = withTx(ctx, tx);
    await lockClientPeriod(tctx, clientId, period);
    let job: typeof exportJobs.$inferSelect | null = null;
    if (input.exportJobId) {
      job = (await tx.select().from(exportJobs).where(eq(exportJobs.id, input.exportJobId)))[0] ?? null;
      if (!job || job.clientId !== clientId || job.period !== period) throw new NotFoundError('이 거래처·기간의 전송파일');
    }
    if (input.phase === 'pre_export') {
      const rec = job
        ? await executeReconciliation(tctx, { clientId, period, phase: 'pre_export', mode: 'file', exportJobIds: [job.id], exportJobId: job.id, scopeKind: job.kind as WehagoExportKind })
        : await executeReconciliation(tctx, { clientId, period, phase: 'pre_export', mode: 'ready' });
      return rec.id;
    }
    // post_export: 최근 역수입 파일
    const [prev] = await tx
      .select({ report: reconciliationJobs.report })
      .from(reconciliationJobs)
      .where(and(eq(reconciliationJobs.clientId, clientId), eq(reconciliationJobs.period, period), eq(reconciliationJobs.phase, 'post_export'), sql`${reconciliationJobs.report} -> 'meta' -> 'wehago' ->> 'fileId' is not null`))
      .orderBy(desc(reconciliationJobs.createdAt))
      .limit(1);
    const fileId = (prev?.report as { meta?: ReconReportMeta } | undefined)?.meta?.wehago?.fileId ?? null;
    if (!fileId) {
      throw new AppError({
        code: 'WEHAGO_LEDGER_REQUIRED',
        httpStatus: 422,
        userMessage: 'WEHAGO 역수입 대사를 하려면 먼저 WEHAGO 매입매출장 "엑셀 변환" 파일을 올려 주세요.',
        action: { label: '전송센터', href: transferHref(clientId, period) },
      });
    }
    const stored = await readStoredFile(tctx, fileId);
    const refs = await tx.select({ id: clients.id, businessNumber: clients.businessNumber, name: clients.name }).from(clients).where(eq(clients.active, true));
    const ledger = await parseWehagoLedger(stored.data, stored.row.originalName, { id: clientId, businessNumber: client.businessNumber }, period, refs);
    const target = job ?? (await latestTakenExport(tctx, clientId, period));
    const rec = await executeReconciliation(tctx, {
      clientId,
      period,
      phase: 'post_export',
      mode: target ? 'file' : 'verify',
      exportJobIds: target ? [target.id] : undefined,
      exportJobId: target?.id ?? null,
      scopeKind: 'wehago_purchase_sales',
      wehago: { rows: ledger.rows, fileId, fileName: stored.row.originalName, failures: ledger.failures, outOfPeriod: ledger.outOfPeriod },
    });
    await applyPostExportOutcome(tctx, rec, { clientId, clientName: client.name, period, exportJobId: target?.id ?? null });
    return rec.id;
  });
  return getReconciliationInternal(ctx, id);
}

// ────────────────────────────── 조회 ──────────────────────────────

type ReconRow = typeof reconciliationJobs.$inferSelect;

export function toReconciliationDTO(row: ReconRow, clientName: string, createdBy: string | null): ReconciliationDTO {
  const r = row.report as unknown as ReconcileResult & { meta?: ReconReportMeta };
  const meta = r.meta;
  const mode: ReconMode = meta?.mode ?? (r.equation?.exportBasis === 'file' ? 'file' : 'ready');
  const discrepancies = r.discrepancies ?? [];
  const t = (x: { count: number; supplyAmount: number; vatAmount: number; totalAmount: number } | undefined) => ({
    count: x?.count ?? 0,
    supplyAmount: x?.supplyAmount ?? 0,
    vatAmount: x?.vatAmount ?? 0,
    totalAmount: x?.totalAmount ?? 0,
  });
  const accountNames = r.accountNames ?? {};
  return {
    id: row.id,
    clientId: row.clientId,
    clientName,
    period: row.period,
    phase: row.phase,
    mode,
    scopeKind: meta?.scopeKind ?? null,
    exportJobId: row.exportJobId,
    balanced: row.balanced,
    exportAllowed: row.exportAllowed,
    wehagoMatched: meta?.wehagoMatched ?? null,
    summary: row.summary,
    stageLine: meta?.stageLine ?? stageLine(r.stages ?? {}, mode),
    stages: stageDTOs(r.stages ?? {}, mode),
    equation: {
      basis: r.equation?.exportBasis ?? 'ready',
      source: t(r.equation?.source),
      terms: {
        export: t(r.equation?.terms?.export),
        duplicate: t(r.equation?.terms?.duplicate),
        excluded: t(r.equation?.terms?.excluded),
        failed: t(r.equation?.terms?.failed),
        pending: t(r.equation?.terms?.pending),
      },
      residual: t(r.equation?.residual),
    },
    expected: t(r.expected),
    pendingReview: t(r.pendingReview),
    byEvidenceType: breakdownDTOs(r.byEvidenceType ?? {}, evidenceLabel),
    byAccount: breakdownDTOs(r.byAccount ?? {}, (k) => (accountNames[k] ? `${k} ${accountNames[k]}` : k)),
    discrepancies: discrepancyDTOs(discrepancies, row.clientId, row.period),
    blockingCount: discrepancies.filter((d) => d.blocking).length,
    explainedCount: discrepancies.filter((d) => !d.blocking).length,
    excludedEvidenceTypes: meta?.excludedEvidenceTypes ?? [],
    wehago: meta?.wehago ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy,
  };
}

async function getReconciliationInternal(ctx: ServiceContext, id: string): Promise<ReconciliationDTO> {
  const [row] = await ctx.db
    .select({ r: reconciliationJobs, clientName: clients.name, createdBy: users.name })
    .from(reconciliationJobs)
    .innerJoin(clients, eq(clients.id, reconciliationJobs.clientId))
    .leftJoin(users, eq(users.id, reconciliationJobs.createdBy))
    .where(eq(reconciliationJobs.id, id));
  if (!row) throw new NotFoundError('대사 결과');
  return toReconciliationDTO(row.r, row.clientName, row.createdBy ?? (row.r.createdBy ? null : 'MIN TAX OPS 시스템'));
}

export async function getReconciliation(ctx: ServiceContext, id: string): Promise<ReconciliationDTO> {
  requirePermission(ctx, 'transactions.read');
  if (!isUuid(id)) throw new NotFoundError('대사 결과');
  return getReconciliationInternal(ctx, id);
}

export async function listReconciliations(
  ctx: ServiceContext,
  input: { clientId?: string; period?: string; phase?: ReconPhase; exportJobId?: string; limit?: number } = {},
): Promise<ReconciliationListItemDTO[]> {
  requirePermission(ctx, 'transactions.read');
  const conds = [];
  if (input.clientId) conds.push(eq(reconciliationJobs.clientId, assertUuid(input.clientId, 'clientId', '거래처')));
  if (input.period) conds.push(eq(reconciliationJobs.period, assertPeriod(input.period)));
  if (input.phase) conds.push(eq(reconciliationJobs.phase, input.phase));
  if (input.exportJobId) conds.push(eq(reconciliationJobs.exportJobId, assertUuid(input.exportJobId, 'exportJobId', '전송파일')));
  const limit = Math.min(Math.max(1, input.limit ?? 50), 500);
  const rows = await ctx.db
    .select({
      id: reconciliationJobs.id,
      clientId: reconciliationJobs.clientId,
      clientName: clients.name,
      period: reconciliationJobs.period,
      phase: reconciliationJobs.phase,
      exportJobId: reconciliationJobs.exportJobId,
      balanced: reconciliationJobs.balanced,
      exportAllowed: reconciliationJobs.exportAllowed,
      summary: reconciliationJobs.summary,
      mode: sql<string | null>`${reconciliationJobs.report} -> 'meta' ->> 'mode'`,
      stageLine: sql<string | null>`${reconciliationJobs.report} -> 'meta' ->> 'stageLine'`,
      blockingCount: sql<number>`(select count(*)::int from jsonb_array_elements(coalesce(${reconciliationJobs.report} -> 'discrepancies', '[]'::jsonb)) d where (d ->> 'blocking')::boolean)`,
      createdAt: reconciliationJobs.createdAt,
    })
    .from(reconciliationJobs)
    .innerJoin(clients, eq(clients.id, reconciliationJobs.clientId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(reconciliationJobs.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    period: r.period,
    phase: r.phase,
    mode: (r.mode ?? 'ready') as ReconMode,
    exportJobId: r.exportJobId,
    balanced: r.balanced,
    exportAllowed: r.exportAllowed,
    blockingCount: Number(r.blockingCount),
    summary: r.summary,
    stageLine: r.stageLine ?? '',
    createdAt: r.createdAt.toISOString(),
  }));
}

export { lockClientPeriod };
