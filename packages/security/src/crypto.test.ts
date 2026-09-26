import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_KEY_VERSION,
  assertSecurityConfig,
  blindIndex,
  ciphertextKeyVersion,
  createKeyring,
  decryptField,
  decryptOptional,
  encryptField,
  encryptOptional,
  getIndexKey,
  getKeyring,
  isEncryptedField,
  loadIndexKeyFromEnv,
  loadKeyringFromEnv,
  needsRotation,
  normalizeForBlindIndex,
  parsePreviousKeys,
  resetSecurityKeyCache,
  rotateField,
  timingSafeEqualString,
} from './crypto';
import { ConfigurationError, CryptoError, ValidationError } from './errors';

const k0 = randomBytes(32);
const k1 = randomBytes(32);
const k2 = randomBytes(32);
const b64 = (b: Buffer) => b.toString('base64');

const ringV1 = createKeyring({ version: 'v1', key: k1 });
const RRN = '900101-1234567';

afterEach(() => {
  vi.unstubAllEnvs();
  resetSecurityKeyCache();
});

describe('encryptField / decryptField (AES-256-GCM)', () => {
  it('왕복 암호화, 형식 v1:iv:tag:ct', () => {
    const ct = encryptField(RRN, ringV1);
    expect(ct.startsWith('v1:')).toBe(true);
    const [, iv, tag] = ct.split(':');
    expect(Buffer.from(iv!, 'base64')).toHaveLength(12);
    expect(Buffer.from(tag!, 'base64')).toHaveLength(16);
    expect(ct).not.toContain('900101');
    expect(decryptField(ct, ringV1)).toBe(RRN);
  });

  it('같은 평문도 매번 다른 암호문 (IV 무작위)', () => {
    expect(encryptField(RRN, ringV1)).not.toBe(encryptField(RRN, ringV1));
  });

  it('유니코드·빈 문자열·긴 문자열', () => {
    for (const s of ['', '국민은행 123-456-789012', 'x'.repeat(10_000), '{"a":1}']) {
      expect(decryptField(encryptField(s, ringV1), ringV1)).toBe(s);
    }
  });

  it('변조 탐지: 암호문·태그·IV 한 비트만 바뀌어도 CRYPTO_AUTH_FAILED', () => {
    const ct = encryptField(RRN, ringV1);
    const [v, iv, tag, body] = ct.split(':') as [string, string, string, string];
    const flip = (s: string) => {
      const b = Buffer.from(s, 'base64');
      b[0] = b[0]! ^ 0x01;
      return b.toString('base64');
    };
    for (const tampered of [
      [v, iv, tag, flip(body)].join(':'),
      [v, iv, flip(tag), body].join(':'),
      [v, flip(iv), tag, body].join(':'),
    ]) {
      expect(() => decryptField(tampered, ringV1)).toThrow(CryptoError);
      try {
        decryptField(tampered, ringV1);
      } catch (e) {
        expect((e as CryptoError).code).toBe('CRYPTO_AUTH_FAILED');
        expect((e as CryptoError).message).not.toContain('900101');
      }
    }
  });

  it('버전 접두사를 바꿔치기하면 실패 (AAD 에 버전 포함)', () => {
    const ring = createKeyring({ version: 'v2', key: k1 }, [{ version: 'v1', key: k1 }]);
    const ct = encryptField(RRN, ring); // v2
    const swapped = ct.replace(/^v2:/, 'v1:'); // 같은 키지만 다른 버전으로 위장
    expect(() => decryptField(swapped, ring)).toThrow(/무결성/);
  });

  it('다른 키로는 복호화 불가', () => {
    const other = createKeyring({ version: 'v1', key: k2 });
    expect(() => decryptField(encryptField(RRN, ringV1), other)).toThrow(CryptoError);
  });

  it('context(AAD) 가 다르면 복호화 실패 — 컬럼 간 암호문 바꿔치기 방지', () => {
    const ct = encryptField(RRN, ringV1, { context: 'employees.id_number' });
    expect(decryptField(ct, ringV1, { context: 'employees.id_number' })).toBe(RRN);
    expect(() => decryptField(ct, ringV1, { context: 'employees.bank_account' })).toThrow(CryptoError);
    expect(() => decryptField(ct, ringV1)).toThrow(CryptoError);
  });

  it('형식 오류·알 수 없는 버전', () => {
    for (const bad of ['', 'abc', 'v1:a:b', 'v1:!!:!!:!!', 'v1:AAAA:AAAA:AAAA', 'v 1:a:b:c']) {
      expect(() => decryptField(bad, ringV1)).toThrow(CryptoError);
    }
    const ct = encryptField(RRN, createKeyring({ version: 'v9', key: k2 }));
    try {
      decryptField(ct, ringV1);
      expect.unreachable();
    } catch (e) {
      expect((e as CryptoError).code).toBe('CRYPTO_UNKNOWN_KEY');
      expect((e as CryptoError).message).toContain('MINTAX_DATA_KEYS_PREVIOUS');
    }
  });

  it('isEncryptedField / ciphertextKeyVersion', () => {
    const ct = encryptField('x', ringV1);
    expect(isEncryptedField(ct)).toBe(true);
    expect(isEncryptedField('900101-1234567')).toBe(false);
    expect(isEncryptedField(null)).toBe(false);
    expect(ciphertextKeyVersion(ct)).toBe('v1');
    expect(ciphertextKeyVersion('nope')).toBeNull();
  });

  it('encryptOptional / decryptOptional: null·빈 값은 null', () => {
    expect(encryptOptional(null, ringV1)).toBeNull();
    expect(encryptOptional('', ringV1)).toBeNull();
    expect(decryptOptional(undefined, ringV1)).toBeNull();
    expect(decryptOptional(encryptOptional('abc', ringV1), ringV1)).toBe('abc');
  });
});

describe('키 교체 (rotation)', () => {
  it('이전 키로 암호화된 값은 복호화되고, rotateField 로 현재 키로 옮겨진다', () => {
    const oldRing = createKeyring({ version: 'v0', key: k0 });
    const oldCt = encryptField(RRN, oldRing);

    const newRing = createKeyring({ version: 'v1', key: k1 }, [{ version: 'v0', key: k0 }]);
    expect(decryptField(oldCt, newRing)).toBe(RRN);
    expect(needsRotation(oldCt, newRing)).toBe(true);

    const rotated = rotateField(oldCt, newRing);
    expect(rotated.startsWith('v1:')).toBe(true);
    expect(needsRotation(rotated, newRing)).toBe(false);
    expect(decryptField(rotated, newRing)).toBe(RRN);
    // 이전 키를 제거해도 교체된 값은 읽힌다
    expect(decryptField(rotated, ringV1)).toBe(RRN);
    expect(() => decryptField(oldCt, ringV1)).toThrow(CryptoError);
  });

  it('이미 현재 버전이면 그대로, force 면 새 IV 로 재암호화', () => {
    const ct = encryptField(RRN, ringV1);
    expect(rotateField(ct, ringV1)).toBe(ct);
    const forced = rotateField(ct, ringV1, { force: true });
    expect(forced).not.toBe(ct);
    expect(decryptField(forced, ringV1)).toBe(RRN);
  });

  it('context 를 유지한 채 교체', () => {
    const oldRing = createKeyring({ version: 'v0', key: k0 });
    const newRing = createKeyring({ version: 'v1', key: k1 }, [{ version: 'v0', key: k0 }]);
    const ct = encryptField(RRN, oldRing, { context: 'c' });
    const rotated = rotateField(ct, newRing, { context: 'c' });
    expect(decryptField(rotated, newRing, { context: 'c' })).toBe(RRN);
  });

  it('변조된 이전 암호문은 교체 중에도 실패', () => {
    const newRing = createKeyring({ version: 'v1', key: k1 }, [{ version: 'v0', key: k0 }]);
    const ct = encryptField(RRN, createKeyring({ version: 'v0', key: k0 }));
    const bad = ct.slice(0, -4) + (ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => rotateField(bad, newRing)).toThrow(CryptoError);
  });
});

describe('키링 구성 (환경변수)', () => {
  it('parsePreviousKeys', () => {
    expect(parsePreviousKeys('')).toEqual([]);
    expect(parsePreviousKeys(undefined)).toEqual([]);
    const parsed = parsePreviousKeys(` v0:${b64(k0)} , v1:${b64(k1)} `);
    expect(parsed.map((p) => p.version)).toEqual(['v0', 'v1']);
    expect(() => parsePreviousKeys('nocolon')).toThrow(ConfigurationError);
  });

  it('MINTAX_DATA_KEY + VERSION + PREVIOUS', () => {
    const ring = loadKeyringFromEnv({
      NODE_ENV: 'production',
      MINTAX_DATA_KEY: b64(k2),
      MINTAX_DATA_KEY_VERSION: 'v2',
      MINTAX_DATA_KEYS_PREVIOUS: `v0:${b64(k0)},v1:${b64(k1)}`,
    });
    expect(ring.currentVersion).toBe('v2');
    expect([...ring.keys.keys()].sort()).toEqual(['v0', 'v1', 'v2']);
    expect(ring.insecureDevKey).toBe(false);
  });

  it('버전 기본값 v1', () => {
    expect(loadKeyringFromEnv({ MINTAX_DATA_KEY: b64(k1) }).currentVersion).toBe('v1');
  });

  it('잘못된 키 길이·base64·중복 버전은 ConfigurationError (키 값은 메시지에 없음)', () => {
    const short = b64(randomBytes(16));
    try {
      loadKeyringFromEnv({ MINTAX_DATA_KEY: short });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      expect((e as Error).message).toContain('32바이트');
      expect((e as Error).message).not.toContain(short);
    }
    expect(() => loadKeyringFromEnv({ MINTAX_DATA_KEY: 'not base64!!' })).toThrow(ConfigurationError);
    expect(() =>
      loadKeyringFromEnv({ MINTAX_DATA_KEY: b64(k1), MINTAX_DATA_KEYS_PREVIOUS: `v1:${b64(k0)}` }),
    ).toThrow(/중복/);
    expect(() => loadKeyringFromEnv({ MINTAX_DATA_KEY: b64(k1), MINTAX_DATA_KEY_VERSION: 'v:1' })).toThrow(ConfigurationError);
  });

  it('운영: 키가 없으면 즉시 실패 (한국어 오류)', () => {
    expect(() => loadKeyringFromEnv({ NODE_ENV: 'production' })).toThrow(/MINTAX_DATA_KEY 환경변수가 설정되지 않았습니다/);
    expect(() => loadIndexKeyFromEnv({ NODE_ENV: 'production' })).toThrow(/MINTAX_INDEX_KEY 환경변수가 설정되지 않았습니다/);
    expect(() => assertSecurityConfig({ NODE_ENV: 'production', MINTAX_DATA_KEY: b64(k1) })).toThrow(ConfigurationError);
  });

  it('개발: 결정적 개발용 키 + 경고 1회', () => {
    const warn = vi.fn();
    const a = loadKeyringFromEnv({ NODE_ENV: 'development' }, { warn });
    const b = loadKeyringFromEnv({}, { warn });
    expect(a.insecureDevKey).toBe(true);
    expect(a.currentVersion).toBe(DEV_KEY_VERSION);
    expect(Buffer.compare(a.keys.get(DEV_KEY_VERSION)!, b.keys.get(DEV_KEY_VERSION)!)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('개발용 고정 키');
    // 개발용 키로 만든 암호문은 운영 키링에서 알 수 없는 버전으로 명확히 실패
    const devCt = encryptField('x', a);
    expect(() => decryptField(devCt, ringV1)).toThrow(/키 버전 'dev'/);
  });

  it('운영: 개발용 공개 키를 그대로 쓰면 거부', () => {
    const dev = loadKeyringFromEnv({}, { warn: () => undefined });
    const devKeyB64 = b64(dev.keys.get(DEV_KEY_VERSION)!);
    expect(() => loadKeyringFromEnv({ NODE_ENV: 'production', MINTAX_DATA_KEY: devKeyB64 })).toThrow(/개발용 공개 키/);
    expect(loadKeyringFromEnv({ NODE_ENV: 'development', MINTAX_DATA_KEY: devKeyB64 }).currentVersion).toBe('v1');
  });

  it('운영: INDEX_KEY 와 DATA_KEY 가 같으면 거부', () => {
    expect(() => loadIndexKeyFromEnv({ NODE_ENV: 'production', MINTAX_INDEX_KEY: b64(k1), MINTAX_DATA_KEY: b64(k1) })).toThrow(
      /서로 다른 값/,
    );
    expect(() => loadIndexKeyFromEnv({ MINTAX_INDEX_KEY: b64(randomBytes(16)) })).toThrow(/32바이트 이상/);
  });

  it('assertSecurityConfig: 정상 운영 설정은 경고 없음, 개발 미설정은 경고', () => {
    expect(
      assertSecurityConfig({ NODE_ENV: 'production', MINTAX_DATA_KEY: b64(k1), MINTAX_INDEX_KEY: b64(k2) }).warnings,
    ).toEqual([]);
    expect(assertSecurityConfig({}, { warn: () => undefined }).warnings.length).toBe(2);
  });

  it('getKeyring / getIndexKey 는 환경변수 변경을 반영한다', () => {
    vi.stubEnv('MINTAX_DATA_KEY', b64(k1));
    vi.stubEnv('MINTAX_DATA_KEY_VERSION', 'v7');
    vi.stubEnv('MINTAX_INDEX_KEY', b64(k2));
    expect(getKeyring().currentVersion).toBe('v7');
    const ct = encryptField('기본 키링');
    expect(ct.startsWith('v7:')).toBe(true);
    expect(decryptField(ct)).toBe('기본 키링');
    expect(Buffer.compare(getIndexKey(), k2)).toBe(0);

    vi.stubEnv('MINTAX_DATA_KEY_VERSION', 'v8');
    expect(getKeyring().currentVersion).toBe('v8');
  });
});

describe('blindIndex', () => {
  const key = randomBytes(32);

  it('주민번호는 숫자만 정규화 → 표기 차이와 무관하게 동일', () => {
    const a = blindIndex('900101-1234567', 'rrn', key);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(blindIndex('9001011234567', 'rrn', key)).toBe(a);
    expect(blindIndex(' 900101 1234567 ', 'rrn', key)).toBe(a);
    expect(blindIndex('９００１０１-１２３４５６７', 'rrn', key)).toBe(a); // 전각 숫자
    expect(blindIndex('900101-1234568', 'rrn', key)).not.toBe(a);
  });

  it('용도가 다르면 다른 값, 키가 다르면 다른 값', () => {
    const v = '1234567890123';
    expect(blindIndex(v, 'rrn', key)).not.toBe(blindIndex(v, 'bank_account', key));
    expect(blindIndex(v, 'rrn', key)).not.toBe(blindIndex(v, 'rrn', randomBytes(32)));
  });

  it('원문이 해시에 드러나지 않는다', () => {
    expect(blindIndex('9001011234567', 'rrn', key)).not.toContain('9001011234567');
  });

  it('이메일은 소문자·공백 정규화', () => {
    expect(blindIndex(' Kim@Office.KR ', 'email', key)).toBe(blindIndex('kim@office.kr', 'email', key));
    expect(normalizeForBlindIndex('Ab-12 3', 'bank_account')).toBe('123');
  });

  it('빈 값·잘못된 용도는 오류', () => {
    expect(() => blindIndex('---', 'rrn', key)).toThrow(ValidationError);
    expect(() => blindIndex('x', 'Bad Purpose', key)).toThrow(CryptoError);
  });

  it('기본 키는 MINTAX_INDEX_KEY', () => {
    vi.stubEnv('MINTAX_INDEX_KEY', b64(key));
    expect(blindIndex('900101-1234567', 'rrn')).toBe(blindIndex('900101-1234567', 'rrn', key));
  });
});

describe('timingSafeEqualString', () => {
  it('동일/상이/길이 차이', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
  });
});
