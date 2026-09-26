/**
 * review 영역 통합 테스트 전용 도우미 (서비스 코드에서 쓰지 않는다).
 */
import { randomUUID } from 'node:crypto';
import { classificationResults, getPool, transactions, type Database } from '@mintax/db';
import {
  normalizeMerchantName,
  type AccountClassification,
  type ClassificationSource,
  type ExceptionBucket,
  type ReviewLevel,
  type RiskFlag,
  type VatClassification,
} from '@mintax/core';

export const TEST_KEYS = {
  MINTAX_DATA_KEY: Buffer.alloc(32, 11).toString('base64'),
  MINTAX_INDEX_KEY: Buffer.alloc(32, 13).toString('base64'),
};

export const REVIEW_TEST_DB = process.env.DATABASE_URL_TEST ?? 'postgres://mintax:mintax_dev@localhost:5432/mintax_test_review';

/**
 * 같은 테스트 DB 를 쓰는 review 통합 테스트 파일끼리 직렬화 (vitest 가 파일을 병렬로 돌려도 DB 초기화가 겹치지 않게).
 * beforeAll 에서 setupTestDatabase 전에 잡고, afterAll 에서 closeDb() 전에 푼다.
 */
export async function lockReviewTestDatabase(): Promise<() => Promise<void>> {
  const client = await getPool(REVIEW_TEST_DB).connect();
  await client.query('select pg_advisory_lock(727274777)');
  return async () => {
    try {
      await client.query('select pg_advisory_unlock(727274777)');
    } finally {
      client.release();
    }
  };
}

export interface ReviewSeed {
  clientId: string;
  date: string;
  merchantName: string;
  bizno?: string | null;
  total: number;
  direction?: 'purchase' | 'sales';
  evidenceType?: string;
  status?: string;
  accountCode?: string | null;
  accountName?: string | null;
  source?: ClassificationSource | null;
  confidence?: number;
  vatType?: string | null;
  deductible?: boolean | null;
  buckets?: ExceptionBucket[];
  riskFlags?: RiskFlag[];
  reviewLevel?: ReviewLevel | null;
  alternatives?: AccountClassification['alternatives'];
  description?: string;
  summary?: string;
  rawData?: Record<string, unknown>;
  cardNumberMasked?: string | null;
}

export function riskFlag(bucket: ExceptionBucket, p: Partial<RiskFlag> = {}): RiskFlag {
  return {
    ruleCode: `RISK-${bucket}`,
    ruleName: bucket,
    bucket,
    severity: 'warning',
    blocksAutoApproval: true,
    message: `${bucket} 검토 필요`,
    ...p,
  };
}

/** 거래 + 최신 분류 결과를 한 번에 넣는다 (1000행 단위) → id 목록 (입력 순서) */
export async function seedTransactions(db: Database, seeds: ReviewSeed[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < seeds.length; i += 1000) {
    const part = seeds.slice(i, i + 1000);
    const rows = await db
      .insert(transactions)
      .values(
        part.map((s) => {
          const vat = s.evidenceType === 'invoice_exempt' ? 0 : Math.round(s.total / 11);
          const conf = s.confidence ?? 70;
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
            merchantBusinessNumber: s.bizno ?? null,
            merchantTaxType: 'general',
            description: s.description ?? '',
            supplyAmount: s.total - vat,
            vatAmount: vat,
            totalAmount: s.total,
            cardNumberMasked: s.cardNumberMasked === undefined ? '1234-****-****-5678' : s.cardNumberMasked,
            rawData: s.rawData ?? {},
            fingerprint: randomUUID(),
            accountCode: s.accountCode === undefined ? '830' : s.accountCode,
            accountName: s.accountName === undefined ? (s.accountCode === null ? null : '소모품비') : s.accountName,
            accountConfidence: conf,
            classificationSource: (s.source === undefined ? 'name_history' : s.source) as ClassificationSource | null,
            classificationSummary: s.summary ?? `${s.merchantName} 과거 처리 기준`,
            vatType: s.vatType === undefined ? (s.direction === 'sales' ? 'sales_card' : 'purchase_card') : s.vatType,
            deductible: s.deductible === undefined ? true : s.deductible,
            vatConfidence: 95,
            confidenceScore: Math.min(conf, 95),
            reviewLevel: s.reviewLevel === undefined ? (conf >= 80 ? 'quick_review' : 'must_review') : s.reviewLevel,
            buckets: s.buckets ?? (conf < 80 ? ['low_confidence'] : []),
            riskFlags: s.riskFlags ?? [],
            status: s.status ?? 'needs_review',
          };
        }),
      )
      .returning({ id: transactions.id });
    const got = rows.map((r) => r.id);
    await db.insert(classificationResults).values(
      part.map((s, j) => {
        const account: AccountClassification = {
          accountCode: s.accountCode === undefined ? '830' : s.accountCode,
          accountName: s.accountName === undefined ? (s.accountCode === null ? null : '소모품비') : s.accountName,
          confidence: s.confidence ?? 70,
          source: (s.source ?? 'name_history') as ClassificationSource,
          summary: s.summary ?? `${s.merchantName} 과거 처리 기준`,
          reasons: ['테스트 근거'],
          evidence: { historyCount: 10, consistentCount: 9 },
          alternatives: s.alternatives ?? [
            { accountCode: '829', accountName: '사무용품비', confidence: 60, source: 'name_history' },
            { accountCode: '811', accountName: '복리후생비', confidence: 41, source: 'ai' },
            { accountCode: '146', accountName: '상품', confidence: 30, source: 'industry_pattern' },
            { accountCode: '826', accountName: '도서인쇄비', confidence: 10, source: 'ai' },
          ],
        };
        const vat: VatClassification = {
          vatType: 'purchase_card',
          deductible: true,
          nonDeductibleReasonCode: null,
          confidence: 95,
          summary: '공제 — 일반과세자 카드',
          reasons: ['테스트'],
          ruleIds: ['VAT-DEF-CARD-GEN'],
        };
        return { transactionId: got[j]!, engineVersion: 'test', account, vat, risks: s.riskFlags ?? [], reviewLevel: 'must_review' };
      }),
    );
    ids.push(...got);
  }
  return ids;
}
