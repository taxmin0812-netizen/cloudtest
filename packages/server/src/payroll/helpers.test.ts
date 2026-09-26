import { describe, expect, it } from 'vitest';
import type { PayrollLine } from '@mintax/core';
import { ValidationError } from '@mintax/security';
import {
  containsRawRrn,
  dDayLabel,
  daysBetween,
  describeAmountChange,
  halfEndOf,
  isLocalDate,
  itemsDigest,
  kstToday,
  maskBankAccount,
  nextEmployeeCode,
  normalizeBankAccount,
  normalizeIdNumber,
  recomputeLine,
  sameAmounts,
  amountsOf,
  sumLines,
} from './helpers';

const line = (over: Partial<PayrollLine>): PayrollLine => ({
  employeeId: 'e1',
  name: '홍길동',
  incomeType: 'earned',
  taxablePay: 0,
  nonTaxablePay: 0,
  grossPay: 0,
  allowances: {},
  incomeTax: 0,
  localIncomeTax: 0,
  otherDeductions: 0,
  netPay: 0,
  paymentDate: '2026-09-25',
  ...over,
});

describe('주민번호·계좌 정규화', () => {
  it('13자리만 허용, 마스킹본·원문은 오류 메시지에 넣지 않는다', () => {
    const r = normalizeIdNumber('900101-1234567');
    expect(r).toEqual({ digits: '9001011234567', masked: '900101-1******', isForeigner: false });
    expect(normalizeIdNumber('9001015234567').isForeigner).toBe(true);
    for (const bad of ['900101-1******', '900101-123456', '900101-9234567', 'abc']) {
      try {
        normalizeIdNumber(bad);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect((e as ValidationError).userMessage).not.toContain(bad);
      }
    }
  });
  it('계좌번호는 뒤 4자리만 보인다', () => {
    expect(normalizeBankAccount('110-123-456789')).toEqual({ digits: '110123456789', masked: '********6789' });
    expect(maskBankAccount('1234')).toBe('****');
    expect(() => normalizeBankAccount('12*4567890')).toThrow(ValidationError);
  });
  it('원문 주민번호 탐지', () => {
    expect(containsRawRrn('{"id":"900101-1234567"}')).toBe(true);
    expect(containsRawRrn('9001011234567')).toBe(true);
    expect(containsRawRrn('900101-1******')).toBe(false);
    expect(containsRawRrn('12345678901234')).toBe(false);
  });
});

describe('날짜', () => {
  it('실재 날짜만', () => {
    expect(isLocalDate('2026-02-28')).toBe(true);
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(isLocalDate('2026-2-3')).toBe(false);
  });
  it('KST 오늘·D-day·반기', () => {
    expect(kstToday(new Date('2026-09-25T15:30:00Z'))).toBe('2026-09-26');
    expect(daysBetween('2026-09-26', '2026-10-12')).toBe(16);
    expect(dDayLabel(16)).toBe('D-16');
    expect(dDayLabel(0)).toBe('D-day');
    expect(dDayLabel(-2)).toBe('D+2');
    expect(halfEndOf('2026-03')).toBe('2026-06');
    expect(halfEndOf('2026-09')).toBe('2026-12');
  });
});

describe('급여행 재계산', () => {
  it('사업소득 3% + 지방 0.3%, 차인지급액', () => {
    const { line: l } = recomputeLine(line({ incomeType: 'business', taxablePay: 1_000_000, incomeTax: 999 }));
    expect(l.grossPay).toBe(1_000_000);
    expect(l.incomeTax).toBe(30_000);
    expect(l.localIncomeTax).toBe(3_000);
    expect(l.netPay).toBe(967_000);
  });
  it('일용근로 (일당 − 15만원) × 2.7%, 10원 미만 절사', () => {
    const { line: l } = recomputeLine(line({ incomeType: 'daily', taxablePay: 1_000_000, workDays: 5 }));
    // (200,000 − 150,000) × 6% × 45% = 1,350/일 × 5 = 6,750 → 지방 675 → 670
    expect(l.incomeTax).toBe(6_750);
    expect(l.localIncomeTax).toBe(670);
    expect(l.netPay).toBe(1_000_000 - 6_750 - 670);
  });
  it('근로소득은 소득세 유지 + 지방소득세 10%', () => {
    const { line: l } = recomputeLine(line({ taxablePay: 3_300_000, nonTaxablePay: 200_000, incomeTax: 74_350, otherDeductions: 300_000 }));
    expect(l.grossPay).toBe(3_500_000);
    expect(l.incomeTax).toBe(74_350);
    expect(l.localIncomeTax).toBe(7_430);
    expect(l.netPay).toBe(3_500_000 - 74_350 - 7_430 - 300_000);
  });
  it('합계·동일성·지문', () => {
    const a = recomputeLine(line({ taxablePay: 100 })).line;
    const b = recomputeLine(line({ employeeId: 'e2', incomeType: 'business', taxablePay: 1_000_000 })).line;
    const s = sumLines([a, b]);
    expect(s.headcount).toBe(2);
    expect(s.byIncomeType.business.incomeTax).toBe(30_000);
    expect(sameAmounts(amountsOf(a), amountsOf(a))).toBe(true);
    expect(sameAmounts(amountsOf(a), amountsOf(b))).toBe(false);
    const item = (id: string, gross: number) => ({ id, employeeId: id, incomeType: 'earned' as const, taxablePay: gross, nonTaxablePay: 0, grossPay: gross, allowances: {}, workDays: null, incomeTax: 0, localIncomeTax: 0, otherDeductions: 0, netPay: gross, paymentDate: null });
    expect(itemsDigest([item('a', 1), item('b', 2)])).toBe(itemsDigest([item('b', 2), item('a', 1)]));
    expect(itemsDigest([item('a', 1)])).not.toBe(itemsDigest([item('a', 2)]));
  });
  it('사람이 읽는 변경 요약', () => {
    expect(describeAmountChange('김민수', { taxablePay: 3_300_000, incomeTax: 74_350 }, { taxablePay: 3_630_000, incomeTax: 91_000 })).toBe(
      '김민수 과세급여 3,300,000원 → 3,630,000원, 소득세 74,350원 → 91,000원',
    );
  });
  it('사원코드 자동 부여', () => {
    expect(nextEmployeeCode([])).toBe('1001');
    expect(nextEmployeeCode(['1001', '1007', 'A9'])).toBe('1008');
  });
});
