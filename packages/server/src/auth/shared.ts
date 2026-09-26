/**
 * 인증 영역 내부 공용 (DB 접근 도우미). 외부에 export 하지 않는 것도 있다.
 */
import { eq } from 'drizzle-orm';
import { loginHistory, sessions, users, type Database, type DbOrTx } from '@mintax/db';
import type { Permission } from '@mintax/core';
import {
  AuthenticationError,
  ForbiddenError,
  PERMISSION_LABELS,
  computeSessionExpiresAt,
  generateSessionToken,
  getSessionPolicy,
  hashToken,
  permissionsOf,
} from '@mintax/security';
import { createContext, systemActor, type Actor, type ServiceContext } from '../context';
import { cleanMeta, roleLabel, roleOf, type Env, type LoginResultCode } from './helpers';
import type { AuthOptions, AuthRequestMeta, AuthUserDTO } from './types';

export type UserRow = typeof users.$inferSelect;

export function nowOf(opts: AuthOptions | undefined): Date {
  return opts?.now ? opts.now() : new Date();
}

export function envOf(opts: AuthOptions | undefined): Env {
  return opts?.env ?? process.env;
}

export function toAuthUserDTO(u: UserRow): AuthUserDTO {
  const role = roleOf(u.role);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role,
    roleLabel: roleLabel(role),
    permissions: permissionsOf(role) as Permission[],
    mfaEnabled: u.mfaEnabled,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    passwordChangedAt: u.passwordChangedAt ? u.passwordChangedAt.toISOString() : null,
  };
}

export async function loadUserById(db: DbOrTx, userId: string): Promise<UserRow | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  return u ?? null;
}

export async function loadUserByEmail(db: DbOrTx, email: string): Promise<UserRow | null> {
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return u ?? null;
}

/** login_history 1행 (모든 시도 기록 — 결과 코드 포함) */
export async function recordLoginAttempt(
  db: DbOrTx,
  input: { userId: string | null; email: string; result: LoginResultCode; meta: AuthRequestMeta; at: Date },
): Promise<void> {
  await db.insert(loginHistory).values({
    userId: input.userId,
    email: input.email.slice(0, 320),
    success: input.result === 'success' || input.result === 'success_recovery_code',
    result: input.result,
    ip: cleanMeta(input.meta.ip, 64),
    userAgent: cleanMeta(input.meta.userAgent),
    createdAt: input.at,
  });
}

/** 세션 생성 — 원문 토큰은 반환만 하고 DB 에는 SHA-256 만 저장 */
export async function insertSession(
  db: DbOrTx,
  input: { userId: string; meta: AuthRequestMeta; mfaVerified: boolean; at: Date; env?: Env },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const policy = getSessionPolicy(input.env ?? process.env);
  const expiresAt = computeSessionExpiresAt(input.at, policy);
  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: hashToken(token),
      ip: cleanMeta(input.meta.ip, 64),
      userAgent: cleanMeta(input.meta.userAgent),
      mfaVerified: input.mfaVerified,
      createdAt: input.at,
      lastSeenAt: input.at,
      expiresAt,
    })
    .returning({ id: sessions.id });
  return { token, sessionId: row!.id, expiresAt };
}

/** 로그인 전 단계에서 감사로그를 남기기 위한 컨텍스트 (사용자 확인 전이면 시스템 행위자) */
export function authContext(db: Database, actor: Actor | null, meta: AuthRequestMeta, at: Date): ServiceContext {
  const base = actor ?? systemActor('MIN TAX OPS 보안');
  return createContext(db, { ...base, ip: cleanMeta(meta.ip, 64), userAgent: cleanMeta(meta.userAgent) }, () => at);
}

/** 로그인한 사용자 본인만 (시스템 작업 불가) */
export function requireUserActor(ctx: ServiceContext): string {
  if (ctx.actor.kind !== 'user' || !ctx.actor.userId) {
    throw new AuthenticationError('로그인한 사용자만 사용할 수 있는 기능입니다. 다시 로그인해 주세요.');
  }
  return ctx.actor.userId;
}

/**
 * 본인이면 통과, 다른 사용자의 정보면 권한 필요 (권한 검사 — 서비스 첫 줄에서 호출).
 */
export function requireSelfOrPermission(ctx: ServiceContext, userId: string | null | undefined, permission: Permission): void {
  if (userId && ctx.actor.kind === 'user' && ctx.actor.userId === userId) return;
  if (!userId && ctx.actor.kind === 'user' && ctx.actor.userId) return;
  if (ctx.actor.permissions.has(permission)) return;
  throw new ForbiddenError(permission, PERMISSION_LABELS[permission]);
}
