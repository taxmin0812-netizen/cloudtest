/**
 * 세션 — 원문 토큰은 쿠키에만, DB 에는 SHA-256(token_hash)만.
 * 만료: 유휴(SESSION_IDLE_MINUTES, 기본 30분) + 절대(SESSION_ABSOLUTE_HOURS, 기본 12시간) — @mintax/security 정책.
 * lastSeenAt 은 60초에 한 번만 갱신한다 (요청마다 쓰기 방지).
 */
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { sessions, users, type Database, type DbOrTx } from '@mintax/db';
import { NotFoundError, getSessionPolicy, hashToken, isIpAllowed, isWellFormedSessionToken, sessionExpiryReason, shouldTouchSession, type SessionPolicy } from '@mintax/security';
import type { ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { buildActor, mustEnrollMfa } from './helpers';
import { authContext, envOf, insertSession, loadUserById, nowOf, requireSelfOrPermission, toAuthUserDTO } from './shared';
import type { AuthOptions, AuthRequestMeta, SessionCheck, SessionDTO, ValidatedSession } from './types';

type SessionRow = typeof sessions.$inferSelect;

function toSessionDTO(s: SessionRow, policy: SessionPolicy, currentId: string | null | undefined): SessionDTO {
  const idleEnd = Math.min(s.lastSeenAt.getTime() + policy.idleMinutes * 60_000, s.expiresAt.getTime());
  return {
    id: s.id,
    ip: s.ip,
    userAgent: s.userAgent,
    mfaVerified: s.mfaVerified,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    idleExpiresAt: new Date(idleEnd).toISOString(),
    current: !!currentId && currentId === s.id,
  };
}

/**
 * 세션 생성 (로그인 흐름 밖에서 — 예: 테스트·관리 도구). 원문 토큰은 반환값에만 있다.
 */
export async function createSession(
  db: Database,
  input: { userId: string; mfaVerified?: boolean } & AuthRequestMeta,
  opts: AuthOptions = {},
): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const s = await insertSession(db, {
    userId: input.userId,
    meta: { ip: input.ip ?? null, userAgent: input.userAgent ?? null },
    mfaVerified: input.mfaVerified ?? false,
    at: nowOf(opts),
    env: envOf(opts),
  });
  return { token: s.token, sessionId: s.sessionId, expiresAt: s.expiresAt.toISOString() };
}

/** 세션 검사 (실패 사유 포함) — 화면에서 "자동 로그아웃" 문구 선택용 */
export async function checkSession(db: Database, token: unknown, meta: AuthRequestMeta = {}, opts: AuthOptions = {}): Promise<SessionCheck> {
  if (!isWellFormedSessionToken(token)) return { ok: false, reason: 'malformed' };
  const now = nowOf(opts);
  const env = envOf(opts);
  const policy = getSessionPolicy(env);
  const [row] = await db.select({ s: sessions, u: users }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(eq(sessions.tokenHash, hashToken(token)));
  if (!row) return { ok: false, reason: 'not_found' };
  const { s, u } = row;
  const expiry = sessionExpiryReason({ createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt, now }, policy);
  if (expiry) return { ok: false, reason: expiry };
  if (!u.active) return { ok: false, reason: 'inactive' };
  if (!isIpAllowed(meta.ip ?? null, u.allowedIpRanges)) return { ok: false, reason: 'ip_blocked' };
  if (u.mfaEnabled && !s.mfaVerified) return { ok: false, reason: 'mfa_pending' };

  let lastSeenAt = s.lastSeenAt;
  if (shouldTouchSession(s.lastSeenAt, now, 60)) {
    const nowIso = now.toISOString();
    await db.execute(sql`
      update sessions set last_seen_at = ${nowIso}::timestamptz
      where id = ${s.id}::uuid and last_seen_at < ${nowIso}::timestamptz - interval '60 seconds'
    `);
    lastSeenAt = now;
  }
  const session = toSessionDTO({ ...s, lastSeenAt }, policy, s.id);
  const actor = buildActor(u, { id: s.id, ip: meta.ip ?? s.ip, userAgent: meta.userAgent ?? s.userAgent });
  return {
    ok: true,
    user: toAuthUserDTO(u),
    actor,
    session,
    mustEnrollMfa: mustEnrollMfa(u, env),
    mustChangePassword: u.passwordChangedAt === null,
  };
}

/**
 * 세션 검증 → { user, actor, session } 또는 null (만료·폐기·비활성·IP 차단·OTP 미완료).
 * actor 의 권한은 매 요청 users.role 에서 계산한다 (역할 변경 즉시 반영).
 */
export async function validateSession(db: Database, token: unknown, meta: AuthRequestMeta = {}, opts: AuthOptions = {}): Promise<ValidatedSession | null> {
  const r = await checkSession(db, token, meta, opts);
  if (!r.ok) return null;
  const { ok: _ok, ...rest } = r;
  return rest;
}

/** 로그아웃 — 세션 즉시 폐기 + 감사로그 */
export async function logout(db: Database, token: unknown, meta: AuthRequestMeta = {}, opts: AuthOptions = {}): Promise<{ revoked: boolean }> {
  if (!isWellFormedSessionToken(token)) return { revoked: false };
  const now = nowOf(opts);
  const [s] = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
    .returning();
  if (!s) return { revoked: false };
  const user = await loadUserById(db, s.userId);
  if (user) {
    await writeAudit(authContext(db, buildActor(user, { id: s.id, ip: meta.ip, userAgent: meta.userAgent }), meta, now), {
      action: 'auth.logout',
      category: 'security',
      entityType: 'session',
      entityId: s.id,
      summary: `${user.name} 로그아웃`,
    });
  }
  return { revoked: true };
}

/** 내부용: 사용자 세션 일괄 폐기 (비밀번호 변경·비활성화·MFA 초기화) */
export async function revokeUserSessions(db: DbOrTx, userId: string, at: Date, exceptSessionId?: string | null): Promise<number> {
  const conds = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptSessionId) conds.push(ne(sessions.id, exceptSessionId));
  const r = await db.update(sessions).set({ revokedAt: at }).where(and(...conds)).returning({ id: sessions.id });
  return r.length;
}

/**
 * 사용자의 모든 세션 폐기 ("모든 기기에서 로그아웃"). 본인 또는 users.manage.
 * exceptCurrent: 본인 요청이면 지금 쓰는 세션은 남긴다.
 */
export async function revokeAllSessions(ctx: ServiceContext, userId: string, opts: { exceptCurrent?: boolean } = {}): Promise<{ revoked: number }> {
  requireSelfOrPermission(ctx, userId, 'users.manage');
  const target = await loadUserById(ctx.db, userId);
  if (!target) throw new NotFoundError('사용자');
  const self = ctx.actor.userId === userId;
  const except = self && opts.exceptCurrent !== false ? (ctx.actor.sessionId ?? null) : null;
  const revoked = await revokeUserSessions(ctx.db, userId, ctx.now(), except);
  await writeAudit(ctx, {
    action: 'auth.sessions_revoked',
    category: 'security',
    entityType: 'user',
    entityId: userId,
    summary: self ? `${target.name} 다른 기기 세션 ${revoked}개 로그아웃` : `${ctx.actor.name} → ${target.name} 세션 ${revoked}개 강제 로그아웃`,
    after: { revoked, exceptCurrent: !!except },
  });
  return { revoked };
}

/** 세션 1개 폐기 (보안 화면의 "이 기기 로그아웃") */
export async function revokeSession(ctx: ServiceContext, sessionId: string): Promise<{ revoked: boolean }> {
  requireSelfOrPermission(ctx, null, 'users.manage');
  const [s] = await ctx.db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!s) throw new NotFoundError('세션');
  requireSelfOrPermission(ctx, s.userId, 'users.manage');
  if (s.revokedAt) return { revoked: false };
  await ctx.db.update(sessions).set({ revokedAt: ctx.now() }).where(eq(sessions.id, sessionId));
  await writeAudit(ctx, {
    action: 'auth.session_revoked',
    category: 'security',
    entityType: 'session',
    entityId: sessionId,
    summary: `세션 로그아웃 (${s.ip ?? 'IP 미상'} · ${String(s.userAgent ?? '').slice(0, 40) || '브라우저 미상'})`,
    before: { revokedAt: null },
    after: { revokedAt: ctx.now().toISOString() },
  });
  return { revoked: true };
}

/** 보안 화면: 사용 중인 세션 목록 (본인 또는 users.manage 로 다른 사용자) */
export async function listSessions(ctx: ServiceContext, input: { userId?: string } = {}): Promise<SessionDTO[]> {
  requireSelfOrPermission(ctx, input.userId ?? null, 'users.manage');
  const userId = input.userId ?? ctx.actor.userId;
  if (!userId) return [];
  const now = ctx.now();
  const policy = getSessionPolicy();
  const rows = await ctx.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.lastSeenAt))
    .limit(100);
  return rows
    .filter((s) => sessionExpiryReason({ createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt, now }, policy) === null)
    .map((s) => toSessionDTO(s, policy, ctx.actor.sessionId));
}
