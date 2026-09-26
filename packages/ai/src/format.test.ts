import { describe, expect, it } from 'vitest';
import { changeRatePercent, formatManwon, formatPp, formatRate, formatRatio } from './format';

describe('formatManwon', () => {
  it.each([
    [55_000, '55,000원'],
    [125_000, '12.5만원'],
    [450_000, '45만원'],
    [2_400_000, '240만원'],
    [8_900_000, '890만원'],
    [47_040_000, '4,704만원'],
    [100_000_000, '1억원'],
    [123_000_000, '1억 2,300만원'],
    [-3_800_000, '-380만원'],
    [0, '0원'],
  ])('%d → %s', (v, s) => {
    expect(formatManwon(v)).toBe(s);
  });
});

describe('증감률 표기', () => {
  it('changeRatePercent', () => {
    expect(changeRatePercent(47_040_000, 32_000_000)).toBe(47);
    expect(changeRatePercent(56_000_000, 50_000_000)).toBe(12);
    expect(changeRatePercent(1, 0)).toBeNull();
  });
  it('formatRate / formatPp / formatRatio', () => {
    expect(formatRate(47)).toBe('+47%');
    expect(formatRate(-12.4)).toBe('-12%');
    expect(formatRate(3.5)).toBe('+3.5%');
    expect(formatRate(0)).toBe('0%');
    expect(formatPp(19)).toBe('+19%p');
    expect(formatPp(-4.5)).toBe('-4.5%p');
    expect(formatRatio(8_900_000 / 2_400_000)).toBe('3.7배');
    expect(formatRatio(2)).toBe('2배');
  });
});
