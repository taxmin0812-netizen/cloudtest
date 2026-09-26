/**
 * 인건비 area — DB 공용 도우미 (조회·잠금·집계·알림 갱신).
 * 서비스 함수가 아니므로 권한 검사는 호출하는 서비스가 한다.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { clientBusinessProfiles, clients, employees, payrollItems, payrollMonths, settings, users } from '@mintax/db';
import type { EmployeeSnapshot, IncomeType } from '@mintax/core';
import { previousYearMonth } from '@mintax/core';
import { NotFoundError } from '@mintax/security';
import type { ServiceContext } from '../context';
import { notifyProblem, resolveProblem } from '../infra/notify';
import {
  PAYROLL_LOCK_NAMESPACE,
  PAYROLL_STATUS_LABELS,
  WIZARD_STEP_LABELS,
  emptyMoneyTotals,
  nextEmployeeCode,
  payrollHref,
  toIso,
  type MoneyTotals,
} from './helpers';
import type { PayrollMonthDTO } from './types';

type Db = Pick<ServiceContext, 'db'>;

export type EmployeeRow = typeof employees.$inferSelect;
export type PayrollMonthRow = typeof payrollMonths.$inferSelect;
export type PayrollItemRow = typeof payrollItems.$inferSelect;

export interface MonthContext {
  month: PayrollMonthRow;
  clientName: string;
  clientCode: string;
  businessNumber: string;
  semiannual: boolean;
  assigneeId: string | null;
}

/** 수임처·귀속월 단위 직렬화 (트랜잭션 안에서만 의미 있음) */
export async function lockPayroll(ctx: Db, clientId: string, period: string): Promise<void> {
  await ctx.db.execute(sql`select pg_advisory_xact_lock(${PAYROLL_LOCK_NAMESPACE}, hashtext(${`${clientId}:${period}`}))`);
}

export async function loadClientBasics(ctx: Db, clientId: string): Promise<{ id: string; name: string; code: string; businessNumber: string; semiannual: boolean; active: boolean; assigneeId: string | null }> {
  const [row] = await ctx.db
    .select({
      id: clients.id,
      name: clients.name,
      code: clients.code,
      businessNumber: clients.businessNumber,
      active: clients.active,
      assigneeId: clients.assigneeId,
      semiannual: clientBusinessProfiles.withholdingSemiannual,
    })
    .from(clients)
    .leftJoin(clientBusinessProfiles, eq(clientBusinessProfiles.clientId, clients.id))
    .where(eq(clients.id, clientId));
  if (!row) throw new NotFoundError('수임처');
  return { ...row, semiannual: row.semiannual ?? false };
}

export async function loadMonthContext(ctx: Db, payrollMonthId: string, opts: { forUpdate?: boolean } = {}): Promise<MonthContext> {
  const q = ctx.db
    .select({
      month: payrollMonths,
      clientName: clients.name,
      clientCode: clients.code,
      businessNumber: clients.businessNumber,
      assigneeId: clients.assigneeId,
      semiannual: clientBusinessProfiles.withholdingSemiannual,
    })
    .from(payrollMonths)
    .innerJoin(clients, eq(clients.id, payrollMonths.clientId))
    .leftJoin(clientBusinessProfiles, eq(clientBusinessProfiles.clientId, clients.id))
    .where(eq(payrollMonths.id, payrollMonthId));
  const [row] = opts.forUpdate ? await q.for('update', { of: payrollMonths }) : await q;
  if (!row) throw new NotFoundError('급여 월');
  return {
    month: row.month,
    clientName: row.clientName,
    clientCode: row.clientCode,
    businessNumber: row.businessNumber,
    semiannual: row.semiannual ?? false,
    assigneeId: row.assigneeId,
  };
}

export async function findMonthRow(ctx: Db, clientId: string, period: string): Promise<PayrollMonthRow | null> {
  const [row] = await ctx.db.select().from(payrollMonths).where(and(eq(payrollMonths.clientId, clientId), eq(payrollMonths.period, period)));
  return row ?? null;
}

export async function loadPreviousMonth(ctx: Db, clientId: string, period: string): Promise<PayrollMonthRow | null> {
  return findMonthRow(ctx, clientId, previousYearMonth(period));
}

export async function loadEmployeeRows(ctx: Db, clientId: string): Promise<EmployeeRow[]> {
  return ctx.db.select().from(employees).where(eq(employees.clientId, clientId)).orderBy(asc(employees.createdAt), asc(employees.id));
}

export function snapshotOf(e: EmployeeRow): EmployeeSnapshot {
  return {
    employeeId: e.id,
    name: e.name,
    incomeType: e.incomeType,
    hasIdNumber: !!e.idNumberEnc,
    idNumberMasked: e.idNumberMasked,
    hireDate: e.hireDate,
    resignDate: e.resignDate,
  };
}

export async function loadItemRows(ctx: Db, payrollMonthId: string): Promise<PayrollItemRow[]> {
  return ctx.db.select().from(payrollItems).where(eq(payrollItems.payrollMonthId, payrollMonthId)).orderBy(asc(payrollItems.createdAt), asc(payrollItems.id));
}

export async function userNames(ctx: Db, ids: Array<string | null>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (list.length === 0) return new Map();
  const rows = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ────────────────────────────── WEHAGO 사원코드 (settings) ──────────────────────────────

export interface EmployeeCodeEntry {
  code: string;
  source: 'auto' | 'user';
}

export function employeeCodeSettingKey(clientId: string): string {
  return `payroll_employee_codes:${clientId}`;
}

export async function loadEmployeeCodes(ctx: Db, clientId: string): Promise<Record<string, EmployeeCodeEntry>> {
  const [row] = await ctx.db.select({ value: settings.value }).from(settings).where(eq(settings.key, employeeCodeSettingKey(clientId)));
  const v = row?.value;
  return v && typeof v === 'object' ? (v as Record<string, EmployeeCodeEntry>) : {};
}

/**
 * 사원코드가 없는 직원에게 자동 코드를 부여한다 (WEHAGO 사원코드와 다를 수 있음 → 화면·파일 경고).
 * 호출자는 같은 트랜잭션에서 수임처 잠금을 잡고 있어야 한다.
 */
export async function ensureEmployeeCodes(
  ctx: ServiceContext,
  clientId: string,
  employeeIds: readonly string[],
  userCodes: Record<string, string> = {},
): Promise<Record<string, EmployeeCodeEntry>> {
  const codes = await loadEmployeeCodes(ctx, clientId);
  let changed = false;
  for (const [id, code] of Object.entries(userCodes)) {
    const c = code.trim();
    if (c && codes[id]?.code !== c) {
      codes[id] = { code: c, source: 'user' };
      changed = true;
    }
  }
  for (const id of employeeIds) {
    if (codes[id]) continue;
    codes[id] = { code: nextEmployeeCode(Object.values(codes).map((x) => x.code)), source: 'auto' };
    changed = true;
  }
  if (changed) {
    await ctx.db
      .insert(settings)
      .values({ key: employeeCodeSettingKey(clientId), value: codes, updatedBy: ctx.actor.userId, updatedAt: ctx.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value: codes, updatedBy: ctx.actor.userId, updatedAt: ctx.now() } });
  }
  return codes;
}

// ────────────────────────────── totals (jsonb) ──────────────────────────────

export interface MonthTotals extends MoneyTotals {
  byIncomeType?: Record<IncomeType, MoneyTotals>;
  manualTouches?: number;
  pendingReview?: number;
  decisions?: Record<string, { decision: 'resigned' | 'keep' | 'on_leave'; resignDate?: string | null; by: string; byId: string | null; at: string }>;
  carry?: { carriedForward: number; fromMaster: number; excluded: Array<{ employeeId: string; name: string; reason: string }>; notes: string[] };
  validation?: { ok: boolean; checkedAt: string; blocking: number; high: number; warning: number; info: number; missingId: number };
  import?: { at: string; by: string; sourceName: string | null; changed: number; unchanged: number; added: number; removed: number; unmatched: number };
  warnings?: string[];
}

export function totalsOf(m: PayrollMonthRow): MonthTotals {
  const t = (m.totals ?? {}) as Partial<MonthTotals>;
  return { ...emptyMoneyTotals(), ...t } as MonthTotals;
}

/** totals 에 키를 병합 (다른 키는 보존) */
export async function patchTotals(ctx: ServiceContext, payrollMonthId: string, patch: Partial<MonthTotals>, extra: Partial<Pick<PayrollMonthRow, 'wizardStep' | 'status' | 'diffSummary'>> = {}): Promise<void> {
  await ctx.db
    .update(payrollMonths)
    .set({ totals: sql`${payrollMonths.totals} || ${JSON.stringify(patch)}::jsonb`, updatedAt: ctx.now(), ...extra })
    .where(eq(payrollMonths.id, payrollMonthId));
}

/** 인건비 수동 터치 KPI (사람 1회 행동 = 1). 원자적 증가 후 새 값 반환 */
export async function addManualTouches(ctx: ServiceContext, payrollMonthId: string, n: number): Promise<number> {
  if (n <= 0) {
    const [row] = await ctx.db.select({ t: sql<number>`coalesce((${payrollMonths.totals}->>'manualTouches')::int, 0)` }).from(payrollMonths).where(eq(payrollMonths.id, payrollMonthId));
    return Number(row?.t ?? 0);
  }
  const r = await ctx.db.execute<{ touches: number }>(sql`
    update payroll_months
    set totals = jsonb_set(totals, '{manualTouches}', to_jsonb(coalesce((totals->>'manualTouches')::int, 0) + ${n})),
        updated_at = ${ctx.now()}
    where id = ${payrollMonthId}
    returning (totals->>'manualTouches')::int as touches
  `);
  return Number(r.rows[0]?.touches ?? 0);
}

// ────────────────────────────── 알림 ──────────────────────────────

export function unreviewedDedupeKey(period: string): string {
  return `payroll_unreviewed:${period}`;
}

/**
 * "인건비 변동 미확인 N곳" 알림을 현재 DB 상태로 다시 맞춘다 (문제 알림만 — 0곳이면 해소).
 */
export async function refreshUnreviewedNotice(ctx: Db, period: string): Promise<{ clients: number; employees: number }> {
  const r = await ctx.db.execute<{ client_name: string; pending: number }>(sql`
    select c.name as client_name, coalesce((pm.totals->>'pendingReview')::int, 0) as pending
    from payroll_months pm join clients c on c.id = pm.client_id
    where pm.period = ${period} and pm.status in ('draft', 'reviewing') and coalesce((pm.totals->>'pendingReview')::int, 0) > 0
    order by c.name
  `);
  const rows = r.rows;
  const key = unreviewedDedupeKey(period);
  if (rows.length === 0) {
    await resolveProblem(ctx, key);
    return { clients: 0, employees: 0 };
  }
  const employeesPending = rows.reduce((t, x) => t + Number(x.pending), 0);
  const names = rows.slice(0, 5).map((x) => `${x.client_name}(${x.pending}명)`).join(', ');
  await notifyProblem(ctx, {
    kind: 'payroll_unreviewed',
    severity: 'warning',
    title: `인건비 변동 미확인 ${rows.length}곳`,
    body: `${period} 귀속 급여에서 확인이 필요한 변경 ${employeesPending}명: ${names}${rows.length > 5 ? ` 외 ${rows.length - 5}곳` : ''}`,
    href: `/payroll?period=${period}&filter=unreviewed`,
    dedupeKey: key,
  });
  return { clients: rows.length, employees: employeesPending };
}

// ────────────────────────────── DTO ──────────────────────────────

export async function toMonthDTO(ctx: Db, mc: MonthContext, extraWarnings: string[] = []): Promise<PayrollMonthDTO> {
  const m = mc.month;
  const t = totalsOf(m);
  const prev = await loadPreviousMonth(ctx, m.clientId, m.period);
  const names = await userNames(ctx, [m.confirmedBy]);
  const warnings = [...(t.warnings ?? []), ...extraWarnings];
  if (!prev) warnings.push(`전월(${previousYearMonth(m.period)}) 급여가 없어 모든 인원을 새로 확인해야 합니다 (첫 달).`);
  else if (!['confirmed', 'exported', 'filed'].includes(prev.status)) warnings.push(`전월(${prev.period}) 급여가 아직 확정되지 않았습니다 — 전월 기준 비교가 바뀔 수 있습니다.`);
  const byIncomeType = t.byIncomeType ?? { earned: emptyMoneyTotals(), business: emptyMoneyTotals(), daily: emptyMoneyTotals() };
  return {
    id: m.id,
    clientId: m.clientId,
    clientName: mc.clientName,
    period: m.period,
    paymentPeriod: m.paymentPeriod,
    wizardStep: m.wizardStep,
    wizardStepLabel: WIZARD_STEP_LABELS[Math.min(7, Math.max(1, m.wizardStep)) - 1]!,
    status: m.status,
    statusLabel: PAYROLL_STATUS_LABELS[m.status] ?? m.status,
    diffSummary: m.diffSummary ?? {},
    totals: {
      headcount: t.headcount,
      taxablePay: t.taxablePay,
      nonTaxablePay: t.nonTaxablePay,
      grossPay: t.grossPay,
      incomeTax: t.incomeTax,
      localIncomeTax: t.localIncomeTax,
      otherDeductions: t.otherDeductions,
      netPay: t.netPay,
      byIncomeType,
    },
    pendingReview: t.pendingReview ?? 0,
    manualTouches: t.manualTouches ?? 0,
    confirmedAt: toIso(m.confirmedAt),
    confirmedBy: m.confirmedBy ? names.get(m.confirmedBy) ?? null : null,
    previousPeriod: previousYearMonth(m.period),
    previousMonthId: prev?.id ?? null,
    previousStatus: prev?.status ?? null,
    semiannual: mc.semiannual,
    warnings,
    href: payrollHref(m.clientId, m.period),
    createdAt: toIso(m.createdAt)!,
    updatedAt: toIso(m.updatedAt)!,
  };
}

// ────────────────────────────── 파일 무효화 ──────────────────────────────

export const PAYROLL_EXPORT_KINDS = ['payroll_earned', 'payroll_business', 'payroll_daily'] as const;

/**
 * 급여 행이 바뀌면 그 달의 WEHAGO 급여 파일(준비·받음)은 더 이상 맞지 않는다 → 차단(blocked)하고 다시 만들게 한다.
 * 반환: 차단한 파일 수
 */
export async function blockStalePayrollExports(ctx: Pick<ServiceContext, 'db'>, payrollMonthId: string, reason: string): Promise<number> {
  const r = await ctx.db.execute(sql`
    update export_jobs
    set status = 'blocked', blocked_reason = ${reason},
        validation = validation || jsonb_build_object('staleReason', ${reason}::text)
    where kind in ('payroll_earned', 'payroll_business', 'payroll_daily')
      and validation->>'payrollMonthId' = ${payrollMonthId}
      and status in ('ready', 'downloaded')
  `);
  return r.rowCount ?? 0;
}
