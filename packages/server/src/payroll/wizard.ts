/**
 * 월 급여 마법사 1~4단계 (멱등·재개 가능, payroll_months.wizard_step).
 *
 * 1 startPayrollMonth      전월 복사(core carryForward) → 이번 달 초안. 이미 있으면 그대로 돌려준다.
 * 2 applyPayrollRows       수임처 제출 자료 반영 (같으면 carried_forward 유지, 다르면 imported, 전체 명단이면 빠진 사람은 '명단 없음')
 * 3 getPayrollDiff         전월 대비 변동 — 바뀐 사람만 보여 준다 / approveChanges / confirmNewAndResigned
 * 4 validatePayrollMonth   세액 재계산·검산 / updatePayrollItem (사람 수정 = 확인)
 *
 * 인건비 수동 터치 KPI: 사람의 직원 단위 행동(승인·수정·결정) 1회 = 1 → payroll_months.totals.manualTouches
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { payrollItems, payrollMonths } from '@mintax/db';
import { formatWon, previousYearMonth, yearMonthOf, type PayrollLine } from '@mintax/core';
import { carryForwardWithReport, lastDayOfMonth, type EmployeeMaster } from '@mintax/core/payroll/index';
import { cellText, isAdapterError, isBlankRow, normalizeHeader, readTabularFile } from '@mintax/adapters';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit, writeAuditMany, type AuditEntry } from '../infra/audit';
import { storeFile } from '../infra/storage';
import { detachMonthFromFilingJobs } from '../filing/sync';
import { patchEmployeeInternal } from './employees';
import { listPayrollExportJobs } from './exports';
import {
  CHANGE_KIND_LABELS,
  LOCKED_STATUSES,
  amountsOf,
  assertPeriod,
  assertUuid,
  chunk,
  describeAmountChange,
  employeesHref,
  incomeTypeLabel,
  isLocalDate,
  itemToLine,
  parseInput,
  payrollHref,
  recomputeLine,
  sameAmounts,
  toIso,
} from './helpers';
import { computeMonthState, nameOf, recomputeMonth, type RecomputeMode } from './month-engine';
import {
  addManualTouches,
  blockStalePayrollExports,
  findMonthRow,
  loadClientBasics,
  loadEmployeeCodes,
  loadEmployeeRows,
  loadItemRows,
  loadMonthContext,
  loadPreviousMonth,
  lockPayroll,
  patchTotals,
  refreshUnreviewedNotice,
  toMonthDTO,
  totalsOf,
  type EmployeeRow,
  type MonthContext,
  type MonthTotals,
  type PayrollItemRow,
} from './store';
import { runPayrollValidation } from './validation';
import type {
  ApplyPayrollRowsInput,
  ApplyPayrollRowsResult,
  ApproveChangesResult,
  PayrollDecision,
  PayrollDiffDTO,
  PayrollExportJobDTO,
  PayrollItemDTO,
  PayrollMonthDTO,
  PayrollMonthDetailDTO,
  PayrollValidationDTO,
  StartPayrollMonthResult,
  UpdatePayrollItemInput,
  UpdatePayrollItemResult,
} from './types';

export const STALE_EXPORT_REASON = '파일 생성 뒤 급여가 바뀌었습니다 — WEHAGO 급여 파일을 다시 만드세요.';

// ────────────────────────────── 공통 ──────────────────────────────

export function lockedError(mc: MonthContext): AppError {
  return new AppError({
    code: 'PAYROLL_LOCKED',
    httpStatus: 409,
    userMessage: `확정된 급여입니다 (${mc.clientName} ${mc.month.period}). 수정하려면 확정을 되돌려야 합니다(관리자 — 변경 되돌리기 권한).`,
    action: { label: '급여 월 보기', href: payrollHref(mc.month.clientId, mc.month.period) },
  });
}

function assertEditable(mc: MonthContext): void {
  if (LOCKED_STATUSES.has(mc.month.status)) throw lockedError(mc);
}

/** 트랜잭션 + 월 잠금 */
async function inMonthTx<T>(ctx: ServiceContext, payrollMonthId: string, fn: (t: ServiceContext, mc: MonthContext) => Promise<T>): Promise<T> {
  assertUuid(payrollMonthId, 'payrollMonthId', '급여 월');
  const head = await loadMonthContext(ctx, payrollMonthId);
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    await lockPayroll(t, head.month.clientId, head.month.period);
    const mc = await loadMonthContext(t, payrollMonthId, { forUpdate: true });
    return fn(t, mc);
  });
}

function monthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return yb * 12 + mb - (ya * 12 + ma);
}

function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function dateInPeriod(period: string, day: number): string {
  const last = Number(lastDayOfMonth(period).slice(8, 10));
  return `${period}-${String(Math.min(Math.max(1, day), last)).padStart(2, '0')}`;
}

function masterOf(e: EmployeeRow): EmployeeMaster {
  return {
    employeeId: e.id,
    name: e.name,
    incomeType: e.incomeType,
    hasIdNumber: !!e.idNumberEnc,
    idNumberMasked: e.idNumberMasked,
    hireDate: e.hireDate,
    resignDate: e.resignDate,
    baseSalary: e.baseSalary,
    allowances: e.allowances ?? {},
    nonTaxable: e.nonTaxable ?? {},
    dailyWage: e.dailyWage,
    businessIncomeCode: e.businessIncomeCode,
    paymentDay: e.paymentDay,
    active: e.active,
  };
}

function itemValues(line: PayrollLine) {
  return {
    incomeType: line.incomeType,
    taxablePay: line.taxablePay,
    nonTaxablePay: line.nonTaxablePay,
    grossPay: line.grossPay,
    allowances: line.allowances,
    workDays: line.workDays ?? null,
    incomeTax: line.incomeTax,
    localIncomeTax: line.localIncomeTax,
    otherDeductions: line.otherDeductions,
    netPay: line.netPay,
    paymentDate: line.paymentDate,
  };
}

export function toItemDTO(item: PayrollItemRow, emp: EmployeeRow | undefined, code: string | undefined): PayrollItemDTO {
  return {
    id: item.id,
    payrollMonthId: item.payrollMonthId,
    employeeId: item.employeeId,
    name: emp?.name ?? '(알 수 없는 직원)',
    employeeCode: code ?? '',
    incomeType: item.incomeType,
    incomeTypeLabel: incomeTypeLabel(item.incomeType),
    idNumberMasked: emp?.idNumberMasked ?? null,
    hasIdNumber: !!emp?.idNumberEnc,
    taxablePay: item.taxablePay,
    nonTaxablePay: item.nonTaxablePay,
    grossPay: item.grossPay,
    allowances: item.allowances ?? {},
    workDays: item.workDays,
    incomeTax: item.incomeTax,
    localIncomeTax: item.localIncomeTax,
    otherDeductions: item.otherDeductions,
    netPay: item.netPay,
    paymentDate: item.paymentDate,
    changeKinds: item.changeKinds ?? [],
    needsReview: item.needsReview,
    reviewed: !!item.reviewedAt,
    reviewedAt: toIso(item.reviewedAt),
    origin: item.origin,
  };
}

// ────────────────────────────── 1단계: 급여 월 시작 ──────────────────────────────

export interface StartInternalResult {
  monthId: string;
  created: boolean;
  carried: StartPayrollMonthResult['carried'];
}

/** 권한 검사 없음 (payroll_prepare 작업·startPayrollMonth 공용) */
export async function startPayrollMonthInternal(ctx: ServiceContext, input: { clientId: string; period: string; paymentPeriod?: string | null }): Promise<StartInternalResult> {
  const period = assertPeriod(input.period);
  if (input.paymentPeriod) assertPeriod(input.paymentPeriod, 'paymentPeriod', '지급월');
  const client = await loadClientBasics(ctx, input.clientId);
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    await lockPayroll(t, client.id, period);
    const existing = await findMonthRow(t, client.id, period);
    if (existing) {
      const carry = totalsOf(existing).carry;
      return { monthId: existing.id, created: false, carried: carry ?? { carriedForward: 0, fromMaster: 0, excluded: [], notes: [] } };
    }
    if (!client.active) {
      throw new AppError({ code: 'CLIENT_INACTIVE', httpStatus: 409, userMessage: `${client.name}은(는) 비활성 수임처입니다. 급여를 시작하려면 먼저 수임처를 활성화하세요.` });
    }
    const employees = await loadEmployeeRows(t, client.id);
    const prev = await loadPreviousMonth(t, client.id, period);
    const empById = new Map(employees.map((e) => [e.id, e]));
    const prevItems = prev ? await loadItemRows(t, prev.id) : [];
    const prevLines = prevItems.map((i) => itemToLine(i, nameOf(empById, i.employeeId)));
    const report = carryForwardWithReport(prevLines, employees.map(masterOf), period);
    if (report.lines.length === 0) {
      throw new AppError({
        code: 'PAYROLL_NO_EMPLOYEES',
        httpStatus: 409,
        userMessage: `${client.name}에 ${period} 급여 대상 직원이 없습니다. 직원을 먼저 등록하세요.`,
        action: { label: '직원 등록', href: employeesHref(client.id) },
      });
    }
    let paymentPeriod = input.paymentPeriod ?? null;
    if (!paymentPeriod && prev) paymentPeriod = addMonths(period, monthsBetween(prev.period, prev.paymentPeriod));
    if (!paymentPeriod) {
      const counts = new Map<string, number>();
      for (const l of report.lines) if (l.paymentDate) counts.set(yearMonthOf(l.paymentDate), (counts.get(yearMonthOf(l.paymentDate)) ?? 0) + 1);
      paymentPeriod = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? period;
    }
    const fromMaster = Object.values(report.origins).filter((o) => o === 'master').length;
    const carried = { carriedForward: report.lines.length - fromMaster, fromMaster, excluded: report.excluded, notes: report.notes };
    const totals: Partial<MonthTotals> = { manualTouches: 0, pendingReview: 0, carry: carried };
    const [month] = await t.db
      .insert(payrollMonths)
      .values({ clientId: client.id, period, paymentPeriod, wizardStep: 2, status: 'draft', totals, createdAt: ctx.now(), updatedAt: ctx.now() })
      .returning({ id: payrollMonths.id });
    const monthId = month!.id;
    for (const part of chunk(report.lines)) {
      await t.db.insert(payrollItems).values(
        part.map((l) => ({
          payrollMonthId: monthId,
          employeeId: l.employeeId,
          ...itemValues(l),
          origin: report.origins[l.employeeId] === 'master' ? 'master' : 'carried_forward',
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        })),
      );
    }
    await writeAudit(t, {
      action: 'payroll.start',
      category: 'data_change',
      entityType: 'payroll_month',
      entityId: monthId,
      clientId: client.id,
      summary: `${client.name} ${period} 급여 시작 (지급 ${paymentPeriod}): 전월 복사 ${carried.carriedForward}명, 직원 마스터 ${fromMaster}명${report.excluded.length ? `, 제외 ${report.excluded.length}명` : ''}`,
      after: { period, paymentPeriod, headcount: report.lines.length, carriedForward: carried.carriedForward, fromMaster, excluded: report.excluded.length },
    });
    await recomputeMonth(t, monthId, 'none');
    return { monthId, created: true, carried };
  });
}

/** 1단계 — 전월 복사로 이번 달 초안 생성. 이미 있으면 그대로 돌려준다 (멱등) */
export async function startPayrollMonth(ctx: ServiceContext, input: { clientId: string; period: string; paymentPeriod?: string | null }): Promise<StartPayrollMonthResult> {
  requirePermission(ctx, 'payroll.write');
  assertUuid(input?.clientId, 'clientId', '수임처');
  const r = await startPayrollMonthInternal(ctx, input);
  const mc = await loadMonthContext(ctx, r.monthId);
  await refreshUnreviewedNotice(ctx, mc.month.period);
  return { ...(await toMonthDTO(ctx, mc)), created: r.created, carried: r.carried };
}

export async function getPayrollMonth(ctx: ServiceContext, payrollMonthId: string): Promise<PayrollMonthDetailDTO> {
  requirePermission(ctx, 'payroll.read');
  assertUuid(payrollMonthId, 'payrollMonthId', '급여 월');
  const mc = await loadMonthContext(ctx, payrollMonthId);
  const [items, employees, codes] = await Promise.all([loadItemRows(ctx, mc.month.id), loadEmployeeRows(ctx, mc.month.clientId), loadEmployeeCodes(ctx, mc.month.clientId)]);
  const empById = new Map(employees.map((e) => [e.id, e]));
  const exports: PayrollExportJobDTO[] = await listPayrollExportJobs(ctx, mc.month.id);
  return {
    ...(await toMonthDTO(ctx, mc)),
    items: items
      .map((i) => toItemDTO(i, empById.get(i.employeeId), codes[i.employeeId]?.code))
      .sort((a, b) => a.incomeType.localeCompare(b.incomeType) || a.name.localeCompare(b.name, 'ko')),
    exports,
  };
}

export async function findPayrollMonth(ctx: ServiceContext, input: { clientId: string; period: string }): Promise<PayrollMonthDTO | null> {
  requirePermission(ctx, 'payroll.read');
  assertUuid(input?.clientId, 'clientId', '수임처');
  const row = await findMonthRow(ctx, input.clientId, assertPeriod(input.period));
  if (!row) return null;
  return toMonthDTO(ctx, await loadMonthContext(ctx, row.id));
}

// ────────────────────────────── 2단계: 자료 반영 ──────────────────────────────

const won = z.number().int('원 단위 정수여야 합니다').min(0, '0 이상이어야 합니다').max(Number.MAX_SAFE_INTEGER);
const rowSchema = z.object({
  employeeId: z.string().uuid().nullish(),
  employeeCode: z.string().trim().max(20).nullish(),
  name: z.string().trim().max(50).nullish(),
  taxablePay: won.nullish(),
  nonTaxablePay: won.nullish(),
  grossPay: won.nullish(),
  allowances: z.record(z.string().max(40), z.number().int()).nullish(),
  workDays: z.number().int().min(0).max(62).nullish(),
  incomeTax: won.nullish(),
  localIncomeTax: won.nullish(),
  otherDeductions: won.nullish(),
  paymentDate: z.string().refine(isLocalDate, '지급일 형식은 YYYY-MM-DD 입니다').nullish(),
  rowNumber: z.number().int().nullish(),
});
const applySchema = z.object({
  payrollMonthId: z.string().uuid(),
  rows: z.array(rowSchema).min(1, '반영할 행이 없습니다').max(10_000),
  fullRoster: z.boolean().optional(),
  sourceName: z.string().max(200).optional(),
});

/** 2단계 — 수임처 제출 자료 반영 (값이 같은 사람은 전월 복사 상태 유지 → 검토 대상 아님) */
export async function applyPayrollRows(ctx: ServiceContext, input: ApplyPayrollRowsInput): Promise<ApplyPayrollRowsResult> {
  requirePermission(ctx, 'payroll.write');
  const p = parseInput(applySchema, input, '급여 자료');
  const res = await inMonthTx(ctx, p.payrollMonthId, async (t, mc) => {
    assertEditable(mc);
    const m = mc.month;
    const [employees, items, codes] = await Promise.all([loadEmployeeRows(t, m.clientId), loadItemRows(t, m.id), loadEmployeeCodes(t, m.clientId)]);
    const empById = new Map(employees.map((e) => [e.id, e]));
    const itemByEmp = new Map(items.map((i) => [i.employeeId, i]));
    const byCode = new Map(Object.entries(codes).map(([id, c]) => [c.code, id]));
    const periodStart = `${m.period}-01`;
    const byName = new Map<string, EmployeeRow[]>();
    for (const e of employees) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
    const defaultPayDate = (() => {
      const counts = new Map<string, number>();
      for (const i of items) if (i.paymentDate) counts.set(i.paymentDate, (counts.get(i.paymentDate) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    })();

    const unmatched: ApplyPayrollRowsResult['unmatched'] = [];
    const notes: string[] = [];
    const audits: AuditEntry[] = [];
    const seen = new Set<string>();
    let changed = 0;
    let unchangedCount = 0;
    let added = 0;
    for (const [idx, r] of p.rows.entries()) {
      const rowNumber = r.rowNumber ?? idx + 1;
      const label = r.name || r.employeeCode || r.employeeId || `${rowNumber}행`;
      let emp: EmployeeRow | undefined;
      if (r.employeeId) {
        emp = empById.get(r.employeeId);
        if (!emp) {
          unmatched.push({ rowNumber, name: label, reason: '이 수임처의 직원이 아닙니다.' });
          continue;
        }
      } else if (r.employeeCode && byCode.has(r.employeeCode)) {
        emp = empById.get(byCode.get(r.employeeCode)!);
      } else if (r.name) {
        const cands = (byName.get(r.name) ?? []).filter((e) => e.active && !(e.resignDate && e.resignDate < periodStart));
        const all = byName.get(r.name) ?? [];
        const pick = cands.length === 1 ? cands : all.length === 1 ? all : [];
        if (pick.length === 1) emp = pick[0];
        else if (all.length > 1) {
          unmatched.push({ rowNumber, name: label, reason: `같은 이름의 직원이 ${all.length}명입니다 — 사원코드를 함께 넣어 주세요.` });
          continue;
        }
      }
      if (!emp) {
        unmatched.push({ rowNumber, name: label, reason: '직원 마스터에 없는 사람입니다 — 신규 입사자면 직원 등록 후 다시 반영하세요.' });
        continue;
      }
      if (seen.has(emp.id)) {
        unmatched.push({ rowNumber, name: emp.name, reason: '같은 직원의 행이 두 번 있습니다 — 합산하지 않았습니다. 한 행으로 합쳐 다시 올려 주세요.' });
        continue;
      }
      seen.add(emp.id);
      const item = itemByEmp.get(emp.id);
      const baseLine: PayrollLine = item
        ? itemToLine(item, emp.name)
        : {
            employeeId: emp.id,
            name: emp.name,
            incomeType: emp.incomeType,
            taxablePay: 0,
            nonTaxablePay: 0,
            grossPay: 0,
            allowances: {},
            incomeTax: 0,
            localIncomeTax: 0,
            otherDeductions: 0,
            netPay: 0,
            paymentDate: emp.paymentDay ? dateInPeriod(m.paymentPeriod, emp.paymentDay) : defaultPayDate,
          };
      const nonTaxable = r.nonTaxablePay ?? baseLine.nonTaxablePay;
      let taxable = r.taxablePay ?? baseLine.taxablePay;
      if ((r.taxablePay === null || r.taxablePay === undefined) && r.grossPay !== null && r.grossPay !== undefined) {
        taxable = r.grossPay - nonTaxable;
        if (taxable < 0) {
          unmatched.push({ rowNumber, name: emp.name, reason: `지급총액 ${formatWon(r.grossPay)}이 비과세 ${formatWon(nonTaxable)}보다 작습니다.` });
          continue;
        }
      }
      const draft: PayrollLine = {
        ...baseLine,
        taxablePay: taxable,
        nonTaxablePay: nonTaxable,
        allowances: r.allowances ?? baseLine.allowances,
        ...(r.workDays !== null && r.workDays !== undefined ? { workDays: r.workDays } : {}),
        incomeTax: emp.incomeType === 'earned' ? r.incomeTax ?? baseLine.incomeTax : baseLine.incomeTax,
        otherDeductions: r.otherDeductions ?? baseLine.otherDeductions,
        paymentDate: r.paymentDate ?? baseLine.paymentDate,
      };
      const { line } = recomputeLine(draft);
      if (emp.incomeType !== 'earned' && r.incomeTax !== null && r.incomeTax !== undefined && r.incomeTax !== line.incomeTax) {
        notes.push(`${emp.name}: 제출 소득세 ${formatWon(r.incomeTax)} ≠ 법정 산식 ${formatWon(line.incomeTax)} — 산식 값을 적용했습니다.`);
      }
      if (r.localIncomeTax !== null && r.localIncomeTax !== undefined && r.localIncomeTax !== line.localIncomeTax) {
        notes.push(`${emp.name}: 제출 지방소득세 ${formatWon(r.localIncomeTax)} ≠ 소득세의 10% ${formatWon(line.localIncomeTax)} — 10% 값을 적용했습니다.`);
      }
      if (emp.incomeType === 'earned' && item && line.taxablePay !== item.taxablePay && (r.incomeTax === null || r.incomeTax === undefined)) {
        notes.push(`${emp.name}: 과세급여가 바뀌었는데 소득세가 제출되지 않아 전월 세액을 유지했습니다 — WEHAGO 간이세액 확인 필요.`);
      }
      if (item) {
        const before = amountsOf(item);
        const after = amountsOf(line);
        if (sameAmounts(before, after) && JSON.stringify(item.allowances ?? {}) === JSON.stringify(line.allowances ?? {})) {
          unchangedCount++;
          continue;
        }
        await t.db
          .update(payrollItems)
          .set({ ...itemValues(line), origin: 'imported', reviewedAt: null, reviewedBy: null, updatedAt: ctx.now() })
          .where(eq(payrollItems.id, item.id));
        changed++;
        audits.push({
          action: 'payroll.item_import',
          category: 'data_change',
          entityType: 'payroll_item',
          entityId: item.id,
          clientId: m.clientId,
          summary: `자료 반영: ${describeAmountChange(emp.name, before, after)}`,
          before: { ...before },
          after: { ...after },
        });
      } else {
        const [ins] = await t.db
          .insert(payrollItems)
          .values({ payrollMonthId: m.id, employeeId: emp.id, ...itemValues(line), origin: 'imported', createdAt: ctx.now(), updatedAt: ctx.now() })
          .returning({ id: payrollItems.id });
        added++;
        audits.push({
          action: 'payroll.item_import',
          category: 'data_change',
          entityType: 'payroll_item',
          entityId: ins!.id,
          clientId: m.clientId,
          summary: `자료 반영: ${emp.name} 추가 (지급총액 ${formatWon(line.grossPay)})`,
          before: null,
          after: { ...amountsOf(line) },
        });
      }
    }

    const removedNotInRoster: ApplyPayrollRowsResult['removedNotInRoster'] = [];
    if (p.fullRoster) {
      const missing = items.filter((i) => !seen.has(i.employeeId));
      if (missing.length > 0) {
        await t.db.delete(payrollItems).where(inArray(payrollItems.id, missing.map((i) => i.id)));
        for (const i of missing) {
          const name = nameOf(empById, i.employeeId);
          removedNotInRoster.push({ employeeId: i.employeeId, name });
          audits.push({
            action: 'payroll.item_remove',
            category: 'data_change',
            entityType: 'payroll_item',
            entityId: i.id,
            clientId: m.clientId,
            summary: `자료 반영: ${name} 이번 달 명단에 없음 → 급여 행 제외 (지급총액 ${formatWon(i.grossPay)}, 3단계에서 퇴사·휴직 확인)`,
            before: { ...amountsOf(i), origin: i.origin },
            after: null,
          });
        }
      }
    }
    const summary = `${mc.clientName} ${m.period} 자료 반영${p.sourceName ? ` (${p.sourceName})` : ''}: 변경 ${changed}명, 동일 ${unchangedCount}명, 추가 ${added}명${removedNotInRoster.length ? `, 명단 없음 ${removedNotInRoster.length}명` : ''}${unmatched.length ? `, 반영 못함 ${unmatched.length}행` : ''}`;
    audits.push({
      action: 'payroll.import',
      category: 'data_change',
      entityType: 'payroll_month',
      entityId: m.id,
      clientId: m.clientId,
      summary,
      after: { changed, unchanged: unchangedCount, added, removed: removedNotInRoster.length, unmatched: unmatched.length, sourceName: p.sourceName ?? null },
    });
    await writeAuditMany(t, audits);
    const dataChanged = changed + added + removedNotInRoster.length > 0;
    await patchTotals(t, m.id, {
      import: { at: ctx.now().toISOString(), by: ctx.actor.name, sourceName: p.sourceName ?? null, changed, unchanged: unchangedCount, added, removed: removedNotInRoster.length, unmatched: unmatched.length },
    });
    if (dataChanged) await blockStalePayrollExports(t, m.id, STALE_EXPORT_REASON);
    const state = await recomputeMonth(t, m.id, dataChanged ? 'data_changed' : 'view', mc);
    return {
      payrollMonthId: m.id,
      matched: seen.size,
      changed,
      unchanged: unchangedCount,
      added,
      removedNotInRoster,
      unmatched,
      notes,
      diff: state.dto,
      summary,
    };
  });
  await refreshUnreviewedNotice(ctx, res.diff.period);
  return res;
}

const PAYROLL_HEADER_ALIASES: Record<string, string[]> = {
  name: ['성명', '이름', '사원명', '소득자명', '직원명'],
  employeeCode: ['사원코드', '사번', '사원번호', '소득자코드'],
  taxablePay: ['과세급여', '과세합계', '과세', '과세지급액'],
  nonTaxablePay: ['비과세', '비과세합계', '비과세급여'],
  grossPay: ['지급총액', '지급합계', '총지급액', '지급액', '급여총액'],
  workDays: ['근무일수', '근로일수', '출역일수'],
  incomeTax: ['소득세'],
  localIncomeTax: ['지방소득세', '주민세'],
  otherDeductions: ['기타공제', '공제합계', '4대보험'],
  paymentDate: ['지급일', '지급년월일', '지급일자'],
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,원\s]/g, '');
  return /^-?\d+(\.0+)?$/.test(s) ? Number(s) : null;
}

/** 2단계 — 수임처 급여 엑셀/CSV 반영 (제목행 자동 인식). 원본은 암호화 저장 */
export async function importPayrollFile(
  ctx: ServiceContext,
  input: { payrollMonthId: string; fileName: string; data: Buffer; fullRoster?: boolean },
): Promise<ApplyPayrollRowsResult & { fileId: string }> {
  requirePermission(ctx, 'payroll.write');
  const mc = await loadMonthContext(ctx, assertUuid(input?.payrollMonthId, 'payrollMonthId', '급여 월'));
  assertEditable(mc);
  if (!input.data || input.data.length === 0) throw new ValidationError('빈 파일입니다. 파일을 다시 선택해 주세요.');
  if (input.data.length > 20 * 1024 * 1024) throw new ValidationError('급여 파일은 20MB 이하만 올릴 수 있습니다.');
  let file;
  try {
    file = await readTabularFile(input.data, input.fileName);
  } catch (e) {
    if (isAdapterError(e)) throw new ValidationError(e.message);
    throw e;
  }
  const sheet = file.sheets.find((s) => !s.hidden && s.rows.length > 0);
  if (!sheet) throw new ValidationError('파일에 표가 없습니다.');
  const aliasToField = new Map<string, string>();
  for (const [f, list] of Object.entries(PAYROLL_HEADER_ALIASES)) for (const a of list) aliasToField.set(normalizeHeader(a), f);
  let headerIdx = -1;
  let cols: Array<string | null> = [];
  for (let r = 0; r < Math.min(sheet.rows.length, 15); r++) {
    const c = sheet.rows[r]!.map((x) => aliasToField.get(normalizeHeader(cellText(x))) ?? null);
    if ((c.includes('name') || c.includes('employeeCode')) && (c.includes('taxablePay') || c.includes('grossPay'))) {
      headerIdx = r;
      cols = c;
      break;
    }
  }
  if (headerIdx < 0) {
    throw new ValidationError('급여 파일에서 제목행(성명·과세급여 또는 지급총액)을 찾지 못했습니다. 급여대장 엑셀의 제목행을 확인해 주세요.');
  }
  const rows: ApplyPayrollRowsInput['rows'] = [];
  const bad: Array<{ rowNumber: number; name: string; reason: string }> = [];
  for (let r = headerIdx + 1; r < sheet.rows.length; r++) {
    const cells = sheet.rows[r]!;
    if (isBlankRow(cells)) continue;
    const rec: Record<string, unknown> = {};
    cols.forEach((f, j) => {
      if (f) rec[f] = cells[j] ?? null;
    });
    const name = cellText(rec.name);
    if (/^(합계|총계|소계)$/.test(name.replace(/\s/g, ''))) continue;
    const amounts: Record<string, number | null> = {};
    let invalid = false;
    for (const f of ['taxablePay', 'nonTaxablePay', 'grossPay', 'workDays', 'incomeTax', 'localIncomeTax', 'otherDeductions']) {
      if (rec[f] === undefined) continue;
      const n = num(rec[f]);
      if (rec[f] !== null && rec[f] !== '' && (n === null || !Number.isSafeInteger(n) || n < 0)) invalid = true;
      amounts[f] = n;
    }
    if (invalid) {
      bad.push({ rowNumber: r + 1, name: name || '(이름 없음)', reason: '금액 칸에 원 단위 숫자가 아닌 값이 있습니다.' });
      continue;
    }
    const pd = rec.paymentDate instanceof Date ? rec.paymentDate.toISOString().slice(0, 10) : rec.paymentDate ? cellText(rec.paymentDate).replace(/[./]/g, '-') : null;
    rows.push({
      rowNumber: r + 1,
      name: name || null,
      employeeCode: rec.employeeCode ? cellText(rec.employeeCode) : null,
      ...Object.fromEntries(Object.entries(amounts).filter(([, v]) => v !== null)),
      paymentDate: pd && isLocalDate(pd) ? pd : null,
    });
  }
  if (rows.length === 0) throw new ValidationError('반영할 급여 행이 없습니다.');
  const stored = await storeFile(ctx, { data: input.data, originalName: input.fileName, purpose: 'import_source', clientId: mc.month.clientId });
  const result = await applyPayrollRows(ctx, { payrollMonthId: mc.month.id, rows, fullRoster: input.fullRoster ?? true, sourceName: input.fileName });
  return { ...result, unmatched: [...bad, ...result.unmatched], fileId: stored.id };
}

// ────────────────────────────── 3단계: 변경분 검토 ──────────────────────────────

/** 3단계 — 전월 대비 변동. 바뀐 사람만(needsReview) 보여 주고 변동 없음은 개수만 */
export async function getPayrollDiff(ctx: ServiceContext, payrollMonthId: string): Promise<PayrollDiffDTO> {
  requirePermission(ctx, 'payroll.read');
  assertUuid(payrollMonthId, 'payrollMonthId', '급여 월');
  const state = await recomputeMonth(ctx, payrollMonthId, 'view');
  await refreshUnreviewedNotice(ctx, state.dto.period);
  return state.dto;
}

const approveSchema = z.object({
  payrollMonthId: z.string().uuid(),
  itemIds: z.array(z.string().uuid()).min(1, '확인할 행을 고르세요').max(1000),
});

/** 3단계 — 변경 확인 (사람 1명 확인 = 수동 터치 1) */
export async function approveChanges(ctx: ServiceContext, input: { payrollMonthId: string; itemIds: string[] }): Promise<ApproveChangesResult> {
  requirePermission(ctx, 'payroll.write');
  const p = parseInput(approveSchema, input, '변경 확인');
  const res = await inMonthTx(ctx, p.payrollMonthId, async (t, mc) => {
    assertEditable(mc);
    const ids = [...new Set(p.itemIds)];
    const rows = await t.db.select().from(payrollItems).where(and(eq(payrollItems.payrollMonthId, mc.month.id), inArray(payrollItems.id, ids)));
    if (rows.length !== ids.length) throw new NotFoundError(`급여 행 ${ids.length - rows.length}건`);
    const todo = rows.filter((r) => !r.reviewedAt);
    const employees = await loadEmployeeRows(t, mc.month.clientId);
    const empById = new Map(employees.map((e) => [e.id, e]));
    if (todo.length > 0) {
      await t.db
        .update(payrollItems)
        .set({ reviewedAt: ctx.now(), reviewedBy: ctx.actor.userId, updatedAt: ctx.now() })
        .where(inArray(payrollItems.id, todo.map((r) => r.id)));
      await writeAuditMany(
        t,
        todo.map((r) => {
          const kinds = (r.changeKinds ?? []).filter((k) => k !== 'unchanged').map((k) => CHANGE_KIND_LABELS[k as keyof typeof CHANGE_KIND_LABELS] ?? k);
          return {
            action: 'payroll.review',
            category: 'data_change' as const,
            entityType: 'payroll_item',
            entityId: r.id,
            clientId: mc.month.clientId,
            summary: `${nameOf(empById, r.employeeId)} ${kinds.length ? kinds.join('·') : '변동'} 확인 (${mc.month.period} 지급총액 ${formatWon(r.grossPay)})`,
            before: { reviewed: false },
            after: { reviewed: true, grossPay: r.grossPay, changeKinds: r.changeKinds },
          };
        }),
      );
      await addManualTouches(t, mc.month.id, todo.length);
    }
    const state = await recomputeMonth(t, mc.month.id, 'reviewed', mc);
    return { approved: todo.length, alreadyReviewed: rows.length - todo.length, diff: state.dto };
  });
  await refreshUnreviewedNotice(ctx, res.diff.period);
  return res;
}

const decisionSchema = z.object({
  payrollMonthId: z.string().uuid(),
  decisions: z
    .array(
      z.object({
        employeeId: z.string().uuid(),
        decision: z.enum(['resigned', 'keep', 'on_leave'], { errorMap: () => ({ message: 'resigned(퇴사)·keep(계속 지급)·on_leave(휴직) 중 하나' }) }),
        resignDate: z.string().refine(isLocalDate, '퇴사일 형식은 YYYY-MM-DD 입니다').nullish(),
      }),
    )
    .min(1, '결정할 직원을 고르세요')
    .max(500),
});

/**
 * 3단계 — 신규·퇴사·명단 없음 결정.
 * resigned: 퇴사일 기록(employee.update). 이번 달 전에 퇴사했고 전월 복사 행이면 이번 달 행을 뺀다.
 * keep:     계속 근무 — 이번 달 행이 없으면 전월(없으면 직원 마스터) 기준으로 추가한다.
 * on_leave: 휴직 — 이번 달 지급 없음(행 제외), 직원 신고상태에 휴직 기록.
 */
export async function confirmNewAndResigned(
  ctx: ServiceContext,
  input: { payrollMonthId: string; decisions: Array<{ employeeId: string; decision: PayrollDecision; resignDate?: string | null }> },
): Promise<PayrollDiffDTO> {
  requirePermission(ctx, 'payroll.write');
  const p = parseInput(decisionSchema, input, '신규·퇴사 결정');
  const res = await inMonthTx(ctx, p.payrollMonthId, async (t, mc) => {
    assertEditable(mc);
    const m = mc.month;
    const periodStart = `${m.period}-01`;
    const s = await computeMonthState(t, m.id, mc);
    const decisions = { ...(totalsOf(m).decisions ?? {}) };
    const audits: AuditEntry[] = [];
    let dataChanged = false;
    const seen = new Set<string>();
    for (const d of p.decisions) {
      if (seen.has(d.employeeId)) throw new ValidationError('같은 직원에 대한 결정이 두 번 들어 있습니다.', [{ field: 'decisions', message: d.employeeId }]);
      seen.add(d.employeeId);
      const emp = s.empById.get(d.employeeId);
      if (!emp) throw new ValidationError('이 수임처의 직원이 아닙니다.', [{ field: 'decisions.employeeId', message: 'not in client' }]);
      const item = s.itemByEmp.get(emp.id);
      let what = '';
      if (d.decision === 'resigned') {
        const resignDate = d.resignDate ?? emp.resignDate;
        if (!resignDate) throw new ValidationError(`${emp.name}의 퇴사일을 입력하세요.`, [{ field: 'resignDate', message: '필수' }]);
        const r = await patchEmployeeInternal(t, emp.id, { resignDate }, 'employee.update', '퇴사 처리: ');
        if (r.audit) audits.push(r.audit);
        if (item && resignDate < periodStart && (item.origin === 'carried_forward' || item.origin === 'master') && !item.reviewedAt) {
          await t.db.delete(payrollItems).where(eq(payrollItems.id, item.id));
          dataChanged = true;
          audits.push({
            action: 'payroll.item_remove',
            category: 'data_change',
            entityType: 'payroll_item',
            entityId: item.id,
            clientId: m.clientId,
            summary: `${emp.name} ${m.period} 급여 행 제외 (퇴사일 ${resignDate}, 전월 복사분)`,
            before: { ...amountsOf(item), origin: item.origin },
            after: null,
          });
          what = `퇴사 확인 (퇴사일 ${resignDate}) — ${m.period} 급여에서 제외`;
        } else {
          if (item && !item.reviewedAt) await t.db.update(payrollItems).set({ reviewedAt: ctx.now(), reviewedBy: ctx.actor.userId, updatedAt: ctx.now() }).where(eq(payrollItems.id, item.id));
          what = `퇴사 확인 (퇴사일 ${resignDate})${item ? ` — 퇴사월 급여 ${formatWon(item.grossPay)} 유지` : ''}`;
        }
        decisions[emp.id] = { decision: 'resigned', resignDate, by: ctx.actor.name, byId: ctx.actor.userId, at: ctx.now().toISOString() };
      } else if (d.decision === 'keep') {
        if (emp.resignDate && emp.resignDate < periodStart) {
          const r = await patchEmployeeInternal(t, emp.id, { resignDate: null }, 'employee.update', '계속 근무 확인: ');
          if (r.audit) audits.push(r.audit);
        }
        if (!item) {
          const prevLine = s.prevLines.find((l) => l.employeeId === emp.id);
          const report = carryForwardWithReport(prevLine ? [prevLine] : [], [{ ...masterOf(emp), resignDate: null, active: true }], m.period);
          const line = report.lines[0];
          if (!line) throw new ValidationError(`${emp.name}의 이번 달 급여를 만들 수 없습니다: ${report.excluded[0]?.reason ?? '대상 아님'}`);
          const [ins] = await t.db
            .insert(payrollItems)
            .values({ payrollMonthId: m.id, employeeId: emp.id, ...itemValues(line), origin: 'manual', reviewedAt: ctx.now(), reviewedBy: ctx.actor.userId, createdAt: ctx.now(), updatedAt: ctx.now() })
            .returning({ id: payrollItems.id });
          dataChanged = true;
          audits.push({
            action: 'payroll.item_add',
            category: 'data_change',
            entityType: 'payroll_item',
            entityId: ins!.id,
            clientId: m.clientId,
            summary: `${emp.name} ${m.period} 급여 추가 (${prevLine ? '전월' : '직원 마스터'} 기준, 지급총액 ${formatWon(line.grossPay)})`,
            before: null,
            after: { ...amountsOf(line) },
          });
          what = `계속 근무 — 이번 달 급여 추가 (${formatWon(line.grossPay)})`;
        } else {
          if (!item.reviewedAt) await t.db.update(payrollItems).set({ reviewedAt: ctx.now(), reviewedBy: ctx.actor.userId, updatedAt: ctx.now() }).where(eq(payrollItems.id, item.id));
          what = '계속 근무 확인';
        }
        decisions[emp.id] = { decision: 'keep', by: ctx.actor.name, byId: ctx.actor.userId, at: ctx.now().toISOString() };
      } else {
        const r = await patchEmployeeInternal(t, emp.id, { reportStatus: `휴직 (${m.period}~)` }, 'employee.update', '휴직 처리: ');
        if (r.audit) audits.push(r.audit);
        if (item) {
          await t.db.delete(payrollItems).where(eq(payrollItems.id, item.id));
          dataChanged = true;
          audits.push({
            action: 'payroll.item_remove',
            category: 'data_change',
            entityType: 'payroll_item',
            entityId: item.id,
            clientId: m.clientId,
            summary: `${emp.name} 휴직 — ${m.period} 급여 행 제외 (지급총액 ${formatWon(item.grossPay)})`,
            before: { ...amountsOf(item), origin: item.origin },
            after: null,
          });
        }
        what = '휴직 — 이번 달 지급 없음';
        decisions[emp.id] = { decision: 'on_leave', by: ctx.actor.name, byId: ctx.actor.userId, at: ctx.now().toISOString() };
      }
      audits.push({
        action: 'payroll.decision',
        category: 'data_change',
        entityType: 'payroll_month',
        entityId: m.id,
        clientId: m.clientId,
        summary: `${emp.name} ${what}`,
        before: null,
        after: { employeeId: emp.id, decision: d.decision, resignDate: d.resignDate ?? null },
      });
    }
    await writeAuditMany(t, audits);
    await patchTotals(t, m.id, { decisions });
    m.totals = { ...(m.totals ?? {}), decisions };
    await addManualTouches(t, m.id, p.decisions.length);
    if (dataChanged) await blockStalePayrollExports(t, m.id, STALE_EXPORT_REASON);
    const state = await recomputeMonth(t, m.id, dataChanged ? 'data_changed' : 'reviewed', mc);
    return state.dto;
  });
  await refreshUnreviewedNotice(ctx, res.period);
  return res;
}

// ────────────────────────────── 4단계: 세액 계산 · 수정 ──────────────────────────────

const updateSchema = z.object({
  itemId: z.string().uuid(),
  taxablePay: won.optional(),
  nonTaxablePay: won.optional(),
  incomeTax: won.optional(),
  workDays: z.number().int().min(0).max(62).optional(),
  allowances: z.record(z.string().max(40), z.number().int()).optional(),
  otherDeductions: won.optional(),
  paymentDate: z.string().refine(isLocalDate, '지급일 형식은 YYYY-MM-DD 입니다').nullish(),
  note: z.string().max(200).optional(),
});

/** 4단계 — 급여 행 수정. 파생 필드(지급총액·사업/일용 세액·지방소득세·차인지급액)는 자동 계산, 수정 = 확인 */
export async function updatePayrollItem(ctx: ServiceContext, input: UpdatePayrollItemInput): Promise<UpdatePayrollItemResult> {
  requirePermission(ctx, 'payroll.write');
  const p = parseInput(updateSchema, input, '급여 행');
  const [head] = await ctx.db.select({ monthId: payrollItems.payrollMonthId }).from(payrollItems).where(eq(payrollItems.id, p.itemId));
  if (!head) throw new NotFoundError('급여 행');
  const res = await inMonthTx(ctx, head.monthId, async (t, mc) => {
    assertEditable(mc);
    const [item] = await t.db.select().from(payrollItems).where(eq(payrollItems.id, p.itemId)).for('update');
    if (!item) throw new NotFoundError('급여 행');
    const employees = await loadEmployeeRows(t, mc.month.clientId);
    const emp = employees.find((e) => e.id === item.employeeId);
    const name = emp?.name ?? '(알 수 없는 직원)';
    if (item.incomeType !== 'earned' && p.incomeTax !== undefined && p.incomeTax !== item.incomeTax) {
      throw new ValidationError(
        `${incomeTypeLabel(item.incomeType)} 소득세는 법정 산식(${item.incomeType === 'business' ? '지급액 × 3%' : '(일당 − 15만원) × 2.7%'})으로 자동 계산됩니다. 지급액·근무일수를 수정하세요.`,
        [{ field: 'incomeTax', message: '자동 계산 항목' }],
      );
    }
    const before = itemToLine(item, name);
    const draft: PayrollLine = {
      ...before,
      taxablePay: p.taxablePay ?? before.taxablePay,
      nonTaxablePay: p.nonTaxablePay ?? before.nonTaxablePay,
      incomeTax: item.incomeType === 'earned' ? p.incomeTax ?? before.incomeTax : before.incomeTax,
      allowances: p.allowances ?? before.allowances,
      otherDeductions: p.otherDeductions ?? before.otherDeductions,
      paymentDate: p.paymentDate !== undefined ? p.paymentDate : before.paymentDate,
      ...(p.workDays !== undefined ? { workDays: p.workDays } : {}),
    };
    const { line, basis, issues } = recomputeLine(draft);
    const warnings = [...issues];
    if (item.incomeType === 'earned' && line.taxablePay !== before.taxablePay && line.incomeTax === before.incomeTax && p.incomeTax === undefined) {
      warnings.push('과세급여가 바뀌었는데 소득세는 그대로입니다 — WEHAGO 간이세액표 금액을 확인해 입력하세요.');
    }
    const changed = !sameAmounts(amountsOf(before), amountsOf(line)) || JSON.stringify(before.allowances) !== JSON.stringify(line.allowances);
    if (!changed) {
      const codes = await loadEmployeeCodes(t, mc.month.clientId);
      return { item: toItemDTO(item, emp, codes[item.employeeId]?.code), basis, warnings: ['변경 사항이 없습니다.', ...warnings], manualTouches: await addManualTouches(t, mc.month.id, 0) };
    }
    const [u] = await t.db
      .update(payrollItems)
      .set({ ...itemValues(line), origin: 'manual', reviewedAt: ctx.now(), reviewedBy: ctx.actor.userId, updatedAt: ctx.now() })
      .where(eq(payrollItems.id, item.id))
      .returning();
    await writeAudit(t, {
      action: 'payroll.item_update',
      category: 'data_change',
      entityType: 'payroll_item',
      entityId: item.id,
      clientId: mc.month.clientId,
      summary: `${describeAmountChange(name, amountsOf(before), amountsOf(line))}${p.note ? ` (${p.note})` : ''}`,
      before: { ...amountsOf(before), allowances: before.allowances },
      after: { ...amountsOf(line), allowances: line.allowances },
      revertible: true,
    });
    const touches = await addManualTouches(t, mc.month.id, 1);
    await blockStalePayrollExports(t, mc.month.id, STALE_EXPORT_REASON);
    await recomputeMonth(t, mc.month.id, 'data_changed', mc);
    const [fresh] = await t.db.select().from(payrollItems).where(eq(payrollItems.id, item.id));
    const codes = await loadEmployeeCodes(t, mc.month.clientId);
    return { item: toItemDTO(fresh ?? u!, emp, codes[item.employeeId]?.code), basis, warnings, manualTouches: touches };
  });
  const mc = await loadMonthContext(ctx, head.monthId);
  await refreshUnreviewedNotice(ctx, mc.month.period);
  return res;
}

/** 4단계 — 세액 재계산 검증 (사업 3.3%·일용 2.7%·근로 정합성·지방세 10%·0원·주민번호·검산) */
export async function validatePayrollMonth(ctx: ServiceContext, payrollMonthId: string): Promise<PayrollValidationDTO> {
  requirePermission(ctx, 'payroll.write');
  assertUuid(payrollMonthId, 'payrollMonthId', '급여 월');
  const r = await runPayrollValidation(ctx, payrollMonthId, { persist: true });
  const { missingIdCount: _omit, ...dto } = r;
  return dto;
}

// ────────────────────────────── 확정 되돌리기 ──────────────────────────────

/** 확정 되돌리기 (audit.revert). 신고 완료된 달은 되돌릴 수 없다 (WEHAGO 수정신고) */
export async function reopenPayrollMonth(ctx: ServiceContext, input: { payrollMonthId: string; reason: string }): Promise<PayrollMonthDTO> {
  requirePermission(ctx, 'audit.revert');
  const reason = String(input?.reason ?? '').trim();
  if (reason.length < 2) throw new ValidationError('확정을 되돌리는 사유를 입력하세요.', [{ field: 'reason', message: '필수' }]);
  return inMonthTx(ctx, input.payrollMonthId, async (t, mc) => {
    const m = mc.month;
    if (!LOCKED_STATUSES.has(m.status)) throw new ConflictError('확정되지 않은 급여입니다. 그대로 수정하면 됩니다.');
    const detached = await detachMonthFromFilingJobs(t, mc);
    if (detached.filedKinds.length > 0) {
      throw new AppError({
        code: 'PAYROLL_ALREADY_FILED',
        httpStatus: 409,
        userMessage: `이미 신고 완료된 신고(${detached.filedKinds.join(', ')})에 포함된 급여라 되돌릴 수 없습니다. WEHAGO 에서 수정신고를 진행하세요.`,
        action: { label: '원천세 Control Tower', href: `/filing?period=${m.paymentPeriod}` },
      });
    }
    await t.db
      .update(payrollMonths)
      .set({ status: 'reviewing', wizardStep: 4, confirmedAt: null, confirmedBy: null, updatedAt: ctx.now() })
      .where(eq(payrollMonths.id, m.id));
    await writeAudit(t, {
      action: 'payroll.reopen',
      category: 'data_change',
      entityType: 'payroll_month',
      entityId: m.id,
      clientId: m.clientId,
      summary: `${mc.clientName} ${m.period} 급여 확정 되돌림: ${reason}`,
      before: { status: m.status },
      after: { status: 'reviewing', reason, filingJobsDetached: detached.jobIds.length },
    });
    return toMonthDTO(t, await loadMonthContext(t, m.id));
  });
}

