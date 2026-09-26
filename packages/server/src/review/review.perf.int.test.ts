import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_TEST_DB, TEST_KEYS, lockReviewTestDatabase } from './test-fixtures';

process.env.MINTAX_DATA_KEY ??= TEST_KEYS.MINTAX_DATA_KEY;
process.env.MINTAX_INDEX_KEY ??= TEST_KEYS.MINTAX_INDEX_KEY;

import { sql } from 'drizzle-orm';
import { closeDb, setupTestDatabase, type Database } from '@mintax/db';
import { createTestClient, createTestUser, testContext } from '../testing/factory';
import type { ServiceContext } from '../context';
import { approveTransactions, getExceptionCounts, listExceptions, revertAudit } from './index';

/**
 * 성능: 50,000행 거래 테이블(분류 결과 50,000행 포함)에서 예외함 1,000행 페이지 < 300ms.
 * (웹 서버 컴포넌트가 요청 안에서 바로 부르는 경로 — 느리면 화면이 멈춘다)
 */
const ROWS = 50_000;
const PERIOD = '2026-09';

let db: Database;
let unlock: (() => Promise<void>) | null = null;
let staff: ServiceContext;
let manager: ServiceContext;
let clientIds: string[] = [];

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

beforeAll(async () => {
  unlock = await lockReviewTestDatabase();
  db = await setupTestDatabase(REVIEW_TEST_DB);
  staff = testContext(db, (await createTestUser(db, 'staff', '김세무')).actor);
  manager = testContext(db, (await createTestUser(db, 'manager', '박팀장')).actor);
  for (let i = 0; i < 10; i++) clientIds.push((await createTestClient(db, { name: `성능수임처${i}` })).id);

  // 50k: 2026-09 needs_review 40k · auto_approved 5k · 2026-08 5k
  await db.execute(sql`
    insert into transactions (client_id, business_number, source, channel, direction, period, transaction_date, evidence_type,
      merchant_name, merchant_key, merchant_business_number, description, supply_amount, vat_amount, total_amount, fingerprint,
      account_code, account_name, account_confidence, classification_source, classification_summary, vat_type, deductible,
      vat_confidence, confidence_score, review_level, buckets, risk_flags, status)
    select
      (${sql.param(clientIds)}::uuid[])[1 + (g % 10)], '1234567890', 'business_card', 'manual_upload', 'purchase',
      case when g <= 45000 then '2026-09' else '2026-08' end,
      case when g <= 45000 then date '2026-09-01' + (g % 30) else date '2026-08-01' + (g % 31) end,
      'card', '가맹점' || (g % 700), '가맹점' || (g % 700), null, '적요 ' || g,
      (1000 + (g * 37) % 900000), (100 + (g * 37) % 90000), (1100 + (g * 37) % 900000) + ((g * 37) % 90000),
      md5(g::text),
      '830', '소모품비', 40 + (g % 60), 'name_history', '가맹점' || (g % 700) || ' 과거 처리 ' || (g % 10) || '건 중 ' || (g % 9) || '건 소모품비',
      'purchase_card', true, 95, 40 + (g % 60),
      case when 40 + (g % 60) >= 80 then 'quick_review' else 'must_review' end,
      (case g % 4 when 0 then '["low_confidence"]' when 1 then '["new_merchant","low_confidence"]' when 2 then '["high_amount"]' else '[]' end)::jsonb,
      (case when g % 7 = 0 then '[{"ruleCode":"HIGH","ruleName":"고액","bucket":"high_amount","severity":"high","blocksAutoApproval":true,"message":"고액 거래"}]'
            when g % 7 = 1 then '[{"ruleCode":"NEW","ruleName":"신규","bucket":"new_merchant","severity":"warning","blocksAutoApproval":true,"message":"신규 거래처"}]'
            else '[]' end)::jsonb,
      case when g <= 40000 then 'needs_review' when g <= 45000 then 'auto_approved' else 'approved' end
    from generate_series(1, ${ROWS}) g
  `);
  await db.execute(sql`
    insert into classification_results (transaction_id, engine_version, account, vat, risks, review_level)
    select t.id, 'perf',
      jsonb_build_object('accountCode', '830', 'accountName', '소모품비', 'confidence', t.account_confidence, 'source', 'name_history',
        'summary', t.classification_summary, 'reasons', '[]'::jsonb, 'evidence', '{}'::jsonb,
        'alternatives', '[{"accountCode":"829","accountName":"사무용품비","confidence":60,"source":"name_history"},{"accountCode":"811","accountName":"복리후생비","confidence":41,"source":"ai"},{"accountCode":"146","accountName":"상품","confidence":30,"source":"industry_pattern"}]'::jsonb),
      '{"vatType":"purchase_card","deductible":true,"nonDeductibleReasonCode":null,"confidence":95,"summary":"공제","reasons":[],"ruleIds":[]}'::jsonb,
      '[]'::jsonb, t.review_level
    from transactions t
  `);
  await db.execute(sql`analyze transactions`);
  await db.execute(sql`analyze classification_results`);
}, 300_000);

afterAll(async () => {
  await unlock?.();
  await closeDb();
});

describe('review performance (50k transactions)', () => {
  it('listExceptions returns 1,000 rows in < 300ms (default risk sort, date sort, filtered, deep page)', async () => {
    const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from transactions`);
    expect(count.rows[0]?.n).toBe(ROWS);
    await listExceptions(staff, { period: PERIOD, limit: 1000 }); // 워밍업 (커넥션·플랜 캐시)

    const risk = await timed(() => listExceptions(staff, { period: PERIOD, limit: 1000 }));
    expect(risk.value.rows).toHaveLength(1000);
    expect(risk.value.total).toBe(40_000);
    expect(risk.value.rows[0]!.riskFlags[0]!.severity).toBe('high');
    expect(risk.value.rows[0]!.alternatives).toHaveLength(3);

    const date = await timed(() => listExceptions(staff, { period: PERIOD, sort: 'date', limit: 1000 }));
    // 깊은 페이지 (커서 20번째 페이지 근처) — keyset 이라 offset 비용 없음
    let cursor = date.value.nextCursor;
    for (let i = 0; i < 18 && cursor; i++) cursor = (await listExceptions(staff, { period: PERIOD, sort: 'date', limit: 1000, cursor })).nextCursor;
    const deep = await timed(() => listExceptions(staff, { period: PERIOD, sort: 'date', limit: 1000, cursor }));
    expect(deep.value.rows).toHaveLength(1000);

    const filtered = await timed(() =>
      listExceptions(staff, { period: PERIOD, clientId: clientIds[3]!, buckets: ['low_confidence'], sort: 'amount', limit: 1000 }),
    );
    expect(filtered.value.rows.length).toBeGreaterThan(0);
    const search = await timed(() => listExceptions(staff, { period: PERIOD, search: '가맹점12', sort: 'client', limit: 1000 }));
    expect(search.value.rows.length).toBeGreaterThan(0);

    console.log(
      `[review perf] 1000 rows: risk ${risk.ms.toFixed(0)}ms · date ${date.ms.toFixed(0)}ms · deep page ${deep.ms.toFixed(0)}ms · ` +
        `filtered ${filtered.ms.toFixed(0)}ms · search ${search.ms.toFixed(0)}ms`,
    );
    for (const t of [risk, date, deep, filtered, search]) expect(t.ms).toBeLessThan(300);
  });

  it('getExceptionCounts aggregates in SQL quickly', async () => {
    await getExceptionCounts(staff, { period: PERIOD });
    const c = await timed(() => getExceptionCounts(staff, { period: PERIOD }));
    expect(c.value.total).toBe(40_000);
    expect(c.value.byClient).toHaveLength(10);
    expect(c.value.byBucket.low_confidence).toBe(20_000);
    console.log(`[review perf] counts ${c.ms.toFixed(0)}ms`);
    expect(c.ms).toBeLessThan(500);
  });

  it('bulk approve of 4,000 rows (chunked writes + audit) and its batch revert finish in seconds', async () => {
    const page = await listExceptions(staff, { period: PERIOD, clientId: clientIds[0]!, sort: 'date', limit: 1000 });
    const ids = [...page.rows.map((r) => r.id)];
    let cursor = page.nextCursor;
    while (ids.length < 4000 && cursor) {
      const p = await listExceptions(staff, { period: PERIOD, clientId: clientIds[0]!, sort: 'date', limit: 1000, cursor });
      ids.push(...p.rows.map((r) => r.id));
      cursor = p.nextCursor;
    }
    const approve = await timed(() => approveTransactions(staff, { ids }));
    expect(approve.value.approved).toBe(ids.length);
    const revert = await timed(() => revertAudit(manager, approve.value.auditLogId!));
    expect(revert.value.reverted).toBe(ids.length);
    console.log(`[review perf] approve ${ids.length}: ${approve.ms.toFixed(0)}ms · batch revert: ${revert.ms.toFixed(0)}ms`);
    expect(approve.ms).toBeLessThan(10_000);
    expect(revert.ms).toBeLessThan(15_000);
  });
});
