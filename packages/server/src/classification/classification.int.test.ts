import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { TEST_KEYS, insertTxs, type TxSeed } from './test-fixtures';

process.env.MINTAX_DATA_KEY ??= TEST_KEYS.MINTAX_DATA_KEY;
process.env.MINTAX_INDEX_KEY ??= TEST_KEYS.MINTAX_INDEX_KEY;
process.env.AI_PROVIDER = 'heuristic';

import { eq, sql } from 'drizzle-orm';
import { auditLogs, classificationResults, closeDb, mappingRules, setupTestDatabase, transactions, type Database } from '@mintax/db';
import type { AIProvider } from '@mintax/ai';
import { createTestClient, createTestUser, testContext } from '../testing/factory';
import { systemActor, type ServiceContext } from '../context';
import { classifyClientPeriod, loadClassificationInputs } from './index';
import { ensureDefaultRules } from '../rules/index';

let db: Database;
let sys: ServiceContext;

beforeAll(async () => {
  db = await setupTestDatabase();
  await ensureDefaultRules(db);
  sys = testContext(db, systemActor());
});

afterAll(async () => {
  await closeDb();
});

const COUPANG_BIZNO = '1208800767';

function hist(clientId: string, n: number, over: Partial<TxSeed> = {}): TxSeed[] {
  return Array.from({ length: n }, (_, i) => ({
    clientId,
    date: `2026-0${3 + (i % 5)}-1${i % 9}`,
    merchantName: '쿠팡(주)',
    merchantBusinessNumber: COUPANG_BIZNO,
    totalAmount: 33000 + i * 110,
    status: 'approved',
    accountCode: '830',
    accountName: '소모품비',
    ...over,
  }));
}

describe('loadClassificationInputs', () => {
  it('excludes the batch transactions, restricts peers to batch merchants, loads corrections/rules/policy', async () => {
    const a = await createTestClient(db, { industry: 'construction' });
    const b = await createTestClient(db, { industry: 'construction' });
    const c = await createTestClient(db, { industry: 'construction' });
    await insertTxs(db, hist(a.id, 4));
    // 타 수임처: 쿠팡(배치 상대방) + 무관 상대방(배치에 없음)
    await insertTxs(db, [...hist(b.id, 3), ...hist(c.id, 2, { accountCode: '829', accountName: '사무용품비' })]);
    await insertTxs(db, [{ clientId: b.id, date: '2026-05-01', merchantName: '무관상사', totalAmount: 50000, status: 'approved', accountCode: '831', accountName: '지급수수료' }]);
    // 분류 대상 (approved 로 넣고 excludeTransactionIds 로 제외되는지 확인)
    const batchIds = await insertTxs(db, [
      { clientId: a.id, date: '2026-09-03', merchantName: '쿠팡(주)', merchantBusinessNumber: COUPANG_BIZNO, totalAmount: 44000, status: 'approved', accountCode: '830', accountName: '소모품비' },
    ]);
    // 오래된 이력 (24개월 밖) — 제외
    await insertTxs(db, [{ ...hist(a.id, 1)[0]!, date: '2024-08-31' }]);

    const inputs = await loadClassificationInputs(db, {
      clientId: a.id,
      period: '2026-09',
      merchantKeys: ['쿠팡'],
      bizNos: [COUPANG_BIZNO],
      excludeTransactionIds: batchIds,
    });
    expect(inputs.history).toHaveLength(4);
    expect(inputs.history.every((h) => h.clientId === a.id && h.direction === 'purchase')).toBe(true);
    expect(inputs.peerHistory.every((h) => h.clientId !== a.id)).toBe(true);
    expect(new Set(inputs.peerHistory.map((h) => h.merchantKey))).toEqual(new Set(['쿠팡']));
    expect(inputs.peerHistory).toHaveLength(5);
    expect(inputs.stats.peerClients).toBe(2);
    expect(inputs.peerHistory.filter((h) => h.accountCode === '829')).toHaveLength(2);
    expect(inputs.peerHistory[0]!.industry).toBe('construction');
    expect(inputs.accounts.length).toBeGreaterThan(50);
    expect(inputs.vatRulesSource).toBe('db');
    expect(inputs.reviewRulesSource).toBe('db');
    expect(inputs.rules.some((r) => r.origin === 'system_default' && String(r.id).startsWith('SYS-'))).toBe(true);
    expect(inputs.policy.autoApproveMin).toBe(95);
    expect(inputs.asOfDate).toBe('2026-09-30');
  });
});

describe('classifyClientPeriod — end-to-end on a mini-ledger', () => {
  it('history → auto-approved; unknown → needs_review; high-risk never auto; idempotent re-run', async () => {
    const user = await createTestUser(db, 'staff', '김세무');
    const cl = await createTestClient(db, { industry: 'construction' });
    await insertTxs(db, hist(cl.id, 6));
    const ids = await insertTxs(db, [
      // 과거 6회 소모품비 → 자동확정
      { clientId: cl.id, date: '2026-09-05', merchantName: '쿠팡(주)', merchantBusinessNumber: COUPANG_BIZNO, totalAmount: 38500 },
      // 처음 보는 상대방 → 검토
      { clientId: cl.id, date: '2026-09-06', merchantName: '듣보잡상회', totalAmount: 27500 },
      // 접대 키워드 (high) → 절대 자동확정 불가
      { clientId: cl.id, date: '2026-09-07', merchantName: '쿠팡(주)', merchantBusinessNumber: COUPANG_BIZNO, totalAmount: 39600, description: '골프 선물' },
      // 사람이 이미 검토한 거래 → 건드리지 않음
      { clientId: cl.id, date: '2026-09-08', merchantName: '쿠팡(주)', merchantBusinessNumber: COUPANG_BIZNO, totalAmount: 11000, reviewedBy: user.id, status: 'imported' },
    ]);

    const res = await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', aiProvider: null });
    expect(res.total).toBe(3);
    const rows = await db.select().from(transactions).where(eq(transactions.clientId, cl.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const auto = byId.get(ids[0]!)!;
    expect(auto.status).toBe('auto_approved');
    expect(auto.accountCode).toBe('830');
    expect(auto.classificationSource).toBe('exact_history');
    expect(auto.confidenceScore).toBeGreaterThanOrEqual(95);
    expect(auto.touchCount).toBe(0);
    const unknown = byId.get(ids[1]!)!;
    expect(unknown.status).toBe('needs_review');
    expect(unknown.buckets.length).toBeGreaterThan(0);
    const risky = byId.get(ids[2]!)!;
    expect(risky.status).toBe('needs_review');
    expect(risky.buckets).toContain('entertainment');
    expect(risky.reviewLevel).toBe('must_review');
    const reviewed = byId.get(ids[3]!)!;
    expect(reviewed.status).toBe('imported');
    expect(reviewed.accountCode).toBeNull();
    expect(res.autoApproved).toBe(1);
    expect(res.needsReview).toBe(2);

    const results = await db.select().from(classificationResults);
    expect(results.filter((r) => ids.includes(r.transactionId))).toHaveLength(3);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.clientId, cl.id));
    const batchAudit = audits.find((a) => a.action === 'classification.batch');
    expect(batchAudit?.summary).toBe('9월 카드매입 3건 자동분류: 1건 자동확정, 2건 검토필요');
    expect(batchAudit?.category).toBe('system');

    // 재실행: imported/classified 만 대상 → 0건, 기존 결과 불변
    const again = await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', aiProvider: null });
    expect(again.total).toBe(0);
    const after = await db.select().from(transactions).where(eq(transactions.id, ids[0]!));
    expect(after[0]!.status).toBe('auto_approved');
    const results2 = await db.select({ n: sql<number>`count(*)::int` }).from(classificationResults);
    expect(results2[0]!.n).toBe(results.length);
  });
});

export const _unused: AIProvider | null = null;
void mappingRules;
