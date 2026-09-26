import { isValidBusinessNumber, type IndustryKey } from '@mintax/core';
import { DEFAULT_ACCOUNT_CODES } from '@mintax/core/data/accounts';
import { describe, expect, it } from 'vitest';
import { isSyntheticBusinessNumber } from './ids';
import {
  ACCOUNT_MAPPING_EXAMPLES,
  ASSET_THRESHOLD,
  acquisitionCostOf,
  MERCHANT_SPECS,
  RESERVED_MERCHANT_NAMES,
  SYNTHETIC_USD_KRW,
  VAT_ON_SLIP_SIMPLIFIED_NAMES,
  generateCustomers,
  generateMerchants,
  truthAccountFor,
} from './merchants';
import { ACCOUNT_NAMES } from './truth';
import type { MerchantKind } from './types';

const INDUSTRIES: IndustryKey[] = [
  'restaurant', 'meat_restaurant', 'construction', 'ecommerce', 'interior', 'service', 'academy', 'clinic',
  'wholesale_retail', 'rental', 'manufacturing', 'it_service', 'design', 'cafe', 'other',
];

describe('merchants', () => {
  const used = new Set<string>();
  const merchants = generateMerchants(20260926, used, new Set());

  it('약 150곳 이상, id·이름 고유', () => {
    expect(merchants.length).toBeGreaterThanOrEqual(140);
    expect(new Set(merchants.map((m) => m.id)).size).toBe(merchants.length);
    expect(new Set(merchants.map((m) => m.name)).size).toBe(merchants.length);
  });

  it('국내 가맹점 사업자번호는 유효·합성·고유, 해외는 번호 없음 + USD', () => {
    for (const m of merchants) {
      if (m.foreign) {
        expect(m.businessNumber).toBeNull();
        expect(m.currency).toBe('USD');
        expect(m.representativeName).toBe('');
      } else {
        expect(isValidBusinessNumber(m.businessNumber)).toBe(true);
        expect(isSyntheticBusinessNumber(m.businessNumber)).toBe(true);
        expect(m.currency).toBe('KRW');
      }
    }
    const domestic = merchants.filter((m) => !m.foreign);
    expect(new Set(domestic.map((m) => m.businessNumber)).size).toBe(domestic.length);
    expect(merchants.filter((m) => m.foreign).length).toBeGreaterThanOrEqual(10);
  });

  it('요청된 브랜드류 가맹점이 모두 있다', () => {
    const names = merchants.map((m) => m.name).join('\n');
    for (const kw of ['스타벅스', 'KT', '한국전력', '쿠팡', 'ADOBE', 'GS칼텍스', '카카오T', '이마트', '다이소', '골프', '유흥주점', '단란주점', 'AMAZON WEB SERVICES']) {
      expect(names).toContain(kw);
    }
  });

  it('과세유형(일반/간이/면세)·증빙 유형이 섞여 있다', () => {
    expect(new Set(merchants.map((m) => m.taxType))).toEqual(new Set(['general', 'simplified', 'exempt']));
    expect(new Set(merchants.map((m) => m.evidence))).toEqual(new Set(['card', 'tax_invoice', 'invoice_exempt']));
    for (const m of merchants) {
      if (m.evidence === 'tax_invoice' || m.evidence === 'invoice_exempt') expect(m.items.length).toBeGreaterThan(0);
      if (m.evidence === 'invoice_exempt') expect(m.taxType).toBe('exempt');
      expect(m.amount.min).toBeLessThanOrEqual(m.amount.median);
      expect(m.amount.median).toBeLessThanOrEqual(m.amount.max);
    }
    for (const n of VAT_ON_SLIP_SIMPLIFIED_NAMES) expect(merchants.find((m) => m.name === n)!.taxType).toBe('simplified');
    for (const n of RESERVED_MERCHANT_NAMES) expect(merchants.some((m) => m.name === n)).toBe(true);
  });

  it('해외 금액은 합성 환율 기준', () => {
    const adobe = merchants.find((m) => m.name === 'ADOBE *CREATIVE CLOUD')!;
    expect(adobe.amount.median).toBe(62 * SYNTHETIC_USD_KRW);
  });

  it('같은 가맹점이 업종·금액에 따라 다른 계정 (쿠팡 예시 포함)', () => {
    const kindOf = (name: string): MerchantKind => merchants.find((m) => m.name === name)!.kind;
    for (const ex of ACCOUNT_MAPPING_EXAMPLES) {
      expect(truthAccountFor(kindOf(ex.merchant), ex.industry, ex.amount), `${ex.merchant}/${ex.industry}/${ex.amount}`).toBe(ex.accountCode);
    }
    expect(truthAccountFor('ecommerce_market', 'construction', 50_000)).toBe('830');
    expect(truthAccountFor('ecommerce_market', 'ecommerce', 50_000)).toBe('146');
    expect(truthAccountFor('ecommerce_market', 'design', 999_999)).toBe('830');
    expect(truthAccountFor('ecommerce_market', 'design', -1_450_000)).toBe('212');
  });

  it('즉시상각 경계: 취득가액 100만원 이하는 비용, 초과는 자산 (법인세법 시행령 제31조④)', () => {
    expect(ASSET_THRESHOLD).toBe(1_000_000);
    expect(truthAccountFor('ecommerce_market', 'design', 1_000_000)).toBe('830');
    expect(truthAccountFor('ecommerce_market', 'design', 1_000_001)).toBe('212');
    expect(truthAccountFor('electronics', 'it_service', 1_000_000)).toBe('830');
    expect(truthAccountFor('electronics', 'it_service', 1_000_010)).toBe('212');
    expect(truthAccountFor('hardware_tools', 'construction', 1_000_000)).toBe('830');
    expect(truthAccountFor('hardware_tools', 'construction', 1_200_000)).toBe('210');
    // 합계 1,017,000원(공급가액 924,545원): 일반과세 수임처는 공급가액 기준 → 비용, 면세·간이 수임처는 합계 기준 → 자산
    const t = { supplyAmount: 924_545, totalAmount: 1_017_000 };
    expect(acquisitionCostOf(t, 'general')).toBe(924_545);
    expect(acquisitionCostOf(t, 'mixed')).toBe(924_545);
    expect(acquisitionCostOf(t, 'exempt')).toBe(1_017_000);
    expect(acquisitionCostOf(t, 'simplified')).toBe(1_017_000);
    expect(truthAccountFor('furniture', 'design', t.totalAmount, acquisitionCostOf(t, 'general'))).toBe('830');
    expect(truthAccountFor('furniture', 'clinic', t.totalAmount, acquisitionCostOf(t, 'exempt'))).toBe('212');
  });

  it('모든 종류 × 업종 정답 계정이 계정표에 있다 (core DEFAULT_ACCOUNT_CODES 와 이름 일치)', () => {
    const core = new Map(DEFAULT_ACCOUNT_CODES.map((a) => [a.code, a.name]));
    const kinds = new Set<MerchantKind>([...MERCHANT_SPECS.map((s) => s.kind), 'unknown']);
    for (const k of kinds) {
      for (const ind of INDUSTRIES) {
        for (const amt of [10_000, 999_999, 1_000_000, 5_000_000]) {
          const code = truthAccountFor(k, ind, amt);
          expect(ACCOUNT_NAMES[code], `${k}/${ind}/${code}`).toBeDefined();
        }
      }
    }
    for (const [code, name] of Object.entries(ACCOUNT_NAMES)) expect(core.get(code), code).toBe(name);
  });

  it('매출 상대방(가상 고객)도 유효·합성 번호, 가맹점과 겹치지 않음', () => {
    const customers = generateCustomers(20260926, used, new Set());
    expect(customers.length).toBeGreaterThanOrEqual(20);
    for (const k of customers) expect(isSyntheticBusinessNumber(k.businessNumber)).toBe(true);
    const merchantNos = new Set(merchants.map((m) => m.businessNumber));
    for (const k of customers) expect(merchantNos.has(k.businessNumber)).toBe(false);
  });
});
