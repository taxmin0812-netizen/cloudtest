/**
 * 비밀번호 변경(본인) · 재설정(관리자, 임시 비밀번호).
 * 감사로그(category security)에는 비밀번호·해시를 절대 넣지 않는다.
 */
import { eq } from 'drizzle-orm';
import { users } from '@mintax/db';
import { NotFoundError, ValidationError, hashPassword, validatePasswordPolicy, verifyPassword } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { generateTemporaryPassword } from './helpers';
import { loadUserById, requireSelfOrPermission, requireUserActor } from './shared';
import { revokeUserSessions } from './sessions';

/** 본인 비밀번호 변경 — 현재 비밀번호 확인 + 정책 검사. 다른 기기 세션은 로그아웃된다 */
export async function changePassword(
  ctx: ServiceContext,
  input: { currentPassword: string; newPassword: string },
): Promise<{ changed: true; revokedSessions: number }> {
  requireSelfOrPermission(ctx, null, 'users.manage');
  const userId = requireUserActor(ctx);
  const user = await loadUserById(ctx.db, userId);
  if (!user) throw new NotFoundError('사용자');
  const current = typeof input?.currentPassword === 'string' ? input.currentPassword : '';
  const next = typeof input?.newPassword === 'string' ? input.newPassword : '';
  if (!(await verifyPassword(current, user.passwordHash))) {
    throw new ValidationError('현재 비밀번호가 올바르지 않습니다.', [{ field: 'currentPassword', message: '현재 비밀번호가 올바르지 않습니다.' }]);
  }
  const policy = validatePasswordPolicy(next, { email: user.email });
  if (!policy.ok) {
    throw new ValidationError(`새 비밀번호가 정책에 맞지 않습니다: ${policy.errors.join(' ')}`, policy.errors.map((m) => ({ field: 'newPassword', message: m })));
  }
  if (await verifyPassword(next, user.passwordHash)) {
    throw new ValidationError('새 비밀번호가 현재 비밀번호와 같습니다. 다른 비밀번호를 입력해 주세요.', [{ field: 'newPassword', message: '현재 비밀번호와 같습니다.' }]);
  }
  const hash = await hashPassword(next);
  const now = ctx.now();
  const revokedSessions = await ctx.db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: hash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null, updatedAt: now }).where(eq(users.id, userId));
    const n = await revokeUserSessions(tx, userId, now, ctx.actor.sessionId ?? null);
    await writeAudit({ ...ctx, db: tx as unknown as typeof ctx.db }, {
      action: 'auth.password_change',
      category: 'security',
      entityType: 'user',
      entityId: userId,
      summary: `${user.name} 비밀번호 변경 · 다른 세션 ${n}개 로그아웃`,
      before: { passwordChangedAt: user.passwordChangedAt ? user.passwordChangedAt.toISOString() : null },
      after: { passwordChangedAt: now.toISOString() },
    });
    return n;
  });
  return { changed: true, revokedSessions };
}

/**
 * 관리자 비밀번호 재설정 — 임시 비밀번호(한 번만 표시) 발급, 잠금 해제, 모든 세션 폐기.
 * 임시 비밀번호 상태(passwordChangedAt = null)는 로그인 결과의 mustChangePassword 로 안내된다.
 */
export async function resetUserPassword(ctx: ServiceContext, input: { userId: string }): Promise<{ temporaryPassword: string; revokedSessions: number }> {
  requirePermission(ctx, 'users.manage');
  const user = await loadUserById(ctx.db, input?.userId);
  if (!user) throw new NotFoundError('사용자');
  const temporaryPassword = generateTemporaryPassword();
  const hash = await hashPassword(temporaryPassword);
  const now = ctx.now();
  const revokedSessions = await ctx.db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: hash, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, updatedAt: now }).where(eq(users.id, user.id));
    const n = await revokeUserSessions(tx, user.id, now);
    await writeAudit({ ...ctx, db: tx as unknown as typeof ctx.db }, {
      action: 'auth.password_reset',
      category: 'security',
      entityType: 'user',
      entityId: user.id,
      summary: `${ctx.actor.name} → ${user.name} 비밀번호 재설정 (임시 비밀번호 발급) · 세션 ${n}개 로그아웃`,
      after: { temporaryPassword: true },
    });
    return n;
  });
  return { temporaryPassword, revokedSessions };
}
