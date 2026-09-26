/**
 * 알림 — 문제만 (docs/05 §7). 성공 알림은 없다.
 * - 목록·읽음·해결, 상단 종 배지 수 (미해결 = resolved_at is null, 읽음과 무관)
 * - 좌측 내비 배지: 처리할 일만 (0이면 화면에서 숨김)
 * 알림 가시성: user_id 가 null(전체) 이거나 본인.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { notifications } from '@mintax/db';
import { NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { getCurrentPeriod } from '../infra/settings';
import {
  FILING_DONE_STEPS,
  NOTIFICATION_KIND_LABELS,
  addDaysIso,
  assertPeriod,
  assertUuid,
  clampLimit,
  cleanText,
  decodeCursor,
  encodeCursor,
  invalidCursor,
  isUuid,
  iso,
  kstDateOf,
  num,
  optionalUuid,
  textArray,
} from './shared';

export interface ProblemDTO {
  id: string;
  kind: string;
  kindLabel: string;
  severity: 'info' | 'warning' | 'high';
  title: string;
  body: string | null;
  href: string | null;
  clientId: string | null;
  clientName: string | null;
  read: boolean;
  readAt: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

export interface NotificationCountsDTO {
  /** 종 배지 = 미해결 문제 수 (읽음과 무관) */
  unresolved: number;
  unread: number;
  high: number;
}

export interface NavBadgesDTO {
  period: string;
  inbox: number;
  transfer: number;
  payroll: number;
  filing: number;
  imports: number;
  review: number;
  rules: number;
}

function visibleTo(ctx: ServiceContext): SQL {
  const me = ctx.actor.userId;
  return me ? or(isNull(notifications.userId), eq(notifications.userId, me))! : isNull(notifications.userId);
}

/** 문제 알림 목록 — 미해결 먼저, 심각도·최신순. 커서 페이징 */
export async function listProblems(
  ctx: ServiceContext,
  input: { unreadOnly?: boolean; includeResolved?: boolean; clientId?: string | null; limit?: number; cursor?: string | null } = {},
): Promise<{ items: ProblemDTO[]; nextCursor: string | null; counts: NotificationCountsDTO }> {
  requirePermission(ctx, 'transactions.read');
  const limit = clampLimit(input.limit, 50, 200);
  const clientId = optionalUuid(input.clientId, 'clientId', '수임처');
  const me = ctx.actor.userId;
  const conds: SQL[] = [me ? sql`(n.user_id is null or n.user_id = ${me}::uuid)` : sql`n.user_id is null`];
  if (!input.includeResolved) conds.push(sql`n.resolved_at is null`);
  if (input.unreadOnly) conds.push(sql`n.read_at is null`);
  if (clientId) conds.push(sql`n.client_id = ${clientId}::uuid`);
  const rankExpr = sql`((case when n.resolved_at is null then 0 else 3 end) + (case n.severity when 'high' then 0 when 'warning' then 1 else 2 end))`;
  if (input.cursor) {
    const c = decodeCursor(input.cursor);
    if (!c || typeof c.r !== 'number' || typeof c.t !== 'string' || !isUuid(c.id)) throw invalidCursor();
    conds.push(sql`(${rankExpr}, -extract(epoch from n.created_at), n.id) > (${c.r}::int, -extract(epoch from ${c.t}::timestamptz), ${c.id}::uuid)`);
  }
  const [rows, counts] = await Promise.all([
    ctx.db.execute<{ id: string; kind: string; severity: 'info' | 'warning' | 'high'; title: string; body: string | null; href: string | null; client_id: string | null; client_name: string | null; read_at: Date | null; resolved_at: Date | null; created_at: Date; rnk: number }>(sql`
      select n.id, n.kind, n.severity, n.title, n.body, n.href, n.client_id, c.name as client_name, n.read_at, n.resolved_at, n.created_at, ${rankExpr}::int as rnk
      from notifications n left join clients c on c.id = n.client_id
      where ${sql.join(conds, sql` and `)}
      order by ${rankExpr}, n.created_at desc, n.id
      limit ${limit + 1}
    `),
    getNotificationCounts(ctx, { skipPermission: true }),
  ]);
  const list = rows.rows.slice(0, limit);
  const last = list[list.length - 1];
  return {
    items: list.map((n) => ({
      id: n.id,
      kind: n.kind,
      kindLabel: NOTIFICATION_KIND_LABELS[n.kind] ?? n.kind,
      severity: n.severity,
      title: n.title,
      body: n.body,
      href: n.href,
      clientId: n.client_id,
      clientName: n.client_name,
      read: n.read_at !== null,
      readAt: iso(n.read_at),
      resolved: n.resolved_at !== null,
      resolvedAt: iso(n.resolved_at),
      createdAt: iso(n.created_at)!,
    })),
    nextCursor: rows.rows.length > limit && last ? encodeCursor({ r: num(last.rnk), t: iso(last.created_at), id: last.id }) : null,
    counts,
  };
}

/** 상단 종 배지 */
export async function getNotificationCounts(ctx: ServiceContext, opts: { skipPermission?: boolean } = {}): Promise<NotificationCountsDTO> {
  if (!opts.skipPermission) requirePermission(ctx, 'transactions.read');
  const [r] = await ctx.db
    .select({
      unresolved: sql<number>`count(*)::int`,
      unread: sql<number>`(count(*) filter (where ${notifications.readAt} is null))::int`,
      high: sql<number>`(count(*) filter (where ${notifications.severity} = 'high'))::int`,
    })
    .from(notifications)
    .where(and(isNull(notifications.resolvedAt), visibleTo(ctx)));
  return { unresolved: num(r?.unresolved), unread: num(r?.unread), high: num(r?.high) };
}

function normalizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError('알림을 선택해 주세요.', [{ field: 'ids', message: 'required' }]);
  if (ids.length > 1000) throw new ValidationError('한 번에 1,000건까지 처리할 수 있습니다.', [{ field: 'ids', message: 'max 1000' }]);
  return [...new Set(ids.map((id, i) => assertUuid(id, `ids.${i}`, '알림')))];
}

/** 읽음 처리 (ids 또는 all) — 사용자 화면 상태라 거래 데이터는 바뀌지 않는다. 감사로그는 호출 1회당 1행 */
export async function markRead(ctx: ServiceContext, input: { ids?: string[]; all?: boolean }): Promise<{ updated: number }> {
  requirePermission(ctx, 'transactions.read');
  const conds = [isNull(notifications.readAt), isNull(notifications.resolvedAt), visibleTo(ctx)];
  if (!input?.all) conds.push(inArray(notifications.id, normalizeIds(input?.ids)));
  const rows = await ctx.db.update(notifications).set({ readAt: ctx.now() }).where(and(...conds)).returning({ id: notifications.id });
  if (rows.length > 0) {
    await writeAudit(ctx, {
      action: 'notification.read',
      category: 'data_change',
      entityType: 'notification',
      entityId: rows.length === 1 ? rows[0]!.id : null,
      summary: `알림 ${rows.length}건 읽음 처리`,
      after: { ids: rows.slice(0, 50).map((r) => r.id), count: rows.length },
    });
  }
  return { updated: rows.length };
}

/**
 * 문제 해결 처리 (사람이 시스템 밖에서 해결한 경우). 원인이 남아 있으면 같은 dedupe 키로 다시 생긴다.
 */
export async function resolveNotification(ctx: ServiceContext, input: { id: string; note?: string }): Promise<ProblemDTO> {
  requirePermission(ctx, 'transactions.review');
  const id = assertUuid(input?.id, 'id', '알림');
  const note = cleanText(input?.note, 300);
  const [before] = await ctx.db.select().from(notifications).where(and(eq(notifications.id, id), visibleTo(ctx)));
  if (!before) throw new NotFoundError('알림');
  const now = ctx.now();
  const [row] = before.resolvedAt
    ? [before]
    : await ctx.db
        .update(notifications)
        .set({ resolvedAt: now, readAt: before.readAt ?? now })
        .where(and(eq(notifications.id, id), isNull(notifications.resolvedAt)))
        .returning();
  const n = row ?? before;
  if (!before.resolvedAt) {
    await writeAudit(ctx, {
      action: 'notification.resolve',
      category: 'data_change',
      entityType: 'notification',
      entityId: id,
      clientId: before.clientId,
      summary: `문제 해결 처리: ${before.title}${note ? ` (메모: ${note})` : ''}`,
      before: { resolvedAt: null },
      after: { resolvedAt: now.toISOString(), note },
    });
  }
  return {
    id: n.id,
    kind: n.kind,
    kindLabel: NOTIFICATION_KIND_LABELS[n.kind] ?? n.kind,
    severity: n.severity,
    title: n.title,
    body: n.body,
    href: n.href,
    clientId: n.clientId,
    clientName: null,
    read: n.readAt !== null,
    readAt: iso(n.readAt),
    resolved: n.resolvedAt !== null,
    resolvedAt: iso(n.resolvedAt),
    createdAt: n.createdAt.toISOString(),
  };
}

/**
 * 좌측 내비 배지 — 처리할 일 수만 (권한 없는 메뉴는 0). 쿼리 1개.
 * - inbox   : 검토 필요 거래 + WEHAGO 전송오류 거래 (예외함과 같은 조건)
 * - transfer: 전송 행동이 필요한 수임처 (검토가 끝났는데 전송파일에 없는 승인 거래 · 받기 대기 · 업로드 확인 대기 · 차단)
 * - payroll : 미검토 인건비 변동이 있는 수임처
 * - filing  : 7일 안에 기한이 오는(지난 것 포함) 미신고 신고 건
 * - imports : 실패 행이 있거나 실패한 수집 (해당 기간 또는 기간 미상 최근 35일)
 * - review  : 확인하지 않은 AI 장부검토 지적 (최신 검토 기준)
 * - rules   : 승인 대기 규칙 제안
 */
export async function getNavBadges(ctx: ServiceContext, periodInput?: string | null): Promise<NavBadgesDTO> {
  requirePermission(ctx, 'transactions.read');
  const period = periodInput ? assertPeriod(periodInput) : await getCurrentPeriod(ctx);
  const has = (p: Parameters<typeof ctx.actor.permissions.has>[0]) => ctx.actor.permissions.has(p);
  const today = kstDateOf(ctx.now());
  const dueLimit = addDaysIso(today, 7);
  const recent = new Date(ctx.now().getTime() - 35 * 86_400_000).toISOString();
  const zero = sql`0`;
  const r = await ctx.db.execute<Omit<NavBadgesDTO, 'period'>>(sql`
    select
      (select count(*)::int from transactions t join clients c on c.id = t.client_id and c.active
        where t.period = ${period}
          and (t.status = 'needs_review' or (t.buckets @> '["export_error"]'::jsonb and t.status in ('approved', 'auto_approved', 'exported')))) as inbox,
      ${
        has('export.create')
          ? sql`(select count(*)::int from (
        select t.client_id from transactions t join clients c on c.id = t.client_id and c.active
        where t.period = ${period}
        group by t.client_id
        having count(*) filter (where t.status in ('imported', 'classified', 'needs_review')) = 0
           and count(*) filter (where t.status in ('approved', 'auto_approved') and t.export_job_id is null) > 0
        union
        select l.client_id from (
          select distinct on (e.client_id, e.kind) e.client_id, e.status, (e.validation ? 'supersededBy') as superseded
          from export_jobs e join clients c on c.id = e.client_id and c.active
          where e.period = ${period} and e.kind in ('wehago_purchase_sales', 'wehago_general_journal')
          order by e.client_id, e.kind, e.created_at desc
        ) l where l.status in ('ready', 'downloaded', 'blocked') and not l.superseded
      ) x)`
          : zero
      } as transfer,
      ${
        has('payroll.read')
          ? sql`(select count(distinct pm.client_id)::int from payroll_months pm join clients c on c.id = pm.client_id and c.active
        join payroll_items pi on pi.payroll_month_id = pm.id and pi.needs_review and pi.reviewed_at is null
        where pm.period = ${period})`
          : zero
      } as payroll,
      ${
        has('filing.write')
          ? sql`(select count(*)::int from filing_jobs f join clients c on c.id = f.client_id and c.active
        where f.due_date is not null and f.due_date <= ${dueLimit}::date and not (f.current_step = any(${textArray(FILING_DONE_STEPS)})))`
          : zero
      } as filing,
      ${
        has('imports.create')
          ? sql`(select count(*)::int from import_jobs ij
        where (ij.status = 'failed' or ij.failed_rows > 0)
          and (ij.period = ${period} or (ij.period is null and ij.created_at >= ${recent}::timestamptz)))`
          : zero
      } as imports,
      (select count(*)::int from (
        select distinct on (r.client_id, r.kind) r.findings from ai_reviews r join clients c on c.id = r.client_id and c.active
        where r.period = ${period} and r.status = 'open'
        order by r.client_id, r.kind, r.created_at desc
      ) lr cross join lateral jsonb_array_elements(lr.findings) as f(finding) where f.finding ->> 'ackAt' is null) as review,
      ${has('rules.read') ? sql`(select count(*)::int from mapping_rules m where m.status = 'suggested')` : zero} as rules
  `);
  const x = r.rows[0]!;
  return {
    period,
    inbox: num(x.inbox),
    transfer: num(x.transfer),
    payroll: num(x.payroll),
    filing: num(x.filing),
    imports: num(x.imports),
    review: num(x.review),
    rules: num(x.rules),
  };
}
