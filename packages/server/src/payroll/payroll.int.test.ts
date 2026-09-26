/**
 * 인건비·원천세 통합 테스트 — 실제 PostgreSQL (mintax_test_payroll).
 * DATABASE_URL_TEST=postgres://mintax:mintax_dev@localhost:5432/mintax_test_payroll npx vitest run --project integration packages/server/src/payroll
 *
 * 시나리오 2 (docs/06-mvp-plan.md §3.2): 직원 10명, 9월 급여변경 1(+10%) + 퇴사 1 → 변경된 2명만 검토 → 원천세·간이지급명세서·WEHAGO 작업파일 준비.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.MINTAX_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MINTAX_INDEX_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.STORAGE_LOCAL_DIR = mkdtempSync(path.join(os.tmpdir(), 'mintax-payroll-'));

import { and, eq, sql } from 'drizzle-orm';
import {
  auditLogs,
  closeDb,
  clientBusinessProfiles,
  employees,
  exportJobs,
  filingJobs,
  notifications,
  payrollItems,
  payrollMonths,
  setupTestDatabase,
  type Database,
} from '@mintax/db';
import { readTabularFile } from '@mintax/adapters';
import { withholdingDueDate, simplifiedStatementDueDate, localIncomeTaxOf } from '@mintax/core/payroll/index';
import { AppError, ForbiddenError, ValidationError } from '@mintax/security';
import type { ServiceContext } from '../context';
import { createTestClient, createTestUser, testContext } from '../testing/factory';
import {
  applyPayrollRows,
  approveChanges,
  confirmNewAndResigned,
  createEmployee,
  downloadPayrollExport,
  generatePayrollExports,
  getPayrollDiff,
  getPayrollMonth,
  getPayrollTemplates,
  getWithholdingSummary,
  importEmployees,
  importPayrollFile,
  listEmployees,
  markReadyForFiling,
  reopenPayrollMonth,
  resignEmployee,
  revealEmployeeSensitive,
  startPayrollMonth,
  updateEmployee,
  updatePayrollItem,
  validatePayrollMonth,
  type EmployeeDTO,
} from './index';
import { generateReviewExcel, getFilingBoard, getFilingJob, markFiled, uploadFilingResult } from '../filing';
import { RAW_RRN_PATTERN } from './helpers';

const DB_URL = process.env.DATABASE_URL_TEST ?? 'postgres://mintax:mintax_dev@localhost:5432/mintax_test_payroll';
const PREV = '2026-08';
const P = '2026-09';

let db: Database;
let admin: ServiceContext;
let staff: ServiceContext;
let viewer: ServiceContext;
/** 모든 서비스 결과 — 마지막에 주민번호 원문이 없는지 검사 */
const seen: unknown[] = [];
const rawRrns: string[] = [];
function keep<T>(x: T): T {
  seen.push(x);
  return x;
}

/** 형식만 맞춘 가짜 주민번호 (합성) */
function fakeRrn(i: number, female = false): string {
  const front = String(800101 + i * 100).padStart(6, '0');
  const back = `${female ? 2 : 1}${String(100_000 + ((i * 7919) % 900_000)).slice(-6)}`;
  const v = `${front}-${back}`;
  rawRrns.push(v, v.replace('-', ''));
  return v;
}

/** 합성 근로소득 세액 (간이세액표 아님 — 테스트 픽스처) */
const fixtureTax = (taxable: number) => Math.max(0, Math.floor(((taxable - 1_500_000) * 0.05) / 10) * 10);
const fixtureOther = (taxable: number) => Math.floor(taxable * 0.097);

async function insertConfirmedMonth(
  clientId: string,
  period: string,
  lines: Array<{ employeeId: string; incomeType?: 'earned' | 'business' | 'daily'; taxable: number; nonTaxable: number; incomeTax: number; workDays?: number }>,
  payDay = '25',
): Promise<string> {
  const [m] = await db
    .insert(payrollMonths)
    .values({ clientId, period, paymentPeriod: period, wizardStep: 7, status: 'confirmed', confirmedAt: new Date('2026-08-26T00:00:00Z') })
    .returning({ id: payrollMonths.id });
  await db.insert(payrollItems).values(
    lines.map((l) => {
      const gross = l.taxable + l.nonTaxable;
      const local = localIncomeTaxOf(l.incomeTax);
      const other = fixtureOther(l.taxable);
      return {
        payrollMonthId: m!.id,
        employeeId: l.employeeId,
        incomeType: l.incomeType ?? 'earned',
        taxablePay: l.taxable,
        nonTaxablePay: l.nonTaxable,
        grossPay: gross,
        incomeTax: l.incomeTax,
        localIncomeTax: local,
        otherDeductions: other,
        netPay: gross - l.incomeTax - local - other,
        workDays: l.workDays ?? null,
        paymentDate: `${period}-${payDay}`,
        origin: 'imported',
      };
    }),
  );
  return m!.id;
}

function expectAppError(e: unknown, code: string): AppError {
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
  return e as AppError;
}

beforeAll(async () => {
  db = await setupTestDatabase(DB_URL);
  admin = testContext(db, (await createTestUser(db, 'admin', '김세무')).actor);
  staff = testContext(db, (await createTestUser(db, 'staff', '이담당')).actor);
  viewer = testContext(db, (await createTestUser(db, 'viewer', '조회자')).actor);
});

afterAll(async () => {
  await closeDb();
});

// ════════════════════════════ 시나리오 2 ════════════════════════════

describe('시나리오 2 — 직원 10명, 급여변경 1 + 퇴사 1 → 변경된 2명만 검토', () => {
  const plan = [
    { name: '김민수', base: 3_300_000, meal: false },
    { name: '최지훈', base: 2_900_000, meal: true },
    { name: '이영희', base: 3_600_000, meal: true },
    { name: '박서준', base: 3_100_000, meal: true },
    { name: '정다은', base: 2_800_000, meal: true },
    { name: '강민호', base: 2_700_000, meal: true },
    { name: '조수아', base: 2_600_000, meal: true },
    { name: '윤지훈', base: 2_500_000, meal: true },
    { name: '장하늘', base: 3_000_000, meal: true },
    { name: '임도윤', base: 2_950_000, meal: true },
  ];
  let clientId = '';
  const emp = new Map<string, EmployeeDTO>();
  let monthId = '';

  it('직원 등록 — 주민번호는 암호화·마스킹, 목록에는 마스킹본만', async () => {
    const c = await createTestClient(db, { name: '시나리오상사' });
    clientId = c.id;
    for (const [i, p] of plan.entries()) {
      const e = keep(
        await createEmployee(staff, {
          clientId,
          name: p.name,
          incomeType: 'earned',
          idNumber: fakeRrn(i, i % 3 === 0),
          hireDate: '2024-03-02',
          baseSalary: p.base,
          nonTaxable: p.meal ? { 식대: 200_000 } : {},
          paymentDay: 25,
          bankName: '국민',
          bankAccount: `123-45-67890${i}`,
        }),
      );
      emp.set(p.name, e);
      expect(e.idNumberMasked).toMatch(/^\d{6}-[12]\*{6}$/);
      expect(e.bankAccountMasked).toMatch(/^\*+\d{4}$/);
      expect(e.hasIdNumber).toBe(true);
    }
    const [row] = await db.select().from(employees).where(eq(employees.id, emp.get('김민수')!.id));
    expect(row!.idNumberEnc).toMatch(/^v1:/);
    expect(row!.idNumberEnc).not.toContain('800101');
    expect(row!.idNumberHash).toMatch(/^[0-9a-f]{64}$/);

    const list = keep(await listEmployees(staff, clientId));
    expect(list).toHaveLength(10);
    await expect(listEmployees(viewer, clientId)).rejects.toBeInstanceOf(ForbiddenError);

    // 같은 주민번호 중복 등록 차단 (급여 합산 사고 방지)
    await createEmployee(staff, { clientId, name: '중복', incomeType: 'earned', idNumber: rawRrns[0]! }).then(
      () => expect.unreachable(),
      (e) => expect((e as AppError).userMessage).toMatch(/이미 등록된 직원이 있습니다 \(김민수\)/),
    );

    // 전월(8월) 확정 급여 10행
    await insertConfirmedMonth(
      clientId,
      PREV,
      plan.map((p) => ({ employeeId: emp.get(p.name)!.id, taxable: p.base, nonTaxable: p.meal ? 200_000 : 0, incomeTax: fixtureTax(p.base) })),
    );
  });

  it('1단계 — 전월 복사로 9월 초안 (멱등)', async () => {
    const r = keep(await startPayrollMonth(staff, { clientId, period: P }));
    monthId = r.id;
    expect(r.created).toBe(true);
    expect(r.paymentPeriod).toBe(P);
    expect(r.carried.carriedForward).toBe(10);
    expect(r.totals.headcount).toBe(10);
    const again = keep(await startPayrollMonth(staff, { clientId, period: P }));
    expect(again.created).toBe(false);
    expect(again.id).toBe(monthId);
    const [m] = await db.select().from(payrollMonths).where(eq(payrollMonths.id, monthId));
    expect(m!.wizardStep).toBe(2);
  });

  it('2단계 — 수임처 급여 엑셀 반영: 김민수 +10%, 최지훈 명단 없음 (전체 명단)', async () => {
    const rows = plan
      .filter((p) => p.name !== '최지훈')
      .map((p) => {
        const base = p.name === '김민수' ? 3_630_000 : p.base;
        return { name: p.name, taxablePay: base, nonTaxablePay: p.meal ? 200_000 : 0, incomeTax: fixtureTax(base), otherDeductions: fixtureOther(p.base) };
      });
    const r = keep(await applyPayrollRows(staff, { payrollMonthId: monthId, rows, fullRoster: true, sourceName: '시나리오상사_9월급여.xlsx' }));
    expect(r.changed).toBe(1);
    expect(r.unchanged).toBe(8);
    expect(r.removedNotInRoster.map((x) => x.name)).toEqual(['최지훈']);
    expect(r.unmatched).toEqual([]);
    const items = await db.select().from(payrollItems).where(eq(payrollItems.payrollMonthId, monthId));
    expect(items).toHaveLength(9);
    expect(items.filter((i) => i.origin === 'carried_forward')).toHaveLength(8);
    expect(items.filter((i) => i.origin === 'imported')).toHaveLength(1);
  });

  it('3단계 — 변경분: 정확히 2명만 보인다', async () => {
    const d = keep(await getPayrollDiff(staff, monthId));
    expect(d.changes).toHaveLength(2);
    expect(d.pendingCount).toBe(2);
    expect(d.unchangedCount).toBe(8);
    expect(d.summary.unchanged).toBe(8);
    expect(d.summary.payChanged).toBe(1);
    expect(d.summary.missing).toBe(1);
    const kim = d.changes.find((c) => c.name === '김민수')!;
    expect(kim.kinds).toEqual(['pay_changed']);
    expect(kim.changeRate).toBe(10);
    expect(kim.itemId).toBeTruthy();
    const choi = d.changes.find((c) => c.name === '최지훈')!;
    expect(choi.kinds).toEqual(['missing_this_month']);
    expect(choi.itemId).toBeNull();
    expect(choi.actions).toEqual(expect.arrayContaining(['resigned', 'keep', 'on_leave']));

    const [m] = await db.select().from(payrollMonths).where(eq(payrollMonths.id, monthId));
    expect(m!.diffSummary).toMatchObject({ unchanged: 8, pay_changed: 1, missing_this_month: 1, pending: 2 });
    expect(m!.wizardStep).toBe(3);
    expect(m!.status).toBe('reviewing');
    const items = await db.select().from(payrollItems).where(eq(payrollItems.payrollMonthId, monthId));
    expect(items.filter((i) => i.needsReview)).toHaveLength(1);
    expect(items.find((i) => i.employeeId === emp.get('김민수')!.id)!.changeKinds).toEqual(['pay_changed']);

    const [n] = await db.select().from(notifications).where(and(eq(notifications.dedupeKey, `payroll_unreviewed:${P}`), sql`resolved_at is null`));
    expect(n!.title).toBe('인건비 변동 미확인 1곳');
    expect(n!.kind).toBe('payroll_unreviewed');

    // 반복 호출해도 같은 결과 (멱등)
    const d2 = await getPayrollDiff(staff, monthId);
    expect(d2.changes.map((c) => c.name).sort()).toEqual(['김민수', '최지훈']);
  });

  it('검토 전에는 파일 생성·확정이 막힌다', async () => {
    const v = keep(await validatePayrollMonth(staff, monthId));
    expect(v.ok).toBe(false);
    expect(v.issues.filter((i) => i.code === 'pending_review')).toHaveLength(2);
    await expect(generatePayrollExports(staff, monthId)).rejects.toSatisfy((e: unknown) => (e as AppError).code === 'PAYROLL_EXPORT_BLOCKED');
  });

  it('3단계 — 김민수 확인(A) · 최지훈 퇴사 처리(2026-08-31) → 검토 0, 알림 해소, 수동 터치 2', async () => {
    const d0 = await getPayrollDiff(staff, monthId);
    const kimItem = d0.changes.find((c) => c.name === '김민수')!.itemId!;
    const a = keep(await approveChanges(staff, { payrollMonthId: monthId, itemIds: [kimItem] }));
    expect(a.approved).toBe(1);
    expect(a.diff.pendingCount).toBe(1);
    const again = await approveChanges(staff, { payrollMonthId: monthId, itemIds: [kimItem] });
    expect(again.approved).toBe(0);
    expect(again.alreadyReviewed).toBe(1);

    const d = keep(
      await confirmNewAndResigned(staff, { payrollMonthId: monthId, decisions: [{ employeeId: emp.get('최지훈')!.id, decision: 'resigned', resignDate: '2026-08-31' }] }),
    );
    expect(d.pendingCount).toBe(0);
    expect(d.changes.find((c) => c.name === '최지훈')!.decision).toBe('resigned');
    const [e] = await db.select().from(employees).where(eq(employees.id, emp.get('최지훈')!.id));
    expect(e!.resignDate).toBe('2026-08-31');
    const [m] = await db.select().from(payrollMonths).where(eq(payrollMonths.id, monthId));
    expect((m!.totals as { manualTouches: number }).manualTouches).toBe(2);
    expect(m!.wizardStep).toBe(4);
    const open = await db.select().from(notifications).where(and(eq(notifications.dedupeKey, `payroll_unreviewed:${P}`), sql`resolved_at is null`));
    expect(open).toHaveLength(0);
  });

  it('4단계 — 세액 검산 통과 (근로 9명, 지방소득세 10%, 검산식)', async () => {
    const v = keep(await validatePayrollMonth(staff, monthId));
    expect(v.ok).toBe(true);
    expect(v.counts.blocking).toBe(0);
    expect(v.totals.headcount).toBe(9);
    const items = await db.select().from(payrollItems).where(eq(payrollItems.payrollMonthId, monthId));
    for (const i of items) {
      expect(i.grossPay).toBe(i.taxablePay + i.nonTaxablePay);
      expect(i.netPay).toBe(i.grossPay - i.incomeTax - i.localIncomeTax - i.otherDeductions);
      expect(i.localIncomeTax).toBe(localIncomeTaxOf(i.incomeTax));
    }
  });

  it('5단계 — WEHAGO 급여자료 파일 (MOCK 경고, 재읽기 합계 = Σ 급여 행)', async () => {
    const r = keep(await generatePayrollExports(staff, monthId));
    expect(r.integrationStatus).toBe('FILE_BASED');
    expect(r.jobs).toHaveLength(1);
    const j = r.jobs[0]!;
    expect(j.kind).toBe('payroll_earned');
    expect(j.status).toBe('ready');
    expect(j.rowCount).toBe(9);
    expect(j.templateStatus).toBe('mock');
    expect(j.uploadAllowed).toBe(false);
    expect(j.warnings.join(' ')).toMatch(/MOCK/);
    const [sum] = await db
      .select({ gross: sql<string>`sum(gross_pay)`, tax: sql<string>`sum(income_tax)`, local: sql<string>`sum(local_income_tax)` })
      .from(payrollItems)
      .where(eq(payrollItems.payrollMonthId, monthId));
    expect(j.grossPay).toBe(Number(sum!.gross));
    expect(j.incomeTax).toBe(Number(sum!.tax));

    const dl = keep(await downloadPayrollExport(staff, j.id));
    const file = await readTabularFile(dl.data, dl.fileName);
    const sheet = file.sheets.find((s) => s.name === '급여자료')!;
    const header = sheet.rows[0]!.map(String);
    const gi = header.indexOf('지급총액');
    const fileGross = sheet.rows.slice(1).reduce((t, r) => t + (typeof r[gi] === 'number' ? (r[gi] as number) : 0), 0);
    expect(fileGross).toBe(Number(sum!.gross));
    expect(dl.exportJob.status).toBe('downloaded');
    const [m] = await db.select().from(payrollMonths).where(eq(payrollMonths.id, monthId));
    expect(m!.wizardStep).toBe(6);
  });

  it('6단계 — 원천세 요약 = 급여 행 합계 (1원 단위), 기한 2026-10-12', async () => {
    const w = keep(await getWithholdingSummary(staff, monthId));
    const [sum] = await db
      .select({ gross: sql<string>`sum(gross_pay)`, tax: sql<string>`sum(income_tax)`, local: sql<string>`sum(local_income_tax)`, n: sql<number>`count(*)::int` })
      .from(payrollItems)
      .where(eq(payrollItems.payrollMonthId, monthId));
    expect(w.consistency.ok).toBe(true);
    expect(w.blocked).toBe(false);
    expect(w.total.incomeTax).toBe(Number(sum!.tax));
    expect(w.total.totalPay).toBe(Number(sum!.gross));
    expect(w.total.persons).toBe(9);
    expect(w.localIncomeTax.declared).toBe(Number(sum!.local));
    expect(w.rows.map((r) => r.code)).toEqual(['A01', 'A10', 'A99']);
    // 10/10 토요일 → 다음 영업일 (core 캘린더와 일치)
    expect(withholdingDueDate(P)).toBe('2026-10-12');
    expect(w.dueDate).toBe('2026-10-12');
    expect(w.dueNote).toContain('2026-10-10(토)');
    const earned = w.statements.find((s) => s.kind === 'earned')!;
    expect(earned.cycle).toBe('semiannual');
    expect(earned.filingPeriod).toBe('2026-12');
    expect(earned.dueDate).toBe('2027-02-01');
    expect(earned.rows).toBe(9);
  });

  it('7단계 — 확정 + 신고 작업 생성 (원천세·지방소득세 2026-10-12, 근로 간이지급명세서 반기 묶음)', async () => {
    const r = keep(await markReadyForFiling(staff, monthId));
    expect(r.alreadyConfirmed).toBe(false);
    expect(r.month.status).toBe('confirmed');
    expect(r.month.wizardStep).toBe(7);
    const byKind = new Map(r.filingJobs.map((j) => [j.kind, j]));
    expect(byKind.get('withholding')).toMatchObject({ period: P, dueDate: '2026-10-12', currentStep: 'withholding_ready' });
    expect(byKind.get('local_income_tax')).toMatchObject({ period: P, dueDate: '2026-10-12' });
    expect(byKind.get('simplified_statement_earned')).toMatchObject({ period: '2026-12', dueDate: '2027-02-01' });
    expect(byKind.has('simplified_statement_business')).toBe(false);
    expect(byKind.has('daily_statement')).toBe(false);

    const [wh] = await db.select().from(filingJobs).where(eq(filingJobs.id, byKind.get('withholding')!.id));
    const payload = wh!.payload as { totals: { persons: number; totalPay: number; incomeTax: number }; channel: string };
    expect(payload.totals.persons).toBe(9);
    expect(payload.totals.incomeTax).toBe(r.withholding.total.incomeTax);
    expect(payload.channel).toBe('FILE_BASED');
    expect(wh!.channelStatus).toBe('FILE_BASED');

    // 멱등
    const again = await markReadyForFiling(staff, monthId);
    expect(again.alreadyConfirmed).toBe(true);
    const jobs = await db.select().from(filingJobs).where(eq(filingJobs.clientId, clientId));
    expect(jobs).toHaveLength(3);

    // 확정 후 수정 거부
    const item = (await getPayrollMonth(staff, monthId)).items[0]!;
    await updatePayrollItem(staff, { itemId: item.id, taxablePay: 1 }).then(
      () => expect.unreachable(),
      (e) => expect(expectAppError(e, 'PAYROLL_LOCKED').userMessage).toContain('확정된 급여입니다'),
    );
  });

  it('Control Tower — 원천세 준비 완료, 신고완료 대기, 기한 D-16', async () => {
    const b = keep(await getFilingBoard(staff, { period: P }));
    expect(b.integration.status).toBe('FILE_BASED');
    const row = b.rows.find((r) => r.clientId === clientId)!;
    const st = (s: string) => row.steps.find((x) => x.step === s)!.status;
    expect(st('payroll_input')).toBe('done');
    expect(st('earned_confirmed')).toBe('done');
    expect(st('business_confirmed')).toBe('na');
    expect(st('daily_confirmed')).toBe('na');
    expect(st('withholding_ready')).toBe('done');
    expect(st('simplified_statement_ready')).toBe('done');
    expect(st('local_tax_ready')).toBe('done');
    expect(st('filed')).toBe('pending');
    expect(st('receipt_collected')).toBe('pending');
    expect(row.dueDate).toBe('2026-10-12');
    expect(row.dDay).toBe(16);
    expect(row.nextAction?.label).toBe('신고 완료 표시');
    expect(row.blockers.join(' ')).toMatch(/MOCK/);
    expect(await getFilingBoard(staff, { period: P, dueWithinDays: 7 }).then((x) => x.rows.find((r) => r.clientId === clientId))).toBeUndefined();
    await expect(getFilingBoard(viewer, { period: P })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('신고 완료 표시(FILE_BASED) → 접수증 없으면 미완료 → 접수증·납부서 올리면 완료', async () => {
    const later = testContext(db, staff.actor, new Date('2026-10-08T15:00:00+09:00'));
    const jobs = await db.select().from(filingJobs).where(and(eq(filingJobs.clientId, clientId), eq(filingJobs.period, P)));
    const wh = jobs.find((j) => j.kind === 'withholding')!;
    const lc = jobs.find((j) => j.kind === 'local_income_tax')!;
    const f = keep(await markFiled(later, { filingJobId: wh.id, filedAt: '2026-10-08' }));
    expect(f.integrationStatus).toBe('FILE_BASED');
    expect(f.note).toContain('제출하지 않습니다');
    await expect(markFiled(later, { filingJobId: wh.id, filedAt: '2026-12-01' })).rejects.toBeInstanceOf(ValidationError);
    keep(await markFiled(later, { filingJobId: lc.id, filedAt: '2026-10-08T16:00:00+09:00' }));
    let b = await getFilingBoard(later, { period: P });
    let row = b.rows.find((r) => r.clientId === clientId)!;
    expect(row.steps.find((s) => s.step === 'filed')!.status).toBe('attention');
    expect(b.summary.receiptsMissing).toBeGreaterThanOrEqual(1);

    const pdf = (s: string) => Buffer.from(`%PDF-1.4\n% ${s}\n`);
    const r1 = keep(await uploadFilingResult(later, { filingJobId: wh.id, kind: 'receipt', fileName: '원천세_접수증.pdf', data: pdf('wh receipt') }));
    expect(r1.duplicate).toBe(false);
    expect(r1.result.canonical).toBe(true);
    const dup = await uploadFilingResult(later, { filingJobId: wh.id, kind: 'receipt', fileName: '원천세_접수증(1).pdf', data: pdf('wh receipt') });
    expect(dup.duplicate).toBe(true);
    keep(await uploadFilingResult(later, { filingJobId: lc.id, kind: 'receipt', fileName: '지방세_접수증.pdf', data: pdf('lc receipt') }));
    const whTax = (wh.payload as { totals: { incomeTax: number } }).totals.incomeTax;
    const s1 = keep(await uploadFilingResult(later, { filingJobId: wh.id, kind: 'payment_slip', fileName: `원천세_납부서_${whTax.toLocaleString('ko-KR')}원.pdf`, data: pdf('wh slip') }));
    expect(s1.amountSource).toBe('file_name');
    expect(s1.warnings.filter((w) => w.includes('≠'))).toEqual([]);
    const s2 = keep(await uploadFilingResult(later, { filingJobId: lc.id, kind: 'payment_slip', fileName: '지방세_납부서.pdf', data: pdf('lc slip'), amount: 1 }));
    expect(s2.warnings.join(' ')).toMatch(/≠/);
    await expect(uploadFilingResult(later, { filingJobId: lc.id, kind: 'receipt', fileName: 'x.zip', data: Buffer.from('PK\u0003\u0004zip') })).rejects.toBeInstanceOf(AppError);

    b = await getFilingBoard(later, { period: P });
    row = b.rows.find((r) => r.clientId === clientId)!;
    expect(row.steps.find((s) => s.step === 'filed')!.status).toBe('done');
    expect(row.steps.find((s) => s.step === 'receipt_collected')!.status).toBe('done');
    expect(row.steps.find((s) => s.step === 'payment_slip_collected')!.status).toBe('done');
    expect(row.complete).toBe(true);
    const [m] = await db.select().from(payrollMonths).where(eq(payrollMonths.id, monthId));
    expect(m!.status).toBe('filed');
    const detail = keep(await getFilingJob(later, wh.id));
    expect(detail.results.filter((x) => x.kind === 'receipt')).toHaveLength(1);

    // 신고 완료된 달은 되돌릴 수 없다 (수정신고 안내)
    await reopenPayrollMonth(admin, { payrollMonthId: monthId, reason: '테스트' }).then(
      () => expect.unreachable(),
      (e) => expectAppError(e, 'PAYROLL_ALREADY_FILED'),
    );
  });

  it('검토용 엑셀 — 요약·급여대장, 주민번호 마스킹만', async () => {
    const x = keep(await generateReviewExcel(staff, { payrollMonthId: monthId }));
    expect(x.sheets).toEqual(['요약', '급여대장', '변동 내역', '원천세 요약']);
    const file = await readTabularFile(x.data, x.fileName);
    const cells = file.sheets.flatMap((s) => s.rows.flat()).map((c) => (c === null ? '' : String(c)));
    expect(cells.some((c) => /^\d{6}-[12]\*{6}$/.test(c))).toBe(true);
    for (const c of cells) expect(RAW_RRN_PATTERN.test(c)).toBe(false);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'export.review_excel'));
    expect(audit!.category).toBe('download');
  });

  it('주민번호 열람 — payroll.sensitive 필요, 열람마다 감사(access)', async () => {
    const id = emp.get('김민수')!.id;
    await expect(revealEmployeeSensitive(staff, id, 'idNumber')).rejects.toBeInstanceOf(ForbiddenError);
    const r = await revealEmployeeSensitive(admin, id, 'idNumber');
    expect(r.value).toBe(rawRrns[0]);
    expect(r.masked).toMatch(/^\d{6}-[12]\*{6}$/);
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'employee.view_sensitive'), eq(auditLogs.entityId, id)));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.category).toBe('access');
    expect(logs[0]!.summary).toContain('주민번호 열람');
    expect(JSON.stringify(logs[0])).not.toContain(rawRrns[1]!);
    const acct = await revealEmployeeSensitive(admin, id, 'bankAccount');
    expect(acct.value).toBe('12345678900');
  });

  it('감사로그 — review/employee.update/confirm/export.create 기록, 요약 문장', async () => {
    const count = async (action: string) => (await db.select().from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.clientId, clientId)))).length;
    expect(await count('payroll.review')).toBe(1);
    expect(await count('employee.update')).toBeGreaterThanOrEqual(1);
    expect(await count('payroll.confirm')).toBe(1);
    expect(await count('export.create')).toBe(1);
    const [rev] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'payroll.review'), eq(auditLogs.clientId, clientId)));
    expect(rev!.summary).toMatch(/김민수 급여 변경 확인/);
    const [imp] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'payroll.item_import'), eq(auditLogs.clientId, clientId)));
    expect(imp!.summary).toBe('자료 반영: 김민수 과세급여 3,300,000원 → 3,630,000원, 지급총액 3,300,000원 → 3,630,000원, 소득세 90,000원 → 106,500원, 지방소득세 9,000원 → 10,650원');
  });
});

// ════════════════════════════ 사업소득·일용근로 세액 ════════════════════════════

describe('사업소득 3.3% · 일용근로 2.7% 자동 계산 + 지급명세서 작업', () => {
  let clientId = '';
  let monthId = '';
  const ids = new Map<string, string>();

  it('첫 달 — 직원 마스터에서 초안, 사업소득 1,000,000 → 30,000 / 3,000', async () => {
    const c = await createTestClient(db, { name: '계산상사' });
    clientId = c.id;
    const imp = keep(
      await importEmployees(staff, {
        clientId,
        rows: [
          { name: '프리랜서김', incomeType: '사업소득', idNumber: fakeRrn(31), baseSalary: 1_000_000, businessIncomeCode: '940909', paymentDay: 25 },
          { name: '일용박', incomeType: '일용', idNumber: fakeRrn(32), dailyWage: 200_000, paymentDay: 25 },
          { name: '근로최', incomeType: '근로', idNumber: fakeRrn(33, true), baseSalary: 2_500_000, paymentDay: 25 },
          { name: '', incomeType: '근로', rowNumber: 9 },
          { name: '오류행', incomeType: '알바', rowNumber: 10 },
        ],
      }),
    );
    expect(imp.created).toBe(3);
    expect(imp.failed.map((f) => f.rowNumber)).toEqual([9, 10]);
    for (const e of imp.employees) ids.set(e.name, e.id);
    const again = await importEmployees(staff, { clientId, rows: [{ name: '근로최', idNumber: rawRrns.at(-2)!, dependents: 2 }] });
    expect(again.updated).toBe(1);
    expect(again.created).toBe(0);

    const s = keep(await startPayrollMonth(staff, { clientId, period: P }));
    monthId = s.id;
    expect(s.carried.fromMaster).toBe(3);
    const d = keep(await getPayrollDiff(staff, monthId));
    expect(d.pendingCount).toBe(3);
    const detail = await getPayrollMonth(staff, monthId);
    const biz = detail.items.find((i) => i.name === '프리랜서김')!;
    expect(biz.incomeTax).toBe(30_000);
    expect(biz.localIncomeTax).toBe(3_000);
    expect(biz.netPay).toBe(967_000);
  });

  it('일용근로 (일당 200,000 × 5일) → 소득세 6,750 / 지방 670, 사업소득 세액 직접 입력은 거부', async () => {
    const detail = await getPayrollMonth(staff, monthId);
    const daily = detail.items.find((i) => i.name === '일용박')!;
    const r = keep(await updatePayrollItem(staff, { itemId: daily.id, workDays: 5, taxablePay: 1_000_000 }));
    expect(r.item.incomeTax).toBe(6_750);
    expect(r.item.localIncomeTax).toBe(670);
    expect(r.item.netPay).toBe(1_000_000 - 6_750 - 670);
    expect(r.item.reviewed).toBe(true);
    expect(r.manualTouches).toBe(1);
    const biz = detail.items.find((i) => i.name === '프리랜서김')!;
    await expect(updatePayrollItem(staff, { itemId: biz.id, incomeTax: 1 })).rejects.toBeInstanceOf(ValidationError);
    const earned = detail.items.find((i) => i.name === '근로최')!;
    const e = await updatePayrollItem(staff, { itemId: earned.id, incomeTax: 20_000 });
    expect(e.item.localIncomeTax).toBe(2_000);
    await approveChanges(staff, { payrollMonthId: monthId, itemIds: [biz.id] });
    const v = keep(await validatePayrollMonth(staff, monthId));
    expect(v.ok).toBe(true);
  });

  it('확정 — 사업소득 간이지급명세서·일용근로 지급명세서 (2026-11-02), A25/A03 포함', async () => {
    const w = await getWithholdingSummary(staff, monthId);
    expect(w.rows.map((r) => r.code)).toEqual(['A01', 'A03', 'A10', 'A25', 'A30', 'A99']);
    expect(w.total.incomeTax).toBe(20_000 + 6_750 + 30_000);
    const r = keep(await markReadyForFiling(admin, monthId));
    const byKind = new Map(r.filingJobs.map((j) => [j.kind, j]));
    expect(simplifiedStatementDueDate('business', P)).toBe('2026-11-02');
    expect(byKind.get('simplified_statement_business')).toMatchObject({ period: P, dueDate: '2026-11-02' });
    expect(byKind.get('daily_statement')).toMatchObject({ period: P, dueDate: '2026-11-02' });
    expect(byKind.get('withholding')).toMatchObject({ period: P, dueDate: '2026-10-12' });
    expect(r.exports.map((x) => x.kind).sort()).toEqual(['payroll_business', 'payroll_daily', 'payroll_earned']);
    // 관리자가 만든 사업소득 파일에는 주민번호가 들어간다 → 받을 때도 payroll.sensitive 필요
    const bizExport = r.exports.find((x) => x.kind === 'payroll_business')!;
    expect(bizExport.containsIdNumbers).toBe(true);
    await expect(downloadPayrollExport(staff, bizExport.id)).rejects.toBeInstanceOf(ForbiddenError);
    const dl = await downloadPayrollExport(admin, bizExport.id);
    expect(dl.data.length).toBeGreaterThan(0);
    const [a] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'export.download'), eq(auditLogs.entityId, bizExport.id)));
    expect(a!.category).toBe('download');
    expect(a!.summary).toContain('주민번호 포함');

    const board = await getFilingBoard(admin, { period: P });
    const row = board.rows.find((x) => x.clientId === clientId)!;
    expect(row.steps.find((s) => s.step === 'business_confirmed')!.status).toBe('done');
    expect(row.steps.find((s) => s.step === 'daily_confirmed')!.status).toBe('done');
    expect(row.steps.find((s) => s.step === 'simplified_statement_ready')!.status).toBe('done');
  });

  it('확정 되돌리기 (audit.revert) → 신고 작업에서 이번 달 몫 제거 → 재확정 시 중복 가산 없음', async () => {
    await expect(reopenPayrollMonth(staff, { payrollMonthId: monthId, reason: '세액 정정' })).rejects.toBeInstanceOf(ForbiddenError);
    const m = keep(await reopenPayrollMonth(admin, { payrollMonthId: monthId, reason: '세액 정정' }));
    expect(m.status).toBe('reviewing');
    const [wh] = await db.select().from(filingJobs).where(and(eq(filingJobs.clientId, clientId), eq(filingJobs.kind, 'withholding')));
    expect(Object.keys((wh!.payload as { months: object }).months)).toEqual([]);
    expect(wh!.steps.withholding_ready).toBeNull();
    const detail = await getPayrollMonth(admin, monthId);
    const earned = detail.items.find((i) => i.name === '근로최')!;
    await updatePayrollItem(admin, { itemId: earned.id, incomeTax: 21_000 });
    const r = await markReadyForFiling(admin, monthId);
    expect(r.alreadyConfirmed).toBe(false);
    const [wh2] = await db.select().from(filingJobs).where(and(eq(filingJobs.clientId, clientId), eq(filingJobs.kind, 'withholding')));
    expect((wh2!.payload as { totals: { incomeTax: number } }).totals.incomeTax).toBe(21_000 + 6_750 + 30_000);
    // 파일도 새 급여로 다시 만들어졌다 (오래된 파일은 차단)
    const stale = await db.select().from(exportJobs).where(and(eq(exportJobs.clientId, clientId), eq(exportJobs.kind, 'payroll_earned')));
    expect(stale.filter((x) => x.status === 'blocked').length).toBeGreaterThanOrEqual(1);
    expect(stale.filter((x) => x.status === 'ready')).toHaveLength(1);
  });
});

// ════════════════════════════ 부정 테스트 ════════════════════════════

describe('변동 유형 · 차단 조건', () => {
  it('+25% → 큰 변동, 0원 → zero_pay, 명단 없음 → keep 으로 전월 기준 추가 / on_leave 로 제외', async () => {
    const c = await createTestClient(db, { name: '변동상사' });
    const mk = (name: string, i: number, base: number) =>
      createEmployee(staff, { clientId: c.id, name, incomeType: 'earned', idNumber: fakeRrn(40 + i), baseSalary: base, paymentDay: 10 });
    const a = await mk('가대리', 1, 3_000_000);
    const b = await mk('나사원', 2, 2_500_000);
    const d = await mk('다주임', 3, 2_800_000);
    const e = await mk('라과장', 4, 3_500_000);
    await insertConfirmedMonth(
      c.id,
      PREV,
      [a, b, d, e].map((x) => ({ employeeId: x.id, taxable: x.baseSalary, nonTaxable: 0, incomeTax: fixtureTax(x.baseSalary) })),
      '10',
    );
    const m = await startPayrollMonth(staff, { clientId: c.id, period: P });
    const r = await applyPayrollRows(staff, {
      payrollMonthId: m.id,
      fullRoster: true,
      rows: [
        { name: '가대리', taxablePay: 3_750_000, incomeTax: fixtureTax(3_750_000) },
        { name: '나사원', taxablePay: 0, incomeTax: 0 },
        { name: '없는사람', taxablePay: 1_000_000 },
      ],
    });
    expect(r.unmatched.map((u) => u.name)).toEqual(['없는사람']);
    expect(r.removedNotInRoster.map((x) => x.name).sort()).toEqual(['다주임', '라과장']);
    const diff = await getPayrollDiff(staff, m.id);
    const k = (n: string) => diff.changes.find((x) => x.name === n)!;
    expect(k('가대리').kinds).toEqual(expect.arrayContaining(['pay_changed', 'pay_changed_large']));
    expect(k('가대리').severity).toBe('warning');
    expect(k('나사원').kinds).toEqual(expect.arrayContaining(['zero_pay']));
    expect(k('다주임').kinds).toEqual(['missing_this_month']);

    const after = await confirmNewAndResigned(staff, {
      payrollMonthId: m.id,
      decisions: [
        { employeeId: d.id, decision: 'keep' },
        { employeeId: e.id, decision: 'on_leave' },
      ],
    });
    expect(after.changes.find((x) => x.name === '다주임')!.decision).toBe('keep');
    const detail = await getPayrollMonth(staff, m.id);
    expect(detail.items.find((i) => i.name === '다주임')!.grossPay).toBe(2_800_000);
    expect(detail.items.find((i) => i.name === '다주임')!.origin).toBe('manual');
    const [le] = await db.select().from(employees).where(eq(employees.id, e.id));
    expect(le!.reportStatus).toContain('휴직');
    expect(after.pendingCount).toBe(2);
    expect(detail.manualTouches).toBe(2);
  });

  it('주민번호 없는 직원 → 확정 차단 "주민번호가 없는 직원 1명"', async () => {
    const c = await createTestClient(db, { name: '누락상사' });
    const x = await createEmployee(staff, { clientId: c.id, name: '무번호', incomeType: 'earned', baseSalary: 2_000_000, paymentDay: 25 });
    expect(x.hasIdNumber).toBe(false);
    expect(x.warnings.join(' ')).toContain('주민(외국인)등록번호 미등록');
    const m = await startPayrollMonth(staff, { clientId: c.id, period: P });
    const diff = await getPayrollDiff(staff, m.id);
    expect(diff.changes[0]!.kinds).toEqual(expect.arrayContaining(['new_hire', 'missing_id']));
    const item = (await getPayrollMonth(staff, m.id)).items[0]!;
    await updatePayrollItem(staff, { itemId: item.id, incomeTax: 15_000 });
    await markReadyForFiling(staff, m.id).then(
      () => expect.unreachable(),
      (e) => expect((e as AppError).userMessage).toContain('주민번호가 없는 직원 1명'),
    );
    // 주민번호 등록 → 통과
    const upd = keep(await updateEmployee(staff, x.id, { idNumber: fakeRrn(60) }));
    expect(upd.hasIdNumber).toBe(true);
    const ok = await markReadyForFiling(staff, m.id);
    expect(ok.month.status).toBe('confirmed');
  });

  it('퇴사 처리·입력 검증·권한', async () => {
    const c = await createTestClient(db, { name: '검증상사' });
    const x = await createEmployee(staff, { clientId: c.id, name: '퇴사예정', incomeType: 'earned', idNumber: fakeRrn(70), hireDate: '2025-01-02' });
    await expect(resignEmployee(staff, x.id, '2024-12-31')).rejects.toBeInstanceOf(ValidationError);
    const r = keep(await resignEmployee(staff, x.id, '2026-09-30'));
    expect(r.resignDate).toBe('2026-09-30');
    await expect(createEmployee(staff, { clientId: c.id, name: '가', incomeType: 'earned', idNumber: '900101-1******' })).rejects.toBeInstanceOf(ValidationError);
    await expect(createEmployee(staff, { clientId: c.id, name: '가', incomeType: 'earned', baseSalary: 1.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createEmployee(viewer, { clientId: c.id, name: '가', incomeType: 'earned' })).rejects.toBeInstanceOf(ForbiddenError);
    const templates = await getPayrollTemplates(staff);
    expect(templates.every((t) => t.status === 'mock' && t.warning)).toBe(true);
  });

  it('수임처 급여 엑셀 파일 반영 (제목행 자동 인식, 합계행 무시)', async () => {
    const c = await createTestClient(db, { name: '엑셀상사' });
    const a = await createEmployee(staff, { clientId: c.id, name: '홍엑셀', incomeType: 'earned', idNumber: fakeRrn(80), baseSalary: 2_000_000, paymentDay: 25 });
    await insertConfirmedMonth(c.id, PREV, [{ employeeId: a.id, taxable: 2_000_000, nonTaxable: 0, incomeTax: fixtureTax(2_000_000) }]);
    const m = await startPayrollMonth(staff, { clientId: c.id, period: P });
    const csv = ['9월 급여대장', '성명,과세급여,비과세,소득세,지급일', `홍엑셀,"2,200,000",0,${fixtureTax(2_200_000)},2026-09-25`, '합계,"2,200,000",0,0,'].join('\n');
    const r = keep(await importPayrollFile(staff, { payrollMonthId: m.id, fileName: '급여대장.csv', data: Buffer.from(csv, 'utf8') }));
    expect(r.changed).toBe(1);
    expect(r.unmatched).toEqual([]);
    expect(r.diff.changes.map((x) => x.name)).toEqual(['홍엑셀']);
    expect(r.fileId).toBeTruthy();
  });
});

// ════════════════════════════ 민감정보 ════════════════════════════

describe('주민번호 원문 노출 없음', () => {
  it('모든 서비스 결과 JSON 에 주민번호 원문이 없다', () => {
    const json = JSON.stringify(seen, (k, v) => (k === 'sha256' || k === 'data' || k === 'value' ? undefined : v));
    for (const r of rawRrns) expect(json).not.toContain(r);
    expect(RAW_RRN_PATTERN.test(json)).toBe(false);
    expect(json).toMatch(/\d{6}-[12]\*{6}/);
  });

  it('감사로그 before/after 에도 원문이 없다', async () => {
    const rows = await db.select({ b: auditLogs.beforeData, a: auditLogs.afterData, s: auditLogs.summary }).from(auditLogs);
    const json = JSON.stringify(rows);
    for (const r of rawRrns) expect(json).not.toContain(r);
    expect(RAW_RRN_PATTERN.test(json)).toBe(false);
  });

  it('반기납부 수임처 — 9월분 원천세는 2026-12 반기 작업(기한 2027-01-11)에 누적', async () => {
    const c = await createTestClient(db, { name: '반기상사' });
    await db.update(clientBusinessProfiles).set({ withholdingSemiannual: true }).where(eq(clientBusinessProfiles.clientId, c.id));
    const x = await createEmployee(staff, { clientId: c.id, name: '반기직원', incomeType: 'earned', idNumber: fakeRrn(90), baseSalary: 2_400_000, paymentDay: 25 });
    const m = await startPayrollMonth(staff, { clientId: c.id, period: P });
    const item = (await getPayrollMonth(staff, m.id)).items[0]!;
    await updatePayrollItem(staff, { itemId: item.id, incomeTax: 30_000 });
    const r = await markReadyForFiling(staff, m.id);
    const wh = r.filingJobs.find((j) => j.kind === 'withholding')!;
    expect(wh).toMatchObject({ period: '2026-12', dueDate: '2027-01-11' });
    const board = await getFilingBoard(staff, { period: P });
    const row = board.rows.find((b) => b.clientId === c.id)!;
    expect(row.cycle).toBe('semiannual');
    expect(row.filingDueThisPeriod).toBe(false);
    expect(row.steps.find((s) => s.step === 'withholding_ready')!.status).toBe('done');
    expect(x.id).toBeTruthy();
  });
});
