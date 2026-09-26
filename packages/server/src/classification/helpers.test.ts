import { describe, expect, it } from 'vitest';
import {
  addMonths,
  assertPeriod,
  batchLabel,
  chunk,
  classificationSummaryText,
  emptyBucketCounts,
  fanOutSummaryText,
  isUuid,
  kstDate,
  mapWithConcurrency,
  monthLabel,
  periodBounds,
  trailingWindow,
  unifyLabels,
  withTimeout,
} from './helpers';

describe('period helpers', () => {
  it('computes bounds incl. leap years', () => {
    expect(periodBounds('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(periodBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodBounds('2026-12').end).toBe('2026-12-31');
  });
  it('adds months across years', () => {
    expect(addMonths('2026-09', -24)).toBe('2024-09');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-03', -15)).toBe('2024-12');
  });
  it('trailing window is N months inclusive of the period', () => {
    expect(trailingWindow('2026-09', 24)).toEqual({ from: '2024-10-01', to: '2026-09-30' });
    expect(trailingWindow('2026-09', 3)).toEqual({ from: '2026-07-01', to: '2026-09-30' });
  });
  it('validates period format with a Korean message', () => {
    expect(assertPeriod('2026-09')).toBe('2026-09');
    expect(() => assertPeriod('2026-9')).toThrow(/형식/);
    expect(() => assertPeriod('2026-13')).toThrow();
    expect(() => assertPeriod(undefined)).toThrow();
  });
  it('kstDate uses Korean date', () => {
    expect(kstDate(new Date('2026-09-30T16:00:00Z'))).toBe('2026-10-01');
  });
  it('isUuid', () => {
    expect(isUuid('6f1c2a4e-9b7d-5c3e-8a21-4d0b7e9f3c55')).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });
});

describe('labels & summaries', () => {
  it('labels homogeneous batches', () => {
    expect(batchLabel([{ evidenceType: 'card', direction: 'purchase' }, { evidenceType: 'card', direction: 'purchase' }])).toBe('카드매입');
    expect(batchLabel([{ evidenceType: 'tax_invoice', direction: 'sales' }])).toBe('세금계산서 매출');
    expect(batchLabel([{ evidenceType: 'card', direction: 'purchase' }, { evidenceType: 'bank', direction: 'purchase' }])).toBe('거래');
    expect(batchLabel([])).toBe('거래');
  });
  it('month label shows year only when different', () => {
    expect(monthLabel('2026-09', 2026)).toBe('9월');
    expect(monthLabel('2025-12', 2026)).toBe('2025년 12월');
  });
  it('builds the spec summary strings', () => {
    expect(classificationSummaryText({ period: '2026-09', label: '카드매입', total: 500, autoApproved: 470, needsReview: 30, currentYear: 2026 })).toBe(
      '9월 카드매입 500건 자동분류: 470건 자동확정, 30건 검토필요',
    );
    expect(classificationSummaryText({ period: '2026-09', label: '카드매입', total: 1500, autoApproved: 1400, needsReview: 100, skipped: 2, currentYear: 2026 })).toContain(
      '1,500건',
    );
    expect(fanOutSummaryText({ period: '2026-09', label: '카드매입', clients: 154, autoCompleted: 149, needsReview: 5, failed: 0, currentYear: 2026 })).toBe(
      '9월 카드매입 자동처리 전체 거래처 154곳 → 149곳 자동처리 / 5곳 검토필요',
    );
    expect(fanOutSummaryText({ period: '2026-09', label: '거래', clients: 3, autoCompleted: 1, needsReview: 1, failed: 1, currentYear: 2026 })).toMatch(/1곳 실패$/);
    expect(unifyLabels(['카드매입', '카드매입'])).toBe('카드매입');
    expect(unifyLabels(['카드매입', '통장 매입'])).toBe('거래');
  });
  it('bucket counts include every bucket', () => {
    const b = emptyBucketCounts();
    expect(Object.keys(b)).toHaveLength(15);
    expect(b.unclassified).toBe(0);
  });
});

describe('async helpers', () => {
  it('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
  it('mapWithConcurrency keeps order and limits parallelism', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 3, 2, 4], 2, async (x) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, x));
      active -= 1;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBeLessThanOrEqual(2);
  });
  it('withTimeout rejects slow promises', async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 50)), 5, 'x')).rejects.toThrow(/시간 초과/);
    await expect(withTimeout(Promise.resolve(1), 50, 'x')).resolves.toBe(1);
  });
});
