import { isValidBusinessNumber, type IndustryKey } from '@mintax/core';
import { describe, expect, it } from 'vitest';
import { CLIENT_SPECS, SCENARIO_A_CODE, SCENARIO_PAYROLL_CODE, clientSpecOf, generateClients } from './clients';
import { isSyntheticBusinessNumber } from './ids';

const ALL_INDUSTRIES: IndustryKey[] = [
  'restaurant', 'meat_restaurant', 'construction', 'ecommerce', 'interior', 'service', 'academy', 'clinic',
  'wholesale_retail', 'rental', 'manufacturing', 'it_service', 'design', 'cafe', 'other',
];

describe('clients', () => {
  const used = new Set<string>();
  const clients = generateClients(20260926, used, new Set());

  it('20곳 이상, 코드 C001… 연속·고유', () => {
    expect(clients.length).toBeGreaterThanOrEqual(22);
    clients.forEach((c, i) => expect(c.code).toBe(`C${String(i + 1).padStart(3, '0')}`));
    expect(new Set(clients.map((c) => c.name)).size).toBe(clients.length);
  });

  it('모든 업종 포함, 법인/개인·과세유형 혼합', () => {
    const industries = new Set(clients.map((c) => c.industry));
    for (const k of ALL_INDUSTRIES) expect(industries.has(k)).toBe(true);
    expect(new Set(clients.map((c) => c.businessType))).toEqual(new Set(['corporation', 'individual']));
    expect(new Set(clients.map((c) => c.vatType))).toEqual(new Set(['general', 'simplified', 'exempt', 'mixed']));
    // 학원·병원 면세 거래처
    expect(clients.some((c) => c.industry === 'academy' && c.vatType === 'exempt')).toBe(true);
    expect(clients.some((c) => c.industry === 'clinic' && c.vatType === 'exempt')).toBe(true);
  });

  it('사업자번호: 유효 체크섬·합성 표식·고유, 법인은 81/86/87', () => {
    for (const c of clients) {
      expect(isValidBusinessNumber(c.businessNumber)).toBe(true);
      expect(isSyntheticBusinessNumber(c.businessNumber)).toBe(true);
      if (c.businessType === 'corporation') expect(['81', '86', '87']).toContain(c.businessNumber.slice(3, 5));
      if (c.businessType === 'individual' && c.vatType === 'exempt') expect(Number(c.businessNumber.slice(3, 5))).toBeGreaterThanOrEqual(90);
    }
    expect(new Set(clients.map((c) => c.businessNumber)).size).toBe(clients.length);
    expect(used.size).toBe(clients.length);
  });

  it('차량·카드', () => {
    for (const c of clients) {
      expect(c.nonDeductibleVehicles).toEqual(c.vehicles.filter((v) => v.nonDeductible).map((v) => v.plate));
      for (const v of c.vehicles) if (v.kind !== 'passenger') expect(v.nonDeductible).toBe(false);
      expect(c.cards.length).toBeGreaterThanOrEqual(1);
      for (const card of c.cards) expect(card.masked).toMatch(/^\d{4}-\*{4}-\*{4}-\d{4}$/);
      if (c.businessType === 'individual') expect(c.cards.every((k) => k.holderType === 'owner')).toBe(true);
      expect(c.email).toMatch(/@example\.com$/);
      expect(c.address.startsWith('가상시')).toBe(true);
      expect(c.industryCode).toBeNull();
    }
    expect(clients.filter((c) => c.vehicles.length > 0).length).toBeGreaterThanOrEqual(8);
    expect(clients.filter((c) => c.nonDeductibleVehicles.length > 0).length).toBeGreaterThanOrEqual(5);
    // 경차는 불공제 대상 아님
    const rental = clients.find((c) => c.code === 'C010')!;
    expect(rental.vehicles[0]!.nonDeductible).toBe(false);
  });

  it('시나리오 거래처', () => {
    const a = clients.find((c) => c.code === SCENARIO_A_CODE)!;
    expect(a.name).toBe('(주)에이플러스디자인');
    expect(a.industry).toBe('design');
    expect(a.tags).toContain('scenario_a');
    const s = clients.find((c) => c.code === SCENARIO_PAYROLL_CODE)!;
    expect(s.name).toBe('시나리오상사');
    expect(s.businessType).toBe('individual');
    expect(s.withholdingSemiannual).toBe(false);
  });

  it('간이과세자는 의제매입 대상이 아니다', () => {
    for (const c of clients) if (c.vatType === 'simplified') expect(c.deemedInputTaxEligible).toBe(false);
    expect(clients.filter((c) => c.deemedInputTaxEligible).length).toBeGreaterThanOrEqual(3);
  });

  it('카드 월 사용량은 50~600건 범위 (계획값)', () => {
    for (const s of CLIENT_SPECS) {
      expect(s.volume.card).toBeGreaterThanOrEqual(50);
      expect(s.volume.card).toBeLessThanOrEqual(600);
    }
    expect(() => clientSpecOf('C999')).toThrow();
  });

  it('결정적', () => {
    expect(generateClients(20260926, new Set(), new Set())).toEqual(generateClients(20260926, new Set(), new Set()));
    expect(generateClients(1, new Set(), new Set())[0]!.businessNumber).not.toBe(clients[0]!.businessNumber);
  });
});
