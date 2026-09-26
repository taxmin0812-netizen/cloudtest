/**
 * 감사로그 되돌리기 (Ctrl+Z · 감사로그 화면) — 거래 승인·수정·제외와 그 묶음(일괄) 작업.
 *
 * - 권한 audit.revert. 원 로그에 reverted_by_id, 새 로그에 revert_of_id.
 * - 되돌리기 전에 거래가 "그 작업 직후 상태" 그대로인지 확인한다. 그 뒤에 다른 변경이 있으면 거부 (최근 것부터 되돌리기).
 * - 전송 후 변경 규칙 (docs/03 §4.2): 이미 받은(downloaded·uploaded_confirmed) 전송파일에 포함된 거래는 되돌리지 않는다.
 *   받기 전(ready) 파일이면 되돌리고 그 파일을 차단한다.
 * - 수정 되돌리기는 그 수정으로 생긴 학습 기록(classification_corrections)을 지운다 — 되돌린 실수로 엔진이 배우지 않게.
 *   지운 기록 전체는 되돌리기 감사로그 before 에 남긴다 (조용한 삭제 아님).
 * - 되돌리기도 사람 처리이므로 touch_count +1.
 */
import { sql } from 'drizzle-orm';
import type { TransactionStatus } from '@mintax/core';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit, writeAuditMany } from '../infra/audit';
import {
  STATUS_LABELS,
  TAKEN_EXPORT_STATUSES,
  accountLabel,
  assertUuid,
  chunk,
  exportReleasable,
  isUuid,
  sameCoreState,
  txLabel,
} from './helpers';
import {
  blockExportJobsForChange,
  lockActionRows,
  opContext,
  txAuditEntry,
  uuidArray,
  writeTxStates,
  type ActionRow,
} from './shared';
import type { RevertResult, TxState } from './types';

export const REVERTIBLE_TX_ACTIONS: ReadonlySet<string> = new Set(['transaction.approve', 'transaction.correct', 'transaction.exclude']);
export const REVERTIBLE_BATCH_ACTIONS: ReadonlySet<string> = new Set([
  'transaction.approve_bulk',
  'transaction.correct_bulk',
  'transaction.correct_similar',
  'transaction.exclude_bulk',
]);

type AuditRow = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  client_id: string | null;
  summary: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  revertible: boolean;
  reverted_by_id: string | null;
  revert_of_id: string | null;
  created_at: Date | string;
};

const ALREADY_EXPORTED_MESSAGE =
  '이미 WEHAGO용 파일로 받은 거래라 되돌릴 수 없습니다. WEHAGO에 전표가 있을 수 있어 MIN TAX OPS만 되돌리면 두 장부가 어긋납니다. 정정 전송으로 처리하세요.';

/** 받기 전 전송파일에 연결된 거래 (되돌리면 파일에서 풀고 ready·validating 파일은 차단) */
function readyExport(row: ActionRow): boolean {
  return exportReleasable(row.state.exportJobId, row.exportStatus);
}

/** 되돌릴 수 없는 사유 (null = 가능). kind 로 오류 종류를 구분한다 */
function revertBlock(row: ActionRow, after: Partial<TxState>): { kind: 'exported' | 'changed'; message: string } | null {
  const taken = !!row.exportStatus && TAKEN_EXPORT_STATUSES.has(row.exportStatus);
  const exportedWithoutReadyFile = (row.status === 'exported' || row.status === 'reconciled') && !readyExport(row);
  if (taken || exportedWithoutReadyFile) return { kind: 'exported', message: ALREADY_EXPORTED_MESSAGE };
  // 받기 전 파일에 들어가며 상태만 'exported' 가 된 경우는 승인과 같게 본다
  const current: Partial<TxState> =
    row.status === 'exported' && readyExport(row) && (after.status === 'approved' || after.status === 'auto_approved')
      ? { ...row.state, status: after.status }
      : row.state;
  if (!sameCoreState(current, after)) {
    return {
      kind: 'changed',
      message: `이 거래는 그 뒤에 다시 변경되었습니다 (현재: ${STATUS_LABELS[row.status] ?? row.status} · ${accountLabel(row.state.accountCode, row.state.accountName)}). 가장 최근 변경부터 되돌리세요.`,
    };
  }
  return null;
}

function blockError(b: { kind: 'exported' | 'changed'; message: string }, row: ActionRow): AppError {
  if (b.kind === 'exported') {
    return new AppError({
      code: 'ALREADY_EXPORTED',
      httpStatus: 409,
      userMessage: b.message,
      action: { label: '정정 전송', href: `/transfer?client=${row.clientId}&period=${row.period}` },
      details: { status: row.status, exportStatus: row.exportStatus },
    });
  }
  return new ConflictError(b.message);
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(Object.keys(STATUS_LABELS));

/** 감사로그 before 로 복원할 상태. 전송 상태로는 복원하지 않는다 (그 파일은 차단되므로 승인으로). */
function restoredState(row: ActionRow, before: Record<string, unknown>): TxState {
  const b = before as Partial<TxState>;
  let status = (typeof b.status === 'string' && KNOWN_STATUSES.has(b.status) ? b.status : row.state.status) as TransactionStatus;
  let exportJobId = b.exportJobId ?? null;
  if (status === 'exported' || status === 'reconciled') {
    status = 'approved';
    exportJobId = null;
  }
  if (readyExport(row)) exportJobId = null;
  return {
    status,
    accountCode: b.accountCode ?? null,
    accountName: b.accountName ?? null,
    accountConfidence: b.accountConfidence ?? null,
    classificationSource: b.classificationSource ?? null,
    classificationSummary: b.classificationSummary ?? null,
    vatType: b.vatType ?? null,
    deductible: b.deductible ?? null,
    vatConfidence: b.vatConfidence ?? null,
    vatReasonCode: b.vatReasonCode ?? null,
    confidenceScore: b.confidenceScore ?? null,
    reviewedBy: b.reviewedBy ?? null,
    reviewedAt: b.reviewedAt ?? null,
    excludedReason: b.excludedReason ?? null,
    buckets: Array.isArray(b.buckets) ? b.buckets : row.state.buckets,
    exportJobId,
  };
}

function correctionIdsOf(after: Record<string, unknown> | null): string[] {
  const ids = after?.correctionIds;
  return Array.isArray(ids) ? ids.filter(isUuid) : [];
}

/** 수정으로 생긴 학습 기록 삭제 → 삭제한 행 (감사로그 보존용) */
async function deleteCorrections(ctx: ServiceContext, ids: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const part of chunk(ids, 1000)) {
    const r = await ctx.db.execute<Record<string, unknown>>(sql`
      delete from classification_corrections where id = any(${uuidArray(part)})
      returning id, transaction_id, field, before_value, before_label, after_value, after_label, before_source, before_confidence,
                reason, user_id, suggested_rule_id, created_at
    `);
    out.push(...r.rows);
  }
  return out;
}

async function blockExports(ctx: ServiceContext, rows: readonly ActionRow[]): Promise<void> {
  const changes = rows.filter(readyExport).map((r) => ({ exportJobId: r.state.exportJobId!, label: `${txLabel(r)} 되돌림` }));
  if (changes.length > 0) await blockExportJobsForChange(ctx, changes);
}

/**
 * 감사로그 1건 되돌리기. 거래 승인·수정·제외(단건) 또는 그 묶음 로그(일괄 승인·묶음 수정·같은 가맹점 적용·일괄 제외).
 * 묶음은 아직 되돌리지 않은 하위 거래를 모두 되돌리고, 되돌릴 수 없는 거래(전송됨·그 뒤 변경)는 skipped 로 알려준다.
 */
export async function revertAudit(ctx: ServiceContext, auditLogId: string): Promise<RevertResult> {
  requirePermission(ctx, 'audit.revert');
  const id = assertUuid(auditLogId, 'auditLogId', '감사로그');
  const op = opContext(ctx);
  return op.db.transaction(async (trx) => {
    const tctx = withTx(op, trx);
    const r = await tctx.db.execute<AuditRow>(sql`
      select id, action, entity_type, entity_id, client_id, summary, before_data, after_data, revertible, reverted_by_id, revert_of_id, created_at
      from audit_logs where id = ${id}::uuid for update
    `);
    const log = r.rows[0];
    if (!log) throw new NotFoundError('감사로그');
    if (log.reverted_by_id) throw new ConflictError('이미 되돌린 작업입니다. 감사 로그에서 되돌린 기록을 확인하세요.');
    if (!log.revertible) {
      throw new AppError({ code: 'NOT_REVERTIBLE', httpStatus: 400, userMessage: '이 기록은 되돌릴 수 없는 작업입니다 (조회·다운로드·시스템 작업 또는 되돌리기 기록).' });
    }
    if (REVERTIBLE_TX_ACTIONS.has(log.action)) return revertSingle(tctx, log);
    if (REVERTIBLE_BATCH_ACTIONS.has(log.action)) return revertBatch(tctx, log);
    throw new AppError({
      code: 'REVERT_UNSUPPORTED',
      httpStatus: 400,
      userMessage: '이 경로로는 거래 승인·수정·제외만 되돌릴 수 있습니다. 규칙·설정 변경은 해당 화면에서 되돌리세요.',
      action: { label: '감사 로그', href: '/audit' },
      details: { action: log.action },
    });
  });
}

async function revertSingle(ctx: ServiceContext, log: AuditRow): Promise<RevertResult> {
  const txId = log.entity_id;
  if (!txId || !isUuid(txId) || !log.before_data || !log.after_data) {
    throw new ValidationError('되돌릴 거래 정보가 감사로그에 없습니다. 관리자에게 문의하세요.', [{ field: 'auditLogId', message: '거래 정보 없음' }]);
  }
  const row = (await lockActionRows(ctx.db, [txId])).get(txId);
  if (!row) throw new NotFoundError('거래');
  const b = revertBlock(row, log.after_data as Partial<TxState>);
  if (b) throw blockError(b, row);
  const restored = restoredState(row, log.before_data);
  await writeTxStates(ctx.db, [{ id: row.id, state: restored }], ctx.now());
  const deleted = await deleteCorrections(ctx, correctionIdsOf(log.after_data));
  const summary = `되돌림: ${log.summary}`;
  const revertId = await writeAudit(
    ctx,
    txAuditEntry('transaction.revert', row, row.state, restored, summary, {
      revertible: false,
      revertOfId: log.id,
      before: deleted.length > 0 ? { deletedCorrections: deleted } : {},
      after: { revertedAction: log.action },
    }),
  );
  await ctx.db.execute(sql`update audit_logs set reverted_by_id = ${revertId}::uuid where id = ${log.id}::uuid`);
  await blockExports(ctx, [row]);
  return { revertAuditLogId: revertId, reverted: 1, revertedTransactionIds: [row.id], skipped: [], summary };
}

async function revertBatch(ctx: ServiceContext, log: AuditRow): Promise<RevertResult> {
  const childAction = typeof log.after_data?.childAction === 'string' ? log.after_data.childAction : null;
  if (!childAction || !REVERTIBLE_TX_ACTIONS.has(childAction)) {
    throw new ValidationError('묶음 작업의 하위 기록 정보가 없습니다. 거래별 감사로그에서 하나씩 되돌리세요.', [{ field: 'auditLogId', message: '하위 기록 없음' }]);
  }
  // 하위 로그: 같은 작업 시각(opContext 로 고정) + 같은 묶음 ID — audit_created_idx 사용
  const cr = await ctx.db.execute<AuditRow>(sql`
    select id, action, entity_type, entity_id, client_id, summary, before_data, after_data, revertible, reverted_by_id, revert_of_id, created_at
    from audit_logs
    where created_at = ${log.created_at instanceof Date ? log.created_at.toISOString() : String(log.created_at)}::timestamptz and action = ${childAction}
      and after_data->>'batchId' = ${log.id} and reverted_by_id is null and revertible
    order by entity_id
    for update
  `);
  const children = cr.rows.filter((c) => c.entity_id && isUuid(c.entity_id) && c.before_data && c.after_data);
  const rows = await lockActionRows(ctx.db, children.map((c) => c.entity_id!));
  const skipped: RevertResult['skipped'] = [];
  const ok: Array<{ child: AuditRow; row: ActionRow; restored: TxState }> = [];
  let firstBlock: { b: { kind: 'exported' | 'changed'; message: string }; row: ActionRow } | null = null;
  for (const child of children) {
    const row = rows.get(child.entity_id!);
    if (!row) {
      skipped.push({ transactionId: child.entity_id!, reason: '거래를 찾을 수 없습니다.' });
      continue;
    }
    const b = revertBlock(row, child.after_data as Partial<TxState>);
    if (b) {
      firstBlock ??= { b, row };
      skipped.push({ transactionId: row.id, reason: b.message });
      continue;
    }
    ok.push({ child, row, restored: restoredState(row, child.before_data!) });
  }
  if (ok.length === 0 && firstBlock) throw blockError(firstBlock.b, firstBlock.row);

  if (ok.length > 0) await writeTxStates(ctx.db, ok.map((x) => ({ id: x.row.id, state: x.restored })), ctx.now());
  const deletedByTx = new Map<string, Array<Record<string, unknown>>>();
  const allCorrIds = ok.flatMap((x) => correctionIdsOf(x.child.after_data));
  for (const d of await deleteCorrections(ctx, allCorrIds)) {
    const t = String(d.transaction_id);
    (deletedByTx.get(t) ?? deletedByTx.set(t, []).get(t)!).push(d);
  }

  const summary =
    ok.length === 0
      ? `되돌림: ${log.summary} (하위 거래는 이미 개별로 되돌려져 있음)`
      : `되돌림: ${log.summary} (${ok.length}건${skipped.length > 0 ? `, ${skipped.length}건은 되돌리지 못함` : ''})`;
  const clientIds = [...new Set(ok.map((x) => x.row.clientId))];
  const revertId = await writeAudit(ctx, {
    action: 'transaction.revert_bulk',
    category: 'data_change',
    entityType: 'transaction_batch',
    entityId: null,
    clientId: log.client_id ?? (clientIds.length === 1 ? clientIds[0]! : null),
    summary: summary.slice(0, 500),
    before: null,
    after: { revertedAction: log.action, reverted: ok.length, skipped: skipped.slice(0, 200) },
    revertible: false,
    revertOfId: log.id,
  });
  if (ok.length > 0) {
    await writeAuditMany(
      ctx,
      ok.map((x) =>
        txAuditEntry('transaction.revert', x.row, x.row.state, x.restored, `되돌림: ${x.child.summary}`, {
          revertible: false,
          revertOfId: x.child.id,
          before: deletedByTx.has(x.row.id) ? { deletedCorrections: deletedByTx.get(x.row.id) } : {},
          after: { revertedAction: x.child.action, batchRevertId: revertId },
        }),
      ),
    );
    // 하위 로그 ↔ 그 되돌리기 로그 연결: 이번 작업 시각(opContext 고정)의 되돌리기 로그를 먼저 모은 뒤 PK 로 갱신
    await ctx.db.execute(sql`
      with n as materialized (
        select id, revert_of_id from audit_logs
        where created_at = ${ctx.now().toISOString()}::timestamptz and action = 'transaction.revert' and revert_of_id is not null
      )
      update audit_logs o set reverted_by_id = n.id
      from n
      where o.id = n.revert_of_id and o.reverted_by_id is null
    `);
  }
  await ctx.db.execute(sql`update audit_logs set reverted_by_id = ${revertId}::uuid where id = ${log.id}::uuid`);
  await blockExports(ctx, ok.map((x) => x.row));
  return {
    revertAuditLogId: revertId,
    reverted: ok.length,
    revertedTransactionIds: ok.map((x) => x.row.id),
    skipped,
    summary,
  };
}
