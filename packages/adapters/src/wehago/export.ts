/**
 * WEHAGO 전표 엑셀 생성 + 재검증 ('단 1원 차이도 전송 금지' 게이트).
 *
 * 흐름: validateExportRows (사전검증) → writeWehagoExport (xlsx) → verifyExportFile (생성 파일을 다시 읽어 건수·금액 1원 단위 비교)
 */
import {
  formatBusinessNumber,
  formatWon,
  isValidBusinessNumber,
  normalizeBusinessNumber,
  normalizeDate,
  parseWon,
  type AmountTotals,
  type Direction,
  type EvidenceType,
  type JournalLine,
  type LocalDate,
  type VatType,
  type Won,
  type YearMonth,
} from '@mintax/core';
import { AdapterError } from '../errors';
import type { CellValue } from '../file/read';
import type { DouzoneVatTypeEntry, JournalTypeKey } from './codes';
import { checkTraceIntegrity, readTemplateWorkbook, traceRangeProblem, writeTemplateWorkbook, type FieldRecord, type ParsedTemplateFile } from './render';
import { templateHeaderHash, validateTemplate, type ExportField, type VatTypeCodeMapping, type WehagoTemplate } from './templates';

// ────────────────────────────── 입력 ──────────────────────────────

/** 승인된 거래 + 분개 판단 → 전송 행 */
export interface ExportRow {
  transactionId: string;
  date: LocalDate;
  direction: Direction;
  evidenceType: EvidenceType;
  vatType: VatType;
  /** true 공제 / false 불공제 / null 미확정 */
  deductible: boolean | null;
  /** 불공(54) 사유 텍스트 — WEHAGO 에서 사람이 사유번호를 고른다 */
  nonDeductibleReason?: string | null;
  /** WEHAGO 거래처코드 (매입매출전표 필수) */
  counterpartyCode?: string | null;
  counterpartyName: string;
  counterpartyBusinessNumber?: string | null;
  description?: string | null;
  supplyAmount: Won;
  vatAmount: Won;
  serviceCharge?: Won;
  totalAmount: Won;
  /** 비용/수익 계정 (매입매출전표 하단 분개 기준 계정) */
  accountCode: string;
  accountName: string;
  /** 분개유형 — 없으면 증빙별 기본값 (카드→카드, 현금영수증→현금, 세금계산서→외상) */
  journalType?: JournalTypeKey;
  /** 전자(세금)계산서 여부 — 없으면 세금계산서/계산서는 전자로 본다 */
  electronic?: boolean | null;
  cardCompany?: string | null;
  approvalNumber?: string | null;
  /** 일반전표용 분개 줄 (core buildJournalEntry 결과) */
  journalLines?: JournalLine[];
}

export interface ExportMeta {
  /** 'YYYY-MM' — 일자가 이 기간 안인지 검사 */
  period?: YearMonth;
  periodFrom?: LocalDate;
  periodTo?: LocalDate;
  generatedAt?: Date;
  /** 추적 시트 포함 여부 (기본: template.traceSheet) */
  includeTraceSheet?: boolean;
}

export interface ExportIssue {
  rowIndex: number | null;
  transactionId: string | null;
  field?: string;
  code: string;
  message: string;
}

export interface ExportTotals extends AmountTotals {
  transactionIds: string[];
}

export interface ExportValidation {
  ok: boolean;
  errors: ExportIssue[];
  warnings: ExportIssue[];
  totals: ExportTotals;
  /** 파일 행 수 (일반전표는 분개 줄 수) */
  fileRowCount: number;
}

// ────────────────────────────── 유형코드 결정 ──────────────────────────────

export type VatCodeResolution =
  | { kind: 'code'; mapping: VatTypeCodeMapping; entry: DouzoneVatTypeEntry | null }
  | { kind: 'general_journal'; reason: string };

/** 전송 행의 매입매출 유형코드를 결정한다 (불공제 → 54, 적격증빙 없음 → 일반전표) */
export function resolveWehagoVatCode(row: Pick<ExportRow, 'vatType' | 'deductible' | 'direction' | 'vatAmount' | 'evidenceType'>, template: WehagoTemplate): VatCodeResolution {
  const lookup = (m: VatTypeCodeMapping | null) =>
    m ? ({ kind: 'code', mapping: m, entry: template.vatTypeTable.find((e) => e.code === m.code) ?? null } as const) : null;
  if (row.vatType === 'purchase_no_evidence') {
    return { kind: 'general_journal', reason: '적격증빙이 없는 거래는 매입매출전표가 아니라 일반전표로 보내야 합니다.' };
  }
  if (row.direction === 'purchase' && row.deductible === false && row.vatType !== 'purchase_non_deductible') {
    if (row.vatAmount === 0) {
      return { kind: 'general_journal', reason: '세액 0 인 불공제 매입(간이과세자 등)은 일반전표 대상입니다.' };
    }
    const r = lookup(template.vatTypeCodes.purchase_non_deductible);
    if (r) return r;
  }
  const r = lookup(template.vatTypeCodes[row.vatType]);
  if (!r) return { kind: 'general_journal', reason: `부가세 유형 ${row.vatType} 에 대응하는 WEHAGO 유형코드가 서식에 없습니다.` };
  return r;
}

function defaultJournalType(row: Pick<ExportRow, 'evidenceType'>): JournalTypeKey {
  switch (row.evidenceType) {
    case 'card':
      return 'card';
    case 'tax_invoice':
    case 'invoice_exempt':
      return 'credit';
    default:
      return 'cash';
  }
}

// ────────────────────────────── 사전검증 ──────────────────────────────

function periodRange(meta: ExportMeta): { from: string; to: string } | null {
  if (meta.periodFrom || meta.periodTo) return { from: meta.periodFrom ?? '0000-01-01', to: meta.periodTo ?? '9999-12-31' };
  if (meta.period && /^\d{4}-\d{2}$/.test(meta.period)) return { from: `${meta.period}-01`, to: `${meta.period}-31` };
  return null;
}

export function computeExportTotals(rows: readonly ExportRow[]): ExportTotals {
  const t: ExportTotals = { count: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0, transactionIds: [] };
  for (const r of rows) {
    t.count++;
    t.supplyAmount += r.supplyAmount;
    t.vatAmount += r.vatAmount;
    t.totalAmount += r.totalAmount;
    t.transactionIds.push(r.transactionId);
  }
  return t;
}

export function validateExportRows(template: WehagoTemplate, rows: readonly ExportRow[], meta: ExportMeta = {}): ExportValidation {
  const errors: ExportIssue[] = [];
  const warnings: ExportIssue[] = [];
  const err = (i: number | null, id: string | null, code: string, message: string, field?: string) => errors.push({ rowIndex: i, transactionId: id, code, message, ...(field ? { field } : {}) });
  const warn = (i: number | null, id: string | null, code: string, message: string, field?: string) => warnings.push({ rowIndex: i, transactionId: id, code, message, ...(field ? { field } : {}) });

  if (template.kind !== 'purchase_sales' && template.kind !== 'general_journal') {
    err(null, null, 'wrong_template', `전표 서식이 아닙니다 (${template.name}). 급여는 writePayrollExport 를 사용하세요.`);
  }
  if (!template.verified) {
    warn(null, null, 'unverified_template', `검증되지 않은 서식입니다 (${template.name}) — 첫 업로드 후 WEHAGO 화면의 건수·금액을 반드시 확인하세요.`);
  }
  for (const m of validateTemplate(template)) err(null, null, 'template_invalid', `서식 오류: ${m}`);
  if (rows.length === 0) err(null, null, 'empty', '전송할 거래가 없습니다.');

  const fields = new Set<ExportField>(template.columns.map((c) => c.field));
  const range = periodRange(meta);
  const seen = new Set<string>();
  let fileRowCount = 0;

  rows.forEach((r, i) => {
    const id = r.transactionId;
    if (!id) err(i, null, 'missing_id', `${i + 1}번째 행: 거래ID가 없습니다.`);
    else if (seen.has(id)) err(i, id, 'duplicate_id', `같은 거래가 두 번 들어 있습니다 (${id}).`);
    seen.add(id);

    const date = normalizeDate(r.date);
    if (!date || date !== r.date) err(i, id, 'invalid_date', `일자 형식 오류: "${r.date}" (YYYY-MM-DD)`, 'date');
    else if (range && (date < range.from || date > range.to)) err(i, id, 'out_of_period', `일자 ${date} 가 전송 기간(${range.from} ~ ${range.to}) 밖입니다.`, 'date');

    const svc = r.serviceCharge ?? 0;
    for (const [k, v] of Object.entries({ supplyAmount: r.supplyAmount, vatAmount: r.vatAmount, serviceCharge: svc, totalAmount: r.totalAmount })) {
      if (!Number.isSafeInteger(v)) err(i, id, 'not_integer', `${k} 는 원 단위 정수여야 합니다: ${v}`, k);
    }
    if (r.supplyAmount + r.vatAmount + svc !== r.totalAmount) {
      err(i, id, 'sum_mismatch', `공급가액 + 부가세${svc ? ' + 봉사료' : ''} ≠ 합계 (차이 ${formatWon(r.totalAmount - r.supplyAmount - r.vatAmount - svc)})`, 'totalAmount');
    }
    const nonZero = [r.supplyAmount, r.vatAmount, svc, r.totalAmount].filter((x) => x !== 0);
    if (nonZero.some((x) => x > 0) && nonZero.some((x) => x < 0)) {
      err(i, id, 'sign_mismatch', '공급가액·부가세·합계의 부호(+/−)가 서로 다릅니다 (취소 거래는 모두 음수여야 합니다).', 'totalAmount');
    }

    if (!/^\d{3,5}$/.test(r.accountCode ?? '')) err(i, id, 'invalid_account', `계정코드가 올바르지 않습니다: "${r.accountCode ?? ''}"`, 'accountCode');

    if (template.kind === 'purchase_sales') {
      fileRowCount++;
      if (svc !== 0 && !fields.has('serviceCharge')) {
        err(i, id, 'no_service_column', `봉사료 ${formatWon(svc)} 가 있지만 서식에 봉사료 열이 없습니다 — 공급가액+부가세가 합계와 달라집니다.`, 'serviceCharge');
      }
      const res = resolveWehagoVatCode(r, template);
      if (res.kind === 'general_journal') err(i, id, 'route_general_journal', res.reason, 'vatType');
      else {
        const nature = res.entry?.nature;
        if ((nature === 'exempt' || nature === 'zero_rated') && r.vatAmount !== 0) {
          err(i, id, 'vat_must_be_zero', `유형 ${res.mapping.code}(${res.mapping.label})은 세액이 0 이어야 합니다 (현재 ${formatWon(r.vatAmount)}).`, 'vatAmount');
        }
        if (nature === 'taxable' && r.vatAmount === 0 && r.supplyAmount !== 0) {
          warn(i, id, 'taxable_zero_vat', `과세 유형 ${res.mapping.code}(${res.mapping.label})인데 세액이 0 입니다.`, 'vatAmount');
        }
        const isNonDeductibleCode = res.mapping.code === template.vatTypeCodes.purchase_non_deductible?.code;
        if (isNonDeductibleCode) {
          warn(i, id, 'needs_reason', `불공제(${res.mapping.code}) — WEHAGO 에서 불공제사유 번호를 선택해야 합니다${r.nonDeductibleReason ? ` (사유: ${r.nonDeductibleReason})` : ' (사유 미기재)'}.`, 'nonDeductibleReason');
          if (r.deductible === true) err(i, id, 'deductible_conflict', `공제로 확정된 거래인데 불공제 유형(${res.mapping.code})입니다. 부가세 판단을 다시 확인해 주세요.`, 'deductible');
        }
        // 공제 여부 미확정 매입을 공제 유형(51·57·61 등)으로 보내면 매입세액을 검토 없이 공제받게 된다
        if (r.direction === 'purchase' && r.deductible === null && r.vatAmount !== 0) {
          err(i, id, 'deductible_undecided', `매입세액 ${formatWon(r.vatAmount)}의 공제 여부가 확정되지 않았습니다 — 검토에서 공제/불공제를 정한 뒤 전송하세요.`, 'deductible');
        }
        if (!res.entry) warn(i, id, 'unknown_code', `유형코드 ${res.mapping.code} 는 코드표에 없습니다 (사무소 서식 확인).`, 'vatType');
      }
      if (template.requireCounterpartyCode && !(r.counterpartyCode ?? '').trim()) {
        err(i, id, 'missing_counterparty_code', `거래처코드가 없습니다 (${r.counterpartyName}) — WEHAGO 거래처등록의 코드를 연결해 주세요.`, 'counterpartyCode');
      }
      if (!r.counterpartyName?.trim()) err(i, id, 'missing_counterparty_name', '거래처명이 없습니다.', 'counterpartyName');
      if (r.counterpartyBusinessNumber) {
        const b = normalizeBusinessNumber(r.counterpartyBusinessNumber);
        if (!b) err(i, id, 'invalid_bizno', `사업자번호 형식 오류: "${r.counterpartyBusinessNumber}"`, 'counterpartyBusinessNumber');
        else if (!isValidBusinessNumber(b)) err(i, id, 'bizno_checksum', `사업자번호 ${formatBusinessNumber(b)} 의 검증번호가 맞지 않습니다.`, 'counterpartyBusinessNumber');
      }
    } else if (template.kind === 'general_journal') {
      // 매입매출 유형코드가 있는 거래를 일반전표로 보내면 부가세 신고서(매입매출장)에서 빠진다
      const res = resolveWehagoVatCode(r, template);
      if (res.kind === 'code') {
        err(i, id, 'vat_row_in_general_journal', `부가세 신고 대상 거래(유형 ${res.mapping.code} ${res.mapping.label})입니다 — 일반전표가 아니라 매입매출전표로 보내야 합니다.`, 'vatType');
      }
      const lines = r.journalLines ?? [];
      if (lines.length === 0) {
        err(i, id, 'missing_journal', '분개 줄이 없습니다 — 일반전표는 분개가 필요합니다.', 'journalLines');
        return;
      }
      let debit = 0;
      let credit = 0;
      lines.forEach((l, k) => {
        if (!Number.isSafeInteger(l.amount) || l.amount === 0) err(i, id, 'invalid_line_amount', `${k + 1}번째 분개 줄 금액 오류: ${l.amount}`, 'journalLines');
        if (!/^\d{3,5}$/.test(l.accountCode)) err(i, id, 'invalid_line_account', `${k + 1}번째 분개 줄 계정코드 오류: "${l.accountCode}"`, 'journalLines');
        if (/부가세(대급금|예수금)|부가가치세(대급금|예수금)/.test(l.accountName.replace(/\s+/g, ''))) {
          warn(i, id, 'vat_account_in_general_journal', `${k + 1}번째 분개 줄이 ${l.accountName} 계정입니다 — 일반전표의 부가세 계정은 부가세 신고서에 반영되지 않습니다.`, 'journalLines');
        }
        if (l.side === 'debit') debit += l.amount;
        else credit += l.amount;
      });
      if (debit !== credit) err(i, id, 'unbalanced', `차변 ${formatWon(debit)} ≠ 대변 ${formatWon(credit)} (차이 ${formatWon(debit - credit)})`, 'journalLines');
      if (debit !== r.totalAmount) err(i, id, 'journal_total_mismatch', `분개 차변 합 ${formatWon(debit)} ≠ 거래 합계 ${formatWon(r.totalAmount)}`, 'journalLines');
      fileRowCount += lines.length;
    }
  });

  if (template.maxRows !== null && fileRowCount > template.maxRows) {
    err(null, null, 'too_many_rows', `파일 행 수 ${fileRowCount} 가 서식 한도 ${template.maxRows} 를 넘습니다. 기간을 나누어 생성해 주세요.`);
  }
  return { ok: errors.length === 0, errors, warnings, totals: computeExportTotals(rows), fileRowCount };
}

// ────────────────────────────── 생성 ──────────────────────────────

function bizNoOut(b: string | null | undefined, t: WehagoTemplate): string | null {
  const n = normalizeBusinessNumber(b ?? null);
  if (!n) return null;
  return t.businessNumberFormat === 'dashed' ? formatBusinessNumber(n) : n;
}

function purchaseSalesRecord(r: ExportRow, t: WehagoTemplate): FieldRecord {
  const res = resolveWehagoVatCode(r, t);
  const mapping = res.kind === 'code' ? res.mapping : null;
  const electronic = r.electronic ?? (r.evidenceType === 'tax_invoice' || r.evidenceType === 'invoice_exempt' ? true : null);
  return {
    date: r.date,
    vatTypeCode: mapping?.code ?? null,
    vatTypeLabel: mapping?.label ?? null,
    counterpartyCode: r.counterpartyCode ?? null,
    counterpartyName: r.counterpartyName,
    counterpartyBusinessNumber: bizNoOut(r.counterpartyBusinessNumber, t),
    description: r.description ?? null,
    supplyAmount: r.supplyAmount,
    vatAmount: r.vatAmount,
    serviceCharge: r.serviceCharge ?? 0,
    totalAmount: r.totalAmount,
    electronic: electronic === null ? null : electronic ? t.electronicValues.yes : t.electronicValues.no,
    journalTypeCode: t.journalTypeCodes[r.journalType ?? defaultJournalType(r)],
    accountCode: r.accountCode,
    accountName: r.accountName,
    cardCompany: r.cardCompany ?? null,
    approvalNumber: r.approvalNumber ?? null,
    nonDeductibleReason: r.nonDeductibleReason ?? null,
  };
}

function journalRecords(rows: readonly ExportRow[], t: WehagoTemplate): { records: FieldRecord[]; ids: string[] } {
  const records: FieldRecord[] = [];
  const ids: string[] = [];
  const voucherSeq = new Map<string, number>();
  for (const r of rows) {
    const no = (voucherSeq.get(r.date) ?? 0) + 1;
    voucherSeq.set(r.date, no);
    for (const l of r.journalLines ?? []) {
      records.push({
        month: r.date.slice(5, 7),
        day: r.date.slice(8, 10),
        voucherNo: no,
        slipSideCode: l.side === 'debit' ? t.slipSideCodes.debit : t.slipSideCodes.credit,
        accountCode: l.accountCode,
        accountName: l.accountName,
        counterpartyCode: r.counterpartyCode ?? null,
        counterpartyName: l.counterpartyName ?? r.counterpartyName,
        memo: l.memo ?? r.description ?? null,
        debit: l.side === 'debit' ? l.amount : null,
        credit: l.side === 'credit' ? l.amount : null,
      });
      ids.push(r.transactionId);
    }
  }
  return { records, ids };
}

/**
 * 전송 파일 생성. 사전검증 오류가 하나라도 있으면 파일을 만들지 않고 EXPORT_VALIDATION_FAILED 를 던진다.
 */
export async function writeWehagoExport(template: WehagoTemplate, rows: readonly ExportRow[], meta: ExportMeta = {}): Promise<Buffer> {
  const v = validateExportRows(template, rows, meta);
  if (!v.ok) {
    const head = v.errors.slice(0, 3).map((e) => e.message).join(' / ');
    throw new AdapterError('EXPORT_VALIDATION_FAILED', `전송 파일을 만들 수 없습니다 — 오류 ${v.errors.length}건: ${head}${v.errors.length > 3 ? ' 외' : ''}`, {
      errors: v.errors,
    });
  }
  const byId = new Map(rows.map((r) => [r.transactionId, r]));
  let records: FieldRecord[];
  let ids: string[];
  if (template.kind === 'purchase_sales') {
    records = rows.map((r) => purchaseSalesRecord(r, template));
    ids = rows.map((r) => r.transactionId);
  } else {
    ({ records, ids } = journalRecords(rows, template));
  }
  return writeTemplateWorkbook(template, records, {
    generatedAt: meta.generatedAt,
    includeTraceSheet: meta.includeTraceSheet ?? template.traceSheet,
    traceColumns: ['supplyAmount', 'vatAmount', 'totalAmount'],
    traceIdOf: (i) => ids[i]!,
    traceAmountsOf: (id) => {
      const r = byId.get(id)!;
      return [r.supplyAmount, r.vatAmount, r.totalAmount];
    },
  });
}

// ────────────────────────────── 재검증 ──────────────────────────────

export type VerifyDiffCode =
  | 'sheet_missing'
  | 'header_mismatch'
  | 'template_changed'
  | 'unreadable_amount'
  | 'row_sum_mismatch'
  | 'row_amount_mismatch'
  | 'untraced_row'
  | 'unbalanced'
  | 'count_mismatch'
  | 'supply_mismatch'
  | 'vat_mismatch'
  | 'total_mismatch'
  | 'missing_transaction'
  | 'extra_transaction'
  | 'duplicate_transaction'
  | 'expected_inconsistent'
  | 'no_trace'
  | 'not_verifiable'
  | 'trace_invalid'
  | 'row_content_mismatch'
  | 'sample_row_changed'
  | 'sample_row_present';

export interface VerifyDiff {
  code: VerifyDiffCode;
  message: string;
  /** true 면 전송 금지 */
  blocking: boolean;
  excelRow?: number;
  transactionId?: string;
  expected?: number;
  actual?: number;
}

export interface VerifyResult {
  ok: boolean;
  actual: ExportTotals;
  expected: ExportTotals;
  diffs: VerifyDiff[];
  traceFound: boolean;
  /** 사용자에게 보여줄 한 줄 요약 */
  summary: string;
}

/**
 * 금액 셀 값. 빈 칸은 0. 숫자 셀만 인정한다 — 텍스트 금액("1,000")은 WEHAGO 가 0 또는 오류로 읽을 수 있어
 * 생성 파일에 있으면 안 된다 (null → 읽을 수 없음으로 차단).
 */
function amountOf(v: CellValue | undefined): number | null {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v !== 'number') return null;
  return parseWon(v);
}

/**
 * 생성된 xlsx 를 다시 읽어 건수·공급가액·부가세·합계를 1원 단위로 비교한다.
 * ok=false 이면 WEHAGO 로 보내면 안 된다.
 */
export async function verifyExportFile(
  buffer: Buffer,
  template: WehagoTemplate,
  expected: AmountTotals & { transactionIds: string[] },
): Promise<VerifyResult> {
  const diffs: VerifyDiff[] = [];
  const block = (d: Omit<VerifyDiff, 'blocking'>) => diffs.push({ ...d, blocking: true });
  const exp: ExportTotals = { count: expected.count, supplyAmount: expected.supplyAmount, vatAmount: expected.vatAmount, totalAmount: expected.totalAmount, transactionIds: [...expected.transactionIds] };
  const actual: ExportTotals = { count: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0, transactionIds: [] };

  let parsed: ParsedTemplateFile;
  try {
    parsed = await readTemplateWorkbook(buffer, template);
  } catch (e) {
    block({ code: 'sheet_missing', message: `파일을 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}` });
    return finish(false, actual, exp, diffs);
  }
  if (!parsed.sheetName) {
    block({ code: 'sheet_missing', message: `데이터 시트(${template.sheetName})가 없습니다.` });
    return finish(false, actual, exp, diffs);
  }
  for (const m of parsed.headerMismatches) block({ code: 'header_mismatch', message: `제목행이 서식과 다릅니다: ${m}` });
  if (exp.count !== exp.transactionIds.length) {
    block({ code: 'expected_inconsistent', message: `기대 건수 ${exp.count} 와 거래ID 수 ${exp.transactionIds.length} 가 다릅니다.` });
  }

  const trace = parsed.trace;
  if (trace && trace.headerHash !== templateHeaderHash(template)) {
    block({ code: 'template_changed', message: '파일 생성 당시 서식과 현재 서식의 제목행이 다릅니다.' });
  }
  for (const issue of checkTraceIntegrity(parsed, template)) block(issue);
  if (template.sampleRow) {
    diffs.push({
      code: 'sample_row_present',
      message: `${parsed.headerExcelRow + 1}행에 서식 샘플 행이 있습니다 (검증 대상 아님). WEHAGO 가 이 행을 건너뛰는지 첫 업로드 때 확인하세요.`,
      blocking: false,
      excelRow: parsed.headerExcelRow + 1,
    });
  }

  // 행 단위 금액
  const rowAmounts = new Map<number, { s: number; v: number; svc: number; t: number; debit: number; credit: number }>();
  for (const { excelRow, values } of parsed.dataRows) {
    const read = (f: ExportField): number => {
      const n = amountOf(values[f]);
      if (n === null) {
        const kind = typeof values[f] === 'string' ? '숫자가 아닌 텍스트 셀' : '원 단위 정수가 아님';
        block({ code: 'unreadable_amount', message: `${excelRow}행 ${f} 금액을 읽을 수 없습니다 (${kind}): "${String(values[f])}"`, excelRow });
        return 0;
      }
      return n;
    };
    const a =
      template.kind === 'purchase_sales'
        ? { s: read('supplyAmount'), v: read('vatAmount'), svc: read('serviceCharge'), t: read('totalAmount'), debit: 0, credit: 0 }
        : { s: 0, v: 0, svc: 0, t: 0, debit: read('debit'), credit: read('credit') };
    rowAmounts.set(excelRow, a);
    if (template.kind === 'purchase_sales') {
      if (a.s + a.v + a.svc !== a.t) {
        block({ code: 'row_sum_mismatch', message: `${excelRow}행: 공급가액+부가세${a.svc ? '+봉사료' : ''} ≠ 합계 (차이 ${formatWon(a.t - a.s - a.v - a.svc)})`, excelRow });
      }
      actual.supplyAmount += a.s;
      actual.vatAmount += a.v;
      actual.totalAmount += a.t;
    } else {
      actual.totalAmount += a.debit;
    }
  }

  if (template.kind === 'general_journal') {
    const debit = [...rowAmounts.values()].reduce((s, a) => s + a.debit, 0);
    const credit = [...rowAmounts.values()].reduce((s, a) => s + a.credit, 0);
    if (debit !== credit) block({ code: 'unbalanced', message: `차변 합 ${formatWon(debit)} ≠ 대변 합 ${formatWon(credit)} (차이 ${formatWon(debit - credit)})` });
  }

  // 추적 시트 대조
  if (trace) {
    const covered = new Set<number>();
    const idSeen = new Set<string>();
    let traceSupply = 0;
    let traceVat = 0;
    for (const e of trace.entries) {
      if (idSeen.has(e.id)) block({ code: 'duplicate_transaction', message: `같은 거래가 파일에 두 번 있습니다 (${e.id}).`, transactionId: e.id });
      idSeen.add(e.id);
      actual.transactionIds.push(e.id);
      const [ts = 0, tv = 0, tt = 0] = e.amounts;
      traceSupply += ts;
      traceVat += tv;
      let s = 0;
      let v = 0;
      let t = 0;
      let debit = 0;
      let credit = 0;
      // 범위 오류는 checkTraceIntegrity 가 이미 차단 사유로 남겼다. 파일 끝을 넘는 범위는 끝까지만 본다
      const lastRn = traceRangeProblem(e, parsed) ? e.firstRow - 1 : Math.min(e.lastRow, parsed.lastExcelRow);
      for (let rn = e.firstRow; rn <= lastRn; rn++) {
        covered.add(rn);
        const a = rowAmounts.get(rn);
        if (!a) continue;
        s += a.s;
        v += a.v;
        t += a.t;
        debit += a.debit;
        credit += a.credit;
      }
      if (template.kind === 'purchase_sales') {
        if (s !== ts || v !== tv || t !== tt) {
          block({
            code: 'row_amount_mismatch',
            message: `${e.firstRow}행(${e.id}): 파일 금액 공급가액 ${formatWon(s)}/부가세 ${formatWon(v)}/합계 ${formatWon(t)} ≠ 생성 당시 ${formatWon(ts)}/${formatWon(tv)}/${formatWon(tt)}`,
            excelRow: e.firstRow,
            transactionId: e.id,
          });
        }
      } else if (debit !== tt || credit !== tt) {
        block({
          code: 'row_amount_mismatch',
          message: `${e.firstRow}~${e.lastRow}행(${e.id}): 차변 ${formatWon(debit)}/대변 ${formatWon(credit)} ≠ 거래 합계 ${formatWon(tt)}`,
          excelRow: e.firstRow,
          transactionId: e.id,
        });
      }
    }
    for (const { excelRow } of parsed.dataRows) {
      if (!covered.has(excelRow)) block({ code: 'untraced_row', message: `${excelRow}행은 생성 당시 없던 행입니다 (추가·이동된 행).`, excelRow });
    }
    const expSet = new Set(exp.transactionIds);
    for (const id of exp.transactionIds) if (!idSeen.has(id)) block({ code: 'missing_transaction', message: `거래 ${id} 가 파일에 없습니다.`, transactionId: id });
    for (const id of idSeen) if (!expSet.has(id)) block({ code: 'extra_transaction', message: `거래 ${id} 는 전송 대상이 아닌데 파일에 있습니다.`, transactionId: id });
    if (template.kind === 'general_journal') {
      actual.count = trace.entries.length;
      actual.supplyAmount = traceSupply;
      actual.vatAmount = traceVat;
    } else {
      actual.count = parsed.dataRows.length;
    }
  } else {
    diffs.push({ code: 'no_trace', message: '추적 시트가 없어 거래ID는 건수로만 확인했습니다.', blocking: false });
    if (template.kind === 'general_journal') {
      const groups = new Set(parsed.dataRows.map((d) => `${String(d.values.month)}|${String(d.values.day)}|${String(d.values.voucherNo ?? '')}`));
      actual.count = template.columns.some((c) => c.field === 'voucherNo') ? groups.size : parsed.dataRows.length;
      diffs.push({ code: 'not_verifiable', message: '일반전표 파일에는 공급가액·부가세 열이 없어 합계(차변)만 비교했습니다.', blocking: false });
    } else {
      actual.count = parsed.dataRows.length;
    }
  }

  // 합계 비교 (1원 단위)
  const cmp = (code: VerifyDiffCode, label: string, a: number, b: number, isWon = true) => {
    if (a !== b) {
      block({
        code,
        message: `${label}: 파일 ${isWon ? formatWon(a) : `${a}건`} / 기대 ${isWon ? formatWon(b) : `${b}건`} (차이 ${isWon ? formatWon(a - b) : `${a - b}건`})`,
        actual: a,
        expected: b,
      });
    }
  };
  cmp('count_mismatch', '건수', actual.count, exp.count, false);
  const supplyVatVerifiable = template.kind === 'purchase_sales' || !!trace;
  if (supplyVatVerifiable) {
    cmp('supply_mismatch', '공급가액 합계', actual.supplyAmount, exp.supplyAmount);
    cmp('vat_mismatch', '부가세 합계', actual.vatAmount, exp.vatAmount);
  }
  cmp('total_mismatch', '합계', actual.totalAmount, exp.totalAmount);

  return finish(!!trace, actual, exp, diffs);
}

function finish(traceFound: boolean, actual: ExportTotals, expected: ExportTotals, diffs: VerifyDiff[]): VerifyResult {
  const blocking = diffs.filter((d) => d.blocking);
  const ok = blocking.length === 0;
  const summary = ok
    ? `검증 통과: ${actual.count}건 · 공급가액 ${formatWon(actual.supplyAmount)} · 부가세 ${formatWon(actual.vatAmount)} · 합계 ${formatWon(actual.totalAmount)} (1원 단위 일치)`
    : `전송 금지: 차이 ${blocking.length}건 — ${blocking[0]!.message}`;
  return { ok, actual, expected, diffs, traceFound, summary };
}
