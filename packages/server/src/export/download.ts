/**
 * 전송파일 받기 · WEHAGO 업로드 완료 확인.
 *
 * WEHAGO 전표 API 가 없으므로(FILE_BASED) "업로드 완료"는 직원이 WEHAGO 에 올렸다고 확인한 기록일 뿐이다.
 * 실제 반영 여부는 WEHAGO 매입매출장 역수입 대사(importWehagoLedger)로 확인한다.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { formatWon } from '@mintax/core';
import { exportJobs, transactions } from '@mintax/db';
import { AppError, ConflictError, ValidationError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { notifyProblem } from '../infra/notify';
import { readStoredFile } from '../infra/storage';
import { lockClientPeriod } from '../reconciliation/run';
import { loadExportJob, toExportJobDTO, validationOf, type ExportJobRow } from './dto';
import { APPROVED_STATUSES, EXPORT_KIND_LABELS, XLSX_MIME, exportHref, transferHref } from './helpers';
import type { ConfirmUploadResult, DownloadExportResult, WehagoExportKind } from './types';

const TAKEN = new Set(['ready', 'downloaded', 'uploaded_confirmed']);

/** 파일에 든 거래가 그 뒤에 바뀌었는지 (상태·금액·계정·연결 전송파일) — 한 번의 집계 쿼리 */
export async function exportStaleness(ctx: Pick<ServiceContext, 'db'>, job: Pick<ExportJobRow, 'id' | 'clientId' | 'period' | 'kind' | 'createdAt'>): Promise<{ changed: number; missing: number; newApproved: number }> {
  const approved = sql.join([...APPROVED_STATUSES].map((s) => sql`${s}`), sql`, `);
  const r = await ctx.db.execute<{ changed: number; missing: number; new_approved: number }>(sql`
    select
      (select count(*)::int from export_items ei join transactions t on t.id = ei.transaction_id
        where ei.export_job_id = ${job.id}
          and (t.status not in (${approved})
               or t.supply_amount <> ei.supply_amount or t.vat_amount <> ei.vat_amount or t.total_amount <> ei.total_amount
               or (ei.account_code is not null and t.account_code is distinct from ei.account_code)
               or t.export_job_id is distinct from ei.export_job_id)) as changed,
      (select count(*)::int from export_items ei left join transactions t on t.id = ei.transaction_id
        where ei.export_job_id = ${job.id} and t.id is null) as missing,
      (select count(*)::int from transactions t
        where t.client_id = ${job.clientId} and t.period = ${job.period} and t.status in (${approved})
          and t.export_job_id is null and (t.created_at > ${job.createdAt} or t.reviewed_at > ${job.createdAt})) as new_approved
  `);
  const row = r.rows[0] ?? { changed: 0, missing: 0, new_approved: 0 };
  return { changed: Number(row.changed), missing: Number(row.missing), newApproved: Number(row.new_approved) };
}

function supersededError(job: ExportJobRow): AppError {
  const next = validationOf(job).supersededBy!;
  return new AppError({
    code: 'EXPORT_SUPERSEDED',
    httpStatus: 409,
    userMessage: '새 버전으로 대체된 전송파일입니다. 최신 버전 파일을 받으세요.',
    action: { label: '최신 전송파일', href: exportHref(next) },
  });
}

function staleError(job: ExportJobRow, n: number): AppError {
  return new AppError({
    code: 'EXPORT_STALE',
    httpStatus: 409,
    userMessage: `이 파일에 든 거래 ${n}건이 파일 생성 뒤 변경되었습니다. 파일을 다시 만드세요 — 바뀐 거래가 든 파일은 WEHAGO에 올리면 안 됩니다.`,
    action: { label: '전송파일 다시 만들기', href: transferHref(job.clientId, job.period) },
  });
}

/**
 * 전송파일 받기 — 다운로드 감사(category 'download'), 처음 받으면 status 'downloaded'.
 * 대체된 버전·차단된 파일·파일 생성 뒤 거래가 바뀐 파일은 받을 수 없다.
 */
export async function downloadExport(ctx: ServiceContext, exportJobId: string): Promise<DownloadExportResult> {
  requirePermission(ctx, 'export.download');
  const { row: job, client, createdBy } = await loadExportJob(ctx, exportJobId);
  const v = validationOf(job);
  if (job.status === 'blocked' || !job.fileId) {
    throw new AppError({
      code: 'EXPORT_BLOCKED',
      httpStatus: 409,
      userMessage: v.supersededBy
        ? '새 버전으로 대체된 전송파일입니다. 최신 버전 파일을 받으세요.'
        : `차단된 전송파일은 받을 수 없습니다: ${job.blockedReason ?? '사전검증 실패'}`,
      action: v.supersededBy ? { label: '최신 전송파일', href: exportHref(v.supersededBy) } : { label: '전송센터', href: transferHref(job.clientId, job.period) },
    });
  }
  if (!TAKEN.has(job.status)) throw new ConflictError(`아직 준비되지 않은 파일입니다 (상태: ${job.status}). 잠시 후 다시 시도하세요.`);
  if (v.supersededBy) throw supersededError(job);

  const stale = await exportStaleness(ctx, job);
  if (stale.changed + stale.missing > 0) {
    if (job.status === 'ready') {
      await ctx.db.update(exportJobs).set({ status: 'blocked', blockedReason: '포함 거래가 변경되었습니다. 파일을 다시 만드세요' }).where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, 'ready')));
      await writeAudit(ctx, {
        action: 'export.block',
        category: 'system',
        entityType: 'export_job',
        entityId: job.id,
        clientId: job.clientId,
        summary: `${client.name} ${job.period} ${EXPORT_KIND_LABELS[job.kind as WehagoExportKind] ?? job.kind} 전송파일 차단: 포함 거래 ${stale.changed + stale.missing}건 변경`,
        before: { status: 'ready' },
        after: { status: 'blocked', changed: stale.changed, missing: stale.missing },
      });
      await notifyProblem(ctx, {
        kind: 'export_error',
        severity: 'warning',
        title: `${client.name} ${job.period} WEHAGO 전송파일을 다시 만들어야 합니다`,
        body: `파일 생성 뒤 포함 거래 ${stale.changed + stale.missing}건이 변경되어 받기 전에 차단했습니다.`,
        href: transferHref(job.clientId, job.period),
        clientId: job.clientId,
        dedupeKey: `export_blocked:${job.clientId}:${job.period}:${job.kind}`,
      });
    }
    throw staleError(job, stale.changed + stale.missing);
  }

  const { data, row: file } = await readStoredFile(ctx, job.fileId);
  if (v.fileSha256 && v.fileSha256 !== file.sha256) {
    throw new AppError({ code: 'EXPORT_FILE_MISMATCH', httpStatus: 409, userMessage: '저장된 전송파일이 생성 당시와 다릅니다. 파일을 다시 만드세요.', action: { label: '전송센터', href: transferHref(job.clientId, job.period) } });
  }
  const warnings = [...(v.warnings ?? [])];
  if (stale.newApproved > 0) warnings.push(`이 파일을 만든 뒤 승인된 거래 ${stale.newApproved}건은 파일에 없습니다 — 기간 전체를 담은 새 버전을 만드세요.`);
  if (v.template && !v.template.verified) {
    warnings.push('WEHAGO 실서식으로 확인되지 않은 파일입니다. WEHAGO 열 매칭 화면에서 공급가액·부가세 열을 확인하고 올리세요. 올린 뒤에는 역수입 대사가 필요합니다.');
  }

  const now = ctx.now();
  const firstDownload = job.status === 'ready';
  await ctx.db
    .update(exportJobs)
    .set({ status: firstDownload ? 'downloaded' : job.status, downloadedAt: job.downloadedAt ?? now })
    .where(eq(exportJobs.id, job.id));
  const fileName = v.fileName ?? file.originalName;
  await writeAudit(ctx, {
    action: 'export.download',
    category: 'download',
    entityType: 'export_job',
    entityId: job.id,
    clientId: job.clientId,
    summary: `${client.name} ${job.period} ${EXPORT_KIND_LABELS[job.kind as WehagoExportKind] ?? job.kind} v${v.version ?? '?'} 전송파일 다운로드 (${job.rowCount}건 · 합계 ${formatWon(job.totalAmount)})`,
    before: { status: job.status },
    after: { status: firstDownload ? 'downloaded' : job.status, fileName, sha256: file.sha256, sizeBytes: data.length },
  });
  const [updated] = await ctx.db.select().from(exportJobs).where(eq(exportJobs.id, job.id));
  return {
    fileName,
    mimeType: XLSX_MIME,
    data,
    sizeBytes: data.length,
    sha256: file.sha256,
    warnings,
    exportJob: toExportJobDTO(updated!, client, createdBy),
  };
}

/**
 * 직원이 WEHAGO 에 파일을 올렸다고 확인 (WEHAGO 전표 API 없음 → 기록만 한다).
 * 포함 거래 → exported. 같은 기간 이전 버전을 이미 올렸다면 "WEHAGO 에서 이전 전표를 지웠다"는 확인이 필요하다.
 */
export async function confirmWehagoUpload(ctx: ServiceContext, exportJobId: string, opts: { previousVersionDeleted?: boolean } = {}): Promise<ConfirmUploadResult> {
  requirePermission(ctx, 'export.create');
  const loaded = await loadExportJob(ctx, exportJobId);
  const { client, createdBy } = loaded;
  const note =
    'WEHAGO 전표 API가 없어 MIN TAX OPS가 업로드를 직접 확인할 수 없습니다. 이 확인은 직원이 WEHAGO [엑셀서식 불러오기]로 올렸다는 기록이며, 실제 반영 여부는 WEHAGO 매입매출장 역수입 대사로 확인합니다.';
  const nextStep = 'WEHAGO 매입매출장 화면에서 "엑셀 변환"한 파일을 올려 반영 결과를 대사하세요.';

  return ctx.db.transaction(async (tx) => {
    const tctx = withTx(ctx, tx);
    await lockClientPeriod(tctx, loaded.row.clientId, loaded.row.period);
    const [job] = await tx.select().from(exportJobs).where(eq(exportJobs.id, loaded.row.id));
    if (!job) throw new ConflictError('전송파일이 삭제되었습니다. 화면을 새로고침하세요.');
    const v = validationOf(job);
    if (job.status === 'uploaded_confirmed') {
      return { exportJob: toExportJobDTO(job, client, createdBy), alreadyConfirmed: true, transactionsExported: 0, integrationStatus: 'FILE_BASED', note, nextStep };
    }
    if (v.supersededBy) throw supersededError(job);
    if (job.status === 'ready') {
      throw new AppError({
        code: 'EXPORT_NOT_DOWNLOADED',
        httpStatus: 409,
        userMessage: '아직 파일을 받지 않았습니다. 파일을 받아 WEHAGO에 올린 뒤 업로드 완료를 확인하세요.',
        action: { label: '업로드 파일 받기', href: exportHref(job.id) },
      });
    }
    if (job.status !== 'downloaded') {
      throw new ConflictError(`업로드 완료를 확인할 수 없는 상태입니다 (${job.status}). 전송센터에서 파일 상태를 확인하세요.`);
    }
    if (v.template?.status === 'mock') {
      throw new AppError({ code: 'EXPORT_MOCK_TEMPLATE', httpStatus: 409, userMessage: '개발용(MOCK) 서식 파일은 WEHAGO에 올리면 안 되므로 업로드 완료를 확인할 수 없습니다.' });
    }
    const stale = await exportStaleness(tctx, job);
    if (stale.changed + stale.missing > 0) throw staleError(job, stale.changed + stale.missing);

    const previous = await tx
      .select()
      .from(exportJobs)
      .where(and(eq(exportJobs.clientId, job.clientId), eq(exportJobs.period, job.period), eq(exportJobs.kind, job.kind), ne(exportJobs.id, job.id), eq(exportJobs.status, 'uploaded_confirmed')));
    const prevUnreplaced = previous.filter((p) => !validationOf(p).replacedInWehagoBy);
    if (prevUnreplaced.length > 0 && opts.previousVersionDeleted !== true) {
      const desc = prevUnreplaced.map((p) => `v${validationOf(p).version ?? '?'} 전표(행 ${p.rowCount} · 합계 ${formatWon(p.totalAmount)})`).join(', ');
      throw new ValidationError(`WEHAGO에서 ${desc}를 삭제했는지 확인하세요 — 이전 전표를 지우지 않고 새 파일을 올리면 이중 기장됩니다.`, [
        { field: 'previousVersionDeleted', message: '이전 버전 전표 삭제 확인 필요' },
      ]);
    }

    const now = ctx.now();
    await tx.update(exportJobs).set({ status: 'uploaded_confirmed', uploadConfirmedAt: now, uploadConfirmedBy: ctx.actor.userId }).where(eq(exportJobs.id, job.id));
    for (const p of prevUnreplaced) {
      await tx
        .update(exportJobs)
        .set({ validation: sql`${exportJobs.validation} || ${JSON.stringify({ replacedInWehagoBy: job.id, previousVersionDeleted: { confirmedBy: ctx.actor.name, confirmedAt: now.toISOString(), versions: [job.id] } })}::jsonb` })
        .where(eq(exportJobs.id, p.id));
    }
    const upd = await tx
      .update(transactions)
      .set({ status: 'exported', updatedAt: now })
      .where(and(eq(transactions.exportJobId, job.id), inArray(transactions.status, ['approved', 'auto_approved', 'exported', 'reconciled'])))
      .returning({ id: transactions.id });
    await writeAudit(tctx, {
      action: 'export.confirm_upload',
      category: 'data_change',
      entityType: 'export_job',
      entityId: job.id,
      clientId: job.clientId,
      summary: `${client.name} ${job.period} ${EXPORT_KIND_LABELS[job.kind as WehagoExportKind] ?? job.kind} v${v.version ?? '?'} WEHAGO 업로드 완료 확인 (직원 확인 · ${job.rowCount}건 · 합계 ${formatWon(job.totalAmount)}) → 거래 ${upd.length}건 전송완료`,
      before: { status: job.status, previousVersions: prevUnreplaced.map((p) => ({ id: p.id, version: validationOf(p).version ?? null, rowCount: p.rowCount, totalAmount: p.totalAmount })) },
      after: { status: 'uploaded_confirmed', transactionsExported: upd.length, previousVersionDeleted: prevUnreplaced.length > 0 ? true : null, integrationStatus: 'FILE_BASED' },
    });
    const [updated] = await tx.select().from(exportJobs).where(eq(exportJobs.id, job.id));
    return { exportJob: toExportJobDTO(updated!, client, createdBy), alreadyConfirmed: false, transactionsExported: upd.length, integrationStatus: 'FILE_BASED', note, nextStep };
  });
}

