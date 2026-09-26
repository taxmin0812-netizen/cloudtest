/**
 * export_wehago 작업 — 여러 수임처의 WEHAGO 전송파일을 한 번에 준비한다 (웹 요청을 막지 않도록 worker 에서).
 *
 * payload: { period, clientIds: string[], kind?: WehagoExportKind, requestedBy?: string }
 * 결과 예: { ready: 4, blocked: 1, summary: "4개 거래처 전송파일 생성 완료 / 1곳 차단: 미소카페 — 검토 대기 3건이 남아 있습니다." }
 */
import { inArray } from 'drizzle-orm';
import { clients, type Database } from '@mintax/db';
import { ValidationError, toUserError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { notifyProblem } from '../infra/notify';
import { recordSystemError } from '../infra/system-errors';
import { enqueueJob } from '../jobs/queue';
import type { JobResult, JobRunContext } from '../jobs/registry';
import { EXPORT_KIND_LABELS, assertKind, assertPeriod, isUuid, transferHref } from './helpers';
import { prepareClientExports, prepareWehagoExport } from './prepare';
import type { PrepareExportResult, WehagoExportKind } from './types';

export interface ExportWehagoPayload {
  period: string;
  clientIds: string[];
  kind?: WehagoExportKind;
  requestedBy?: string | null;
}

export interface ExportBatchClientOutcome {
  clientId: string;
  clientName: string;
  status: 'ready' | 'blocked' | 'failed';
  exportJobIds: string[];
  reasons: string[];
  summary: string;
}

export interface ExportBatchResult {
  period: string;
  clients: number;
  ready: number;
  blocked: number;
  failed: number;
  perClient: ExportBatchClientOutcome[];
  /** "4개 거래처 전송파일 생성 완료 / 1곳 차단: 사유" */
  summary: string;
}

export function batchSummary(outcomes: readonly ExportBatchClientOutcome[]): string {
  const ready = outcomes.filter((o) => o.status === 'ready');
  const blocked = outcomes.filter((o) => o.status === 'blocked');
  const failed = outcomes.filter((o) => o.status === 'failed');
  const parts = [`${ready.length}개 거래처 전송파일 생성 완료`];
  if (blocked.length) {
    const first = blocked[0]!;
    parts.push(`${blocked.length}곳 차단: ${first.clientName} — ${first.reasons[0] ?? '사전검증 실패'}${blocked.length > 1 ? ` 외 ${blocked.length - 1}곳` : ''}`);
  }
  if (failed.length) parts.push(`${failed.length}곳 오류: ${failed[0]!.clientName} — ${failed[0]!.reasons[0] ?? '처리 실패'}`);
  return parts.join(' / ');
}

function outcomeOf(clientId: string, clientName: string, results: PrepareExportResult[]): ExportBatchClientOutcome {
  const blocked = results.filter((r) => r.status === 'blocked');
  const reasons = blocked.flatMap((b) => (b.status === 'blocked' ? b.reasons.map((r) => r.message) : []));
  return {
    clientId,
    clientName,
    status: blocked.length ? 'blocked' : 'ready',
    exportJobIds: results.map((r) => r.exportJobId).filter((x): x is string => !!x),
    reasons,
    summary: results.map((r) => r.summary).join(' / '),
  };
}

/**
 * 여러 수임처 전송파일 준비 (작업 본체, 테스트에서 직접 호출 가능). 수임처별 오류는 다른 수임처 처리를 멈추지 않는다.
 */
export async function runExportBatch(
  ctx: ServiceContext,
  payload: ExportWehagoPayload,
  progress?: (done: number, total: number) => Promise<void>,
): Promise<ExportBatchResult> {
  const period = assertPeriod(payload.period);
  const ids = [...new Set((payload.clientIds ?? []).filter(isUuid))];
  if (ids.length === 0) throw new ValidationError('전송파일을 만들 거래처가 없습니다 (clientIds).', [{ field: 'clientIds', message: '1곳 이상' }]);
  const kind = payload.kind ? assertKind(payload.kind) : null;
  const names = new Map((await ctx.db.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, ids))).map((c) => [c.id, c.name] as const));
  const perClient: ExportBatchClientOutcome[] = [];
  await progress?.(0, ids.length);
  for (let i = 0; i < ids.length; i++) {
    const clientId = ids[i]!;
    const clientName = names.get(clientId) ?? '(삭제된 거래처)';
    try {
      const results = kind ? [await prepareWehagoExport(ctx, { clientId, period, kind })] : (await prepareClientExports(ctx, { clientId, period })).results;
      perClient.push(outcomeOf(clientId, clientName, results));
    } catch (e) {
      const ue = toUserError(e);
      perClient.push({ clientId, clientName, status: 'failed', exportJobIds: [], reasons: [ue.message], summary: `${clientName} 전송파일 생성 오류: ${ue.message}` });
      await recordSystemError(ctx, { area: 'export', error: e, userMessage: ue.message, context: { clientId, period, kind } }).catch(() => undefined);
      await notifyProblem(ctx, {
        kind: 'export_error',
        severity: 'high',
        title: `${clientName} ${period} WEHAGO 전송파일 생성 오류`,
        body: ue.message,
        href: transferHref(clientId, period),
        clientId,
        dedupeKey: `export_failed:${clientId}:${period}`,
      }).catch(() => undefined);
    }
    await progress?.(i + 1, ids.length);
  }
  const ready = perClient.filter((o) => o.status === 'ready').length;
  const blocked = perClient.filter((o) => o.status === 'blocked').length;
  const failed = perClient.filter((o) => o.status === 'failed').length;
  return { period, clients: ids.length, ready, blocked, failed, perClient, summary: batchSummary(perClient) };
}

export async function runExportWehagoJob(run: JobRunContext): Promise<JobResult> {
  const payload = (run.job.payload ?? {}) as unknown as ExportWehagoPayload;
  const res = await runExportBatch(run.ctx, payload, (d, t) => run.progress(d, t));
  return { status: res.blocked + res.failed === 0 ? 'succeeded' : 'partial', result: res as unknown as Record<string, unknown> };
}

/** 한 수임처(또는 여러 곳) 전송파일 준비를 작업으로 요청 — 대용량(수만 건)일 때 웹을 막지 않는다 */
export async function requestWehagoExport(ctx: ServiceContext, input: { clientIds: string[]; period: string; kind?: WehagoExportKind }): Promise<{ jobId: string; clientCount: number }> {
  requirePermission(ctx, 'export.create');
  const period = assertPeriod(input.period);
  const ids = [...new Set((input.clientIds ?? []).filter(isUuid))];
  if (ids.length === 0) throw new ValidationError('전송파일을 만들 거래처를 선택하세요.', [{ field: 'clientIds', message: '1곳 이상' }]);
  const kind = input.kind ? assertKind(input.kind) : undefined;
  const jobId = await enqueueJob(ctx.db as Database, 'export_wehago', { period, clientIds: ids, ...(kind ? { kind } : {}), requestedBy: ctx.actor.userId }, { createdBy: ctx.actor.userId, maxAttempts: 1 });
  await writeAudit(ctx, {
    action: 'export.request',
    category: 'data_change',
    entityType: 'job',
    entityId: jobId,
    summary: `${period} WEHAGO ${kind ? EXPORT_KIND_LABELS[kind] : ''} 전송파일 준비 요청: ${ids.length}곳`.replace('  ', ' '),
    before: null,
    after: { jobId, period, clientIds: ids, kind: kind ?? null },
  });
  return { jobId, clientCount: ids.length };
}
