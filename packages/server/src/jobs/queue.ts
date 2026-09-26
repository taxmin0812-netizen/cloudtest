import { and, eq, sql } from 'drizzle-orm';
import { jobs, type Database } from '@mintax/db';
import type { JobStatus, JobType } from '@mintax/core';

/**
 * PostgreSQL 기반 Job Queue.
 * - claim: SELECT ... FOR UPDATE SKIP LOCKED (다중 worker 안전)
 * - 대량 작업은 반드시 이 큐를 통해 실행하고 진행률을 기록한다 (UI 멈춤 방지)
 * - 실패 시 지수 백오프 재시도 (maxAttempts), 최종 실패는 사용자 메시지와 함께 기록
 */
export interface EnqueueOptions {
  createdBy?: string | null;
  parentJobId?: string | null;
  runAfter?: Date;
  maxAttempts?: number;
}

export async function enqueueJob(db: Database, type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<string> {
  const [row] = await db
    .insert(jobs)
    .values({
      type,
      payload,
      status: 'queued',
      createdBy: opts.createdBy ?? null,
      parentJobId: opts.parentJobId ?? null,
      runAfter: opts.runAfter ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 3,
    })
    .returning({ id: jobs.id });
  return row!.id;
}

export type ClaimedJob = typeof jobs.$inferSelect;

export async function claimNextJob(db: Database, workerId: string, types?: JobType[]): Promise<ClaimedJob | null> {
  const typeFilter = types && types.length > 0 ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const result = await db.execute<{ id: string }>(sql`
    update jobs set status = 'running', locked_by = ${workerId}, locked_at = now(), started_at = coalesce(started_at, now()), attempts = attempts + 1
    where id = (
      select id from jobs
      where status = 'queued' and run_after <= now() ${typeFilter}
      order by run_after asc, created_at asc
      for update skip locked
      limit 1
    )
    returning id
  `);
  const id = result.rows[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job ?? null;
}

export async function updateJobProgress(db: Database, jobId: string, processed: number, total: number): Promise<void> {
  const progress = total > 0 ? Math.min(100, Math.round((processed / total) * 1000) / 10) : 0;
  await db.update(jobs).set({ processedItems: processed, totalItems: total, progress }).where(eq(jobs.id, jobId));
}

export async function completeJob(db: Database, jobId: string, status: Extract<JobStatus, 'succeeded' | 'partial'>, result: Record<string, unknown>): Promise<void> {
  await db
    .update(jobs)
    .set({ status, result, progress: 100, finishedAt: new Date(), lockedBy: null, lockedAt: null })
    .where(eq(jobs.id, jobId));
}

/** 재시도 가능하면 queued 로 되돌리고, 아니면 failed + 사용자 메시지 */
export async function failJob(db: Database, job: ClaimedJob, userMessage: string, retryable: boolean): Promise<'retry' | 'failed'> {
  if (retryable && job.attempts < job.maxAttempts) {
    const delaySec = Math.min(300, 2 ** job.attempts * 5);
    await db
      .update(jobs)
      .set({ status: 'queued', errorMessage: userMessage, lockedBy: null, lockedAt: null, runAfter: new Date(Date.now() + delaySec * 1000) })
      .where(eq(jobs.id, job.id));
    return 'retry';
  }
  await db
    .update(jobs)
    .set({ status: 'failed', errorMessage: userMessage, finishedAt: new Date(), lockedBy: null, lockedAt: null })
    .where(eq(jobs.id, job.id));
  return 'failed';
}

/** 오래 잠긴(worker 사망) 작업 회수 */
export async function recoverStaleJobs(db: Database, staleMinutes = 15): Promise<number> {
  const r = await db.execute(sql`
    update jobs set status = 'queued', locked_by = null, locked_at = null
    where status = 'running' and locked_at < now() - make_interval(mins => ${staleMinutes})
  `);
  return r.rowCount ?? 0;
}

export async function getJob(db: Database, jobId: string): Promise<ClaimedJob | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  return job ?? null;
}

export async function cancelJob(db: Database, jobId: string): Promise<boolean> {
  const r = await db.update(jobs).set({ status: 'cancelled', finishedAt: new Date() }).where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')));
  return (r.rowCount ?? 0) > 0;
}
