import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { AdapterError } from '../errors';
import { readTabularFile } from '../file/read';
import { computePayrollTotals, validatePayrollRows, verifyPayrollExportFile, writePayrollExport, type PayrollExportRow } from './payroll';
import { WEHAGO_PAYROLL_BUSINESS_TEMPLATE, WEHAGO_PAYROLL_DAILY_TEMPLATE, WEHAGO_PAYROLL_EARNED_TEMPLATE } from './templates';

function earned(): PayrollExportRow[] {
  return [
    {
      employeeId: 'e1',
      employeeCode: '1001',
      name: '홍길동',
      incomeType: 'earned',
      attributionMonth: '2026-09',
      paymentDate: '2026-09-25',
      taxablePay: 3000000,
      nonTaxablePay: 200000,
      grossPay: 3200000,
      allowances: { 기본급: 2800000, 식대: 200000, 직책수당: 200000 },
      incomeTax: 84850,
      localIncomeTax: 8480,
      otherDeductions: 285000,
      netPay: 2821670,
    },
    {
      employeeId: 'e2',
      employeeCode: '1002',
      name: '김영희',
      incomeType: 'earned',
      attributionMonth: '2026-09',
      paymentDate: '2026-09-25',
      taxablePay: 2500000,
      nonTaxablePay: 200000,
      grossPay: 2700000,
      allowances: { 기본급: 2500000, 식대: 200000 },
      incomeTax: 41630,
      localIncomeTax: 4160,
      otherDeductions: 237500,
      netPay: 2416710,
    },
  ];
}

describe('급여자료 (MOCK 서식)', () => {
  it('생성 → 재검증 1원 일치, 수당은 열로 펼침', async () => {
    const rows = earned();
    const buf = await writePayrollExport(WEHAGO_PAYROLL_EARNED_TEMPLATE, rows);
    const v = await verifyPayrollExportFile(buf, WEHAGO_PAYROLL_EARNED_TEMPLATE, { ...computePayrollTotals(rows), employeeIds: ['e1', 'e2'] });
    expect(v.ok).toBe(true);
    expect(v.actual).toMatchObject({ count: 2, grossPay: 5900000, netPay: 5238380 });
    const f = await readTabularFile(buf, 'pay.xlsx');
    const header = f.sheets[0]!.rows[0]!;
    expect(header.slice(-3)).toEqual(['기본급', '식대', '직책수당']);
    expect(f.sheets[0]!.rows[1]![0]).toBe('1001');
    expect(f.sheets[0]!.rows[2]![header.length - 1] ?? null).toBeNull();
    expect(f.sheets[0]!.rows[2]![header.length - 2]).toBe(200000);
  });

  it('차인지급액 1원 변조 → 전송 금지', async () => {
    const rows = earned();
    const buf = await writePayrollExport(WEHAGO_PAYROLL_EARNED_TEMPLATE, rows);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const col = WEHAGO_PAYROLL_EARNED_TEMPLATE.columns.findIndex((c) => c.field === 'netPay') + 1;
    const cell = wb.worksheets[0]!.getRow(2).getCell(col);
    cell.value = (cell.value as number) - 1;
    const bad = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const v = await verifyPayrollExportFile(bad, WEHAGO_PAYROLL_EARNED_TEMPLATE, { ...computePayrollTotals(rows), employeeIds: ['e1', 'e2'] });
    expect(v.ok).toBe(false);
    expect(v.diffs.map((d) => d.code)).toEqual(expect.arrayContaining(['row_amount_mismatch', 'total_mismatch']));
    expect(v.summary).toContain('전송 금지');
  });

  it('사전검증: 지급총액·차인지급액 검산, 소득구분, 사원코드 중복', async () => {
    const rows = earned();
    rows[0]!.grossPay += 1;
    rows[1]!.employeeCode = '1001';
    rows[1]!.incomeType = 'business';
    const v = validatePayrollRows(WEHAGO_PAYROLL_EARNED_TEMPLATE, rows);
    expect(v.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['gross_mismatch', 'net_mismatch', 'duplicate_code', 'income_type']));
    await expect(writePayrollExport(WEHAGO_PAYROLL_EARNED_TEMPLATE, rows)).rejects.toThrowError(AdapterError);
  });
});

describe('사업소득 · 일용직', () => {
  it('사업소득: 주민번호는 숫자만(텍스트 셀), 없으면 경고', async () => {
    const rows: PayrollExportRow[] = [
      {
        employeeId: 'b1',
        employeeCode: 'B01',
        name: '프리랜서',
        incomeType: 'business',
        attributionMonth: '2026-09',
        paymentDate: '2026-09-30',
        taxablePay: 1000000,
        nonTaxablePay: 0,
        grossPay: 1000000,
        allowances: {},
        incomeTax: 30000,
        localIncomeTax: 3000,
        otherDeductions: 0,
        netPay: 967000,
        idNumber: '900101-1234567',
        incomeCategoryCode: '940909',
        taxRate: 3,
      },
    ];
    const buf = await writePayrollExport(WEHAGO_PAYROLL_BUSINESS_TEMPLATE, rows);
    const f = await readTabularFile(buf, 'biz.xlsx');
    const idCol = WEHAGO_PAYROLL_BUSINESS_TEMPLATE.columns.findIndex((c) => c.field === 'idNumber');
    expect(f.sheets[0]!.rows[1]![idCol]).toBe('9001011234567');
    const v = await verifyPayrollExportFile(buf, WEHAGO_PAYROLL_BUSINESS_TEMPLATE, { ...computePayrollTotals(rows), employeeIds: ['b1'] });
    expect(v.ok).toBe(true);
    const warn = validatePayrollRows(WEHAGO_PAYROLL_BUSINESS_TEMPLATE, [{ ...rows[0]!, idNumber: null }]);
    expect(warn.ok).toBe(true);
    expect(warn.warnings.map((w) => w.code)).toEqual(['missing_id']);
    // 오류 메시지에는 주민번호가 들어가지 않는다
    const bad = validatePayrollRows(WEHAGO_PAYROLL_BUSINESS_TEMPLATE, [{ ...rows[0]!, idNumber: '900101-12345' }]);
    expect(JSON.stringify(bad)).not.toContain('90010112345');
  });

  it('일용직: 근무일수 필수, 일당×일수 불일치 경고', () => {
    const base: PayrollExportRow = {
      employeeId: 'd1',
      employeeCode: 'D01',
      name: '일용',
      incomeType: 'daily',
      attributionMonth: '2026-09',
      paymentDate: '2026-09-30',
      taxablePay: 1500000,
      nonTaxablePay: 0,
      grossPay: 1500000,
      allowances: {},
      workDays: 10,
      dailyWage: 150000,
      incomeTax: 0,
      localIncomeTax: 0,
      otherDeductions: 0,
      netPay: 1500000,
      idNumber: '9001011234567',
    };
    expect(validatePayrollRows(WEHAGO_PAYROLL_DAILY_TEMPLATE, [base]).ok).toBe(true);
    const v = validatePayrollRows(WEHAGO_PAYROLL_DAILY_TEMPLATE, [{ ...base, workDays: 0 }, { ...base, employeeCode: 'D02', employeeId: 'd2', dailyWage: 140000 }]);
    expect(v.errors.map((e) => e.code)).toContain('missing_work_days');
    expect(v.warnings.map((w) => w.code)).toContain('daily_wage_mismatch');
  });
});
