import { describe, expect, it } from 'vitest';
import {
  NEEDS_CLIENT_TAG,
  NEEDS_MAPPING_TAG,
  baseNameOf,
  buildImportSummary,
  channelForBridgeFolder,
  checkRowAccounting,
  chooseImportPeriod,
  chunk,
  deriveImportState,
  failureNotificationTitle,
  generateBridgeToken,
  isValidPeriod,
  matchWehagoDoubleBooking,
  parseBridgeToken,
  summarizeWarnings,
  wehagoDuplicateKey,
} from './helpers';

describe('buildImportSummary', () => {
  it('matches the office wording exactly', () => {
    expect(buildImportSummary({ totalRows: 1048, importedRows: 1046, duplicateRows: 0, failedRows: 2 })).toBe('1,048건 수집 · 1,046건 처리 · 2건 처리실패');
  });
  it('mentions duplicates inside the processed count and omits zero failures', () => {
    expect(buildImportSummary({ totalRows: 10, importedRows: 7, duplicateRows: 3, failedRows: 0 })).toBe('10건 수집 · 10건 처리(중복 3건 포함)');
  });
  it('describes states that need a person', () => {
    const c = { totalRows: 0, importedRows: 0, duplicateRows: 0, failedRows: 0 };
    expect(buildImportSummary(c, 'needs_client')).toContain('수임처 확인 필요');
    expect(buildImportSummary(c, 'needs_mapping')).toContain('서식 확인 필요');
    expect(buildImportSummary(c, 'failed')).toContain('실패');
  });
  it('builds the failure notification title', () => {
    expect(failureNotificationTitle(2)).toBe('2건 처리실패 — 오류 항목을 확인하세요');
  });
});

describe('deriveImportState', () => {
  it('derives needs_* from status/client/message tags', () => {
    expect(deriveImportState('queued', null, `${NEEDS_CLIENT_TAG} 후보`)).toBe('needs_client');
    expect(deriveImportState('queued', null, null)).toBe('needs_client');
    expect(deriveImportState('failed', 'c1', `${NEEDS_MAPPING_TAG} 알 수 없는 서식`)).toBe('needs_mapping');
    expect(deriveImportState('queued', 'c1', null)).toBe('queued');
    expect(deriveImportState('partial', 'c1', null)).toBe('partial');
    expect(deriveImportState('weird', 'c1', null)).toBe('failed');
  });
});

describe('checkRowAccounting', () => {
  it('accepts total = imported + duplicate + failed', () => {
    expect(checkRowAccounting({ totalRows: 7, importedRows: 4, duplicateRows: 1, failedRows: 2 })).toBeNull();
  });
  it('explains a violation in Korean', () => {
    const msg = checkRowAccounting({ totalRows: 8, importedRows: 4, duplicateRows: 1, failedRows: 2 });
    expect(msg).toContain('행 집계가 맞지 않습니다');
    expect(msg).toContain('(= 7)');
  });
});

describe('WEHAGO double-booking key', () => {
  const base = { direction: 'purchase', transactionDate: '2026-09-05', merchantBusinessNumber: '1208100031', totalAmount: 5000, evidenceType: 'card' };
  it('uses date + business number + amount + tax class (+ direction)', () => {
    expect(wehagoDuplicateKey(base)).toBe('purchase|2026-09-05|1208100031|5000|카드');
    expect(wehagoDuplicateKey({ ...base, evidenceType: 'tax_invoice' })).not.toBe(wehagoDuplicateKey(base));
    expect(wehagoDuplicateKey({ ...base, direction: 'sales' })).not.toBe(wehagoDuplicateKey(base));
  });
  it('cannot key a transaction without a business number', () => {
    expect(wehagoDuplicateKey({ ...base, merchantBusinessNumber: null })).toBeNull();
  });
  it('matches one-to-one and skips exported rows already consumed by fingerprint duplicates', () => {
    const k = wehagoDuplicateKey(base);
    const m = matchWehagoDoubleBooking(
      [
        { index: 0, key: k },
        { index: 1, key: k },
        { index: 2, key: null },
      ],
      [
        { id: 'x1', key: k },
        { id: 'x2', key: k },
      ],
      new Set(['x1']),
    );
    expect([...m.entries()]).toEqual([[0, 'x2']]);
  });
});

describe('misc helpers', () => {
  it('chooses the dominant period unless one was requested', () => {
    const counts = new Map([
      ['2026-08', 3],
      ['2026-09', 10],
    ]);
    expect(chooseImportPeriod(counts, null)).toBe('2026-09');
    expect(chooseImportPeriod(counts, '2026-08')).toBe('2026-08');
    expect(chooseImportPeriod(new Map(), null)).toBeNull();
  });
  it('validates periods', () => {
    expect(isValidPeriod('2026-09')).toBe(true);
    expect(isValidPeriod('2026-13')).toBe(false);
    expect(isValidPeriod('202609')).toBe(false);
  });
  it('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('summarizes row warnings by code', () => {
    const out = summarizeWarnings([
      { sourceRowNumber: 3, code: 'amounts_estimated', message: '추정' },
      { sourceRowNumber: 5, code: 'amounts_estimated', message: '추정' },
      { sourceRowNumber: null, code: 'declared_total_mismatch', message: '합계 불일치' },
      { sourceRowNumber: 9, code: 'other', message: '기타' },
    ]);
    expect(out).toEqual(['추정 (2건: 3, 5행)', '합계 불일치', '9행: 기타']);
  });
  it('generates and parses bridge tokens', () => {
    const { id, token } = generateBridgeToken();
    expect(token.startsWith(`mtb1.${id}.`)).toBe(true);
    expect(parseBridgeToken(token)).toEqual({ id });
    expect(parseBridgeToken('mtb1.zz.abc')).toBeNull();
    expect(parseBridgeToken(123)).toBeNull();
  });
  it('maps bridge source folders to channels and keeps only base names', () => {
    expect(channelForBridgeFolder('downloads')).toBe('download_watch');
    expect(channelForBridgeFolder('inbox')).toBe('desktop_bridge');
    expect(channelForBridgeFolder(undefined)).toBe('desktop_bridge');
    expect(baseNameOf('C:\\Users\\홍길동\\Downloads\\카드.xlsx')).toBe('카드.xlsx');
  });
});
