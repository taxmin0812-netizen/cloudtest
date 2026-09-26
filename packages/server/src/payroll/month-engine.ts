/**
 * 급여 월 재계산 엔진 — 전월 대비 변동(core diffPayroll)을 계산해 payroll_items.change_kinds/needs_review,
 * payroll_months.diff_summary/totals.pendingReview/wizard_step 에 저장한다.
 *
 * "검토 대기" = core 가 needsReview 로 판정했고 아직 사람이 확인(승인·수정·결정)하지 않은 사람.
 *  - 이번 달 행이 있는 사람: payroll_items.reviewed_at 이 있으면 확인됨
 *  - 이번 달 행이 없는 사람(명단 없음·퇴사): payroll_months.totals.decisions 에 결정이 있으면 확인됨
 */
import { sql } from 'drizzle-orm';
import { payrollItems } from '@mintax/db';
import { previousYearMonth, type PayrollChangeKind, type PayrollLine, type RiskSeverity } from '@mintax/core';
import { diffPayroll, formatDiffSummary, type PayrollDiffResult } from '@mintax/core/payroll/index';
import type { ServiceContext } from '../context';
import { SETTING_KEYS, getSetting } from '../infra/settings';
import { CHANGE_KIND_LABELS, LOCKED_STATUSES, amountsOf, chunk, incomeTypeLabel, itemToLine, sumLines, toIso } from './helpers';
import {
  loadEmployeeRows,
  loadItemRows,
  loadMonthContext,
  loadPreviousMonth,
  patchTotals,
  snapshotOf,
  totalsOf,
  type EmployeeRow,
  type MonthContext,
  type PayrollItemRow,
  type PayrollMonthRow,
} from './store';
import type { PayrollChangeDTO, PayrollDecision, PayrollDiffDTO } from './types';

/**
 * view: 3단계 화면을 열었음 (앞으로만 이동)
 * reviewed: 사람이 확인만 함 (데이터 변경 없음)
 * data_changed: 금액·명단이 바뀜 (검증·파일 단계를 다시 해야 함 → 최대 4단계)
 * none: 단계 이동 없음
 */
export type RecomputeMode = 'view' | 'reviewed' | 'data_changed' | 'none';

export interface MonthState {
  mc: MonthContext;
  employees: EmployeeRow[];
  empById: Map<string, EmployeeRow>;
  items: PayrollItemRow[];
  itemByEmp: Map<string, PayrollItemRow>;
  prev: PayrollMonthRow | null;
  prevLines: PayrollLine[];
  currLines: PayrollLine[];
  diff: PayrollDiffResult;
  pending: number;
  dto: PayrollDiffDTO;
}

const SEVERITY_RANK: Record<RiskSeverity, number> = { info: 0, warning: 1, high: 2 };

export async function loadLargeChangePct(ctx: Pick<ServiceContext, 'db'>): Promise<number> {
  const v = await getSetting<unknown>(ctx, SETTING_KEYS.payrollLargeChangePct, 20);
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

export function nameOf(empById: Map<string, EmployeeRow>, employeeId: string): string {
  return empById.get(employeeId)?.name ?? '(알 수 없는 직원)';
}

/** 월 상태 적재 + diff 계산 (저장 없음) */
export async function computeMonthState(ctx: ServiceContext, payrollMonthId: string, mcIn?: MonthContext): Promise<Omit<MonthState, 'dto' | 'pending'> & { reviewedOf: (employeeId: string) => { reviewed: boolean; at: string | null; decision: PayrollDecision | null } }> {
  const mc = mcIn ?? (await loadMonthContext(ctx, payrollMonthId));
  const m = mc.month;
  const [employees, items, prev, largeChangePct] = await Promise.all([
    loadEmployeeRows(ctx, m.clientId),
    loadItemRows(ctx, m.id),
    loadPreviousMonth(ctx, m.clientId, m.period),
    loadLargeChangePct(ctx),
  ]);
  const empById = new Map(employees.map((e) => [e.id, e]));
  const prevItems = prev ? await loadItemRows(ctx, prev.id) : [];
  const prevLines = prevItems.map((i) => itemToLine(i, nameOf(empById, i.employeeId)));
  const currLines = items.map((i) => itemToLine(i, nameOf(empById, i.employeeId)));
  const snaps = employees.map(snapshotOf);
  const diff = diffPayroll({ employees: snaps, lines: prevLines }, { employees: snaps, lines: currLines }, { period: m.period, largeChangePct });
  const itemByEmp = new Map(items.map((i) => [i.employeeId, i]));
  const decisions = totalsOf(m).decisions ?? {};
  const reviewedOf = (employeeId: string) => {
    const item = itemByEmp.get(employeeId);
    const d = decisions[employeeId];
    if (item?.reviewedAt) return { reviewed: true, at: toIso(item.reviewedAt), decision: d?.decision ?? null };
    if (d) return { reviewed: true, at: d.at, decision: d.decision };
    return { reviewed: false, at: null, decision: null };
  };
  return { mc, employees, empById, items, itemByEmp, prev, prevLines, currLines, diff, reviewedOf };
}

function nextWizardStep(current: number, pending: number, mode: RecomputeMode): number {
  switch (mode) {
    case 'view':
    case 'reviewed':
      return pending > 0 ? 3 : Math.max(current, 4);
    case 'data_changed':
      return pending > 0 ? 3 : 4;
    case 'none':
    default:
      return current;
  }
}

/**
 * diff 를 계산해 저장하고 3단계 DTO 를 돌려준다. 확정된 달은 읽기만 한다.
 */
export async function recomputeMonth(ctx: ServiceContext, payrollMonthId: string, mode: RecomputeMode, mcIn?: MonthContext): Promise<MonthState> {
  const s = await computeMonthState(ctx, payrollMonthId, mcIn);
  const { mc, diff, itemByEmp, empById } = s;
  const m = mc.month;
  const locked = LOCKED_STATUSES.has(m.status);

  // 1) 급여행 변동 분류 저장 (바뀐 행만, 500건 단위)
  const updates: Array<{ id: string; kinds: string[]; needsReview: boolean }> = [];
  for (const c of diff.changes) {
    const item = c.employeeId ? itemByEmp.get(c.employeeId) : undefined;
    if (!item) continue;
    const same = item.needsReview === c.needsReview && JSON.stringify(item.changeKinds ?? []) === JSON.stringify(c.kinds);
    if (!same) updates.push({ id: item.id, kinds: c.kinds, needsReview: c.needsReview });
  }
  if (!locked) {
    for (const part of chunk(updates)) {
      const values = sql.join(
        part.map((u) => sql`(${u.id}::uuid, ${JSON.stringify(u.kinds)}::jsonb, ${u.needsReview}::boolean)`),
        sql`, `,
      );
      await ctx.db.execute(sql`
        update ${payrollItems} as p set change_kinds = v.kinds, needs_review = v.nr
        from (values ${values}) as v(id, kinds, nr)
        where p.id = v.id
      `);
    }
    const byId = new Map(s.items.map((i) => [i.id, i]));
    for (const u of updates) {
      const item = byId.get(u.id);
      if (item) {
        item.changeKinds = u.kinds;
        item.needsReview = u.needsReview;
      }
    }
  }

  // 2) 검토 대기 / 요약
  let pending = 0;
  let reviewedCount = 0;
  let unchangedGross = 0;
  const changes: PayrollChangeDTO[] = [];
  const kindCounts: Partial<Record<PayrollChangeKind, number>> = {};
  for (const c of diff.changes) {
    for (const k of c.kinds) kindCounts[k] = (kindCounts[k] ?? 0) + 1;
    const r = s.reviewedOf(c.employeeId);
    const item = itemByEmp.get(c.employeeId) ?? null;
    const isUnchanged = c.kinds.length === 1 && c.kinds[0] === 'unchanged';
    if (isUnchanged) unchangedGross += c.current?.grossPay ?? 0;
    if (c.needsReview && !r.reviewed) pending++;
    const show = c.needsReview || (r.reviewed && !isUnchanged) || !!r.decision;
    if (!show) continue;
    if (r.reviewed) reviewedCount++;
    const emp = empById.get(c.employeeId);
    const actions: PayrollChangeDTO['actions'] = item ? ['approve', 'edit', 'resigned', 'on_leave'] : ['resigned', 'keep', 'on_leave'];
    if (item && c.kinds.includes('new_hire')) actions.push('keep');
    changes.push({
      employeeId: c.employeeId,
      itemId: item?.id ?? null,
      name: c.name,
      incomeType: c.incomeType,
      incomeTypeLabel: incomeTypeLabel(c.incomeType),
      kinds: c.kinds,
      kindLabels: c.kinds.map((k) => CHANGE_KIND_LABELS[k]),
      severity: c.severity,
      messages: c.messages,
      previous: c.previous ? amountsOf(c.previous) : null,
      current: c.current ? amountsOf(c.current) : null,
      changeRate: c.changeRate,
      grossDelta: c.previous && c.current ? c.current.grossPay - c.previous.grossPay : c.previous ? -c.previous.grossPay : c.current ? c.current.grossPay : null,
      idNumberMasked: emp?.idNumberMasked ?? null,
      reviewed: r.reviewed,
      reviewedAt: r.at,
      decision: r.decision,
      actions,
    });
  }
  changes.sort(
    (a, b) =>
      Number(a.reviewed) - Number(b.reviewed) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.name.localeCompare(b.name, 'ko'),
  );

  const sums = sumLines(s.currLines);
  const diffSummary: Record<string, number> = { ...diff.summary, ...kindCounts, pending };
  const wizardStep = locked ? m.wizardStep : nextWizardStep(m.wizardStep, pending, mode);
  const status = locked ? m.status : m.status === 'draft' && mode !== 'none' ? 'reviewing' : m.status;
  if (!locked) {
    await patchTotals(
      ctx,
      m.id,
      {
        headcount: sums.headcount,
        taxablePay: sums.taxablePay,
        nonTaxablePay: sums.nonTaxablePay,
        grossPay: sums.grossPay,
        incomeTax: sums.incomeTax,
        localIncomeTax: sums.localIncomeTax,
        otherDeductions: sums.otherDeductions,
        netPay: sums.netPay,
        byIncomeType: sums.byIncomeType,
        pendingReview: pending,
      },
      { diffSummary, wizardStep, status },
    );
    m.diffSummary = diffSummary;
    m.wizardStep = wizardStep;
    m.status = status;
    m.totals = { ...(m.totals ?? {}), ...sums, pendingReview: pending };
  }

  const warnings: string[] = [];
  if (!s.prev) warnings.push(`전월(${previousYearMonth(m.period)}) 급여가 없어 전원이 새 인원으로 표시됩니다 (첫 달).`);
  else if (!LOCKED_STATUSES.has(s.prev.status)) warnings.push(`전월(${s.prev.period}) 급여가 확정 전입니다 — 전월 값이 바뀌면 비교 결과도 바뀝니다.`);
  const carry = totalsOf(m).carry;
  if (carry) warnings.push(...carry.notes);

  const dto: PayrollDiffDTO = {
    payrollMonthId: m.id,
    clientId: m.clientId,
    clientName: mc.clientName,
    period: m.period,
    paymentPeriod: m.paymentPeriod,
    previousPeriod: s.prev?.period ?? previousYearMonth(m.period),
    previousMonthId: s.prev?.id ?? null,
    previousStatus: s.prev?.status ?? null,
    summary: diff.summary,
    summaryText: formatDiffSummary(diff.summary),
    changes,
    pendingCount: pending,
    reviewedCount,
    unchangedCount: diff.summary.unchanged,
    unchangedGrossPay: unchangedGross,
    wizardStep,
    status,
    warnings,
  };
  return { ...s, pending, dto };
}
