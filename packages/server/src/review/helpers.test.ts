import { describe, expect, it } from 'vitest';
import type { RiskFlag } from '@mintax/core';
import { AppError, ValidationError } from '@mintax/security';
import {
  approvalBlockReason,
  bulkIdOf,
  bulkReason,
  cardLast4,
  correctionBlockReason,
  correctionSummary,
  decodeCursor,
  displayReason,
  encodeCursor,
  exclusionBlockReason,
  foldBulkCorrections,
  kstStartOfDay,
  needsIndividualReview,
  normalizeIds,
  parseSearch,
  sameCoreState,
  scrubRawData,
  shortRiskFlags,
  txLabel,
  withoutBucket,
} from './helpers';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function flag(p: Partial<RiskFlag>): RiskFlag {
  return { ruleCode: 'R', ruleName: '규칙', bucket: 'high_amount', severity: 'warning', blocksAutoApproval: true, message: '고액', ...p };
}

const baseRow = {
  status: 'needs_review',
  direction: 'purchase' as const,
  accountCode: '830',
  deductible: true as boolean | null,
  buckets: [] as string[],
  riskFlags: [] as RiskFlag[],
  exportStatus: null as string | null,
};

describe('normalizeIds', () => {
  it('dedupes, lowercases and validates', () => {
    expect(normalizeIds([U1, U1.toUpperCase(), U2])).toEqual([U1, U2]);
  });
  it('rejects empty / malformed / too many with Korean messages', () => {
    expect(() => normalizeIds([])).toThrow(ValidationError);
    expect(() => normalizeIds(['nope'])).toThrow(/ID 형식/);
    expect(() => normalizeIds([U1, U2], 'ids', 1)).toThrow(/1건까지/);
  });
});

describe('cursor', () => {
  it('round-trips and rejects cursors from another sort', () => {
    const c = encodeCursor({ s: 'amount', k: [72300, U1] });
    expect(decodeCursor(c, 'amount', 2)).toEqual([72300, U1]);
    expect(() => decodeCursor(c, 'date', 2)).toThrow(/처음부터/);
    expect(() => decodeCursor('garbage!!', 'amount', 2)).toThrow(ValidationError);
    expect(decodeCursor(null, 'amount', 2)).toBeNull();
  });
});

describe('parseSearch', () => {
  it('escapes LIKE wildcards and extracts amount / bizno digits', () => {
    const s = parseSearch(' 50%_off ')!;
    expect(s.like).toBe('%50\\%\\_off%');
    expect(s.amount).toBeNull();
    const a = parseSearch('72,300원')!;
    expect(a.amount).toBe(72300);
    const b = parseSearch('120-88')!;
    expect(b.digits).toBe('12088');
    expect(parseSearch('   ')).toBeNull();
  });
});

describe('approvalBlockReason', () => {
  it('allows needs_review / auto_approved with account and VAT decided', () => {
    expect(approvalBlockReason(baseRow)).toBeNull();
    expect(approvalBlockReason({ ...baseRow, status: 'auto_approved' })).toBeNull();
  });
  it('explains why a row cannot be approved', () => {
    expect(approvalBlockReason({ ...baseRow, status: 'approved' })).toMatch(/이미 승인/);
    expect(approvalBlockReason({ ...baseRow, status: 'excluded' })).toMatch(/제외된/);
    expect(approvalBlockReason({ ...baseRow, accountCode: null })).toMatch(/계정과목/);
    expect(approvalBlockReason({ ...baseRow, deductible: null })).toMatch(/공제/);
    expect(approvalBlockReason({ ...baseRow, direction: 'sales', deductible: null })).toBeNull();
    expect(approvalBlockReason({ ...baseRow, status: 'auto_approved', exportStatus: 'downloaded' })).toMatch(/정정 전송/);
  });
  it('re-confirming an approved row clears an export error', () => {
    expect(approvalBlockReason({ ...baseRow, status: 'approved', buckets: ['export_error'] })).toBeNull();
  });
  it('optionally skips rows with auto-approval-blocking risks', () => {
    const row = { ...baseRow, riskFlags: [flag({ bucket: 'possible_asset' })] };
    expect(approvalBlockReason(row)).toBeNull();
    expect(approvalBlockReason(row, { excludeBlockingRisks: true })).toMatch(/자산 가능성/);
  });
});

describe('correction / exclusion eligibility', () => {
  it('allows correcting approved rows and rows in a not-yet-downloaded export', () => {
    expect(correctionBlockReason({ status: 'approved', exportStatus: null })).toBeNull();
    expect(correctionBlockReason({ status: 'exported', exportStatus: 'ready' })).toBeNull();
    expect(correctionBlockReason({ status: 'exported', exportStatus: 'downloaded' })).toMatch(/WEHAGO/);
    expect(correctionBlockReason({ status: 'exported', exportStatus: null })).toMatch(/정정 전송/);
    expect(exclusionBlockReason({ status: 'excluded', exportStatus: null })).toMatch(/이미 제외/);
  });
});

describe('risk flags', () => {
  it('sorts high severity and blocking first', () => {
    const s = shortRiskFlags([flag({ ruleCode: 'A', severity: 'info', blocksAutoApproval: false }), flag({ ruleCode: 'B', severity: 'high' })]);
    expect(s.map((f) => f.code)).toEqual(['B', 'A']);
  });
  it('account-resolvable buckets do not force individual review', () => {
    expect(needsIndividualReview([flag({ bucket: 'low_confidence' }), flag({ bucket: 'new_merchant' })])).toHaveLength(0);
    expect(needsIndividualReview([flag({ bucket: 'high_amount' })])).toHaveLength(1);
    expect(needsIndividualReview([flag({ bucket: 'high_amount', blocksAutoApproval: false })])).toHaveLength(0);
  });
});

describe('summaries', () => {
  it('builds the human audit summary', () => {
    const tx = { merchantName: '쿠팡', totalAmount: 72300 };
    expect(txLabel(tx)).toBe('쿠팡 72,300원');
    const before = { accountCode: '830', accountName: '소모품비', vatType: 'purchase_card', deductible: true };
    expect(correctionSummary(tx, before, { ...before, accountCode: '146', accountName: '상품' })).toBe('쿠팡 72,300원 소모품비 → 상품');
    expect(correctionSummary(tx, before, { ...before, deductible: false, vatType: 'purchase_no_evidence' })).toBe('쿠팡 72,300원 부가세 공제 → 불공제');
    expect(correctionSummary(tx, { ...before, accountCode: null, accountName: null }, before)).toBe('쿠팡 72,300원 미분류 → 소모품비');
  });
});

describe('bulk corrections fold to one learning event', () => {
  it('keeps the earliest record per bulk id and every non-bulk record', () => {
    const recs = [
      { transactionId: 't1', createdAt: '2026-09-01T00:00:00.000Z', reason: null },
      { transactionId: 't3', createdAt: '2026-09-02T00:00:00.000Z', reason: bulkReason(B1, '같은 가맹점') },
      { transactionId: 't2', createdAt: '2026-09-02T00:00:00.000Z', reason: bulkReason(B1, null) },
      { transactionId: 't4', createdAt: '2026-09-03T00:00:00.000Z', reason: '직접 수정' },
    ];
    expect(foldBulkCorrections(recs).map((r) => r.transactionId)).toEqual(['t1', 't2', 't4']);
    expect(bulkIdOf(bulkReason(B1, 'x'))).toBe(B1);
    expect(displayReason(bulkReason(B1, '같은 가맹점'))).toBe('같은 가맹점');
    expect(displayReason(bulkReason(B1, null))).toBeNull();
  });
});

describe('misc', () => {
  it('scrubs raw source rows', () => {
    const out = scrubRawData({ 카드번호: '1234567812345678', 주민번호: '900101-1234567', 가맹점: '쿠팡', 메모: '연락처 900101-1234567', n: 5 }) as Record<string, unknown>;
    expect(out['카드번호']).toBe('1234-****-****-5678');
    expect(out['주민번호']).toBe('***');
    expect(out['가맹점']).toBe('쿠팡');
    expect(String(out['메모'])).not.toContain('1234567');
    expect(out.n).toBe(5);
  });
  it('compares core state and strips buckets', () => {
    expect(sameCoreState({ status: 'approved', accountCode: '830' }, { status: 'approved', accountCode: '830', deductible: null })).toBe(true);
    expect(sameCoreState({ status: 'approved' }, { status: 'needs_review' })).toBe(false);
    expect(withoutBucket(['export_error', 'high_amount'], 'export_error')).toEqual(['high_amount']);
  });
  it('computes KST day start and card last 4', () => {
    expect(kstStartOfDay(new Date('2026-09-26T00:30:00+09:00')).toISOString()).toBe('2026-09-25T15:00:00.000Z');
    expect(cardLast4('1234-****-****-5678')).toBe('5678');
    expect(cardLast4(null)).toBeNull();
  });
  it('validation errors are AppErrors with Korean user messages', () => {
    try {
      normalizeIds('x' as never);
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).userMessage).toMatch(/선택/);
    }
  });
});
