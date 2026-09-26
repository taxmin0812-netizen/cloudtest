/**
 * 세션 토큰 · 만료 정책.
 *
 * - 원문 토큰은 쿠키(HttpOnly, Secure, SameSite=Lax)에만 둔다. DB 에는 hashToken() 값만 (sessions.token_hash).
 * - 유휴 만료(SESSION_IDLE_MINUTES, 기본 30분) + 절대 만료(SESSION_ABSOLUTE_HOURS, 기본 12시간).
 */
import { createHash, randomBytes } from 'node:crypto';

type Env = Record<string, string | undefined>;
type TimeInput = Date | string | number;

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

export const DEFAULT_SESSION_POLICY: Readonly<SessionPolicy> = Object.freeze({ idleMinutes: 30, absoluteHours: 12 });

export const SESSION_COOKIE_NAME = 'mintax_session';

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function intInRange(v: string | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** 환경변수 기반 세션 정책. 범위를 벗어난 값은 기본값 사용 (유휴 1~1440분, 절대 1~720시간) */
export function getSessionPolicy(env: Env = process.env): SessionPolicy {
  return {
    idleMinutes: intInRange(env.SESSION_IDLE_MINUTES, 1, 1440, DEFAULT_SESSION_POLICY.idleMinutes),
    absoluteHours: intInRange(env.SESSION_ABSOLUTE_HOURS, 1, 720, DEFAULT_SESSION_POLICY.absoluteHours),
  };
}

/** 32바이트 무작위 토큰 (base64url, 43자) */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedSessionToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/** 토큰 저장용 SHA-256 (hex). 토큰 자체가 256bit 무작위이므로 salt 불필요 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toMs(t: TimeInput): number {
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : new Date(t).getTime();
  if (Number.isNaN(ms)) throw new TypeError('세션 시각 값이 올바르지 않습니다.');
  return ms;
}

/** sessions.expires_at 에 저장할 절대 만료 시각 */
export function computeSessionExpiresAt(createdAt: TimeInput, policy: SessionPolicy = getSessionPolicy()): Date {
  return new Date(toMs(createdAt) + policy.absoluteHours * 3_600_000);
}

export interface SessionTimes {
  createdAt: TimeInput;
  lastSeenAt: TimeInput;
  now?: TimeInput;
  /** DB 에 저장된 절대 만료 (정책보다 이르면 이 값 우선) */
  expiresAt?: TimeInput | null;
  revokedAt?: TimeInput | null;
}

export type SessionExpiryReason = 'revoked' | 'absolute' | 'idle';

/** 만료 사유 (유효하면 null). 로그아웃 안내 문구 선택용 */
export function sessionExpiryReason(s: SessionTimes, policy: SessionPolicy = getSessionPolicy()): SessionExpiryReason | null {
  const now = s.now === undefined ? Date.now() : toMs(s.now);
  if (s.revokedAt !== null && s.revokedAt !== undefined && toMs(s.revokedAt) <= now) return 'revoked';
  const created = toMs(s.createdAt);
  let absoluteEnd = created + policy.absoluteHours * 3_600_000;
  if (s.expiresAt !== null && s.expiresAt !== undefined) absoluteEnd = Math.min(absoluteEnd, toMs(s.expiresAt));
  if (now >= absoluteEnd) return 'absolute';
  // 미래 시각 lastSeenAt(시계 오차)은 now 로 간주
  const lastSeen = Math.min(toMs(s.lastSeenAt), now);
  if (now - lastSeen >= policy.idleMinutes * 60_000) return 'idle';
  // 생성 시각이 미래인 비정상 세션은 거부
  if (created - now > 5 * 60_000) return 'absolute';
  return null;
}

export function isSessionExpired(s: SessionTimes, policy: SessionPolicy = getSessionPolicy()): boolean {
  return sessionExpiryReason(s, policy) !== null;
}

/** lastSeenAt 갱신 쓰기를 줄이기 위해 일정 간격(기본 60초)마다만 갱신 */
export function shouldTouchSession(lastSeenAt: TimeInput, now: TimeInput = Date.now(), minIntervalSeconds = 60): boolean {
  return toMs(now) - toMs(lastSeenAt) >= minIntervalSeconds * 1000;
}

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  /** 초 단위 (절대 만료와 동일) */
  maxAge: number;
}

/**
 * 세션 쿠키 옵션. secure 는 COOKIE_SECURE 가 명시되면 그 값, 아니면 운영(NODE_ENV=production)일 때 true.
 */
export function sessionCookieOptions(env: Env = process.env, policy: SessionPolicy = getSessionPolicy(env)): SessionCookieOptions {
  const explicit = env.COOKIE_SECURE?.trim().toLowerCase();
  const secure = explicit === 'true' ? true : explicit === 'false' ? false : env.NODE_ENV === 'production';
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: policy.absoluteHours * 3600 };
}
