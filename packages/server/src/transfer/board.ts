/**
 * WEHAGO 전송센터 (/transfer) — 수임처별 파이프라인 단계 · 전송파일 · 대사 상태 · 다음 행동.
 * 집계는 SQL 로 한 번에 (수임처 수와 무관하게 쿼리 6개), 단계 판정은 stage.ts 순수 함수.
 */
import { sql } from 'drizzle-orm';
import { findIntegration } from '@mintax/adapters';
import type { IntegrationStatus } from '@mintax/core';
import type { Database } from '@mintax/db';
import { ValidationError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { getCurrentPeriod } from '../infra/settings';
import { enqueueJob } from '../jobs/queue';
import { APPROVED_STATUSES, EXPORT_KIND_LABELS, EXPORT_STATUS_LABELS, WEHAGO_FILE_NOTE, assertPeriod, assertUuid, isUuid, parseExportScope } from '../export/helpers';
import type { WehagoExportKind } from '../export/types';
import { STAGE_LABELS_KO, TRANSFER_STAGES, computeTransferStage, type ExportFact, type NextAction, type ReconFact, type ReconStatus, type StageFacts, type TransferBlocker, type TransferStage } from './stage';

export interface TransferExportDTO {
  id: string;
  kind: string;
  kindLabel: string;
  version: number | null;
  status: string;
  statusLabel: string;
  rowCount: number;
  totalAmount: number;
  templateVerified: boolean | null;
  createdAt: string;
  downloadedAt: string | null;
  uploadConfirmedAt: string | null;
}

export interface TransferRowDTO {
  clientId: string;
  code: string;
  name: string;
  assigneeName: string | null;
  stage: TransferStage;
  stageLabel: string;
  /** 0(자료 없음) ~ 7(대사완료) — 진행 표시용 */
  stageIndex: number;
  txCount: number;
  unclassified: number;
  pending: number;
  approved: number;
  failedRows: number;
  /** 가장 최근 전송 시도 (차단 포함) */
  lastExport: TransferExportDTO | null;
  /** 종류별 현재 유효한 전송파일 */
  exports: TransferExportDTO[];
  reconStatus: ReconStatus;
  reconciliationId: string | null;
  reconMismatch: number;
  blockers: TransferBlocker[];
  nextAction: NextAction;
  eligibleForPrepare: boolean;
}

export interface TransferBoardDTO {
  period: string;
  generatedAt: string;
  notice: string;
  integration: Array<{ key: string; name: string; status: IntegrationStatus; statusReason: string }>;
  stages: Array<{ stage: TransferStage; label: string; clients: number }>;
  totals: { clients: number; eligibleForPrepare: number; blocked: number; reconMismatch: number };
  rows: TransferRowDTO[];
}

const KINDS: readonly WehagoExportKind[] = ['wehago_purchase_sales', 'wehago_general_journal'];
const VALID_STATUSES = new Set(['ready', 'downloaded', 'uploaded_confirmed']);

function exportDTO(e: ExportFact): TransferExportDTO {
  return {
    id: e.id,
    kind: e.kind,
    kindLabel: EXPORT_KIND_LABELS[e.kind as WehagoExportKind] ?? e.kind,
    version: e.version,
    status: e.status,
    statusLabel: EXPORT_STATUS_LABELS[e.status] ?? e.status,
    rowCount: e.rowCount,
    totalAmount: e.totalAmount,
    templateVerified: e.templateVerified,
    createdAt: e.createdAt.toISOString(),
    downloadedAt: e.downloadedAt ? e.downloadedAt.toISOString() : null,
    uploadConfirmedAt: e.uploadConfirmedAt ? e.uploadConfirmedAt.toISOString() : null,
  };
}

interface BoardFilter {
  period: string;
  clientIds?: string[];
  assigneeId?: string;
}

const uuidArr = (ids: readonly string[]) => sql`${sql.param([...ids])}::uuid[]`;

/** 전송센터 행 계산 (권한 검사 없음 — 내부용) */
export async function computeTransferRows(db: Database, f: BoardFilter): Promise<TransferRowDTO[]> {
  const conds = [sql`c.active = true`];
  if (f.clientIds && f.clientIds.length > 0) conds.push(sql`c.id = any(${uuidArr(f.clientIds)})`);
  if (f.assigneeId) conds.push(sql`c.assignee_id = ${f.assigneeId}`);
  const cRes = await db.execute<{ id: string; code: string; name: string; assignee_name: string | null; rule_params: Record<string, unknown> | null }>(sql`
    select c.id, c.code, c.name, u.name as assignee_name, p.rule_params
    from clients c
    left join users u on u.id = c.assignee_id
    left join client_business_profiles p on p.client_id = c.id
    where ${sql.join(conds, sql` and `)}
    order by c.name, c.id
  `);
  const clientRows = cRes.rows;
  if (clientRows.length === 0) return [];
  const ids = clientRows.map((c) => c.id);
  const p = f.period;
  const approved = sql.join([...APPROVED_STATUSES].map((s) => sql`${s}`), sql`, `);

  const [txRes, impRes, failRes, expRes, recRes] = await Promise.all([
    db.execute<{ client_id: string; evidence_type: string; tx_count: number; unclassified: number; pending: number; approved: number; human_reviewed: number; stale: number }>(sql`
      select t.client_id, t.evidence_type,
        count(*) filter (where t.status not in ('duplicate', 'excluded', 'failed'))::int as tx_count,
        count(*) filter (where t.status = 'imported')::int as unclassified,
        count(*) filter (where t.status in ('classified', 'needs_review'))::int as pending,
        count(*) filter (where t.status in (${approved}))::int as approved,
        count(*) filter (where t.status in (${approved}) and t.reviewed_by is not null)::int as human_reviewed,
        count(*) filter (where t.status in (${approved}) and (e.id is null or e.file_id is null
            or e.status not in ('ready', 'downloaded', 'uploaded_confirmed') or (e.validation ? 'supersededBy')))::int as stale
      from transactions t
      left join export_jobs e on e.id = t.export_job_id
      where t.period = ${p} and t.client_id = any(${uuidArr(ids)})
      group by t.client_id, t.evidence_type
    `),
    db.execute<{ client_id: string; n: number }>(sql`
      select client_id, count(*)::int as n from import_jobs
      where period = ${p} and status in ('succeeded', 'partial') and client_id = any(${uuidArr(ids)})
      group by client_id
    `),
    db.execute<{ client_id: string; n: number }>(sql`
      select ij.client_id, count(*)::int as n
      from transaction_sources ts join import_jobs ij on ij.id = ts.import_job_id
      where ts.outcome = 'failed' and ts.transaction_id is null and ij.client_id = any(${uuidArr(ids)})
        and (ij.period = ${p} or (ij.period is null and exists (select 1 from transactions t2 where t2.import_job_id = ij.id and t2.period = ${p})))
      group by ij.client_id
    `),
    db.execute<{
      id: string; client_id: string; kind: string; status: string; created_at: Date; version: number | null; template_verified: boolean | null;
      row_count: number; total_amount: number; blocked_reason: string | null; has_file: boolean; superseded: boolean; downloaded_at: Date | null; upload_confirmed_at: Date | null;
    }>(sql`
      select id, client_id, kind, status, created_at, (validation ->> 'version')::int as version,
        (validation -> 'template' ->> 'verified')::boolean as template_verified,
        row_count, total_amount, blocked_reason, (file_id is not null) as has_file, (validation ? 'supersededBy') as superseded,
        downloaded_at, upload_confirmed_at
      from export_jobs
      where period = ${p} and client_id = any(${uuidArr(ids)}) and kind in (${sql.join(KINDS.map((k) => sql`${k}`), sql`, `)})
      order by created_at desc
    `),
    db.execute<{ id: string; client_id: string; phase: 'pre_export' | 'post_export'; export_allowed: boolean; created_at: Date; export_job_id: string | null; mismatch: number }>(sql`
      select r.id, r.client_id, r.phase, r.export_allowed, r.created_at, r.export_job_id,
        (select count(*)::int from jsonb_array_elements(coalesce(rj.report -> 'discrepancies', '[]'::jsonb)) d
          where (d ->> 'blocking')::boolean and d ->> 'kind' <> 'pending_review') as mismatch
      from (
        select distinct on (client_id, phase) id, client_id, phase, export_allowed, created_at, export_job_id
        from reconciliation_jobs
        where period = ${p} and client_id = any(${uuidArr(ids)})
        order by client_id, phase, created_at desc
      ) r join reconciliation_jobs rj on rj.id = r.id
    `),
  ]);

  const scopeOf = new Map(clientRows.map((c) => [c.id, new Set(parseExportScope(c.rule_params).excludedEvidenceTypes)] as const));
  const agg = new Map<string, { txCount: number; unclassified: number; pending: number; approved: number; humanReviewed: number; stale: number }>();
  for (const r of txRes.rows) {
    let a = agg.get(r.client_id);
    if (!a) agg.set(r.client_id, (a = { txCount: 0, unclassified: 0, pending: 0, approved: 0, humanReviewed: 0, stale: 0 }));
    a.txCount += Number(r.tx_count);
    a.unclassified += Number(r.unclassified);
    a.pending += Number(r.pending);
    a.approved += Number(r.approved);
    a.humanReviewed += Number(r.human_reviewed);
    // 전송 범위가 "WEHAGO 수집"인 원천은 파일로 보내지 않으므로 전송 대상 미포함으로 세지 않는다
    if (!scopeOf.get(r.client_id)?.has(r.evidence_type)) a.stale += Number(r.stale);
  }
  const imports = new Map(impRes.rows.map((r) => [r.client_id, Number(r.n)] as const));
  const failed = new Map(failRes.rows.map((r) => [r.client_id, Number(r.n)] as const));
  const exportsBy = new Map<string, ExportFact[]>();
  for (const r of expRes.rows) {
    const list = exportsBy.get(r.client_id) ?? exportsBy.set(r.client_id, []).get(r.client_id)!;
    list.push({
      id: r.id,
      kind: r.kind,
      status: r.status,
      createdAt: new Date(r.created_at),
      version: r.version === null ? null : Number(r.version),
      templateVerified: r.template_verified,
      rowCount: Number(r.row_count),
      totalAmount: Number(r.total_amount),
      blockedReason: r.blocked_reason,
      hasFile: r.has_file,
      superseded: r.superseded,
      downloadedAt: r.downloaded_at ? new Date(r.downloaded_at) : null,
      uploadConfirmedAt: r.upload_confirmed_at ? new Date(r.upload_confirmed_at) : null,
    });
  }
  const reconsBy = new Map<string, ReconFact[]>();
  for (const r of recRes.rows) {
    const list = reconsBy.get(r.client_id) ?? reconsBy.set(r.client_id, []).get(r.client_id)!;
    list.push({ id: r.id, phase: r.phase, exportAllowed: r.export_allowed, createdAt: new Date(r.created_at), mismatch: Number(r.mismatch), exportJobId: r.export_job_id });
  }

  return clientRows.map((c) => {
    const a = agg.get(c.id) ?? { txCount: 0, unclassified: 0, pending: 0, approved: 0, humanReviewed: 0, stale: 0 };
    const exps = exportsBy.get(c.id) ?? []; // created_at desc
    const latestAttempts: ExportFact[] = [];
    const validExports: ExportFact[] = [];
    for (const k of KINDS) {
      const ofKind = exps.filter((e) => e.kind === k);
      if (ofKind[0]) latestAttempts.push(ofKind[0]);
      const valid = ofKind.find((e) => e.hasFile && VALID_STATUSES.has(e.status) && !e.superseded);
      if (valid) validExports.push(valid);
    }
    const recons = reconsBy.get(c.id) ?? [];
    const latestRecon = [...recons].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0] ?? null;
    const latestPostRecon = recons.find((r) => r.phase === 'post_export') ?? null;
    const facts: StageFacts = {
      clientId: c.id,
      period: p,
      txCount: a.txCount,
      imports: imports.get(c.id) ?? 0,
      unclassified: a.unclassified,
      pending: a.pending,
      approved: a.approved,
      humanReviewed: a.humanReviewed,
      stale: a.stale,
      failedRows: failed.get(c.id) ?? 0,
      latestAttempts,
      validExports,
      latestRecon,
      latestPostRecon,
    };
    const s = computeTransferStage(facts);
    const last = exps[0] ?? null;
    return {
      clientId: c.id,
      code: c.code,
      name: c.name,
      assigneeName: c.assignee_name,
      stage: s.stage,
      stageLabel: STAGE_LABELS_KO[s.stage],
      stageIndex: TRANSFER_STAGES.indexOf(s.stage),
      txCount: a.txCount,
      unclassified: a.unclassified,
      pending: a.pending,
      approved: a.approved,
      failedRows: facts.failedRows,
      lastExport: last ? exportDTO(last) : null,
      exports: validExports.map(exportDTO),
      reconStatus: s.reconStatus,
      reconciliationId: latestRecon?.id ?? null,
      reconMismatch: latestRecon?.mismatch ?? 0,
      blockers: s.blockers,
      nextAction: s.nextAction,
      eligibleForPrepare: s.eligibleForPrepare,
    };
  });
}

function integrationInfo(): TransferBoardDTO['integration'] {
  return ['wehago.voucher_api', 'wehago.purchase_sales_file', 'wehago.general_journal_file', 'wehago.ledger_reimport']
    .map((k) => findIntegration(k))
    .filter((d): d is NonNullable<typeof d> => !!d)
    .map((d) => ({ key: d.key, name: d.name, status: d.status, statusReason: d.statusReason }));
}

/** WEHAGO 전송센터 보드 */
export async function getTransferBoard(ctx: ServiceContext, input: { period?: string; clientIds?: string[]; assigneeId?: string } = {}): Promise<TransferBoardDTO> {
  requirePermission(ctx, 'export.create');
  const period = input.period ? assertPeriod(input.period) : await getCurrentPeriod(ctx);
  if (input.assigneeId) assertUuid(input.assigneeId, 'assigneeId', '담당자');
  const rows = await computeTransferRows(ctx.db, { period, clientIds: input.clientIds?.filter(isUuid), assigneeId: input.assigneeId });
  const stages = TRANSFER_STAGES.map((stage) => ({ stage, label: STAGE_LABELS_KO[stage], clients: rows.filter((r) => r.stage === stage).length }));
  return {
    period,
    generatedAt: ctx.now().toISOString(),
    notice: `${WEHAGO_FILE_NOTE} 올린 뒤 [업로드 완료 확인]을 누르고, WEHAGO 매입매출장 "엑셀 변환" 파일로 반영 결과를 대사합니다.`,
    integration: integrationInfo(),
    stages,
    totals: {
      clients: rows.length,
      eligibleForPrepare: rows.filter((r) => r.eligibleForPrepare).length,
      blocked: rows.filter((r) => r.blockers.some((b) => b.code === 'export_blocked')).length,
      reconMismatch: rows.filter((r) => r.reconStatus === 'mismatch').length,
    },
    rows,
  };
}

export interface TransferBatchRequestResult {
  jobId: string | null;
  period: string;
  clientCount: number;
  clientIds: string[];
  skipped: Array<{ clientId: string; name: string; stage: TransferStage; reason: string }>;
  message: string;
}

/**
 * 일괄 "전송 준비" — 검토가 끝난(자동분개완료·검토완료) 수임처 전체(또는 지정 수임처)의 전송파일을 작업으로 만든다.
 * 작업 결과: "4개 거래처 전송파일 생성 완료 / 1곳 차단: 사유"
 */
export async function prepareTransferBatch(ctx: ServiceContext, input: { period?: string; clientIds?: string[]; kind?: WehagoExportKind } = {}): Promise<TransferBatchRequestResult> {
  requirePermission(ctx, 'export.create');
  const period = input.period ? assertPeriod(input.period) : await getCurrentPeriod(ctx);
  const requested = input.clientIds?.filter(isUuid);
  if (input.clientIds && input.clientIds.length > 0 && (!requested || requested.length === 0)) {
    throw new ValidationError('거래처 식별자가 올바르지 않습니다.', [{ field: 'clientIds', message: 'uuid' }]);
  }
  const rows = await computeTransferRows(ctx.db, { period, clientIds: requested });
  const eligible = rows.filter((r) => r.eligibleForPrepare);
  const skipped = requested
    ? rows
        .filter((r) => !r.eligibleForPrepare)
        .map((r) => ({ clientId: r.clientId, name: r.name, stage: r.stage, reason: r.blockers[0]?.message ?? `${r.stageLabel} 단계 — 전송 준비 대상이 아닙니다` }))
    : [];
  if (eligible.length === 0) {
    return { jobId: null, period, clientCount: 0, clientIds: [], skipped, message: `${period} 전송 준비할 거래처가 없습니다 (검토가 끝난 거래처만 대상).` };
  }
  const ids = eligible.map((r) => r.clientId);
  const jobId = await enqueueJob(ctx.db, 'export_wehago', { period, clientIds: ids, ...(input.kind ? { kind: input.kind } : {}), requestedBy: ctx.actor.userId }, { createdBy: ctx.actor.userId, maxAttempts: 1 });
  await writeAudit(ctx, {
    action: 'export.batch_request',
    category: 'data_change',
    entityType: 'job',
    entityId: jobId,
    summary: `${period} WEHAGO 전송 준비 일괄 요청: ${ids.length}곳${skipped.length ? ` (제외 ${skipped.length}곳)` : ''}`,
    before: null,
    after: { jobId, period, clientIds: ids, skipped: skipped.map((s) => s.clientId) },
  });
  return { jobId, period, clientCount: ids.length, clientIds: ids, skipped, message: `${ids.length}개 거래처 전송파일 생성을 시작했습니다.` };
}
