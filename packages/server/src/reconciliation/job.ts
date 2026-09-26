/**
 * reconcile 작업 — payload { clientId, period, phase, exportJobId? } 또는 { clientIds: [...], period, phase }.
 * 결과는 reconciliation_jobs 에 이력으로 쌓인다 (docs/03 §9.1).
 */
import { ValidationError, toUserError } from '@mintax/security';
import type { JobResult, JobRunContext } from '../jobs/registry';
import { recordSystemError } from '../infra/system-errors';
import { runReconciliation } from './run';
import type { ReconPhase } from './types';

interface ReconcilePayload {
  clientId?: string;
  clientIds?: string[];
  period?: string;
  phase?: ReconPhase;
  exportJobId?: string | null;
}

export async function runReconcileJob(run: JobRunContext): Promise<JobResult> {
  const p = (run.job.payload ?? {}) as ReconcilePayload;
  const ids = [...new Set([...(p.clientIds ?? []), ...(p.clientId ? [p.clientId] : [])])];
  if (ids.length === 0 || !p.period) throw new ValidationError('대사 작업에 거래처와 기간이 필요합니다.', [{ field: 'clientId', message: '필수' }]);
  const phase: ReconPhase = p.phase === 'post_export' ? 'post_export' : 'pre_export';
  const out: Array<{ clientId: string; reconciliationId: string | null; exportAllowed: boolean; summary: string; error?: string }> = [];
  await run.progress(0, ids.length);
  for (let i = 0; i < ids.length; i++) {
    const clientId = ids[i]!;
    try {
      const dto = await runReconciliation(run.ctx, { clientId, period: p.period, phase, exportJobId: ids.length === 1 ? (p.exportJobId ?? null) : null });
      out.push({ clientId, reconciliationId: dto.id, exportAllowed: dto.exportAllowed, summary: dto.summary });
    } catch (e) {
      const ue = toUserError(e);
      out.push({ clientId, reconciliationId: null, exportAllowed: false, summary: ue.message, error: ue.code });
      await recordSystemError(run.ctx, { area: 'reconcile', error: e, userMessage: ue.message, context: { clientId, period: p.period, phase } }).catch(() => undefined);
    }
    await run.progress(i + 1, ids.length);
  }
  const failed = out.filter((o) => o.error).length;
  const ok = out.filter((o) => !o.error && o.exportAllowed).length;
  return {
    status: failed === 0 ? 'succeeded' : 'partial',
    result: { period: p.period, phase, clients: ids.length, balancedAndAllowed: ok, failed, perClient: out, summary: `대사 ${ids.length}곳: 일치 ${ok}곳 · 차이/대기 ${ids.length - ok - failed}곳${failed ? ` · 오류 ${failed}곳` : ''}` },
  };
}
