import { describe, expect, it } from 'vitest';
import type { CorrectionRecord, HistoryEntry } from '../types';
import {
  applyCorrectionPriority,
  buildCorrectionIndex,
  buildHistoryIndex,
  buildMerchantIndex,
  compareCorrection,
  consistency,
  daysBetween,
  dominantAccount,
  historyKey,
  isoToKstDate,
  latestCorrectedEntry,
  lookupCorrections,
  lookupMerchant,
  majorityAccountByCount,
  recencyWeight,
  tallyHistory,
} from './history';

function e(p: Partial<HistoryEntry> & { accountCode: string; transactionDate: string }): HistoryEntry {
  return {
    clientId: 'c1',
    merchantKey: '쿠팡',
    merchantBusinessNumber: null,
    accountName: p.accountCode,
    totalAmount: 10_000,
    corrected: false,
    industry: 'construction',
    ...p,
  };
}

function corr(p: Partial<CorrectionRecord> & { after: string; createdAt: string }): CorrectionRecord {
  return {
    clientId: 'c1',
    merchantKey: '쿠팡',
    merchantBusinessNumber: null,
    field: 'account',
    before: '830',
    userId: 'u',
    transactionId: 't',
    ...p,
  };
}

describe('dates', () => {
  it('daysBetween / isoToKstDate', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2026-03-01', '2026-02-28')).toBe(-1);
    expect(daysBetween('bad', '2026-01-01')).toBe(0);
    // UTC 15시 이후는 KST 다음날
    expect(isoToKstDate('2026-09-05T16:00:00Z')).toBe('2026-09-06');
    expect(isoToKstDate('2026-09-05T10:00:00+09:00')).toBe('2026-09-05');
    expect(isoToKstDate('2026-09-05')).toBe('2026-09-05');
  });

  it('recencyWeight halves per half-life and is 1 without a reference date', () => {
    expect(recencyWeight('2025-09-15', '2026-09-15', 365)).toBeCloseTo(0.5, 5);
    expect(recencyWeight('2026-09-15', '2026-09-15', 365)).toBe(1);
    expect(recencyWeight('2026-10-01', '2026-09-15', 365)).toBe(1);
    expect(recencyWeight('2020-01-01', null, 365)).toBe(1);
  });
});

describe('tally & dominance', () => {
  const opts = { asOfDate: '2026-09-15', halfLifeDays: 365, correctedWeight: 3 };

  it('counts, averages and picks the dominant account', () => {
    const entries = [
      e({ accountCode: '830', transactionDate: '2026-08-01', totalAmount: 10_000 }),
      e({ accountCode: '830', transactionDate: '2026-07-01', totalAmount: -20_000 }),
      e({ accountCode: '146', transactionDate: '2026-06-01', totalAmount: 30_000 }),
    ];
    const s = tallyHistory(entries, opts);
    expect(s.total).toBe(3);
    expect(s.dominant?.accountCode).toBe('830');
    expect(s.consistentCount).toBe(2);
    expect(s.ratio).toBeCloseTo(2 / 3);
    expect(s.averageAmount).toBe(20_000); // |금액| 평균
    expect(s.lastUsedDate).toBe('2026-08-01');
    expect(consistency(entries, '146')).toEqual({ count: 1, total: 3, ratio: 1 / 3 });
  });

  it('corrected and recent entries weigh more than old uncorrected ones', () => {
    const entries = [
      e({ accountCode: '830', transactionDate: '2023-01-01' }),
      e({ accountCode: '830', transactionDate: '2023-02-01' }),
      e({ accountCode: '146', transactionDate: '2026-08-01', corrected: true }),
    ];
    expect(dominantAccount(entries, opts)?.accountCode).toBe('146');
    expect(majorityAccountByCount(entries)).toBe('830');
  });

  it('ties are resolved deterministically', () => {
    const a = [e({ accountCode: '830', transactionDate: '2026-08-01' }), e({ accountCode: '146', transactionDate: '2026-08-01' })];
    expect(dominantAccount(a, opts)?.accountCode).toBe('146');
    expect(dominantAccount([...a].reverse(), opts)?.accountCode).toBe('146');
    expect(majorityAccountByCount(a)).toBe('146');
    expect(majorityAccountByCount([...a].reverse())).toBe('146');
    expect(majorityAccountByCount([])).toBeNull();
  });

  it('empty history', () => {
    const s = tallyHistory([], opts);
    expect(s.dominant).toBeNull();
    expect(s.averageAmount).toBeNull();
    expect(s.ratio).toBe(0);
  });
});

describe('correction priority', () => {
  const entries = [
    e({ accountCode: '830', transactionDate: '2026-05-01' }),
    e({ accountCode: '830', transactionDate: '2026-06-01' }),
    e({ accountCode: '146', transactionDate: '2026-08-01', corrected: true }),
    e({ accountCode: '146', transactionDate: '2026-08-15' }),
  ];

  it('drops entries before a correction that disagrees with the majority', () => {
    const r = applyCorrectionPriority(entries, { date: '2026-08-01', accountCode: '146' }, '830');
    expect(r.effective.map((x) => x.transactionDate)).toEqual(['2026-08-01', '2026-08-15']);
    expect(r.superseded).toHaveLength(2);
  });

  it('keeps everything when the correction agrees with the majority or there is none', () => {
    expect(applyCorrectionPriority(entries, { date: '2026-08-01', accountCode: '830' }, '830').effective).toHaveLength(4);
    expect(applyCorrectionPriority(entries, null, '830').effective).toHaveLength(4);
  });

  it('latestCorrectedEntry', () => {
    expect(latestCorrectedEntry(entries)?.transactionDate).toBe('2026-08-01');
    expect(latestCorrectedEntry(entries.filter((x) => !x.corrected))).toBeNull();
  });
});

describe('indexes', () => {
  it('buildHistoryIndex keys by client + bizno/merchantKey, sorted, skipping empty keys', () => {
    const idx = buildHistoryIndex([
      e({ accountCode: '830', transactionDate: '2026-08-01', merchantBusinessNumber: '1208800767' }),
      e({ accountCode: '830', transactionDate: '2026-07-01' }),
      e({ accountCode: '830', transactionDate: '2026-07-01', merchantKey: '' }),
      e({ accountCode: '830', transactionDate: '2026-07-01', clientId: 'c2' }),
    ]);
    expect(idx.byBizno.get(historyKey('c1', 'b:1208800767'))).toHaveLength(1);
    const k = idx.byKey.get(historyKey('c1', 'k:쿠팡'))!;
    expect(k.map((x) => x.transactionDate)).toEqual(['2026-07-01', '2026-08-01']);
    expect(idx.byKey.get(historyKey('c2', 'k:쿠팡'))).toHaveLength(1);
    expect([...idx.byKey.keys()].some((x) => x.endsWith('k:'))).toBe(false);
    expect(idx.size).toBe(4);
  });

  it('lookupMerchant unions bizno and key matches without duplicates', () => {
    const shared = e({ accountCode: '830', transactionDate: '2026-08-01', merchantBusinessNumber: '1208800767' });
    const idx = buildMerchantIndex([shared, e({ accountCode: '146', transactionDate: '2026-08-02' }), e({ accountCode: '146', transactionDate: '2026-08-02', merchantKey: '다른곳', merchantBusinessNumber: '1208800767' })]);
    expect(lookupMerchant(idx, { merchantBusinessNumber: '1208800767', merchantKey: '쿠팡' })).toHaveLength(3);
    expect(lookupMerchant(idx, { merchantBusinessNumber: null, merchantKey: '쿠팡' })).toHaveLength(2);
    expect(lookupMerchant(idx, { merchantBusinessNumber: null, merchantKey: '' })).toHaveLength(0);
  });

  it('correction index keeps only this client’s real account changes; different bizno excluded', () => {
    const idx = buildCorrectionIndex(
      [
        corr({ after: '146', createdAt: '2026-09-02T00:00:00Z' }),
        corr({ after: '146', createdAt: '2026-09-01T00:00:00Z', transactionId: 't0' }),
        corr({ after: '830', before: '830', createdAt: '2026-09-03T00:00:00Z' }),
        corr({ after: 'x', field: 'vat', createdAt: '2026-09-03T00:00:00Z' }),
        corr({ after: '146', clientId: 'c2', createdAt: '2026-09-03T00:00:00Z' }),
        corr({ after: '153', merchantBusinessNumber: '9999999999', createdAt: '2026-09-04T00:00:00Z' }),
      ],
      'c1',
    );
    const found = lookupCorrections(idx, { merchantBusinessNumber: '1208800767', merchantKey: '쿠팡' });
    expect(found.map((c) => c.createdAt)).toEqual(['2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z']);
    expect(lookupCorrections(idx, { merchantBusinessNumber: null, merchantKey: '쿠팡' })).toHaveLength(3);
  });

  it('compareCorrection orders by actual instant across offsets', () => {
    const a = corr({ after: '1', createdAt: '2026-09-01T10:00:00+09:00' }); // 01:00Z
    const b = corr({ after: '2', createdAt: '2026-09-01T02:00:00Z' });
    expect(compareCorrection(a, b)).toBeLessThan(0);
  });
});
