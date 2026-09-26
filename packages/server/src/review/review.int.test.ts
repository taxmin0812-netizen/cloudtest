import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_TEST_DB, TEST_KEYS, lockReviewTestDatabase, riskFlag, seedTransactions, type ReviewSeed } from './test-fixtures';

process.env.MINTAX_DATA_KEY ??= TEST_KEYS.MINTAX_DATA_KEY;
process.env.MINTAX_INDEX_KEY ??= TEST_KEYS.MINTAX_INDEX_KEY;

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  auditLogs,
  classificationCorrections,
  closeDb,
  exportJobs,
  files,
  importJobs,
  mappingRules,
  notifications,
  setupTestDatabase,
  transactionSources,
  transactions,
  type Database,
} from '@mintax/db';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '@mintax/security';
import { createTestClient, createTestUser, testContext } from '../testing/factory';
import type { ServiceContext } from '../context';
import {
  applyCorrectionToSimilar,
  approveTransactions,
  correctTransaction,
  correctTransactions,
  excludeTransactions,
  getExceptionCounts,
  getLearningSummary,
  getNextException,
  getTransactionDetail,
  listExceptions,
  listQuickReviewGroups,
  previewApproval,
  revertAudit,
  type ExceptionRow,
  type ExceptionSort,
} from './index';

const PERIOD = '2026-09';
const COUPANG = '1208800767';

let db: Database;
let unlock: (() => Promise<void>) | null = null;
let staff: ServiceContext;
let manager: ServiceContext;
let viewer: ServiceContext;
let staffId: string;

async function expectAppError<T extends AppError>(p: Promise<unknown>, cls: new (...a: never[]) => T, re?: RegExp): Promise<T> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(cls);
    if (re) expect((e as AppError).userMessage).toMatch(re);
    return e as T;
  }
  throw new Error('expected rejection');
}

async function txRow(id: string) {
  const [r] = await db.select().from(transactions).where(eq(transactions.id, id));
  return r!;
}

async function auditFor(id: string) {
  return db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'transaction'), eq(auditLogs.entityId, id)));
}

async function newClient(name: string) {
  return createTestClient(db, { name, industry: 'ecommerce' });
}

function seed(clientId: string, p: Partial<ReviewSeed> & { merchantName: string; total: number }): ReviewSeed {
  return { clientId, date: `${PERIOD}-12`, ...p };
}

beforeAll(async () => {
  unlock = await lockReviewTestDatabase();
  db = await setupTestDatabase(REVIEW_TEST_DB);
  const s = await createTestUser(db, 'staff', '김세무');
  const m = await createTestUser(db, 'manager', '박팀장');
  const v = await createTestUser(db, 'viewer', '이조회');
  staffId = s.id;
  staff = testContext(db, s.actor);
  manager = testContext(db, m.actor);
  viewer = testContext(db, v.actor);
});

afterAll(async () => {
  await unlock?.();
  await closeDb();
});

// ═══════════════════════════════ 목록 · 필터 · 페이지 ═══════════════════════════════

describe('listExceptions / getExceptionCounts', () => {
  let clientA: { id: string; name: string };
  let clientB: { id: string; name: string };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    clientA = await newClient('상록건설');
    clientB = await newClient('한빛상사');
    const seeds: Array<[string, ReviewSeed]> = [
      ['coupang', seed(clientA.id, { merchantName: '쿠팡', bizno: COUPANG, total: 72_300, confidence: 88, description: '로켓배송' })],
      ['hanbit', seed(clientA.id, { merchantName: '(주)한빛철물', total: 1_320_000, confidence: 61, evidenceType: 'tax_invoice', buckets: ['new_merchant', 'low_confidence'], riskFlags: [riskFlag('new_merchant', { severity: 'warning' })] })],
      ['samsung', seed(clientA.id, { merchantName: '삼성전자서비스', total: 6_600_000, confidence: 81, date: `${PERIOD}-14`, buckets: ['high_amount', 'possible_asset'], riskFlags: [riskFlag('high_amount', { severity: 'high' }), riskFlag('possible_asset')] })],
      ['naver', seed(clientA.id, { merchantName: '네이버페이', total: 38_000, confidence: 0, accountCode: null, source: 'none', deductible: null, date: `${PERIOD}-15`, buckets: ['unclassified', 'vat_review'] })],
      ['gs', seed(clientB.id, { merchantName: 'GS칼텍스 역삼', total: 82_000, confidence: 74, accountCode: '822', accountName: '차량유지비', date: `${PERIOD}-03`, buckets: ['vehicle'], riskFlags: [riskFlag('vehicle')] })],
      ['sales', seed(clientB.id, { merchantName: '고객사A', total: 500_000, confidence: 85, direction: 'sales', accountCode: '401', accountName: '상품매출', date: `${PERIOD}-20` })],
      // 예외함에 올라오지 않는 것
      ['auto', seed(clientA.id, { merchantName: 'KT', total: 55_000, confidence: 99, status: 'auto_approved', reviewLevel: 'auto' })],
      ['approved', seed(clientA.id, { merchantName: '스타벅스', total: 9_000, status: 'approved' })],
      ['otherPeriod', seed(clientA.id, { merchantName: '쿠팡', bizno: COUPANG, total: 10_000, date: '2026-08-10' })],
      // 전송오류 버킷은 승인 상태여도 올라온다
      ['exportErr', seed(clientB.id, { merchantName: '다이소', total: 12_000, status: 'approved', confidence: 97, buckets: ['export_error'] })],
    ];
    const got = await seedTransactions(db, seeds.map((s) => s[1]));
    seeds.forEach(([k], i) => (ids[k] = got[i]!));
  });

  it('returns only needs_review + export_error rows for the period, most risky first', async () => {
    const r = await listExceptions(staff, { period: PERIOD, clientId: null });
    const mine = r.rows.filter((x) => x.clientId === clientA.id || x.clientId === clientB.id);
    expect(new Set(mine.map((x) => x.id))).toEqual(new Set([ids.coupang, ids.hanbit, ids.samsung, ids.naver, ids.gs, ids.sales, ids.exportErr]));
    // 기본 정렬: 위험 심각도 → 신뢰도 오름차순
    expect(mine[0]!.id).toBe(ids.samsung);
    const row = mine.find((x) => x.id === ids.coupang)!;
    expect(row).toMatchObject({
      clientName: '상록건설',
      merchantName: '쿠팡',
      merchantBusinessNumber: COUPANG,
      totalAmount: 72_300,
      accountCode: '830',
      accountName: '소모품비',
      confidence: 88,
      reviewLevel: 'quick_review',
      status: 'needs_review',
      summary: '쿠팡 과거 처리 기준',
    });
    expect(row.alternatives.map((a) => a.accountCode)).toEqual(['829', '811', '146']);
    const samsung = mine.find((x) => x.id === ids.samsung)!;
    expect(samsung.riskFlags[0]!.severity).toBe('high');
    expect(r.total).toBeGreaterThanOrEqual(7);
    // JSON 직렬화 가능
    expect(JSON.parse(JSON.stringify(r)).rows.length).toBe(r.rows.length);
  });

  it('filters by client, buckets (any-of), review level, direction, search', async () => {
    const byClient = await listExceptions(staff, { period: PERIOD, clientId: clientB.id });
    expect(byClient.rows.map((x) => x.id).sort()).toEqual([ids.gs, ids.sales, ids.exportErr].sort());

    const b = await listExceptions(staff, { period: PERIOD, clientId: clientA.id, buckets: ['possible_asset', 'unclassified'] });
    expect(b.rows.map((x) => x.id).sort()).toEqual([ids.samsung, ids.naver].sort());

    const quick = await listExceptions(staff, { period: PERIOD, clientId: clientA.id, reviewLevel: 'quick_review' });
    expect(quick.rows.map((x) => x.id).sort()).toEqual([ids.coupang, ids.samsung].sort());

    const sales = await listExceptions(staff, { period: PERIOD, clientId: clientB.id, direction: 'sales' });
    expect(sales.rows.map((x) => x.id)).toEqual([ids.sales]);

    const s1 = await listExceptions(staff, { period: PERIOD, search: '로켓' });
    expect(s1.rows.map((x) => x.id)).toContain(ids.coupang);
    const s2 = await listExceptions(staff, { period: PERIOD, search: '1,320,000' });
    expect(s2.rows.map((x) => x.id)).toEqual([ids.hanbit]);
    const s3 = await listExceptions(staff, { period: PERIOD, search: '120-88' });
    expect(s3.rows.map((x) => x.id)).toEqual([ids.coupang]);
    const s4 = await listExceptions(staff, { period: PERIOD, search: '상록' });
    expect(s4.rows.every((x) => x.clientId === clientA.id)).toBe(true);

    const exp = await listExceptions(staff, { period: PERIOD, buckets: ['export_error'] });
    expect(exp.rows.map((x) => x.id)).toContain(ids.exportErr);
  });

  it('validates input with Korean messages', async () => {
    await expectAppError(listExceptions(staff, { period: '2026-9' }), ValidationError, /2026-09/);
    await expectAppError(listExceptions(staff, { period: PERIOD, limit: 5000 }), ValidationError, /1000/);
    await expectAppError(listExceptions(staff, { period: PERIOD, buckets: ['nope' as never] }), ValidationError, /버킷/);
    await expectAppError(listExceptions(staff, { period: PERIOD, sort: 'date', cursor: 'abc' }), ValidationError, /처음부터/);
    await expectAppError(listExceptions({ ...staff, actor: { ...staff.actor, permissions: new Set() } }, { period: PERIOD }), ForbiddenError);
  });

  it('keyset pagination is complete and stable for every sort', async () => {
    const full = await listExceptions(staff, { period: PERIOD, limit: 1000 });
    for (const sort of ['risk', 'date', 'amount', 'confidence', 'client'] as ExceptionSort[]) {
      const all = await listExceptions(staff, { period: PERIOD, sort, limit: 1000 });
      const seen: ExceptionRow[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof listExceptions>> = await listExceptions(staff, { period: PERIOD, sort, limit: 2, cursor });
        seen.push(...page.rows);
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 100);
      expect(seen.map((x) => x.id)).toEqual(all.rows.map((x) => x.id));
      expect(new Set(seen.map((x) => x.id)).size).toBe(full.total);
    }
    const byAmount = await listExceptions(staff, { period: PERIOD, sort: 'amount', limit: 1000 });
    const amounts = byAmount.rows.map((x) => x.totalAmount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });

  it('pagination does not skip or duplicate rows when earlier rows are processed between pages', async () => {
    const c = await newClient('페이지테스트');
    const got = await seedTransactions(
      db,
      Array.from({ length: 9 }, (_, i) => seed(c.id, { merchantName: `가맹점${i}`, total: 10_000 + i * 1000, date: `${PERIOD}-0${i + 1}` })),
    );
    const p1 = await listExceptions(staff, { period: PERIOD, clientId: c.id, sort: 'date', limit: 4 });
    expect(p1.rows.map((x) => x.id)).toEqual(got.slice(0, 4));
    await approveTransactions(staff, { ids: p1.rows.slice(0, 2).map((x) => x.id) });
    const p2 = await listExceptions(staff, { period: PERIOD, clientId: c.id, sort: 'date', limit: 4, cursor: p1.nextCursor });
    expect(p2.rows.map((x) => x.id)).toEqual(got.slice(4, 8));
    const p3 = await listExceptions(staff, { period: PERIOD, clientId: c.id, sort: 'date', limit: 4, cursor: p2.nextCursor });
    expect(p3.rows.map((x) => x.id)).toEqual(got.slice(8));
    expect(p3.nextCursor).toBeNull();
  });

  it('counts per bucket, review level and client', async () => {
    const c = await getExceptionCounts(staff, { period: PERIOD, clientId: clientA.id });
    expect(c.total).toBe(4);
    expect(c.needsReview).toBe(4);
    expect(c.byBucket.low_confidence).toBe(1);
    expect(c.byBucket.possible_asset).toBe(1);
    expect(c.amountByBucket.high_amount).toBe(6_600_000);
    expect(c.byReviewLevel).toMatchObject({ quick_review: 2, must_review: 2, auto: 0 });
    expect(c.byClient).toEqual([
      expect.objectContaining({ clientId: clientA.id, clientName: '상록건설', count: 4, amount: 72_300 + 1_320_000 + 6_600_000 + 38_000, quickReview: 2, mustReview: 2 }),
    ]);
    expect(c.bucketChips[0]!.count).toBeGreaterThanOrEqual(1);
    const cb = await getExceptionCounts(staff, { period: PERIOD, clientId: clientB.id });
    expect(cb.exportErrors).toBe(1);
    expect(cb.total).toBe(3);
  });

  it('getNextException follows the list order and wraps around', async () => {
    const list = await listExceptions(staff, { period: PERIOD, clientId: clientA.id, sort: 'date' });
    const [first, second] = list.rows;
    const n = await getNextException(staff, { currentId: first!.id, filters: { period: PERIOD, clientId: clientA.id, sort: 'date' } });
    expect(n.next!.id).toBe(second!.id);
    expect(n.remaining).toBe(list.total - 1);
    const last = list.rows[list.rows.length - 1]!;
    const w = await getNextException(staff, { currentId: last.id, filters: { period: PERIOD, clientId: clientA.id, sort: 'date' } });
    expect(w.wrapped).toBe(true);
    expect(w.next!.id).toBe(first!.id);
  });
});

// ═══════════════════════════════ 승인 ═══════════════════════════════

describe('approveTransactions', () => {
  it('bulk approves eligible rows, skips the rest with reasons, audits per tx + batch', async () => {
    const c = await newClient('승인테스트');
    const [a, b, noAcct, excluded, vatPending] = await seedTransactions(db, [
      seed(c.id, { merchantName: '쿠팡', total: 72_300 }),
      seed(c.id, { merchantName: '오피스디포', total: 15_000, status: 'auto_approved' }),
      seed(c.id, { merchantName: '미분류상점', total: 5_000, accountCode: null, source: 'none' }),
      seed(c.id, { merchantName: '제외상점', total: 7_000, status: 'excluded' }),
      seed(c.id, { merchantName: '부가세미정', total: 8_000, deductible: null }),
    ]);
    const res = await approveTransactions(staff, { ids: [a!, b!, noAcct!, excluded!, vatPending!], note: '월말 검토' });
    expect(res.approved).toBe(2);
    expect(res.approvedIds.sort()).toEqual([a!, b!].sort());
    expect(res.skipped.map((s) => s.id).sort()).toEqual([noAcct!, excluded!, vatPending!].sort());
    expect(res.skipped.find((s) => s.id === noAcct)!.reason).toMatch(/계정과목/);
    expect(res.skipped.find((s) => s.id === vatPending)!.reason).toMatch(/공제/);

    const ta = await txRow(a!);
    expect(ta.status).toBe('approved');
    expect(ta.reviewedBy).toBe(staffId);
    expect(ta.touchCount).toBe(1);
    expect((await txRow(noAcct!)).touchCount).toBe(0);

    const logs = await auditFor(a!);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('transaction.approve');
    expect(logs[0]!.revertible).toBe(true);
    expect(logs[0]!.summary).toBe('쿠팡 72,300원 소모품비 승인 — 월말 검토');
    expect(logs[0]!.beforeData).toMatchObject({ status: 'needs_review', reviewedBy: null });
    expect(logs[0]!.afterData).toMatchObject({ status: 'approved', reviewedBy: staffId, batchId: res.auditLogId });
    const [batch] = await db.select().from(auditLogs).where(eq(auditLogs.id, res.auditLogId!));
    expect(batch!.action).toBe('transaction.approve_bulk');
    expect(batch!.summary).toBe('2건 일괄 승인 (승인테스트) — 월말 검토');

    // 두 번째 승인은 건너뜀 (동시 처리 안전)
    const again = await approveTransactions(staff, { ids: [a!] });
    expect(again.approved).toBe(0);
    expect(again.skipped[0]!.reason).toMatch(/이미 승인/);
  });

  it('preview + excludeBlockingRisks keeps risky rows for individual review', async () => {
    const c = await newClient('사전점검');
    const [ok, big, asset] = await seedTransactions(db, [
      seed(c.id, { merchantName: '문구점', total: 20_000 }),
      seed(c.id, { merchantName: '대형매입', total: 9_000_000, riskFlags: [riskFlag('high_amount')], buckets: ['high_amount'] }),
      seed(c.id, { merchantName: '노트북', total: 2_000_000, riskFlags: [riskFlag('possible_asset')], buckets: ['possible_asset'] }),
    ]);
    const p = await previewApproval(staff, { ids: [ok!, big!, asset!] });
    expect(p.approvable.ids).toEqual([ok!]);
    expect(p.blockedByRisk).toHaveLength(2);
    expect(p.message).toMatch(/선택 3건 중 1건을 승인합니다\. 2건은 자동확정 차단 위험\(.*고액 1.*\)이 있어 제외했습니다\./);
    const r = await approveTransactions(staff, { ids: [ok!, big!, asset!], excludeBlockingRisks: true });
    expect(r.approvedIds).toEqual([ok!]);
    expect((await txRow(big!)).status).toBe('needs_review');
  });

  it('viewer cannot approve', async () => {
    await expectAppError(approveTransactions(viewer, { ids: ['11111111-1111-4111-8111-111111111111'] }), ForbiddenError, /권한/);
  });
});

// ═══════════════════════════════ 수정 · 학습 ═══════════════════════════════

describe('correctTransaction + learning loop', () => {
  it('records a correction (before incl. source/confidence) and audits "쿠팡 72,300원 소모품비 → 상품"', async () => {
    const c = await newClient('수정테스트');
    const [id] = await seedTransactions(db, [seed(c.id, { merchantName: '쿠팡', bizno: COUPANG, total: 72_300, confidence: 88 })]);
    const r = await correctTransaction(staff, { id: id!, accountCode: '146', reason: '재판매 상품' });
    expect(r.changed).toBe(true);
    expect(r.transaction).toMatchObject({ status: 'approved', accountCode: '146', accountName: '상품', classificationSource: 'manual', accountConfidence: 100 });
    expect(r.ruleSuggestion).toBeNull();
    const t = await txRow(id!);
    expect(t.touchCount).toBe(1);
    expect(t.reviewedBy).toBe(staffId);
    expect(t.classificationSummary).toBe('담당자 수정: 소모품비 → 상품');
    const corr = await db.select().from(classificationCorrections).where(eq(classificationCorrections.transactionId, id!));
    expect(corr).toHaveLength(1);
    expect(corr[0]).toMatchObject({
      field: 'account',
      beforeValue: '830',
      beforeLabel: '소모품비',
      afterValue: '146',
      afterLabel: '상품',
      beforeSource: 'name_history',
      beforeConfidence: 88,
      reason: '재판매 상품',
      userId: staffId,
      merchantBusinessNumber: COUPANG,
    });
    const [log] = await auditFor(id!);
    expect(log!.action).toBe('transaction.correct');
    expect(log!.summary).toBe('쿠팡 72,300원 소모품비 → 상품 — 재판매 상품');
    expect(log!.revertible).toBe(true);
    expect(log!.afterData).toMatchObject({ accountCode: '146', correctionIds: [corr[0]!.id] });
    expect(r.auditLogId).toBe(log!.id);
  });

  it('re-evaluates VAT when only the account changes (접대비 → 불공제)', async () => {
    const c = await newClient('접대비테스트');
    const [id] = await seedTransactions(db, [seed(c.id, { merchantName: '한우명가', total: 330_000, accountCode: '811', accountName: '복리후생비' })]);
    const r = await correctTransaction(staff, { id: id!, accountCode: '813' });
    expect(r.transaction.deductible).toBe(false);
    expect(r.transaction.vatType).toBe('purchase_no_evidence');
    expect(r.vatReevaluated).toMatchObject({ before: '카드과세매입 · 공제', after: '일반전표(부가세 무관) · 불공제' });
    const t = await txRow(id!);
    expect(t.vatReasonCode).toBe('VAT-ENT-01');
    // 엔진이 바꾼 부가세는 사람의 수정 기록이 아니다 (계정 1건만)
    const corr = await db.select().from(classificationCorrections).where(eq(classificationCorrections.transactionId, id!));
    expect(corr.map((x) => x.field)).toEqual(['account']);
  });

  it('explicit VAT correction is recorded as a vat correction; unchanged correction = approve', async () => {
    const c = await newClient('부가세수정');
    const [id, id2] = await seedTransactions(db, [
      seed(c.id, { merchantName: '주유소', total: 88_000, accountCode: '822', accountName: '차량유지비' }),
      seed(c.id, { merchantName: '문구점', total: 11_000 }),
    ]);
    const r = await correctTransaction(staff, { id: id!, vatDeductible: false, reason: '비영업용 승용차' });
    expect(r.transaction).toMatchObject({ deductible: false, vatType: 'purchase_no_evidence', status: 'approved', accountCode: '822' });
    const [corr] = await db.select().from(classificationCorrections).where(eq(classificationCorrections.transactionId, id!));
    expect(corr).toMatchObject({ field: 'vat', beforeValue: 'purchase_card:deductible', afterValue: 'purchase_no_evidence:non_deductible' });
    expect((await auditFor(id!))[0]!.summary).toBe('주유소 88,000원 부가세 공제 → 불공제 — 비영업용 승용차');

    const same = await correctTransaction(staff, { id: id2!, accountCode: '830' });
    expect(same.changed).toBe(false);
    expect(same.transaction.status).toBe('approved');
    expect((await auditFor(id2!))[0]!.action).toBe('transaction.approve');

    await expectAppError(correctTransaction(staff, { id: id2!, accountCode: '999' }), ValidationError, /찾을 수 없습니다/);
    await expectAppError(correctTransaction(staff, { id: id2!, accountCode: '401' }), ValidationError, /매입 거래에 매출 계정/);
    await expectAppError(correctTransaction(staff, { id: id2! }), ValidationError, /선택하세요/);
  });

  it('3 identical corrections → exactly one suggested rule (never auto-activated), corrections linked', async () => {
    const c = await newClient('학습테스트');
    const got = await seedTransactions(
      db,
      [1, 2, 3, 4, 5].map((d) => seed(c.id, { merchantName: '쿠팡', bizno: COUPANG, total: 10_000 * d, date: `${PERIOD}-0${d}`, confidence: 88 })),
    );
    const r1 = await correctTransaction(staff, { id: got[0]!, accountCode: '146' });
    const r2 = await correctTransaction(staff, { id: got[1]!, accountCode: '146' });
    expect(r1.ruleSuggestion).toBeNull();
    expect(r2.ruleSuggestion).toBeNull();
    const r3 = await correctTransaction(staff, { id: got[2]!, accountCode: '146' });
    expect(r3.ruleSuggestion).not.toBeNull();
    expect(r3.ruleSuggestion!.message).toBe("동일 수정 3회 — '쿠팡 → 상품'을 영구 규칙으로 등록하시겠습니까?");
    const r4 = await correctTransaction(staff, { id: got[3]!, accountCode: '146' });
    expect(r4.ruleSuggestion).toBeNull();

    const rules = await db.select().from(mappingRules).where(eq(mappingRules.clientId, c.id));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id: r3.ruleSuggestion!.id,
      status: 'suggested',
      origin: 'system_suggested',
      accountCode: '146',
      accountName: '상품',
      suggestionReason: '동일 수정 3회: 소모품비 → 상품',
    });
    expect(rules[0]!.condition).toEqual({
      all: [
        { field: 'direction', op: 'eq', value: 'purchase' },
        { field: 'merchantBusinessNumber', op: 'eq', value: COUPANG },
      ],
    });
    const linked = await db
      .select()
      .from(classificationCorrections)
      .where(and(eq(classificationCorrections.clientId, c.id), eq(classificationCorrections.suggestedRuleId, r3.ruleSuggestion!.id)));
    expect(linked).toHaveLength(3);
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'rule.suggest'), eq(auditLogs.entityId, r3.ruleSuggestion!.id)));
    expect(audit!.actorName).toBe('MIN TAX OPS 시스템');
    const notes = await db.select().from(notifications).where(eq(notifications.dedupeKey, `rule_suggested:${r3.ruleSuggestion!.id}`));
    expect(notes).toHaveLength(1);

    // 같은 가맹점 미검토 1건 남음
    expect(r4.similarPending).toMatchObject({ count: 1, message: '같은 가맹점 미검토 1건에도 적용할까요?' });

    const summary = await getLearningSummary(staff, { period: PERIOD, userId: staffId });
    expect(summary.correctedTransactions).toBeGreaterThanOrEqual(4);
    expect(summary.rulesSuggested).toBeGreaterThanOrEqual(1);
    expect(summary.rulesPending).toBeGreaterThanOrEqual(1);
    expect(summary.message).toMatch(/^수정한 \d+건을 다음 처리에 학습했습니다/);
  });

  it('a rejected suggestion is not suggested again', async () => {
    const c = await newClient('거절테스트');
    const got = await seedTransactions(db, [1, 2, 3, 4].map((d) => seed(c.id, { merchantName: '이마트', bizno: '1048137225', total: 5_000 * d, date: `${PERIOD}-0${d}` })));
    for (const id of got.slice(0, 3)) await correctTransaction(staff, { id, accountCode: '146' });
    await db.update(mappingRules).set({ status: 'rejected' }).where(eq(mappingRules.clientId, c.id));
    const r = await correctTransaction(staff, { id: got[3]!, accountCode: '146' });
    expect(r.ruleSuggestion).toBeNull();
    expect(await db.select().from(mappingRules).where(eq(mappingRules.clientId, c.id))).toHaveLength(1);
  });
});

describe('applyCorrectionToSimilar / correctTransactions (bulk counts as one learning event)', () => {
  it('applies the corrected account to other pending rows of the same merchant, skipping risky ones', async () => {
    const c = await newClient('일괄적용');
    const got = await seedTransactions(db, [
      seed(c.id, { merchantName: '다이소 역삼점', bizno: '2118139925', total: 3_000, date: `${PERIOD}-01` }),
      seed(c.id, { merchantName: '다이소 역삼점', bizno: '2118139925', total: 4_000, date: `${PERIOD}-02` }),
      seed(c.id, { merchantName: '다이소 역삼점', bizno: '2118139925', total: 5_000, date: `${PERIOD}-03`, buckets: ['low_confidence', 'new_merchant'], riskFlags: [riskFlag('new_merchant')] }),
      seed(c.id, { merchantName: '다이소 역삼점', bizno: '2118139925', total: 3_000_000, date: `${PERIOD}-04`, buckets: ['high_amount'], riskFlags: [riskFlag('high_amount')] }),
      seed(c.id, { merchantName: '다이소 역삼점', bizno: '2118139925', total: 6_000, date: '2026-08-20' }),
      seed(c.id, { merchantName: '다이소 역삼점', bizno: '2118139925', total: 7_000, date: `${PERIOD}-05`, status: 'approved' }),
    ]);
    const first = await correctTransaction(staff, { id: got[0]!, accountCode: '829' });
    expect(first.similarPending).toMatchObject({ count: 2, message: '같은 가맹점 미검토 2건에도 적용할까요? (1건은 고액 등 위험이 있어 개별 검토)' });

    const r = await applyCorrectionToSimilar(staff, { transactionId: got[0]!, scope: 'period' });
    expect(r.count).toBe(2);
    expect(r.updatedIds.sort()).toEqual([got[1]!, got[2]!].sort());
    expect(r.skipped).toEqual([{ id: got[3]!, reason: '고액 위험이 있어 개별 검토가 필요합니다.' }]);
    expect(r.ruleSuggestion).toBeNull(); // 단건 1 + 묶음 1 = 2회 < 3
    for (const id of [got[1]!, got[2]!]) {
      const t = await txRow(id);
      expect(t).toMatchObject({ status: 'approved', accountCode: '829', accountName: '사무용품비', classificationSource: 'manual', touchCount: 1 });
      expect(t.classificationSummary).toBe('같은 가맹점 일괄 수정: 소모품비 → 사무용품비');
    }
    expect((await txRow(got[3]!)).status).toBe('needs_review');
    expect((await txRow(got[4]!)).accountCode).toBe('830'); // 다른 기간은 period 범위 밖
    const corr = await db.select().from(classificationCorrections).where(inArray(classificationCorrections.transactionId, [got[1]!, got[2]!]));
    expect(corr).toHaveLength(2);
    expect(corr.every((x) => x.reason?.startsWith(`bulk:${r.auditLogId}`))).toBe(true);
    const [batch] = await db.select().from(auditLogs).where(eq(auditLogs.id, r.auditLogId!));
    expect(batch!.summary).toBe('같은 가맹점 2건 일괄 수정: 다이소 역삼점 → 사무용품비 (일괄적용)');

    // all_pending 은 다른 기간 미검토도 포함
    const all = await applyCorrectionToSimilar(staff, { transactionId: got[0]!, scope: 'all_pending' });
    expect(all.updatedIds).toEqual([got[4]!]);

    // 수정되지 않은 거래는 기준이 될 수 없다
    await expectAppError(applyCorrectionToSimilar(staff, { transactionId: got[3]! }), ValidationError, /수정\(M\)/);
  });

  it('a bulk group correction of many rows counts as ONE correction toward the rule threshold', async () => {
    const c = await newClient('묶음학습');
    const got = await seedTransactions(db, Array.from({ length: 8 }, (_, i) => seed(c.id, { merchantName: '카카오T', bizno: '1208147521', total: 10_000 + i, date: `${PERIOD}-${String(i + 1).padStart(2, '0')}`, confidence: 86 })));
    const bulk = await correctTransactions(staff, { ids: got.slice(0, 6), accountCode: '812' });
    expect(bulk.count).toBe(6);
    expect(bulk.ruleSuggestion).toBeNull();
    const one = await correctTransaction(staff, { id: got[6]!, accountCode: '812' });
    expect(one.ruleSuggestion).toBeNull(); // 묶음 1 + 단건 1 = 2
    const two = await correctTransaction(staff, { id: got[7]!, accountCode: '812' });
    expect(two.ruleSuggestion!.message).toBe("동일 수정 3회 — '카카오T → 여비교통비'을 영구 규칙으로 등록하시겠습니까?");
  });
});

// ═══════════════════════════════ 제외 ═══════════════════════════════

describe('excludeTransactions', () => {
  it('excludes (never deletes) with a reason, audits, and drops the row from the inbox', async () => {
    const c = await newClient('제외테스트');
    const [id, dup] = await seedTransactions(db, [
      seed(c.id, { merchantName: '넷플릭스', total: 17_000 }),
      seed(c.id, { merchantName: '중복', total: 1_000, status: 'duplicate' }),
    ]);
    await expectAppError(excludeTransactions(staff, { ids: [id!], reason: '  ' }), ValidationError, /제외 사유/);
    const r = await excludeTransactions(staff, { ids: [id!, dup!], reason: '개인 사용' });
    expect(r.excluded).toBe(1);
    expect(r.skipped[0]).toMatchObject({ id: dup, reason: expect.stringMatching(/중복/) });
    const t = await txRow(id!);
    expect(t).toMatchObject({ status: 'excluded', excludedReason: '개인 사용', touchCount: 1 });
    expect((await auditFor(id!))[0]!.summary).toBe('넷플릭스 17,000원 제외 — 개인 사용');
    const list = await listExceptions(staff, { period: PERIOD, clientId: c.id });
    expect(list.rows).toHaveLength(0);
    await expectAppError(correctTransaction(staff, { id: id!, accountCode: '146' }), AppError, /제외/);
  });
});

// ═══════════════════════════════ 되돌리기 ═══════════════════════════════

describe('revertAudit', () => {
  it('reverts an approve: status/reviewer restored, touch +1, audit linked both ways; second revert refused', async () => {
    const c = await newClient('되돌리기승인');
    const [id] = await seedTransactions(db, [seed(c.id, { merchantName: '쿠팡', total: 72_300 })]);
    const a = await approveTransactions(staff, { ids: [id!] });
    await expectAppError(revertAudit(staff, a.auditLogId!), ForbiddenError); // staff 는 되돌리기 권한 없음
    const r = await revertAudit(manager, a.auditLogId!);
    expect(r.reverted).toBe(1);
    const t = await txRow(id!);
    expect(t).toMatchObject({ status: 'needs_review', reviewedBy: null, reviewedAt: null, touchCount: 2 });
    const [orig] = await db.select().from(auditLogs).where(eq(auditLogs.id, a.auditLogId!));
    expect(orig!.revertedById).toBe(r.revertAuditLogId);
    const [rev] = await db.select().from(auditLogs).where(eq(auditLogs.id, r.revertAuditLogId));
    expect(rev).toMatchObject({ action: 'transaction.revert', revertOfId: a.auditLogId, revertible: false, summary: '되돌림: 쿠팡 72,300원 소모품비 승인' });
    await expectAppError(revertAudit(manager, a.auditLogId!), ConflictError, /이미 되돌린/);
  });

  it('reverts a correction: account restored and its learning record removed (kept in the revert audit)', async () => {
    const c = await newClient('되돌리기수정');
    const [id] = await seedTransactions(db, [seed(c.id, { merchantName: '쿠팡', total: 72_300, confidence: 88 })]);
    const cr = await correctTransaction(staff, { id: id!, accountCode: '146' });
    const r = await revertAudit(manager, cr.auditLogId!);
    expect(r.revertedTransactionIds).toEqual([id!]);
    const t = await txRow(id!);
    expect(t).toMatchObject({ status: 'needs_review', accountCode: '830', accountName: '소모품비', classificationSource: 'name_history', accountConfidence: 88 });
    expect(await db.select().from(classificationCorrections).where(eq(classificationCorrections.transactionId, id!))).toHaveLength(0);
    const [rev] = await db.select().from(auditLogs).where(eq(auditLogs.id, r.revertAuditLogId));
    expect((rev!.beforeData as { deletedCorrections: Array<{ after_value: string }> }).deletedCorrections[0]!.after_value).toBe('146');
    expect(rev!.summary).toBe('되돌림: 쿠팡 72,300원 소모품비 → 상품');
  });

  it('refuses when the transaction changed after the audited action', async () => {
    const c = await newClient('되돌리기충돌');
    const [id] = await seedTransactions(db, [seed(c.id, { merchantName: '쿠팡', total: 72_300 })]);
    const a = await approveTransactions(staff, { ids: [id!] });
    await correctTransaction(staff, { id: id!, accountCode: '146' });
    await expectAppError(revertAudit(manager, a.auditLogId!), ConflictError, /가장 최근 변경부터/);
  });

  it('reverts a bulk approve and a bulk exclude through the batch log', async () => {
    const c = await newClient('묶음되돌리기');
    const got = await seedTransactions(db, [1, 2, 3].map((d) => seed(c.id, { merchantName: `상점${d}`, total: d * 1000 })));
    const a = await approveTransactions(staff, { ids: got });
    const r = await revertAudit(manager, a.auditLogId!);
    expect(r.reverted).toBe(3);
    for (const id of got) expect((await txRow(id)).status).toBe('needs_review');
    const children = await db.select().from(auditLogs).where(and(inArray(auditLogs.entityId, got), eq(auditLogs.action, 'transaction.approve')));
    expect(children.every((ch) => ch.revertedById !== null)).toBe(true);
    const revs = await db.select().from(auditLogs).where(and(inArray(auditLogs.entityId, got), eq(auditLogs.action, 'transaction.revert')));
    expect(revs).toHaveLength(3);

    const e = await excludeTransactions(staff, { ids: got, reason: '사업 무관' });
    const re = await revertAudit(manager, e.auditLogId!);
    expect(re.reverted).toBe(3);
    const t = await txRow(got[0]!);
    expect(t).toMatchObject({ status: 'needs_review', excludedReason: null });
  });

  it('refuses to revert a transaction already downloaded as a WEHAGO file, and explains why', async () => {
    const c = await newClient('전송후되돌리기');
    const [id] = await seedTransactions(db, [seed(c.id, { merchantName: '쿠팡', total: 72_300 })]);
    const a = await approveTransactions(staff, { ids: [id!] });
    const [job] = await db
      .insert(exportJobs)
      .values({ clientId: c.id, period: PERIOD, kind: 'wehago_purchase_sales', templateKey: 't', templateVersion: '1', status: 'downloaded' })
      .returning({ id: exportJobs.id });
    await db.update(transactions).set({ status: 'exported', exportJobId: job!.id }).where(eq(transactions.id, id!));
    const err = await expectAppError(revertAudit(manager, a.auditLogId!), AppError, /이미 WEHAGO용 파일로 받은 거래/);
    expect(err.code).toBe('ALREADY_EXPORTED');
    expect(err.httpStatus).toBe(409);
    expect(err.action).toMatchObject({ label: '정정 전송' });
    expect((await txRow(id!)).status).toBe('exported');
    await expectAppError(correctTransaction(staff, { id: id!, accountCode: '146' }), AppError, /WEHAGO/);
  });

  it('correcting a transaction in a not-yet-downloaded (ready) export blocks that file and notifies', async () => {
    const c = await newClient('ready차단');
    const [id] = await seedTransactions(db, [seed(c.id, { merchantName: '쿠팡', total: 72_300, status: 'exported' })]);
    const [job] = await db
      .insert(exportJobs)
      .values({ clientId: c.id, period: PERIOD, kind: 'wehago_purchase_sales', templateKey: 't', templateVersion: '1', status: 'ready' })
      .returning({ id: exportJobs.id });
    await db.update(transactions).set({ exportJobId: job!.id }).where(eq(transactions.id, id!));
    const r = await correctTransaction(staff, { id: id!, accountCode: '146' });
    expect(r.transaction.status).toBe('approved');
    const [j] = await db.select().from(exportJobs).where(eq(exportJobs.id, job!.id));
    expect(j).toMatchObject({ status: 'blocked', blockedReason: '포함 거래가 변경되었습니다. 파일을 다시 만드세요' });
    expect((await txRow(id!)).exportJobId).toBeNull();
    const n = await db.select().from(notifications).where(eq(notifications.dedupeKey, `export_blocked:${job!.id}`));
    expect(n).toHaveLength(1);
    const blockAudit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'export.block'), eq(auditLogs.entityId, job!.id)));
    expect(blockAudit).toHaveLength(1);
  });

  it('approving an auto-approved row that sits in a ready export keeps the file (content unchanged)', async () => {
    const c = await newClient('ready유지');
    const [id] = await seedTransactions(db, [seed(c.id, { merchantName: '쿠팡', total: 72_300, status: 'auto_approved', confidence: 97 })]);
    const [job] = await db
      .insert(exportJobs)
      .values({ clientId: c.id, period: PERIOD, kind: 'wehago_purchase_sales', templateKey: 't', templateVersion: '1', status: 'ready' })
      .returning({ id: exportJobs.id });
    await db.update(transactions).set({ exportJobId: job!.id }).where(eq(transactions.id, id!));
    const r = await approveTransactions(staff, { ids: [id!] });
    expect(r.approved).toBe(1);
    expect((await txRow(id!)).exportJobId).toBe(job!.id);
    const [j] = await db.select().from(exportJobs).where(eq(exportJobs.id, job!.id));
    expect(j!.status).toBe('ready');
    // 그 승인을 되돌리면 상태가 바뀌므로 파일을 차단하고 거래를 파일에서 푼다
    await revertAudit(manager, r.auditLogId!);
    const [j2] = await db.select().from(exportJobs).where(eq(exportJobs.id, job!.id));
    expect(j2!.status).toBe('blocked');
    expect(await txRow(id!)).toMatchObject({ status: 'auto_approved', exportJobId: null, touchCount: 2 });
  });

  it('refuses unsupported / non-revertible logs', async () => {
    const [row] = await db
      .insert(auditLogs)
      .values({ actorName: 'x', action: 'settings.update', category: 'data_change', entityType: 'setting', summary: '설정', revertible: true })
      .returning({ id: auditLogs.id });
    const e = await expectAppError(revertAudit(manager, row!.id), AppError, /해당 화면/);
    expect(e.code).toBe('REVERT_UNSUPPORTED');
    await expectAppError(revertAudit(manager, 'bad-id'), ValidationError);
  });
});

// ═══════════════════════════════ 상세 · 빠른 검토 ═══════════════════════════════

describe('getTransactionDetail', () => {
  it('returns full explainability with scrubbed source row and audit trail', async () => {
    const c = await newClient('상세테스트');
    const past = await seedTransactions(
      db,
      [1, 2, 3].map((d) => seed(c.id, { merchantName: '쿠팡', bizno: COUPANG, total: 60_000 + d, date: `2026-0${5 + d}-10`, status: 'approved' })),
    );
    const [id] = await seedTransactions(db, [
      seed(c.id, {
        merchantName: '쿠팡',
        bizno: COUPANG,
        total: 72_300,
        confidence: 88,
        rawData: { 가맹점명: '쿠팡', 카드번호: '1234567812345678', 주민번호: '9001011234567' },
        riskFlags: [riskFlag('account_conflict', { message: '다른 후보와 신뢰도 차이가 작습니다' })],
      }),
    ]);
    const [job] = await db.insert(importJobs).values({ clientId: c.id, channel: 'manual_upload', source: 'business_card', period: PERIOD, formatProfile: 'hometax_card_purchase_v1' }).returning({ id: importJobs.id });
    await db.insert(transactionSources).values({ importJobId: job!.id, rowNumber: 7, rawData: { 가맹점명: '쿠팡', 카드번호: '1234-5678-1234-5678', 주민등록번호: '900101-1234567' }, outcome: 'ok', transactionId: id! });
    await db.insert(files).values({ storageKey: 'k', originalName: 'card.xlsx', sizeBytes: 1, sha256: 'x', purpose: 'import_source' }).returning({ id: files.id });
    await correctTransaction(staff, { id: past[0]!, accountCode: '146' });

    const d = await getTransactionDetail(staff, id!);
    expect(d.transaction).toMatchObject({ merchantName: '쿠팡', totalAmount: 72_300, cardLast4: '5678', statusLabel: '검토 필요' });
    expect(d.classification.current).toMatchObject({ accountCode: '830', sourceLabel: '동일 상호 과거 처리' });
    expect(d.classification.engine!.account.alternatives.length).toBeGreaterThan(0);
    expect(d.classification.overriddenByHuman).toBe(false);
    expect(d.vatRules[0]).toMatchObject({ code: 'VAT-DEF-CARD-GEN', legalBasis: '부가가치세법 제46조③' });
    expect(d.riskFlags[0]!.message).toBe('다른 후보와 신뢰도 차이가 작습니다');
    expect(d.merchantHistory.map((h) => h.id)).toEqual([...past].reverse());
    expect(d.merchantHistory.find((h) => h.id === past[0])!.corrected).toBe(true);
    expect(d.corrections).toHaveLength(1);
    expect(d.corrections[0]).toMatchObject({ after: '146', afterLabel: '상품', userName: '김세무', bulk: false });
    expect(d.sourceRow).toMatchObject({ rowNumber: 7, formatProfile: 'hometax_card_purchase_v1' });
    expect(d.sourceRow!.rawData['카드번호']).toBe('1234-****-****-5678');
    expect(d.sourceRow!.rawData['주민등록번호']).toBe('***');
    expect(JSON.stringify(d)).not.toContain('1234567');
    expect(d.similarPending).toBe(0);

    await correctTransaction(staff, { id: id!, accountCode: '829' });
    const d2 = await getTransactionDetail(manager, id!);
    expect(d2.classification.overriddenByHuman).toBe(true);
    expect(d2.auditTrail[0]).toMatchObject({ action: 'transaction.correct', actorName: '김세무', canRevert: true });
    const d3 = await getTransactionDetail(staff, id!);
    expect(d3.auditTrail[0]!.canRevert).toBe(false); // staff 는 되돌리기 권한 없음
  });

  it('lists applicable rules including suggestions', async () => {
    const c = await newClient('규칙상세');
    await db.insert(mappingRules).values({
      clientId: c.id,
      name: '쿠팡 → 상품',
      condition: { field: 'merchantBusinessNumber', op: 'eq', value: COUPANG },
      accountCode: '146',
      accountName: '상품',
      status: 'suggested',
      origin: 'system_suggested',
      suggestionReason: '동일 수정 3회',
    });
    const [id] = await seedTransactions(db, [seed(c.id, { merchantName: '쿠팡', bizno: COUPANG, total: 1000 })]);
    const d = await getTransactionDetail(staff, id!);
    expect(d.applicableRules).toEqual([expect.objectContaining({ name: '쿠팡 → 상품', status: 'suggested', scope: 'client', usedByEngine: false })]);
  });

  it('404 in Korean for unknown ids', async () => {
    await expectAppError(getTransactionDetail(staff, '11111111-1111-4111-8111-111111111111'), AppError, /찾을 수 없습니다/);
  });
});

describe('listQuickReviewGroups', () => {
  it('groups quick_review rows by client+merchant+account+VAT and separates outliers', async () => {
    const c = await newClient('빠른검토');
    const got = await seedTransactions(db, [
      ...[1, 2, 3, 4].map((d) => seed(c.id, { merchantName: '스타벅스', total: 5_000, date: `${PERIOD}-0${d}`, confidence: 91, accountCode: '811', accountName: '복리후생비' })),
      seed(c.id, { merchantName: '스타벅스', total: 90_000, date: `${PERIOD}-05`, confidence: 91, accountCode: '811', accountName: '복리후생비' }),
      seed(c.id, { merchantName: '스타벅스', total: 5_500, date: `${PERIOD}-06`, confidence: 90, accountCode: '811', accountName: '복리후생비', riskFlags: [riskFlag('entertainment')] }),
      seed(c.id, { merchantName: '카카오T', total: 12_000, date: `${PERIOD}-07`, confidence: 86, accountCode: '812', accountName: '여비교통비' }),
      seed(c.id, { merchantName: '카카오T', total: 13_000, date: `${PERIOD}-08`, confidence: 60 }), // must_review → 제외
    ]);
    const r = await listQuickReviewGroups(staff, { period: PERIOD, clientId: c.id });
    expect(r.totalTransactions).toBe(7);
    expect(r.groups).toHaveLength(2);
    const sb = r.groups[0]!;
    expect(sb).toMatchObject({ merchantName: '스타벅스', accountCode: '811', count: 6, minConfidence: 90 });
    expect(sb.approvableIds.sort()).toEqual(got.slice(0, 4).sort());
    expect(sb.outliers.map((o) => o.id).sort()).toEqual([got[4]!, got[5]!].sort());
    expect(sb.outliers.find((o) => o.id === got[4])!.reason).toMatch(/3배/);
    const approve = await approveTransactions(staff, { ids: sb.approvableIds });
    expect(approve.approved).toBe(4);
  });
});

describe('processed today view', () => {
  it('shows rows a human processed today (for undo), not pending ones', async () => {
    const c = await newClient('오늘처리');
    const [a, b] = await seedTransactions(db, [seed(c.id, { merchantName: 'A상점', total: 1000 }), seed(c.id, { merchantName: 'B상점', total: 2000 })]);
    await approveTransactions(staff, { ids: [a!] });
    const r = await listExceptions(staff, { period: PERIOD, clientId: c.id, view: 'processed_today' });
    expect(r.rows.map((x) => x.id)).toEqual([a!]);
    const counts = await getExceptionCounts(staff, { period: PERIOD, clientId: c.id });
    expect(counts.processedToday).toBe(1);
    expect(counts.total).toBe(1);
    expect(b).toBeDefined();
    const withReviewer = await db.select({ n: sql<number>`count(*)::int` }).from(transactions).where(and(eq(transactions.clientId, c.id), isNotNull(transactions.reviewedBy)));
    expect(withReviewer[0]!.n).toBe(1);
  });
});
