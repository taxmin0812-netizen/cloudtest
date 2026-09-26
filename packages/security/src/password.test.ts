import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  isPasswordHash,
  needsRehash,
  validatePasswordPolicy,
  verifyPassword,
  verifyPasswordDummy,
} from './password';

// 테스트 속도를 위해 일부 케이스는 낮은 N 사용 (형식·검증 로직은 동일)
const FAST = { N: 2 ** 10 };

describe('hashPassword / verifyPassword', () => {
  it('기본 파라미터로 scrypt$N$r$p$salt$hash 형식을 만든다', async () => {
    const h = await hashPassword('Correct-Horse-9');
    const parts = h.split('$');
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(['scrypt', String(2 ** 15), '8', '1']);
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5]!, 'base64')).toHaveLength(DEFAULT_SCRYPT_PARAMS.keyLength);
    expect(h).not.toContain('Correct-Horse-9');
    expect(await verifyPassword('Correct-Horse-9', h)).toBe(true);
    expect(await verifyPassword('correct-horse-9', h)).toBe(false);
  });

  it('같은 비밀번호라도 salt 가 달라 매번 다른 해시', async () => {
    const a = await hashPassword('Same-Password-1', FAST);
    const b = await hashPassword('Same-Password-1', FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword('Same-Password-1', a)).toBe(true);
    expect(await verifyPassword('Same-Password-1', b)).toBe(true);
  });

  it('한글 비밀번호: NFC/NFD 입력 차이를 흡수한다', async () => {
    const nfc = '세무사무소Pass1!'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    const h = await hashPassword(nfc, FAST);
    expect(await verifyPassword(nfd, h)).toBe(true);
  });

  it('형식이 잘못된 해시·평문 저장값은 예외 없이 false', async () => {
    for (const bad of ['', 'plaintext', 'scrypt$1$8$1$AAAA$BBBB', 'bcrypt$2b$10$xxx', 'scrypt$abc$8$1$a$b', 'scrypt$1024$8$1$!!$!!']) {
      expect(await verifyPassword('whatever', bad)).toBe(false);
      expect(isPasswordHash(bad)).toBe(false);
    }
  });

  it('DB 값으로 과도한 메모리를 쓰게 하는 파라미터는 거부', async () => {
    const h = await hashPassword('Abcdefghij1', FAST);
    const evil = h.replace('$1024$', `$${2 ** 24}$`);
    expect(isPasswordHash(evil)).toBe(false);
    expect(await verifyPassword('Abcdefghij1', evil)).toBe(false);
  });

  it('N·r 이 각각 허용 범위여도 합산 메모리(128·N·r)가 256MiB 를 넘으면 거부', async () => {
    const h = await hashPassword('Abcdefghij1', FAST);
    const heavy = h.replace('$1024$8$', `$${2 ** 18}$32$`); // 1GiB
    expect(isPasswordHash(heavy)).toBe(false);
    expect(await verifyPassword('Abcdefghij1', heavy)).toBe(false);
    expect(isPasswordHash(h.replace('$1024$8$', `$${2 ** 18}$8$`))).toBe(true); // 정확히 256MiB 는 허용
  });

  it('해시 변조 시 false', async () => {
    const h = await hashPassword('Abcdefghij1', FAST);
    const parts = h.split('$');
    const hash = Buffer.from(parts[5]!, 'base64');
    hash[0] = hash[0]! ^ 0xff;
    parts[5] = hash.toString('base64');
    expect(await verifyPassword('Abcdefghij1', parts.join('$'))).toBe(false);
  });

  it('빈 비밀번호·너무 긴 비밀번호', async () => {
    await expect(hashPassword('')).rejects.toThrow();
    await expect(hashPassword('a'.repeat(257))).rejects.toThrow();
    const h = await hashPassword('Abcdefghij1', FAST);
    expect(await verifyPassword('', h)).toBe(false);
    expect(await verifyPassword('a'.repeat(257), h)).toBe(false);
  });

  it('verifyPasswordDummy 는 항상 false', async () => {
    expect(await verifyPasswordDummy('anything')).toBe(false);
    expect(await verifyPasswordDummy('')).toBe(false);
  });
});

describe('needsRehash', () => {
  it('기본 파라미터 해시는 false, 약한 파라미터·잘못된 형식은 true', async () => {
    const strong = await hashPassword('Abcdefghij1');
    const weak = await hashPassword('Abcdefghij1', FAST);
    expect(needsRehash(strong)).toBe(false);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
    expect(needsRehash(weak, FAST)).toBe(false);
    expect(needsRehash(strong, { N: 2 ** 16 })).toBe(true);
  });
});

describe('validatePasswordPolicy', () => {
  it('정책을 만족하면 ok', () => {
    expect(validatePasswordPolicy('Tax-Office-2026')).toEqual({ ok: true, errors: [] });
    expect(validatePasswordPolicy('abcdefgh12!')).toEqual({ ok: true, errors: [] }); // 소문자+숫자+특수
    expect(validatePasswordPolicy('세무회계사무소abc12').ok).toBe(true); // 한글은 특수문자 계열
  });

  it('10자 미만', () => {
    const r = validatePasswordPolicy('Ab1!xyz');
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('비밀번호는 10자 이상이어야 합니다.');
  });

  it('문자 종류 3가지 미만', () => {
    const r = validatePasswordPolicy('abcdefghij12');
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('3종류 이상');
    expect(validatePasswordPolicy('ABCDEFGHIJKL').ok).toBe(false);
    expect(validatePasswordPolicy('1234567890').ok).toBe(false);
  });

  it('이메일 아이디 포함 금지 (대소문자 무시, +태그 처리)', () => {
    const r = validatePasswordPolicy('MinJun2026!!', { email: 'minjun@office.co.kr' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('비밀번호에 이메일 아이디를 포함할 수 없습니다.');
    expect(validatePasswordPolicy('xKim!2026yyy', { email: 'kim+tax@office.kr' }).ok).toBe(false);
    expect(validatePasswordPolicy('Tax-Office-2026', { email: 'minjun@office.co.kr' }).ok).toBe(true);
    // 2자 이하 아이디는 검사하지 않음 (오탐 방지)
    expect(validatePasswordPolicy('Tax-Office-2026', { email: 'ta@office.co.kr' }).ok).toBe(true);
  });

  it('전각 문자는 NFKC 정규화한 값으로 판단 (해시와 같은 기준)', () => {
    // 원문 기준이면 전각 'Ｆ' 가 특수문자로 세져 3종류지만, 정규화하면 대문자+숫자 2종류뿐이므로 거부
    expect(validatePasswordPolicy('ABCDEＦ12345').ok).toBe(false);
    // 전각 '！' 는 정규화 후에도 특수문자
    expect(validatePasswordPolicy('Abcdefghi！1').ok).toBe(true);
    // 전각으로 쓴 이메일 아이디도 탐지
    expect(validatePasswordPolicy('ｋｉｍｔａｘ-2026!A', { email: 'kimtax@office.kr' }).errors).toContain(
      '비밀번호에 이메일 아이디를 포함할 수 없습니다.',
    );
  });

  it('여러 위반은 모두 보고', () => {
    const r = validatePasswordPolicy('abc');
    expect(r.errors.length).toBe(2);
  });

  it('비문자열 입력도 안전하게 처리', () => {
    expect(validatePasswordPolicy(undefined as unknown as string).ok).toBe(false);
  });
});
