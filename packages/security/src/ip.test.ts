import { describe, expect, it } from 'vitest';
import { isIpAllowed, isIpInCidr, parseCidr, parseIp, validateCidrList } from './ip';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('parseIp', () => {
  it('IPv4', () => {
    expect(parseIp('203.0.113.10')).toEqual({ version: 4, bytes: new Uint8Array([203, 0, 113, 10]) });
    expect(parseIp(' 10.0.0.1 ')?.version).toBe(4);
    for (const bad of ['256.0.0.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.-4', 'a.b.c.d', '', '1.2.3.4/24']) {
      expect(parseIp(bad)).toBeNull();
    }
    expect(parseIp(null)).toBeNull();
    expect(parseIp(undefined)).toBeNull();
  });

  it('IPv6 (압축, 전체, zone, 대괄호, 끝 IPv4)', () => {
    expect(hex(parseIp('2001:db8::1')!.bytes)).toBe('20010db8000000000000000000000001');
    expect(hex(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001')!.bytes)).toBe('20010db8000000000000000000000001');
    expect(hex(parseIp('::1')!.bytes)).toBe('00000000000000000000000000000001');
    expect(hex(parseIp('::')!.bytes)).toBe('0'.repeat(32));
    expect(hex(parseIp('fe80::1%eth0')!.bytes)).toBe('fe800000000000000000000000000001');
    expect(hex(parseIp('[2001:db8::1]')!.bytes)).toBe('20010db8000000000000000000000001');
    expect(hex(parseIp('64:ff9b::192.0.2.33')!.bytes)).toBe('0064ff9b0000000000000000c0000221');
    expect(parseIp('2001:db8::1')!.version).toBe(6);
    for (const bad of ['2001:db8:::1', '1::2::3', '12345::', 'g::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', ':::', '::1.2.3', '::ffff:1.2.3.256']) {
      expect(parseIp(bad)).toBeNull();
    }
  });

  it("IPv4-mapped '::ffff:' 는 IPv4 로 변환", () => {
    expect(parseIp('::ffff:192.168.0.10')).toEqual({ version: 4, bytes: new Uint8Array([192, 168, 0, 10]) });
    expect(parseIp('::FFFF:c0a8:000a')).toEqual({ version: 4, bytes: new Uint8Array([192, 168, 0, 10]) });
    expect(parseIp('0:0:0:0:0:ffff:10.0.0.1')?.version).toBe(4);
  });
});

describe('parseCidr', () => {
  it('prefix 범위와 기본 prefix', () => {
    expect(parseCidr('10.0.0.0/8')?.prefix).toBe(8);
    expect(parseCidr('1.2.3.4')?.prefix).toBe(32);
    expect(parseCidr('2001:db8::/32')?.prefix).toBe(32);
    expect(parseCidr('2001:db8::1')?.prefix).toBe(128);
    for (const bad of ['10.0.0.0/33', '10.0.0.0/', '10.0.0.0/-1', '2001:db8::/129', 'abc/8', '10.0.0.0/8/8', '10.0.0.0/ 8']) {
      expect(parseCidr(bad)).toBeNull();
    }
  });
});

describe('isIpInCidr / isIpAllowed', () => {
  it('IPv4 대역 경계', () => {
    expect(isIpInCidr('192.168.1.0', '192.168.1.0/24')).toBe(true);
    expect(isIpInCidr('192.168.1.255', '192.168.1.0/24')).toBe(true);
    expect(isIpInCidr('192.168.2.0', '192.168.1.0/24')).toBe(false);
    expect(isIpInCidr('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr('11.0.0.0', '10.0.0.0/8')).toBe(false);
    expect(isIpInCidr('172.31.0.1', '172.16.0.0/12')).toBe(true);
    expect(isIpInCidr('172.32.0.1', '172.16.0.0/12')).toBe(false);
    expect(isIpInCidr('203.0.113.10', '203.0.113.10')).toBe(true);
    expect(isIpInCidr('203.0.113.11', '203.0.113.10/32')).toBe(false);
    expect(isIpInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    // 호스트 비트가 있는 CIDR 도 마스크 적용
    expect(isIpInCidr('10.1.2.3', '10.9.9.9/8')).toBe(true);
    // 비정렬 prefix (/27)
    expect(isIpInCidr('198.51.100.31', '198.51.100.0/27')).toBe(true);
    expect(isIpInCidr('198.51.100.32', '198.51.100.0/27')).toBe(false);
  });

  it('IPv6 대역', () => {
    expect(isIpInCidr('2001:db8:abcd::1', '2001:db8::/32')).toBe(true);
    expect(isIpInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(isIpInCidr('2001:db8::1', '2001:db8::/127')).toBe(true);
    expect(isIpInCidr('2001:db8::2', '2001:db8::/127')).toBe(false);
    expect(isIpInCidr('::1', '::1/128')).toBe(true);
  });

  it('IPv4-mapped 주소는 IPv4 대역과 매칭', () => {
    expect(isIpInCidr('::ffff:192.168.1.50', '192.168.1.0/24')).toBe(true);
    expect(isIpInCidr('::ffff:192.168.2.50', '192.168.1.0/24')).toBe(false);
    // IPv6 표기 mapped 대역에 IPv4 클라이언트
    expect(isIpInCidr('10.1.2.3', '::ffff:10.0.0.0/104')).toBe(true);
    expect(isIpInCidr('11.1.2.3', '::ffff:10.0.0.0/104')).toBe(false);
    // 진짜 IPv6 주소는 IPv4 대역과 불일치
    expect(isIpInCidr('2001:db8::1', '0.0.0.0/0')).toBe(false);
  });

  it('허용 목록이 비어 있으면 제한 없음', () => {
    expect(isIpAllowed('8.8.8.8', [])).toBe(true);
    expect(isIpAllowed(null, [])).toBe(true);
    expect(isIpAllowed('8.8.8.8', null)).toBe(true);
  });

  it('목록 중 하나라도 일치하면 허용, IP 없음·형식 오류는 거부 (fail closed)', () => {
    const office = ['203.0.113.0/24', '2001:db8:1::/48', 'garbage'];
    expect(isIpAllowed('203.0.113.77', office)).toBe(true);
    expect(isIpAllowed('::ffff:203.0.113.77', office)).toBe(true);
    expect(isIpAllowed('2001:db8:1:2::5', office)).toBe(true);
    expect(isIpAllowed('198.51.100.1', office)).toBe(false);
    expect(isIpAllowed(undefined, office)).toBe(false);
    expect(isIpAllowed('unknown', office)).toBe(false);
    expect(isIpAllowed('1.2.3.4', ['garbage'])).toBe(false);
  });
});

describe('validateCidrList', () => {
  it('유효/무효 분리, 빈 줄 무시, 한국어 사유', () => {
    const r = validateCidrList(['203.0.113.0/24', '', ' 10.0.0.1 ', '10.0.0.0/40', 'office']);
    expect(r.valid).toEqual(['203.0.113.0/24', '10.0.0.1']);
    expect(r.errors.map((e) => e.value)).toEqual(['10.0.0.0/40', 'office']);
    expect(r.errors[0]!.message).toContain('올바른 IP 또는 대역(CIDR) 형식이 아닙니다');
  });
});

describe('isIpAllowed — DB 값 이상', () => {
  it('jsonb 에 배열이 아닌 값이 들어 있으면 예외 없이 거부 (fail closed)', () => {
    expect(isIpAllowed('203.0.113.5', '203.0.113.0/24' as unknown as string[])).toBe(false);
    expect(isIpAllowed('203.0.113.5', {} as unknown as string[])).toBe(false);
    expect(isIpAllowed('203.0.113.5', null)).toBe(true);
    expect(isIpAllowed('203.0.113.5', undefined)).toBe(true);
  });

  it('잘못된 항목만 있으면 모두 거부, 유효 항목과 섞이면 유효 항목으로 판단', () => {
    expect(isIpAllowed('203.0.113.5', ['not-an-ip'])).toBe(false);
    expect(isIpAllowed('203.0.113.5', ['not-an-ip', '203.0.113.0/24'])).toBe(true);
  });
});
