import { describe, expect, it } from 'vitest';
import { AccountLockedError, RateLimitError, toUserError } from './errors';
import {
  DEFAULT_LOCKOUT_POLICY,
  LOGIN_RATE_LIMIT_MESSAGE,
  SlidingWindowRateLimiter,
  assertNotLocked,
  createLoginRateLimiter,
  getLockoutPolicy,
  isAccountLocked,
  loginRateLimitKey,
  normalizeIpForRateLimit,
  registerFailedLogin,
  registerSuccessfulLogin,
  remainingLoginAttempts,
} from './rate-limit';

const MIN = 60_000;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SlidingWindowRateLimiter', () => {
  it('한도까지 허용, 초과 시 차단 + retryAfter', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 3, windowMs: 10_000, now: c.now });
    expect(rl.hit('k')).toEqual({ allowed: true, count: 1, remaining: 2, retryAfterMs: 0 });
    c.advance(1000);
    rl.hit('k');
    c.advance(1000);
    expect(rl.hit('k')).toMatchObject({ allowed: true, count: 3, remaining: 0 });
    c.advance(1000);
    const blocked = rl.hit('k');
    expect(blocked).toEqual({ allowed: false, count: 3, remaining: 0, retryAfterMs: 7000 });
  });

  it('창이 미끄러지며 가장 오래된 시도가 빠지면 다시 허용', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 2, windowMs: 10_000, now: c.now });
    rl.hit('k'); // t=0
    c.advance(4000);
    rl.hit('k'); // t=4000
    c.advance(5999); // t=9999
    expect(rl.hit('k').allowed).toBe(false);
    c.advance(1); // t=10000 → 첫 시도 만료
    expect(rl.hit('k')).toMatchObject({ allowed: true, count: 2 });
    expect(rl.peek('k')).toMatchObject({ allowed: false, retryAfterMs: 4000 });
  });

  it('차단된 시도는 기록하지 않는다 (공격 중에도 창은 정상 만료)', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000, now: c.now });
    rl.hit('k');
    for (let i = 0; i < 10; i++) {
      c.advance(50);
      rl.hit('k');
    }
    c.advance(500);
    expect(rl.hit('k').allowed).toBe(true);
  });

  it('키별 독립, reset, peek 는 기록하지 않음', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000, now: c.now });
    expect(rl.peek('a')).toMatchObject({ allowed: true, count: 0 });
    rl.hit('a');
    expect(rl.hit('b').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    rl.reset('a');
    expect(rl.hit('a').allowed).toBe(true);
  });

  it('consume 은 RateLimitError(429) 를 던진다', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 90_000, now: c.now });
    rl.consume('k');
    try {
      rl.consume('k');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      const u = toUserError(e);
      expect(u.httpStatus).toBe(429);
      expect(u.retryAfterSeconds).toBe(90);
      expect(u.message).toContain('약 2분');
    }
    expect(() => rl.consume('k', LOGIN_RATE_LIMIT_MESSAGE)).toThrow(/로그인 시도가 너무 많습니다/);
  });

  it('prune 과 maxKeys 로 메모리 상한 유지', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 5, windowMs: 1000, now: c.now, maxKeys: 3 });
    for (const k of ['a', 'b', 'c', 'd']) rl.hit(k);
    expect(rl.size).toBe(3);
    expect(rl.peek('a').count).toBe(0); // 가장 오래된 키 제거
    c.advance(2000);
    rl.prune();
    expect(rl.size).toBe(0);
  });

  it('잘못된 설정', () => {
    expect(() => new SlidingWindowRateLimiter({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
  });
});

describe('로그인 속도 제한 (이메일+IP 5회/15분)', () => {
  it('기본값과 키 정규화', () => {
    const c = clock();
    const rl = createLoginRateLimiter({ now: c.now });
    expect(rl.limit).toBe(5);
    expect(rl.windowMs).toBe(15 * MIN);
    const key = loginRateLimitKey(' Kim@Office.KR ', '203.0.113.5');
    expect(key).toBe(loginRateLimitKey('kim@office.kr', '203.0.113.5'));
    expect(key).not.toBe(loginRateLimitKey('kim@office.kr', '203.0.113.6'));
    expect(loginRateLimitKey('a@b.c', null)).toContain('unknown');
    for (let i = 0; i < 5; i++) expect(rl.hit(key).allowed).toBe(true);
    expect(rl.hit(key).allowed).toBe(false);
    c.advance(15 * MIN);
    expect(rl.hit(key).allowed).toBe(true);
  });
});

describe('계정 잠금 정책', () => {
  const now = new Date('2026-09-26T09:00:00Z');
  const P = DEFAULT_LOCKOUT_POLICY;

  it('기본 5회/15분, 환경변수 조정·범위 검증', () => {
    expect(getLockoutPolicy({})).toEqual({ maxFailedAttempts: 5, lockMinutes: 15 });
    expect(getLockoutPolicy({ LOGIN_LOCKOUT_THRESHOLD: '10', LOGIN_LOCKOUT_MINUTES: '30' })).toEqual({ maxFailedAttempts: 10, lockMinutes: 30 });
    expect(getLockoutPolicy({ LOGIN_LOCKOUT_THRESHOLD: '1', LOGIN_LOCKOUT_MINUTES: 'x' })).toEqual(P);
  });

  it('5번째 실패에서 15분 잠금', () => {
    let s = { failedLoginCount: 0, lockedUntil: null as Date | null };
    for (let i = 1; i <= 4; i++) {
      const r = registerFailedLogin(s, now, P);
      expect(r).toMatchObject({ failedLoginCount: i, locked: false, lockedUntil: null });
      expect(remainingLoginAttempts(r, now, P)).toBe(5 - i);
      s = r;
    }
    const locked = registerFailedLogin(s, now, P);
    expect(locked.locked).toBe(true);
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil!.getTime()).toBe(now.getTime() + 15 * MIN);
    expect(isAccountLocked(locked.lockedUntil, now)).toBe(true);
    expect(isAccountLocked(locked.lockedUntil, new Date(now.getTime() + 15 * MIN))).toBe(false);
    expect(remainingLoginAttempts(locked, now, P)).toBe(0);
  });

  it('잠금 만료 후 실패는 1부터 다시 센다', () => {
    const lockedUntil = new Date(now.getTime() - 1);
    const r = registerFailedLogin({ failedLoginCount: 5, lockedUntil }, now, P);
    expect(r).toEqual({ failedLoginCount: 1, lockedUntil: null, locked: false });
    expect(remainingLoginAttempts({ failedLoginCount: 5, lockedUntil }, now, P)).toBe(5);
  });

  it('잠금 중 추가 실패는 잠금을 연장한다', () => {
    const lockedUntil = new Date(now.getTime() + 5 * MIN);
    const r = registerFailedLogin({ failedLoginCount: 5, lockedUntil }, now, P);
    expect(r.locked).toBe(true);
    expect(r.lockedUntil!.getTime()).toBe(now.getTime() + 15 * MIN);
  });

  it('성공 시 초기화', () => {
    expect(registerSuccessfulLogin()).toEqual({ failedLoginCount: 0, lockedUntil: null });
  });

  it('assertNotLocked → AccountLockedError(423) 남은 분 안내', () => {
    expect(() => assertNotLocked(null, now)).not.toThrow();
    const until = new Date(now.getTime() + 14 * MIN + 1);
    try {
      assertNotLocked(until, now);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AccountLockedError);
      expect((e as AccountLockedError).httpStatus).toBe(423);
      expect((e as AccountLockedError).userMessage).toContain('약 15분 후');
    }
  });
});

describe('로그인 속도 제한 키 — IP 표기 우회 방지', () => {
  it('IPv4-mapped·대괄호 표기는 같은 IPv4 로 합친다', () => {
    const k = loginRateLimitKey('kim@office.kr', '203.0.113.5');
    expect(loginRateLimitKey('kim@office.kr', '::ffff:203.0.113.5')).toBe(k);
    expect(loginRateLimitKey('kim@office.kr', '[::ffff:203.0.113.5]')).toBe(k);
    expect(loginRateLimitKey('kim@office.kr', ' 203.0.113.5 ')).toBe(k);
  });

  it('IPv6 는 /64 단위로 묶는다 (주소만 바꿔 한도 우회 불가), 다른 /64 는 별도', () => {
    expect(normalizeIpForRateLimit('2001:db8:1:2::10')).toBe('2001:db8:1:2::/64');
    expect(normalizeIpForRateLimit('2001:0db8:0001:0002:ffff:1:2:3')).toBe('2001:db8:1:2::/64');
    expect(normalizeIpForRateLimit('2001:db8:1:3::10')).not.toBe(normalizeIpForRateLimit('2001:db8:1:2::10'));

    const c = clock();
    const rl = createLoginRateLimiter({ now: c.now });
    for (let i = 0; i < 5; i++) expect(rl.hit(loginRateLimitKey('kim@office.kr', `2001:db8:1:2::${i + 1}`)).allowed).toBe(true);
    expect(rl.hit(loginRateLimitKey('kim@office.kr', '2001:db8:1:2::99')).allowed).toBe(false);
  });

  it('파싱할 수 없는 IP 는 원문, 없으면 unknown', () => {
    expect(normalizeIpForRateLimit('garbage')).toBe('garbage');
    expect(normalizeIpForRateLimit('')).toBe('unknown');
    expect(normalizeIpForRateLimit(undefined)).toBe('unknown');
  });
});
