/**
 * 감사로그 조회 (/audit) · CSV 내보내기 · 로그인 이력.
 * - 조회는 audit.read. 로그인 이력은 본인 것은 누구나, 다른 사용자는 audit.read.
 * - before/after 는 민감 키(password·token·secret·idNumber·bankAccount 등)를 가린 뒤 돌려준다.
 * - CSV 내보내기 자체도 감사로그(download)로 남긴다. 수식 주입(=,+,-,@) 방지.
 */
import { sql, type SQL } from 'drizzle-orm';
import { ForbiddenError, PERMISSION_LABELS, ValidationError, redact } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { LOGIN_RESULT_LABELS, normalizeEmail, isLoginResultCode } from '../auth/helpers';
import type { LoginHistoryDTO } from '../auth/types';
import { assertUuid, clampLimit, cleanText, csvLine, decodeCursor, encodeCursor, hrefs, invalidCursor, isUuid, iso, optionalUuid } from './shared';

export interface AuditLogFilter {
  clientId?: string | null;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  action?: string | null;
  category?: string | null;
  /** ISO 시각 또는 'YYYY-MM-DD'(KST 0시) */
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface AuditLogDTO {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorName: string;
  action: string;
  category: string;
  entityType: string;
  entityId: string | null;
  clientId: string | null;
  clientName: string | null;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  revertible: boolean;
  reverted: boolean;
  revertedById: string | null;
  revertOfId: string | null;
  ip: string | null;
  userAgent: string | null;
  sessionId: string | null;
  /** 대상 화면 링크 (알 수 있으면) */
  href: string | null;
}

const CATEGORY_SET = new Set(['data_change', 'access', 'download', 'security', 'system']);

function parseTime(v: unknown, field: string): string | null {
  const s = cleanText(v, 40);
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+09:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw invalidTime(field);
  return d.toISOString();
}

function invalidTime(field: string): ValidationError {
  return new ValidationError('기간 형식이 올바르지 않습니다. 예: 2026-09-01', [{ field, message: 'date' }]);
}

function entityHref(entityType: string, entityId: string | null, clientId: string | null): string | null {
  if (!entityId) return clientId ? hrefs.client(clientId) : null;
  switch (entityType) {
    case 'transaction':
      return `/inbox?tx=${entityId}`;
    case 'export_job':
      return hrefs.exportJob(entityId);
    case 'reconciliation_job':
      return hrefs.reconciliation(entityId);
    case 'import_job':
      return `/imports/${entityId}`;
    case 'mapping_rule':
      return hrefs.rules({ rule: entityId });
    case 'client':
      return hrefs.client(entityId);
    case 'job':
      return hrefs.job(entityId);
    case 'system_error':
      return hrefs.systemErrors(entityId);
    default:
      return clientId ? hrefs.client(clientId) : null;
  }
}

function whereOf(f: AuditLogFilter): SQL[] {
  const conds: SQL[] = [];
  const clientId = optionalUuid(f.clientId, 'clientId', '수임처');
  const actorId = optionalUuid(f.actorId, 'actorId', '사용자');
  if (clientId) conds.push(sql`a.client_id = ${clientId}::uuid`);
  if (actorId) conds.push(sql`a.actor_id = ${actorId}::uuid`);
  const entityType = cleanText(f.entityType, 60);
  if (entityType) conds.push(sql`a.entity_type = ${entityType}`);
  const entityId = cleanText(f.entityId, 100);
  if (entityId) conds.push(sql`a.entity_id = ${entityId}`);
  const action = cleanText(f.action, 100);
  if (action) conds.push(action.endsWith('.*') ? sql`a.action like ${`${action.slice(0, -2).replace(/[\\%_]/g, (m) => `\\${m}`)}.%`}` : sql`a.action = ${action}`);
  const category = cleanText(f.category, 20);
  if (category && CATEGORY_SET.has(category)) conds.push(sql`a.category = ${category}`);
  const from = parseTime(f.from, 'from');
  const to = parseTime(f.to, 'to');
  if (from) conds.push(sql`a.created_at >= ${from}::timestamptz`);
  if (to) conds.push(sql`a.created_at < ${to}::timestamptz`);
  return conds;
}

interface AuditRow {
  id: string;
  created_at: Date;
  actor_id: string | null;
  actor_name: string;
  action: string;
  category: string;
  entity_type: string;
  entity_id: string | null;
  client_id: string | null;
  client_name: string | null;
  summary: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  revertible: boolean;
  reverted_by_id: string | null;
  revert_of_id: string | null;
  ip: string | null;
  user_agent: string | null;
  session_id: string | null;
}

function toDTO(r: AuditRow): AuditLogDTO {
  return {
    id: r.id,
    createdAt: iso(r.created_at)!,
    actorId: r.actor_id,
    actorName: r.actor_name,
    action: r.action,
    category: r.category,
    entityType: r.entity_type,
    entityId: r.entity_id,
    clientId: r.client_id,
    clientName: r.client_name,
    summary: r.summary,
    before: r.before_data ? (redact(r.before_data) as Record<string, unknown>) : null,
    after: r.after_data ? (redact(r.after_data) as Record<string, unknown>) : null,
    revertible: r.revertible,
    reverted: r.reverted_by_id !== null,
    revertedById: r.reverted_by_id,
    revertOfId: r.revert_of_id,
    ip: r.ip,
    userAgent: r.user_agent,
    sessionId: r.session_id,
    href: entityHref(r.entity_type, r.entity_id, r.client_id),
  };
}

async function queryAudit(ctx: ServiceContext, f: AuditLogFilter, limit: number): Promise<{ rows: AuditRow[]; more: boolean }> {
  const conds = whereOf(f);
  if (f.cursor) {
    const c = decodeCursor(f.cursor);
    if (!c || typeof c.t !== 'string' || !isUuid(c.id)) throw invalidCursor();
    conds.push(sql`(a.created_at, a.id) < (${c.t}::timestamptz, ${c.id}::uuid)`);
  }
  const r = await ctx.db.execute<AuditRow>(sql`
    select a.id, a.created_at, a.actor_id, a.actor_name, a.action, a.category, a.entity_type, a.entity_id, a.client_id, c.name as client_name,
      a.summary, a.before_data, a.after_data, a.revertible, a.reverted_by_id, a.revert_of_id, a.ip, a.user_agent, a.session_id
    from audit_logs a left join clients c on c.id = a.client_id
    ${conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``}
    order by a.created_at desc, a.id desc
    limit ${limit + 1}
  `);
  return { rows: r.rows.slice(0, limit), more: r.rows.length > limit };
}

/** 감사로그 목록 (최신순, 커서 페이징) */
export async function listAuditLogs(ctx: ServiceContext, input: AuditLogFilter = {}): Promise<{ items: AuditLogDTO[]; nextCursor: string | null }> {
  requirePermission(ctx, 'audit.read');
  const limit = clampLimit(input.limit, 100, 500);
  const { rows, more } = await queryAudit(ctx, input, limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map(toDTO),
    nextCursor: more && last ? encodeCursor({ t: iso(last.created_at), id: last.id }) : null,
  };
}

/** 감사로그 1건 (상세 드로어) */
export async function getAuditLog(ctx: ServiceContext, id: string): Promise<AuditLogDTO | null> {
  requirePermission(ctx, 'audit.read');
  const aid = assertUuid(id, 'id', '감사로그');
  const r = await ctx.db.execute<AuditRow>(sql`
    select a.id, a.created_at, a.actor_id, a.actor_name, a.action, a.category, a.entity_type, a.entity_id, a.client_id, c.name as client_name,
      a.summary, a.before_data, a.after_data, a.revertible, a.reverted_by_id, a.revert_of_id, a.ip, a.user_agent, a.session_id
    from audit_logs a left join clients c on c.id = a.client_id where a.id = ${aid}::uuid
  `);
  return r.rows[0] ? toDTO(r.rows[0]) : null;
}

export const AUDIT_CSV_MAX_ROWS = 50_000;

/**
 * 감사로그 CSV (UTF-8 BOM — Excel 한글 깨짐 방지). 최대 5만 행, 1,000행씩 읽는다.
 * 내보내기 자체를 download 감사로그로 남긴다.
 */
export async function exportAuditCsv(
  ctx: ServiceContext,
  input: Omit<AuditLogFilter, 'cursor' | 'limit'> = {},
): Promise<{ fileName: string; mimeType: string; content: string; rowCount: number; truncated: boolean }> {
  requirePermission(ctx, 'audit.read');
  const header = ['시각(UTC)', '사용자', '작업', '분류', '대상', '대상ID', '수임처', '요약', '이전', '이후', 'IP', '되돌림'];
  const lines = [csvLine(header)];
  let cursor: string | null = null;
  let count = 0;
  let truncated = false;
  for (;;) {
    const { rows, more } = await queryAudit(ctx, { ...input, cursor }, 1000);
    for (const r of rows) {
      const d = toDTO(r);
      lines.push(csvLine([d.createdAt, d.actorName, d.action, d.category, d.entityType, d.entityId, d.clientName, d.summary, d.before, d.after, d.ip, d.reverted ? 'Y' : '']));
      count += 1;
    }
    const last = rows[rows.length - 1];
    if (!more || !last) break;
    if (count >= AUDIT_CSV_MAX_ROWS) {
      truncated = true;
      break;
    }
    cursor = encodeCursor({ t: iso(last.created_at), id: last.id });
  }
  const stamp = ctx.now().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `audit_${stamp}.csv`;
  await writeAudit(ctx, {
    action: 'audit.export_csv',
    category: 'download',
    entityType: 'audit_log',
    clientId: optionalUuid(input.clientId, 'clientId', '수임처'),
    summary: `감사로그 CSV 내보내기 ${count.toLocaleString('ko-KR')}행${truncated ? ' (최대 행수 초과로 잘림)' : ''}`,
    after: { filter: { ...input }, rowCount: count, truncated },
  });
  return { fileName, mimeType: 'text/csv; charset=utf-8', content: `﻿${lines.join('\r\n')}\r\n`, rowCount: count, truncated };
}

/** 로그인 이력 — 본인 것은 누구나, 다른 사용자·전체는 audit.read */
export async function listLoginHistory(
  ctx: ServiceContext,
  input: { userId?: string | null; email?: string | null; result?: string | null; successOnly?: boolean; failedOnly?: boolean; from?: string | null; to?: string | null; cursor?: string | null; limit?: number } = {},
): Promise<{ items: LoginHistoryDTO[]; nextCursor: string | null }> {
  const userId = optionalUuid(input.userId, 'userId', '사용자');
  const self = !!userId && ctx.actor.kind === 'user' && ctx.actor.userId === userId && !input.email;
  if (!self) {
    if (!ctx.actor.permissions.has('audit.read')) throw new ForbiddenError('audit.read', PERMISSION_LABELS['audit.read']);
  }
  const limit = clampLimit(input.limit, 100, 500);
  const conds: SQL[] = [];
  if (userId) conds.push(sql`h.user_id = ${userId}::uuid`);
  const email = input.email ? normalizeEmail(input.email) : '';
  if (email) conds.push(sql`h.email = ${email}`);
  if (input.result && isLoginResultCode(input.result)) conds.push(sql`h.result = ${input.result}`);
  if (input.successOnly) conds.push(sql`h.success`);
  if (input.failedOnly) conds.push(sql`not h.success`);
  const from = parseTime(input.from, 'from');
  const to = parseTime(input.to, 'to');
  if (from) conds.push(sql`h.created_at >= ${from}::timestamptz`);
  if (to) conds.push(sql`h.created_at < ${to}::timestamptz`);
  if (input.cursor) {
    const c = decodeCursor(input.cursor);
    if (!c || typeof c.t !== 'string' || !isUuid(c.id)) throw invalidCursor();
    conds.push(sql`(h.created_at, h.id) < (${c.t}::timestamptz, ${c.id}::uuid)`);
  }
  const r = await ctx.db.execute<{ id: string; created_at: Date; user_id: string | null; user_name: string | null; email: string; success: boolean; result: string; ip: string | null; user_agent: string | null }>(sql`
    select h.id, h.created_at, h.user_id, u.name as user_name, h.email, h.success, h.result, h.ip, h.user_agent
    from login_history h left join users u on u.id = h.user_id
    ${conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``}
    order by h.created_at desc, h.id desc
    limit ${limit + 1}
  `);
  const rows = r.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((h) => ({
      id: h.id,
      createdAt: iso(h.created_at)!,
      userId: h.user_id,
      userName: h.user_name,
      email: h.email,
      success: h.success,
      result: h.result,
      resultLabel: isLoginResultCode(h.result) ? LOGIN_RESULT_LABELS[h.result] : h.result,
      ip: h.ip,
      userAgent: h.user_agent,
    })),
    nextCursor: r.rows.length > limit && last ? encodeCursor({ t: iso(last.created_at), id: last.id }) : null,
  };
}
