import { and, eq, isNull } from 'drizzle-orm';
import { notifications } from '@mintax/db';
import type { ServiceContext } from '../context';

/**
 * 문제 알림만 만든다 (정상처리 알림 없음).
 * dedupeKey 가 같은 미해결 알림이 있으면 새로 만들지 않고 갱신한다.
 */
export type ProblemKind =
  | 'export_error'
  | 'recon_mismatch'
  | 'payroll_unreviewed'
  | 'import_failed'
  | 'job_failed'
  | 'rule_suggested'
  | 'filing_due';

export async function notifyProblem(
  ctx: Pick<ServiceContext, 'db'>,
  input: { kind: ProblemKind; severity: 'info' | 'warning' | 'high'; title: string; body?: string; href?: string; clientId?: string | null; userId?: string | null; dedupeKey: string },
): Promise<void> {
  const existing = await ctx.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.dedupeKey, input.dedupeKey), isNull(notifications.resolvedAt)));
  if (existing[0]) {
    await ctx.db
      .update(notifications)
      .set({ title: input.title, body: input.body ?? null, href: input.href ?? null, severity: input.severity, readAt: null })
      .where(eq(notifications.id, existing[0].id));
    return;
  }
  await ctx.db.insert(notifications).values({
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    body: input.body ?? null,
    href: input.href ?? null,
    clientId: input.clientId ?? null,
    userId: input.userId ?? null,
    dedupeKey: input.dedupeKey,
  });
}

/** 문제가 해소되면 알림도 해소 */
export async function resolveProblem(ctx: Pick<ServiceContext, 'db'>, dedupeKey: string): Promise<void> {
  await ctx.db
    .update(notifications)
    .set({ resolvedAt: new Date() })
    .where(and(eq(notifications.dedupeKey, dedupeKey), isNull(notifications.resolvedAt)));
}
