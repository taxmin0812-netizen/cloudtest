import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './errors';
import {
  TotpReplayGuard,
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotp,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  isTotpReplay,
  normalizeRecoveryCode,
  totpStep,
  totpUri,
  verifyRecoveryCode,
  verifyTotp,
} from './totp';

// RFC 6238 부록 B 의 SHA1 시드: ASCII "12345678901234567890"
const RFC_SECRET_BYTES = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET = base32Encode(RFC_SECRET_BYTES);

describe('base32', () => {
  it('RFC 4648 테스트 벡터', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, enc] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(enc);
      expect(base32Decode(enc).toString()).toBe(plain);
    }
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('소문자·공백·패딩 허용, 잘못된 문자는 오류', () => {
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow(CryptoError);
  });

  it('무작위 왕복', () => {
    for (let i = 0; i < 20; i++) {
      const b = randomBytes(i + 1);
      expect(Buffer.compare(base32Decode(base32Encode(b)), b)).toBe(0);
    }
  });
});

describe('HOTP (RFC 4226 부록 D)', () => {
  it('counter 0~9', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, i) => expect(hotp(RFC_SECRET_BYTES, i)).toBe(code));
  });
});

describe('TOTP (RFC 6238 부록 B, SHA1)', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it('8자리 테스트 벡터', () => {
    for (const [t, code] of vectors) expect(generateTotp(RFC_SECRET, t * 1000, { digits: 8 })).toBe(code);
  });

  it('6자리 = 8자리 값의 끝 6자리 (T=59 → 287082)', () => {
    expect(generateTotp(RFC_SECRET, 59_000)).toBe('287082');
    for (const [t, code] of vectors) expect(generateTotp(RFC_SECRET, new Date(t * 1000))).toBe(code.slice(-6));
  });

  it('verifyTotp: RFC 벡터 검증 + step 반환', () => {
    const r = verifyTotp(RFC_SECRET, '287082', 1, 59_000);
    expect(r).toEqual({ valid: true, step: 1, drift: 0 });
    expect(verifyTotp(RFC_SECRET, '94287082', 0, 59_000, { digits: 8 }).valid).toBe(true);
  });

  it('window=1: 앞뒤 30초 허용, 그 밖은 거부', () => {
    const t = 1111111111 * 1000;
    const step = totpStep(t);
    const prevCode = generateTotp(RFC_SECRET, t - 30_000);
    const nextCode = generateTotp(RFC_SECRET, t + 30_000);
    const farCode = generateTotp(RFC_SECRET, t - 60_000);
    expect(verifyTotp(RFC_SECRET, prevCode, 1, t)).toEqual({ valid: true, step: step - 1, drift: -1 });
    expect(verifyTotp(RFC_SECRET, nextCode, 1, t)).toEqual({ valid: true, step: step + 1, drift: 1 });
    expect(verifyTotp(RFC_SECRET, farCode, 1, t)).toEqual({ valid: false, reason: 'mismatch' });
    expect(verifyTotp(RFC_SECRET, prevCode, 0, t)).toEqual({ valid: false, reason: 'mismatch' });
    expect(verifyTotp(RFC_SECRET, farCode, 2, t).valid).toBe(true);
  });

  it('형식 오류 코드', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5a']) {
      expect(verifyTotp(RFC_SECRET, bad, 1, 59_000)).toEqual({ valid: false, reason: 'malformed' });
    }
    // 공백·하이픈은 허용
    expect(verifyTotp(RFC_SECRET, '287 082', 1, 59_000).valid).toBe(true);
    expect(verifyTotp(RFC_SECRET, '287-082', 1, 59_000).valid).toBe(true);
  });

  it('재사용 방지: lastUsedStep 이하 step 의 코드는 replayed', () => {
    const t = 1234567890 * 1000;
    const code = generateTotp(RFC_SECRET, t);
    const first = verifyTotp(RFC_SECRET, code, 1, t);
    expect(first.valid).toBe(true);
    const step = first.valid ? first.step : -1;
    expect(verifyTotp(RFC_SECRET, code, 1, t + 5_000, { lastUsedStep: step })).toEqual({ valid: false, reason: 'replayed' });
    // 이전 step 의 코드도 거부 (창 안에 있더라도)
    const older = generateTotp(RFC_SECRET, t - 30_000);
    expect(verifyTotp(RFC_SECRET, older, 1, t, { lastUsedStep: step })).toEqual({ valid: false, reason: 'replayed' });
    // 다음 step 코드는 허용
    const next = generateTotp(RFC_SECRET, t + 30_000);
    expect(verifyTotp(RFC_SECRET, next, 1, t + 30_000, { lastUsedStep: step }).valid).toBe(true);
    expect(isTotpReplay(5, null)).toBe(false);
    expect(isTotpReplay(5, 5)).toBe(true);
    expect(isTotpReplay(6, 5)).toBe(false);
  });

  it('너무 짧은 비밀은 거부', () => {
    expect(() => verifyTotp(base32Encode(randomBytes(5)), '123456', 1, 0)).toThrow(CryptoError);
  });

  it('생성한 비밀로 현재 코드 검증', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const now = Date.now();
    expect(verifyTotp(secret, generateTotp(secret, now), 1, now).valid).toBe(true);
    expect(generateTotpSecret()).not.toBe(secret);
    expect(() => generateTotpSecret(8)).toThrow(RangeError);
  });
});

describe('totpUri', () => {
  it('issuer 기본값 MIN TAX OPS, 계정·issuer URL 인코딩', () => {
    const uri = totpUri({ secret: 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq', account: 'kim@office.kr' });
    expect(uri).toBe(
      'otpauth://totp/MIN%20TAX%20OPS:kim%40office.kr?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=MIN%20TAX%20OPS&algorithm=SHA1&digits=6&period=30',
    );
    expect(totpUri({ secret: RFC_SECRET, account: '김세무', issuer: 'A&B' })).toContain('otpauth://totp/A%26B:%EA%B9%80');
  });
});

describe('TotpReplayGuard', () => {
  it('같은 사용자의 같거나 이전 step 거부, TTL 이후 초기화', () => {
    const g = new TotpReplayGuard(10, 60_000);
    expect(g.consume('u1', 100, 0)).toBe(true);
    expect(g.consume('u1', 100, 1_000)).toBe(false);
    expect(g.consume('u1', 99, 1_000)).toBe(false);
    expect(g.consume('u2', 100, 1_000)).toBe(true);
    expect(g.consume('u1', 101, 2_000)).toBe(true);
    expect(g.lastStep('u1')).toBe(101);
    expect(g.consume('u1', 101, 70_000)).toBe(true); // TTL 경과
  });

  it('최대 항목 수 초과 시 오래된 항목 제거', () => {
    const g = new TotpReplayGuard(2);
    g.consume('a', 1, 0);
    g.consume('b', 1, 0);
    g.consume('c', 1, 0);
    expect(g.lastStep('a')).toBeNull();
    expect(g.lastStep('c')).toBe(1);
  });
});

describe('복구 코드', () => {
  const key = randomBytes(32);

  it('10개, XXXXX-XXXXX 형식, 중복 없음, 혼동 문자 제외', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    expect(() => generateRecoveryCodes(0)).toThrow(RangeError);
  });

  it('해시·검증 (소문자·공백 허용, 목록 index 반환)', () => {
    const codes = generateRecoveryCodes(5);
    const hashes = codes.map((c) => hashRecoveryCode(c, key));
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).not.toContain(normalizeRecoveryCode(codes[0]!));
    expect(verifyRecoveryCode(codes[3]!, hashes, key)).toBe(3);
    expect(verifyRecoveryCode(` ${codes[2]!.toLowerCase()} `, hashes, key)).toBe(2);
    expect(verifyRecoveryCode(codes[2]!.replace('-', ''), hashes, key)).toBe(2);
    expect(verifyRecoveryCode('AAAAA-AAAAA', hashes, key)).toBe(-1);
    expect(verifyRecoveryCode('short', hashes, key)).toBe(-1);
    expect(verifyRecoveryCode(codes[0]!, hashes, randomBytes(32))).toBe(-1); // 다른 키
    expect(verifyRecoveryCode(codes[0]!, ['zz', ''], key)).toBe(-1); // 손상된 저장값
  });
});
