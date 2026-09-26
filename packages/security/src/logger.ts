/**
 * 민감정보 제거 JSON-line 로거.
 *
 * 모든 메시지·컨텍스트·오류(스택 포함)는 출력 전에 반드시
 *  1) 키 이름 기반 차단 (password, token, secret, idNumber, rrn, bankAccount, cardNumber, authorization, cookie …) → '[REDACTED]'
 *  2) 패턴 기반 스크럽 (@mintax/core scrubSensitive + 보강 패턴: 주민번호·카드번호·Bearer 토큰)
 * 을 거친다. 주민번호 원문은 어떤 경로로도 로그에 남지 않는다.
 */
import { scrubSensitive } from '../../core/src/normalize';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 8;
const MAX_ARRAY = 100;
const MAX_KEYS = 200;
const MAX_STRING = 8_000;

// ────────────────────────────── 문자열 스크럽 ──────────────────────────────

/**
 * 패턴 기반 민감정보 제거.
 * core.scrubSensitive 는 \b 경계를 쓰므로 'id_9001011234567' 처럼 밑줄·영문에 붙은 번호를 놓친다 → 숫자 경계로 보강.
 */
export function scrubText(text: string): string {
  let s = scrubSensitive(text);
  // 주민(외국인)등록번호: 앞 6자리+성별자리만 남김 (maskResidentNumber 와 동일 형태)
  s = s.replace(/(?<![0-9A-Za-z])(\d{6})[-\s]?([1-8])\d{6}(?!\d)/g, '$1-$2******');
  // 카드번호 16자리
  s = s.replace(/(?<!\d)(\d{4})[-\s]?\d{4}[-\s]?\d{4}[-\s]?(\d{4})(?!\d)/g, '$1-****-****-$2');
  // Authorization 헤더 값
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`);
  // key=value / "key": "value" 형태의 추가 민감 키
  s = s.replace(
    /((?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie|rrn|resident[_-]?number|id[_-]?number)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi,
    `$1${REDACTED}`,
  );
  return s;
}

// ────────────────────────────── 키 기반 차단 ──────────────────────────────

/** 정규화(소문자, 영숫자만)된 키에 포함되면 차단 */
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'idnumber',
  'residentnumber',
  'residentno',
  'juminno',
  'jumin',
  'bankaccount',
  'accountnumber',
  'cardnumber',
  'cardno',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'accesskey',
  'datakey',
  'indexkey',
  'recoverycode',
  'mfacode',
  'otpcode',
  'totp',
  'credential',
  'signature',
] as const;

/** 정확히 일치하면 차단 (부분 일치로 쓰면 오탐이 많은 짧은 키) */
const SENSITIVE_KEY_EXACT = new Set(['rrn', 'ssn', 'otp', 'pin', 'cvc', 'cvv', 'auth']);

/** 마스킹된 값(끝이 masked)은 이미 안전한 형태 → 키 차단 대신 패턴 스크럽만 */
const SAFE_SUFFIXES = ['masked'];

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k === '') return false;
  if (SAFE_SUFFIXES.some((s) => k.endsWith(s))) return false;
  if (SENSITIVE_KEY_EXACT.has(k)) return true;
  if (k.startsWith('rrn') || k.endsWith('rrn')) return true;
  return SENSITIVE_KEY_PARTS.some((p) => k.includes(p));
}

// ────────────────────────────── 값 정리 ──────────────────────────────

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  httpStatus?: number;
  userMessage?: string;
  stack?: string;
  cause?: unknown;
  [key: string]: unknown;
}

function truncate(s: string): string {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[${s.length - MAX_STRING}자 생략]` : s;
}

/** Error → 스크럽된 평범한 객체 (stack 포함, cause 재귀) */
export function serializeError(err: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): SerializedError {
  if (!(err instanceof Error)) {
    return { name: 'NonError', message: truncate(scrubText(safeString(err))) };
  }
  seen.add(err);
  const out: SerializedError = {
    name: err.name,
    message: truncate(scrubText(err.message ?? '')),
  };
  const e = err as Error & { code?: unknown; httpStatus?: unknown; userMessage?: unknown; details?: unknown };
  if (typeof e.code === 'string' || typeof e.code === 'number') out.code = scrubText(String(e.code));
  if (typeof e.httpStatus === 'number') out.httpStatus = e.httpStatus;
  if (typeof e.userMessage === 'string') out.userMessage = scrubText(e.userMessage);
  if (typeof err.stack === 'string') out.stack = truncate(scrubText(err.stack));
  if (e.details !== undefined) out.details = sanitize(e.details, seen, depth + 1);
  if (err.cause !== undefined) {
    out.cause =
      err.cause instanceof Error
        ? seen.has(err.cause)
          ? '[Circular]'
          : depth >= MAX_DEPTH
            ? '[Truncated]'
            : serializeError(err.cause, seen, depth + 1)
        : sanitize(err.cause, seen, depth + 1);
  }
  // AggregateError 등
  if (Array.isArray((err as { errors?: unknown }).errors)) {
    out.errors = sanitize((err as unknown as { errors: unknown[] }).errors, seen, depth + 1);
  }
  return out;
}

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return '[Unprintable]';
  }
}

function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return truncate(scrubText(value));
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'symbol':
      return value.toString();
    case 'function':
      return '[Function]';
    default:
      break;
  }
  const obj = value as object;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof Error) {
    if (seen.has(obj)) return '[Circular]';
    return serializeError(value, seen, depth);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return `[binary ${(value as { byteLength: number }).byteLength} bytes]`;
  }
  if (seen.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      const arr = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, seen, depth + 1));
      if (value.length > MAX_ARRAY) arr.push(`…[${value.length - MAX_ARRAY}개 생략]`);
      return arr;
    }
    if (value instanceof Map) {
      return sanitizeEntries([...value.entries()].map(([k, v]) => [safeString(k), v]), seen, depth);
    }
    if (value instanceof Set) {
      return sanitize([...value], seen, depth);
    }
    if (value instanceof URL) {
      return scrubUrl(value);
    }
    return sanitizeEntries(Object.entries(value as Record<string, unknown>), seen, depth);
  } finally {
    // 같은 객체가 형제 위치에 반복 등장하는 것은 순환이 아니므로 허용
    seen.delete(obj);
  }
}

function scrubUrl(u: URL): string {
  const copy = new URL(u.toString());
  if (copy.password) copy.password = REDACTED;
  for (const k of [...copy.searchParams.keys()]) {
    if (isSensitiveKey(k)) copy.searchParams.set(k, REDACTED);
  }
  return scrubText(copy.toString());
}

/** 'inputTokens: 1234' 같은 개수 필드는 차단하지 않는다 (AI 사용량 로그 등) */
function isCountKey(key: string): boolean {
  return /(tokens|count)$/.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function shouldRedact(key: string, v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false;
  if (!isSensitiveKey(key)) return false;
  return !(typeof v === 'number' && isCountKey(key));
}

function sanitizeEntries(entries: Array<[string, unknown]>, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of entries) {
    if (n++ >= MAX_KEYS) {
      out['…'] = `${entries.length - MAX_KEYS}개 키 생략`;
      break;
    }
    const key = scrubText(k);
    out[key] = shouldRedact(k, v) ? REDACTED : sanitize(v, seen, depth + 1);
  }
  return out;
}

/** 임의 값을 로그에 써도 안전한 형태로 변환 (키 차단 + 패턴 스크럽, 깊은 객체, 순환 참조 처리) */
export function redact(value: unknown): unknown {
  return sanitize(value, new WeakSet(), 0);
}

// ────────────────────────────── Logger ──────────────────────────────

export type LogContext = Record<string, unknown> | Error | undefined;

export interface Logger {
  readonly area: string;
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /** 고정 필드(requestId 등)를 붙인 하위 로거 */
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** 한 줄(JSON) 출력 함수. 기본: info 이하는 stdout, warn/error 는 stderr */
  sink?: (line: string, level: LogLevel) => void;
  /** 최소 레벨. 기본: LOG_LEVEL 환경변수 또는 'info' */
  level?: LogLevel;
  now?: () => Date;
  bindings?: Record<string, unknown>;
}

const RESERVED = new Set(['ts', 'level', 'area', 'msg']);

function defaultSink(line: string, level: LogLevel): void {
  if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

function envLevel(): LogLevel {
  const v = process.env.LOG_LEVEL?.trim().toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

function toContextObject(ctx: LogContext): Record<string, unknown> {
  if (ctx === undefined || ctx === null) return {};
  if (ctx instanceof Error) return { error: ctx };
  if (typeof ctx !== 'object') return { value: ctx };
  return ctx;
}

export function createLogger(area: string, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const minLevel = LEVEL_ORDER[options.level ?? envLevel()];
  const now = options.now ?? (() => new Date());
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, msg: unknown, ctx: LogContext): void => {
    if (LEVEL_ORDER[level] < minLevel) return;
    try {
      const merged = { ...bindings, ...toContextObject(ctx) };
      const clean = redact(merged) as Record<string, unknown>;
      const record: Record<string, unknown> = {
        ts: now().toISOString(),
        level,
        area: scrubText(String(area)),
        msg: truncate(scrubText(typeof msg === 'string' ? msg : safeString(msg))),
      };
      for (const [k, v] of Object.entries(clean)) {
        record[RESERVED.has(k) ? `ctx_${k}` : k] = v;
      }
      sink(JSON.stringify(record), level);
    } catch (e) {
      // 로거 때문에 업무 처리가 실패하면 안 된다. 최소 정보만 남긴다.
      try {
        sink(
          JSON.stringify({ ts: new Date().toISOString(), level: 'error', area: 'logger', msg: '로그 직렬화 실패', reason: scrubText(safeString(e)) }),
          'error',
        );
      } catch {
        /* 무시 */
      }
    }
  };

  return {
    area,
    debug: (msg, ctx) => write('debug', msg, ctx),
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
    child: (extra) => createLogger(area, { ...options, bindings: { ...bindings, ...extra } }),
  };
}
