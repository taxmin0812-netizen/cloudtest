/**
 * classify_batch 작업 — 수임처 한 곳 또는 여러 곳(전체)의 한 기간 자동분류.
 *
 * payload
 * - { clientId, period }                  한 수임처
 * - { clientIds: [...], period }          지정 수임처 순차 처리
 * - { all: true, period }                 그 기간 거래가 있는 활성 수임처 전체
 * - { clientId, importJobId } / { transactionIds } (period 생략) → 해당 거래의 (수임처, 기간) 을 찾아 처리 (가져오기 후속 작업 호환)
 * - reclassifyNeedsReview?: boolean
 *
 * 결과 예: { clients: 154, autoCompleted: 149, needsReview: 5, failed: 0, perClient: [...],
 *           summary: "9월 카드매입 자동처리 전체 거래처 154곳 → 149곳 자동처리 / 5곳 검토필요" }
 */
import { sql } from 'drizzle-orm';
import { AppError, ValidationError, toUserError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { notifyProblem, resolveProblem } from '../infra/notify';
import { recordSystemError } from '../infra/system-errors';
import { enqueueJob } from '../jobs/queue';
import { registerJobHandler, type JobResult, type JobRunContext } from '../jobs/registry';
import { classifyClientPeriod, type ClassifyClientPeriodResult } from './classify';
import { PENDING_STATUSES, assertPeriod, isUuid, kstDate, fanOutSummaryText, unifyLabels } from './helpers';

export interface ClassifyBatchPayload {
  clientId?: string;
  clientIds?: string[];
  period?: string;
  all?: boolean;
  importJobId?: string;
  transactionIds?: string[];
  reclassifyNeedsReview?: boolean;
}

export type ClientBatchStatus = 'auto_completed' | 'needs_review' | 'failed' | 'no_data';

export interface ClientBatchOutcome {
  clientId: string;
  clientName: string;
  period: string;
  status: ClientBatchStatus;
  /** 이번에 분류한 거래 수 */
  classified: number;
  autoApproved: number;
  needsReview: number;
  unclassified: number;
  /** 분류 후에도 사람이 처리해야 하는 거래 수 (이번 배치 + 기존 미검토) */
  pendingReview: number;
  /** 그 기간 전체 유효 거래 수 (중복·제외·실패 제외) */
  periodTransactions: number;
  aiUsed: number;
  durationMs: number;
  summary: string;
  error?: { code: string; message: string };
}

export interface ClassifyBatchJobResult {
  period: string;
  periods: string[];
  clients: number;
  autoCompleted: number;
  needsReview: number;
  failed: number;
  noData: number;
  totals: { classified: number; autoApproved: number; needsReview: number; unclassified: number; aiUsed: number };
  perClient: ClientBatchOutcome[];
  summary: string;
  durationMs: number;
}

interface Target {
  clientId: string;
  period: string;
}

/** payload → (수임처, 기간) 목록 */
export async function resolveBatchTargets(ctx: ServiceContext, payload: ClassifyBatchPayload): Promise<Target[]> {
  const db = ctx.db;
  if (!payload.period) {
    if (payload.importJobId && isUuid(payload.importJobId)) {
      const r = await db.execute<{ client_id: string; period: string }>(sql`
        select distinct client_id, period from transactions where import_job_id = ${payload.importJobId} order by period, client_id
      `);
      return r.rows.map((x) => ({ clientId: x.client_id, period: x.period }));
    }
    const txIds = (payload.transactionIds ?? []).filter(isUuid);
    if (txIds.length > 0) {
      const r = await db.execute<{ client_id: string; period: string }>(sql`
        select distinct client_id, period from transactions where id = any(${sql.param(txIds)}::uuid[]) order by period, client_id
      `);
      return r.rows.map((x) => ({ clientId: x.client_id, period: x.period }));
    }
    throw new ValidationError('자동분류 작업에 처리 기간(period)이 없습니다. 예: 2026-09', [{ field: 'period', message: '필수' }]);
  }
  const period = assertPeriod(payload.period);
  if (payload.all) {
    const r = await db.execute<{ id: string }>(sql`
      select c.id from clients c
      where c.active = true
        and exists (select 1 from transactions t where t.client_id = c.id and t.period = ${period} and t.status not in ('duplicate', 'excluded', 'failed'))
      order by c.name, c.id
    `);
    return r.rows.map((x) => ({ clientId: x.id, period }));
  }
  const ids = [...new Set([...(payload.clientIds ?? []), ...(payload.clientId ? [payload.clientId] : [])])];
  if (ids.length === 0) {
    throw new ValidationError('자동분류할 거래처를 지정하세요. (clientId, clientIds 또는 all)', [{ field: 'clientIds', message: '필수' }]);
  }
  return ids.map((clientId) => ({ clientId, period }));
}

/**
 * 작업 본체. worker 가 JobRunContext 로 호출한다 (registerClassificationJobHandlers).
 */
export async function runClassifyBatchJob(run: JobRunContext): Promise<JobResult> {
  const { ctx, job } = run;
  const started = performance.now();
  const payload = (job.payload ?? {}) as ClassifyBatchPayload;
  const targets = await resolveBatchTargets(ctx, payload);
  const single = targets.length === 1;
  const names = await clientNames(ctx, targets.map((t) => t.clientId));

  const results = new Map<string, ClassifyClientPeriodResult>();
  const failures = new Map<string, { code: string; message: string }>();
  await run.progress(0, single ? 1 : targets.length);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const key = `${t.clientId}|${t.period}`;
    try {
      const res = await classifyClientPeriod(ctx, {
        clientId: t.clientId,
        period: t.period,
        reclassifyNeedsReview: payload.reclassifyNeedsReview === true,
        jobId: job.id,
        onProgress: single ? (p, total) => run.progress(p, total) : undefined,
      });
      results.set(key, res);
      await resolveProblem(ctx, `classify_failed:${t.clientId}:${t.period}`);
    } catch (e) {
      const ue = toUserError(e);
      failures.set(key, { code: ue.code, message: ue.message });
      await recordSystemError(ctx, { area: 'classify', error: e, userMessage: ue.message, context: { clientId: t.clientId, period: t.period, jobId: job.id } });
      await notifyProblem(ctx, {
        kind: 'job_failed',
        severity: 'warning',
        title: `자동분류 실패: ${names.get(t.clientId) ?? '거래처'} ${t.period}`,
        body: `${ue.message} 문제를 해결한 뒤 자동분류를 다시 실행하세요.`,
        href: `/clients/${t.clientId}?period=${t.period}`,
        clientId: isUuid(t.clientId) ? t.clientId : null,
        dedupeKey: `classify_failed:${t.clientId}:${t.period}`,
      });
    }
    if (!single) await run.progress(i + 1, targets.length);
  }

  // 분류 후 대기 건수 (수임처·기간별 1회 집계)
  const pending = await pendingCounts(ctx, targets);
  const perClient: ClientBatchOutcome[] = targets.map((t) => {
    const key = `${t.clientId}|${t.period}`;
    const res = results.get(key);
    const fail = failures.get(key);
    const p = pending.get(key) ?? { pending: 0, total: 0 };
    const base = {
      clientId: t.clientId,
      clientName: names.get(t.clientId) ?? '(알 수 없는 거래처)',
      period: t.period,
      pendingReview: p.pending,
      periodTransactions: p.total,
    };
    if (fail || !res) {
      return {
        ...base,
        status: 'failed' as const,
        classified: 0,
        autoApproved: 0,
        needsReview: 0,
        unclassified: 0,
        aiUsed: 0,
        durationMs: 0,
        summary: fail?.message ?? '자동분류 결과가 없습니다',
        error: fail ?? { code: 'UNKNOWN', message: '자동분류 결과가 없습니다' },
      };
    }
    const status: ClientBatchStatus = p.total === 0 ? 'no_data' : p.pending === 0 ? 'auto_completed' : 'needs_review';
    return {
      ...base,
      status,
      classified: res.total,
      autoApproved: res.autoApproved,
      needsReview: res.needsReview,
      unclassified: res.unclassified,
      aiUsed: res.aiUsed,
      durationMs: res.durationMs,
      summary: res.summary,
    };
  });

  const counted = perClient.filter((c) => c.status !== 'no_data');
  const autoCompleted = counted.filter((c) => c.status === 'auto_completed').length;
  const needsReview = counted.filter((c) => c.status === 'needs_review').length;
  const failed = counted.filter((c) => c.status === 'failed').length;
  const periods = [...new Set(targets.map((t) => t.period))].sort();
  const label = unifyLabels([...results.values()].filter((r) => r.total > 0).map((r) => r.label));
  const summary = fanOutSummaryText({
    period: periods[0] ?? payload.period ?? '',
    label,
    clients: counted.length,
    autoCompleted,
    needsReview,
    failed,
    currentYear: Number(kstDate(ctx.now()).slice(0, 4)),
  });
  const totals = { classified: 0, autoApproved: 0, needsReview: 0, unclassified: 0, aiUsed: 0 };
  for (const r of results.values()) {
    totals.classified += r.total;
    totals.autoApproved += r.autoApproved;
    totals.needsReview += r.needsReview;
    totals.unclassified += r.unclassified;
    totals.aiUsed += r.aiUsed;
  }

  if (targets.length > 0 && failed === targets.length) {
    const first = [...failures.values()][0];
    throw new AppError({
      code: 'CLASSIFY_BATCH_FAILED',
      httpStatus: 500,
      userMessage: `자동분류가 모든 거래처(${failed}곳)에서 실패했습니다. ${first?.message ?? ''} 시스템 오류 목록을 확인한 뒤 다시 실행하세요.`.trim(),
      retryable: false,
      action: { label: '시스템 오류 보기', href: '/settings/errors' },
    });
  }

  if (targets.length > 1) {
    await writeAudit(ctx, {
      action: 'classification.batch_all',
      category: 'system',
      entityType: 'job',
      entityId: job.id,
      summary,
      after: { periods, clients: counted.length, autoCompleted, needsReview, failed, totals },
    });
  }

  const result: ClassifyBatchJobResult = {
    period: periods.join(','),
    periods,
    clients: counted.length,
    autoCompleted,
    needsReview,
    failed,
    noData: perClient.length - counted.length,
    totals,
    perClient,
    summary,
    durationMs: Math.round(performance.now() - started),
  };
  return { status: failed > 0 ? 'partial' : 'succeeded', result: result as unknown as Record<string, unknown> };
}

async function clientNames(ctx: ServiceContext, ids: string[]): Promise<Map<string, string>> {
  const valid = [...new Set(ids.filter(isUuid))];
  if (valid.length === 0) return new Map();
  const r = await ctx.db.execute<{ id: string; name: string }>(sql`select id, name from clients where id = any(${sql.param(valid)}::uuid[])`);
  return new Map(r.rows.map((x) => [x.id, x.name]));
}

async function pendingCounts(ctx: ServiceContext, targets: Target[]): Promise<Map<string, { pending: number; total: number }>> {
  const out = new Map<string, { pending: number; total: number }>();
  const valid = targets.filter((t) => isUuid(t.clientId));
  if (valid.length === 0) return out;
  const clientIds = [...new Set(valid.map((t) => t.clientId))];
  const periods = [...new Set(valid.map((t) => t.period))];
  const pend = sql.raw(`(${PENDING_STATUSES.map((s) => `'${s}'`).join(', ')})`);
  const r = await ctx.db.execute<{ client_id: string; period: string; pending: number; total: number }>(sql`
    select client_id, period,
           (count(*) filter (where status in ${pend}))::int as pending,
           (count(*) filter (where status not in ('duplicate', 'excluded', 'failed')))::int as total
    from transactions
    where client_id = any(${sql.param(clientIds)}::uuid[]) and period = any(${sql.param(periods)}::text[])
    group by client_id, period
  `);
  for (const x of r.rows) out.set(`${x.client_id}|${x.period}`, { pending: x.pending, total: x.total });
  return out;
}

/**
 * 사용자 요청으로 자동분류 작업 등록 → jobId. 권한: transactions.review
 * clientIds 생략 = 그 기간 거래가 있는 전체 활성 거래처.
 */
export async function startBatchClassification(
  ctx: ServiceContext,
  input: { period: string; clientIds?: string[]; reclassifyNeedsReview?: boolean },
): Promise<string> {
  requirePermission(ctx, 'transactions.review');
  const period = assertPeriod(input.period);
  const ids = [...new Set(input.clientIds ?? [])];
  if (ids.length > 0) {
    const bad = ids.filter((id) => !isUuid(id));
    const r = bad.length === ids.length ? { rows: [] as Array<{ id: string }> } : await ctx.db.execute<{ id: string }>(sql`
      select id from clients where id = any(${sql.param(ids.filter(isUuid))}::uuid[])
    `);
    const found = new Set(r.rows.map((x) => x.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new ValidationError(`존재하지 않는 거래처가 ${missing.length}곳 포함되어 있습니다. 거래처 목록을 새로고침한 뒤 다시 선택하세요.`, [
        { field: 'clientIds', message: `알 수 없는 거래처 ${missing.length}곳` },
      ]);
    }
  }
  const payload: ClassifyBatchPayload =
    ids.length > 0 ? { period, clientIds: ids } : { period, all: true };
  if (input.reclassifyNeedsReview) payload.reclassifyNeedsReview = true;
  const jobId = await enqueueJob(ctx.db, 'classify_batch', payload as Record<string, unknown>, { createdBy: ctx.actor.userId });
  await writeAudit(ctx, {
    action: 'classification.batch_requested',
    category: 'system',
    entityType: 'job',
    entityId: jobId,
    summary: `${Number(period.slice(5, 7))}월 자동분류 실행 요청: ${ids.length > 0 ? `거래처 ${ids.length}곳` : '전체 거래처'}${input.reclassifyNeedsReview ? ' (검토필요 건 재분류 포함)' : ''}`,
    after: { period, clientCount: ids.length || null, all: ids.length === 0, reclassifyNeedsReview: !!input.reclassifyNeedsReview },
  });
  return jobId;
}

export function registerClassificationJobHandlers(): void {
  registerJobHandler('classify_batch', runClassifyBatchJob);
}

