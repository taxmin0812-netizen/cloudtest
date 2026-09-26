import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { TEST_KEYS, insertTxs, lockTestDatabase, type TxSeed } from './test-fixtures';

process.env.MINTAX_DATA_KEY ??= TEST_KEYS.MINTAX_DATA_KEY;
process.env.MINTAX_INDEX_KEY ??= TEST_KEYS.MINTAX_INDEX_KEY;
process.env.AI_PROVIDER = 'heuristic';

import { eq, sql } from 'drizzle-orm';
import { auditLogs, classificationResults, closeDb, mappingRules, setupTestDatabase, transactions, type Database } from '@mintax/db';
import type { AIProvider } from '@mintax/ai';
import { createTestClient, createTestUser, testContext } from '../testing/factory';
import { systemActor, type ServiceContext } from '../context';
import { classifyClientPeriod, loadClassificationInputs, runClassifyBatchJob, startBatchClassification, type ClassifyBatchJobResult } from './index';
import { getJob } from '../jobs/queue';
import { AppError } from '@mintax/security';
import type { AIClassificationInput, AIClassificationSuggestion, IntegrationDescriptor } from '@mintax/core';
import { ensureDefaultRules } from '../rules/index';

let db: Database;
let sys: ServiceContext;

let unlockDb: (() => Promise<void>) | null = null;

beforeAll(async () => {
  unlockDb = await lockTestDatabase();
  db = await setupTestDatabase();
  await ensureDefaultRules(db);
  sys = testContext(db, systemActor());
});

afterAll(async () => {
  await unlockDb?.();
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


class FakeAi implements AIProvider {
  readonly name = 'fake-llm';
  readonly model = 'fake-1';
  inputs: AIClassificationInput[] = [];
  constructor(private readonly fn: (i: AIClassificationInput) => AIClassificationSuggestion | null | Promise<AIClassificationSuggestion | null>) {}
  status(): IntegrationDescriptor {
    return { key: 'ai_provider.fake', name: 'fake', status: 'MOCK', statusReason: 'test', capabilities: [] };
  }
  async classifyTransaction(input: AIClassificationInput) {
    this.inputs.push(input);
    return this.fn(input);
  }
  async reviewLedger() {
    return [];
  }
  async detectAnomaly() {
    return [];
  }
  async explainClassification() {
    return '';
  }
  async suggestRule() {
    return [];
  }
}

describe('classifyClientPeriod — AI stage', () => {
  it('asks AI only for unknown merchants, once per merchant, without PII, capped, and never auto-approves AI-only', async () => {
    const cl = await createTestClient(db, { industry: 'service' });
    await insertTxs(db, hist(cl.id, 3));
    const ids = await insertTxs(db, [
      { clientId: cl.id, date: '2026-09-01', merchantName: '미지의공방', merchantBusinessNumber: '2208123456', totalAmount: 44000, description: '공구 구입 연락처 010-1234-5678 주민 900101-1234567' },
      { clientId: cl.id, date: '2026-09-02', merchantName: '미지의공방', merchantBusinessNumber: '2208123456', totalAmount: 22000, description: '공구' },
      { clientId: cl.id, date: '2026-09-03', merchantName: '두번째가게', totalAmount: 11000 },
      { clientId: cl.id, date: '2026-09-04', merchantName: '쿠팡(주)', merchantBusinessNumber: COUPANG_BIZNO, totalAmount: 33000 },
    ]);
    const ai = new FakeAi(() => ({ accountCode: '830', accountName: '소모품비', confidence: 99, rationale: '공구·소모품', provider: 'fake-llm', model: 'fake-1' }));
    const res = await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', aiProvider: ai, aiMaxMerchants: 1 });
    // 미분류 상대방 2곳 중 거래가 많은 1곳만 (상한 1), 같은 상대방 2건은 1회 호출
    expect(ai.inputs).toHaveLength(1);
    expect(res.aiCalls).toBe(1);
    expect(res.aiSkippedMerchants).toBe(1);
    expect(res.aiUsed).toBe(2);
    const sent = JSON.stringify(ai.inputs[0]);
    expect(sent).not.toContain('900101-1234567');
    expect(sent).not.toContain('010-1234-5678');
    expect(sent).not.toContain('2208123456');
    expect(sent).not.toContain('1234-****');
    const rows = await db.select().from(transactions).where(eq(transactions.clientId, cl.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids.slice(0, 2)) {
      const r = byId.get(id)!;
      expect(r.classificationSource).toBe('ai');
      expect(r.accountConfidence).toBeLessThanOrEqual(70);
      expect(r.status).toBe('needs_review');
    }
    expect(byId.get(ids[2]!)!.accountCode).toBeNull();
    expect(byId.get(ids[2]!)!.buckets).toContain('unclassified');
    expect(byId.get(ids[3]!)!.status).toBe('auto_approved');
  });

  it('AI failure does not stop the pipeline and is reported honestly', async () => {
    const cl = await createTestClient(db, { industry: 'service' });
    await insertTxs(db, [{ clientId: cl.id, date: '2026-09-01', merchantName: '알수없음상사', totalAmount: 5500 }]);
    const ai = new FakeAi(() => {
      throw new Error('upstream 503');
    });
    const res = await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', aiProvider: ai });
    expect(res).toMatchObject({ total: 1, aiFailed: 1, aiUsed: 0, needsReview: 1, unclassified: 1 });
  });
});

describe('classifyClientPeriod — peers, guards, re-run', () => {
  it('uses the same-industry peer pattern for a merchant new to this client', async () => {
    const peers = await Promise.all([1, 2, 3].map(() => createTestClient(db, { industry: 'cafe' })));
    for (const p of peers) {
      await insertTxs(db, [
        { clientId: p.id, date: '2026-07-01', merchantName: '서울우유협동조합', merchantBusinessNumber: '1048212345', totalAmount: 120000, status: 'approved', accountCode: '153', accountName: '원재료', evidenceType: 'tax_invoice' },
        { clientId: p.id, date: '2026-08-01', merchantName: '서울우유협동조합', merchantBusinessNumber: '1048212345', totalAmount: 130000, status: 'exported', accountCode: '153', accountName: '원재료', evidenceType: 'tax_invoice' },
      ]);
    }
    const cl = await createTestClient(db, { industry: 'cafe' });
    const [id] = await insertTxs(db, [{ clientId: cl.id, date: '2026-09-10', merchantName: '서울우유협동조합', merchantBusinessNumber: '1048212345', totalAmount: 110000, evidenceType: 'tax_invoice' }]);
    const res = await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', aiProvider: null });
    expect(res.bySource.industry_pattern).toBe(1);
    const [row] = await db.select().from(transactions).where(eq(transactions.id, id!));
    expect(row!.accountCode).toBe('153');
    expect(row!.accountConfidence).toBe(93);
    expect(row!.status).toBe('needs_review'); // 신규 거래처 + 93 < 95
    expect(row!.buckets).toContain('new_merchant');
  });

  it('refuses to reclassify human-confirmed statuses and leaves approved rows alone on needs_review re-runs', async () => {
    const user = await createTestUser(db, 'staff');
    const cl = await createTestClient(db);
    await expect(classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', onlyStatuses: ['approved'] })).rejects.toBeInstanceOf(AppError);
    await expect(classifyClientPeriod(sys, { clientId: cl.id, period: '2026/09' })).rejects.toThrow(/형식/);
    await expect(classifyClientPeriod(sys, { clientId: 'nope', period: '2026-09' })).rejects.toThrow(/찾을 수 없습니다/);
    const viewer = testContext(db, (await createTestUser(db, 'viewer')).actor);
    await expect(classifyClientPeriod(viewer, { clientId: cl.id, period: '2026-09' })).rejects.toThrow(/권한/);

    const [a, b] = await insertTxs(db, [
      { clientId: cl.id, date: '2026-09-01', merchantName: '처음가게', totalAmount: 7700 },
      { clientId: cl.id, date: '2026-09-02', merchantName: '처음가게', totalAmount: 8800 },
    ]);
    await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', aiProvider: null });
    // 사람이 b 를 승인 (다른 영역이 하는 일을 흉내)
    await db.update(transactions).set({ status: 'approved', accountCode: '811', accountName: '복리후생비', reviewedBy: user.id, classificationSource: 'manual' }).where(eq(transactions.id, b!));
    const again = await classifyClientPeriod(sys, { clientId: cl.id, period: '2026-09', reclassifyNeedsReview: true, aiProvider: null });
    expect(again.total).toBe(1);
    const [ra] = await db.select().from(transactions).where(eq(transactions.id, a!));
    const [rb] = await db.select().from(transactions).where(eq(transactions.id, b!));
    expect(rb!.accountCode).toBe('811');
    expect(rb!.status).toBe('approved');
    // 사람이 같은 상대방을 811 로 확정 → 이력 1건(name_history)으로 다시 판단
    expect(ra!.accountCode).toBe('811');
    expect(ra!.classificationSource).toBe('name_history');
  });
});

describe('classify_batch job fan-out', () => {
  it('processes all clients of the period sequentially and reports per-client outcomes', async () => {
    // 격리를 위해 2027-01 기간 사용
    const auto = await createTestClient(db, { name: '가나다자동', industry: 'construction' });
    const review = await createTestClient(db, { name: '라마바검토', industry: 'construction' });
    await createTestClient(db, { name: '자료없음' });
    await insertTxs(db, hist(auto.id, 5, { date: '2026-11-10' }));
    await insertTxs(db, [
      { clientId: auto.id, date: '2027-01-05', merchantName: '쿠팡(주)', merchantBusinessNumber: COUPANG_BIZNO, totalAmount: 33000 },
      { clientId: auto.id, date: '2027-01-06', merchantName: '쿠팡(주)', merchantBusinessNumber: COUPANG_BIZNO, totalAmount: 44000 },
      { clientId: review.id, date: '2027-01-07', merchantName: '처음보는곳', totalAmount: 12000 },
    ]);
    const manager = testContext(db, (await createTestUser(db, 'manager')).actor);
    const jobId = await startBatchClassification(manager, { period: '2027-01' });
    const job = (await getJob(db, jobId))!;
    expect(job.payload).toEqual({ period: '2027-01', all: true });
    const progress: Array<[number, number]> = [];
    const out = await runClassifyBatchJob({ ctx: sys, job, progress: async (p, t) => void progress.push([p, t]) });
    const result = out.result as unknown as ClassifyBatchJobResult;
    expect(out.status).toBe('succeeded');
    expect(result.clients).toBe(2);
    expect(result.autoCompleted).toBe(1);
    expect(result.needsReview).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.summary).toBe('2027년 1월 카드매입 자동처리 전체 거래처 2곳 → 1곳 자동처리 / 1곳 검토필요');
    expect(result.perClient.map((c) => [c.clientName, c.status])).toEqual([
      ['가나다자동', 'auto_completed'],
      ['라마바검토', 'needs_review'],
    ]);
    expect(progress.at(-1)).toEqual([2, 2]);
    const results = await db.select().from(classificationResults).where(eq(classificationResults.batchJobId, jobId));
    expect(results).toHaveLength(3);
    const fan = await db.select().from(auditLogs).where(eq(auditLogs.action, 'classification.batch_all'));
    expect(fan.at(-1)!.summary).toBe(result.summary);

    // 거래 id 로만 온 후속 작업 (가져오기 호환) + 존재하지 않는 거래처는 부분 실패로 보고
    const [tid] = await insertTxs(db, [{ clientId: review.id, date: '2027-02-01', merchantName: '처음보는곳', totalAmount: 1000 }]);
    const partial = await runClassifyBatchJob({
      ctx: sys,
      job: { ...job, id: jobId, payload: { period: '2027-02', clientIds: [review.id, '00000000-0000-4000-8000-000000000000'] } },
      progress: async () => undefined,
    });
    expect(partial.status).toBe('partial');
    const pr = partial.result as unknown as ClassifyBatchJobResult;
    expect(pr.failed).toBe(1);
    expect(pr.perClient.find((c) => c.status === 'failed')!.error!.message).toMatch(/거래처/);
    const byTx = await runClassifyBatchJob({ ctx: sys, job: { ...job, payload: { transactionIds: [tid!] } }, progress: async () => undefined });
    expect((byTx.result as unknown as ClassifyBatchJobResult).periods).toEqual(['2027-02']);
    await expect(startBatchClassification(manager, { period: '2027-01', clientIds: ['00000000-0000-4000-8000-000000000000'] })).rejects.toThrow(/존재하지 않는 거래처/);
  });
});
