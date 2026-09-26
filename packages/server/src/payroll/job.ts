/**
 * payroll_prepare 작업 — 한 귀속월의 모든 수임처 급여를 1~2단계(전월 복사 + 변동 분류)까지 자동으로 준비한다.
 *
 * payload
 * - { period, clientIds? }   그 달 급여 대상 직원이 있는 활성 수임처 전체 (또는 지정 수임처)
 * - { payrollMonthId }       한 달만 변동 분류 다시 계산
 *
 * 변동 없는 수임처는 status 'reviewing' · 검토 대기 0 (사람은 확정만 하면 된다).
 * 변동 있는 수임처는 "인건비 변동 미확인 N곳" 알림 하나로 묶는다 (문제 알림만).
 */
import { sql } from 'drizzle-orm';
import { lastDayOfMonth } from '@mintax/core/payroll/index';
import { AppError, toUserError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { recordSystemError } from '../infra/system-errors';
import { enqueueJob } from '../jobs/queue';
import type { JobResult, JobRunContext } from '../jobs/registry';
import { LOCKED_STATUSES, assertPeriod, isUuid } from './helpers';
import { recomputeMonth } from './month-engine';
import { loadMonthContext, refreshUnreviewedNotice, totalsOf } from './store';
import { startPayrollMonthInternal } from './wizard';
import type { PayrollPrepareClientOutcome, PayrollPrepareJobResult, PayrollPreparePayload } from './types';

/** 전 수임처 인건비 준비 요청 → payroll_prepare 작업 (웹을 막지 않음) */
export async function runPayrollPrepareForAll(ctx: ServiceContext, input: { period: string; clientIds?: string[] }): Promise<{ jobId: string; period: string }> {
  requirePermission(ctx, 'payroll.write');
  const period = assertPeriod(input?.period);
  const clientIds = (input.clientIds ?? []).filter(isUuid);
  const jobId = await enqueueJob(ctx.db, 'payroll_prepare', { period, ...(clientIds.length ? { clientIds } : {}) }, { createdBy: ctx.actor.userId });
  await writeAudit(ctx, {
    action: 'payroll.prepare_requested',
    category: 'data_change',
    entityType: 'job',
    entityId: jobId,
    summary: `${period} 인건비 일괄 준비 요청 (${clientIds.length ? `${clientIds.length}곳` : '전체 수임처'})`,
    after: { period, clientIds: clientIds.length ? clientIds : 'all' },
  });
  return { jobId, period };
}

async function targetClients(ctx: ServiceContext, period: string, clientIds?: string[]): Promise<Array<{ id: string; name: string }>> {
  const start = `${period}-01`;
  const end = lastDayOfMonth(period);
  const ids = (clientIds ?? []).filter(isUuid);
  const idFilter = ids.length ? sql`and c.id = any(${sql.param(ids)}::uuid[])` : sql``;
  const r = await ctx.db.execute<{ id: string; name: string }>(sql`
    select c.id, c.name from clients c
    where c.active = true ${idFilter}
      and exists (
        select 1 from employees e
        where e.client_id = c.id and e.active = true
          and (e.resign_date is null or e.resign_date >= ${start}::date)
          and (e.hire_date is null or e.hire_date <= ${end}::date)
      )
    order by c.name, c.id
  `);
  return r.rows;
}

/** 작업 본체 (권한 검사 없음 — worker 의 시스템 컨텍스트) */
export async function preparePayrollForAll(
  ctx: ServiceContext,
  payload: { period: string; clientIds?: string[] },
  progress: (processed: number, total: number) => Promise<void> = async () => undefined,
): Promise<PayrollPrepareJobResult> {
  const started = performance.now();
  const period = assertPeriod(payload.period);
  const targets = await targetClients(ctx, period, payload.clientIds);
  const perClient: PayrollPrepareClientOutcome[] = [];
  await progress(0, targets.length);
  for (const [i, c] of targets.entries()) {
    try {
      const r = await startPayrollMonthInternal(ctx, { clientId: c.id, period });
      const mc = await loadMonthContext(ctx, r.monthId);
      if (LOCKED_STATUSES.has(mc.month.status)) {
        perClient.push({ clientId: c.id, clientName: c.name, payrollMonthId: r.monthId, created: false, status: 'locked', pendingReview: 0, headcount: totalsOf(mc.month).headcount, summary: '이미 확정됨' });
      } else {
        const s = await ctx.db.transaction(async (tx) => recomputeMonth(withTx(ctx, tx), r.monthId, 'view'));
        perClient.push({
          clientId: c.id,
          clientName: c.name,
          payrollMonthId: r.monthId,
          created: r.created,
          status: s.pending > 0 ? 'needs_review' : 'no_changes',
          pendingReview: s.pending,
          headcount: s.currLines.length,
          summary: s.pending > 0 ? `변경 ${s.pending}명 확인 필요 (${s.dto.summaryText})` : `변동 없음 — 확정만 하면 됩니다 (${s.currLines.length}명)`,
        });
      }
    } catch (e) {
      const u = toUserError(e);
      if (!(e instanceof AppError) || u.httpStatus >= 500) {
        await recordSystemError(ctx, { area: 'payroll', error: e, userMessage: u.message, context: { clientId: c.id, period, job: 'payroll_prepare' } }).catch(() => undefined);
      }
      perClient.push({ clientId: c.id, clientName: c.name, payrollMonthId: null, created: false, status: 'failed', pendingReview: 0, headcount: 0, summary: u.message, error: { code: u.code, message: u.message } });
    }
    await progress(i + 1, targets.length);
  }
  await refreshUnreviewedNotice(ctx, period);
  const count = (s: PayrollPrepareClientOutcome['status']) => perClient.filter((x) => x.status === s).length;
  const noChanges = count('no_changes');
  const needsReview = count('needs_review');
  const locked = count('locked');
  const failed = count('failed');
  const [, mm] = period.split('-');
  const summary =
    `${Number(mm)}월 인건비 준비 ${targets.length}곳 → 변동 없음 ${noChanges}곳 / 변경 확인 필요 ${needsReview}곳` +
    (locked ? ` / 이미 확정 ${locked}곳` : '') +
    (failed ? ` / 실패 ${failed}곳` : '');
  return { period, clients: targets.length, noChanges, needsReview, locked, failed, perClient, summary, durationMs: Math.round(performance.now() - started) };
}

/** worker 처리기 */
export async function runPayrollPrepareJob(run: JobRunContext): Promise<JobResult> {
  const { ctx, job } = run;
  const payload = (job.payload ?? {}) as PayrollPreparePayload;
  if (payload.payrollMonthId && isUuid(payload.payrollMonthId)) {
    const mc = await loadMonthContext(ctx, payload.payrollMonthId);
    await run.progress(0, 1);
    const s = LOCKED_STATUSES.has(mc.month.status) ? null : await ctx.db.transaction(async (tx) => recomputeMonth(withTx(ctx, tx), mc.month.id, 'view'));
    await refreshUnreviewedNotice(ctx, mc.month.period);
    await run.progress(1, 1);
    return {
      status: 'succeeded',
      result: { payrollMonthId: mc.month.id, pendingReview: s?.pending ?? 0, summary: s ? `${mc.clientName} ${mc.month.period}: ${s.dto.summaryText}` : '이미 확정됨' },
    };
  }
  const res = await preparePayrollForAll(ctx, { period: String(payload.period ?? ''), clientIds: payload.clientIds }, run.progress);
  return { status: res.failed > 0 ? 'partial' : 'succeeded', result: res as unknown as Record<string, unknown> };
}
