import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_KEYS, insertTxs, lockTestDatabase, type TxSeed } from './test-fixtures';

process.env.MINTAX_DATA_KEY ??= TEST_KEYS.MINTAX_DATA_KEY;
process.env.MINTAX_INDEX_KEY ??= TEST_KEYS.MINTAX_INDEX_KEY;
process.env.AI_PROVIDER = 'heuristic';

import { eq, sql } from 'drizzle-orm';
import { closeDb, setupTestDatabase, transactions, type Database } from '@mintax/db';
import { createTestClient, testContext } from '../testing/factory';
import { systemActor } from '../context';
import { ensureDefaultRules } from '../rules/index';
import { classifyClientPeriod, resetClassificationAiProvider } from './index';

let db: Database;

let unlockDb: (() => Promise<void>) | null = null;

beforeAll(async () => {
  unlockDb = await lockTestDatabase();
  db = await setupTestDatabase();
  await ensureDefaultRules(db);
  resetClassificationAiProvider();
});

afterAll(async () => {
  await unlockDb?.();
  await closeDb();
});

const ACCOUNTS: Array<[string, string]> = [
  ['830', '소모품비'],
  ['811', '복리후생비'],
  ['829', '사무용품비'],
  ['153', '원재료'],
  ['826', '도서인쇄비'],
  ['831', '지급수수료'],
];

function bizno(i: number): string {
  return String(2_000_000_000 + i * 7);
}

describe('classification performance', () => {
  it('classifies 10,000 transactions for one client (2,000 history rows) within 20s end-to-end', async () => {
    const client = await createTestClient(db, { industry: 'restaurant' });
    const peers = await Promise.all([1, 2, 3, 4, 5].map(() => createTestClient(db, { industry: 'restaurant' })));

    // 이력 2,000건: 상대방 0~199 × 10건 (3~8월)
    const history: TxSeed[] = [];
    for (let m = 0; m < 200; m++) {
      const [code, name] = ACCOUNTS[m % ACCOUNTS.length]!;
      for (let k = 0; k < 10; k++) {
        history.push({
          clientId: client.id,
          date: `2026-0${3 + (k % 6)}-${String(1 + ((m + k) % 27)).padStart(2, '0')}`,
          merchantName: `거래처${m}`,
          merchantBusinessNumber: bizno(m),
          totalAmount: 11000 + ((m * 37 + k * 13) % 50) * 1100,
          status: k % 3 === 0 ? 'exported' : 'approved',
          accountCode: code,
          accountName: name,
        });
      }
    }
    // 타 수임처 이력 2,000건: 상대방 200~249
    const peerRows: TxSeed[] = [];
    peers.forEach((p, pi) => {
      for (let m = 200; m < 250; m++) {
        for (let k = 0; k < 8; k++) {
          peerRows.push({
            clientId: p.id,
            date: `2026-0${4 + (k % 5)}-1${pi}`,
            merchantName: `거래처${m}`,
            merchantBusinessNumber: bizno(m),
            totalAmount: 22000,
            status: 'approved',
            accountCode: '153',
            accountName: '원재료',
          });
        }
      }
    });
    // 이번 달 10,000건: 상대방 400곳 × 25일 (상대방별 하루 1건 — 실제 카드 자료처럼)
    // 0~199 이력 있음(자동확정 대상), 200~249 업종 패턴, 250~399 처음 (일부 시스템 사전·AI)
    const batch: TxSeed[] = [];
    const special = ['KT', '한국전력공사', '스타벅스', 'GS칼텍스', '다이소'];
    for (let i = 0; i < 10_000; i++) {
      const m = i % 400;
      const day = 1 + Math.floor(i / 400);
      const unknown = m >= 250;
      batch.push({
        clientId: client.id,
        date: `2026-09-${String(day).padStart(2, '0')}`,
        merchantName: unknown ? (m < 255 ? special[m - 250]! : `처음가게${m}`) : `거래처${m}`,
        merchantBusinessNumber: unknown ? null : bizno(m),
        totalAmount: 11000 + ((m * 37 + day * 13) % 50) * 1100,
        description: unknown ? '식자재 구입' : '',
      });
    }
    const tIns = performance.now();
    await insertTxs(db, [...history, ...peerRows, ...batch]);
    const insertMs = Math.round(performance.now() - tIns);

    const progress: number[] = [];
    const ctx = testContext(db, systemActor());
    const t0 = performance.now();
    const res = await classifyClientPeriod(ctx, { clientId: client.id, period: '2026-09', onProgress: (p) => void progress.push(p) });
    const elapsed = Math.round(performance.now() - t0);

    console.log(
      `[perf] 10,000 tx / 2,000 history / 2,000 peer rows: total ${elapsed}ms (load ${res.timings.loadMs} · compute ${res.timings.computeMs} · write ${res.timings.writeMs}); ` +
        `seed insert ${insertMs}ms; auto ${res.autoApproved} / review ${res.needsReview} / unclassified ${res.unclassified}; ` +
        `buckets ${JSON.stringify(Object.fromEntries(Object.entries(res.byBucket).filter(([, n]) => n > 0)))}; AI ${res.aiProvider} calls ${res.aiCalls} used ${res.aiUsed}; sources ${JSON.stringify(Object.fromEntries(Object.entries(res.bySource).filter(([, n]) => n > 0)))}`,
    );
    expect(res.total).toBe(10_000);
    expect(res.autoApproved + res.needsReview).toBe(10_000);
    expect(res.autoApproved).toBeGreaterThan(4_500);
    expect(elapsed).toBeLessThan(20_000);
    expect(progress.at(-1)).toBe(10_000);
    const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from classification_results`)).rows as [{ n: number }];
    expect(n).toBe(10_000);
    const pending = await db.select({ c: sql<number>`count(*)::int` }).from(transactions).where(eq(transactions.status, 'imported'));
    expect(pending[0]!.c).toBe(0);
  });
});
