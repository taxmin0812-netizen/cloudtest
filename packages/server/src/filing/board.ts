/**
 * 원천세 Control Tower — 지급월 P 기준 전 수임처의 신고 10단계.
 * 단계는 실제 데이터(payroll_months · payroll_items · filing_jobs.steps · filing_results)에서 계산한다 — 기한 목록이 아니다.
 * 조회는 수임처 수와 무관하게 쿼리 6개 (N+1 없음).
 */
import { inArray, sql } from 'drizzle-orm';
import { filingJobs } from '@mintax/db';
import type { IncomeType } from '@mintax/core';
import { lastDayOfMonth, simplifiedStatementDueDate, simplifiedStatementDueDetail, withholdingDueDate } from '@mintax/core/payroll/index';
import { requirePermission, type ServiceContext } from '../context';
import { assertPeriod, halfEndOf, kstToday, payrollHref, toIso } from '../payroll/helpers';
import { loadCalendarOptions } from '../payroll/withholding';
import {
  FILING_KIND_LABELS,
  FILING_STEPS,
  FILING_STEP_LABELS,
  currentStepOf,
  deriveBoardRow,
  isFilingKind,
  type BoardClientInput,
  type BoardJobInput,
  type BoardMonthInput,
  type FilingKind,
} from './steps';
import { payloadOf, type FilingJobRow } from './sync';
import type { FilingBoardDTO, FilingBoardRowDTO, FilingJobSummaryDTO } from './types';

export const FILING_INTEGRATION_MESSAGE = '전자신고 API가 없습니다(FILE_BASED). WEHAGO 또는 홈택스에서 신고한 뒤 접수증·납부서를 올려 주세요.';

const zero = (): Record<IncomeType, number> => ({ earned: 0, business: 0, daily: 0 });

export function toJobSummary(row: FilingJobRow, counts: { receipts: number; paymentSlips: number }): FilingJobSummaryDTO {
  const p = payloadOf(row);
  const kind = row.kind as FilingKind;
  const step = currentStepOf(row.steps ?? {});
  return {
    id: row.id,
    kind,
    kindLabel: FILING_KIND_LABELS[kind] ?? row.kind,
    period: row.period,
    dueDate: row.dueDate,
    currentStep: step,
    currentStepLabel: FILING_STEP_LABELS[step],
    persons: p.totals?.persons ?? 0,
    totalPay: p.totals?.totalPay ?? 0,
    incomeTax: p.totals?.incomeTax ?? 0,
    localIncomeTax: p.totals?.localIncomeTax ?? 0,
    monthsIncluded: Object.keys(p.months ?? {}).sort(),
    filedAt: row.steps?.filed ?? null,
    receipts: counts.receipts,
    paymentSlips: counts.paymentSlips,
    amendmentWarning: p.amendmentWarning ?? null,
  };
}

/**
 * Control Tower 표.
 * @param input.period 지급월 'YYYY-MM'
 * @param input.dueWithinDays 기한 N일 이내 미완료만 (화면 기본 7)
 */
export async function getFilingBoard(
  ctx: ServiceContext,
  input: { period: string; dueWithinDays?: number; onlyIncomplete?: boolean; clientId?: string },
): Promise<FilingBoardDTO> {
  requirePermission(ctx, 'filing.write');
  const P = assertPeriod(input?.period, 'period', '지급월');
  const half = halfEndOf(P);
  const start = `${P}-01`;
  const end = lastDayOfMonth(P);
  const today = kstToday(ctx.now());
  const calOpts = await loadCalendarOptions(ctx);

  // 1) 재직 인원 (지급월 기준)
  const empRows = (
    await ctx.db.execute<{ client_id: string; income_type: IncomeType; n: number }>(sql`
      select e.client_id, e.income_type, count(*)::int as n
      from employees e join clients c on c.id = e.client_id
      where c.active = true and e.active = true
        and (e.resign_date is null or e.resign_date >= ${start}::date)
        and (e.hire_date is null or e.hire_date <= ${end}::date)
      group by e.client_id, e.income_type
    `)
  ).rows;
  // 2) 이 지급월의 급여 월 + 행 집계 (소득구분별 인원, 주민번호 누락)
  const monthRows = (
    await ctx.db.execute<{
      id: string;
      client_id: string;
      period: string;
      status: string;
      wizard_step: number;
      pending: number | null;
      blocking: number | null;
      created_at: Date | string;
      confirmed_at: Date | string | null;
      earned: number;
      business: number;
      daily: number;
      missing_id: number;
    }>(sql`
      select pm.id, pm.client_id, pm.period, pm.status, pm.wizard_step,
        (pm.totals->>'pendingReview')::int as pending,
        (pm.totals->'validation'->>'blocking')::int as blocking,
        pm.created_at, pm.confirmed_at,
        count(pi.id) filter (where pi.income_type = 'earned')::int as earned,
        count(pi.id) filter (where pi.income_type = 'business')::int as business,
        count(pi.id) filter (where pi.income_type = 'daily')::int as daily,
        count(pi.id) filter (where e.id_number_enc is null)::int as missing_id
      from payroll_months pm
      left join payroll_items pi on pi.payroll_month_id = pm.id
      left join employees e on e.id = pi.employee_id
      where pm.payment_period = ${P}
      group by pm.id
      order by pm.period
    `)
  ).rows;
  // 3) 신고 작업 (월 작업 + 반기 묶음 작업)
  const jobRows: FilingJobRow[] = await ctx.db.select().from(filingJobs).where(inArray(filingJobs.period, [...new Set([P, half])]));
  // 4) 접수증·납부서 수
  const jobIds = jobRows.map((j) => j.id);
  const resRows = jobIds.length
    ? (
        await ctx.db.execute<{ filing_job_id: string; kind: string; n: number }>(sql`
          select filing_job_id, kind, count(*)::int as n from filing_results
          where filing_job_id = any(${sql.param(jobIds)}::uuid[]) group by filing_job_id, kind
        `)
      ).rows
    : [];
  // 5) 급여 파일 서식 경고 (MOCK)
  const monthIds = monthRows.map((m) => m.id);
  const expRows = monthIds.length
    ? (
        await ctx.db.execute<{ month_id: string; template_status: string | null }>(sql`
          select validation->>'payrollMonthId' as month_id, validation->>'templateStatus' as template_status
          from export_jobs
          where kind in ('payroll_earned', 'payroll_business', 'payroll_daily')
            and status in ('ready', 'downloaded', 'uploaded_confirmed')
            and validation->>'payrollMonthId' = any(${sql.param(monthIds)}::text[])
        `)
      ).rows
    : [];
  // 6) 수임처
  const ids = [...new Set([...empRows.map((r) => r.client_id), ...monthRows.map((r) => r.client_id), ...jobRows.map((r) => r.clientId)])];
  if (input.clientId) ids.splice(0, ids.length, ...ids.filter((x) => x === input.clientId));
  const clientRows = ids.length
    ? (
        await ctx.db.execute<{ id: string; name: string; code: string; assignee_id: string | null; semiannual: boolean }>(sql`
          select c.id, c.name, c.code, c.assignee_id, coalesce(p.withholding_semiannual, false) as semiannual
          from clients c left join client_business_profiles p on p.client_id = c.id
          where c.id = any(${sql.param(ids)}::uuid[])
        `)
      ).rows
    : [];

  const empBy = new Map<string, Record<IncomeType, number>>();
  for (const r of empRows) {
    const x = empBy.get(r.client_id) ?? zero();
    x[r.income_type] += Number(r.n);
    empBy.set(r.client_id, x);
  }
  const resBy = new Map<string, { receipts: number; paymentSlips: number }>();
  for (const r of resRows) {
    const x = resBy.get(r.filing_job_id) ?? { receipts: 0, paymentSlips: 0 };
    if (r.kind === 'receipt') x.receipts += Number(r.n);
    if (r.kind === 'payment_slip') x.paymentSlips += Number(r.n);
    resBy.set(r.filing_job_id, x);
  }
  const mockMonths = new Set(expRows.filter((r) => r.template_status === 'mock').map((r) => r.month_id));
  const earnedDetail = simplifiedStatementDueDetail('earned', P, calOpts);

  const rows: FilingBoardRowDTO[] = [];
  for (const c of clientRows) {
    const months = monthRows.filter((m) => m.client_id === c.id);
    const jobs = jobRows.filter((j) => j.clientId === c.id);
    const monthInputs: BoardMonthInput[] = months.map((m) => ({
      id: m.id,
      period: m.period,
      status: m.status,
      wizardStep: Number(m.wizard_step),
      pendingReview: Number(m.pending ?? 0),
      validationBlocking: m.blocking === null ? null : Number(m.blocking),
      missingId: Number(m.missing_id),
      createdAt: toIso(m.created_at)!,
      confirmedAt: toIso(m.confirmed_at),
      headcountByType: { earned: Number(m.earned), business: Number(m.business), daily: Number(m.daily) },
    }));
    const jobInputs: BoardJobInput[] = jobs
      .filter((j) => isFilingKind(j.kind))
      .map((j) => {
        const p = payloadOf(j);
        const r = resBy.get(j.id) ?? { receipts: 0, paymentSlips: 0 };
        return {
          id: j.id,
          kind: j.kind as FilingKind,
          period: j.period,
          dueDate: j.dueDate,
          steps: j.steps ?? {},
          monthsIncluded: Object.keys(p.months ?? {}),
          incomeTax: p.totals?.incomeTax ?? 0,
          localIncomeTax: p.totals?.localIncomeTax ?? 0,
          receipts: r.receipts,
          paymentSlips: r.paymentSlips,
        };
      });
    const active = empBy.get(c.id) ?? zero();
    const headcount = zero();
    for (const m of monthInputs) for (const t of ['earned', 'business', 'daily'] as const) headcount[t] += m.headcountByType[t];
    const present = (t: IncomeType) => (monthInputs.length ? headcount[t] > 0 : active[t] > 0);
    const any = present('earned') || present('business') || present('daily');
    const whPeriod = c.semiannual ? half : P;
    const includeTargets: BoardClientInput['includeTargets'] = {};
    if (any) {
      includeTargets.withholding = whPeriod;
      includeTargets.local_income_tax = whPeriod;
    }
    if (present('business')) includeTargets.simplified_statement_business = P;
    if (present('daily')) includeTargets.daily_statement = P;
    if (present('earned')) includeTargets.simplified_statement_earned = earnedDetail.submissionPeriod.to;

    const expected = new Map<string, { kind: FilingKind; period: string; dueDate: string }>();
    const addExpected = (kind: FilingKind, dueDate: string) => {
      const j = jobInputs.find((x) => x.kind === kind && x.period === P);
      expected.set(kind, { kind, period: P, dueDate: j?.dueDate ?? dueDate });
    };
    if (any && whPeriod === P) {
      const due = withholdingDueDate(P, c.semiannual, calOpts);
      addExpected('withholding', due);
      addExpected('local_income_tax', due);
    }
    if (present('business')) addExpected('simplified_statement_business', simplifiedStatementDueDate('business', P, calOpts));
    if (present('daily')) addExpected('daily_statement', simplifiedStatementDueDate('daily', P, calOpts));
    if (present('earned') && earnedDetail.submissionPeriod.to === P) addExpected('simplified_statement_earned', earnedDetail.dueDate);
    for (const j of jobInputs) if (j.period === P && !expected.has(j.kind)) expected.set(j.kind, { kind: j.kind, period: P, dueDate: j.dueDate ?? P });

    const input2: BoardClientInput = {
      clientId: c.id,
      clientName: c.name,
      semiannual: c.semiannual,
      activeEmployees: active,
      months: monthInputs,
      jobs: jobInputs,
      expected: [...expected.values()],
      includeTargets,
      exportWarnings: months.some((m) => mockMonths.has(m.id)) ? ['WEHAGO 급여 서식 MOCK — 실제 서식 등록 전에는 급여 파일을 WEHAGO에 올리지 마세요'] : [],
    };
    const d = deriveBoardRow(input2, P, today);
    rows.push({
      clientId: c.id,
      clientName: c.name,
      clientCode: c.code,
      assigneeId: c.assignee_id,
      cycle: c.semiannual ? 'semiannual' : 'monthly',
      cycleLabel: c.semiannual ? '반기' : '매월',
      dueDate: d.dueDate,
      dDay: d.dDay,
      dDayLabel: d.dDayLabel,
      steps: d.steps,
      blockers: d.blockers,
      nextAction: d.nextAction,
      complete: d.complete,
      overdue: d.overdue,
      filingDueThisPeriod: d.filingDueThisPeriod,
      payrollMonths: monthInputs.map((m) => ({ id: m.id, period: m.period, status: m.status, wizardStep: m.wizardStep, pendingReview: m.pendingReview, href: payrollHref(c.id, m.period) })),
      jobs: jobs.filter((j) => isFilingKind(j.kind)).map((j) => toJobSummary(j, resBy.get(j.id) ?? { receipts: 0, paymentSlips: 0 })),
    });
  }

  const stepStatus = (r: FilingBoardRowDTO, step: string) => r.steps.find((s) => s.step === step)?.status;
  const summary = {
    clients: rows.length,
    dueSoonUnfiled: rows.filter((r) => r.dDay !== null && r.dDay >= 0 && r.dDay <= 7 && stepStatus(r, 'filed') !== 'done').length,
    overdue: rows.filter((r) => r.overdue).length,
    receiptsMissing: rows.filter((r) => stepStatus(r, 'filed') === 'attention').length,
    payrollUnconfirmed: rows.filter((r) => r.steps.some((s) => ['earned_confirmed', 'business_confirmed', 'daily_confirmed'].includes(s.step) && (s.status === 'pending' || s.status === 'overdue'))).length,
    complete: rows.filter((r) => r.complete).length,
  };
  let out = rows;
  if (input.onlyIncomplete) out = out.filter((r) => !r.complete);
  if (input.dueWithinDays !== undefined && input.dueWithinDays !== null) {
    const n = Number(input.dueWithinDays);
    out = out.filter((r) => !r.complete && r.dDay !== null && r.dDay <= n);
  }
  out.sort((a, b) => (a.dDay ?? 99_999) - (b.dDay ?? 99_999) || Number(a.complete) - Number(b.complete) || a.clientName.localeCompare(b.clientName, 'ko'));
  return {
    period: P,
    today,
    rows: out,
    summary,
    stepLabels: FILING_STEPS.map((step) => ({ step, label: FILING_STEP_LABELS[step] })),
    integration: { status: 'FILE_BASED', message: FILING_INTEGRATION_MESSAGE },
  };
}
