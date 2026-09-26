/**
 * MFA(TOTP) 등록 · 확인 · 관리자 초기화.
 *
 * 등록 흐름: enrollMfa (비밀 생성, 미확인 상태로 암호화 저장) → 인증 앱에 등록 → confirmMfa(첫 코드) → mfa_enabled = true + 복구 코드 10개(한 번만 표시)
 * 비밀은 users.mfa_secret_enc 에 AES-256-GCM 봉투(JSON: secret·lastStep·recovery 해시)로만 저장한다.
 */
import { and, eq } from 'drizzle-orm';
import { sessions, users } from '@mintax/db';
import {
  ConflictError,
  InvalidMfaCodeError,
  NotFoundError,
  TOTP_ISSUER,
  ValidationError,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  totpUri,
  verifyTotp,
} from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { decodeMfaEnvelope, encodeMfaEnvelope } from './helpers';
import { loadUserById, requireSelfOrPermission, requireUserActor } from './shared';
import { revokeUserSessions } from './sessions';
import type { MfaEnrollmentDTO } from './types';

/** OTP 등록 시작 — 본인만. 이미 등록돼 있으면 관리자 초기화 후 다시 등록 */
export async function enrollMfa(ctx: ServiceContext): Promise<MfaEnrollmentDTO> {
  requireSelfOrPermission(ctx, null, 'users.manage');
  const userId = requireUserActor(ctx);
  const user = await loadUserById(ctx.db, userId);
  if (!user) throw new NotFoundError('사용자');
  if (user.mfaEnabled) {
    throw new ConflictError('이미 OTP 가 등록되어 있습니다. 휴대폰을 바꿨다면 관리자에게 OTP 초기화를 요청한 뒤 다시 등록하세요.');
  }
  const secret = generateTotpSecret();
  await ctx.db
    .update(users)
    .set({ mfaSecretEnc: encodeMfaEnvelope({ v: 1, secret, lastStep: null, recovery: [], confirmed: false }), updatedAt: ctx.now() })
    .where(eq(users.id, userId));
  await writeAudit(ctx, {
    action: 'auth.mfa_enroll_start',
    category: 'security',
    entityType: 'user',
    entityId: userId,
    summary: `${user.name} OTP 등록 시작`,
  });
  return { secret, otpauthUri: totpUri({ secret, account: user.email }), issuer: TOTP_ISSUER, account: user.email };
}

/** OTP 등록 확인 — 첫 코드 검증 후 활성화. 복구 코드 10개를 이 응답에서만 돌려준다 */
export async function confirmMfa(ctx: ServiceContext, input: { code: string }): Promise<{ enabled: true; recoveryCodes: string[] }> {
  requireSelfOrPermission(ctx, null, 'users.manage');
  const userId = requireUserActor(ctx);
  const user = await loadUserById(ctx.db, userId);
  if (!user) throw new NotFoundError('사용자');
  if (user.mfaEnabled) throw new ConflictError('이미 OTP 가 활성화되어 있습니다.');
  if (!user.mfaSecretEnc) throw new ValidationError('먼저 OTP 등록을 시작해 주세요. (설정 > 보안 > OTP 등록)');
  const envelope = decodeMfaEnvelope(user.mfaSecretEnc);
  const code = String(input?.code ?? '').trim();
  const r = verifyTotp(envelope.secret, code, 1, ctx.now(), { lastUsedStep: envelope.lastStep });
  if (!r.valid) throw new InvalidMfaCodeError();
  const recoveryCodes = generateRecoveryCodes(10);
  const now = ctx.now();
  const swapped = await ctx.db
    .update(users)
    .set({
      mfaEnabled: true,
      mfaSecretEnc: encodeMfaEnvelope({ v: 1, secret: envelope.secret, lastStep: r.step, recovery: recoveryCodes.map((c) => hashRecoveryCode(c)), confirmed: true }),
      updatedAt: now,
    })
    .where(and(eq(users.id, userId), eq(users.mfaSecretEnc, user.mfaSecretEnc)))
    .returning({ id: users.id });
  if (swapped.length === 0) throw new ConflictError('OTP 등록 정보가 바뀌었습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.');
  // 코드를 방금 증명한 현재 세션은 OTP 인증된 세션으로 표시 (다른 세션은 다음 요청부터 OTP 재로그인 필요)
  if (ctx.actor.sessionId) {
    await ctx.db.update(sessions).set({ mfaVerified: true }).where(and(eq(sessions.id, ctx.actor.sessionId), eq(sessions.userId, userId)));
  }
  await writeAudit(ctx, {
    action: 'auth.mfa_enabled',
    category: 'security',
    entityType: 'user',
    entityId: userId,
    summary: `${user.name} OTP 등록 완료 (복구 코드 10개 발급)`,
    before: { mfaEnabled: false },
    after: { mfaEnabled: true },
  });
  return { enabled: true, recoveryCodes };
}

/**
 * OTP 초기화 (관리자) — 휴대폰 분실 등. 대상 사용자의 모든 세션을 폐기한다.
 * 관리자 MFA 강제 환경에서 관리자 계정을 초기화하면 다음 로그인 때 등록 화면으로 안내된다.
 */
export async function disableMfa(ctx: ServiceContext, input: { userId: string; reason?: string }): Promise<{ disabled: boolean; revokedSessions: number }> {
  requirePermission(ctx, 'users.manage');
  const user = await loadUserById(ctx.db, input?.userId);
  if (!user) throw new NotFoundError('사용자');
  if (!user.mfaEnabled && !user.mfaSecretEnc) return { disabled: false, revokedSessions: 0 };
  const now = ctx.now();
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  const revokedSessions = await ctx.db.transaction(async (tx) => {
    await tx.update(users).set({ mfaEnabled: false, mfaSecretEnc: null, updatedAt: now }).where(eq(users.id, user.id));
    const n = await revokeUserSessions(tx, user.id, now);
    await writeAudit({ ...ctx, db: tx as unknown as typeof ctx.db }, {
      action: 'auth.mfa_reset',
      category: 'security',
      entityType: 'user',
      entityId: user.id,
      summary: `${ctx.actor.name} → ${user.name} OTP 초기화${reason ? ` (사유: ${reason})` : ''} · 세션 ${n}개 로그아웃`,
      before: { mfaEnabled: user.mfaEnabled },
      after: { mfaEnabled: false, reason: reason || null },
    });
    return n;
  });
  return { disabled: true, revokedSessions };
}
