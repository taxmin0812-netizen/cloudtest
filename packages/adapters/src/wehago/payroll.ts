/**
 * 급여·사업소득·일용직 WEHAGO 업로드 파일 (서식 확보 전 MOCK 서식).
 *
 * 주민번호는 서버가 권한 확인 후 복호화해 넘긴 경우에만 파일에 숫자로 쓴다. 로그·오류 메시지에는 절대 넣지 않는다.
 */
import { formatWon, normalizeDate, parseWon, type IncomeType, type PayrollLine, type Won, type YearMonth } from '@mintax/core';
import { AdapterError } from '../errors';
import type { CellValue } from '../file/read';
import { checkTraceIntegrity, readTemplateWorkbook, writeTemplateWorkbook, type FieldRecord, type ParsedTemplateFile } from './render';
import { templateHeaderHash, validateTemplate, type ExportField, type WehagoTemplate, type WehagoTemplateKind } from './templates';

export interface PayrollExportRow extends PayrollLine {
  /** WEHAGO 사원코드 / 소득자코드 */
  employeeCode: string;
  /** 귀속년월 'YYYY-MM' */
  attributionMonth: YearMonth;
  /** 주민(외국인)등록번호 — 복호화 값(숫자 13자리). 없으면 빈칸 + 경고 */
  idNumber?: string | null;
  /** 사업소득 업종코드 (예: 940909) */
  incomeCategoryCode?: string | null;
  /** 사업소득 세율 % (예: 3) */
  taxRate?: number | null;
  dailyWage?: Won | null;
  studentLoanRepayment?: Won | null;
}

export interface PayrollExportTotals {
  count: number;
  grossPay: Won;
  incomeTax: Won;
  localIncomeTax: Won;
  netPay: Won;
}

export interface PayrollIssue {
  rowIndex: number | null;
  employeeId: string | null;
  code: string;
  message: string;
}

const KIND_INCOME: Record<Exclude<WehagoTemplateKind, 'purchase_sales' | 'general_journal'>, IncomeType> = {
  payroll_earned: 'earned',
  payroll_business: 'business',
  payroll_daily: 'daily',
};

export function computePayrollTotals(rows: readonly PayrollLine[]): PayrollExportTotals {
  const t: PayrollExportTotals = { count: 0, grossPay: 0, incomeTax: 0, localIncomeTax: 0, netPay: 0 };
  for (const r of rows) {
    t.count++;
    t.grossPay += r.grossPay;
    t.incomeTax += r.incomeTax;
    t.localIncomeTax += r.localIncomeTax;
    t.netPay += r.netPay;
  }
  return t;
}

export function validatePayrollRows(
  template: WehagoTemplate,
  rows: readonly PayrollExportRow[],
): { ok: boolean; errors: PayrollIssue[]; warnings: PayrollIssue[]; totals: PayrollExportTotals } {
  const errors: PayrollIssue[] = [];
  const warnings: PayrollIssue[] = [];
  const incomeType = KIND_INCOME[template.kind as keyof typeof KIND_INCOME];
  if (!incomeType) errors.push({ rowIndex: null, employeeId: null, code: 'wrong_template', message: `급여 서식이 아닙니다 (${template.name}).` });
  for (const m of validateTemplate(template)) errors.push({ rowIndex: null, employeeId: null, code: 'template_invalid', message: `서식 오류: ${m}` });
  if (!template.verified) {
    warnings.push({
      rowIndex: null,
      employeeId: null,
      code: 'unverified_template',
      message: template.status === 'mock' ? `임시(MOCK) 서식입니다 (${template.name}) — WEHAGO 실서식 등록 전에는 업로드하지 마세요.` : `검증되지 않은 서식입니다 (${template.name}).`,
    });
  }
  if (rows.length === 0) errors.push({ rowIndex: null, employeeId: null, code: 'empty', message: '전송할 인원이 없습니다.' });
  const hasIdColumn = template.columns.some((c) => c.field === 'idNumber');
  const codes = new Set<string>();

  rows.forEach((r, i) => {
    const e = (code: string, message: string) => errors.push({ rowIndex: i, employeeId: r.employeeId, code, message: `${r.name}: ${message}` });
    const w = (code: string, message: string) => warnings.push({ rowIndex: i, employeeId: r.employeeId, code, message: `${r.name}: ${message}` });
    if (incomeType && r.incomeType !== incomeType) e('income_type', `소득구분(${r.incomeType})이 서식(${incomeType})과 다릅니다.`);
    if (!r.employeeCode?.trim()) e('missing_code', '사원코드가 없습니다.');
    else if (codes.has(r.employeeCode)) e('duplicate_code', `사원코드 ${r.employeeCode} 가 중복됩니다 (WEHAGO 는 중복 행을 제외함).`);
    codes.add(r.employeeCode);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(r.attributionMonth)) e('invalid_month', `귀속년월 형식 오류: "${r.attributionMonth}"`);
    if (!r.paymentDate || normalizeDate(r.paymentDate) !== r.paymentDate) e('invalid_payment_date', `지급일 형식 오류: "${r.paymentDate ?? ''}"`);
    for (const [k, v] of Object.entries({ taxablePay: r.taxablePay, nonTaxablePay: r.nonTaxablePay, grossPay: r.grossPay, incomeTax: r.incomeTax, localIncomeTax: r.localIncomeTax, otherDeductions: r.otherDeductions, netPay: r.netPay })) {
      if (!Number.isSafeInteger(v)) e('not_integer', `${k} 는 원 단위 정수여야 합니다.`);
    }
    if (r.taxablePay + r.nonTaxablePay !== r.grossPay) e('gross_mismatch', `과세 ${formatWon(r.taxablePay)} + 비과세 ${formatWon(r.nonTaxablePay)} ≠ 지급총액 ${formatWon(r.grossPay)}`);
    const net = r.grossPay - r.incomeTax - r.localIncomeTax - r.otherDeductions - (r.studentLoanRepayment ?? 0);
    if (net !== r.netPay) e('net_mismatch', `차인지급액 ${formatWon(r.netPay)} ≠ 지급총액 − 공제 ${formatWon(net)}`);
    if (hasIdColumn) {
      const d = (r.idNumber ?? '').replace(/\D/g, '');
      if (!d) w('missing_id', '주민(외국인)등록번호가 없습니다 — WEHAGO 에서 직접 입력해야 합니다.');
      else if (d.length !== 13) e('invalid_id', '주민(외국인)등록번호 자릿수가 13자리가 아닙니다.');
    }
    if (template.kind === 'payroll_daily') {
      if (!r.workDays || r.workDays <= 0) e('missing_work_days', '근무일수가 없습니다.');
      if (r.dailyWage && r.workDays && r.dailyWage * r.workDays !== r.grossPay) w('daily_wage_mismatch', `일당 × 근무일수(${formatWon(r.dailyWage * r.workDays)}) ≠ 지급총액`);
    }
    if (template.kind === 'payroll_business' && !r.incomeCategoryCode) e('missing_income_code', '사업소득 업종코드(소득구분)가 없습니다.');
  });
  return { ok: errors.length === 0, errors, warnings, totals: computePayrollTotals(rows) };
}

function recordOf(r: PayrollExportRow): FieldRecord {
  return {
    employeeCode: r.employeeCode,
    employeeName: r.name,
    idNumber: r.idNumber ? r.idNumber.replace(/\D/g, '') : null,
    attributionMonth: r.attributionMonth,
    paymentDate: r.paymentDate,
    taxablePay: r.taxablePay,
    nonTaxablePay: r.nonTaxablePay,
    grossPay: r.grossPay,
    incomeTax: r.incomeTax,
    localIncomeTax: r.localIncomeTax,
    otherDeductions: r.otherDeductions,
    netPay: r.netPay,
    workDays: r.workDays ?? null,
    dailyWage: r.dailyWage ?? null,
    incomeCategoryCode: r.incomeCategoryCode ?? null,
    taxRate: r.taxRate ?? null,
    studentLoanRepayment: r.studentLoanRepayment ?? null,
  };
}

export async function writePayrollExport(
  template: WehagoTemplate,
  rows: readonly PayrollExportRow[],
  meta: {
    generatedAt?: Date;
    includeTraceSheet?: boolean;
    /** MOCK 서식으로도 파일을 만든다 (미리보기·테스트 전용 — WEHAGO 업로드 금지) */
    allowMockTemplate?: boolean;
  } = {},
): Promise<Buffer> {
  // 열 구성이 확인되지 않은 임시 서식으로 만든 파일이 '업로드용'으로 오인되지 않게, 명시적으로 허용할 때만 만든다
  if (template.status === 'mock' && !meta.allowMockTemplate) {
    throw new AdapterError(
      'EXPORT_VALIDATION_FAILED',
      `임시(MOCK) 서식이라 업로드 파일을 만들지 않습니다 (${template.name}). WEHAGO 에서 내려받은 실제 엑셀서식을 먼저 등록해 주세요.`,
      { templateKey: template.key, status: template.status },
    );
  }
  const v = validatePayrollRows(template, rows);
  if (!v.ok) {
    throw new AdapterError('EXPORT_VALIDATION_FAILED', `급여 파일을 만들 수 없습니다 — 오류 ${v.errors.length}건: ${v.errors.slice(0, 3).map((e) => e.message).join(' / ')}`, {
      errors: v.errors,
    });
  }
  const allowanceNames = template.dynamicAllowanceColumns ? [...new Set(rows.flatMap((r) => Object.keys(r.allowances ?? {})))].sort((a, b) => a.localeCompare(b, 'ko')) : [];
  const byId = new Map(rows.map((r) => [r.employeeId, r]));
  return writeTemplateWorkbook(template, rows.map(recordOf), {
    generatedAt: meta.generatedAt,
    includeTraceSheet: meta.includeTraceSheet ?? template.traceSheet,
    traceColumns: ['grossPay', 'incomeTax', 'localIncomeTax', 'netPay'],
    traceIdOf: (i) => rows[i]!.employeeId,
    traceAmountsOf: (id) => {
      const r = byId.get(id)!;
      return [r.grossPay, r.incomeTax, r.localIncomeTax, r.netPay];
    },
    extraColumns: allowanceNames.map((name) => ({ header: name, valueOf: (i: number) => rows[i]!.allowances?.[name] ?? null })),
  });
}

export interface PayrollVerifyResult {
  ok: boolean;
  actual: PayrollExportTotals & { employeeIds: string[] };
  expected: PayrollExportTotals & { employeeIds: string[] };
  diffs: Array<{ code: string; message: string; blocking: boolean }>;
  summary: string;
}

/** 생성된 급여 파일을 다시 읽어 인원·지급총액·세액·차인지급액을 1원 단위로 비교 */
export async function verifyPayrollExportFile(
  buffer: Buffer,
  template: WehagoTemplate,
  expected: PayrollExportTotals & { employeeIds: string[] },
): Promise<PayrollVerifyResult> {
  const diffs: PayrollVerifyResult['diffs'] = [];
  const block = (code: string, message: string) => diffs.push({ code, message, blocking: true });
  const actual: PayrollExportTotals & { employeeIds: string[] } = { count: 0, grossPay: 0, incomeTax: 0, localIncomeTax: 0, netPay: 0, employeeIds: [] };
  let parsed: ParsedTemplateFile;
  try {
    parsed = await readTemplateWorkbook(buffer, template);
  } catch (e) {
    block('sheet_missing', `파일을 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
    return {
      ok: false,
      actual,
      expected: { ...expected, employeeIds: [...expected.employeeIds] },
      diffs,
      summary: `전송 금지: ${diffs[0]!.message}`,
    };
  }
  if (!parsed.sheetName) block('sheet_missing', `데이터 시트(${template.sheetName})가 없습니다.`);
  for (const m of parsed.headerMismatches) block('header_mismatch', `제목행이 서식과 다릅니다: ${m}`);
  if (parsed.trace && parsed.trace.headerHash !== templateHeaderHash(template)) block('template_changed', '파일 생성 당시 서식과 현재 서식이 다릅니다.');
  for (const issue of checkTraceIntegrity(parsed, template)) block(issue.code, issue.message);

  // 숫자 셀만 금액으로 인정 (텍스트 금액은 WEHAGO 가 다르게 읽을 수 있음)
  const num = (v: CellValue | undefined, label: string, row: number): number => {
    if (v === null || v === undefined || v === '') return 0;
    const n = typeof v === 'number' ? parseWon(v) : null;
    if (n === null) {
      block('unreadable_amount', `${row}행 ${label} 금액을 읽을 수 없습니다${typeof v === 'string' ? ' (숫자가 아닌 텍스트 셀)' : ''}.`);
      return 0;
    }
    return n;
  };
  const perRow = new Map<number, number[]>();
  for (const { excelRow, values } of parsed.dataRows) {
    const f = (k: ExportField, label: string) => num(values[k], label, excelRow);
    const a = [f('grossPay', '지급총액'), f('incomeTax', '소득세'), f('localIncomeTax', '지방소득세'), f('netPay', '차인지급액')];
    perRow.set(excelRow, a);
    actual.count++;
    actual.grossPay += a[0]!;
    actual.incomeTax += a[1]!;
    actual.localIncomeTax += a[2]!;
    actual.netPay += a[3]!;
  }
  if (parsed.trace) {
    const expSet = new Set(expected.employeeIds);
    const traced = new Set<number>();
    for (const e of parsed.trace.entries) {
      if (actual.employeeIds.includes(e.id)) block('duplicate_employee', `같은 인원이 파일에 두 번 있습니다 (${e.id}).`);
      actual.employeeIds.push(e.id);
      traced.add(e.firstRow);
      const a = perRow.get(e.firstRow);
      if (!a || a.some((x, k) => x !== e.amounts[k])) block('row_amount_mismatch', `${e.firstRow}행: 생성 당시 금액과 다릅니다.`);
      if (!expSet.has(e.id)) block('extra_employee', `대상이 아닌 인원이 파일에 있습니다 (${e.id}).`);
    }
    const seen = new Set(actual.employeeIds);
    for (const id of expected.employeeIds) if (!seen.has(id)) block('missing_employee', `인원 ${id} 가 파일에 없습니다.`);
    for (const { excelRow } of parsed.dataRows) if (!traced.has(excelRow)) block('untraced_row', `${excelRow}행은 생성 당시 없던 행입니다 (추가·이동된 행).`);
  } else {
    diffs.push({ code: 'no_trace', message: '추적 시트가 없어 인원은 건수로만 확인했습니다.', blocking: false });
  }
  const cmp = (label: string, a: number, b: number, won = true) => {
    if (a !== b) block('total_mismatch', `${label}: 파일 ${won ? formatWon(a) : `${a}명`} / 기대 ${won ? formatWon(b) : `${b}명`}`);
  };
  cmp('인원', actual.count, expected.count, false);
  cmp('지급총액', actual.grossPay, expected.grossPay);
  cmp('소득세', actual.incomeTax, expected.incomeTax);
  cmp('지방소득세', actual.localIncomeTax, expected.localIncomeTax);
  cmp('차인지급액', actual.netPay, expected.netPay);
  const blocking = diffs.filter((d) => d.blocking);
  return {
    ok: blocking.length === 0,
    actual,
    expected: { ...expected, employeeIds: [...expected.employeeIds] },
    diffs,
    summary: blocking.length === 0 ? `검증 통과: ${actual.count}명 · 지급총액 ${formatWon(actual.grossPay)} · 차인지급액 ${formatWon(actual.netPay)}` : `전송 금지: ${blocking[0]!.message}`,
  };
}
