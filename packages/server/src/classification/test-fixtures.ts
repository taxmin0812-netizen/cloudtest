/**
 * classify 영역 통합 테스트용 거래 생성 도우미 (테스트 전용 — 서비스 코드에서 쓰지 않는다).
 */
import { randomUUID } from 'node:crypto';
import { transactions, type Database } from '@mintax/db';
import { normalizeMerchantName } from '@mintax/core';

export interface TxSeed {
  clientId: string;
  date: string;
  merchantName: string;
  merchantBusinessNumber?: string | null;
  totalAmount: number;
  direction?: 'purchase' | 'sales';
  evidenceType?: string;
  merchantTaxType?: string;
  merchantCategory?: string | null;
  description?: string;
  status?: string;
  accountCode?: string | null;
  accountName?: string | null;
  classificationSource?: string | null;
  reviewedBy?: string | null;
  sourceDeductibleHint?: boolean | null;
  vatAmount?: number;
  isForeign?: boolean;
}

export function txValues(s: TxSeed): typeof transactions.$inferInsert {
  const vat = s.vatAmount ?? (s.evidenceType === 'invoice_exempt' ? 0 : Math.round(s.totalAmount / 11));
  return {
    clientId: s.clientId,
    businessNumber: '1234567890',
    source: s.evidenceType === 'tax_invoice' ? 'tax_invoice' : 'business_card',
    channel: 'manual_upload',
    direction: s.direction ?? 'purchase',
    period: s.date.slice(0, 7),
    transactionDate: s.date,
    evidenceType: s.evidenceType ?? 'card',
    merchantName: s.merchantName,
    merchantKey: normalizeMerchantName(s.merchantName),
    merchantBusinessNumber: s.merchantBusinessNumber ?? null,
    merchantCategory: s.merchantCategory ?? null,
    merchantTaxType: s.merchantTaxType ?? 'general',
    description: s.description ?? '',
    supplyAmount: s.totalAmount - vat,
    vatAmount: vat,
    serviceCharge: 0,
    totalAmount: s.totalAmount,
    cardNumberMasked: '1234-****-****-5678',
    approvalNumber: randomUUID().slice(0, 8),
    currency: 'KRW',
    isForeign: s.isForeign ?? false,
    sourceDeductibleHint: s.sourceDeductibleHint ?? null,
    rawData: {},
    fingerprint: randomUUID(),
    accountCode: s.accountCode ?? null,
    accountName: s.accountName ?? null,
    classificationSource: (s.classificationSource ?? (s.accountCode ? 'exact_history' : null)) as never,
    status: s.status ?? 'imported',
    reviewedBy: s.reviewedBy ?? null,
  };
}

/** 대량 삽입 (1000행 단위) → 생성된 id 목록 (입력 순서) */
export async function insertTxs(db: Database, seeds: TxSeed[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < seeds.length; i += 1000) {
    const rows = await db
      .insert(transactions)
      .values(seeds.slice(i, i + 1000).map(txValues))
      .returning({ id: transactions.id });
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

export const TEST_KEYS = {
  MINTAX_DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
  MINTAX_INDEX_KEY: Buffer.alloc(32, 9).toString('base64'),
};
