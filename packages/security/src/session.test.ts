import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  computeSessionExpiresAt,
  generateSessionToken,
  getSessionPolicy,
  hashToken,
  isSessionExpired,
  isWellFormedSessionToken,
  sessionCookieOptions,
  sessionExpiryReason,
  shouldTouchSession,
} from './session';

const P = { idleMinutes: 30, absoluteHours: 12 };
const T0 = new Date('2026-09-26T00:00:00Z').getTime();
const min = (n: number) => n * 60_000;

describe('토큰', () => {
  it('32바이트 base64url (43자), 매번 다름', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(isWellFormedSessionToken(a)).toBe(true);
    expect(isWellFormedSessionToken('short')).toBe(false);
    expect(isWellFormedSessionToken(`${a.slice(0, 42)}+`)).toBe(false);
    expect(isWellFormedSessionToken(undefined)).toBe(false);
  });

  it('hashToken = sha256 hex, 원문과 다름', () => {
    const t = generateSessionToken();
    const h = hashToken(t);
    expect(h).toBe(createHash('sha256').update(t).digest('hex'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(hashToken(t)).toBe(h);
  });
});

describe('세션 정책', () => {
  it('환경변수 반영, 잘못된 값은 기본값', () => {
    expect(getSessionPolicy({})).toEqual(DEFAULT_SESSION_POLICY);
    expect(getSessionPolicy({ SESSION_IDLE_MINUTES: '15', SESSION_ABSOLUTE_HOURS: '8' })).toEqual({ idleMinutes: 15, absoluteHours: 8 });
    expect(getSessionPolicy({ SESSION_IDLE_MINUTES: 'abc', SESSION_ABSOLUTE_HOURS: '0' })).toEqual(DEFAULT_SESSION_POLICY);
    expect(getSessionPolicy({ SESSION_IDLE_MINUTES: '1.5', SESSION_ABSOLUTE_HOURS: '99999' })).toEqual(DEFAULT_SESSION_POLICY);
  });

  it('computeSessionExpiresAt = 생성 + 절대 시간', () => {
    expect(computeSessionExpiresAt(T0, P).getTime()).toBe(T0 + 12 * 3_600_000);
    expect(computeSessionExpiresAt(new Date(T0).toISOString(), { idleMinutes: 30, absoluteHours: 1 }).getTime()).toBe(T0 + 3_600_000);
  });
});

describe('isSessionExpired / sessionExpiryReason', () => {
  it('활동 중이면 유효', () => {
    expect(isSessionExpired({ createdAt: T0, lastSeenAt: T0 + min(10), now: T0 + min(20) }, P)).toBe(false);
  });

  it('유휴 30분 경과 → idle', () => {
    expect(sessionExpiryReason({ createdAt: T0, lastSeenAt: T0, now: T0 + min(29) }, P)).toBeNull();
    expect(sessionExpiryReason({ createdAt: T0, lastSeenAt: T0, now: T0 + min(30) }, P)).toBe('idle');
    expect(isSessionExpired({ createdAt: new Date(T0), lastSeenAt: new Date(T0), now: new Date(T0 + min(31)) }, P)).toBe(true);
  });

  it('계속 활동해도 절대 12시간이 지나면 absolute', () => {
    const now = T0 + 12 * 3_600_000;
    expect(sessionExpiryReason({ createdAt: T0, lastSeenAt: now - min(1), now }, P)).toBe('absolute');
    expect(sessionExpiryReason({ createdAt: T0, lastSeenAt: now - min(1), now: now - 1 }, P)).toBeNull();
  });

  it('DB expiresAt 이 더 이르면 우선', () => {
    expect(sessionExpiryReason({ createdAt: T0, lastSeenAt: T0 + min(50), now: T0 + min(60), expiresAt: T0 + min(59) }, P)).toBe('absolute');
  });

  it('폐기된 세션 → revoked (다른 조건보다 우선)', () => {
    expect(sessionExpiryReason({ createdAt: T0, lastSeenAt: T0, now: T0 + min(1), revokedAt: T0 + min(1) }, P)).toBe('revoked');
    expect(sessionExpiryReason({ createdAt: T0, lastSeenAt: T0, now: T0 + min(1), revokedAt: null }, P)).toBeNull();
  });

  it('미래 lastSeenAt(시계 오차)은 현재로 간주, 미래 createdAt(5분 초과)은 거부', () => {
    expect(isSessionExpired({ createdAt: T0, lastSeenAt: T0 + min(100), now: T0 + min(1) }, P)).toBe(false);
    expect(isSessionExpired({ createdAt: T0 + min(10), lastSeenAt: T0, now: T0 }, P)).toBe(true);
  });

  it('ISO 문자열 입력, 잘못된 시각은 TypeError', () => {
    const iso = new Date(T0).toISOString();
    expect(isSessionExpired({ createdAt: iso, lastSeenAt: iso, now: new Date(T0 + min(5)).toISOString() }, P)).toBe(false);
    expect(() => isSessionExpired({ createdAt: 'not-a-date', lastSeenAt: T0, now: T0 }, P)).toThrow(TypeError);
  });
});

describe('shouldTouchSession / 쿠키 옵션', () => {
  it('60초 간격으로만 갱신', () => {
    expect(shouldTouchSession(T0, T0 + 59_000)).toBe(false);
    expect(shouldTouchSession(T0, T0 + 60_000)).toBe(true);
    expect(shouldTouchSession(T0, T0 + 10_000, 5)).toBe(true);
  });

  it('HttpOnly, SameSite=Lax, 운영 기본 Secure, 명시값 우선', () => {
    const dev = sessionCookieOptions({ NODE_ENV: 'development' });
    expect(dev).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: false, maxAge: 12 * 3600 });
    expect(sessionCookieOptions({ NODE_ENV: 'production' }).secure).toBe(true);
    expect(sessionCookieOptions({ NODE_ENV: 'development', COOKIE_SECURE: 'true' }).secure).toBe(true);
    expect(sessionCookieOptions({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }).secure).toBe(false);
    expect(sessionCookieOptions({ SESSION_ABSOLUTE_HOURS: '2' }).maxAge).toBe(7200);
  });
});
