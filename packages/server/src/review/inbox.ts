/**
 * 예외 검토 목록 (Grid) · 필터 칩 건수 · 다음 예외 · 빠른 검토 묶음.
 *
 * - 목록은 keyset 페이지네이션 (정렬 키 + id). 50k 행 기간에서도 1,000행 < 300ms (review.perf.int.test.ts).
 * - 예외함 = status 'needs_review' + export_error 버킷(승인·자동확정·전송 상태). 자동확정 거래는 올리지 않는다.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Direction, ExceptionBucket, ReviewLevel } from '@mintax/core';
import { ValidationError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { getSetting } from '../infra/settings';
import {
  ALL_BUCKETS,
  BUCKET_LABELS,
  EXPORT_ERROR_STATUSES,
  REVIEW_LEVELS,
  assertBuckets,
  assertLimit,
  assertPeriod,
  assertReviewLevels,
  assertSort,
  assertUuid,
  decodeCursor,
  encodeCursor,
  kstStartOfDay,
  parseSearch,
  type CursorValue,
  type ExceptionSort,
  type ParsedSearch,
} from './helpers';
import {
  EXCEPTION_ROW_COLUMNS,
  LATEST_ALTERNATIVES_JOIN,
  mapExceptionRow,
  textArray,
  type RawExceptionRow,
} from './shared';
import type {
  ExceptionCounts,
  ExceptionFilters,
  ExceptionRow,
  ListExceptionsInput,
  ListExceptionsResult,
  NextExceptionInput,
  NextExceptionResult,
  QuickReviewGroup,
  QuickReviewResult,
} from './types';

// ────────────────────────────── 필터 ──────────────────────────────

interface NormalizedFilters {
  period: string;
  clientId: string | null;
  buckets: ExceptionBucket[] | null;
  reviewLevels: ReviewLevel[] | null;
  search: ParsedSearch | null;
  evidenceTypes: string[] | null;
  direction: Direction | null;
  confidenceMin: number | null;
  confidenceMax: number | null;
  view: 'pending' | 'processed_today';
}

function optInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new ValidationError('신뢰도 범위는 0~100 사이 정수로 입력하세요.', [{ field, message: '0~100' }]);
  return n;
}

export function normalizeFilters(f: ExceptionFilters): NormalizedFilters {
  if (!f || typeof f !== 'object') throw new ValidationError('조회 조건이 비어 있습니다.', [{ field: 'filters', message: '필수' }]);
  const evidenceTypes = f.evidenceTypes == null ? null : Array.isArray(f.evidenceTypes) ? f.evidenceTypes.filter((x) => typeof x === 'string' && x !== '').slice(0, 20) : null;
  if (f.direction != null && f.direction !== 'purchase' && f.direction !== 'sales') {
    throw new ValidationError('매입/매출 필터 값이 올바르지 않습니다.', [{ field: 'direction', message: 'purchase | sales' }]);
  }
  if (f.view != null && f.view !== 'pending' && f.view !== 'processed_today') {
    throw new ValidationError('보기 조건이 올바르지 않습니다. (pending / processed_today)', [{ field: 'view', message: '알 수 없는 값' }]);
  }
  return {
    period: assertPeriod(f.period),
    clientId: f.clientId ? assertUuid(f.clientId, 'clientId', '수임처') : null,
    buckets: assertBuckets(f.buckets),
    reviewLevels: assertReviewLevels(f.reviewLevel),
    search: parseSearch(f.search),
    evidenceTypes: evidenceTypes && evidenceTypes.length > 0 ? evidenceTypes : null,
    direction: f.direction ?? null,
    confidenceMin: optInt(f.confidenceMin, 'confidenceMin'),
    confidenceMax: optInt(f.confidenceMax, 'confidenceMax'),
    view: f.view ?? 'pending',
  };
}

/** 예외함 기본 조건: 검토 필요 + 전송오류 버킷 */
export const INBOX_PREDICATE = sql`(t.status = 'needs_review' or (t.buckets @> '["export_error"]'::jsonb and t.status = any(${textArray(EXPORT_ERROR_STATUSES)})))`;

function whereOf(f: NormalizedFilters, now: Date): SQL {
  const conds: SQL[] = [sql`t.period = ${f.period}`];
  if (f.view === 'processed_today') {
    conds.push(sql`t.reviewed_by is not null and t.reviewed_at >= ${kstStartOfDay(now).toISOString()}::timestamptz`);
  } else {
    conds.push(INBOX_PREDICATE);
  }
  if (f.clientId) conds.push(sql`t.client_id = ${f.clientId}::uuid`);
  if (f.buckets) conds.push(sql`t.buckets ?| ${textArray(f.buckets)}`);
  if (f.reviewLevels) conds.push(sql`t.review_level = any(${textArray(f.reviewLevels)})`);
  if (f.evidenceTypes) conds.push(sql`t.evidence_type = any(${textArray(f.evidenceTypes)})`);
  if (f.direction) conds.push(sql`t.direction = ${f.direction}`);
  if (f.confidenceMin !== null) conds.push(sql`coalesce(t.confidence_score, 0) >= ${f.confidenceMin}::int`);
  if (f.confidenceMax !== null) conds.push(sql`coalesce(t.confidence_score, 0) <= ${f.confidenceMax}::int`);
  if (f.search) {
    const s = f.search;
    const ors: SQL[] = [
      sql`t.merchant_name ilike ${s.like}`,
      sql`t.description ilike ${s.like}`,
      sql`t.account_name ilike ${s.like}`,
      sql`c.name ilike ${s.like}`,
    ];
    if (s.digits) ors.push(sql`t.merchant_business_number like ${`${s.digits}%`}`);
    if (s.amount !== null) ors.push(sql`t.total_amount = ${s.amount}::bigint`, sql`t.supply_amount = ${s.amount}::bigint`);
    conds.push(sql`(${sql.join(ors, sql` or `)})`);
  }
  return sql.join(conds, sql` and `);
}

// ────────────────────────────── 정렬 키 ──────────────────────────────

type KeyCast = 'int' | 'bigint' | 'date' | 'text' | 'uuid';
interface SortKey {
  expr: SQL;
  dir: 'asc' | 'desc';
  cast: KeyCast;
}

const RISK_RANK = sql`(case when t.risk_flags @> '[{"severity":"high"}]'::jsonb then 2 when t.risk_flags @> '[{"severity":"warning"}]'::jsonb then 1 else 0 end)`;
const CONFIDENCE = sql`coalesce(t.confidence_score, -1)`;
const ID_KEY: SortKey = { expr: sql`t.id`, dir: 'asc', cast: 'uuid' };

const SORT_KEYS: Record<ExceptionSort, SortKey[]> = {
  // 기본: 가장 위험한 것 먼저 (위험 심각도 → 신뢰도 오름차순 → 금액 내림차순) — docs/05 §5.2.2
  risk: [
    { expr: RISK_RANK, dir: 'desc', cast: 'int' },
    { expr: CONFIDENCE, dir: 'asc', cast: 'int' },
    { expr: sql`t.total_amount`, dir: 'desc', cast: 'bigint' },
    ID_KEY,
  ],
  date: [{ expr: sql`t.transaction_date`, dir: 'asc', cast: 'date' }, ID_KEY],
  amount: [{ expr: sql`t.total_amount`, dir: 'desc', cast: 'bigint' }, ID_KEY],
  confidence: [
    { expr: CONFIDENCE, dir: 'asc', cast: 'int' },
    { expr: sql`t.total_amount`, dir: 'desc', cast: 'bigint' },
    ID_KEY,
  ],
  client: [
    { expr: sql`c.name`, dir: 'asc', cast: 'text' },
    { expr: sql`t.transaction_date`, dir: 'asc', cast: 'date' },
    ID_KEY,
  ],
};

function castValue(v: CursorValue, cast: KeyCast): SQL {
  switch (cast) {
    case 'int':
      return sql`${Number(v)}::int`;
    case 'bigint':
      return sql`${Number(v)}::bigint`;
    case 'date':
      return sql`${String(v)}::date`;
    case 'uuid':
      return sql`${String(v)}::uuid`;
    default:
      return sql`${String(v)}::text`;
  }
}

/** (k1,k2,…,id) 가 커서보다 "뒤"인 행 — 열마다 방향이 달라 OR 전개형으로 쓴다 */
function keysetAfter(keys: SortKey[], values: CursorValue[]): SQL {
  const ors: SQL[] = [];
  for (let i = 0; i < keys.length; i++) {
    const ands: SQL[] = [];
    for (let j = 0; j < i; j++) ands.push(sql`${keys[j]!.expr} = ${castValue(values[j]!, keys[j]!.cast)}`);
    ands.push(sql`${keys[i]!.expr} ${keys[i]!.dir === 'asc' ? sql`>` : sql`<`} ${castValue(values[i]!, keys[i]!.cast)}`);
    ors.push(sql`(${sql.join(ands, sql` and `)})`);
  }
  return sql`(${sql.join(ors, sql` or `)})`;
}

function orderByOf(keys: SortKey[], prefix = ''): SQL {
  return sql.join(
    keys.map((k, i) => sql`${sql.raw(prefix ? `${prefix}.k${i}` : `k${i}`)} ${sql.raw(k.dir)}`),
    sql`, `,
  );
}

function keyColumns(keys: SortKey[]): SQL {
  return sql.join(
    keys.map((k, i) => sql`${k.expr} as ${sql.raw(`k${i}`)}`),
    sql`, `,
  );
}

type PageRow = RawExceptionRow & Record<`k${number}`, CursorValue>;

async function fetchPage(
  ctx: ServiceContext,
  f: NormalizedFilters,
  sort: ExceptionSort,
  after: CursorValue[] | null,
  limit: number,
  excludeId: string | null,
): Promise<{ rows: ExceptionRow[]; last: CursorValue[] | null; hasMore: boolean }> {
  const keys = SORT_KEYS[sort];
  const conds: SQL[] = [whereOf(f, ctx.now())];
  if (after) conds.push(keysetAfter(keys, after));
  if (excludeId) conds.push(sql`t.id <> ${excludeId}::uuid`);
  const r = await ctx.db.execute<PageRow>(sql`
    with page as (
      select ${EXCEPTION_ROW_COLUMNS}, ${keyColumns(keys)}
      from transactions t
      join clients c on c.id = t.client_id
      where ${sql.join(conds, sql` and `)}
      order by ${orderByOf(keys)}
      limit ${limit + 1}
    )
    select page.*, cr.alternatives
    from page
    ${LATEST_ALTERNATIVES_JOIN(sql`page.id`)}
    order by ${orderByOf(keys, 'page')}
  `);
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const lastRow = rows[rows.length - 1];
  const last = lastRow ? keys.map((_, i) => (lastRow as Record<string, CursorValue>)[`k${i}`]!) : null;
  return { rows: rows.map(mapExceptionRow), last, hasMore };
}

async function countFiltered(ctx: ServiceContext, f: NormalizedFilters, excludeId: string | null = null): Promise<{ total: number; amount: number }> {
  const ex = excludeId ? sql` and t.id <> ${excludeId}::uuid` : sql``;
  const r = await ctx.db.execute<{ n: number; amount: number }>(sql`
    select count(*)::int as n, coalesce(sum(t.total_amount), 0)::bigint as amount
    from transactions t join clients c on c.id = t.client_id
    where ${whereOf(f, ctx.now())}${ex}
  `);
  return { total: r.rows[0]?.n ?? 0, amount: r.rows[0]?.amount ?? 0 };
}

// ────────────────────────────── 서비스 ──────────────────────────────

/**
 * 예외함 목록 (keyset 페이지). rows 는 status needs_review (+ export_error 버킷) 거래만.
 * nextCursor 를 다음 호출의 cursor 로 넘기면 같은 정렬로 이어서 읽는다 (중간에 처리된 행이 빠져도 중복·누락 없음).
 */
export async function listExceptions(ctx: ServiceContext, input: ListExceptionsInput): Promise<ListExceptionsResult> {
  requirePermission(ctx, 'transactions.read');
  const f = normalizeFilters(input);
  const sort = assertSort(input.sort);
  const limit = assertLimit(input.limit);
  const after = decodeCursor(input.cursor, sort, SORT_KEYS[sort].length);
  const [page, count] = await Promise.all([fetchPage(ctx, f, sort, after, limit, null), countFiltered(ctx, f)]);
  return {
    rows: page.rows,
    nextCursor: page.hasMore && page.last ? encodeCursor({ s: sort, k: page.last }) : null,
    total: count.total,
    totalAmount: count.amount,
  };
}

/**
 * "승인하고 다음" — 현재 거래 다음 순서의 예외 1건. 현재 거래가 방금 처리돼 목록에서 빠졌어도 그 정렬 위치 다음을 준다.
 * 끝까지 가면 처음으로 돌아간다 (wrapped=true).
 */
export async function getNextException(ctx: ServiceContext, input: NextExceptionInput): Promise<NextExceptionResult> {
  requirePermission(ctx, 'transactions.read');
  const currentId = assertUuid(input?.currentId, 'currentId');
  const f = normalizeFilters(input.filters);
  const sort = assertSort(input.filters?.sort);
  const keys = SORT_KEYS[sort];
  const cur = await ctx.db.execute<Record<string, CursorValue>>(sql`
    select ${keyColumns(keys)} from transactions t join clients c on c.id = t.client_id where t.id = ${currentId}::uuid
  `);
  const kv = cur.rows[0];
  const values = kv ? keys.map((_, i) => kv[`k${i}`]!) : null;
  const [page, count] = await Promise.all([
    values ? fetchPage(ctx, f, sort, values, 1, currentId) : Promise.resolve({ rows: [] as ExceptionRow[], last: null, hasMore: false }),
    countFiltered(ctx, f, currentId),
  ]);
  if (page.rows[0]) return { next: page.rows[0], remaining: count.total, wrapped: false };
  if (count.total === 0) return { next: null, remaining: 0, wrapped: false };
  const first = await fetchPage(ctx, f, sort, null, 1, currentId);
  return { next: first.rows[0] ?? null, remaining: count.total, wrapped: !!first.rows[0] && values !== null };
}

/** 필터 칩·대시보드용 건수: 버킷별(건수·금액) · 검토수준별 · 수임처별 · 오늘 처리 */
export async function getExceptionCounts(ctx: ServiceContext, input: { period: string; clientId?: string | null }): Promise<ExceptionCounts> {
  requirePermission(ctx, 'transactions.read');
  const period = assertPeriod(input?.period);
  const clientId = input?.clientId ? assertUuid(input.clientId, 'clientId', '수임처') : null;
  const clientCond = clientId ? sql` and t.client_id = ${clientId}::uuid` : sql``;
  const base = sql`t.period = ${period}${clientCond} and ${INBOX_PREDICATE}`;
  const todayIso = kstStartOfDay(ctx.now()).toISOString();

  const [bucketR, levelR, clientR, todayR] = await Promise.all([
    ctx.db.execute<{ bucket: string; n: number; amount: number }>(sql`
      select b.bucket, count(*)::int as n, coalesce(sum(t.total_amount), 0)::bigint as amount
      from transactions t cross join lateral jsonb_array_elements_text(t.buckets) as b(bucket)
      where ${base}
      group by b.bucket
    `),
    ctx.db.execute<{ level: string | null; n: number }>(sql`
      select t.review_level as level, count(*)::int as n from transactions t
      where ${base} and t.status = 'needs_review' group by t.review_level
    `),
    ctx.db.execute<{ client_id: string; client_name: string; n: number; amount: number; must: number; quick: number; export_errors: number }>(sql`
      select t.client_id, c.name as client_name, count(*)::int as n, coalesce(sum(t.total_amount), 0)::bigint as amount,
             (count(*) filter (where t.status = 'needs_review' and coalesce(t.review_level, 'must_review') = 'must_review'))::int as must,
             (count(*) filter (where t.status = 'needs_review' and t.review_level = 'quick_review'))::int as quick,
             (count(*) filter (where t.buckets @> '["export_error"]'::jsonb))::int as export_errors
      from transactions t join clients c on c.id = t.client_id
      where ${base}
      group by t.client_id, c.name
      order by n desc, c.name asc
    `),
    ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from transactions t
      where t.period = ${period}${clientCond} and t.reviewed_by is not null and t.reviewed_at >= ${todayIso}::timestamptz
    `),
  ]);

  const byBucket = {} as Record<ExceptionBucket, number>;
  const amountByBucket = {} as Record<ExceptionBucket, number>;
  for (const b of ALL_BUCKETS) {
    byBucket[b] = 0;
    amountByBucket[b] = 0;
  }
  for (const row of bucketR.rows) {
    if (!(ALL_BUCKETS as readonly string[]).includes(row.bucket)) continue;
    byBucket[row.bucket as ExceptionBucket] = row.n;
    amountByBucket[row.bucket as ExceptionBucket] = row.amount;
  }
  const byReviewLevel = {} as Record<ReviewLevel, number>;
  for (const l of REVIEW_LEVELS) byReviewLevel[l] = 0;
  for (const row of levelR.rows) {
    const l = (row.level ?? 'must_review') as ReviewLevel;
    if (l in byReviewLevel) byReviewLevel[l] += row.n;
  }
  const byClient = clientR.rows.map((r) => ({
    clientId: r.client_id,
    clientName: r.client_name,
    count: r.n,
    amount: r.amount,
    mustReview: r.must,
    quickReview: r.quick,
    exportErrors: r.export_errors,
  }));
  const total = byClient.reduce((s, c) => s + c.count, 0);
  const totalAmount = byClient.reduce((s, c) => s + c.amount, 0);
  const exportErrors = byClient.reduce((s, c) => s + c.exportErrors, 0);
  const needsReview = Object.values(byReviewLevel).reduce((s, n) => s + n, 0);
  return {
    period,
    clientId,
    total,
    totalAmount,
    needsReview,
    exportErrors,
    processedToday: todayR.rows[0]?.n ?? 0,
    byBucket,
    amountByBucket,
    bucketChips: ALL_BUCKETS.filter((b) => byBucket[b] > 0)
      .map((b) => ({ bucket: b, label: BUCKET_LABELS[b], count: byBucket[b], amount: amountByBucket[b] }))
      .sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket)),
    byReviewLevel,
    byClient,
  };
}

// ────────────────────────────── 빠른 검토 ──────────────────────────────

export const QUICK_REVIEW_OUTLIER_SETTING = 'quick_review_outlier_ratio';
const DEFAULT_OUTLIER_RATIO = 3;

/**
 * 빠른 검토 (quick_review, 신뢰도 80~94) 묶음: 수임처 + 상호키 + 추천 계정 + 부가세 판단.
 * 이상치(묶음의 다른 거래 평균 × 배수 이상 금액, 또는 경고 이상 위험 플래그)는 묶음 승인 대상에서 뺀다 (docs/05 §5.3).
 * 묶음 승인 = approveTransactions(approvableIds), 묶음 계정 변경 = correctTransactions(ids) — 학습에는 1회로 센다.
 */
export async function listQuickReviewGroups(
  ctx: ServiceContext,
  input: { period: string; clientId?: string | null; limit?: number },
): Promise<QuickReviewResult> {
  requirePermission(ctx, 'transactions.read');
  const period = assertPeriod(input?.period);
  const clientId = input?.clientId ? assertUuid(input.clientId, 'clientId', '수임처') : null;
  const limit = input?.limit === undefined ? 500 : assertLimit(input.limit);
  const ratioSetting = Number(await getSetting<number>(ctx, QUICK_REVIEW_OUTLIER_SETTING, DEFAULT_OUTLIER_RATIO));
  const ratio = Number.isFinite(ratioSetting) && ratioSetting > 1 ? ratioSetting : DEFAULT_OUTLIER_RATIO;
  const clientCond = clientId ? sql` and t.client_id = ${clientId}::uuid` : sql``;

  const r = await ctx.db.execute<{
    id: string;
    client_id: string;
    client_name: string;
    merchant_key: string;
    merchant_name: string;
    account_code: string | null;
    account_name: string | null;
    vat_type: string | null;
    deductible: boolean | null;
    total_amount: number;
    confidence_score: number | null;
    classification_summary: string | null;
    transaction_date: string;
    description: string;
    risky: boolean;
    n: number;
    sum_abs: number;
  }>(sql`
    select t.id, t.client_id, c.name as client_name, t.merchant_key, t.merchant_name, t.account_code, t.account_name, t.vat_type,
           t.deductible, t.total_amount, t.confidence_score, t.classification_summary, t.transaction_date, t.description,
           (t.risk_flags @> '[{"severity":"high"}]'::jsonb or t.risk_flags @> '[{"severity":"warning"}]'::jsonb
             or t.risk_flags @> '[{"blocksAutoApproval":true}]'::jsonb) as risky,
           (count(*) over w)::int as n,
           (sum(abs(t.total_amount)) over w)::bigint as sum_abs
    from transactions t join clients c on c.id = t.client_id
    where t.period = ${period}${clientCond} and t.status = 'needs_review' and t.review_level = 'quick_review'
    window w as (partition by t.client_id, t.merchant_key, t.account_code, t.vat_type, t.deductible)
    order by t.client_id, t.merchant_key, t.transaction_date, t.id
  `);

  const groups = new Map<string, QuickReviewGroup & { _conf: number[]; _names: Map<string, number> }>();
  for (const row of r.rows) {
    const key = [row.client_id, row.merchant_key, row.account_code ?? '', row.vat_type ?? '', String(row.deductible)].join('|');
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        clientId: row.client_id,
        clientName: row.client_name,
        merchantKey: row.merchant_key,
        merchantName: row.merchant_name,
        accountCode: row.account_code,
        accountName: row.account_name,
        vatType: row.vat_type,
        deductible: row.deductible,
        count: 0,
        totalAmount: 0,
        minConfidence: null,
        avgConfidence: null,
        summary: row.classification_summary ?? '',
        approvableIds: [],
        approvableAmount: 0,
        outliers: [],
        items: [],
        _conf: [],
        _names: new Map(),
      };
      groups.set(key, g);
    }
    g.count += 1;
    g.totalAmount += row.total_amount;
    if (row.confidence_score !== null) g._conf.push(row.confidence_score);
    g._names.set(row.merchant_name, (g._names.get(row.merchant_name) ?? 0) + 1);
    // 이상치: 자신을 뺀 나머지 평균의 ratio 배 이상 (묶음 2건 이상일 때만) 또는 경고 이상 위험
    const others = row.n > 1 ? (row.sum_abs - Math.abs(row.total_amount)) / (row.n - 1) : null;
    const bigAmount = others !== null && others > 0 && Math.abs(row.total_amount) >= others * ratio;
    let reason: string | null = null;
    if (row.risky) reason = '위험 플래그가 있어 개별 검토가 필요합니다';
    else if (bigAmount) reason = `묶음 평균(${Math.round(others!).toLocaleString('ko-KR')}원)의 ${ratio}배 이상 금액`;
    if (reason) g.outliers.push({ id: row.id, date: row.transaction_date, totalAmount: row.total_amount, reason });
    else {
      g.approvableIds.push(row.id);
      g.approvableAmount += row.total_amount;
    }
    if (g.items.length < 50) g.items.push({ id: row.id, date: row.transaction_date, totalAmount: row.total_amount, description: row.description, outlier: !!reason });
  }

  const out: QuickReviewGroup[] = [...groups.values()]
    .map(({ _conf, _names, ...g }) => ({
      ...g,
      merchantName: [..._names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? g.merchantName,
      minConfidence: _conf.length > 0 ? Math.min(..._conf) : null,
      avgConfidence: _conf.length > 0 ? Math.round(_conf.reduce((s, n) => s + n, 0) / _conf.length) : null,
    }))
    .sort((a, b) => b.count - a.count || b.totalAmount - a.totalAmount || a.key.localeCompare(b.key));

  return {
    period,
    groups: out.slice(0, limit),
    totalTransactions: r.rows.length,
    totalGroups: out.length,
    outlierRatio: ratio,
  };
}
