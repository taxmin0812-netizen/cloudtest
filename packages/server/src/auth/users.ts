/**
 * 사용자·권한 관리 (/settings/users) — 모두 users.manage (관리자 전용).
 * 안전장치: 마지막 활성 관리자는 강등·비활성화할 수 없다. 자기 자신은 비활성화할 수 없다.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { users, type DbOrTx } from '@mintax/db';
import type { Role } from '@mintax/core';
import {
  ConflictError,
  NotFoundError,
  ROLE_LABELS,
  ValidationError,
  hashPassword,
  isAccountLocked,
  isRole,
  validateCidrList,
} from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { generateTemporaryPassword, isValidEmail, mustEnrollMfa, normalizeEmail, roleLabel, roleOf } from './helpers';
import { loadUserById, type UserRow } from './shared';
import { revokeUserSessions } from './sessions';
import type { CreateUserInput, CreatedUserResult, UserAdminDTO } from './types';

function toAdminDTO(u: UserRow, activeSessions: number, now: Date): UserAdminDTO {
  const role = roleOf(u.role);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role,
    roleLabel: roleLabel(role),
    active: u.active,
    mfaEnabled: u.mfaEnabled,
    mfaMissing: mustEnrollMfa(u),
    lockedUntil: u.lockedUntil && isAccountLocked(u.lockedUntil, now) ? u.lockedUntil.toISOString() : null,
    failedLoginCount: u.failedLoginCount,
    allowedIpRanges: Array.isArray(u.allowedIpRanges) ? u.allowedIpRanges : [],
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    passwordChangedAt: u.passwordChangedAt ? u.passwordChangedAt.toISOString() : null,
    temporaryPassword: u.passwordChangedAt === null,
    activeSessions,
    createdAt: u.createdAt.toISOString(),
  };
}

async function activeSessionCounts(db: DbOrTx, now: Date, userId?: string): Promise<Map<string, number>> {
  const r = await db.execute<{ user_id: string; n: number }>(sql`
    select user_id, count(*)::int as n from sessions
    where revoked_at is null and expires_at > ${now.toISOString()}::timestamptz ${userId ? sql`and user_id = ${userId}::uuid` : sql``}
    group by user_id
  `);
  return new Map(r.rows.map((x) => [x.user_id, Number(x.n)] as const));
}

async function adminDTO(db: DbOrTx, u: UserRow, now: Date): Promise<UserAdminDTO> {
  const counts = await activeSessionCounts(db, now, u.id);
  return toAdminDTO(u, counts.get(u.id) ?? 0, now);
}

function assertRole(role: unknown): Role {
  if (!isRole(role)) {
    throw new ValidationError('역할을 선택해 주세요. (관리자·팀장·담당자·조회 전용)', [{ field: 'role', message: 'admin | manager | staff | viewer' }]);
  }
  return role;
}

function cleanName(name: unknown): string {
  const s = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  if (s.length < 1 || s.length > 50) throw new ValidationError('이름을 1~50자로 입력해 주세요.', [{ field: 'name', message: '1~50자' }]);
  return s;
}

function cleanIpRanges(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ValidationError('허용 IP 는 목록으로 입력해 주세요.', [{ field: 'allowedIpRanges', message: 'array' }]);
  const { valid, errors } = validateCidrList(v.map((x) => String(x ?? '')));
  if (errors.length > 0) {
    throw new ValidationError(errors[0]!.message, errors.map((e) => ({ field: 'allowedIpRanges', message: e.message })));
  }
  return [...new Set(valid)].slice(0, 50);
}

async function countOtherActiveAdmins(db: DbOrTx, exceptUserId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.active, true), ne(users.id, exceptUserId)));
  return Number(r?.n ?? 0);
}

async function mustLoad(db: DbOrTx, userId: unknown): Promise<UserRow> {
  const u = typeof userId === 'string' && /^[0-9a-f-]{36}$/i.test(userId) ? await loadUserById(db, userId) : null;
  if (!u) throw new NotFoundError('사용자');
  return u;
}

/** 사용자 목록 (관리자) */
export async function listUsers(ctx: ServiceContext, input: { includeInactive?: boolean } = {}): Promise<UserAdminDTO[]> {
  requirePermission(ctx, 'users.manage');
  const now = ctx.now();
  const rows = await ctx.db
    .select()
    .from(users)
    .where(input.includeInactive === false ? eq(users.active, true) : undefined)
    .orderBy(sql`${users.active} desc`, users.name, users.id);
  const counts = await activeSessionCounts(ctx.db, now);
  return rows.map((u) => toAdminDTO(u, counts.get(u.id) ?? 0, now));
}

/** 사용자 생성 — 임시 비밀번호를 한 번만 돌려준다 (첫 로그인 후 변경 안내) */
export async function createUser(ctx: ServiceContext, input: CreateUserInput): Promise<CreatedUserResult> {
  requirePermission(ctx, 'users.manage');
  const email = normalizeEmail(input?.email);
  if (!isValidEmail(email)) throw new ValidationError('이메일 형식이 올바르지 않습니다. 예: kim@office.co.kr', [{ field: 'email', message: '이메일 형식' }]);
  const name = cleanName(input?.name);
  const role = assertRole(input?.role);
  const allowedIpRanges = cleanIpRanges(input?.allowedIpRanges);
  const existing = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing.length > 0) throw new ConflictError(`이미 등록된 이메일입니다: ${email}. 기존 사용자를 활성화하거나 다른 이메일을 입력하세요.`);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const now = ctx.now();
  const [row] = await ctx.db
    .insert(users)
    .values({ email, name, role, passwordHash, allowedIpRanges, active: true, passwordChangedAt: null, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (!row) throw new ConflictError(`이미 등록된 이메일입니다: ${email}.`);
  await writeAudit(ctx, {
    action: 'user.create',
    category: 'security',
    entityType: 'user',
    entityId: row.id,
    summary: `사용자 추가: ${name} (${email}) · ${ROLE_LABELS[role]}`,
    after: { email, name, role, allowedIpRanges },
  });
  return { user: toAdminDTO(row, 0, now), temporaryPassword };
}

/** 역할 변경 — 권한은 다음 요청부터 즉시 반영 (세션마다 역할에서 권한 계산) */
export async function updateUserRole(ctx: ServiceContext, input: { userId: string; role: Role }): Promise<UserAdminDTO> {
  requirePermission(ctx, 'users.manage');
  const role = assertRole(input?.role);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const u = await mustLoad(tx, input?.userId);
    if (u.role === role) return adminDTO(tx, u, now);
    if (u.role === 'admin' && u.active && (await countOtherActiveAdmins(tx, u.id)) === 0) {
      throw new ConflictError('마지막 관리자의 역할은 바꿀 수 없습니다. 다른 사용자를 먼저 관리자로 지정하세요.');
    }
    const [row] = await tx.update(users).set({ role, updatedAt: now }).where(eq(users.id, u.id)).returning();
    await writeAudit({ ...ctx, db: tx as unknown as typeof ctx.db }, {
      action: 'user.role_change',
      category: 'security',
      entityType: 'user',
      entityId: u.id,
      summary: `${u.name} 역할 변경: ${roleLabel(u.role)} → ${ROLE_LABELS[role]}`,
      before: { role: u.role },
      after: { role },
      revertible: false,
    });
    return adminDTO(tx, row!, now);
  });
}

/** 계정 비활성화 — 로그인 차단 + 모든 세션 폐기 (데이터·감사 이력은 보존) */
export async function deactivateUser(ctx: ServiceContext, input: { userId: string; reason?: string }): Promise<UserAdminDTO> {
  requirePermission(ctx, 'users.manage');
  const now = ctx.now();
  const reason = typeof input?.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  return ctx.db.transaction(async (tx) => {
    const u = await mustLoad(tx, input?.userId);
    if (u.id === ctx.actor.userId) throw new ConflictError('자기 자신은 비활성화할 수 없습니다. 다른 관리자에게 요청하세요.');
    if (!u.active) return adminDTO(tx, u, now);
    if (u.role === 'admin' && (await countOtherActiveAdmins(tx, u.id)) === 0) {
      throw new ConflictError('마지막 관리자는 비활성화할 수 없습니다. 다른 사용자를 먼저 관리자로 지정하세요.');
    }
    const [row] = await tx.update(users).set({ active: false, updatedAt: now }).where(eq(users.id, u.id)).returning();
    const revoked = await revokeUserSessions(tx, u.id, now);
    await writeAudit({ ...ctx, db: tx as unknown as typeof ctx.db }, {
      action: 'user.deactivate',
      category: 'security',
      entityType: 'user',
      entityId: u.id,
      summary: `${u.name} 계정 사용 중지${reason ? ` (사유: ${reason})` : ''} · 세션 ${revoked}개 로그아웃`,
      before: { active: true },
      after: { active: false, reason: reason || null },
    });
    return adminDTO(tx, row!, now);
  });
}

/** 계정 다시 사용 */
export async function reactivateUser(ctx: ServiceContext, input: { userId: string }): Promise<UserAdminDTO> {
  requirePermission(ctx, 'users.manage');
  const now = ctx.now();
  const u = await mustLoad(ctx.db, input?.userId);
  if (u.active) return adminDTO(ctx.db, u, now);
  const [row] = await ctx.db.update(users).set({ active: true, failedLoginCount: 0, lockedUntil: null, updatedAt: now }).where(eq(users.id, u.id)).returning();
  await writeAudit(ctx, {
    action: 'user.reactivate',
    category: 'security',
    entityType: 'user',
    entityId: u.id,
    summary: `${u.name} 계정 다시 사용`,
    before: { active: false },
    after: { active: true },
  });
  return adminDTO(ctx.db, row!, now);
}

/** 로그인 잠금 해제 */
export async function unlockUser(ctx: ServiceContext, input: { userId: string }): Promise<UserAdminDTO> {
  requirePermission(ctx, 'users.manage');
  const now = ctx.now();
  const u = await mustLoad(ctx.db, input?.userId);
  const [row] = await ctx.db.update(users).set({ failedLoginCount: 0, lockedUntil: null, updatedAt: now }).where(eq(users.id, u.id)).returning();
  await writeAudit(ctx, {
    action: 'user.unlock',
    category: 'security',
    entityType: 'user',
    entityId: u.id,
    summary: `${u.name} 로그인 잠금 해제 (실패 ${u.failedLoginCount}회 초기화)`,
    before: { failedLoginCount: u.failedLoginCount, lockedUntil: u.lockedUntil ? u.lockedUntil.toISOString() : null },
    after: { failedLoginCount: 0, lockedUntil: null },
  });
  return adminDTO(ctx.db, row!, now);
}

/** 허용 IP 대역 변경 (빈 목록 = 제한 없음) */
export async function updateUserAllowedIps(ctx: ServiceContext, input: { userId: string; allowedIpRanges: string[] }): Promise<UserAdminDTO> {
  requirePermission(ctx, 'users.manage');
  const ranges = cleanIpRanges(input?.allowedIpRanges);
  const now = ctx.now();
  const u = await mustLoad(ctx.db, input?.userId);
  const [row] = await ctx.db.update(users).set({ allowedIpRanges: ranges, updatedAt: now }).where(eq(users.id, u.id)).returning();
  await writeAudit(ctx, {
    action: 'user.allowed_ips',
    category: 'security',
    entityType: 'user',
    entityId: u.id,
    summary: `${u.name} 허용 IP 변경: ${(u.allowedIpRanges ?? []).join(', ') || '제한 없음'} → ${ranges.join(', ') || '제한 없음'}`,
    before: { allowedIpRanges: u.allowedIpRanges ?? [] },
    after: { allowedIpRanges: ranges },
  });
  return adminDTO(ctx.db, row!, now);
}
