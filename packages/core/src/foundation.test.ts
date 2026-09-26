import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './hash';
import { parseWon, splitVatInclusive } from './money';
import { isValidBusinessNumber, maskCardNumber, maskResidentNumber, normalizeDate, normalizeMerchantName, scrubSensitive } from './normalize';
import { evaluateCondition, validateCondition } from './dsl';
import { computeFingerprint } from './fingerprint';

describe('sha256Hex', () => {
  it('matches node crypto for various inputs', () => {
    for (const s of ['', 'abc', '한글 상호 (주)스타벅스', 'x'.repeat(1000), 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('money', () => {
  it('parses Korean amount strings', () => {
    expect(parseWon('1,234')).toBe(1234);
    expect(parseWon('₩12,300원')).toBe(12300);
    expect(parseWon('(1,000)')).toBe(-1000);
    expect(parseWon('-500')).toBe(-500);
    expect(parseWon('100.00')).toBe(100);
    expect(parseWon('100.5')).toBeNull();
    expect(parseWon('abc')).toBeNull();
    expect(parseWon(3300)).toBe(3300);
  });
  it('splits VAT-inclusive totals exactly', () => {
    for (const total of [1100, 11000, 32500, 72300, 1, 99999]) {
      const s = splitVatInclusive(total);
      expect(s.supplyAmount + s.vatAmount).toBe(total);
    }
  });
});

describe('normalize', () => {
  it('normalizes merchant names', () => {
    expect(normalizeMerchantName('(주)스타벅스 코리아')).toBe(normalizeMerchantName('스타벅스코리아 주식회사'));
    expect(normalizeMerchantName('㈜케이티')).toBe('케이티');
  });
  it('validates business numbers', () => {
    expect(isValidBusinessNumber('1208147521')).toBe(true);
    expect(isValidBusinessNumber('1208147522')).toBe(false);
  });
  it('parses dates', () => {
    expect(normalizeDate('2026.09.12')).toBe('2026-09-12');
    expect(normalizeDate('20260912')).toBe('2026-09-12');
    expect(normalizeDate('2026-09-12 13:22:10')).toBe('2026-09-12');
    expect(normalizeDate('2026-02-30')).toBeNull();
    expect(normalizeDate(new Date(Date.UTC(2026, 8, 12)))).toBe('2026-09-12');
    expect(normalizeDate(46277)).toBe('2026-09-12');
  });
  it('masks and scrubs sensitive data', () => {
    expect(maskCardNumber('1234567812345678')).toBe('1234-****-****-5678');
    expect(maskResidentNumber('900101-1234567')).toBe('900101-1******');
    expect(scrubSensitive('주민번호 900101-1234567 카드 1234-5678-1234-5678 password=abc')).toBe(
      '주민번호 900101-1****** 카드 1234-****-****-5678 password=[REDACTED]',
    );
  });
});

describe('dsl', () => {
  const cond = { all: [{ field: 'merchantName', op: 'contains', value: '농협' }, { field: 'description', op: 'contains', value: '축산' }] } as const;
  it('evaluates nested conditions', () => {
    expect(evaluateCondition(cond as never, { merchantName: '농협하나로마트', description: '축산물 매입' })).toBe(true);
    expect(evaluateCondition(cond as never, { merchantName: '농협하나로마트', description: '생활용품' })).toBe(false);
    expect(evaluateCondition({ any: [{ field: 'totalAmount', op: 'gte', value: 1000000 }, { field: 'isForeign', op: 'eq', value: true }] }, { totalAmount: 50000, isForeign: true })).toBe(true);
    expect(evaluateCondition({ field: 'totalAmount', op: 'between', value: [100, 200] }, { totalAmount: 150 })).toBe(true);
  });
  it('validates conditions', () => {
    expect(validateCondition(cond)).toEqual([]);
    expect(validateCondition({ field: 'nope', op: 'eq' }).length).toBeGreaterThan(0);
    expect(validateCondition({ field: 'totalAmount', op: 'in', value: 3 }).length).toBeGreaterThan(0);
  });
});

describe('fingerprint', () => {
  const base = {
    clientId: 'c1', direction: 'purchase' as const, evidenceType: 'card' as const, transactionDate: '2026-09-12',
    merchantBusinessNumber: '1208147521', merchantKey: 'ABC마트', totalAmount: 32500, supplyAmount: 29545, vatAmount: 2955,
    cardNumberMasked: '1234-****-****-5678', approvalNumber: '30012345', originalSourceId: null,
  };
  it('is channel independent and stable', () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }));
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, approvalNumber: '30012346' }));
  });
});
