import ExcelJS from 'exceljs';
import type { JournalLine, VatType } from '@mintax/core';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_A, makeBizNo, VENDOR_A, VENDOR_B, VENDOR_C } from '../__fixtures__/builders';
import { AdapterError } from '../errors';
import { readTabularFile } from '../file/read';
import {
  computeExportTotals,
  resolveWehagoVatCode,
  validateExportRows,
  verifyExportFile,
  writeWehagoExport,
  type ExportRow,
} from './export';
import { TRACE_SHEET_NAME } from './render';
import {
  DEFAULT_VAT_TYPE_CODES,
  templateHeaderHash,
  validateTemplate,
  WEHAGO_GENERAL_JOURNAL_TEMPLATE,
  WEHAGO_PURCHASE_SALES_TEMPLATE,
  WEHAGO_TEMPLATES,
  type WehagoTemplate,
} from './templates';

const PS = WEHAGO_PURCHASE_SALES_TEMPLATE;
const GJ = WEHAGO_GENERAL_JOURNAL_TEMPLATE;
const fixedDate = new Date('2026-09-30T00:00:00Z');

function psRows(): ExportRow[] {
  return [
    {
      transactionId: 'tx-001',
      date: '2026-09-01',
      direction: 'purchase',
      evidenceType: 'card',
      vatType: 'purchase_card',
      deductible: true,
      counterpartyCode: '00101',
      counterpartyName: VENDOR_B.name,
      counterpartyBusinessNumber: VENDOR_B.bizno,
      description: '커피',
      supplyAmount: 9091,
      vatAmount: 909,
      totalAmount: 10000,
      accountCode: '811',
      accountName: '복리후생비',
      cardCompany: '비씨카드',
    },
    {
      transactionId: 'tx-002',
      date: '2026-09-10',
      direction: 'purchase',
      evidenceType: 'tax_invoice',
      vatType: 'purchase_taxable',
      deductible: true,
      counterpartyCode: '00102',
      counterpartyName: VENDOR_A.name,
      counterpartyBusinessNumber: `${VENDOR_A.bizno.slice(0, 3)}-${VENDOR_A.bizno.slice(3, 5)}-${VENDOR_A.bizno.slice(5)}`,
      description: 'A4 용지',
      supplyAmount: 100000,
      vatAmount: 10000,
      totalAmount: 110000,
      accountCode: '830',
      accountName: '소모품비',
      approvalNumber: '20260910-41000012-00000001',
    },
    {
      transactionId: 'tx-003',
      date: '2026-09-12',
      direction: 'purchase',
      evidenceType: 'tax_invoice',
      vatType: 'purchase_taxable',
      deductible: true,
      counterpartyCode: '00102',
      counterpartyName: VENDOR_A.name,
      counterpartyBusinessNumber: VENDOR_A.bizno,
      description: '취소 · 반품',
      supplyAmount: -20000,
      vatAmount: -2000,
      totalAmount: -22000,
      accountCode: '830',
      accountName: '소모품비',
    },
    {
      transactionId: 'tx-004',
      date: '2026-09-08',
      direction: 'purchase',
      evidenceType: 'card',
      vatType: 'purchase_card',
      deductible: false,
      nonDeductibleReason: '접대비(기업업무추진비) 관련',
      counterpartyCode: '00103',
      counterpartyName: VENDOR_C.name,
      counterpartyBusinessNumber: VENDOR_C.bizno,
      supplyAmount: 60000,
      vatAmount: 6000,
      totalAmount: 66000,
      accountCode: '813',
      accountName: '접대비(기업업무추진비)',
    },
    {
      transactionId: 'tx-005',
      date: '2026-09-11',
      direction: 'sales',
      evidenceType: 'tax_invoice',
      vatType: 'sales_taxable',
      deductible: null,
      counterpartyCode: '00201',
      counterpartyName: CUSTOMER_A.name,
      counterpartyBusinessNumber: CUSTOMER_A.bizno,
      description: '컨설팅',
      supplyAmount: 500000,
      vatAmount: 50000,
      totalAmount: 550000,
      accountCode: '401',
      accountName: '상품매출',
    },
    {
      transactionId: 'tx-006',
      date: '2026-09-04',
      direction: 'purchase',
      evidenceType: 'cash_receipt',
      vatType: 'purchase_cash_receipt',
      deductible: true,
      counterpartyCode: '00104',
      counterpartyName: VENDOR_B.name,
      counterpartyBusinessNumber: VENDOR_B.bizno,
      supplyAmount: 18182,
      vatAmount: 1818,
      serviceCharge: 2000,
      totalAmount: 22000,
      accountCode: '811',
      accountName: '복리후생비',
    },
  ];
}

async function tamper(buf: Buffer, sheet: string, edit: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  edit(wb.getWorksheet(sheet)!);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

function colOf(t: WehagoTemplate, field: string): number {
  return t.columns.findIndex((c) => c.field === field) + 1;
}

describe('유형코드 매핑 (VatType → WEHAGO)', () => {
  it('기본 매핑: 매입 51/53/54/57/58/61/62, 매출 11/13/17/22/14', () => {
    const codes = Object.fromEntries(Object.entries(DEFAULT_VAT_TYPE_CODES).map(([k, v]) => [k, v?.code ?? null]));
    expect(codes).toEqual({
      purchase_taxable: '51',
      purchase_exempt: '53',
      purchase_card: '57',
      purchase_card_exempt: '58',
      purchase_cash_receipt: '61',
      purchase_cash_receipt_exempt: '62',
      purchase_non_deductible: '54',
      purchase_no_evidence: null,
      sales_taxable: '11',
      sales_exempt: '13',
      sales_card: '17',
      sales_cash_receipt: '22',
      sales_other: '14',
    });
  });

  it('불공제(세액 있음) → 54, 세액 0 불공제·무증빙 → 일반전표', () => {
    const base = { direction: 'purchase' as const, evidenceType: 'card' as const };
    const r1 = resolveWehagoVatCode({ ...base, vatType: 'purchase_card', deductible: false, vatAmount: 100 }, PS);
    expect(r1.kind === 'code' && r1.mapping.code).toBe('54');
    const r2 = resolveWehagoVatCode({ ...base, vatType: 'purchase_card', deductible: false, vatAmount: 0 }, PS);
    expect(r2.kind).toBe('general_journal');
    const r3 = resolveWehagoVatCode({ ...base, vatType: 'purchase_no_evidence' as VatType, deductible: null, vatAmount: 0 }, PS);
    expect(r3.kind).toBe('general_journal');
    const r4 = resolveWehagoVatCode({ ...base, vatType: 'purchase_card', deductible: null, vatAmount: 100 }, PS);
    expect(r4.kind === 'code' && r4.mapping.code).toBe('57');
  });

  it('템플릿 데이터 무결성', () => {
    for (const t of WEHAGO_TEMPLATES) {
      expect(validateTemplate(t)).toEqual([]);
      expect(t.verified).toBe(false);
      expect(t.note).toContain('검증필요');
    }
    expect(templateHeaderHash(PS)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('매입매출전표 생성 → 재검증', () => {
  it('생성 파일을 다시 읽으면 건수·공급가액·부가세·합계가 1원까지 일치', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { period: '2026-09', generatedAt: fixedDate });
    const expected = computeExportTotals(rows);
    expect(expected).toMatchObject({ count: 6, supplyAmount: 667273, vatAmount: 66727, totalAmount: 736000 });
    const v = await verifyExportFile(buf, PS, expected);
    expect(v.diffs.filter((d) => d.blocking)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.traceFound).toBe(true);
    expect(v.actual).toEqual({ ...expected, transactionIds: rows.map((r) => r.transactionId) });
    expect(v.summary).toContain('검증 통과');
  });

  it('사업자번호·코드·일자는 텍스트 셀, 금액은 숫자 셀', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { generatedAt: fixedDate });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet(PS.sheetName)!;
    expect(ws.getRow(1).getCell(1).value).toBe('일자');
    const r2 = ws.getRow(2);
    expect(r2.getCell(colOf(PS, 'date')).value).toBe('2026-09-01');
    expect(r2.getCell(colOf(PS, 'counterpartyBusinessNumber')).value).toBe(VENDOR_B.bizno);
    expect(r2.getCell(colOf(PS, 'counterpartyBusinessNumber')).numFmt).toBe('@');
    expect(r2.getCell(colOf(PS, 'counterpartyCode')).value).toBe('00101');
    expect(r2.getCell(colOf(PS, 'vatTypeCode')).value).toBe('57');
    expect(r2.getCell(colOf(PS, 'journalTypeCode')).value).toBe('4');
    expect(r2.getCell(colOf(PS, 'supplyAmount')).value).toBe(9091);
    // 하이픈 사업자번호 입력도 숫자 10자리로
    expect(ws.getRow(3).getCell(colOf(PS, 'counterpartyBusinessNumber')).value).toBe(VENDOR_A.bizno);
    expect(ws.getRow(3).getCell(colOf(PS, 'electronic')).value).toBe('1');
    expect(ws.getRow(3).getCell(colOf(PS, 'journalTypeCode')).value).toBe('2');
    // 불공제 카드 → 54 + 사유
    expect(ws.getRow(5).getCell(colOf(PS, 'vatTypeCode')).value).toBe('54');
    expect(ws.getRow(5).getCell(colOf(PS, 'nonDeductibleReason')).value).toBe('접대비(기업업무추진비) 관련');
    expect(ws.getRow(6).getCell(colOf(PS, 'vatTypeCode')).value).toBe('11');
    expect(wb.getWorksheet(TRACE_SHEET_NAME)!.state).toBe('veryHidden');
    // 일반 리더로 읽어도 앞자리 0 유지
    const f = await readTabularFile(buf, 'export.xlsx');
    expect(f.sheets[0]!.rows[1]![colOf(PS, 'counterpartyCode') - 1]).toBe('00101');
  });

  it('1원 변조(공급가액만) → 행 검산·합계·추적 불일치로 전송 금지', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { generatedAt: fixedDate });
    const bad = await tamper(buf, PS.sheetName, (ws) => {
      const c = ws.getRow(3).getCell(colOf(PS, 'supplyAmount'));
      c.value = (c.value as number) + 1;
    });
    const v = await verifyExportFile(bad, PS, computeExportTotals(rows));
    expect(v.ok).toBe(false);
    const codes = v.diffs.filter((d) => d.blocking).map((d) => d.code);
    expect(codes).toContain('row_sum_mismatch');
    expect(codes).toContain('row_amount_mismatch');
    expect(codes).toContain('supply_mismatch');
    const d = v.diffs.find((x) => x.code === 'supply_mismatch')!;
    expect(d.actual! - d.expected!).toBe(1);
    expect(d.message).toContain('차이 1원');
    expect(v.summary).toContain('전송 금지');
  });

  it('1원 변조(공급가액+합계 동시, 행 검산은 맞음)도 잡는다', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { generatedAt: fixedDate });
    const bad = await tamper(buf, PS.sheetName, (ws) => {
      for (const f of ['supplyAmount', 'totalAmount']) {
        const c = ws.getRow(2).getCell(colOf(PS, f));
        c.value = (c.value as number) + 1;
      }
    });
    const v = await verifyExportFile(bad, PS, computeExportTotals(rows));
    expect(v.ok).toBe(false);
    const codes = v.diffs.map((d) => d.code);
    expect(codes).not.toContain('row_sum_mismatch');
    expect(codes).toEqual(expect.arrayContaining(['row_amount_mismatch', 'supply_mismatch', 'total_mismatch']));
  });

  it('행 삭제 → 건수·누락 거래', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { generatedAt: fixedDate });
    const bad = await tamper(buf, PS.sheetName, (ws) => ws.spliceRows(4, 1));
    const v = await verifyExportFile(bad, PS, computeExportTotals(rows));
    expect(v.ok).toBe(false);
    expect(v.diffs.map((d) => d.code)).toEqual(expect.arrayContaining(['count_mismatch', 'total_mismatch']));
  });

  it('기대값이 1원 다르면 전송 금지 / 거래ID 목록이 다르면 전송 금지', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { generatedAt: fixedDate });
    const exp = computeExportTotals(rows);
    const v1 = await verifyExportFile(buf, PS, { ...exp, vatAmount: exp.vatAmount + 1 });
    expect(v1.ok).toBe(false);
    expect(v1.diffs.map((d) => d.code)).toEqual(['vat_mismatch']);
    const v2 = await verifyExportFile(buf, PS, { ...exp, transactionIds: [...exp.transactionIds.slice(1), 'tx-999'] });
    expect(v2.ok).toBe(false);
    expect(v2.diffs.map((d) => d.code).sort()).toEqual(['extra_transaction', 'missing_transaction']);
  });

  it('추적 시트 없이도 합계 검증 (거래ID 는 건수로만)', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { includeTraceSheet: false });
    const v = await verifyExportFile(buf, PS, computeExportTotals(rows));
    expect(v.ok).toBe(true);
    expect(v.traceFound).toBe(false);
    expect(v.diffs.map((d) => [d.code, d.blocking])).toEqual([['no_trace', false]]);
  });

  it('다른 서식으로 검증하면 제목행 불일치', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows);
    const other: WehagoTemplate = { ...PS, columns: PS.columns.map((c, i) => (i === 0 ? { ...c, header: '전표일자' } : c)) };
    const v = await verifyExportFile(buf, other, computeExportTotals(rows));
    expect(v.ok).toBe(false);
    expect(v.diffs.map((d) => d.code)).toEqual(expect.arrayContaining(['header_mismatch', 'template_changed']));
  });
});

describe('사전검증 (파일 생성 거부)', () => {
  it('거래처코드 누락·사업자번호 오류·합계 불일치·기간 밖·중복ID·무증빙', async () => {
    const rows = psRows();
    rows[0]!.counterpartyCode = '';
    rows[1]!.counterpartyBusinessNumber = makeBizNo('120810003').slice(0, 9) + '0';
    rows[2]!.totalAmount = -22001;
    rows[3]!.date = '2026-10-01';
    rows[4]!.transactionId = 'tx-001';
    rows[5]!.vatType = 'purchase_no_evidence';
    const v = validateExportRows(PS, rows, { period: '2026-09' });
    expect(v.ok).toBe(false);
    const codes = v.errors.map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining(['missing_counterparty_code', 'sum_mismatch', 'out_of_period', 'duplicate_id', 'route_general_journal']),
    );
    if (!makeBizNo('120810003').endsWith('0')) expect(codes).toContain('bizno_checksum');
    await expect(writeWehagoExport(PS, rows, { period: '2026-09' })).rejects.toThrowError(AdapterError);
    try {
      await writeWehagoExport(PS, rows, { period: '2026-09' });
    } catch (e) {
      expect((e as AdapterError).code).toBe('EXPORT_VALIDATION_FAILED');
      expect((e as AdapterError).message).toContain('전송 파일을 만들 수 없습니다');
    }
  });

  it('면세 유형인데 세액이 있으면 오류, 과세인데 세액 0 이면 경고, 불공제는 사유 경고', () => {
    const rows = psRows().slice(0, 1);
    rows[0]!.vatType = 'purchase_card_exempt';
    const v = validateExportRows(PS, rows);
    expect(v.errors.map((e) => e.code)).toContain('vat_must_be_zero');
    const r2 = psRows().slice(0, 1);
    r2[0]!.vatAmount = 0;
    r2[0]!.supplyAmount = 10000;
    expect(validateExportRows(PS, r2).warnings.map((w) => w.code)).toContain('taxable_zero_vat');
    expect(validateExportRows(PS, psRows()).warnings.map((w) => w.code)).toContain('needs_reason');
  });

  it('서식에 봉사료 열이 없는데 봉사료가 있으면 오류', () => {
    const noSvc: WehagoTemplate = { ...PS, columns: PS.columns.filter((c) => c.field !== 'serviceCharge') };
    const v = validateExportRows(noSvc, psRows());
    expect(v.errors.map((e) => e.code)).toContain('no_service_column');
  });

  it('빈 목록·급여 서식은 거부', () => {
    expect(validateExportRows(PS, []).errors.map((e) => e.code)).toContain('empty');
    const payroll = WEHAGO_TEMPLATES.find((t) => t.kind === 'payroll_earned')!;
    expect(validateExportRows(payroll, psRows()).errors.map((e) => e.code)).toContain('wrong_template');
  });
});

describe('일반전표 생성 → 재검증', () => {
  // 일반전표 대상 = 매입매출 유형코드가 없는 거래 (무증빙·불공제 카드 등, 부가세 포함 전액 비용)
  function gjRows(): ExportRow[] {
    const line = (side: JournalLine['side'], code: string, name: string, amount: number): JournalLine => ({ side, accountCode: code, accountName: name, amount, memo: '테스트' });
    return [
      {
        ...psRows()[0]!,
        vatType: 'purchase_no_evidence',
        journalLines: [line('debit', '811', '복리후생비', 6000), line('debit', '811', '복리후생비', 4000), line('credit', '253', '미지급금', 10000)],
      },
      {
        ...psRows()[2]!,
        vatType: 'purchase_no_evidence',
        deductible: false,
        journalLines: [line('debit', '830', '소모품비', -22000), line('credit', '251', '외상매입금', -22000)],
      },
      {
        ...psRows()[3]!,
        vatType: 'purchase_no_evidence',
        journalLines: [line('debit', '813', '접대비(기업업무추진비)', 66000), line('credit', '253', '미지급금', 66000)],
      },
    ];
  }

  it('필수 7항목 + 추적 → 1원까지 일치', async () => {
    const rows = gjRows();
    const buf = await writeWehagoExport(GJ, rows, { generatedAt: fixedDate });
    const v = await verifyExportFile(buf, GJ, computeExportTotals(rows));
    expect(v.diffs.filter((d) => d.blocking)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.actual.count).toBe(3);
    const f = await readTabularFile(buf, 'gj.xlsx');
    const sheet = f.sheets[0]!;
    expect(sheet.rows[0]).toEqual(['월', '일', '번호', '구분', '계정과목코드', '계정과목명', '거래처코드', '거래처명', '적요', '차변(출금)', '대변(입금)']);
    expect(sheet.rows[1]!.slice(0, 6)).toEqual(['09', '01', 1, '3', '811', '복리후생비']);
    expect(sheet.rows.length).toBe(1 + 7);
  });

  it('차변 1원 변조 → 대차 불일치 + 전송 금지', async () => {
    const rows = gjRows();
    const buf = await writeWehagoExport(GJ, rows, { generatedAt: fixedDate });
    const bad = await tamper(buf, GJ.sheetName, (ws) => {
      const c = ws.getRow(2).getCell(colOf(GJ, 'debit'));
      c.value = (c.value as number) + 1;
    });
    const v = await verifyExportFile(bad, GJ, computeExportTotals(rows));
    expect(v.ok).toBe(false);
    expect(v.diffs.map((d) => d.code)).toEqual(expect.arrayContaining(['unbalanced', 'row_amount_mismatch', 'total_mismatch']));
  });

  it('분개가 없거나 대차가 안 맞으면 생성 거부', () => {
    const rows = gjRows();
    rows[0]!.journalLines = [];
    rows[2]!.journalLines![0]!.amount = 65999;
    const codes = validateExportRows(GJ, rows).errors.map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(['missing_journal', 'unbalanced', 'journal_total_mismatch']));
  });

  it('추적 시트 없으면 합계(차변)만 비교하고 공급가액·부가세는 검증 불가로 표시', async () => {
    const rows = gjRows();
    const buf = await writeWehagoExport(GJ, rows, { includeTraceSheet: false });
    const v = await verifyExportFile(buf, GJ, computeExportTotals(rows));
    expect(v.ok).toBe(true);
    expect(v.diffs.map((d) => d.code)).toEqual(['no_trace', 'not_verifiable']);
  });
});

describe('리뷰 보강: 회계 안전 사전검증', () => {
  it('공제 여부 미확정(null) 매입은 세액이 있으면 전송 거부, 공제 확정인데 불공(54)이면 거부', () => {
    const rows = psRows();
    rows[0]!.deductible = null; // 카드 과세 매입, 세액 909
    rows[1]!.vatType = 'purchase_non_deductible';
    rows[1]!.deductible = true;
    const v = validateExportRows(PS, rows);
    expect(v.ok).toBe(false);
    const codes = v.errors.map((e) => [e.transactionId, e.code]);
    expect(codes).toContainEqual(['tx-001', 'deductible_undecided']);
    expect(codes).toContainEqual(['tx-002', 'deductible_conflict']);
    // 매출·면세(세액 0) 매입은 공제 여부와 무관
    expect(codes.filter(([id]) => id === 'tx-005')).toEqual([]);
  });

  it('부호가 섞인 행은 거부 (합계 검산이 맞아도)', () => {
    const rows = psRows();
    Object.assign(rows[0]!, { supplyAmount: -1000, vatAmount: 11000, totalAmount: 10000 });
    expect(validateExportRows(PS, rows).errors.map((e) => e.code)).toContain('sign_mismatch');
  });

  it('검증되지 않은 서식은 경고로 알린다', () => {
    const v = validateExportRows(PS, psRows());
    expect(v.warnings.find((w) => w.code === 'unverified_template')?.message).toContain('첫 업로드');
  });

  it('일반전표: 부가세 신고 대상(유형코드 있음) 거래는 거부, 부가세 계정 줄은 경고', () => {
    const line = (side: JournalLine['side'], code: string, name: string, amount: number): JournalLine => ({ side, accountCode: code, accountName: name, amount });
    const rows: ExportRow[] = [
      { ...psRows()[1]!, journalLines: [line('debit', '830', '소모품비', 100000), line('debit', '135', '부가세대급금', 10000), line('credit', '251', '외상매입금', 110000)] },
    ];
    const v = validateExportRows(GJ, rows);
    expect(v.errors.map((e) => e.code)).toContain('vat_row_in_general_journal');
    expect(v.warnings.map((w) => w.code)).toContain('vat_account_in_general_journal');
    rows[0]!.vatType = 'purchase_no_evidence';
    expect(validateExportRows(GJ, rows).errors.map((e) => e.code)).not.toContain('vat_row_in_general_journal');
  });
});

describe('리뷰 보강: 재검증 게이트 (금액 외 내용·형식)', () => {
  it('거래처코드가 숫자로 바뀌면(앞자리 0 손실) 금액이 같아도 전송 금지', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { generatedAt: fixedDate });
    const bad = await tamper(buf, PS.sheetName, (ws) => {
      ws.getRow(2).getCell(colOf(PS, 'counterpartyCode')).value = 101;
    });
    const v = await verifyExportFile(bad, PS, computeExportTotals(rows));
    expect(v.ok).toBe(false);
    expect(v.diffs.filter((d) => d.blocking).map((d) => [d.code, d.transactionId])).toEqual([['row_content_mismatch', 'tx-001']]);
  });

  it('유형코드·일자 변경도 잡는다 (57 → 51, 09-01 → 08-31)', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { generatedAt: fixedDate });
    const bad = await tamper(buf, PS.sheetName, (ws) => {
      ws.getRow(2).getCell(colOf(PS, 'vatTypeCode')).value = '51';
      ws.getRow(3).getCell(colOf(PS, 'date')).value = '2026-08-31';
    });
    const v = await verifyExportFile(bad, PS, computeExportTotals(rows));
    expect(v.ok).toBe(false);
    expect(v.diffs.filter((d) => d.code === 'row_content_mismatch').map((d) => d.transactionId)).toEqual(['tx-001', 'tx-002']);
  });

  it('금액 셀이 텍스트면 값이 같아도 전송 금지', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { generatedAt: fixedDate });
    const bad = await tamper(buf, PS.sheetName, (ws) => {
      ws.getRow(2).getCell(colOf(PS, 'totalAmount')).value = '10,000';
    });
    const v = await verifyExportFile(bad, PS, computeExportTotals(rows));
    expect(v.ok).toBe(false);
    const d = v.diffs.find((x) => x.code === 'unreadable_amount')!;
    expect(d.blocking).toBe(true);
    expect(d.message).toContain('텍스트');
  });

  it('추적 범위가 조작돼도(끝 행 10억) 멈추지 않고 전송 금지', async () => {
    const rows = psRows();
    const buf = await writeWehagoExport(PS, rows, { generatedAt: fixedDate });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    wb.getWorksheet(TRACE_SHEET_NAME)!.getRow(3).getCell(3).value = 1_000_000_000;
    const bad = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const t0 = Date.now();
    const v = await verifyExportFile(bad, PS, computeExportTotals(rows));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(v.ok).toBe(false);
    expect(v.diffs.map((d) => d.code)).toContain('row_content_mismatch');

    wb.getWorksheet(TRACE_SHEET_NAME)!.getRow(3).getCell(3).value = 0; // 끝 < 시작
    const bad2 = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const v2 = await verifyExportFile(bad2, PS, computeExportTotals(rows));
    expect(v2.ok).toBe(false);
    expect(v2.diffs.map((d) => d.code)).toContain('trace_invalid');
  });

  it('일반전표도 계정코드 변경을 잡는다', async () => {
    const line = (side: JournalLine['side'], code: string, name: string, amount: number): JournalLine => ({ side, accountCode: code, accountName: name, amount });
    const rows: ExportRow[] = [{ ...psRows()[0]!, vatType: 'purchase_no_evidence', journalLines: [line('debit', '811', '복리후생비', 10000), line('credit', '253', '미지급금', 10000)] }];
    const buf = await writeWehagoExport(GJ, rows, { generatedAt: fixedDate });
    expect((await verifyExportFile(buf, GJ, computeExportTotals(rows))).ok).toBe(true);
    const bad = await tamper(buf, GJ.sheetName, (ws) => {
      ws.getRow(2).getCell(colOf(GJ, 'accountCode')).value = '813';
    });
    const v = await verifyExportFile(bad, GJ, computeExportTotals(rows));
    expect(v.ok).toBe(false);
    expect(v.diffs.map((d) => d.code)).toEqual(['row_content_mismatch']);
  });
});
