import { describe, expect, it } from 'vitest';
import {
  AccountLockedError,
  AppError,
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  CryptoError,
  ExternalServiceError,
  ForbiddenError,
  GENERIC_ERROR_MESSAGE,
  InvalidCredentialsError,
  InvalidMfaCodeError,
  IpNotAllowedError,
  MfaRequiredError,
  NotFoundError,
  RateLimitError,
  SessionExpiredError,
  ValidationError,
  generateErrorId,
  isAppError,
  toUserError,
} from './errors';

const HANGUL = /[가-힣]/;

describe('AppError 계층', () => {
  it('기본 속성과 instanceof', () => {
    const cause = new Error('root');
    const e = new AppError({ code: 'X', userMessage: '실패했습니다.', message: 'internal detail', httpStatus: 418, cause, retryable: true });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AppError');
    expect(e.message).toBe('internal detail');
    expect(e.cause).toBe(cause);
    expect(e.httpStatus).toBe(418);
    expect(e.retryable).toBe(true);
    expect(isAppError(e)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(new AppError({ code: 'Y', userMessage: 'u' }).httpStatus).toBe(500);
  });

  it.each([
    [new ValidationError(), 400, 'VALIDATION_FAILED'],
    [new AuthenticationError(), 401, 'UNAUTHENTICATED'],
    [new InvalidCredentialsError(), 401, 'INVALID_CREDENTIALS'],
    [new MfaRequiredError(), 401, 'MFA_REQUIRED'],
    [new InvalidMfaCodeError(), 401, 'MFA_INVALID'],
    [new SessionExpiredError('absolute'), 401, 'SESSION_EXPIRED'],
    [new ForbiddenError('rules.approve', '규칙 승인'), 403, 'FORBIDDEN'],
    [new IpNotAllowedError(), 403, 'IP_NOT_ALLOWED'],
    [new NotFoundError('거래처'), 404, 'NOT_FOUND'],
    [new ConflictError(), 409, 'CONFLICT'],
    [new AccountLockedError(new Date(Date.now() + 60_000)), 423, 'ACCOUNT_LOCKED'],
    [new RateLimitError(30), 429, 'RATE_LIMITED'],
    [new ExternalServiceError('WEHAGO'), 502, 'EXTERNAL_SERVICE'],
    [new ConfigurationError('MINTAX_DATA_KEY 없음'), 500, 'CONFIG_ERROR'],
    [new CryptoError('CRYPTO_AUTH_FAILED', 'tag mismatch'), 500, 'CRYPTO_AUTH_FAILED'],
  ] as const)('%s → %i %s, 한국어 안내', (err, status, code) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(status);
    expect(err.code).toBe(code);
    expect(err.userMessage).toMatch(HANGUL);
    expect(err.name).toBe(err.constructor.name);
  });

  it('로그인·세션 오류는 로그인 이동 action 제공', () => {
    expect(new AuthenticationError().action).toEqual({ label: '로그인', href: '/login' });
    expect(new SessionExpiredError().action?.href).toBe('/login');
    expect(new SessionExpiredError('revoked').userMessage).toContain('로그아웃');
  });

  it('NotFound/Forbidden 메시지 구성', () => {
    expect(new NotFoundError('거래처').userMessage).toContain('거래처을(를) 찾을 수 없습니다');
    expect(new ForbiddenError().userMessage).toContain('권한이 없습니다');
    expect(new ForbiddenError('x', '규칙 승인').userMessage).toContain('(필요 권한: 규칙 승인)');
  });

  it('외부 서비스 오류는 재시도 가능, 내부 사유는 userMessage 에 없음', () => {
    const e = new ExternalServiceError('위멤버스', 'ECONNRESET 10.0.0.5:443');
    expect(e.retryable).toBe(true);
    expect(e.userMessage).not.toContain('ECONNRESET');
    expect(e.message).toContain('ECONNRESET');
  });

  it('RateLimitError 대기 시간 표기', () => {
    expect(new RateLimitError(30).userMessage).toContain('30초');
    expect(new RateLimitError(0.2).retryAfterSeconds).toBe(1);
    expect(new RateLimitError(900).userMessage).toContain('약 15분');
  });
});

describe('toUserError', () => {
  it('알 수 없는 오류는 스택·원문 없이 일반 문구 + 오류코드', () => {
    const e = new Error('duplicate key value violates unique constraint "users_email_uq" at /app/db.ts:12');
    const u = toUserError(e, { errorId: 'EABC123' });
    expect(u).toEqual({
      httpStatus: 500,
      code: 'INTERNAL_ERROR',
      message: `${GENERIC_ERROR_MESSAGE} (오류코드: EABC123)`,
      errorId: 'EABC123',
      retryable: true,
    });
    expect(u.message).toBe('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요. (오류코드: EABC123)');
    expect(JSON.stringify(u)).not.toContain('users_email_uq');
    expect(JSON.stringify(u)).not.toContain('db.ts');
  });

  it('문자열·null·undefined 등 비정상 throw 도 안전', () => {
    for (const v of ['boom', null, undefined, 42, { message: 'secret internals' }]) {
      const u = toUserError(v);
      expect(u.httpStatus).toBe(500);
      expect(u.message.startsWith(GENERIC_ERROR_MESSAGE)).toBe(true);
      expect(JSON.stringify(u)).not.toContain('secret internals');
    }
  });

  it('AppError 4xx 는 userMessage 그대로, 5xx 는 오류코드 부착', () => {
    const f = toUserError(new ForbiddenError('rules.approve', '규칙 승인'));
    expect(f.httpStatus).toBe(403);
    expect(f.message).not.toContain('오류코드');
    const c = toUserError(new ConfigurationError('MINTAX_DATA_KEY 가 없습니다'), { errorId: 'EZZ' });
    expect(c.httpStatus).toBe(500);
    expect(c.message).toContain('(오류코드: EZZ)');
    expect(c.message).not.toContain('MINTAX_DATA_KEY'); // 내부 사유 비노출
  });

  it('action, retryAfterSeconds, fieldErrors 전달', () => {
    expect(toUserError(new AuthenticationError()).action).toEqual({ label: '로그인', href: '/login' });
    expect(toUserError(new RateLimitError(12)).retryAfterSeconds).toBe(12);
    const v = toUserError(new ValidationError('입력값을 확인해 주세요.', [{ field: 'email', message: '이메일 형식이 아닙니다.' }]));
    expect(v.fieldErrors).toEqual([{ field: 'email', message: '이메일 형식이 아닙니다.' }]);
    expect(toUserError(new ValidationError()).fieldErrors).toBeUndefined();
  });

  it('ZodError 형태 (zod import 없이 덕타이핑)', () => {
    const zodLike = Object.assign(new Error('[{"code":"invalid_type"...}]'), {
      name: 'ZodError',
      issues: [
        { path: ['items', 0, 'amount'], message: 'Expected number' },
        { path: ['email'], message: 'Invalid email' },
      ],
    });
    const u = toUserError(zodLike);
    expect(u.httpStatus).toBe(400);
    expect(u.code).toBe('VALIDATION_FAILED');
    expect(u.message).toBe('입력값을 확인해 주세요. (확인 필요 항목: items.0.amount, email)');
    expect(u.fieldErrors?.map((f) => f.field)).toEqual(['items.0.amount', 'email']);
    expect(JSON.stringify(u)).not.toContain('Expected number');
  });

  it('타 패키지의 userMessage 속성 오류는 문구 사용 + 민감정보 스크럽', () => {
    const e = Object.assign(new Error('internal'), { userMessage: '직원 900101-1234567 의 정보가 올바르지 않습니다.', httpStatus: 422, code: 'PAYROLL_INVALID' });
    const u = toUserError(e);
    expect(u.httpStatus).toBe(422);
    expect(u.code).toBe('PAYROLL_INVALID');
    expect(u.message).not.toContain('1234567');
    const noStatus = toUserError(Object.assign(new Error('x'), { userMessage: '작업을 완료하지 못했습니다.', retryable: false }), { errorId: 'E1' });
    expect(noStatus.httpStatus).toBe(500);
    expect(noStatus.message).toBe('작업을 완료하지 못했습니다. (오류코드: E1)');
    expect(noStatus.retryable).toBe(false);
  });

  it('errorId 는 자동 생성되고 매번 다르다', () => {
    const a = generateErrorId();
    expect(a).toMatch(/^E[2-9A-HJ-NP-Z]{9}$/);
    expect(generateErrorId()).not.toBe(a);
    const u = toUserError(new Error('x'));
    expect(u.message).toContain(`(오류코드: ${u.errorId})`);
  });
});

describe('toUserError — AppError 문구에 끼어든 민감정보', () => {
  it('userMessage·fieldErrors 에 주민번호가 들어가도 응답에는 마스킹되어 나간다', () => {
    const e = new NotFoundError('직원 900101-1234567');
    const out = toUserError(e);
    expect(out.message).not.toContain('1234567');
    expect(out.message).toContain('900101-1******');

    const v = new ValidationError('입력값을 확인해 주세요.', [{ field: 'idNumber', message: '9001011234567 은 이미 등록됨' }]);
    const vo = toUserError(v);
    expect(JSON.stringify(vo)).not.toContain('9001011234567');
    expect(vo.fieldErrors?.[0]?.field).toBe('idNumber');
  });
});
