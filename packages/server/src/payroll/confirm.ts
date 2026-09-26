/**
 * 7단계 — 급여 확정 + 신고 연계.
 * 확정 조건: 검토 대기 0 · 검산 차단 0(주민번호 누락 포함) · 신고 요약 = 급여 행 합계(1원 단위) · WEHAGO 급여 파일 최신.
 * 확정하면 급여 행이 잠기고, filing_jobs(원천세·지방소득세·지급명세서)가 기한과 함께 생성·갱신된다.
 */
import { and, eq, sql } from 'drizzle-orm';
import { filingJobs, payrollMonths } from '@mintax/db';
import { formatWon } from '@mintax/core';
import { AppError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { syncFilingJobsForMonth } from '../filing/sync';
import { FILING_KIND_LABELS, type FilingKind } from '../filing/steps';
import { LOCKED_STATUSES, assertUuid, itemsDigest, payrollHref } from './helpers';
import { currentPayrollExports, generatePayrollExportsInternal, toPayrollExportDTO } from './exports';
import { recomputeMonth } from './month-engine';
import { loadItemRows, loadMonthContext, lockPayroll, refreshUnreviewedNotice, toMonthDTO } from './store';
import { runPayrollValidation } from './validation';
import { computeWithholding } from './withholding';
import type { PayrollExportJobDTO, ReadyForFilingResult } from './types';

const OK_EXPORT = new Set(['ready', 'downloaded', 'uploaded_confirmed']);

async function exportsAreCurrent(ctx: ServiceContext, payrollMonthId: string): Promise<boolean> {
  const items = await loadItemRows(ctx, payrollMonthId);
  const digest = itemsDigest(items);
  const current = await currentPayrollExports(ctx, payrollMonthId);
  const kinds = new Set(items.map((i) => `payroll_${i.incomeType}`));
  for (const k of kinds) {
    const row = current.get(k);
    if (!row || !OK_EXPORT.has(row.status) || (row.validation as { itemsDigest?: string })?.itemsDigest !== digest) return false;
  }
  return true;
}

async function filingJobsOfMonth(ctx: ServiceContext, clientId: string, paymentPeriod: string, payrollMonthId: string): Promise<ReadyForFilingResult['filingJobs']> {
  const rows = await ctx.db
    .select()
    .from(filingJobs)
    .where(and(eq(filingJobs.clientId, clientId), sql`${filingJobs.payload}->'months'->${paymentPeriod}->>'payrollMonthId' = ${payrollMonthId}`));
  return rows.map((r) => ({ id: r.id, kind: r.kind, label: FILING_KIND_LABELS[r.kind as FilingKind] ?? r.kind, period: r.period, dueDate: r.dueDate, currentStep: r.currentStep, created: false }));
}

/**
 * 7단계 — 급여 확정 → 신고 준비 완료. 멱등: 이미 확정된 달은 현재 상태를 그대로 돌려준다.
 * WEHAGO 급여 파일이 없거나 급여 변경 뒤 오래된 파일이면 이 단계에서 다시 만든다 (사람 손을 한 번 덜 쓰게).
 */
export async function markReadyForFiling(ctx: ServiceContext, payrollMonthId: string): Promise<ReadyForFilingResult> {
  requirePermission(ctx, 'payroll.write');
  requirePermission(ctx, 'filing.write');
  assertUuid(payrollMonthId, 'payrollMonthId', '급여 월');
  const head = await loadMonthContext(ctx, payrollMonthId);
  const m0 = head.month;

  if (LOCKED_STATUSES.has(m0.status)) {
    const w = await computeWithholding(ctx, m0.id, head);
    const current = await currentPayrollExports(ctx, m0.id);
    return {
      month: await toMonthDTO(ctx, head),
      alreadyConfirmed: true,
      exports: [...current.values()].map(toPayrollExportDTO),
      filingJobs: await filingJobsOfMonth(ctx, m0.clientId, m0.paymentPeriod, m0.id),
      withholding: w.dto,
      warnings: [],
      summary: `${head.clientName} ${m0.period} 급여는 이미 확정되었습니다.`,
    };
  }

  const warnings: string[] = [];
  let exports: PayrollExportJobDTO[];
  if (!(await exportsAreCurrent(ctx, m0.id))) {
    const gen = await generatePayrollExportsInternal(ctx, m0.id);
    warnings.push(...gen.warnings);
    const blocked = gen.jobs.filter((j) => j.status !== 'ready');
    if (blocked.length > 0) {
      throw new AppError({
        code: 'PAYROLL_EXPORT_BLOCKED',
        httpStatus: 409,
        userMessage: `WEHAGO 급여 파일 검증에 실패해 확정할 수 없습니다: ${blocked.map((j) => `${j.kindLabel} — ${j.blockedReason ?? '검증 실패'}`).join(' / ')}`,
        action: { label: '급여 파일 확인', href: payrollHref(m0.clientId, m0.period) },
      });
    }
    exports = gen.jobs;
  } else {
    exports = [...(await currentPayrollExports(ctx, m0.id)).values()].map(toPayrollExportDTO);
    for (const e of exports) warnings.push(...e.warnings.map((w) => `${e.kindLabel}: ${w}`));
  }

  const res = await ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    await lockPayroll(t, m0.clientId, m0.period);
    const mc = await loadMonthContext(t, m0.id, { forUpdate: true });
    const m = mc.month;
    if (LOCKED_STATUSES.has(m.status)) throw new AppError({ code: 'PAYROLL_LOCKED', httpStatus: 409, userMessage: '다른 사용자가 먼저 확정했습니다. 화면을 새로고침하세요.' });
    const state = await recomputeMonth(t, m.id, 'reviewed', mc);
    if (state.pending > 0) {
      throw new AppError({
        code: 'PAYROLL_PENDING_REVIEW',
        httpStatus: 409,
        userMessage: `변경 확인이 끝나지 않은 직원 ${state.pending}명이 있어 확정할 수 없습니다. 3단계에서 확인하세요.`,
        action: { label: '변경분 검토', href: payrollHref(m.clientId, m.period) },
      });
    }
    const v = await runPayrollValidation(t, m.id, { persist: true, mc });
    if (!v.ok) {
      throw new AppError({
        code: 'PAYROLL_VALIDATION_FAILED',
        httpStatus: 409,
        userMessage: `${v.summary}. ${v.issues.filter((i) => i.blocking).slice(0, 3).map((i) => i.message).join(' / ')}`,
        action: { label: '세액 검산 보기', href: payrollHref(m.clientId, m.period) },
      });
    }
    const w = await computeWithholding(t, m.id, mc);
    if (w.dto.blocked) {
      throw new AppError({
        code: 'WITHHOLDING_MISMATCH',
        httpStatus: 409,
        userMessage: `신고 요약을 확정할 수 없습니다: ${w.dto.blockedReasons.join(' / ')}`,
        action: { label: '신고 요약 보기', href: payrollHref(m.clientId, m.period) },
        details: { mismatches: w.dto.consistency.mismatches },
      });
    }
    const now = ctx.now();
    await t.db
      .update(payrollMonths)
      .set({ status: 'confirmed', wizardStep: 7, confirmedAt: now, confirmedBy: ctx.actor.userId, updatedAt: now })
      .where(eq(payrollMonths.id, m.id));
    const jobs = await syncFilingJobsForMonth(t, mc, w, now);
    const wh = jobs.find((j) => j.kind === 'withholding');
    await writeAudit(t, {
      action: 'payroll.confirm',
      category: 'data_change',
      entityType: 'payroll_month',
      entityId: m.id,
      clientId: m.clientId,
      summary: `${mc.clientName} ${m.period} 급여 확정: ${w.dto.total.persons}명, 지급총액 ${formatWon(w.dto.total.totalPay)}, 소득세 ${formatWon(w.dto.total.incomeTax)}, 지방소득세 ${formatWon(w.dto.localIncomeTax.declared)} → 신고 준비 ${jobs.length}건${wh ? ` (원천세 기한 ${wh.dueDate})` : ''}`,
      before: { status: m.status },
      after: { status: 'confirmed', filingJobs: jobs.map((j) => ({ kind: j.kind, period: j.period, dueDate: j.dueDate })), totals: w.dto.total },
    });
    m.status = 'confirmed';
    m.wizardStep = 7;
    m.confirmedAt = now;
    m.confirmedBy = ctx.actor.userId;
    return { mc, jobs, w };
  });
  await refreshUnreviewedNotice(ctx, m0.period);
  const month = await toMonthDTO(ctx, await loadMonthContext(ctx, m0.id));
  const whJob = res.jobs.find((j) => j.kind === 'withholding');
  return {
    month,
    alreadyConfirmed: false,
    exports,
    filingJobs: res.jobs,
    withholding: res.w.dto,
    warnings: [...new Set([...warnings, ...res.w.dto.warnings])],
    summary: `${res.mc.clientName} ${m0.period} 급여 확정 · 원천세 신고 준비 완료${whJob ? ` (기한 ${whJob.dueDate})` : ''} — 신고는 WEHAGO/홈택스에서 사람이 제출합니다.`,
  };
}
