/**
 * 전송·대사 통합 테스트용 데이터 적재 도우미 (실제 DB 에 import_jobs · transactions · transaction_sources 를 직접 만든다).
 * 수집 파이프라인(imports 영역)과 독립적으로 전송/대사만 검증하기 위함.
 */
import { randomUUID } from 'node:crypto';
import { computeFingerprint, normalizeMerchantName } from '@mintax/core';
import { clientBusinessProfiles, importJobs, transactionSources, transactions, type Database } from '@mintax/db';
import { eq } from 'drizzle-orm';

export interface TxSpec {
  date: string;
  merchant: string;
  bizno?: string | null;
  evidenceType?: 'card' | 'tax_invoice' | 'invoice_exempt' | 'cash_receipt' | 'bank' | 'other';
  direction?: 'purchase' | 'sales';
  supply: number;
  vat: number;
  total?: number;
  serviceCharge?: number;
  status?: 'imported' | 'classified' | 'needs_review' | 'auto_approved' | 'approved' | 'duplicate' | 'excluded';
  accountCode?: string | null;
  accountName?: string | null;
  vatType?: string | null;
  deductible?: boolean | null;
  duplicateReason?: string | null;
  excludedReason?: string | null;
  /** 사람이 승인 */
  reviewedBy?: string | null;
  approvalNumber?: string | null;
  description?: string;
}

export interface FailedSpec {
  rowNumber: number;
  reason: string;
  supply?: number | null;
  vat?: number | null;
  total?: number | null;
}

export interface SeededPeriod {
  importJobId: string;
  txIds: string[];
}

const DEFAULT_ACCOUNT: Record<string, [string, string]> = {
  purchase: ['811', '복리후생비'],
  sales: ['401', '상품매출'],
};

function defaultVatType(t: TxSpec): string {
  const dir = t.direction ?? 'purchase';
  const ev = t.evidenceType ?? 'card';
  if (dir === 'sales') return ev === 'card' ? 'sales_card' : ev === 'cash_receipt' ? 'sales_cash_receipt' : ev === 'invoice_exempt' ? 'sales_exempt' : 'sales_taxable';
  if (ev === 'card') return t.vat === 0 ? 'purchase_card_exempt' : 'purchase_card';
  if (ev === 'cash_receipt') return 'purchase_cash_receipt';
  if (ev === 'invoice_exempt') return 'purchase_exempt';
  if (ev === 'tax_invoice') return 'purchase_taxable';
  return 'purchase_no_evidence';
}

/** 수임처 한 곳·한 기간 자료 적재 (가져오기 1건 + 거래 + 원본 행) */
export async function seedPeriod(
  db: Database,
  client: { id: string; businessNumber: string },
  period: string,
  specs: TxSpec[],
  failed: FailedSpec[] = [],
): Promise<SeededPeriod> {
  const [job] = await db
    .insert(importJobs)
    .values({
      clientId: client.id,
      channel: 'wemembers_file',
      source: 'business_card',
      period,
      status: failed.length ? 'partial' : 'succeeded',
      totalRows: specs.length + failed.length,
      importedRows: specs.filter((s) => s.status !== 'duplicate').length,
      duplicateRows: specs.filter((s) => s.status === 'duplicate').length,
      failedRows: failed.length,
    })
    .returning({ id: importJobs.id });
  const ids = specs.map(() => randomUUID());
  const txRows = specs.map((s, i) => {
    const dir = s.direction ?? 'purchase';
    const ev = s.evidenceType ?? 'card';
    const total = s.total ?? s.supply + s.vat + (s.serviceCharge ?? 0);
    const status = s.status ?? 'auto_approved';
    const [acc, accName] = DEFAULT_ACCOUNT[dir]!;
    const merchantKey = normalizeMerchantName(s.merchant);
    const fingerprint = computeFingerprint({
      clientId: client.id,
      direction: dir,
      evidenceType: ev,
      transactionDate: s.date,
      merchantBusinessNumber: s.bizno ?? null,
      merchantKey,
      totalAmount: total,
      supplyAmount: s.supply,
      vatAmount: s.vat,
      cardNumberMasked: null,
      approvalNumber: s.approvalNumber ?? `A${i}-${ids[i]!.slice(0, 6)}`,
      originalSourceId: null,
    });
    return {
      id: ids[i]!,
      clientId: client.id,
      businessNumber: client.businessNumber,
      importJobId: job!.id,
      source: 'business_card',
      channel: 'wemembers_file',
      direction: dir,
      period,
      transactionDate: s.date,
      evidenceType: ev,
      merchantName: s.merchant,
      merchantKey,
      merchantBusinessNumber: s.bizno ?? null,
      description: s.description ?? '',
      supplyAmount: s.supply,
      vatAmount: s.vat,
      serviceCharge: s.serviceCharge ?? 0,
      totalAmount: total,
      approvalNumber: s.approvalNumber ?? null,
      fingerprint,
      status,
      accountCode: s.accountCode === undefined ? acc : s.accountCode,
      accountName: s.accountName === undefined ? (s.accountCode === undefined ? accName : null) : s.accountName,
      vatType: s.vatType === undefined ? defaultVatType(s) : s.vatType,
      deductible: s.deductible === undefined ? (dir === 'purchase' ? true : null) : s.deductible,
      duplicateReason: status === 'duplicate' ? (s.duplicateReason ?? null) : null,
      excludedReason: status === 'excluded' ? (s.excludedReason ?? null) : null,
      reviewedBy: s.reviewedBy ?? null,
      reviewedAt: s.reviewedBy ? new Date() : null,
      classificationSource: 'system_rule' as const,
      confidenceScore: 96,
    };
  });
  for (let i = 0; i < txRows.length; i += 1000) await db.insert(transactions).values(txRows.slice(i, i + 1000));
  const srcRows = [
    ...txRows.map((t, i) => ({
      importJobId: job!.id,
      rowNumber: i + 1,
      rawData: { __row: i + 1 },
      outcome: (t.status === 'duplicate' ? 'duplicate' : 'ok') as 'ok' | 'duplicate',
      errorReason: t.status === 'duplicate' ? t.duplicateReason : null,
      transactionId: t.id,
      supplyAmount: t.supplyAmount,
      vatAmount: t.vatAmount,
      totalAmount: t.totalAmount,
    })),
    ...failed.map((f) => ({
      importJobId: job!.id,
      rowNumber: f.rowNumber,
      rawData: { __row: f.rowNumber },
      outcome: 'failed' as const,
      errorReason: f.reason,
      transactionId: null,
      supplyAmount: f.supply ?? null,
      vatAmount: f.vat ?? null,
      totalAmount: f.total ?? null,
    })),
  ];
  for (let i = 0; i < srcRows.length; i += 1000) await db.insert(transactionSources).values(srcRows.slice(i, i + 1000));
  return { importJobId: job!.id, txIds: ids };
}

export async function setRuleParams(db: Database, clientId: string, params: Record<string, string | number | boolean>): Promise<void> {
  await db.update(clientBusinessProfiles).set({ ruleParams: params }).where(eq(clientBusinessProfiles.clientId, clientId));
}
