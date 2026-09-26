/**
 * 6단계 — 원천징수이행상황신고서 요약(A01/A03/A10/A25/A30/A99) + 지방소득세 특별징수 + 지급명세서 행 수.
 * 신고 파일은 WEHAGO 가 만든다 (FILE_BASED). 여기 값은 WEHAGO 마감값과 대조하기 위한 신고 전 검증 집계다.
 * 집계는 급여 행 합계(SQL)와 1원 단위까지 같아야 하며, 다르면 신고 연계를 막는다.
 */
import { sql } from 'drizzle-orm';
import type { IncomeType } from '@mintax/core';
import {
  KR_HOLIDAYS,
  buildSimplifiedStatements,
  buildWithholdingReturn,
  type CalendarOptions,
  type StatementBundle,
  type StatementEmployee,
} from '@mintax/core/payroll/index';
import type { ServiceContext } from '../context';
import { requirePermission } from '../context';
import { getSetting } from '../infra/settings';
import { assertUuid, emptyMoneyTotals, halfEndOf, itemToLine, isLocalDate, type MoneyTotals } from './helpers';
import { nameOf } from './month-engine';
import { loadEmployeeRows, loadItemRows, loadMonthContext, snapshotOf, type MonthContext } from './store';
import type { StatementSummaryDTO, WithholdingSummaryDTO } from './types';

export const WITHHOLDING_NOTE =
  '전자신고 API가 없습니다(FILE_BASED). WEHAGO 원천세 마감 → 전자신고 파일 생성 → 사람이 홈택스 "파일 변환신고"로 제출하고, 지방소득세는 위택스에서 신고합니다. 접수증·납부서는 MIN TAX OPS에 올려 주세요.';

/** 설정의 임시공휴일 등 추가 휴일 (settings.kr_extra_holidays = ['2026-10-02', ...]) */
export const EXTRA_HOLIDAYS_SETTING = 'kr_extra_holidays';

export async function loadCalendarOptions(ctx: Pick<ServiceContext, 'db'>): Promise<CalendarOptions> {
  const extra = await getSetting<unknown>(ctx, EXTRA_HOLIDAYS_SETTING, []);
  const list = Array.isArray(extra) ? extra.filter((d): d is string => isLocalDate(d)) : [];
  return list.length ? { holidays: [...KR_HOLIDAYS, ...list.map((date) => ({ date, name: '임시공휴일(설정)' }))] } : {};
}

interface ItemSums {
  paid: number;
  byIncomeType: Record<IncomeType, MoneyTotals>;
  totals: MoneyTotals;
}

/** 급여 행 합계 — DB 에서 직접 집계 (계산 경로와 독립적인 대조값) */
export async function sumItemsInDb(ctx: Pick<ServiceContext, 'db'>, payrollMonthId: string): Promise<ItemSums> {
  const r = await ctx.db.execute<{
    income_type: IncomeType;
    headcount: number;
    paid: number;
    taxable: string;
    non_taxable: string;
    gross: string;
    income_tax: string;
    local_tax: string;
    other: string;
    net: string;
  }>(sql`
    select income_type, count(*)::int as headcount,
      count(*) filter (where gross_pay <> 0 or income_tax <> 0)::int as paid,
      coalesce(sum(taxable_pay), 0)::text as taxable, coalesce(sum(non_taxable_pay), 0)::text as non_taxable,
      coalesce(sum(gross_pay), 0)::text as gross, coalesce(sum(income_tax), 0)::text as income_tax,
      coalesce(sum(local_income_tax), 0)::text as local_tax, coalesce(sum(other_deductions), 0)::text as other,
      coalesce(sum(net_pay), 0)::text as net
    from payroll_items where payroll_month_id = ${payrollMonthId}
    group by income_type
  `);
  const by: Record<IncomeType, MoneyTotals> = { earned: emptyMoneyTotals(), business: emptyMoneyTotals(), daily: emptyMoneyTotals() };
  const totals = emptyMoneyTotals();
  let paid = 0;
  for (const row of r.rows) {
    const t: MoneyTotals = {
      headcount: Number(row.headcount),
      taxablePay: Number(row.taxable),
      nonTaxablePay: Number(row.non_taxable),
      grossPay: Number(row.gross),
      incomeTax: Number(row.income_tax),
      localIncomeTax: Number(row.local_tax),
      otherDeductions: Number(row.other),
      netPay: Number(row.net),
    };
    by[row.income_type] = t;
    paid += Number(row.paid);
    for (const k of Object.keys(totals) as Array<keyof MoneyTotals>) totals[k] += t[k];
  }
  return { paid, byIncomeType: by, totals };
}

export interface WithholdingComputation {
  dto: WithholdingSummaryDTO;
  /** 지급명세서 종류별 대상 직원 ID (반기 묶음 작업의 실인원 계산용 — 민감정보 아님) */
  statementEmployeeIds: Record<'earned' | 'business' | 'daily', string[]>;
  paidEmployeeIds: string[];
}

function statementDTO(b: StatementBundle<{ employeeId: string }>, kind: 'earned' | 'business' | 'daily'): StatementSummaryDTO {
  return {
    kind,
    label: b.label,
    rows: b.rows.length,
    persons: b.totals.persons,
    paidAmount: b.totals.paidAmount,
    incomeTax: b.totals.incomeTax,
    localIncomeTax: b.totals.localIncomeTax,
    cycle: b.due.cycle,
    submissionPeriod: b.due.submissionPeriod,
    dueDate: b.due.dueDate,
    shiftNote: b.due.shiftNote,
    filingPeriod: b.due.submissionPeriod.to,
    status: b.due.status,
    note: b.due.note,
  };
}

/** 권한 검사 없음 (confirm·review Excel 공용) */
export async function computeWithholding(ctx: ServiceContext, payrollMonthId: string, mcIn?: MonthContext): Promise<WithholdingComputation> {
  const mc = mcIn ?? (await loadMonthContext(ctx, payrollMonthId));
  const m = mc.month;
  const [items, employees, calOpts, sums] = await Promise.all([
    loadItemRows(ctx, m.id),
    loadEmployeeRows(ctx, m.clientId),
    loadCalendarOptions(ctx),
    sumItemsInDb(ctx, m.id),
  ]);
  const empById = new Map(employees.map((e) => [e.id, e]));
  const lines = items.map((i) => itemToLine(i, nameOf(empById, i.employeeId)));
  const semiannual = mc.semiannual;
  const wr = buildWithholdingReturn(lines, m.paymentPeriod, { ...calOpts, semiannual, attributionPeriod: m.period });
  const stEmployees: StatementEmployee[] = employees.map((e) => ({ ...snapshotOf(e), businessIncomeCode: e.businessIncomeCode }));
  const st = buildSimplifiedStatements(lines, stEmployees, m.paymentPeriod, calOpts);

  // 1원 단위 대조 (계산 결과 vs DB 합계)
  const mismatches: string[] = [];
  const eq = (label: string, a: number, b: number) => {
    if (a !== b) mismatches.push(`${label}: 신고 요약 ${a.toLocaleString('ko-KR')} ≠ 급여 행 합계 ${b.toLocaleString('ko-KR')}`);
  };
  eq('소득세 합계(A99)', wr.total.incomeTax, sums.totals.incomeTax);
  eq('총지급액(A99)', wr.total.totalPay, sums.totals.grossPay);
  eq('인원(A99)', wr.total.persons, sums.paid);
  eq('지방소득세 합계', wr.localIncomeTax.declared, sums.totals.localIncomeTax);
  for (const t of ['earned', 'business', 'daily'] as const) eq(`지방소득세(${t})`, wr.localIncomeTax.byIncomeType[t], sums.byIncomeType[t].localIncomeTax);
  eq('사업소득 간이지급명세서 지급액', st.business.totals.paidAmount, sums.byIncomeType.business.grossPay);
  eq('사업소득 간이지급명세서 소득세', st.business.totals.incomeTax, sums.byIncomeType.business.incomeTax);
  eq('일용근로 지급명세서 지급액', st.daily.totals.paidAmount, sums.byIncomeType.daily.grossPay);
  eq('근로소득 간이지급명세서 지급액', st.earned.totals.paidAmount, sums.byIncomeType.earned.grossPay);

  const blockedReasons: string[] = [];
  if (mismatches.length) blockedReasons.push(`신고 요약이 급여 행 합계와 다릅니다 (${mismatches.length}건) — 급여 행을 다시 저장한 뒤 다시 확인하세요.`);
  if (wr.excludedLines.length) blockedReasons.push(`금액 형식 오류 ${wr.excludedLines.length}건이 집계에서 빠졌습니다 — 수정 후 다시 확인하세요.`);
  if (!wr.localIncomeTax.matches) blockedReasons.push(`지방소득세 합계(${wr.localIncomeTax.declared.toLocaleString('ko-KR')}원)가 소득세 × 10% 재계산(${wr.localIncomeTax.expected.toLocaleString('ko-KR')}원)과 다릅니다.`);
  if (items.length === 0) blockedReasons.push('급여 행이 없습니다.');

  const statements: StatementSummaryDTO[] = [];
  if (st.earned.rows.length) statements.push(statementDTO(st.earned, 'earned'));
  if (st.business.rows.length) statements.push(statementDTO(st.business, 'business'));
  if (st.daily.rows.length) statements.push(statementDTO(st.daily, 'daily'));

  const dto: WithholdingSummaryDTO = {
    payrollMonthId: m.id,
    clientId: m.clientId,
    clientName: mc.clientName,
    period: m.period,
    paymentPeriod: m.paymentPeriod,
    semiannual,
    filingPeriod: semiannual ? halfEndOf(m.paymentPeriod) : m.paymentPeriod,
    rows: wr.rows.map((r) => ({ code: r.code, label: r.label, persons: r.persons, totalPay: r.totalPay, incomeTax: r.incomeTax, isSubtotal: r.isSubtotal })),
    total: { persons: wr.total.persons, totalPay: wr.total.totalPay, incomeTax: wr.total.incomeTax },
    localIncomeTax: {
      declared: wr.localIncomeTax.declared,
      expected: wr.localIncomeTax.expected,
      matches: wr.localIncomeTax.matches,
      byIncomeType: wr.localIncomeTax.byIncomeType,
      dueDate: wr.localIncomeTax.dueDate,
    },
    dueDate: wr.dueDate,
    dueNote: wr.dueNote,
    statements,
    itemTotals: { ...sums.totals, byIncomeType: sums.byIncomeType },
    consistency: { ok: mismatches.length === 0, mismatches },
    blocked: blockedReasons.length > 0,
    blockedReasons,
    warnings: [...wr.warnings, ...st.warnings.filter((w) => !wr.warnings.includes(w))],
    notCovered: wr.notCovered,
    integrationStatus: 'FILE_BASED',
    note: WITHHOLDING_NOTE,
  };
  const paidEmployeeIds = [...new Set(lines.filter((l) => l.grossPay !== 0 || l.incomeTax !== 0).map((l) => l.employeeId))];
  return {
    dto,
    paidEmployeeIds,
    statementEmployeeIds: {
      earned: [...new Set(st.earned.rows.map((r) => r.employeeId))],
      business: [...new Set(st.business.rows.map((r) => r.employeeId))],
      daily: [...new Set(st.daily.rows.map((r) => r.employeeId))],
    },
  };
}

/** 6단계 — 원천세·지방소득세·지급명세서 신고 전 요약 (급여 행 합계와 1원 단위 일치해야 함) */
export async function getWithholdingSummary(ctx: ServiceContext, payrollMonthId: string): Promise<WithholdingSummaryDTO> {
  requirePermission(ctx, 'payroll.read');
  assertUuid(payrollMonthId, 'payrollMonthId', '급여 월');
  return (await computeWithholding(ctx, payrollMonthId)).dto;
}
