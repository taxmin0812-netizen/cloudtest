/**
 * 급여 확정 → filing_jobs 생성·갱신 (7단계 신고 연계).
 *
 * - 원천세·지방소득세: 지급월 단위 (반기납부 수임처는 반기 마지막 달 작업에 누적)
 * - 사업소득 간이지급명세서·일용근로 지급명세서: 매월
 * - 근로소득 간이지급명세서: core 제출주기 규칙(2026년 반기 → period=반기 마지막 달 묶음 작업, 2027~ 매월 예정)
 * 한 작업에 여러 달이 들어가면 payload.months[지급월] 로 달마다 저장하고 합계는 다시 계산한다 (재확정해도 중복 가산 없음).
 * 신고 방식: FILE_BASED (전자신고 API 없음 — 사람이 홈택스·위택스에 제출).
 */
import { and, eq, sql } from 'drizzle-orm';
import { filingJobs } from '@mintax/db';
import type { ServiceContext } from '../context';
import { FILING_LOCK_NAMESPACE, toIso } from '../payroll/helpers';
import type { MonthContext } from '../payroll/store';
import type { WithholdingComputation } from '../payroll/withholding';
import { FILING_KIND_LABELS, READY_STEP_OF, STATEMENT_KIND_OF, currentStepOf, type FilingKind } from './steps';

export const FILING_CHANNEL_NOTE =
  '전자신고 API 없음(FILE_BASED): WEHAGO 가 만든 신고 파일을 사람이 홈택스 "파일 변환신고"(지방소득세는 위택스)로 제출합니다. 제출 후 접수증·납부서를 올려 주세요.';

export interface FilingMonthEntry {
  payrollMonthId: string;
  attributionPeriod: string;
  paymentPeriod: string;
  persons: number;
  totalPay: number;
  incomeTax: number;
  localIncomeTax: number;
  rows: number;
  employeeIds: string[];
  confirmedAt: string;
  withholdingRows?: Array<{ code: string; label: string; persons: number; totalPay: number; incomeTax: number; isSubtotal: boolean }>;
}

export interface FilingPayload {
  kind: FilingKind;
  label: string;
  months: Record<string, FilingMonthEntry>;
  totals: { persons: number; totalPay: number; incomeTax: number; localIncomeTax: number; rows: number; months: number };
  due: { dueDate: string; shiftNote: string | null; cycle: string; submissionPeriod: { from: string; to: string } | null };
  channel: 'FILE_BASED';
  channelNote: string;
  warnings: string[];
  filedHistory?: Array<{ filedAt: string; by: string; receiptNumber: string | null }>;
  amendmentWarning?: string | null;
}

export type FilingJobRow = typeof filingJobs.$inferSelect;

export function payloadOf(row: Pick<FilingJobRow, 'payload'>): Partial<FilingPayload> {
  return (row.payload ?? {}) as Partial<FilingPayload>;
}

function recomputeTotals(months: Record<string, FilingMonthEntry>): FilingPayload['totals'] {
  const ids = new Set<string>();
  const t = { persons: 0, totalPay: 0, incomeTax: 0, localIncomeTax: 0, rows: 0, months: 0 };
  for (const e of Object.values(months)) {
    for (const id of e.employeeIds) ids.add(id);
    t.totalPay += e.totalPay;
    t.incomeTax += e.incomeTax;
    t.localIncomeTax += e.localIncomeTax;
    t.rows += e.rows;
    t.months += 1;
  }
  t.persons = ids.size;
  return t;
}

async function lockFilingJob(ctx: Pick<ServiceContext, 'db'>, clientId: string, period: string, kind: string): Promise<void> {
  await ctx.db.execute(sql`select pg_advisory_xact_lock(${FILING_LOCK_NAMESPACE}, hashtext(${`${clientId}:${period}:${kind}`}))`);
}

export interface SyncedFilingJob {
  id: string;
  kind: FilingKind;
  label: string;
  period: string;
  dueDate: string | null;
  currentStep: string;
  created: boolean;
}

interface JobSpec {
  kind: FilingKind;
  period: string;
  dueDate: string;
  due: FilingPayload['due'];
  entry: FilingMonthEntry;
  warnings: string[];
}

/**
 * 확정된 급여 월을 신고 작업에 반영한다. 호출자는 트랜잭션 안에서 부른다.
 */
export async function syncFilingJobsForMonth(ctx: ServiceContext, mc: MonthContext, w: WithholdingComputation, confirmedAt: Date): Promise<SyncedFilingJob[]> {
  const m = mc.month;
  const d = w.dto;
  const confirmedIso = confirmedAt.toISOString();
  const base = { payrollMonthId: m.id, attributionPeriod: m.period, paymentPeriod: m.paymentPeriod, confirmedAt: confirmedIso };
  const specs: JobSpec[] = [];
  const whDue = { dueDate: d.dueDate, shiftNote: d.dueNote, cycle: d.semiannual ? 'semiannual' : 'monthly', submissionPeriod: null };
  if (d.itemTotals.headcount > 0) {
    specs.push({
      kind: 'withholding',
      period: d.filingPeriod,
      dueDate: d.dueDate,
      due: whDue,
      entry: { ...base, persons: d.total.persons, totalPay: d.total.totalPay, incomeTax: d.total.incomeTax, localIncomeTax: d.localIncomeTax.declared, rows: d.total.persons, employeeIds: w.paidEmployeeIds, withholdingRows: d.rows },
      warnings: d.warnings,
    });
    specs.push({
      kind: 'local_income_tax',
      period: d.filingPeriod,
      dueDate: d.localIncomeTax.dueDate,
      due: { ...whDue, dueDate: d.localIncomeTax.dueDate },
      entry: { ...base, persons: d.total.persons, totalPay: d.total.totalPay, incomeTax: d.total.incomeTax, localIncomeTax: d.localIncomeTax.declared, rows: d.total.persons, employeeIds: w.paidEmployeeIds },
      warnings: d.localIncomeTax.matches ? [] : ['지방소득세 합계가 소득세 × 10% 와 다릅니다'],
    });
  }
  for (const st of d.statements) {
    specs.push({
      kind: STATEMENT_KIND_OF[st.kind],
      period: st.filingPeriod,
      dueDate: st.dueDate,
      due: { dueDate: st.dueDate, shiftNote: st.shiftNote, cycle: st.cycle, submissionPeriod: st.submissionPeriod },
      entry: { ...base, persons: st.persons, totalPay: st.paidAmount, incomeTax: st.incomeTax, localIncomeTax: st.localIncomeTax, rows: st.rows, employeeIds: w.statementEmployeeIds[st.kind] },
      warnings: [
        ...(st.cycle === 'semiannual' ? [`반기 제출(${st.submissionPeriod.from}~${st.submissionPeriod.to}) — 달마다 이 작업에 누적됩니다`] : []),
        ...(st.status === 'enacted_recheck' ? ['제출주기 개정 여부 재확인 필요 (2026 세법개정)'] : []),
        ...(st.note ? [st.note] : []),
      ],
    });
  }

  // 이번 달이 더 이상 들어가지 않는 작업(예: 사업소득자가 빠짐)에서 이번 달 몫을 뺀다
  const keep = new Set(specs.map((s) => `${s.kind}|${s.period}`));
  await detachMonthFromFilingJobs(ctx, mc, (row) => !keep.has(`${row.kind}|${row.period}`));

  const out: SyncedFilingJob[] = [];
  for (const s of specs) {
    await lockFilingJob(ctx, m.clientId, s.period, s.kind);
    const [existing] = await ctx.db
      .select()
      .from(filingJobs)
      .where(and(eq(filingJobs.clientId, m.clientId), eq(filingJobs.period, s.period), eq(filingJobs.kind, s.kind)));
    const prevPayload = existing ? payloadOf(existing) : {};
    const months = { ...(prevPayload.months ?? {}), [m.paymentPeriod]: s.entry };
    const totals = recomputeTotals(months);
    const steps: Record<string, string | null> = { ...(existing?.steps ?? {}) };
    const createdIso = toIso(m.createdAt)!;
    if (!steps.payroll_input || steps.payroll_input > createdIso) steps.payroll_input = createdIso;
    const byType = d.itemTotals.byIncomeType;
    if (byType.earned.headcount > 0) steps.earned_confirmed = confirmedIso;
    if (byType.business.headcount > 0) steps.business_confirmed = confirmedIso;
    if (byType.daily.headcount > 0) steps.daily_confirmed = confirmedIso;
    steps[READY_STEP_OF[s.kind]] = confirmedIso;
    let amendmentWarning: string | null = prevPayload.amendmentWarning ?? null;
    const prevEntry = prevPayload.months?.[m.paymentPeriod];
    if (existing?.steps?.filed && prevEntry && (prevEntry.incomeTax !== s.entry.incomeTax || prevEntry.totalPay !== s.entry.totalPay)) {
      amendmentWarning = `신고 완료 후 ${m.paymentPeriod} 지급분이 바뀌었습니다 (소득세 ${prevEntry.incomeTax.toLocaleString('ko-KR')} → ${s.entry.incomeTax.toLocaleString('ko-KR')}원) — WEHAGO 에서 수정신고가 필요합니다.`;
    }
    const payload: FilingPayload = {
      kind: s.kind,
      label: FILING_KIND_LABELS[s.kind],
      months,
      totals,
      due: s.due,
      channel: 'FILE_BASED',
      channelNote: FILING_CHANNEL_NOTE,
      warnings: [...new Set(s.warnings)],
      filedHistory: prevPayload.filedHistory ?? [],
      amendmentWarning,
    };
    const currentStep = currentStepOf(steps);
    if (existing) {
      await ctx.db
        .update(filingJobs)
        .set({ steps, payload: payload as unknown as Record<string, unknown>, currentStep, dueDate: s.dueDate, assigneeId: existing.assigneeId ?? mc.assigneeId, updatedAt: ctx.now() })
        .where(eq(filingJobs.id, existing.id));
      out.push({ id: existing.id, kind: s.kind, label: FILING_KIND_LABELS[s.kind], period: s.period, dueDate: s.dueDate, currentStep, created: false });
    } else {
      const [row] = await ctx.db
        .insert(filingJobs)
        .values({
          clientId: m.clientId,
          period: s.period,
          kind: s.kind,
          steps,
          currentStep,
          dueDate: s.dueDate,
          payload: payload as unknown as Record<string, unknown>,
          channelStatus: 'FILE_BASED',
          assigneeId: mc.assigneeId,
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        })
        .returning({ id: filingJobs.id });
      out.push({ id: row!.id, kind: s.kind, label: FILING_KIND_LABELS[s.kind], period: s.period, dueDate: s.dueDate, currentStep, created: true });
    }
  }
  return out;
}

/**
 * 신고 작업에서 이 급여 월 몫을 뺀다 (확정 되돌리기·재확정). 신고 완료된 작업은 건드리지 않고 filedKinds 로 알린다.
 * @param filter 대상 작업 선택 (기본: 전부)
 */
export async function detachMonthFromFilingJobs(
  ctx: ServiceContext,
  mc: MonthContext,
  filter: (row: FilingJobRow) => boolean = () => true,
): Promise<{ jobIds: string[]; filedKinds: string[] }> {
  const m = mc.month;
  const rows = await ctx.db
    .select()
    .from(filingJobs)
    .where(and(eq(filingJobs.clientId, m.clientId), sql`${filingJobs.payload}->'months'->${m.paymentPeriod}->>'payrollMonthId' = ${m.id}`));
  const jobIds: string[] = [];
  const filedKinds: string[] = [];
  for (const row of rows) {
    if (!filter(row)) continue;
    if (row.steps?.filed) {
      filedKinds.push(FILING_KIND_LABELS[row.kind as FilingKind] ?? row.kind);
      continue;
    }
    const p = payloadOf(row);
    const months = { ...(p.months ?? {}) };
    delete months[m.paymentPeriod];
    const steps: Record<string, string | null> = { ...(row.steps ?? {}) };
    if (Object.keys(months).length === 0) {
      for (const k of ['earned_confirmed', 'business_confirmed', 'daily_confirmed', 'withholding_ready', 'simplified_statement_ready', 'local_tax_ready']) steps[k] = null;
    }
    await ctx.db
      .update(filingJobs)
      .set({ payload: { ...p, months, totals: recomputeTotals(months) } as unknown as Record<string, unknown>, steps, currentStep: currentStepOf(steps), updatedAt: ctx.now() })
      .where(eq(filingJobs.id, row.id));
    jobIds.push(row.id);
  }
  return { jobIds, filedKinds };
}
