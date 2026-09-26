/**
 * 애플리케이션 오류 계층.
 *
 * 원칙
 * - message: 내부 로그용 (개발자/운영자). 사용자에게 절대 그대로 노출하지 않는다.
 * - userMessage: 사용자에게 보여줄 한국어 문장. "무엇이 문제인지 + 무엇을 하면 되는지"를 담는다.
 * - 알 수 없는 오류(500)는 스택·원문 없이 오류코드만 보여준다 → 운영자는 errorId 로 로그를 찾는다.
 */
import { randomBytes } from 'node:crypto';
import { scrubSensitive } from '../../core/src/normalize';

export interface UserAction {
  label: string;
  href: string;
}

export interface FieldError {
  /** 'email', 'items.3.amount' 등 */
  field: string;
  message: string;
}

export interface AppErrorOptions {
  code: string;
  /** 사용자에게 보여줄 한국어 메시지 (구체적·행동 가능하게) */
  userMessage: string;
  httpStatus?: number;
  /** 내부 로그용 메시지. 생략하면 userMessage 를 쓴다. */
  message?: string;
  action?: UserAction;
  /** 같은 요청을 다시 시도하면 성공할 가능성이 있는가 (worker 재시도 판단) */
  retryable?: boolean;
  /** 로그·디버깅용 부가정보 (사용자 응답에는 포함하지 않음) */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly userMessage: string;
  readonly action?: UserAction;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(opts: AppErrorOptions) {
    super(opts.message ?? opts.userMessage, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus ?? 500;
    this.userMessage = opts.userMessage;
    this.action = opts.action;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

const LOGIN_ACTION: UserAction = { label: '로그인', href: '/login' };

export class ValidationError extends AppError {
  readonly fieldErrors: FieldError[];
  constructor(userMessage = '입력값을 확인해 주세요.', fieldErrors: FieldError[] = [], message?: string) {
    super({ code: 'VALIDATION_FAILED', httpStatus: 400, userMessage, message });
    this.fieldErrors = fieldErrors;
  }
}

export class AuthenticationError extends AppError {
  constructor(userMessage = '로그인이 필요합니다. 다시 로그인해 주세요.', code = 'UNAUTHENTICATED', message?: string) {
    super({ code, httpStatus: 401, userMessage, message, action: LOGIN_ACTION });
  }
}

/** 이메일/비밀번호 불일치 — 어느 쪽이 틀렸는지 알려주지 않는다 (계정 존재 여부 노출 방지) */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super({
      code: 'INVALID_CREDENTIALS',
      httpStatus: 401,
      userMessage: '이메일 또는 비밀번호가 올바르지 않습니다. 비밀번호를 잊었다면 사무소 관리자에게 재설정을 요청하세요.',
    });
  }
}

export class MfaRequiredError extends AppError {
  constructor() {
    super({
      code: 'MFA_REQUIRED',
      httpStatus: 401,
      userMessage: '추가 인증이 필요합니다. 인증 앱(OTP)에 표시된 6자리 코드를 입력해 주세요.',
    });
  }
}

export class InvalidMfaCodeError extends AppError {
  constructor() {
    super({
      code: 'MFA_INVALID',
      httpStatus: 401,
      userMessage: '인증 코드가 올바르지 않거나 이미 사용되었습니다. 인증 앱의 새 코드를 입력해 주세요.',
    });
  }
}

export class SessionExpiredError extends AppError {
  constructor(reason: 'idle' | 'absolute' | 'revoked' = 'idle') {
    const userMessage =
      reason === 'revoked'
        ? '로그아웃되었습니다. 다시 로그인해 주세요.'
        : reason === 'absolute'
          ? '로그인 유지 시간이 지나 자동 로그아웃되었습니다. 다시 로그인해 주세요.'
          : '오랫동안 사용하지 않아 자동 로그아웃되었습니다. 다시 로그인해 주세요.';
    super({ code: 'SESSION_EXPIRED', httpStatus: 401, userMessage, action: LOGIN_ACTION, details: { reason } });
  }
}

export class ForbiddenError extends AppError {
  readonly permission?: string;
  /**
   * @param permission 필요한 권한 코드 (예: 'rules.approve')
   * @param permissionLabel 권한의 한국어 이름 (예: '규칙 승인')
   */
  constructor(permission?: string, permissionLabel?: string, userMessage?: string) {
    super({
      code: 'FORBIDDEN',
      httpStatus: 403,
      userMessage:
        userMessage ??
        (permissionLabel
          ? `이 작업을 수행할 권한이 없습니다. (필요 권한: ${permissionLabel}) 사무소 관리자에게 권한을 요청하세요.`
          : '이 작업을 수행할 권한이 없습니다. 사무소 관리자에게 권한을 요청하세요.'),
      message: permission ? `권한 부족: ${permission}` : '권한 부족',
      details: permission ? { permission } : undefined,
    });
    this.permission = permission;
  }
}

export class IpNotAllowedError extends AppError {
  constructor() {
    super({
      code: 'IP_NOT_ALLOWED',
      httpStatus: 403,
      userMessage: '허용되지 않은 위치(IP)에서 접속했습니다. 사무실 네트워크에서 접속하거나 관리자에게 허용 IP 등록을 요청하세요.',
    });
  }
}

export class NotFoundError extends AppError {
  constructor(what = '요청한 항목') {
    super({
      code: 'NOT_FOUND',
      httpStatus: 404,
      userMessage: `${what}을(를) 찾을 수 없습니다. 삭제되었거나 주소가 잘못되었을 수 있습니다. 목록을 새로고침해 주세요.`,
    });
  }
}

export class ConflictError extends AppError {
  constructor(userMessage = '다른 사용자가 먼저 변경했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.', message?: string) {
    super({ code: 'CONFLICT', httpStatus: 409, userMessage, message });
  }
}

/** 로그인 연속 실패로 계정 잠김 */
export class AccountLockedError extends AppError {
  readonly lockedUntil: Date;
  constructor(lockedUntil: Date, now: Date = new Date()) {
    const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
    super({
      code: 'ACCOUNT_LOCKED',
      httpStatus: 423,
      userMessage: `로그인에 여러 번 실패하여 계정이 잠겼습니다. 약 ${minutes}분 후 다시 시도하거나 관리자에게 잠금 해제를 요청하세요.`,
      details: { lockedUntil: lockedUntil.toISOString() },
    });
    this.lockedUntil = lockedUntil;
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, userMessage?: string) {
    const secs = Math.max(1, Math.ceil(retryAfterSeconds));
    const wait = secs >= 60 ? `약 ${Math.ceil(secs / 60)}분` : `${secs}초`;
    super({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      userMessage: userMessage ?? `요청이 너무 많습니다. ${wait} 후 다시 시도해 주세요.`,
      retryable: true,
    });
    this.retryAfterSeconds = secs;
  }
}

/** WEHAGO·위멤버스 등 외부 시스템 연결 실패 */
export class ExternalServiceError extends AppError {
  constructor(serviceName: string, message?: string, cause?: unknown) {
    super({
      code: 'EXTERNAL_SERVICE',
      httpStatus: 502,
      userMessage: `${serviceName} 연결에 실패했습니다. 잠시 후 다시 시도해 주세요. 계속 실패하면 연동 설정을 확인해 주세요.`,
      message: message ?? `${serviceName} 연결 실패`,
      retryable: true,
      cause,
    });
  }
}

/** 환경변수·키 설정 오류 (운영자가 고쳐야 함) */
export class ConfigurationError extends AppError {
  constructor(message: string) {
    super({
      code: 'CONFIG_ERROR',
      httpStatus: 500,
      userMessage: '시스템 설정에 문제가 있어 요청을 처리하지 못했습니다. 사무소 관리자에게 문의해 주세요.',
      message,
    });
  }
}

export type CryptoErrorCode = 'CRYPTO_FORMAT' | 'CRYPTO_UNKNOWN_KEY' | 'CRYPTO_AUTH_FAILED' | 'CRYPTO_INVALID_INPUT';

/** 암·복호화 실패. 원문·키는 절대 메시지에 넣지 않는다. */
export class CryptoError extends AppError {
  constructor(code: CryptoErrorCode, message: string) {
    super({
      code,
      httpStatus: 500,
      userMessage: '암호화된 정보를 처리하지 못했습니다. 사무소 관리자에게 문의해 주세요.',
      message,
    });
  }
}

// ────────────────────────────── 사용자 응답 변환 ──────────────────────────────

export interface UserFacingError {
  httpStatus: number;
  code: string;
  /** 화면에 그대로 표시할 한국어 메시지 */
  message: string;
  /** 로그·system_errors 와 대조할 참조 ID */
  errorId: string;
  action?: UserAction;
  retryable: boolean;
  retryAfterSeconds?: number;
  fieldErrors?: FieldError[];
}

export const GENERIC_ERROR_MESSAGE = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';

const ERROR_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 사용자에게 보여줄 오류 참조 ID (예: 'E7K3F9QX2M') */
export function generateErrorId(): string {
  const bytes = randomBytes(9);
  let out = 'E';
  for (const b of bytes) out += ERROR_ID_ALPHABET[b & 31];
  return out;
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

function isValidStatus(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 400 && n <= 599;
}

interface ZodLikeIssue {
  path: Array<string | number>;
  message: string;
}

function asZodLike(e: unknown): ZodLikeIssue[] | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as { name?: unknown; issues?: unknown };
  if (o.name !== 'ZodError' || !Array.isArray(o.issues)) return null;
  return o.issues.filter(
    (i): i is ZodLikeIssue => !!i && typeof i === 'object' && Array.isArray((i as ZodLikeIssue).path),
  );
}

/**
 * 어떤 오류든 사용자에게 안전한 응답으로 변환한다.
 * - AppError: userMessage / httpStatus / action 사용
 * - ZodError: 400 + 필드 목록
 * - userMessage 속성을 가진 타 패키지 오류: 그 문구 사용 (민감정보 스크럽)
 * - 그 외: 500 + 일반 문구 + 오류코드. 스택·원문 메시지는 절대 포함하지 않는다.
 */
export function toUserError(e: unknown, opts: { errorId?: string } = {}): UserFacingError {
  const errorId = opts.errorId ?? generateErrorId();
  const withRef = (msg: string, status: number) => (status >= 500 ? `${msg} (오류코드: ${errorId})` : msg);

  if (e instanceof AppError) {
    const out: UserFacingError = {
      httpStatus: e.httpStatus,
      code: e.code,
      // userMessage 에 입력값이 끼어들 수 있으므로 (예: NotFoundError(원문)) 여기서도 민감정보를 스크럽한다
      message: withRef(scrubSensitive(e.userMessage), e.httpStatus),
      errorId,
      retryable: e.retryable,
    };
    if (e.action) out.action = { ...e.action };
    if (e instanceof RateLimitError) out.retryAfterSeconds = e.retryAfterSeconds;
    if (e instanceof ValidationError && e.fieldErrors.length > 0) {
      out.fieldErrors = e.fieldErrors.map((f) => ({ field: f.field, message: scrubSensitive(f.message) }));
    }
    return out;
  }

  const zodIssues = asZodLike(e);
  if (zodIssues) {
    const fieldErrors = zodIssues.map((i) => ({
      field: i.path.join('.') || '(입력값)',
      message: '형식이 올바르지 않습니다.',
    }));
    const fields = [...new Set(fieldErrors.map((f) => f.field))].slice(0, 5).join(', ');
    return {
      httpStatus: 400,
      code: 'VALIDATION_FAILED',
      message: fields ? `입력값을 확인해 주세요. (확인 필요 항목: ${fields})` : '입력값을 확인해 주세요.',
      errorId,
      retryable: false,
      fieldErrors,
    };
  }

  if (e && typeof e === 'object') {
    const o = e as { userMessage?: unknown; httpStatus?: unknown; status?: unknown; code?: unknown; retryable?: unknown };
    if (typeof o.userMessage === 'string' && o.userMessage.trim() !== '') {
      const status = isValidStatus(o.httpStatus) ? o.httpStatus : isValidStatus(o.status) ? o.status : 500;
      return {
        httpStatus: status,
        code: typeof o.code === 'string' && /^[A-Z0-9_.-]{1,64}$/i.test(o.code) ? o.code : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED',
        message: withRef(scrubSensitive(o.userMessage), status),
        errorId,
        retryable: o.retryable === true,
      };
    }
  }

  return {
    httpStatus: 500,
    code: 'INTERNAL_ERROR',
    message: withRef(GENERIC_ERROR_MESSAGE, 500),
    errorId,
    retryable: true,
  };
}
