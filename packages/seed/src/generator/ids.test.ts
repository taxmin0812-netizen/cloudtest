import { isValidBusinessNumber, maskCardNumber, maskResidentNumber } from '@mintax/core';
import { describe, expect, it } from 'vitest';
import {
  businessNumberCheckDigit,
  isSyntheticBusinessNumber,
  isSyntheticResidentNumber,
  makeBusinessNumber,
  makeCardApproval,
  makeCashReceiptApproval,
  makeFakeResidentNumber,
  makeInvoiceApproval,
  makeMaskedCard,
  makePersonName,
  makePlate,
  residentNumberCheckDigit,
} from './ids';
import { Rng } from './prng';

describe('사업자등록번호 (합성)', () => {
  it('체크섬이 core isValidBusinessNumber 와 일치', () => {
    const r = new Rng(1);
    for (let i = 0; i < 500; i++) {
      const prefix = String(r.int(100_000_000, 999_999_999));
      expect(isValidBusinessNumber(`${prefix}${businessNumberCheckDigit(prefix)}`)).toBe(true);
    }
    expect(() => businessNumberCheckDigit('12345')).toThrow();
  });

  it('유효·합성(0xx)·고유, 종류별 가운데 자리', () => {
    const r = new Rng(2);
    const used = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const corp = makeBusinessNumber(r, 'corporation', used);
      const ind = makeBusinessNumber(r, 'individual', used);
      const ex = makeBusinessNumber(r, 'individual_exempt', used);
      for (const bn of [corp, ind, ex]) {
        expect(bn).toMatch(/^0\d{9}$/);
        expect(isValidBusinessNumber(bn)).toBe(true);
        expect(isSyntheticBusinessNumber(bn)).toBe(true);
      }
      expect(['81', '86', '87']).toContain(corp.slice(3, 5));
      expect(Number(ind.slice(3, 5))).toBeLessThanOrEqual(79);
      expect(Number(ex.slice(3, 5))).toBeGreaterThanOrEqual(90);
    }
    expect(used.size).toBe(900);
    expect(isSyntheticBusinessNumber('1234567890')).toBe(false);
    expect(isSyntheticBusinessNumber(null)).toBe(false);
  });
});

describe('주민등록번호 (가짜)', () => {
  it('형식은 맞지만 검증번호가 틀리고 99 표식이 있다', () => {
    const r = new Rng(3);
    const used = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const year = r.int(1960, 2005);
      const rrn = makeFakeResidentNumber(r, year, i % 2 ? 'M' : 'F', used);
      expect(rrn).toMatch(/^\d{6}-[1-4]99\d{4}$/);
      const digits = rrn.replace('-', '');
      expect(residentNumberCheckDigit(digits.slice(0, 12))).not.toBe(Number(digits[12]));
      expect(isSyntheticResidentNumber(rrn)).toBe(true);
      const g = Number(rrn[7]);
      expect(year >= 2000 ? [3, 4] : [1, 2]).toContain(g);
      const mm = Number(rrn.slice(2, 4));
      const dd = Number(rrn.slice(4, 6));
      expect(mm).toBeGreaterThanOrEqual(1);
      expect(mm).toBeLessThanOrEqual(12);
      expect(dd).toBeGreaterThanOrEqual(1);
      expect(dd).toBeLessThanOrEqual(31);
      expect(maskResidentNumber(rrn)).toBe(`${rrn.slice(0, 6)}-${rrn[7]}******`);
    }
    expect(used.size).toBe(300);
  });

  it('검증번호가 맞는 번호는 합성으로 보지 않는다', () => {
    const front = '900101';
    const back6 = '199123';
    const valid = residentNumberCheckDigit(`${front}${back6}`);
    expect(isSyntheticResidentNumber(`${front}-${back6}${valid}`)).toBe(false);
    expect(isSyntheticResidentNumber('900101-1234567')).toBe(false);
    expect(isSyntheticResidentNumber(null)).toBe(false);
  });
});

describe('카드·승인번호·기타', () => {
  it('마스킹 카드는 core maskCardNumber 결과와 같은 모양', () => {
    const r = new Rng(4);
    const used = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const m = makeMaskedCard(r, used);
      expect(m).toMatch(/^\d{4}-\*{4}-\*{4}-\d{4}$/);
      expect(maskCardNumber(m)).toBe(m);
    }
  });

  it('승인번호 형식·고유성', () => {
    const r = new Rng(5);
    const used = new Set<string>();
    for (let i = 0; i < 200; i++) {
      expect(makeCardApproval(r, used)).toMatch(/^\d{8}$/);
      expect(makeCashReceiptApproval(r, used)).toMatch(/^\d{9}$/);
      expect(makeInvoiceApproval(r, '2026-09-15', used)).toMatch(/^20260915-4100\d{4}-\d{8}$/);
    }
    expect(used.size).toBe(600);
  });

  it('이름·차량번호', () => {
    const r = new Rng(6);
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) expect(makePersonName(r, names)).toMatch(/^[가-힣]{3}$/);
    expect(names.size).toBe(200);
    const plates = new Set<string>();
    for (let i = 0; i < 50; i++) expect(makePlate(r, plates)).toMatch(/^\d{2,3}[가-힣]\d{4}$/);
  });
});
