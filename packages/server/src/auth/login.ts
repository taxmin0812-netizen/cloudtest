/**
 * 로그인 · MFA 검증.
 *
 * 순서 (login)
 *  1. 이메일+IP 속도 제한 (실패 5회/15분, 프로세스 메모리) → rate_limited
 *  2. 사용자 조회 — 없으면 더미 scrypt 로 시간을 맞추고 unknown_user
 *  3. 계정 잠금(locked_until) → locked (AccountLockedError)
 *  4. 허용 IP (users.allowed_ip_ranges) → ip_blocked — 외부에서의 비밀번호 대입 자체를 막기 위해 비밀번호 확인 전에 검사
 *  5. 비밀번호 (scrypt) 실패 → failed_login_count 원자적 증가, 5회면 15분 잠금 (AccountLockedError)
 *  6. 비활성 계정 → inactive
 *  7. MFA 등록자 → 챌린지 토큰 발급 (password_ok_mfa_required), verifyMfa 에서 세션 발급
 *  8. 성공 → 실패횟수 초기화, 세션 생성(해시만 저장), login_history + 감사로그(security)
 *
 * 모든 시도는 login_history 에 결과 코드와 함께 남는다. 비밀번호·토큰·OTP 는 어디에도 기록하지 않는다.
 */
import { and, eq, sql } from 'drizzle-orm';
import { users, type Database, type DbOrTx } from '@mintax/db';
import {
  AccountLockedError,
  AuthenticationError,
  InvalidCredentialsError,
  InvalidMfaCodeError,
  IpNotAllowedError,
  LOGIN_RATE_LIMIT_MESSAGE,
  RateLimitError,
  ValidationError,
  getLockoutPolicy,
  hashPassword,
  isAccountLocked,
  isIpAllowed,
  loginRateLimitKey,
  needsRehash,
  verifyPassword,
  verifyPasswordDummy,
  verifyRecoveryCode,
  verifyTotp,
} from '@mintax/security';
import { writeAudit } from '../infra/audit';
import {
  MFA_CHALLENGE_TTL_MS,
  buildActor,
  challengeBinding,
  decodeMfaEnvelope,
  encodeMfaEnvelope,
  isChallengeExpired,
  loginLimiterAt,
  looksLikeRecoveryCode,
  mustEnrollMfa,
  normalizeEmail,
  parseMfaChallenge,
  signMfaChallenge,
  verifyMfaChallengeSig,
  type Env,
  type LoginResultCode,
  type MfaEnvelope,
} from './helpers';
import { authContext, envOf, insertSession, loadUserByEmail, loadUserById, nowOf, recordLoginAttempt, toAuthUserDTO, type UserRow } from './shared';
import type { AuthOptions, AuthRequestMeta, LoginInput, LoginResult, VerifyMfaInput } from './types';

type OkResult = Extract<LoginResult, { status: 'ok' }>;

function metaOf(input: AuthRequestMeta | null | undefined): AuthRequestMeta {
  return { ip: input?.ip ?? null, userAgent: input?.userAgent ?? null };
}

function challengeError(expired: boolean): AuthenticationError {
  return new AuthenticationError(
    expired
      ? '인증 코드 입력 시간(5분)이 지났습니다. 처음부터 다시 로그인해 주세요.'
      : '인증 단계 정보가 올바르지 않거나 이미 사용되었습니다. 처음부터 다시 로그인해 주세요.',
    expired ? 'MFA_CHALLENGE_EXPIRED' : 'MFA_CHALLENGE_INVALID',
  );
}

/** 실패 1회를 원자적으로 반영 (동시 실패도 정확히 센다). 잠금 여부 반환 */
async function registerFailure(db: DbOrTx, userId: string, now: Date, env: Env): Promise<{ failedLoginCount: number; lockedUntil: Date | null; locked: boolean }> {
  const policy = getLockoutPolicy(env);
  const nowIso = now.toISOString();
  const r = await db.execute<{ failed_login_count: number; locked_until: Date | string | null }>(sql`
    update users set
      failed_login_count = case when locked_until is not null and locked_until <= ${nowIso}::timestamptz then 1 else failed_login_count + 1 end,
      locked_until = case
        when (case when locked_until is not null and locked_until <= ${nowIso}::timestamptz then 1 else failed_login_count + 1 end) >= ${policy.maxFailedAttempts}::int
          then ${nowIso}::timestamptz + make_interval(mins => ${policy.lockMinutes}::int)
        when locked_until is not null and locked_until <= ${nowIso}::timestamptz then null
        else locked_until end,
      updated_at = ${nowIso}::timestamptz
    where id = ${userId}::uuid
    returning failed_login_count, locked_until
  `);
  const row = r.rows[0];
  const lockedUntil = row?.locked_until ? new Date(row.locked_until) : null;
  return { failedLoginCount: Number(row?.failed_login_count ?? 0), lockedUntil, locked: isAccountLocked(lockedUntil, now) };
}

async function auditLockout(db: Database, user: UserRow, meta: AuthRequestMeta, now: Date, lockedUntil: Date, via: string): Promise<void> {
  await writeAudit(authContext(db, null, meta, now), {
    action: 'auth.account_locked',
    category: 'security',
    entityType: 'user',
    entityId: user.id,
    summary: `${user.name}(${user.email}) 계정 잠금 — ${via} 연속 실패, ${lockedUntil.toISOString()} 까지`,
    after: { lockedUntil: lockedUntil.toISOString(), via },
  });
}

/** 성공 처리: 실패 초기화 + 세션 + login_history + 감사로그 (한 트랜잭션) */
async function completeLogin(
  db: Database,
  user: UserRow,
  meta: AuthRequestMeta,
  now: Date,
  env: Env,
  opts: { mfaVerified: boolean; result: LoginResultCode; beforeCommit?: (tx: DbOrTx) => Promise<boolean> },
): Promise<OkResult> {
  const out = await db.transaction(async (tx) => {
    if (opts.beforeCommit && !(await opts.beforeCommit(tx))) return null;
    await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now }).where(eq(users.id, user.id));
    const s = await insertSession(tx, { userId: user.id, meta, mfaVerified: opts.mfaVerified, at: now, env });
    await recordLoginAttempt(tx, { userId: user.id, email: user.email, result: opts.result, meta, at: now });
    const actor = buildActor(user, { id: s.sessionId, ip: meta.ip, userAgent: meta.userAgent });
    await writeAudit(authContext(tx as unknown as Database, actor, meta, now), {
      action: 'auth.login',
      category: 'security',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.name} 로그인${opts.mfaVerified ? ' (OTP 인증)' : ''}${opts.result === 'success_recovery_code' ? ' — 복구 코드 사용' : ''}${meta.ip ? ` · ${meta.ip}` : ''}`,
      after: { sessionId: s.sessionId, mfaVerified: opts.mfaVerified, recoveryCodeUsed: opts.result === 'success_recovery_code' },
    });
    return s;
  });
  if (!out) {
    // 동시에 같은 OTP 를 사용한 요청이 먼저 성공 — 재사용으로 처리
    throw new InvalidMfaCodeError();
  }
  const fresh = { ...user, lastLoginAt: now, failedLoginCount: 0, lockedUntil: null };
  return {
    status: 'ok',
    sessionToken: out.token,
    sessionId: out.sessionId,
    expiresAt: out.expiresAt.toISOString(),
    user: toAuthUserDTO(fresh),
    mustEnrollMfa: mustEnrollMfa(user, env),
    mustChangePassword: user.passwordChangedAt === null,
  };
}

/**
 * 이메일/비밀번호 로그인.
 * @returns 세션 발급(ok) 또는 OTP 입력 필요(mfa_required + challengeToken)
 * @throws RateLimitError · InvalidCredentialsError · AccountLockedError · IpNotAllowedError · AuthenticationError(비활성)
 */
export async function login(db: Database, input: LoginInput, opts: AuthOptions = {}): Promise<LoginResult> {
  const now = nowOf(opts);
  const env = envOf(opts);
  const meta = metaOf(input);
  const email = normalizeEmail(input?.email);
  const password = typeof input?.password === 'string' ? input.password : '';
  if (!email || !password) {
    throw new ValidationError('이메일과 비밀번호를 모두 입력해 주세요.', [
      ...(!email ? [{ field: 'email', message: '이메일을 입력해 주세요.' }] : []),
      ...(!password ? [{ field: 'password', message: '비밀번호를 입력해 주세요.' }] : []),
    ]);
  }

  const rlKey = loginRateLimitKey(email, meta.ip);
  const rl = loginLimiterAt(now.getTime()).peek(rlKey);
  const user = await loadUserByEmail(db, email);
  if (!rl.allowed) {
    await recordLoginAttempt(db, { userId: user?.id ?? null, email, result: 'rate_limited', meta, at: now });
    throw new RateLimitError(Math.ceil(rl.retryAfterMs / 1000), LOGIN_RATE_LIMIT_MESSAGE);
  }
  const fail = () => loginLimiterAt(now.getTime()).hit(rlKey);

  if (!user) {
    await verifyPasswordDummy(password);
    fail();
    await recordLoginAttempt(db, { userId: null, email, result: 'unknown_user', meta, at: now });
    throw new InvalidCredentialsError();
  }

  if (user.lockedUntil && isAccountLocked(user.lockedUntil, now)) {
    await verifyPasswordDummy(password);
    fail();
    await recordLoginAttempt(db, { userId: user.id, email, result: 'locked', meta, at: now });
    throw new AccountLockedError(user.lockedUntil, now);
  }

  if (!isIpAllowed(meta.ip, user.allowedIpRanges)) {
    await verifyPasswordDummy(password);
    fail();
    await recordLoginAttempt(db, { userId: user.id, email, result: 'ip_blocked', meta, at: now });
    await writeAudit(authContext(db, null, meta, now), {
      action: 'auth.ip_blocked',
      category: 'security',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.name} 로그인 차단 — 허용되지 않은 IP${meta.ip ? ` (${meta.ip})` : ''}`,
      after: { ip: meta.ip ?? null },
    });
    throw new IpNotAllowedError();
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    fail();
    const state = await registerFailure(db, user.id, now, env);
    await recordLoginAttempt(db, { userId: user.id, email, result: 'bad_password', meta, at: now });
    if (state.locked && state.lockedUntil) {
      await auditLockout(db, user, meta, now, state.lockedUntil, '비밀번호');
      throw new AccountLockedError(state.lockedUntil, now);
    }
    throw new InvalidCredentialsError();
  }

  if (!user.active) {
    await recordLoginAttempt(db, { userId: user.id, email, result: 'inactive', meta, at: now });
    throw new AuthenticationError('사용이 중지된 계정입니다. 사무소 관리자에게 계정 활성화를 요청하세요.', 'ACCOUNT_INACTIVE');
  }

  // 해시 파라미터가 약해졌으면 점진 업그레이드 (다른 요청이 먼저 바꿨으면 건너뜀)
  let current = user;
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(password);
    const r = await db
      .update(users)
      .set({ passwordHash: upgraded, updatedAt: now })
      .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)))
      .returning({ id: users.id });
    if (r.length > 0) current = { ...user, passwordHash: upgraded };
  }

  if (current.mfaEnabled) {
    if (!current.mfaSecretEnc) {
      throw new AuthenticationError('OTP 설정 정보가 없습니다. 사무소 관리자에게 OTP 초기화를 요청하세요.', 'MFA_MISCONFIGURED');
    }
    const challengeToken = signMfaChallenge(current.id, now.getTime(), challengeBinding(current));
    await recordLoginAttempt(db, { userId: current.id, email, result: 'password_ok_mfa_required', meta, at: now });
    return { status: 'mfa_required', challengeToken, expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS).toISOString() };
  }

  loginLimiterAt(now.getTime()).reset(rlKey);
  return completeLogin(db, current, meta, now, env, { mfaVerified: false, result: 'success' });
}

/**
 * OTP(또는 복구 코드) 검증 → 세션 발급.
 * - 재사용 방지: 성공한 time step 을 MFA 봉투(lastStep)에 저장, 같거나 이전 step 의 코드는 거부 (mfa_replayed)
 * - 동시 요청: 봉투 비교 후 교체(compare-and-swap)로 한 요청만 성공
 * - OTP 실패도 계정 잠금 횟수에 포함 (6자리 대입 방지)
 */
export async function verifyMfa(db: Database, input: VerifyMfaInput, opts: AuthOptions = {}): Promise<OkResult> {
  const now = nowOf(opts);
  const env = envOf(opts);
  const meta = metaOf(input);
  const parts = parseMfaChallenge(input?.challengeToken);
  if (!parts) throw challengeError(false);
  if (isChallengeExpired(parts, now.getTime())) throw challengeError(true);
  const user = await loadUserById(db, parts.userId);
  if (!user || !verifyMfaChallengeSig(parts, challengeBinding(user))) throw challengeError(false);

  const rlKey = loginRateLimitKey(user.email, meta.ip);
  const rl = loginLimiterAt(now.getTime()).peek(rlKey);
  if (!rl.allowed) {
    await recordLoginAttempt(db, { userId: user.id, email: user.email, result: 'rate_limited', meta, at: now });
    throw new RateLimitError(Math.ceil(rl.retryAfterMs / 1000), LOGIN_RATE_LIMIT_MESSAGE);
  }
  if (user.lockedUntil && isAccountLocked(user.lockedUntil, now)) {
    await recordLoginAttempt(db, { userId: user.id, email: user.email, result: 'locked', meta, at: now });
    throw new AccountLockedError(user.lockedUntil, now);
  }
  if (!isIpAllowed(meta.ip, user.allowedIpRanges)) {
    await recordLoginAttempt(db, { userId: user.id, email: user.email, result: 'ip_blocked', meta, at: now });
    throw new IpNotAllowedError();
  }
  if (!user.active) {
    await recordLoginAttempt(db, { userId: user.id, email: user.email, result: 'inactive', meta, at: now });
    throw new AuthenticationError('사용이 중지된 계정입니다. 사무소 관리자에게 계정 활성화를 요청하세요.', 'ACCOUNT_INACTIVE');
  }
  if (!user.mfaEnabled || !user.mfaSecretEnc) throw challengeError(false);

  const envelope = decodeMfaEnvelope(user.mfaSecretEnc);
  const code = String(input?.code ?? '').trim();

  const failure = async (result: 'mfa_failed' | 'mfa_replayed'): Promise<never> => {
    loginLimiterAt(now.getTime()).hit(rlKey);
    const state = await registerFailure(db, user.id, now, env);
    await recordLoginAttempt(db, { userId: user.id, email: user.email, result, meta, at: now });
    if (state.locked && state.lockedUntil) {
      await auditLockout(db, user, meta, now, state.lockedUntil, 'OTP');
      throw new AccountLockedError(state.lockedUntil, now);
    }
    throw new InvalidMfaCodeError();
  };

  let next: MfaEnvelope;
  let result: LoginResultCode;
  if (looksLikeRecoveryCode(code)) {
    const idx = verifyRecoveryCode(code, envelope.recovery);
    if (idx < 0) return failure('mfa_failed');
    next = { ...envelope, recovery: envelope.recovery.filter((_, i) => i !== idx) };
    result = 'success_recovery_code';
  } else {
    const r = verifyTotp(envelope.secret, code, 1, now, { lastUsedStep: envelope.lastStep });
    if (!r.valid) return failure(r.reason === 'replayed' ? 'mfa_replayed' : 'mfa_failed');
    next = { ...envelope, lastStep: r.step };
    result = 'success';
  }

  const nextEnc = encodeMfaEnvelope(next);
  const previousEnc = user.mfaSecretEnc;
  loginLimiterAt(now.getTime()).reset(rlKey);
  try {
    return await completeLogin(db, { ...user, mfaSecretEnc: nextEnc }, meta, now, env, {
      mfaVerified: true,
      result,
      beforeCommit: async (tx) => {
        const swapped = await tx
          .update(users)
          .set({ mfaSecretEnc: nextEnc, updatedAt: now })
          .where(and(eq(users.id, user.id), eq(users.mfaSecretEnc, previousEnc)))
          .returning({ id: users.id });
        return swapped.length > 0;
      },
    });
  } catch (e) {
    if (e instanceof InvalidMfaCodeError) {
      await recordLoginAttempt(db, { userId: user.id, email: user.email, result: 'mfa_replayed', meta, at: now });
    }
    throw e;
  }
}
