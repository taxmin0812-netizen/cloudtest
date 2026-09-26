/**
 * 민감 필드 암호화 (AES-256-GCM, 키 버전) + HMAC blind index.
 *
 * 암호문 형식: '<keyVersion>:<ivB64>:<tagB64>:<ctB64>'   예) 'v1:...:...:...'
 * - IV 12바이트 무작위, 인증 태그 16바이트
 * - AAD 에 키 버전(및 선택적 컨텍스트)을 넣어, 버전 접두사나 컬럼을 바꿔치기하면 복호화가 실패한다
 *
 * 환경변수
 * - MINTAX_DATA_KEY           현재 키 (base64, 32바이트)
 * - MINTAX_DATA_KEY_VERSION   현재 키 버전 (기본 'v1')
 * - MINTAX_DATA_KEYS_PREVIOUS 복호화 전용 이전 키 'v0:base64,v1:base64'
 * - MINTAX_INDEX_KEY          blind index HMAC 키 (base64, 32바이트 이상, DATA_KEY 와 달라야 함)
 *
 * 운영(NODE_ENV=production)에서 키가 없으면 즉시 실패한다.
 * 개발/테스트에서만 결정적 개발용 키로 대체하고 경고를 출력한다.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigurationError, CryptoError, ValidationError } from './errors';

type Env = Record<string, string | undefined>;

export interface Keyring {
  /** 새로 암호화할 때 쓰는 키 버전 */
  readonly currentVersion: string;
  /** 버전 → 32바이트 키 */
  readonly keys: ReadonlyMap<string, Buffer>;
  /** 개발용 대체 키 사용 여부 (운영에서는 절대 true 가 될 수 없다) */
  readonly insecureDevKey: boolean;
}

export interface KeyEntry {
  version: string;
  /** Buffer(32바이트) 또는 base64 문자열 */
  key: Buffer | string;
}

const VERSION_RE = /^[A-Za-z0-9_-]{1,32}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DATA_KEY_LENGTH = 32;
const MIN_INDEX_KEY_LENGTH = 32;
export const DEFAULT_KEY_VERSION = 'v1';
/** 개발용 대체 키의 버전. 실제 키 버전과 겹치지 않게 별도 이름을 쓴다 → 운영 키로는 복호화 불가(명확한 오류) */
export const DEV_KEY_VERSION = 'dev';

const KEYGEN_HINT = `생성 방법: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`;

function devKey(label: string): Buffer {
  return createHash('sha256').update(`MINTAX-DEV-ONLY-INSECURE-${label}-KEY`).digest();
}
const DEV_DATA_KEY = devKey('DATA');
const DEV_INDEX_KEY = devKey('INDEX');

function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

function decodeKey(value: Buffer | string, name: string, exactLength: number | null, minLength = 0): Buffer {
  let buf: Buffer;
  if (Buffer.isBuffer(value)) {
    buf = Buffer.from(value);
  } else {
    const s = value.trim();
    if (!B64_RE.test(s) || s.length % 4 !== 0) {
      throw new ConfigurationError(`${name} 값이 올바른 base64 형식이 아닙니다. ${KEYGEN_HINT}`);
    }
    buf = Buffer.from(s, 'base64');
  }
  if (exactLength !== null && buf.length !== exactLength) {
    throw new ConfigurationError(`${name} 는 ${exactLength}바이트 키여야 합니다. (현재 ${buf.length}바이트) ${KEYGEN_HINT}`);
  }
  if (buf.length < minLength) {
    throw new ConfigurationError(`${name} 는 ${minLength}바이트 이상이어야 합니다. (현재 ${buf.length}바이트) ${KEYGEN_HINT}`);
  }
  return buf;
}

function assertVersion(version: string, name: string): void {
  if (!VERSION_RE.test(version)) {
    throw new ConfigurationError(`${name} 의 키 버전 '${version.slice(0, 40)}' 이(가) 올바르지 않습니다. 영문·숫자·'_'·'-' 1~32자로 지정하세요. (예: v1)`);
  }
}

export function createKeyring(current: KeyEntry, previous: readonly KeyEntry[] = [], insecureDevKey = false): Keyring {
  assertVersion(current.version, 'MINTAX_DATA_KEY_VERSION');
  const keys = new Map<string, Buffer>();
  keys.set(current.version, decodeKey(current.key, 'MINTAX_DATA_KEY', DATA_KEY_LENGTH));
  for (const p of previous) {
    assertVersion(p.version, 'MINTAX_DATA_KEYS_PREVIOUS');
    if (keys.has(p.version)) {
      throw new ConfigurationError(`키 버전 '${p.version}' 이(가) 중복되었습니다. MINTAX_DATA_KEYS_PREVIOUS 에 현재 버전과 다른 버전만 넣으세요.`);
    }
    keys.set(p.version, decodeKey(p.key, `MINTAX_DATA_KEYS_PREVIOUS(${p.version})`, DATA_KEY_LENGTH));
  }
  return Object.freeze({ currentVersion: current.version, keys, insecureDevKey });
}

/** 'v0:base64,v1:base64' → KeyEntry[] */
export function parsePreviousKeys(spec: string | undefined | null): KeyEntry[] {
  if (!spec || spec.trim() === '') return [];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((item) => {
      const idx = item.indexOf(':');
      if (idx <= 0) {
        throw new ConfigurationError(`MINTAX_DATA_KEYS_PREVIOUS 형식이 올바르지 않습니다. '버전:base64키' 를 쉼표로 구분해 입력하세요. (예: v0:AAAA...,v1:BBBB...)`);
      }
      return { version: item.slice(0, idx).trim(), key: item.slice(idx + 1).trim() };
    });
}

const devWarned = new Set<string>();
function warnDevKey(what: string, warn: (msg: string) => void): void {
  if (devWarned.has(what)) return;
  devWarned.add(what);
  warn(
    [
      '════════════════════════════════════════════════════════════════════',
      `[MIN TAX OPS 보안 경고] ${what} 가 설정되지 않아 "개발용 고정 키"를 사용합니다.`,
      '이 키는 소스코드에 공개된 값이므로 이 상태로 암호화한 주민번호·계좌 등은 보호되지 않습니다.',
      '실제 고객 데이터를 넣기 전에 .env 에 MINTAX_DATA_KEY / MINTAX_INDEX_KEY 를 설정하세요.',
      '운영 환경(NODE_ENV=production)에서는 키 없이 시작할 수 없습니다.',
      '════════════════════════════════════════════════════════════════════',
    ].join('\n'),
  );
}

export interface LoadKeyOptions {
  /** 개발용 키 경고 출력 함수 (기본 console.warn) */
  warn?: (msg: string) => void;
}

/** 환경변수에서 키링을 만든다. 운영에서 키가 없거나 잘못되면 ConfigurationError. */
export function loadKeyringFromEnv(env: Env = process.env, opts: LoadKeyOptions = {}): Keyring {
  const raw = env.MINTAX_DATA_KEY?.trim();
  const previous = parsePreviousKeys(env.MINTAX_DATA_KEYS_PREVIOUS);
  if (!raw) {
    if (isProduction(env)) {
      throw new ConfigurationError(
        `MINTAX_DATA_KEY 환경변수가 설정되지 않았습니다. 운영 환경에서는 암호화 키 없이 시작할 수 없습니다. base64 32바이트 키를 설정하세요. ${KEYGEN_HINT}`,
      );
    }
    warnDevKey('MINTAX_DATA_KEY', opts.warn ?? console.warn);
    return createKeyring({ version: DEV_KEY_VERSION, key: DEV_DATA_KEY }, previous, true);
  }
  const version = env.MINTAX_DATA_KEY_VERSION?.trim() || DEFAULT_KEY_VERSION;
  const keyring = createKeyring({ version, key: raw }, previous, false);
  if (isProduction(env)) {
    for (const [v, k] of keyring.keys) {
      if (timingSafeEqual(k, DEV_DATA_KEY)) {
        throw new ConfigurationError(`키 버전 '${v}' 에 개발용 공개 키가 설정되어 있습니다. 운영에서는 새 무작위 키를 사용하세요. ${KEYGEN_HINT}`);
      }
    }
  }
  return keyring;
}

/** blind index 용 HMAC 키 */
export function loadIndexKeyFromEnv(env: Env = process.env, opts: LoadKeyOptions = {}): Buffer {
  const raw = env.MINTAX_INDEX_KEY?.trim();
  if (!raw) {
    if (isProduction(env)) {
      throw new ConfigurationError(
        `MINTAX_INDEX_KEY 환경변수가 설정되지 않았습니다. 운영 환경에서는 검색용 해시 키 없이 시작할 수 없습니다. MINTAX_DATA_KEY 와 다른 base64 32바이트 키를 설정하세요. ${KEYGEN_HINT}`,
      );
    }
    warnDevKey('MINTAX_INDEX_KEY', opts.warn ?? console.warn);
    return Buffer.from(DEV_INDEX_KEY);
  }
  const key = decodeKey(raw, 'MINTAX_INDEX_KEY', null, MIN_INDEX_KEY_LENGTH);
  if (isProduction(env)) {
    if (key.length === DEV_INDEX_KEY.length && timingSafeEqual(key, DEV_INDEX_KEY)) {
      throw new ConfigurationError(`MINTAX_INDEX_KEY 에 개발용 공개 키가 설정되어 있습니다. 운영에서는 새 무작위 키를 사용하세요. ${KEYGEN_HINT}`);
    }
    const data = env.MINTAX_DATA_KEY?.trim();
    if (data && data === raw) {
      throw new ConfigurationError('MINTAX_INDEX_KEY 와 MINTAX_DATA_KEY 가 같습니다. 두 키는 서로 다른 값이어야 합니다.');
    }
  }
  return key;
}

/**
 * 서버·워커 시작 시 호출: 키 설정을 검증한다. 운영에서 문제가 있으면 예외(시작 차단),
 * 개발에서는 경고 목록을 돌려준다.
 */
export function assertSecurityConfig(env: Env = process.env, opts: LoadKeyOptions = {}): { warnings: string[] } {
  const warnings: string[] = [];
  const keyring = loadKeyringFromEnv(env, opts);
  loadIndexKeyFromEnv(env, opts);
  if (keyring.insecureDevKey) warnings.push('MINTAX_DATA_KEY 미설정 — 개발용 고정 키 사용 중');
  if (!env.MINTAX_INDEX_KEY?.trim()) warnings.push('MINTAX_INDEX_KEY 미설정 — 개발용 고정 키 사용 중');
  if (env.MINTAX_DATA_KEY?.trim() && env.MINTAX_DATA_KEY.trim() === env.MINTAX_INDEX_KEY?.trim()) {
    warnings.push('MINTAX_INDEX_KEY 와 MINTAX_DATA_KEY 가 같습니다 — 서로 다른 키를 사용하세요');
  }
  // .env.example 기본값(COOKIE_SECURE=false)을 운영에 그대로 복사한 경우. 사내 LAN(http) 운영을 막지 않도록 경고만 한다.
  if (isProduction(env) && env.COOKIE_SECURE?.trim().toLowerCase() === 'false') {
    warnings.push('운영 환경인데 COOKIE_SECURE=false 입니다 — HTTPS 로 접속하게 하고 COOKIE_SECURE=true 로 바꾸세요 (세션 쿠키가 암호화되지 않은 연결로 전송될 수 있음)');
  }
  return { warnings };
}

// ── 기본 키링 캐시 (환경변수가 바뀌면 다시 읽는다: 테스트·키 교체 대응) ──

let cachedKeyring: { sig: string; keyring: Keyring } | null = null;
let cachedIndexKey: { sig: string; key: Buffer } | null = null;

function envSig(...names: string[]): string {
  return [process.env.NODE_ENV ?? '', ...names.map((n) => process.env[n] ?? '')].join('\u0000');
}

export function getKeyring(): Keyring {
  const sig = envSig('MINTAX_DATA_KEY', 'MINTAX_DATA_KEY_VERSION', 'MINTAX_DATA_KEYS_PREVIOUS');
  if (cachedKeyring?.sig !== sig) cachedKeyring = { sig, keyring: loadKeyringFromEnv(process.env) };
  return cachedKeyring.keyring;
}

export function getIndexKey(): Buffer {
  const sig = envSig('MINTAX_INDEX_KEY', 'MINTAX_DATA_KEY');
  if (cachedIndexKey?.sig !== sig) cachedIndexKey = { sig, key: loadIndexKeyFromEnv(process.env) };
  return cachedIndexKey.key;
}

/** 테스트용: 캐시와 개발용 키 경고 상태 초기화 */
export function resetSecurityKeyCache(): void {
  cachedKeyring = null;
  cachedIndexKey = null;
  devWarned.clear();
}

// ────────────────────────────── 필드 암호화 ──────────────────────────────

export interface FieldCryptoOptions {
  /**
   * 추가 인증 데이터 (예: 'employees.id_number'). 지정하면 복호화 때도 같은 값을 줘야 한다.
   * 다른 컬럼으로 암호문을 옮겨 붙이는 공격을 막는다.
   */
  context?: string;
}

function aadFor(version: string, context?: string): Buffer {
  return Buffer.from(context ? `mintax:${version}:${context}` : `mintax:${version}`, 'utf8');
}

interface ParsedCiphertext {
  version: string;
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

function parseCiphertext(ciphertext: string): ParsedCiphertext {
  if (typeof ciphertext !== 'string') throw new CryptoError('CRYPTO_FORMAT', '암호문이 문자열이 아닙니다.');
  const parts = ciphertext.split(':');
  if (parts.length !== 4) throw new CryptoError('CRYPTO_FORMAT', '암호문 형식이 올바르지 않습니다. (버전:iv:tag:ct)');
  const [version, ivS, tagS, ctS] = parts as [string, string, string, string];
  if (!VERSION_RE.test(version) || !B64_RE.test(ivS) || !B64_RE.test(tagS) || !B64_RE.test(ctS)) {
    throw new CryptoError('CRYPTO_FORMAT', '암호문 형식이 올바르지 않습니다.');
  }
  const iv = Buffer.from(ivS, 'base64');
  const tag = Buffer.from(tagS, 'base64');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new CryptoError('CRYPTO_FORMAT', '암호문의 IV/인증태그 길이가 올바르지 않습니다.');
  }
  return { version, iv, tag, ct: Buffer.from(ctS, 'base64') };
}

/** 문자열이 이 모듈의 암호문 형식인지 (복호화 가능 여부와 무관) */
export function isEncryptedField(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseCiphertext(value);
    return true;
  } catch {
    return false;
  }
}

/** 암호문의 키 버전. 형식이 틀리면 null */
export function ciphertextKeyVersion(ciphertext: string): string | null {
  try {
    return parseCiphertext(ciphertext).version;
  } catch {
    return null;
  }
}

export function encryptField(plaintext: string, keyring: Keyring = getKeyring(), opts: FieldCryptoOptions = {}): string {
  if (typeof plaintext !== 'string') throw new CryptoError('CRYPTO_INVALID_INPUT', '암호화할 값은 문자열이어야 합니다.');
  const version = keyring.currentVersion;
  const key = keyring.keys.get(version);
  if (!key) throw new CryptoError('CRYPTO_UNKNOWN_KEY', `현재 키 버전 '${version}' 의 키가 키링에 없습니다.`);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aadFor(version, opts.context));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptField(ciphertext: string, keyring: Keyring = getKeyring(), opts: FieldCryptoOptions = {}): string {
  const { version, iv, tag, ct } = parseCiphertext(ciphertext);
  const key = keyring.keys.get(version);
  if (!key) {
    throw new CryptoError(
      'CRYPTO_UNKNOWN_KEY',
      `키 버전 '${version}' 의 키가 없습니다. 이전 키라면 MINTAX_DATA_KEYS_PREVIOUS 에 '${version}:<base64키>' 로 등록하세요.`,
    );
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAAD(aadFor(version, opts.context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new CryptoError('CRYPTO_AUTH_FAILED', '암호문 무결성 검증에 실패했습니다. (변조되었거나 다른 키·컨텍스트로 암호화된 값)');
  }
}

/** DB nullable 컬럼용: null/undefined/'' → null */
export function encryptOptional(plaintext: string | null | undefined, keyring?: Keyring, opts?: FieldCryptoOptions): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return encryptField(plaintext, keyring, opts);
}

export function decryptOptional(ciphertext: string | null | undefined, keyring?: Keyring, opts?: FieldCryptoOptions): string | null {
  if (ciphertext === null || ciphertext === undefined || ciphertext === '') return null;
  return decryptField(ciphertext, keyring, opts);
}

/** 현재 키 버전이 아니면 true → 재암호화 대상 */
export function needsRotation(ciphertext: string, keyring: Keyring = getKeyring()): boolean {
  return parseCiphertext(ciphertext).version !== keyring.currentVersion;
}

/**
 * 현재 키로 다시 암호화한다 (키 교체 작업용).
 * 이미 현재 버전이면 그대로 돌려준다 (force=true 면 새 IV 로 재암호화).
 * 이전 키로 복호화할 수 없으면 CryptoError.
 */
export function rotateField(
  ciphertext: string,
  keyring: Keyring = getKeyring(),
  opts: FieldCryptoOptions & { force?: boolean } = {},
): string {
  const plain = decryptField(ciphertext, keyring, opts);
  if (!opts.force && parseCiphertext(ciphertext).version === keyring.currentVersion) return ciphertext;
  return encryptField(plain, keyring, opts);
}

// ────────────────────────────── Blind index ──────────────────────────────

/** 알려진 용도 + 사용자 정의 용도 문자열 */
export type BlindIndexPurpose =
  | 'rrn' // 주민(외국인)등록번호
  | 'bank_account'
  | 'business_number'
  | 'phone'
  | 'email'
  | 'recovery_code'
  | (string & {});

const PURPOSE_RE = /^[a-z0-9_.-]{1,64}$/;
const DIGITS_ONLY = new Set(['rrn', 'bank_account', 'business_number', 'phone']);

/** 용도별 정규화: 주민번호·계좌·사업자번호·전화는 숫자만, 이메일은 소문자 */
export function normalizeForBlindIndex(value: string, purpose: BlindIndexPurpose): string {
  const s = String(value ?? '').normalize('NFKC').trim();
  if (DIGITS_ONLY.has(purpose)) return s.replace(/\D/g, '');
  if (purpose === 'email') return s.toLowerCase();
  if (purpose === 'recovery_code') return s.toUpperCase().replace(/[\s-]/g, '');
  return s;
}

/** 마스킹 문자 (*, ＊, ●, •, ○, ■, □) — 마스킹된 번호로 해시를 만들면 서로 다른 사람이 같은 값이 된다 */
const MASK_CHAR_RE = /[*＊●•○■□]/;
/** 숫자 자릿수가 고정된 용도 */
const EXACT_DIGITS: Readonly<Record<string, { digits: number; label: string }>> = {
  rrn: { digits: 13, label: '주민(외국인)등록번호는 13자리' },
  business_number: { digits: 10, label: '사업자등록번호는 10자리' },
};
const MIN_DIGITS = 6;

/**
 * 검색·중복확인용 HMAC-SHA256 (hex 64자). 복호화할 수 없다.
 * 용도(purpose)가 다르면 같은 값이라도 다른 해시가 나온다.
 *
 * 숫자형 용도(rrn·bank_account·business_number·phone)는 마스킹 값('900101-1******')이나 자릿수가 틀린 값을 거부한다.
 * 숫자만 남기면 '9001011' 처럼 짧아져 생년월일·성별이 같은 다른 직원과 해시가 겹치고,
 * employees.id_number_hash 로 동일인 판정할 때 서로 다른 직원의 급여가 합쳐질 수 있기 때문이다.
 */
export function blindIndex(value: string, purpose: BlindIndexPurpose, key: Buffer = getIndexKey()): string {
  if (!PURPOSE_RE.test(purpose)) throw new CryptoError('CRYPTO_INVALID_INPUT', `blind index 용도 '${String(purpose).slice(0, 40)}' 가 올바르지 않습니다.`);
  const normalized = normalizeForBlindIndex(value, purpose);
  if (normalized === '') throw new ValidationError('검색할 값이 비어 있습니다.', [], `blindIndex(${purpose}): 정규화 후 빈 값`);
  if (DIGITS_ONLY.has(purpose)) {
    if (MASK_CHAR_RE.test(String(value))) {
      throw new ValidationError(
        '마스킹된 번호로는 조회·중복확인을 할 수 없습니다. 원본 번호 전체를 입력해 주세요.',
        [],
        `blindIndex(${purpose}): 마스킹 문자 포함`,
      );
    }
    const exact = EXACT_DIGITS[purpose];
    if (exact && normalized.length !== exact.digits) {
      throw new ValidationError(`${exact.label}여야 합니다. 번호를 확인해 주세요.`, [], `blindIndex(${purpose}): 자릿수 ${normalized.length}`);
    }
    if (!exact && normalized.length < MIN_DIGITS) {
      throw new ValidationError('번호가 너무 짧습니다. 번호 전체를 입력해 주세요.', [], `blindIndex(${purpose}): 자릿수 ${normalized.length}`);
    }
  }
  return createHmac('sha256', key).update(purpose).update('\u0000').update(normalized, 'utf8').digest('hex');
}

// ────────────────────────────── 기타 유틸 ──────────────────────────────

/** 길이가 달라도 시간 차이를 줄인 문자열 비교 (서명·토큰 비교용) */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ha = createHash('sha256').update(String(a), 'utf8').digest();
  const hb = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function hmacSha256Hex(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}
