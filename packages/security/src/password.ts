/**
 * 비밀번호 해시 (scrypt) 와 비밀번호 정책.
 *
 * 저장 형식: 'scrypt$N$r$p$saltB64$hashB64'  (users.password_hash)
 * - 평문 저장·로그 절대 금지
 * - 파라미터가 해시 문자열에 포함되므로, 기본값을 올린 뒤 needsRehash() 로 로그인 시 점진 업그레이드한다.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export interface ScryptParams {
  /** CPU/메모리 비용 (2의 거듭제곱) */
  N: number;
  r: number;
  p: number;
  /** 해시 길이 (bytes) */
  keyLength: number;
  /** salt 길이 (bytes) */
  saltLength: number;
}

export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({
  N: 2 ** 15,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
});

/** 저장된 해시에서 읽은 파라미터의 허용 범위 (DB 값으로 메모리 폭주를 일으키지 못하게) */
const LIMITS = { minN: 2 ** 10, maxN: 2 ** 18, maxR: 32, maxP: 16, minKey: 16, maxKey: 128, minSalt: 8, maxSalt: 64 };

/** 매우 긴 입력으로 인한 CPU 낭비 방지 */
export const PASSWORD_MAX_LENGTH = 256;
export const PASSWORD_MIN_LENGTH = 10;

function scryptAsync(password: string, salt: Buffer, keyLength: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLength, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function scryptOptions(N: number, r: number, p: number): ScryptOptions {
  // 필요 메모리 ≈ 128·N·r (+ 128·r·p). Node 기본 maxmem(32MiB)은 N=2^15,r=8 에서 경계값이라 여유를 둔다.
  return { N, r, p, maxmem: 128 * N * r * 2 + 128 * r * p + 1024 * 1024 };
}

/** 한글 조합형/완성형, 전각 문자 차이로 로그인이 실패하지 않도록 정규화 */
function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export async function hashPassword(password: string, params: Partial<ScryptParams> = {}): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('비밀번호가 비어 있습니다.');
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new RangeError(`비밀번호는 ${PASSWORD_MAX_LENGTH}자 이하여야 합니다.`);
  }
  const p = { ...DEFAULT_SCRYPT_PARAMS, ...params };
  const salt = randomBytes(p.saltLength);
  const hash = await scryptAsync(normalizePassword(password), salt, p.keyLength, scryptOptions(p.N, p.r, p.p));
  return ['scrypt', p.N, p.r, p.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isPowerOfTwo(n: number): boolean {
  return Number.isSafeInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

function parseHash(stored: string): ParsedHash | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, nS, rS, pS, saltS, hashS] = parts as [string, string, string, string, string, string];
  if (!/^\d+$/.test(nS) || !/^\d+$/.test(rS) || !/^\d+$/.test(pS)) return null;
  const N = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  if (!isPowerOfTwo(N) || N < LIMITS.minN || N > LIMITS.maxN) return null;
  if (r < 1 || r > LIMITS.maxR || p < 1 || p > LIMITS.maxP) return null;
  if (!B64_RE.test(saltS) || !B64_RE.test(hashS)) return null;
  const salt = Buffer.from(saltS, 'base64');
  const hash = Buffer.from(hashS, 'base64');
  if (salt.length < LIMITS.minSalt || salt.length > LIMITS.maxSalt) return null;
  if (hash.length < LIMITS.minKey || hash.length > LIMITS.maxKey) return null;
  return { N, r, p, salt, hash };
}

/** 저장 형식이 올바른 scrypt 해시인지 (평문이 잘못 저장된 경우 탐지용) */
export function isPasswordHash(stored: string): boolean {
  return parseHash(stored) !== null;
}

/**
 * 비밀번호 검증. 형식이 잘못된 해시는 false (예외를 던지지 않는다).
 * 비교는 timingSafeEqual 로 한다.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX_LENGTH) return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const actual = await scryptAsync(
    normalizePassword(password),
    parsed.salt,
    parsed.hash.length,
    scryptOptions(parsed.N, parsed.r, parsed.p),
  );
  return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
}

/** 현재 기본 파라미터보다 약하거나 형식이 다르면 true → 로그인 성공 직후 재해시해 저장 */
export function needsRehash(stored: string, params: Partial<ScryptParams> = {}): boolean {
  const target = { ...DEFAULT_SCRYPT_PARAMS, ...params };
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return (
    parsed.N !== target.N ||
    parsed.r !== target.r ||
    parsed.p !== target.p ||
    parsed.hash.length !== target.keyLength ||
    parsed.salt.length < target.saltLength
  );
}

let dummyHashPromise: Promise<string> | null = null;

/**
 * 존재하지 않는 이메일로 로그인 시도할 때도 같은 시간을 쓰게 해 계정 존재 여부 노출(타이밍)을 막는다.
 * 항상 false.
 */
export async function verifyPasswordDummy(password: string): Promise<false> {
  dummyHashPromise ??= hashPassword(randomBytes(24).toString('base64'));
  await verifyPassword(typeof password === 'string' && password.length > 0 ? password : 'x', await dummyHashPromise);
  return false;
}

// ────────────────────────────── 비밀번호 정책 ──────────────────────────────

export interface PasswordPolicyResult {
  ok: boolean;
  /** 사용자에게 보여줄 한국어 사유 목록 (ok 면 빈 배열) */
  errors: string[];
}

export interface PasswordPolicyContext {
  /** 이메일 아이디(@ 앞부분)가 비밀번호에 들어가면 거부 */
  email?: string | null;
}

/**
 * 비밀번호 정책
 * - 10자 이상 (256자 이하)
 * - 영문 대문자 / 영문 소문자 / 숫자 / 특수문자(한글 등 기타 문자 포함) 중 3종류 이상
 * - 이메일 아이디(3자 이상일 때) 포함 금지 (대소문자 무시)
 */
export function validatePasswordPolicy(password: string, ctx: PasswordPolicyContext = {}): PasswordPolicyResult {
  const errors: string[] = [];
  const pw = typeof password === 'string' ? password : '';

  if ([...pw].length < PASSWORD_MIN_LENGTH) {
    errors.push(`비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`);
  }
  if (pw.length > PASSWORD_MAX_LENGTH) {
    errors.push(`비밀번호는 ${PASSWORD_MAX_LENGTH}자 이하여야 합니다.`);
  }

  const classes = [/[A-Z]/.test(pw), /[a-z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length;
  if (classes < 3) {
    errors.push('영문 대문자, 영문 소문자, 숫자, 특수문자 중 3종류 이상을 섞어 주세요.');
  }

  const email = ctx.email?.trim().toLowerCase() ?? '';
  const at = email.indexOf('@');
  if (at > 0) {
    const local = email.slice(0, at);
    const lower = pw.normalize('NFKC').toLowerCase();
    // 'kim+tax@...' → 'kim+tax' 와 'kim' 모두 검사
    const candidates = new Set([local, local.split('+')[0] ?? ''].filter((c) => c.length >= 3));
    if ([...candidates].some((c) => lower.includes(c))) {
      errors.push('비밀번호에 이메일 아이디를 포함할 수 없습니다.');
    }
  }

  return { ok: errors.length === 0, errors };
}
