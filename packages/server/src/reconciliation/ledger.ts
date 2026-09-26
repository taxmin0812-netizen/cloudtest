/**
 * WEHAGO 매입매출장 엑셀 변환 파일(역수입) 읽기 — adapters 의 대사용 형식 프로필(wehago_ledger_purchase_sales_v1).
 * 읽을 수 없는 행은 버리지 않고 failures 로 돌려준다 (대사 보고서에 차단 사유로 들어간다).
 */
import { findVatTypeByCode, importTabularFile, isAdapterError, type ClientRef } from '@mintax/adapters';
import type { ReconWehagoRow } from '@mintax/core/engine/vat-risk-index';
import { AppError } from '@mintax/security';

export interface ParsedLedgerRow extends ReconWehagoRow {
  rowNumber: number | null;
  vatTypeCode: string | null;
  evidenceType: string | null;
  counterpartyCode: string | null;
  businessNumber: string | null;
}

export interface ParsedLedger {
  /** 이 기간 행 */
  rows: ParsedLedgerRow[];
  failures: Array<{ rowNumber: number; reason: string }>;
  /** 다른 기간 행 수 (대상 아님) */
  outOfPeriod: number;
  profileId: string;
  warnings: string[];
}

export async function parseWehagoLedger(
  data: Buffer,
  fileName: string,
  client: { id: string; businessNumber: string },
  period: string,
  clients: readonly ClientRef[],
): Promise<ParsedLedger> {
  let parsed;
  try {
    parsed = await importTabularFile(
      data,
      fileName,
      { clientId: client.id, businessNumber: client.businessNumber, channel: 'manual_upload', source: 'wehago' },
      { purpose: 'reconciliation', clients },
    );
  } catch (e) {
    if (isAdapterError(e)) {
      const hint =
        e.code === 'INVALID_CONTEXT' || e.code === 'HEADER_NOT_FOUND' || e.code === 'COLUMN_MAPPING_REQUIRED'
          ? ' WEHAGO [매입매출장] 화면에서 "엑셀 변환"한 파일을 그대로 올려주세요.'
          : '';
      throw new AppError({
        code: `WEHAGO_LEDGER_${e.code}`,
        httpStatus: 422,
        userMessage: `${e.message}${hint}`,
        action: { label: '전송센터', href: '/transfer' },
      });
    }
    throw e;
  }
  const rows: ParsedLedgerRow[] = [];
  let outOfPeriod = 0;
  for (const t of parsed.result.transactions) {
    if (t.transactionDate.slice(0, 7) !== period) {
      outOfPeriod++;
      continue;
    }
    const ledger = (t.rawData.__ledger ?? {}) as { vatTypeCode?: string | null; accountCode?: string | null; counterpartyCode?: string | null };
    const code = ledger.vatTypeCode ?? null;
    rows.push({
      date: t.transactionDate,
      merchantName: t.merchantName,
      supplyAmount: t.supplyAmount,
      vatAmount: t.vatAmount,
      totalAmount: t.totalAmount,
      accountCode: ledger.accountCode ?? null,
      rowNumber: t.sourceRowNumber,
      vatTypeCode: code,
      evidenceType: code ? (findVatTypeByCode(code)?.evidenceType ?? null) : null,
      counterpartyCode: ledger.counterpartyCode ?? null,
      businessNumber: t.merchantBusinessNumber,
    });
  }
  const failures = parsed.result.failures
    .filter((f) => f.code !== 'non_data_row')
    .map((f) => ({ rowNumber: f.sourceRowNumber, reason: f.reason }));
  return { rows, failures, outOfPeriod, profileId: parsed.result.profileId, warnings: parsed.preview.file.warnings };
}
