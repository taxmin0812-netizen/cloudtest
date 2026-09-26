/**
 * payroll_prepare 작업(전 수임처 1~2단계 자동 준비) + 대량(600명) 처리 — 실제 PostgreSQL (mintax_test_payroll).
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.MINTAX_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MINTAX_INDEX_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.STORAGE_LOCAL_DIR = mkdtempSync(path.join(os.tmpdir(), 'mintax-payroll-prep-'));

import { and, eq, sql } from 'drizzle-orm';
import { clients, closeDb, jobs, notifications, payrollItems, payrollMonths, setupTestDatabase, type Database } from '@mintax/db';
import { localIncomeTaxOf } from '@mintax/core/payroll/index';
import { ForbiddenError } from '@mintax/security';
import { createContext, systemActor, type ServiceContext } from '../context';
import { claimNextJob } from '../jobs/queue';
import { getJobHandler } from '../jobs/registry';
import { createTestClient, createTestUser, testContext } from '../testing/factory';
import {
  applyPayrollRows,
  approveChanges,
  confirmNewAndResigned,
  createEmployee,
  generatePayrollExports,
  getPayrollDiff,
  importEmployees,
  markReadyForFiling,
  registerPayrollJobHandlers,
  runPayrollPrepareForAll,
  startPayrollMonth,
  validatePayrollMonth,
  type PayrollPrepareJobResult,
} from './index';

const DB_URL = process.env.DATABASE_URL_TEST ?? 'postgres://mintax:mintax_dev@localhost:5432/mintax_test_payroll';
const PREV = '2026-08';
const P = '2026-09';
let db: Database;
let staff: ServiceContext;
let viewer: ServiceContext;
let sys: ServiceContext;

let rrnSeq = 0;
const rrn = () => {
  rrnSeq++;
  return `${String(700101 + (rrnSeq % 9000)).padStart(6, '0')}-1${String(100000 + rrnSeq).slice(-6)}`;
};

async function confirmedPrev(clientId: string, rows: Array<{ employeeId: string; taxable: number; tax: number }>): Promise<void> {
  const [m] = await db.insert(payrollMonths).values({ clientId, period: PREV, paymentPeriod: PREV, wizardStep: 7, status: 'confirmed' }).returning({ id: payrollMonths.id });
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(payrollItems).values(
      rows.slice(i, i + 500).map((r) => {
        const local = localIncomeTaxOf(r.tax);
        return {
          payrollMonthId: m!.id,
          employeeId: r.employeeId,
          incomeType: 'earned' as const,
          taxablePay: r.taxable,
          nonTaxablePay: 0,
          grossPay: r.taxable,
          incomeTax: r.tax,
          localIncomeTax: local,
          otherDeductions: 0,
          netPay: r.taxable - r.tax - local,
          paymentDate: `${PREV}-25`,
          origin: 'imported',
        };
      }),
    );
  }
}

async function runJob(): Promise<PayrollPrepareJobResult> {
  const job = await claimNextJob(db, 'test-worker', ['payroll_prepare']);
  expect(job).not.toBeNull();
  const handler = getJobHandler('payroll_prepare')!;
  const progress: Array<[number, number]> = [];
  const res = await handler({ ctx: sys, job: job!, progress: async (a, b) => void progress.push([a, b]) });
  expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1]);
  return res.result as unknown as PayrollPrepareJobResult;
}

beforeAll(async () => {
  db = await setupTestDatabase(DB_URL);
  staff = testContext(db, (await createTestUser(db, 'staff', '이담당')).actor);
  viewer = testContext(db, (await createTestUser(db, 'viewer', '조회자')).actor);
  sys = createContext(db, systemActor(), () => new Date('2026-09-26T09:00:00+09:00'));
  registerPayrollJobHandlers();
});

afterAll(async () => {
  await closeDb();
});

describe('payroll_prepare — 전 수임처 인건비 자동 준비', () => {
  const ids: Record<string, string> = {};

  it('변동 없음 1곳 / 변경 확인 필요 2곳 → 알림 "인건비 변동 미확인 2곳" 하나', async () => {
    // A: 전월 확정, 변동 없음
    const a = await createTestClient(db, { name: '가나상사' });
    const a1 = await createEmployee(staff, { clientId: a.id, name: '가직원', incomeType: 'earned', idNumber: rrn(), baseSalary: 2_500_000, paymentDay: 25 });
    const a2 = await createEmployee(staff, { clientId: a.id, name: '나직원', incomeType: 'earned', idNumber: rrn(), baseSalary: 2_700_000, paymentDay: 25 });
    await confirmedPrev(a.id, [
      { employeeId: a1.id, taxable: 2_500_000, tax: 50_000 },
      { employeeId: a2.id, taxable: 2_700_000, tax: 60_000 },
    ]);
    // B: 전월 확정 + 9월 신규 입사 1명
    const b = await createTestClient(db, { name: '다라상사' });
    const b1 = await createEmployee(staff, { clientId: b.id, name: '다직원', incomeType: 'earned', idNumber: rrn(), baseSalary: 3_000_000, paymentDay: 25 });
    await createEmployee(staff, { clientId: b.id, name: '신입', incomeType: 'earned', idNumber: rrn(), baseSalary: 2_400_000, hireDate: '2026-09-01', paymentDay: 25 });
    await confirmedPrev(b.id, [{ employeeId: b1.id, taxable: 3_000_000, tax: 80_000 }]);
    // C: 첫 달
    const c = await createTestClient(db, { name: '마바상사' });
    await createEmployee(staff, { clientId: c.id, name: '마직원', incomeType: 'business', idNumber: rrn(), baseSalary: 1_000_000, businessIncomeCode: '940909', paymentDay: 10 });
    // D: 직원 없음 / E: 비활성 수임처 → 대상 아님
    await createTestClient(db, { name: '빈상사' });
    const e = await createTestClient(db, { name: '휴업상사' });
    await createEmployee(staff, { clientId: e.id, name: '휴업직원', incomeType: 'earned', idNumber: rrn(), baseSalary: 2_000_000 });
    await db.update(clients).set({ active: false }).where(eq(clients.id, e.id));
    Object.assign(ids, { a: a.id, b: b.id, c: c.id });

    await expect(runPayrollPrepareForAll(viewer, { period: P })).rejects.toBeInstanceOf(ForbiddenError);
    const { jobId } = await runPayrollPrepareForAll(staff, { period: P });
    const [queued] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(queued!.type).toBe('payroll_prepare');

    const r = await runJob();
    expect(r.clients).toBe(3);
    expect(r.noChanges).toBe(1);
    expect(r.needsReview).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.summary).toBe('9월 인건비 준비 3곳 → 변동 없음 1곳 / 변경 확인 필요 2곳');
    const byClient = new Map(r.perClient.map((x) => [x.clientId, x]));
    expect(byClient.get(a.id)).toMatchObject({ status: 'no_changes', pendingReview: 0, created: true });
    expect(byClient.get(b.id)).toMatchObject({ status: 'needs_review', pendingReview: 1 });
    expect(byClient.get(c.id)).toMatchObject({ status: 'needs_review', pendingReview: 1 });

    const [ma] = await db.select().from(payrollMonths).where(and(eq(payrollMonths.clientId, a.id), eq(payrollMonths.period, P)));
    expect(ma!.status).toBe('reviewing');
    expect(ma!.wizardStep).toBe(4);
    expect((ma!.totals as { pendingReview: number }).pendingReview).toBe(0);
    const open = await db.select().from(notifications).where(and(eq(notifications.kind, 'payroll_unreviewed'), sql`resolved_at is null`));
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toBe('인건비 변동 미확인 2곳');
  });

  it('다시 실행해도 같은 결과 (멱등) · 검토하면 알림이 줄고 해소된다', async () => {
    await runPayrollPrepareForAll(staff, { period: P });
    const r = await runJob();
    expect(r.perClient.every((x) => !x.created)).toBe(true);
    expect(r.needsReview).toBe(2);

    for (const clientId of [ids.b!, ids.c!]) {
      const [m] = await db.select().from(payrollMonths).where(and(eq(payrollMonths.clientId, clientId), eq(payrollMonths.period, P)));
      const d = await getPayrollDiff(staff, m!.id);
      await approveChanges(staff, { payrollMonthId: m!.id, itemIds: d.changes.map((x) => x.itemId!).filter(Boolean) });
      const open = await db.select().from(notifications).where(and(eq(notifications.kind, 'payroll_unreviewed'), sql`resolved_at is null`));
      if (clientId === ids.b) expect(open[0]!.title).toBe('인건비 변동 미확인 1곳');
      else expect(open).toHaveLength(0);
    }
    // 변동 없는 수임처는 확정만 하면 된다 (사람 손 1번)
    const [ma] = await db.select().from(payrollMonths).where(and(eq(payrollMonths.clientId, ids.a!), eq(payrollMonths.period, P)));
    const done = await markReadyForFiling(staff, ma!.id);
    expect(done.month.status).toBe('confirmed');
    expect(done.month.manualTouches).toBe(0);
  });

  it('단일 급여 월 재계산 payload', async () => {
    const [m] = await db.select().from(payrollMonths).where(and(eq(payrollMonths.clientId, ids.b!), eq(payrollMonths.period, P)));
    const { enqueueJob } = await import('../jobs/queue');
    await enqueueJob(db, 'payroll_prepare', { payrollMonthId: m!.id });
    const job = await claimNextJob(db, 'test-worker', ['payroll_prepare']);
    const res = await getJobHandler('payroll_prepare')!({ ctx: sys, job: job!, progress: async () => undefined });
    expect(res.status).toBe('succeeded');
    expect(res.result.pendingReview).toBe(0);
  });
});

describe('대량 — 직원 600명 수임처 (배치 쓰기·N+1 없음)', () => {
  it('가져오기 → 시작 → 자료 반영(50명 변경) → 검토 → 검산 → 파일 → 확정', async () => {
    const t0 = performance.now();
    const c = await createTestClient(db, { name: '대형상사' });
    const N = 600;
    const imp = await importEmployees(staff, {
      clientId: c.id,
      rows: Array.from({ length: N }, (_, i) => ({ name: `직원${String(i + 1).padStart(4, '0')}`, incomeType: '근로', idNumber: rrn(), baseSalary: 2_000_000 + i * 1_000, paymentDay: 25 })),
    });
    expect(imp.created).toBe(N);
    await confirmedPrev(
      c.id,
      imp.employees.map((e) => ({ employeeId: e.id, taxable: e.baseSalary, tax: 40_000 })),
    );
    const m = await startPayrollMonth(staff, { clientId: c.id, period: P });
    expect(m.totals.headcount).toBe(N);
    const rows = imp.employees.slice(0, 50).map((e) => ({ employeeId: e.id, taxablePay: e.baseSalary + 100_000, incomeTax: 45_000 }));
    const r = await applyPayrollRows(staff, { payrollMonthId: m.id, rows });
    expect(r.changed).toBe(50);
    expect(r.diff.pendingCount).toBe(50);
    expect(r.diff.unchangedCount).toBe(N - 50);
    const a = await approveChanges(staff, { payrollMonthId: m.id, itemIds: r.diff.changes.map((x) => x.itemId!) });
    expect(a.diff.pendingCount).toBe(0);
    const v = await validatePayrollMonth(staff, m.id);
    expect(v.ok).toBe(true);
    const ex = await generatePayrollExports(staff, m.id);
    expect(ex.jobs[0]!.rowCount).toBe(N);
    const done = await markReadyForFiling(staff, m.id);
    expect(done.withholding.total.persons).toBe(N);
    expect(done.month.manualTouches).toBe(50);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(60_000);
    // 결정 API 는 500명 한도 (대량 결정은 나눠서)
    await expect(confirmNewAndResigned(staff, { payrollMonthId: m.id, decisions: [] })).rejects.toThrow();
  });
});
