import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from './errors';
import { REDACTED, createLogger, isSensitiveKey, redact, scrubText, serializeError, type LogLevel } from './logger';

const RRN = '900101-1234567';
const RRN_RAW = '9001011234567';

function capture(level?: LogLevel) {
  const lines: Array<{ line: string; level: LogLevel }> = [];
  const log = createLogger('test', {
    sink: (line, lv) => lines.push({ line, level: lv }),
    now: () => new Date('2026-09-26T01:02:03.000Z'),
    level,
  });
  const parsed = () => lines.map((l) => JSON.parse(l.line) as Record<string, unknown>);
  const all = () => lines.map((l) => l.line).join('\n');
  return { log, lines, parsed, all };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scrubText', () => {
  it('주민번호 (하이픈/무하이픈/공백/밑줄 인접)', () => {
    expect(scrubText(`주민번호 ${RRN}`)).toBe('주민번호 900101-1******');
    expect(scrubText(`rrn:${RRN_RAW}`)).not.toContain(RRN_RAW);
    expect(scrubText(`id_${RRN_RAW}_x`)).toBe('id_900101-1******_x');
    expect(scrubText(`외국인 900101-5234567`)).toBe('외국인 900101-5******');
    expect(scrubText('900101 1234567')).toBe('900101-1******');
  });

  it('카드번호·Bearer·API 키', () => {
    expect(scrubText('card 1234-5678-9012-3456')).toBe('card 1234-****-****-3456');
    expect(scrubText('x1234567890123456y')).not.toContain('567890123');
    expect(scrubText('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(scrubText('url?api_key=sk-12345&x=1')).toBe(`url?api_key=${REDACTED}&x=1`);
    expect(scrubText('password=hunter2')).toBe(`password=${REDACTED}`);
  });

  it('일반 텍스트·금액·사업자번호·날짜는 그대로', () => {
    for (const s of ['거래 1,234,000원', '사업자번호 123-45-67890', '2026-09-26', '전화 010-1234-5678', 'job 42 finished']) {
      expect(scrubText(s)).toBe(s);
    }
  });
});

describe('isSensitiveKey', () => {
  it('차단 대상 키', () => {
    for (const k of [
      'password',
      'newPassword',
      'password_hash',
      'token',
      'sessionToken',
      'tokenHash',
      'secret',
      'mfaSecretEnc',
      'idNumber',
      'id_number_enc',
      'rrn',
      'employeeRrn',
      'residentNumber',
      'bankAccount',
      'bank_account_enc',
      'cardNumber',
      'authorization',
      'Authorization',
      'cookie',
      'set-cookie',
      'apiKey',
      'ANTHROPIC_API_KEY',
      'recoveryCodes',
      'otp',
      '주민등록번호',
      '입금 계좌번호',
      '카드번호',
    ]) {
      expect({ k, s: isSensitiveKey(k) }).toEqual({ k, s: true });
    }
  });

  it('일반 키·마스킹 키는 통과', () => {
    for (const k of ['email', 'jobId', 'merchantKey', 'currency', 'cardNumberMasked', 'idNumberMasked', 'accountCode', 'error', 'key', 'footprint', 'fingerprint', '주민세', '카드번호마스킹', '거래처명']) {
      expect({ k, s: isSensitiveKey(k) }).toEqual({ k, s: false });
    }
  });
});

describe('redact (깊은 객체)', () => {
  it('중첩 객체·배열의 민감 키와 주민번호 패턴을 제거', () => {
    const input = {
      employee: {
        name: '홍길동',
        idNumber: RRN,
        memo: `본인 주민번호 ${RRN_RAW} 확인`,
        bank: { bankAccount: '110-123-456789', bankName: '신한' },
        idNumberMasked: '900101-1******',
      },
      rows: [{ raw: { 주민번호: RRN, 성명: '홍길동', 비고: RRN_RAW } }, { note: `신고 대상 ${RRN}` }],
      headers: { authorization: 'Bearer xyz', cookie: 'mintax_session=abc', 'user-agent': 'Mozilla' },
      login: { password: 'P@ssw0rd!', email: 'kim@office.kr' },
      usage: { inputTokens: 1200, outputTokens: 300 },
    };
    const out = redact(input) as Record<string, any>;
    const s = JSON.stringify(out);
    expect(s).not.toContain(RRN);
    expect(s).not.toContain(RRN_RAW);
    expect(s).not.toContain('110-123-456789');
    expect(s).not.toContain('P@ssw0rd!');
    expect(s).not.toContain('xyz');
    expect(s).not.toContain('mintax_session=abc');
    expect(out.employee.idNumber).toBe(REDACTED);
    expect(out.employee.bank.bankAccount).toBe(REDACTED);
    expect(out.employee.bank.bankName).toBe('신한');
    expect(out.employee.memo).toBe('본인 주민번호 900101-1****** 확인');
    expect(out.employee.idNumberMasked).toBe('900101-1******');
    expect(out.rows[0].raw).toEqual({ 주민번호: REDACTED, 성명: '홍길동', 비고: '900101-1******' });
    expect(out.headers['user-agent']).toBe('Mozilla');
    expect(out.login.email).toBe('kim@office.kr');
    expect(out.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    // 원본은 변경되지 않는다
    expect(input.employee.idNumber).toBe(RRN);
  });

  it('순환 참조·깊이 제한·특수 타입', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    let deep: Record<string, unknown> = { v: RRN };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const shared = { x: 1 };
    const out = redact({
      a,
      deep,
      pair: [shared, shared],
      when: new Date('2026-09-26T00:00:00Z'),
      big: 10n,
      fn: () => 1,
      buf: Buffer.from('secret-bytes'),
      map: new Map([['password', 'pw'], ['ok', RRN]]),
      set: new Set([RRN]),
      nan: Number.NaN,
      url: new URL('https://u:pw@example.com/cb?token=abc&page=2'),
    }) as Record<string, any>;
    expect(out.a.self).toBe('[Circular]');
    expect(JSON.stringify(out.deep)).toContain('[Truncated]');
    expect(out.pair).toEqual([{ x: 1 }, { x: 1 }]);
    expect(out.when).toBe('2026-09-26T00:00:00.000Z');
    expect(out.big).toBe('10');
    expect(out.fn).toBe('[Function]');
    expect(out.buf).toBe('[binary 12 bytes]');
    expect(out.map).toEqual({ password: REDACTED, ok: '900101-1******' });
    expect(out.set).toEqual(['900101-1******']);
    expect(out.nan).toBe('NaN');
    expect(out.url).not.toContain('abc');
    expect(out.url).not.toContain(':pw@');
    expect(out.url).toContain('example.com/cb');
  });

  it('긴 배열·문자열은 잘라낸다', () => {
    const out = redact({ arr: Array.from({ length: 150 }, (_, i) => i), s: 'x'.repeat(9000) }) as Record<string, any>;
    expect(out.arr).toHaveLength(101);
    expect(out.s.length).toBeLessThan(8100);
  });
});

describe('serializeError', () => {
  it('메시지·스택·cause 의 주민번호를 제거', () => {
    const cause = new Error(`DB insert failed for ${RRN_RAW}`);
    const err = new Error(`직원 등록 실패: ${RRN}`, { cause });
    err.stack = `Error: 직원 등록 실패: ${RRN}\n    at register (/app/employees.ts:10:5) ${RRN_RAW}`;
    const s = serializeError(err);
    const json = JSON.stringify(s);
    expect(json).not.toContain(RRN);
    expect(json).not.toContain(RRN_RAW);
    expect(s.message).toBe('직원 등록 실패: 900101-1******');
    expect(s.stack).toContain('at register');
    expect((s.cause as { message: string }).message).toContain('900101-1******');
  });

  it('AppError 의 code/httpStatus/userMessage 포함, 순환 cause 처리', () => {
    const e = new AppError({ code: 'X_FAIL', userMessage: '실패했습니다.', httpStatus: 422, details: { password: 'pw', n: 1 } });
    const s = serializeError(e);
    expect(s).toMatchObject({ name: 'AppError', code: 'X_FAIL', httpStatus: 422, userMessage: '실패했습니다.' });
    expect(s.details).toEqual({ password: REDACTED, n: 1 });
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;
    expect(serializeError(loop).cause).toBe('[Circular]');
    expect(serializeError('plain string')).toEqual({ name: 'NonError', message: 'plain string' });
  });
});

describe('createLogger', () => {
  it('JSON 한 줄, 기본 필드 + 컨텍스트 평탄화', () => {
    const { log, parsed, lines } = capture();
    log.info('job started', { jobId: 'j1', attempt: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).not.toContain('\n');
    expect(parsed()[0]).toEqual({ ts: '2026-09-26T01:02:03.000Z', level: 'info', area: 'test', msg: 'job started', jobId: 'j1', attempt: 2 });
  });

  it('레벨 필터링과 sink 레벨 전달', () => {
    const { log, lines } = capture('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('LOG_LEVEL 환경변수', () => {
    vi.stubEnv('LOG_LEVEL', 'error');
    const lines: string[] = [];
    const log = createLogger('x', { sink: (l) => lines.push(l) });
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(1);
  });

  it('메시지·컨텍스트·중첩 객체·오류 스택에서 주민번호가 절대 출력되지 않는다', () => {
    const { log, all } = capture();
    const err = new Error(`검증 실패 ${RRN_RAW}`);
    log.error(`직원 ${RRN} 처리 실패`, {
      employee: { idNumber: RRN, detail: { note: `번호 ${RRN_RAW}` } },
      error: err,
      rows: [[RRN]],
    });
    log.warn('직접 오류 전달', err);
    const out = all();
    expect(out).not.toContain(RRN);
    expect(out).not.toContain(RRN_RAW);
    expect(out).not.toContain('1234567');
    expect(out).toContain('900101-1******');
    expect(out).toContain('"stack"');
  });

  it('예약 필드 충돌 방지 (ctx_ 접두)', () => {
    const { log, parsed } = capture();
    log.info('m', { level: 'fake', msg: 'x', ts: 1, area: 'y' });
    expect(parsed()[0]).toMatchObject({ level: 'info', msg: 'm', area: 'test', ctx_level: 'fake', ctx_msg: 'x', ctx_ts: 1, ctx_area: 'y' });
  });

  it('child 로거는 바인딩을 유지하며 바인딩도 스크럽', () => {
    const { log, parsed } = capture();
    log.child({ requestId: 'r1', token: 'abc' }).info('hello', { userId: 'u1' });
    expect(parsed()[0]).toMatchObject({ requestId: 'r1', token: REDACTED, userId: 'u1' });
  });

  it('sink 오류·직렬화 오류로 예외가 전파되지 않는다', () => {
    const log = createLogger('x', {
      sink: () => {
        throw new Error('disk full');
      },
    });
    expect(() => log.info('m')).not.toThrow();
    const lines: string[] = [];
    const log2 = createLogger('x', {
      sink: (l) => lines.push(l),
      now: () => {
        throw new Error('clock broken');
      },
    });
    expect(() => log2.info('m')).not.toThrow();
    expect(lines[0]).toContain('로그 직렬화 실패');
  });

  it('기본 sink: warn/error 는 stderr, info 는 stdout', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const log = createLogger('std', { level: 'info' });
      log.info('to-stdout');
      log.error('to-stderr', { password: 'pw' });
      expect(String(out.mock.calls.at(-1)?.[0])).toContain('to-stdout');
      const errLine = String(err.mock.calls.at(-1)?.[0]);
      expect(errLine).toContain('to-stderr');
      expect(errLine).not.toContain('"pw"');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe('검토 보강 — 엑셀 원본 행의 주민번호 누출 경로', () => {
  it('숫자 셀로 들어온 주민번호·카드번호(하이픈 없음)도 출력되지 않는다', () => {
    const out = redact({
      row: { 비고: 9001011234567, 카드: 1234567890123456, 금액: 1_234_000, 큰금액: 1_000_000_000_000, 음수: -9001011234567 },
      big: 9001011234567n,
    }) as Record<string, any>;
    const s = JSON.stringify(out);
    expect(s).not.toContain(RRN_RAW);
    expect(s).not.toContain('1234567890123456');
    expect(out.row.비고).toBe('900101-1******');
    expect(out.big).toBe('900101-1******');
    // 일반 금액은 숫자 타입 그대로 (13자리라도 주민번호 패턴이 아니면 유지)
    expect(out.row.금액).toBe(1_234_000);
    expect(out.row.큰금액).toBe(1_000_000_000_000);
  });

  it('괄호·슬래시가 들어간 한글 헤더도 키로 차단, 주민세·마스킹 헤더는 통과', () => {
    for (const k of ['주민(외국인)등록번호', '주민/사업자번호', '주민 번호', '실명번호', '입금계좌', '출금 계좌', '비밀번호(확인)', '운전면허번호', '외국인번호']) {
      expect({ k, s: isSensitiveKey(k) }).toEqual({ k, s: true });
    }
    for (const k of ['주민세', '지방소득세(주민세)', '주민번호(마스킹)', '계좌명', '은행명', '예금주']) {
      expect({ k, s: isSensitiveKey(k) }).toEqual({ k, s: false });
    }
  });

  it('logger 경유: 숫자형 주민번호 + 변형 헤더가 어떤 필드에도 남지 않는다', () => {
    const { log, all, parsed } = capture();
    log.warn('행 정규화 실패', {
      rowNo: 12,
      rawData: { '주민(외국인)등록번호': 9001011234567, 성명: '홍길동', 주민세: 12_000, 입금계좌: '110-123-456789', 메모: 9001011234567 },
    });
    expect(all()).not.toContain(RRN_RAW);
    expect(all()).not.toContain('110-123-456789');
    const raw = parsed()[0]!.rawData as Record<string, unknown>;
    expect(raw['주민(외국인)등록번호']).toBe(REDACTED);
    expect(raw.주민세).toBe(12_000);
    expect(raw.성명).toBe('홍길동');
  });

  it('전각 숫자·전각/유니코드 하이픈 주민번호도 마스킹', () => {
    expect(scrubText('주민번호 ９００１０１－１２３４５６７')).not.toContain('２３４５６７');
    expect(scrubText('900101–1234567')).toBe('900101-1******');
    expect(scrubText('900101－1234567')).toBe('900101-1******');
  });

  it("'__proto__' 키는 프로토타입을 바꾸지 않고 내용도 스크럽", () => {
    const input = JSON.parse(`{"__proto__": {"password": "x", "note": "${RRN}"}, "a": 1}`) as unknown;
    const out = redact(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    const s = JSON.stringify(out);
    expect(s).toContain('"__proto__"');
    expect(s).not.toContain(RRN);
    expect(s).toContain(REDACTED);
  });
});
