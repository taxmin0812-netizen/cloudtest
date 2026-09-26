/**
 * MIN TAX OPS Worker — Job Queue 소비자.
 * 대량작업(수집/일괄분류/WEHAGO 파일생성/대사/인건비)을 백그라운드로 처리해 UI 를 멈추지 않는다.
 */
import os from 'node:os';
import { closeDb, getDb } from '@mintax/db';
import {
  claimNextJob,
  completeJob,
  createContext,
  failJob,
  getJobHandler,
  recoverStaleJobs,
  registerAllJobHandlers,
  recordSystemError,
  systemActor,
  updateJobProgress,
} from '@mintax/server';
import { createLogger } from '@mintax/security';

const log = createLogger('worker');
const workerId = `${os.hostname()}:${process.pid}`;
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2));
const pollMs = Math.max(200, Number(process.env.WORKER_POLL_MS ?? 1000));
let stopping = false;

async function runOne(): Promise<boolean> {
  const db = getDb();
  const job = await claimNextJob(db, workerId);
  if (!job) return false;
  const handler = getJobHandler(job.type);
  const ctx = createContext(db, systemActor());
  if (!handler) {
    await failJob(db, job, `처리기가 등록되지 않은 작업 유형입니다: ${job.type}`, false);
    return true;
  }
  let lastWrite = 0;
  const started = Date.now();
  try {
    log.info('job started', { jobId: job.id, type: job.type, attempt: job.attempts });
    const res = await handler({
      ctx,
      job,
      progress: async (processed, total) => {
        const now = Date.now();
        if (now - lastWrite > 500 || processed >= total) {
          lastWrite = now;
          await updateJobProgress(db, job.id, processed, total);
        }
      },
    });
    await completeJob(db, job.id, res.status, res.result);
    log.info('job finished', { jobId: job.id, type: job.type, status: res.status, ms: Date.now() - started });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const userMessage = (err as { userMessage?: string }).userMessage ?? '작업을 완료하지 못했습니다. 잠시 후 자동으로 다시 시도합니다.';
    const retryable = (err as { retryable?: boolean }).retryable !== false;
    const outcome = await failJob(db, job, userMessage, retryable);
    await recordSystemError(ctx, { area: 'worker', error: err, userMessage, context: { jobId: job.id, type: job.type, outcome } }).catch(() => undefined);
    log.error('job failed', { jobId: job.id, type: job.type, outcome, error: err });
  }
  return true;
}

async function loop(slot: number): Promise<void> {
  while (!stopping) {
    let worked = false;
    try {
      worked = await runOne();
    } catch (e) {
      log.error('worker loop error', { slot, error: e });
    }
    if (!worked) await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function main(): Promise<void> {
  registerAllJobHandlers();
  const recovered = await recoverStaleJobs(getDb());
  if (recovered > 0) log.warn('recovered stale jobs', { recovered });
  log.info('worker started', { workerId, concurrency, pollMs });
  const staleTimer = setInterval(() => void recoverStaleJobs(getDb()).catch(() => undefined), 60_000);
  await Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i)));
  clearInterval(staleTimer);
  await closeDb();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('worker stopping', { sig });
    stopping = true;
  });
}

main().catch((e) => {
  log.error('worker crashed', { error: e });
  process.exitCode = 1;
});
