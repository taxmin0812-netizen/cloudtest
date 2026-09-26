import { describe, expect, it } from 'vitest';
import { assertNoPII, containsPII, detectPII, findPII, PIIDetectedError } from './pii';

describe('detectPII', () => {
  it.each([
    ['주민번호 하이픈', '홍길동 900101-1234567 환급', 'resident_number'],
    ['주민번호 붙여씀', '9001011234567', 'resident_number'],
    ['외국인등록번호', '850505-5123456', 'resident_number'],
    ['카드 16자리 하이픈', '결제카드 1234-5678-9012-3456', 'card_number'],
    ['카드 16자리 공백', '1234 5678 9012 3456', 'card_number'],
    ['카드 16자리 붙여씀', '카드1234567890123456', 'card_number'],
    ['AMEX 15자리', '3782-822463-10005', 'card_number'],
    ['계좌 3-6-5', '입금계좌 123-456789-12345', 'account_number'],
    ['계좌 6-2-6', '국민 123456-01-123456', 'account_number'],
    ['계좌 3-3-6', '신한 110-123-456789', 'account_number'],
    ['계좌 붙여씀 12자리', '계좌110123456789 이체', 'account_number'],
    ['휴대전화', '연락처 010-1234-5678', 'mobile_phone'],
    ['휴대전화 붙여씀', '01012345678', 'mobile_phone'],
    ['비밀번호', 'password: hunter2', 'credential'],
  ])('%s → %s', (_label, text, kind) => {
    expect(detectPII(text)).toContain(kind);
  });

  it.each([
    ['사업자번호', '사업자 123-45-67890'],
    ['일반 전화', '매장 02-123-4567 / 031-1234-5678'],
    ['날짜', '2026-09-12 결제'],
    ['마스킹 카드', '1234-****-****-5678'],
    ['세금계산서 승인번호', '20260912-41000012-12345678'],
    ['금액', '1,234,567원'],
    ['승인번호 8자리', '승인 12345678'],
    ['상호', 'SK에너지 강남주유소'],
    ['빈 문자열', ''],
  ])('%s 는 허용', (_label, text) => {
    expect(detectPII(text)).toEqual([]);
  });

  it('승인번호를 지워도 같은 문자열의 실제 카드번호는 잡는다', () => {
    expect(detectPII('승인 20260912-41000012-12345678 / 카드 1234-5678-9012-3456')).toEqual(['card_number']);
  });

  it('카드번호를 계좌번호로 중복 분류하지 않는다', () => {
    expect(detectPII('1234-5678-9012-3456')).toEqual(['card_number']);
  });
});

describe('findPII / assertNoPII', () => {
  const clean = {
    merchantName: 'SK에너지',
    merchantCategory: '주유소',
    description: '주유',
    totalAmount: 1234567890123, // 숫자 필드는 검사하지 않는다
    similarExamples: [{ merchantName: 'GS칼텍스', accountCode: '822', accountName: '차량유지비', count: 3 }],
  };

  it('중첩 객체·배열의 경로를 알려준다 (값은 남기지 않는다)', () => {
    const dirty = {
      ...clean,
      description: '홍길동 900101-1234567',
      similarExamples: [{ merchantName: '카드 1234-5678-9012-3456', accountCode: '822', accountName: 'x', count: 1 }],
    };
    const findings = findPII(dirty);
    expect(findings).toEqual([
      { kind: 'resident_number', path: 'input.description' },
      { kind: 'card_number', path: 'input.similarExamples[0].merchantName' },
    ]);
    expect(containsPII(dirty)).toBe(true);
    try {
      assertNoPII(dirty);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PIIDetectedError);
      const msg = (e as Error).message;
      expect(msg).toContain('input.description(주민(외국인)등록번호)');
      expect(msg).not.toContain('900101');
      expect(msg).not.toContain('1234-5678');
    }
  });

  it('깨끗한 입력은 통과', () => {
    expect(() => assertNoPII(clean)).not.toThrow();
    expect(containsPII(clean)).toBe(false);
  });

  it('객체 키에 든 PII 도 잡고, 오류 경로·메시지에 키 원문을 남기지 않는다', () => {
    const dirty = { ...clean, memo: { '900101-1234567 홍길동': '급여', 정상키: '010-1111-2222' } };
    const findings = findPII(dirty);
    expect(findings).toEqual([
      { kind: 'resident_number', path: 'input.memo[key#0]' },
      { kind: 'mobile_phone', path: 'input.memo.정상키' },
    ]);
    try {
      assertNoPII(dirty);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('900101');
      expect((e as PIIDetectedError).findings.map((f) => f.path).join(',')).not.toContain('900101');
    }
    // PII 키 아래 값에서 발견된 것도 원문 키 대신 자리표시로 표기
    expect(findPII({ '010-3333-4444': { note: '9001011234567' } })).toEqual([
      { kind: 'mobile_phone', path: 'input[key#0]' },
      { kind: 'resident_number', path: 'input[key#0].note' },
    ]);
  });

  it('순환 참조에도 멈추지 않는다', () => {
    const a: Record<string, unknown> = { name: '010-9999-8888' };
    a.self = a;
    expect(findPII(a)).toEqual([{ kind: 'mobile_phone', path: 'input.name' }]);
  });
});
