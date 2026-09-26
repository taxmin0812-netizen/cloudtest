/**
 * 요청 속도 제한 (메모리 sliding window log) + 로그인 잠금 정책.
 *
 * - SlidingWindowRateLimiter: 단일 프로세스용. 다중 인스턴스 운영 시에는 DB/공유 저장소 기반으로 교체해야 한다.
 *   (계정 단위 잠금은 users.failed_login_count / locked_until 로 DB 에서 강제되므로 인스턴스와 무관하게 동작한다.)
 * - 로그인: 이메일+IP 조합당 15분에 5회.
 */
import { AccountLockedError, RateLimitError } from './errors';

export interface RateLimitResult {
  allowed: boolean;
  /** 이번 요청 포함 창 안의 시도 수 */
  count: number;
  /** 남은 허용 횟수 */
  remaining: number;
  /** 차단 시 다시 허용되기까지 남은 시간(ms). 허용이면 0 */
  retryAfterMs: number;
}

export interface SlidingWindowOptions {
  /** 창 안에서 허용할 최대 횟수 */
  limit: number;
  windowMs: number;
  /** 테스트용 시계 주입 (ms) */
  now?: () => number;
  /** 메모리 상한: 키 수가 넘으면 가장 오래된 키부터 제거 */
  maxKeys?: number;
}

export class SlidingWindowRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly hits = new Map<string, number[]>();

  constructor(opts: SlidingWindowOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new RangeError('limit 은 1 이상의 정수여야 합니다.');
    if (!(opts.windowMs > 0)) throw new RangeError('windowMs 는 0보다 커야 합니다.');
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 50_000;
  }

  private live(key: string, t: number): number[] {
    const arr = this.hits.get(key);
    if (!arr) return [];
    const cutoff = t - this.windowMs;
    let i = 0;
    while (i < arr.length && arr[i]! <= cutoff) i++;
    if (i > 0) arr.splice(0, i);
    if (arr.length === 0) this.hits.delete(key);
    return arr;
  }

  private result(arr: number[], t: number, allowed: boolean): RateLimitResult {
    const count = arr.length;
    const retryAfterMs = allowed || count === 0 ? 0 : Math.max(0, arr[count - this.limit]! + this.windowMs - t);
    return { allowed, count, remaining: Math.max(0, this.limit - count), retryAfterMs };
  }

  /** 시도 1회를 기록한다. 이미 한도에 도달했으면 기록하지 않고 allowed=false */
  hit(key: string): RateLimitResult {
    const t = this.now();
    const arr = this.live(key, t);
    if (arr.length >= this.limit) return this.result(arr, t, false);
    const next = arr.length === 0 ? [] : arr;
    next.push(t);
    // 최근 사용 키를 Map 끝으로 이동 (오래된 키부터 제거하기 위해)
    this.hits.delete(key);
    this.hits.set(key, next);
    this.evict();
    return this.result(next, t, true);
  }

  /** 기록하지 않고 현재 상태만 조회 */
  peek(key: string): RateLimitResult {
    const t = this.now();
    const arr = this.live(key, t);
    return this.result(arr, t, arr.length < this.limit);
  }

  /** 한도 초과면 RateLimitError (429) */
  consume(key: string, userMessage?: string): RateLimitResult {
    const r = this.hit(key);
    if (!r.allowed) throw new RateLimitError(Math.ceil(r.retryAfterMs / 1000), userMessage);
    return r;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** 만료된 기록 정리 (주기적으로 호출해도 되고, 안 해도 hit 시 정리된다) */
  prune(): void {
    const t = this.now();
    for (const key of [...this.hits.keys()]) this.live(key, t);
  }

  get size(): number {
    return this.hits.size;
  }

  private evict(): void {
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

// ────────────────────────────── 로그인 전용 ──────────────────────────────

export const LOGIN_RATE_LIMIT = Object.freeze({ limit: 5, windowMs: 15 * 60_000 });

export function createLoginRateLimiter(opts: Partial<SlidingWindowOptions> = {}): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter({ ...LOGIN_RATE_LIMIT, ...opts });
}

/** 이메일(소문자·공백 제거) + IP 조합 키 */
export function loginRateLimitKey(email: string, ip: string | null | undefined): string {
  return `login:${String(email ?? '').trim().toLowerCase()}|${String(ip ?? '').trim() || 'unknown'}`;
}

export const LOGIN_RATE_LIMIT_MESSAGE =
  '로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요. 비밀번호를 잊었다면 사무소 관리자에게 재설정을 요청하세요.';

// ────────────────────────────── 계정 잠금 정책 (DB 컬럼 기반) ──────────────────────────────

type Env = Record<string, string | undefined>;

export interface LockoutPolicy {
  /** 연속 실패 허용 횟수 — 이 값에 도달하면 잠금 */
  maxFailedAttempts: number;
  lockMinutes: number;
}

export const DEFAULT_LOCKOUT_POLICY: Readonly<LockoutPolicy> = Object.freeze({ maxFailedAttempts: 5, lockMinutes: 15 });

/**
 * 환경변수 LOGIN_LOCKOUT_THRESHOLD(3~20), LOGIN_LOCKOUT_MINUTES(1~1440) 로 조정 가능. 범위 밖이면 기본값.
 * (선택 설정 — .env.example 에는 아직 없음)
 */
export function getLockoutPolicy(env: Env = process.env): LockoutPolicy {
  const num = (v: string | undefined, min: number, max: number, d: number) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : d;
  };
  return {
    maxFailedAttempts: num(env.LOGIN_LOCKOUT_THRESHOLD, 3, 20, DEFAULT_LOCKOUT_POLICY.maxFailedAttempts),
    lockMinutes: num(env.LOGIN_LOCKOUT_MINUTES, 1, 1440, DEFAULT_LOCKOUT_POLICY.lockMinutes),
  };
}

export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export function isAccountLocked(lockedUntil: Date | null | undefined, now: Date = new Date()): boolean {
  return !!lockedUntil && lockedUntil.getTime() > now.getTime();
}

/** 잠겨 있으면 AccountLockedError (423) */
export function assertNotLocked(lockedUntil: Date | null | undefined, now: Date = new Date()): void {
  if (lockedUntil && isAccountLocked(lockedUntil, now)) throw new AccountLockedError(lockedUntil, now);
}

/**
 * 로그인 실패 1회 반영 → users 에 저장할 새 상태.
 * - 이전 잠금이 끝난 뒤의 실패는 1부터 다시 센다.
 * - failedLoginCount ≥ maxFailedAttempts 가 되면 lockMinutes 동안 잠근다.
 */
export function registerFailedLogin(
  state: LockoutState,
  now: Date = new Date(),
  policy: LockoutPolicy = getLockoutPolicy(),
): LockoutState & { locked: boolean } {
  const lockExpired = !!state.lockedUntil && state.lockedUntil.getTime() <= now.getTime();
  const base = lockExpired || state.failedLoginCount < 0 ? 0 : state.failedLoginCount;
  const failedLoginCount = base + 1;
  if (failedLoginCount >= policy.maxFailedAttempts) {
    return { failedLoginCount, lockedUntil: new Date(now.getTime() + policy.lockMinutes * 60_000), locked: true };
  }
  return { failedLoginCount, lockedUntil: lockExpired ? null : state.lockedUntil, locked: false };
}

/** 로그인 성공 → 실패 횟수·잠금 초기화 */
export function registerSuccessfulLogin(): LockoutState {
  return { failedLoginCount: 0, lockedUntil: null };
}

/** 남은 허용 횟수 (UI 안내용: "3회 더 실패하면 잠깁니다") */
export function remainingLoginAttempts(state: LockoutState, now: Date = new Date(), policy: LockoutPolicy = getLockoutPolicy()): number {
  if (isAccountLocked(state.lockedUntil, now)) return 0;
  const lockExpired = !!state.lockedUntil && state.lockedUntil.getTime() <= now.getTime();
  const count = lockExpired ? 0 : Math.max(0, state.failedLoginCount);
  return Math.max(0, policy.maxFailedAttempts - count);
}
