import { describe, expect, it } from 'vitest';
import type { NormalizedTransaction } from '../types';
import { computeFingerprint } from '../fingerprint';
import { normalizeMerchantName } from '../normalize';
import { detectDuplicates } from './dedupe';

function mkTx(o: Partial<NormalizedTransaction> = {}, withFingerprint = true): NormalizedTransaction {
  const merchantName = o.merchantName ?? 'ABC마트';
  const t: NormalizedTransaction = {
    clientId: 'c1',
    businessNumber: '1234567890',
    source: 'business_card',
    channel: 'wemembers_file',
    direction: 'purchase',
    transactionDate: '2026-09-12',
    evidenceType: 'card',
    merchantName,
    merchantKey: normalizeMerchantName(merchantName),
    merchantBusinessNumber: null,
    merchantCategory: null,
    merchantTaxType: 'unknown',
    description: '',
    supplyAmount: 29545,
    vatAmount: 2955,
    serviceCharge: 0,
    totalAmount: 32500,
    cardNumberMasked: '1234-****-****-5678',
    approvalNumber: '30012345',
    originalSourceId: null,
    currency: 'KRW',
    isForeign: false,
    sourceDeductibleHint: null,
    rawData: {},
    sourceRowNumber: 1,
    fingerprint: '',
    ...o,
  };
  if (withFingerprint) t.fingerprint = computeFingerprint(t);
  return t;
}

describe('detectDuplicates', () => {
  it('같은 파일 안의 중복: batch:<앞 index>, 행 번호로 설명', () => {
    const a = mkTx({ sourceRowNumber: 3 });
    const b = mkTx({ sourceRowNumber: 7, channel: 'desktop_bridge' });
    const c = mkTx({ approvalNumber: '30012346', sourceRowNumber: 8 });
    const r = detectDuplicates([a, b, c], []);
    expect(r.unique).toEqual([a, c]);
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0]!.duplicateOf).toBe('batch:0');
    expect(r.duplicates[0]!.index).toBe(1);
    expect(r.duplicates[0]!.tx).toBe(b);
    expect(r.duplicates[0]!.reason).toBe(
      '2026-09-12 ABC마트 32,500원 거래는 같은 자료의 3행과 같아 중복으로 판정했습니다 (승인번호 30012345·일자·금액·카드번호 동일).',
    );
  });

  it('기존 등록 거래와 중복: existing:<id>', () => {
    const a = mkTx();
    const r = detectDuplicates([a], [{ id: 'tx-9', fingerprint: a.fingerprint }]);
    expect(r.unique).toEqual([]);
    expect(r.duplicates[0]!.duplicateOf).toBe('existing:tx-9');
    expect(r.duplicates[0]!.reason).toContain('이미 등록된 거래와 같아');
  });

  it('기존 중복이 같은 파일 중복보다 우선, 아무 것도 버리지 않는다', () => {
    const a = mkTx();
    const b = mkTx();
    const c = mkTx({ approvalNumber: '999' });
    const r = detectDuplicates([a, b, c, c], [{ id: 'x', fingerprint: a.fingerprint }]);
    expect(r.unique.length + r.duplicates.length).toBe(4);
    expect(r.duplicates.map((d) => d.duplicateOf)).toEqual(['existing:x', 'existing:x', 'batch:2']);
  });

  it('세금계산서는 국세청 승인번호 기준', () => {
    const a = mkTx({ evidenceType: 'tax_invoice', approvalNumber: '20260912-41000000-12345678', totalAmount: 110000, supplyAmount: 100000, vatAmount: 10000 });
    const b = mkTx({ evidenceType: 'tax_invoice', approvalNumber: '20260912-41000000-12345678', totalAmount: 110000, supplyAmount: 100000, vatAmount: 10000, transactionDate: '2026-09-13', sourceRowNumber: 2 });
    const r = detectDuplicates([a, b], []);
    expect(r.duplicates[0]!.reason).toContain('국세청 승인번호 20260912-41000000-12345678 동일');
  });

  it('승인번호 없는 행: 일자·상대방·금액 기준, 행번호 없으면 순번으로 설명', () => {
    const a = mkTx({ approvalNumber: null, sourceRowNumber: null });
    const b = mkTx({ approvalNumber: null, sourceRowNumber: null });
    const r = detectDuplicates([a, b], []);
    expect(r.duplicates[0]!.reason).toContain('1번째 거래');
    expect(r.duplicates[0]!.reason).toContain('일자·상대방·금액·증빙유형·카드번호 동일');
  });

  it('fingerprint 가 비어 있으면 계산해서 비교', () => {
    const a = mkTx({}, false);
    const b = mkTx({}, false);
    expect(detectDuplicates([a, b], []).duplicates).toHaveLength(1);
    expect(detectDuplicates([a], [{ id: 'e', fingerprint: computeFingerprint(a) }]).duplicates[0]!.duplicateOf).toBe('existing:e');
  });

  it('빈 fingerprint 인 기존 거래는 매칭에 쓰지 않는다', () => {
    expect(detectDuplicates([mkTx()], [{ id: 'e', fingerprint: '' }]).unique).toHaveLength(1);
  });
});
