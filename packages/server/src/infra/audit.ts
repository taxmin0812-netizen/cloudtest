import { auditLogs } from '@mintax/db';
import type { ServiceContext } from '../context';

export type AuditCategory = 'data_change' | 'access' | 'download' | 'security' | 'system';

export interface AuditEntry {
  action: string;
  category: AuditCategory;
  entityType: string;
  entityId?: string | null;
  clientId?: string | null;
  /** 사람이 읽는 요약: "쿠팡 72,300원 소모품비 → 공구와기구" */
  summary: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  revertible?: boolean;
  revertOfId?: string | null;
}

/**
 * 감사로그 기록. 누가/언제/무엇을/무엇에서/무엇으로.
 * before/after 에 민감정보(주민번호 원문, 비밀번호, 토큰)를 절대 넣지 않는다.
 */
export async function writeAudit(ctx: ServiceContext, entry: AuditEntry): Promise<string> {
  const [row] = await ctx.db
    .insert(auditLogs)
    .values({
      actorId: ctx.actor.userId,
      actorName: ctx.actor.name,
      action: entry.action,
      category: entry.category,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      clientId: entry.clientId ?? null,
      summary: entry.summary,
      beforeData: entry.before ?? null,
      afterData: entry.after ?? null,
      revertible: entry.revertible ?? false,
      revertOfId: entry.revertOfId ?? null,
      ip: ctx.actor.ip ?? null,
      userAgent: ctx.actor.userAgent ?? null,
      sessionId: ctx.actor.sessionId ?? null,
      createdAt: ctx.now(),
    })
    .returning({ id: auditLogs.id });
  return row!.id;
}

/** 대량 감사로그 (일괄 승인 등) */
export async function writeAuditMany(ctx: ServiceContext, entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const now = ctx.now();
  for (let i = 0; i < entries.length; i += 500) {
    await ctx.db.insert(auditLogs).values(
      entries.slice(i, i + 500).map((entry) => ({
        actorId: ctx.actor.userId,
        actorName: ctx.actor.name,
        action: entry.action,
        category: entry.category,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        clientId: entry.clientId ?? null,
        summary: entry.summary,
        beforeData: entry.before ?? null,
        afterData: entry.after ?? null,
        revertible: entry.revertible ?? false,
        revertOfId: entry.revertOfId ?? null,
        ip: ctx.actor.ip ?? null,
        userAgent: ctx.actor.userAgent ?? null,
        sessionId: ctx.actor.sessionId ?? null,
        createdAt: now,
      })),
    );
  }
}
