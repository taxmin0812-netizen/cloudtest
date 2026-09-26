/**
 * 인증 영역 — 순수 도우미 (DB 없음, 단위 테스트 대상).
 *
 * - 이메일 정규화 / 로그인 결과 코드 / MFA 챌린지 토큰(HMAC 서명, 상태 비저장) / MFA 비밀 봉투(암호화 JSON)
 * - 로그인 속도 제한기 (이메일+IP, 실패만 센다 — 프로세스 메모리. 계정 잠금은 DB 로 강제되어 인스턴스와 무관)
 * - 임시 비밀번호 생성
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Permission, Role } from '@mintax/core';
import {
  LOGIN_RATE_LIMIT,
  ROLE_LABELS,
  SlidingWindowRateLimiter,
  decryptField,
  encryptField,
  getIndexKey,
  hmacSha256Hex,
  isRole,
  permissionsOf,
  timingSafeEqualString,
  validatePasswordPolicy,
} from '@mintax/security';
import type { Actor } from '../context';

export type Env = Readonly<Record<string, string | undefined>>;

// ────────────────────────────── 이메일 ──────────────────────────────

/** 로그인·저장용 이메일 키: NFKC + 공백 제거 + 소문자 */
export function normalizeEmail(email: unknown): string {
  return String(email ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

// ────────────────────────────── 로그인 결과 코드 (login_history.result) ──────────────────────────────

export const LOGIN_RESULTS = [
  'success',
  'success_recovery_code',
  'password_ok_mfa_required',
  'bad_password',
  'unknown_user',
  'locked',
  'mfa_failed',
  'mfa_replayed',
  'ip_blocked',
  'inactive',
  'rate_limited',
] as const;
export type LoginResultCode = (typeof LOGIN_RESULTS)[number];

export const LOGIN_RESULT_LABELS: Readonly<Record<LoginResultCode, string>> = Object.freeze({
  success: '로그인 성공',
  success_recovery_code: '로그인 성공 (복구 코드 사용)',
  password_ok_mfa_required: '비밀번호 확인 · OTP 대기',
  bad_password: '비밀번호 불일치',
  unknown_user: '등록되지 않은 이메일',
  locked: '계정 잠김 상태에서 시도',
  mfa_failed: 'OTP 코드 불일치',
  mfa_replayed: 'OTP 코드 재사용 시도',
  ip_blocked: '허용되지 않은 IP',
  inactive: '비활성 계정',
  rate_limited: '시도 횟수 초과로 차단',
});

export function isLoginResultCode(v: unknown): v is LoginResultCode {
  return typeof v === 'string' && (LOGIN_RESULTS as readonly string[]).includes(v);
}

// ────────────────────────────── 설정 ──────────────────────────────

/** 관리자 MFA 강제 여부 (미설정 시 true — 안전한 기본값) */
export function isMfaRequiredForAdmin(env: Env = process.env): boolean {
  const v = (env.MFA_REQUIRED_FOR_ADMIN ?? '').trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
}

export function mustEnrollMfa(user: { role: string; mfaEnabled: boolean }, env: Env = process.env): boolean {
  return user.role === 'admin' && !user.mfaEnabled && isMfaRequiredForAdmin(env);
}

// ────────────────────────────── Actor ──────────────────────────────

export function roleOf(v: unknown): Role {
  return isRole(v) ? v : 'viewer';
}

/** 사용자 + 세션 → 서비스 호출 주체 (권한은 역할에서 매 요청 계산: 역할 변경 즉시 반영) */
export function buildActor(
  user: { id: string; name: string; role: string },
  session?: { id?: string | null; ip?: string | null; userAgent?: string | null } | null,
): Actor {
  const role = roleOf(user.role);
  return {
    kind: 'user',
    userId: user.id,
    name: user.name,
    role,
    permissions: new Set(permissionsOf(role) as Permission[]),
    ip: session?.ip ?? null,
    userAgent: session?.userAgent ?? null,
    sessionId: session?.id ?? null,
  };
}

export function roleLabel(role: string): string {
  return isRole(role) ? ROLE_LABELS[role] : role;
}

// ────────────────────────────── MFA 챌린지 토큰 ──────────────────────────────

/** 비밀번호 확인 후 OTP 입력까지 허용 시간 */
export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_PREFIX = 'mfa1';
const CHALLENGE_DOMAIN = 'mintax:mfa-challenge:v1';

export interface MfaChallengeParts {
  userId: string;
  issuedAtMs: number;
  nonce: string;
  payload: string;
  sig: string;
}

/**
 * 상태 비저장 챌린지 토큰: 'mfa1.<userId>.<issuedAt36>.<nonce>.<sig>'.
 * bind 값(비밀번호 해시·MFA 봉투의 해시)을 서명에 넣어, 비밀번호 변경·MFA 초기화·OTP 성공 뒤에는 토큰이 무효가 된다.
 */
export function signMfaChallenge(userId: string, issuedAtMs: number, bind: string, key: Buffer = getIndexKey()): string {
  const nonce = randomBytes(12).toString('base64url');
  const payload = `${userId}.${issuedAtMs.toString(36)}.${nonce}`;
  const sig = challengeSig(payload, bind, key);
  return `${CHALLENGE_PREFIX}.${payload}.${sig}`;
}

function challengeSig(payload: string, bind: string, key: Buffer): string {
  return Buffer.from(hmacSha256Hex(key, `${CHALLENGE_DOMAIN}|${payload}|${bind}`), 'hex').toString('base64url');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMfaChallenge(token: unknown): MfaChallengeParts | null {
  if (typeof token !== 'string' || token.length > 300) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== CHALLENGE_PREFIX) return null;
  const [, userId, issued, nonce, sig] = parts as [string, string, string, string, string];
  if (!UUID_RE.test(userId) || !/^[0-9a-z]{1,12}$/.test(issued) || !/^[A-Za-z0-9_-]{16}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const issuedAtMs = parseInt(issued, 36);
  if (!Number.isSafeInteger(issuedAtMs)) return null;
  return { userId, issuedAtMs, nonce, payload: `${userId}.${issued}.${nonce}`, sig };
}

export function verifyMfaChallengeSig(parts: MfaChallengeParts, bind: string, key: Buffer = getIndexKey()): boolean {
  return timingSafeEqualString(challengeSig(parts.payload, bind, key), parts.sig);
}

export function isChallengeExpired(parts: MfaChallengeParts, nowMs: number): boolean {
  // 미래 발급(시계 오차 1분 초과)도 거부
  return nowMs - parts.issuedAtMs > MFA_CHALLENGE_TTL_MS || parts.issuedAtMs - nowMs > 60_000;
}

/** 챌린지 바인딩 값: 비밀번호 해시 + MFA 봉투 (둘 중 하나라도 바뀌면 기존 챌린지 무효) */
export function challengeBinding(user: { passwordHash: string; mfaSecretEnc: string | null }): string {
  return createHash('sha256')
    .update(`${user.passwordHash}\u0000${user.mfaSecretEnc ?? ''}`)
    .digest('base64url');
}

// ────────────────────────────── MFA 비밀 봉투 ──────────────────────────────

/**
 * users.mfa_secret_enc 의 평문 형식 (AES-256-GCM 으로 암호화된 JSON).
 * - secret: base32 TOTP 비밀
 * - lastStep: 마지막으로 성공한 time step (재사용 방지 — DB 저장이라 다중 인스턴스에서도 동작)
 * - recovery: 복구 코드 HMAC 목록 (사용하면 제거)
 * - confirmed: 등록 확인(첫 코드 검증) 완료 여부
 */
export interface MfaEnvelope {
  v: 1;
  secret: string;
  lastStep: number | null;
  recovery: string[];
  confirmed: boolean;
}

const MFA_AAD_CONTEXT = 'users.mfa_secret';

export function encodeMfaEnvelope(env: MfaEnvelope): string {
  return encryptField(JSON.stringify(env), undefined, { context: MFA_AAD_CONTEXT });
}

/** 봉투 복호화. 과거 형식(base32 비밀 문자열만 암호화)도 읽는다. 실패 시 CryptoError 전파 */
export function decodeMfaEnvelope(enc: string): MfaEnvelope {
  let plain: string;
  try {
    plain = decryptField(enc, undefined, { context: MFA_AAD_CONTEXT });
  } catch (e) {
    // 컨텍스트 없이 암호화된 과거 값
    try {
      plain = decryptField(enc);
    } catch {
      throw e;
    }
  }
  const trimmed = plain.trim();
  if (trimmed.startsWith('{')) {
    const o = JSON.parse(trimmed) as Partial<MfaEnvelope>;
    return {
      v: 1,
      secret: String(o.secret ?? ''),
      lastStep: typeof o.lastStep === 'number' && Number.isSafeInteger(o.lastStep) ? o.lastStep : null,
      recovery: Array.isArray(o.recovery) ? o.recovery.filter((x): x is string => typeof x === 'string') : [],
      confirmed: o.confirmed !== false,
    };
  }
  return { v: 1, secret: trimmed, lastStep: null, recovery: [], confirmed: true };
}

/** 'ABCDE-FGHIJ' 형식이면 복구 코드로 본다 (OTP 6자리와 구분) */
export function looksLikeRecoveryCode(code: string): boolean {
  return /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(code.trim());
}

// ────────────────────────────── 로그인 속도 제한 ──────────────────────────────

let limiterClockMs = 0;
let limiter = new SlidingWindowRateLimiter({ ...LOGIN_RATE_LIMIT, now: () => limiterClockMs });

/**
 * 이메일+IP 조합 로그인 실패 속도 제한기 (15분 5회). 시각을 주입할 수 있도록 호출마다 시계를 맞춘다.
 * 다중 인스턴스에서는 인스턴스별로 센다 — 계정 단위 잠금(failed_login_count)은 DB 에서 강제되므로 무차별 대입은 그쪽에서 막힌다.
 */
export function loginLimiterAt(nowMs: number): SlidingWindowRateLimiter {
  limiterClockMs = nowMs;
  return limiter;
}

/** 테스트용: 속도 제한 기록 초기화 */
export function resetLoginRateLimits(): void {
  limiter = new SlidingWindowRateLimiter({ ...LOGIN_RATE_LIMIT, now: () => limiterClockMs });
}

// ────────────────────────────── 임시 비밀번호 ──────────────────────────────

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
const SPECIAL = '!@#$%^&*-_=+?';
const ALL = UPPER + LOWER + DIGIT + SPECIAL;

function pick(set: string): string {
  return set[randomInt(set.length)]!;
}

/** 정책(10자 이상, 3종류 이상)을 만족하는 16자 임시 비밀번호 — 혼동 문자(0/O, 1/l/I) 제외 */
export function generateTemporaryPassword(length = 16): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SPECIAL)];
    while (chars.length < Math.max(12, length)) chars.push(pick(ALL));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j]!, chars[i]!];
    }
    const pw = chars.join('');
    if (validatePasswordPolicy(pw).ok) return pw;
  }
  throw new Error('임시 비밀번호 생성 실패');
}

// ────────────────────────────── 기타 ──────────────────────────────

/** 감사로그·화면용 IP 표기 (최대 64자) */
export function cleanMeta(v: unknown, max = 512): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f]/g, '').trim();
  return s === '' ? null : s.slice(0, max);
}
