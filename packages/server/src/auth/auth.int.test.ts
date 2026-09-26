import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.MINTAX_DATA_KEY ??= Buffer.alloc(32, 21).toString('base64');
process.env.MINTAX_INDEX_KEY ??= Buffer.alloc(32, 23).toString('base64');

import { and, desc, eq } from 'drizzle-orm';
import { auditLogs, closeDb, getPool, loginHistory, sessions, setupTestDatabase, users, type Database } from '@mintax/db';
import {
  AccountLockedError,
  AppError,
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  InvalidCredentialsError,
  InvalidMfaCodeError,
  IpNotAllowedError,
  RateLimitError,
  ValidationError,
  generateTotp,
  hashPassword,
} from '@mintax/security';
import { createContext } from '../context';
import {
  buildActor,
  changePassword,
  checkSession,
  confirmMfa,
  createUser,
  deactivateUser,
  disableMfa,
  enrollMfa,
  listSessions,
  listUsers,
  login,
  logout,
  reactivateUser,
  resetLoginRateLimits,
  resetUserPassword,
  revokeAllSessions,
  unlockUser,
  updateUserAllowedIps,
  updateUserRole,
  validateSession,
  verifyMfa,
} from './index';

const DB_URL = process.env.DATABASE_URL_TEST ?? 'postgres://mintax:mintax_dev@localhost:5432/mintax_test_platform';
const PASSWORD = 'Office!Pass2026';
const T0 = new Date('2026-09-26T00:00:00.000Z');
const at = (ms: number) => () => new Date(T0.getTime() + ms);
const MIN = 60_000;
const ENV = { MFA_REQUIRED_FOR_ADMIN: 'true', SESSION_IDLE_MINUTES: '30', SESSION_ABSOLUTE_HOURS: '12' };

let db: Database;
let unlock: (() => Promise<void>) | null = null;
let seq = 0;

async function makeUser(opts: { role?: 'admin' | 'manager' | 'staff' | 'viewer'; allowedIpRanges?: string[]; active?: boolean; name?: string } = {}) {
  seq += 1;
  const email = `auth${seq}@office.test`;
  const [u] = await db
    .insert(users)
    .values({
      email,
      name: opts.name ?? `직원${seq}`,
      passwordHash: await hashPassword(PASSWORD),
      role: opts.role ?? 'staff',
      allowedIpRanges: opts.allowedIpRanges ?? [],
      active: opts.active ?? true,
      passwordChangedAt: T0,
    })
    .returning();
  return u!;
}

async function expectErr<T extends AppError>(p: Promise<unknown>, cls: new (...a: never[]) => T, code?: string): Promise<T> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(cls);
    if (code) expect((e as AppError).code).toBe(code);
    return e as T;
  }
  throw new Error(`expected ${cls.name}`);
}

/** 가장 최근 시각에 기록된 결과 코드들 (같은 시각 여러 행이면 모두) */
async function latestResults(email: string): Promise<string[]> {
  const rows = await db.select({ r: loginHistory.result, c: loginHistory.createdAt }).from(loginHistory).where(eq(loginHistory.email, email)).orderBy(desc(loginHistory.createdAt));
  const top = rows[0]?.c.getTime();
  return rows.filter((x) => x.c.getTime() === top).map((x) => x.r);
}

async function historyResults(email: string): Promise<string[]> {
  const rows = await db.select({ r: loginHistory.result, c: loginHistory.createdAt }).from(loginHistory).where(eq(loginHistory.email, email));
  return rows.map((r) => r.r);
}

beforeAll(async () => {
  const client = await getPool(DB_URL).connect();
  await client.query('select pg_advisory_lock(727274801)');
  unlock = async () => {
    try {
      await client.query('select pg_advisory_unlock(727274801)');
    } finally {
      client.release();
    }
  };
  db = await setupTestDatabase(DB_URL);
});

afterAll(async () => {
  await unlock?.();
  await closeDb();
});

beforeEach(() => resetLoginRateLimits());

describe('login', () => {
  it('succeeds, stores only the token hash, records history and a security audit', async () => {
    const u = await makeUser();
    const r = await login(db, { email: `  ${u.email.toUpperCase()} `, password: PASSWORD, ip: '203.0.113.7', userAgent: 'vitest' }, { now: at(0), env: ENV });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.user.email).toBe(u.email);
    expect(r.user.permissions).toContain('transactions.review');
    expect(r.mustEnrollMfa).toBe(false);
    expect(r.mustChangePassword).toBe(false);
    const [s] = await db.select().from(sessions).where(eq(sessions.id, r.sessionId));
    expect(s!.tokenHash).not.toBe(r.sessionToken);
    expect(s!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await latestResults(u.email)).toContain('success');
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'auth.login'), eq(auditLogs.entityId, u.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.category).toBe('security');
    expect(audit[0]!.actorId).toBe(u.id);
    expect(audit[0]!.ip).toBe('203.0.113.7');
    expect(JSON.stringify(audit[0])).not.toContain(r.sessionToken);

    const v = await validateSession(db, r.sessionToken, { ip: '203.0.113.7' }, { now: at(5 * MIN), env: ENV });
    expect(v?.user.id).toBe(u.id);
    expect(v?.actor.permissions.has('transactions.review')).toBe(true);
    expect(v?.actor.sessionId).toBe(r.sessionId);
  });

  it('rejects wrong password and unknown email with the same message, recording result codes', async () => {
    const u = await makeUser();
    const e1 = await expectErr(login(db, { email: u.email, password: 'wrong-Password1', ip: '198.51.100.1' }, { now: at(0), env: ENV }), InvalidCredentialsError);
    const e2 = await expectErr(login(db, { email: 'nobody@office.test', password: 'wrong-Password1', ip: '198.51.100.1' }, { now: at(0), env: ENV }), InvalidCredentialsError);
    expect(e1.userMessage).toBe(e2.userMessage);
    expect(await latestResults(u.email)).toContain('bad_password');
    expect(await latestResults('nobody@office.test')).toContain('unknown_user');
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.failedLoginCount).toBe(1);
    await expectErr(login(db, { email: u.email, password: '' }, { now: at(0), env: ENV }), ValidationError);
  });

  it('locks the account after 5 failures for 15 minutes, audits the lock, and unlocks afterwards', async () => {
    const u = await makeUser();
    for (let i = 0; i < 4; i++) {
      await expectErr(login(db, { email: u.email, password: `bad-Pass${i}xx`, ip: '198.51.100.2' }, { now: at(i * 1000), env: ENV }), InvalidCredentialsError);
    }
    const locked = await expectErr(login(db, { email: u.email, password: 'bad-Pass5xx', ip: '198.51.100.2' }, { now: at(5000), env: ENV }), AccountLockedError);
    expect(locked.userMessage).toMatch(/잠겼습니다/);
    // 올바른 비밀번호라도 잠금 중 (다른 IP — 속도 제한과 구분)
    await expectErr(login(db, { email: u.email, password: PASSWORD, ip: '198.51.100.3' }, { now: at(10 * MIN), env: ENV }), AccountLockedError);
    expect(await latestResults(u.email)).toContain('locked');
    const lockAudit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'auth.account_locked'), eq(auditLogs.entityId, u.id)));
    expect(lockAudit).toHaveLength(1);
    expect(lockAudit[0]!.category).toBe('security');
    // 15분 뒤 성공 → 실패횟수 초기화
    const ok = await login(db, { email: u.email, password: PASSWORD, ip: '198.51.100.3' }, { now: at(16 * MIN), env: ENV });
    expect(ok.status).toBe('ok');
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.failedLoginCount).toBe(0);
    expect(row!.lockedUntil).toBeNull();
  });

  it('rate-limits per email+ip (5 failures / 15 min) without affecting other IPs', async () => {
    const email = 'ghost@office.test';
    for (let i = 0; i < 5; i++) {
      await expectErr(login(db, { email, password: 'Whatever!123', ip: '192.0.2.10' }, { now: at(i * 1000), env: ENV }), InvalidCredentialsError);
    }
    const rl = await expectErr(login(db, { email, password: 'Whatever!123', ip: '192.0.2.10' }, { now: at(6000), env: ENV }), RateLimitError);
    expect(rl.retryAfterSeconds).toBeGreaterThan(0);
    expect(await latestResults(email)).toContain('rate_limited');
    await expectErr(login(db, { email, password: 'Whatever!123', ip: '192.0.2.11' }, { now: at(7000), env: ENV }), InvalidCredentialsError);
    // 창이 지나면 다시 허용
    await expectErr(login(db, { email, password: 'Whatever!123', ip: '192.0.2.10' }, { now: at(16 * MIN), env: ENV }), InvalidCredentialsError);
  });

  it('blocks logins and sessions from IPs outside allowedIpRanges', async () => {
    const u = await makeUser({ allowedIpRanges: ['10.0.0.0/8'] });
    await expectErr(login(db, { email: u.email, password: PASSWORD, ip: '203.0.113.99' }, { now: at(0), env: ENV }), IpNotAllowedError);
    expect(await latestResults(u.email)).toContain('ip_blocked');
    const blockAudit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'auth.ip_blocked'), eq(auditLogs.entityId, u.id)));
    expect(blockAudit).toHaveLength(1);
    const ok = await login(db, { email: u.email, password: PASSWORD, ip: '10.1.2.3' }, { now: at(0), env: ENV });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    expect(await validateSession(db, ok.sessionToken, { ip: '10.9.9.9' }, { now: at(MIN), env: ENV })).not.toBeNull();
    const c = await checkSession(db, ok.sessionToken, { ip: '8.8.8.8' }, { now: at(MIN), env: ENV });
    expect(c).toEqual({ ok: false, reason: 'ip_blocked' });
  });

  it('refuses inactive users only after a correct password', async () => {
    const u = await makeUser({ active: false });
    await expectErr(login(db, { email: u.email, password: 'nope-Nope123' }, { now: at(0), env: ENV }), InvalidCredentialsError);
    await expectErr(login(db, { email: u.email, password: PASSWORD }, { now: at(1000), env: ENV }), AuthenticationError, 'ACCOUNT_INACTIVE');
    expect(await latestResults(u.email)).toContain('inactive');
  });

  it('lets an admin without MFA log in but flags mandatory enrollment', async () => {
    const admin = await makeUser({ role: 'admin' });
    const r = await login(db, { email: admin.email, password: PASSWORD }, { now: at(0), env: ENV });
    expect(r.status === 'ok' && r.mustEnrollMfa).toBe(true);
    const r2 = await login(db, { email: admin.email, password: PASSWORD }, { now: at(0), env: { ...ENV, MFA_REQUIRED_FOR_ADMIN: 'false' } });
    expect(r2.status === 'ok' && r2.mustEnrollMfa).toBe(false);
  });
});

describe('MFA', () => {
  it('enrolls, requires OTP at login, rejects wrong/replayed codes, accepts recovery codes once', async () => {
    const u = await makeUser({ role: 'admin' });
    const first = await login(db, { email: u.email, password: PASSWORD, ip: '203.0.113.20' }, { now: at(0), env: ENV });
    if (first.status !== 'ok') throw new Error('expected ok');
    const v = (await validateSession(db, first.sessionToken, { ip: '203.0.113.20' }, { now: at(0), env: ENV }))!;
    const ctx = createContext(db, v.actor, at(MIN));
    const enrollment = await enrollMfa(ctx);
    expect(enrollment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const [pending] = await db.select().from(users).where(eq(users.id, u.id));
    expect(pending!.mfaEnabled).toBe(false);
    expect(pending!.mfaSecretEnc).not.toContain(enrollment.secret);
    await expectErr(confirmMfa(ctx, { code: '000000' }), InvalidMfaCodeError);
    const conf = await confirmMfa(ctx, { code: generateTotp(enrollment.secret, at(MIN)()) });
    expect(conf.recoveryCodes).toHaveLength(10);
    // 확인에 쓴 세션은 OTP 인증된 세션으로 유지
    expect(await validateSession(db, first.sessionToken, { ip: '203.0.113.20' }, { now: at(2 * MIN), env: ENV })).not.toBeNull();

    const step1 = await login(db, { email: u.email, password: PASSWORD, ip: '203.0.113.20' }, { now: at(5 * MIN), env: ENV });
    expect(step1.status).toBe('mfa_required');
    if (step1.status !== 'mfa_required') return;
    expect(await latestResults(u.email)).toContain('password_ok_mfa_required');

    await expectErr(verifyMfa(db, { challengeToken: step1.challengeToken, code: '123456', ip: '203.0.113.20' }, { now: at(5 * MIN), env: ENV }), InvalidMfaCodeError);
    expect(await latestResults(u.email)).toContain('mfa_failed');
    await expectErr(verifyMfa(db, { challengeToken: `${step1.challengeToken.slice(0, -2)}AA`, code: '123456' }, { now: at(5 * MIN), env: ENV }), AuthenticationError, 'MFA_CHALLENGE_INVALID');
    await expectErr(verifyMfa(db, { challengeToken: step1.challengeToken, code: '123456' }, { now: at(11 * MIN), env: ENV }), AuthenticationError, 'MFA_CHALLENGE_EXPIRED');

    const code = generateTotp(enrollment.secret, at(5 * MIN)());
    const ok = await verifyMfa(db, { challengeToken: step1.challengeToken, code, ip: '203.0.113.20' }, { now: at(5 * MIN), env: ENV });
    expect(ok.status).toBe('ok');
    expect(ok.mustEnrollMfa).toBe(false);
    const [s] = await db.select().from(sessions).where(eq(sessions.id, ok.sessionId));
    expect(s!.mfaVerified).toBe(true);

    // 같은 코드 재사용 → 거부 (새 챌린지로 시도)
    const step2 = await login(db, { email: u.email, password: PASSWORD, ip: '203.0.113.20' }, { now: at(5 * MIN + 10_000), env: ENV });
    if (step2.status !== 'mfa_required') throw new Error('expected mfa');
    await expectErr(verifyMfa(db, { challengeToken: step2.challengeToken, code, ip: '203.0.113.20' }, { now: at(5 * MIN + 11_000), env: ENV }), InvalidMfaCodeError);
    expect(await latestResults(u.email)).toContain('mfa_replayed');
    // 사용된 챌린지(봉투 변경) 재사용 불가
    await expectErr(verifyMfa(db, { challengeToken: step1.challengeToken, code: generateTotp(enrollment.secret, at(6 * MIN)()) }, { now: at(6 * MIN), env: ENV }), AuthenticationError, 'MFA_CHALLENGE_INVALID');

    // 복구 코드 1회 사용
    const step3 = await login(db, { email: u.email, password: PASSWORD, ip: '203.0.113.20' }, { now: at(7 * MIN), env: ENV });
    if (step3.status !== 'mfa_required') throw new Error('expected mfa');
    const rec = await verifyMfa(db, { challengeToken: step3.challengeToken, code: conf.recoveryCodes[0]!.toLowerCase(), ip: '203.0.113.20' }, { now: at(7 * MIN), env: ENV });
    expect(rec.status).toBe('ok');
    expect(await latestResults(u.email)).toContain('success_recovery_code');
    const step4 = await login(db, { email: u.email, password: PASSWORD, ip: '203.0.113.20' }, { now: at(8 * MIN), env: ENV });
    if (step4.status !== 'mfa_required') throw new Error('expected mfa');
    await expectErr(verifyMfa(db, { challengeToken: step4.challengeToken, code: conf.recoveryCodes[0]!, ip: '203.0.113.20' }, { now: at(8 * MIN), env: ENV }), InvalidMfaCodeError);

    // 관리자 초기화 → 세션 전부 폐기, 다음 로그인은 등록 강제 플래그
    const other = await makeUser({ role: 'admin', name: '대표' });
    const octx = createContext(db, buildActor(other), at(9 * MIN));
    const reset = await disableMfa(octx, { userId: u.id, reason: '휴대폰 분실' });
    expect(reset.disabled).toBe(true);
    expect(reset.revokedSessions).toBeGreaterThanOrEqual(2);
    expect(await validateSession(db, ok.sessionToken, {}, { now: at(9 * MIN), env: ENV })).toBeNull();
    resetLoginRateLimits();
    const after = await login(db, { email: u.email, password: PASSWORD }, { now: at(10 * MIN), env: ENV });
    expect(after.status === 'ok' && after.mustEnrollMfa).toBe(true);

    const actions = (await db.select({ a: auditLogs.action, c: auditLogs.category }).from(auditLogs).where(eq(auditLogs.entityId, u.id))).map((r) => `${r.c}:${r.a}`);
    expect(actions).toEqual(expect.arrayContaining(['security:auth.mfa_enroll_start', 'security:auth.mfa_enabled', 'security:auth.mfa_reset', 'security:auth.login']));
    const all = JSON.stringify(await db.select().from(auditLogs));
    expect(all).not.toContain(enrollment.secret);
    expect(all).not.toContain(conf.recoveryCodes[1]!);
  });

  it('invalidates non-OTP sessions after MFA is enabled (except the confirming session)', async () => {
    const u = await makeUser();
    const a = await login(db, { email: u.email, password: PASSWORD }, { now: at(0), env: ENV });
    const b = await login(db, { email: u.email, password: PASSWORD }, { now: at(0), env: ENV });
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('expected ok');
    const va = (await validateSession(db, a.sessionToken, {}, { now: at(0), env: ENV }))!;
    const ctx = createContext(db, va.actor, at(MIN));
    const e = await enrollMfa(ctx);
    await confirmMfa(ctx, { code: generateTotp(e.secret, at(MIN)()) });
    await expectErr(enrollMfa(ctx), ConflictError);
    expect(await validateSession(db, a.sessionToken, {}, { now: at(2 * MIN), env: ENV })).not.toBeNull();
    expect(await checkSession(db, b.sessionToken, {}, { now: at(2 * MIN), env: ENV })).toEqual({ ok: false, reason: 'mfa_pending' });
  });
});

describe('sessions', () => {
  it('expires after idle time, touches lastSeenAt at most once a minute, and after absolute lifetime', async () => {
    const u = await makeUser();
    const r = await login(db, { email: u.email, password: PASSWORD }, { now: at(0), env: ENV });
    if (r.status !== 'ok') throw new Error('expected ok');
    await validateSession(db, r.sessionToken, {}, { now: at(30_000), env: ENV });
    let [s] = await db.select().from(sessions).where(eq(sessions.id, r.sessionId));
    expect(s!.lastSeenAt.getTime()).toBe(T0.getTime()); // 1분 안 → 갱신 안 함
    await validateSession(db, r.sessionToken, {}, { now: at(20 * MIN), env: ENV });
    [s] = await db.select().from(sessions).where(eq(sessions.id, r.sessionId));
    expect(s!.lastSeenAt.getTime()).toBe(T0.getTime() + 20 * MIN);
    expect(await validateSession(db, r.sessionToken, {}, { now: at(49 * MIN), env: ENV })).not.toBeNull();
    expect(await checkSession(db, r.sessionToken, {}, { now: at(49 * MIN + 31 * MIN), env: ENV })).toEqual({ ok: false, reason: 'idle' });

    const short = { ...ENV, SESSION_ABSOLUTE_HOURS: '1' };
    const r2 = await login(db, { email: u.email, password: PASSWORD }, { now: at(0), env: short });
    if (r2.status !== 'ok') throw new Error('expected ok');
    for (const m of [20, 40, 59]) expect(await validateSession(db, r2.sessionToken, {}, { now: at(m * MIN), env: short })).not.toBeNull();
    expect(await checkSession(db, r2.sessionToken, {}, { now: at(61 * MIN), env: short })).toEqual({ ok: false, reason: 'absolute' });
    expect(await checkSession(db, 'not-a-token', {}, { now: at(0), env: ENV })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('logout revokes, revokeAllSessions keeps the current one, listSessions shows active sessions', async () => {
    const u = await makeUser();
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await login(db, { email: u.email, password: PASSWORD, ip: `203.0.113.${40 + i}`, userAgent: `UA${i}` }, { now: at(i * 1000), env: ENV });
      if (r.status !== 'ok') throw new Error('expected ok');
      tokens.push(r.sessionToken);
    }
    const v = (await validateSession(db, tokens[0], {}, { now: at(5000), env: ENV }))!;
    const ctx = createContext(db, v.actor, at(6000));
    const list = await listSessions(ctx);
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect((await logout(db, tokens[2], { ip: '203.0.113.42' }, { now: at(7000) })).revoked).toBe(true);
    expect(await validateSession(db, tokens[2], {}, { now: at(8000), env: ENV })).toBeNull();
    expect((await revokeAllSessions(ctx, u.id)).revoked).toBe(1);
    expect(await validateSession(db, tokens[1], {}, { now: at(9000), env: ENV })).toBeNull();
    expect(await validateSession(db, tokens[0], {}, { now: at(9000), env: ENV })).not.toBeNull();
    const other = await makeUser();
    await expectErr(revokeAllSessions(ctx, other.id), ForbiddenError);
    const acts = (await db.select({ a: auditLogs.action }).from(auditLogs).where(eq(auditLogs.actorId, u.id))).map((r) => r.a);
    expect(acts).toEqual(expect.arrayContaining(['auth.logout', 'auth.sessions_revoked']));
  });
});

describe('password & user management', () => {
  it('changes password with policy checks, revokes other sessions, never audits the password', async () => {
    const u = await makeUser();
    const a = await login(db, { email: u.email, password: PASSWORD }, { now: at(0), env: ENV });
    const b = await login(db, { email: u.email, password: PASSWORD }, { now: at(0), env: ENV });
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('expected ok');
    const v = (await validateSession(db, a.sessionToken, {}, { now: at(0), env: ENV }))!;
    const ctx = createContext(db, v.actor, at(MIN));
    await expectErr(changePassword(ctx, { currentPassword: 'wrong', newPassword: 'NewPass!2026x' }), ValidationError);
    const weak = await expectErr(changePassword(ctx, { currentPassword: PASSWORD, newPassword: 'short' }), ValidationError);
    expect(weak.fieldErrors.length).toBeGreaterThan(0);
    await expectErr(changePassword(ctx, { currentPassword: PASSWORD, newPassword: PASSWORD }), ValidationError);
    const res = await changePassword(ctx, { currentPassword: PASSWORD, newPassword: 'NewPass!2026x' });
    expect(res.revokedSessions).toBe(1);
    expect(await validateSession(db, a.sessionToken, {}, { now: at(2 * MIN), env: ENV })).not.toBeNull();
    expect(await validateSession(db, b.sessionToken, {}, { now: at(2 * MIN), env: ENV })).toBeNull();
    await expectErr(login(db, { email: u.email, password: PASSWORD }, { now: at(3 * MIN), env: ENV }), InvalidCredentialsError);
    expect((await login(db, { email: u.email, password: 'NewPass!2026x' }, { now: at(3 * MIN), env: ENV })).status).toBe('ok');
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, 'auth.password_change'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe('security');
    expect(JSON.stringify(rows)).not.toContain('NewPass!2026x');
    expect(JSON.stringify(rows)).not.toContain('scrypt$');
  });

  it('admin creates users with a temporary password, changes roles, deactivates and protects the last admin', async () => {
    await db.update(users).set({ active: false }).where(eq(users.role, 'admin'));
    const admin = await makeUser({ role: 'admin', name: '김관리' });
    const actx = createContext(db, buildActor(admin), at(0));
    const staffRow = await makeUser({ role: 'staff' });
    await expectErr(createUser(createContext(db, buildActor(staffRow), at(0)), { email: 'x@office.test', name: 'X', role: 'staff' }), ForbiddenError);

    const created = await createUser(actx, { email: 'New.Staff@Office.test', name: '박담당', role: 'staff', allowedIpRanges: ['203.0.113.0/24'] });
    expect(created.user.email).toBe('new.staff@office.test');
    expect(created.user.temporaryPassword).toBe(true);
    expect(created.temporaryPassword.length).toBeGreaterThanOrEqual(12);
    await expectErr(createUser(actx, { email: 'new.staff@office.test', name: '중복', role: 'staff' }), ConflictError);
    await expectErr(createUser(actx, { email: 'bad', name: 'x', role: 'staff' }), ValidationError);
    await expectErr(createUser(actx, { email: 'ok@office.test', name: 'x', role: 'staff', allowedIpRanges: ['999.1.1.1'] }), ValidationError);

    const first = await login(db, { email: 'new.staff@office.test', password: created.temporaryPassword, ip: '203.0.113.9' }, { now: at(MIN), env: ENV });
    expect(first.status === 'ok' && first.mustChangePassword).toBe(true);

    const promoted = await updateUserRole(actx, { userId: created.user.id, role: 'manager' });
    expect(promoted.role).toBe('manager');
    if (first.status !== 'ok') return;
    const v = await validateSession(db, first.sessionToken, { ip: '203.0.113.9' }, { now: at(2 * MIN), env: ENV });
    expect(v?.actor.permissions.has('rules.approve')).toBe(true);

    await expectErr(updateUserRole(actx, { userId: admin.id, role: 'staff' }), ConflictError);
    await expectErr(deactivateUser(actx, { userId: admin.id }), ConflictError);

    const opened = await updateUserAllowedIps(actx, { userId: created.user.id, allowedIpRanges: [] });
    expect(opened.allowedIpRanges).toEqual([]);
    const off = await deactivateUser(actx, { userId: created.user.id, reason: '퇴사' });
    expect(off.active).toBe(false);
    expect(await validateSession(db, first.sessionToken, {}, { now: at(3 * MIN), env: ENV })).toBeNull();
    await expectErr(login(db, { email: 'new.staff@office.test', password: created.temporaryPassword }, { now: at(4 * MIN), env: ENV }), AuthenticationError, 'ACCOUNT_INACTIVE');
    await reactivateUser(actx, { userId: created.user.id });

    const reset = await resetUserPassword(actx, { userId: staffRow.id });
    expect((await login(db, { email: staffRow.email, password: reset.temporaryPassword }, { now: at(5 * MIN), env: ENV })).status).toBe('ok');

    await db.update(users).set({ failedLoginCount: 5, lockedUntil: new Date(T0.getTime() + 60 * MIN) }).where(eq(users.id, staffRow.id));
    const unlocked = await unlockUser(actx, { userId: staffRow.id });
    expect(unlocked.lockedUntil).toBeNull();

    const list = await listUsers(actx);
    const mine = list.find((x) => x.id === created.user.id)!;
    expect(mine.roleLabel).toBe('팀장');
    expect(list.find((x) => x.id === admin.id)!.mfaMissing).toBe(true);

    const acts = (await db.select({ a: auditLogs.action, c: auditLogs.category }).from(auditLogs).where(eq(auditLogs.actorId, admin.id))).map((r) => r.a);
    expect(acts).toEqual(expect.arrayContaining(['user.create', 'user.role_change', 'user.deactivate', 'user.reactivate', 'auth.password_reset', 'user.unlock', 'user.allowed_ips']));
    const dump = JSON.stringify(await db.select().from(auditLogs));
    expect(dump).not.toContain(created.temporaryPassword);
    expect(dump).not.toContain(reset.temporaryPassword);
    expect(await historyResults('new.staff@office.test')).toContain('inactive');
  });
});
