/**
 * TOTP (RFC 6238, HMAC-SHA1, 6자리, 30초) + 복구 코드.
 *
 * - 비밀(base32)은 users.mfa_secret_enc 에 encryptField() 로 암호화해 저장한다.
 * - 재사용 방지: 검증에 성공한 time step 을 저장해 두고(lastUsedStep), 같거나 이전 step 의 코드는 거부한다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { blindIndex, getIndexKey } from './crypto';
import { CryptoError } from './errors';

export const TOTP_ISSUER = 'MIN TAX OPS';
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
const MIN_SECRET_BYTES = 10; // RFC 4226: 최소 128bit 권장, 80bit 미만은 거부
const MAX_WINDOW = 10;

// ────────────────────────────── base32 (RFC 4648) ──────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** 대소문자·공백·'-'·패딩('=') 무시. 잘못된 문자가 있으면 CryptoError */
export function base32Decode(input: string): Buffer {
  const s = String(input).toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new CryptoError('CRYPTO_INVALID_INPUT', 'OTP 비밀 값에 base32 가 아닌 문자가 있습니다.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

// ────────────────────────────── TOTP ──────────────────────────────

/** 새 TOTP 비밀 (기본 20바이트 = 160bit, base32 32자) */
export function generateTotpSecret(bytes = 20): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) throw new RangeError('TOTP 비밀 길이는 16~64바이트여야 합니다.');
  return base32Encode(randomBytes(bytes));
}

export interface TotpUriInput {
  secret: string;
  /** 인증 앱에 표시될 계정 (보통 이메일) */
  account: string;
  issuer?: string;
}

/** 인증 앱 등록용 otpauth:// URI (QR 코드로 표시) */
export function totpUri({ secret, account, issuer = TOTP_ISSUER }: TotpUriInput): string {
  const cleanSecret = base32Encode(base32Decode(secret));
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = [
    `secret=${cleanSecret}`,
    `issuer=${encodeURIComponent(issuer)}`,
    'algorithm=SHA1',
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`,
  ];
  return `otpauth://totp/${label}?${params.join('&')}`;
}

function toMs(now: number | Date | undefined): number {
  if (now === undefined) return Date.now();
  return now instanceof Date ? now.getTime() : now;
}

/** 현재 time step (Unix 초 / 30) */
export function totpStep(now?: number | Date, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(toMs(now) / 1000 / period);
}

/** RFC 4226 HOTP */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError('HOTP counter 가 올바르지 않습니다.');
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new RangeError('OTP 자릿수는 6~8 이어야 합니다.');
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

function decodeSecret(secret: string): Buffer {
  const key = base32Decode(secret);
  if (key.length < MIN_SECRET_BYTES) throw new CryptoError('CRYPTO_INVALID_INPUT', 'OTP 비밀 값이 너무 짧습니다. (80bit 미만)');
  return key;
}

export interface TotpOptions {
  digits?: number;
  period?: number;
}

/** 특정 시각의 TOTP 코드 (테스트·디버그용) */
export function generateTotp(secret: string, now?: number | Date, opts: TotpOptions = {}): string {
  return hotp(decodeSecret(secret), totpStep(now, opts.period ?? TOTP_PERIOD_SECONDS), opts.digits ?? TOTP_DIGITS);
}

export interface TotpVerifyOptions extends TotpOptions {
  /** 마지막으로 성공한 time step. 이 값 이하 step 의 코드는 재사용으로 거부 */
  lastUsedStep?: number | null;
}

export type TotpVerifyResult =
  | { valid: true; /** 저장할 새 lastUsedStep */ step: number; /** 시계 오차 (step 단위) */ drift: number }
  | { valid: false; reason: 'malformed' | 'mismatch' | 'replayed' };

/**
 * TOTP 검증. window=1 이면 앞뒤 30초(±1 step)까지 허용한다.
 * 성공 시 step 을 users 측에 저장해 두고 다음 검증 때 lastUsedStep 으로 넘긴다.
 */
export function verifyTotp(
  secret: string,
  code: string,
  window = 1,
  now?: number | Date,
  opts: TotpVerifyOptions = {},
): TotpVerifyResult {
  const digits = opts.digits ?? TOTP_DIGITS;
  const period = opts.period ?? TOTP_PERIOD_SECONDS;
  const normalized = String(code ?? '').replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return { valid: false, reason: 'malformed' };
  const key = decodeSecret(secret);
  const w = Math.min(MAX_WINDOW, Math.max(0, Math.floor(window)));
  const current = totpStep(now, period);
  const given = Buffer.from(normalized);

  // 일치 여부와 무관하게 모든 후보를 계산 (시간차 최소화). 현재 step 에 가까운 것을 우선.
  let matched: number | null = null;
  for (const d of [0, ...Array.from({ length: w }, (_, i) => [-(i + 1), i + 1]).flat()]) {
    const step = current + d;
    if (step < 0) continue;
    const eq = timingSafeEqual(Buffer.from(hotp(key, step, digits)), given);
    if (eq && matched === null) matched = step;
  }
  if (matched === null) return { valid: false, reason: 'mismatch' };
  if (isTotpReplay(matched, opts.lastUsedStep)) return { valid: false, reason: 'replayed' };
  return { valid: true, step: matched, drift: matched - current };
}

/** step 이 이미 사용된 step 이하이면 재사용 */
export function isTotpReplay(step: number, lastUsedStep: number | null | undefined): boolean {
  return lastUsedStep !== null && lastUsedStep !== undefined && step <= lastUsedStep;
}

/**
 * 단일 프로세스용 메모리 재사용 방지기.
 * DB 에 last step 을 저장할 수 없을 때의 보조 수단 (다중 인스턴스에서는 DB 저장이 필요).
 */
export class TotpReplayGuard {
  private readonly last = new Map<string, { step: number; at: number }>();
  constructor(private readonly maxEntries = 10_000, private readonly ttlMs = 10 * 60_000) {}

  /** 사용 가능한 step 이면 기록하고 true, 재사용이면 false */
  consume(userKey: string, step: number, nowMs = Date.now()): boolean {
    const prev = this.last.get(userKey);
    if (prev && nowMs - prev.at < this.ttlMs && step <= prev.step) return false;
    this.last.delete(userKey);
    this.last.set(userKey, { step, at: nowMs });
    if (this.last.size > this.maxEntries) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    return true;
  }

  lastStep(userKey: string): number | null {
    return this.last.get(userKey)?.step ?? null;
  }
}

// ────────────────────────────── 복구 코드 ──────────────────────────────

/** 혼동되는 문자(0/O, 1/I) 제외 32자 → 바이트 & 31 로 균등 선택 */
const RECOVERY_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * 복구 코드 생성 ('XXXXX-XXXXX', 50bit). 사용자에게 한 번만 보여주고, 저장은 hashRecoveryCode() 값만 한다.
 */
export function generateRecoveryCodes(count = 10): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new RangeError('복구 코드 개수는 1~20개여야 합니다.');
  const codes = new Set<string>();
  while (codes.size < count) {
    const bytes = randomBytes(10);
    let s = '';
    for (const b of bytes) s += RECOVERY_CHARS[b & 31];
    codes.add(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return [...codes];
}

export function normalizeRecoveryCode(code: string): string {
  return String(code ?? '').normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * 복구 코드 저장용 해시: MINTAX_INDEX_KEY 기반 HMAC (DB 유출만으로는 오프라인 대입 불가).
 */
export function hashRecoveryCode(code: string, key: Buffer = getIndexKey()): string {
  return blindIndex(normalizeRecoveryCode(code), 'recovery_code', key);
}

/**
 * 입력 코드가 저장된 해시 목록 중 어느 것과 일치하는지 (index, 없으면 -1).
 * 사용된 코드는 호출 측에서 목록에서 제거해야 한다 (1회용).
 */
export function verifyRecoveryCode(code: string, hashes: readonly string[], key: Buffer = getIndexKey()): number {
  const normalized = normalizeRecoveryCode(code);
  if (!/^[A-Z0-9]{10}$/.test(normalized)) return -1;
  const h = Buffer.from(hashRecoveryCode(normalized, key), 'hex');
  let found = -1;
  hashes.forEach((stored, i) => {
    const s = Buffer.from(String(stored), 'hex');
    if (s.length === h.length && timingSafeEqual(s, h) && found === -1) found = i;
  });
  return found;
}
