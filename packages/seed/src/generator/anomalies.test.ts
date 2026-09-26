import { parseWon } from '@mintax/core';
import { describe, expect, it } from 'vitest';
import { ANOMALY_KINDS, ANOMALY_SPECS, EXPECTED_BUCKETS_BY_ANOMALY, buildManifest } from './anomalies';
import { generateDataset } from './index';
import { isWeekend } from './transactions';
import type { AnomalyKind, SyntheticTransaction } from './types';

const ds = generateDataset();
const byId = new Map([...ds.history, ...ds.current].map((t) => [t.id, t]));
const withKind = (k: AnomalyKind): SyntheticTransaction[] => ds.current.filter((t) => t.anomalies.includes(k));
const historyMerchantNames = new Set(ds.history.map((t) => `${t.clientCode}|${t.merchantName}`));
const universeNames = new Set(ds.merchants.map((m) => m.name));

describe('이상치 매니페스트', () => {
  it('종류별 건수 = ANOMALY_SPECS 문서 건수', () => {
    for (const k of ANOMALY_KINDS) expect(ds.anomalies.counts[k], k).toBe(ANOMALY_SPECS[k].count);
    expect(ds.stats.anomalies).toEqual(ds.anomalies.counts);
  });

  it('종류별 거래처 구성 = 문서의 거래처 목록', () => {
    for (const k of ANOMALY_KINDS) {
      const actual = ds.anomalies.entries.filter((e) => e.kind === k).map((e) => e.clientCode).sort();
      expect(actual, k).toEqual([...ANOMALY_SPECS[k].clients].sort());
    }
  });

  it('모든 항목의 거래 id 가 실제로 있다 (실패행 포함)', () => {
    const failureIds = new Set(ds.failures.map((f) => f.id));
    for (const e of ds.anomalies.entries) {
      for (const id of e.transactionIds) expect(byId.has(id) || failureIds.has(id), id).toBe(true);
      expect(e.description.length).toBeGreaterThan(0);
    }
  });

  it('이상치는 당월에만 있다', () => {
    expect(ds.history.every((t) => t.anomalies.length === 0)).toBe(true);
  });

  it('기대 버킷이 문서와 일치', () => {
    for (const [k, buckets] of Object.entries(EXPECTED_BUCKETS_BY_ANOMALY)) {
      for (const t of withKind(k as AnomalyKind)) expect(t.truth.expectedBuckets, t.id).toEqual(buckets);
    }
  });

  it('buildManifest 는 입력만으로 같은 결과', () => {
    expect(buildManifest(ds.current, ds.failures, ds.ledgerAnomalies)).toEqual(ds.anomalies);
  });
});

describe('종류별 내용', () => {
  it('완전중복: 원거래와 fingerprint·승인번호 동일, 다른 채널, 기대 상태 duplicate', () => {
    for (const d of withKind('exact_duplicate')) {
      const orig = byId.get(d.truth.duplicateOf!)!;
      expect(orig).toBeDefined();
      expect(d.fingerprint).toBe(orig.fingerprint);
      expect(d.approvalNumber).toBe(orig.approvalNumber);
      expect(d.totalAmount).toBe(orig.totalAmount);
      expect(d.channel).toBe('desktop_bridge');
      expect(orig.channel).toBe('hometax_file');
      expect(d.truth.expectedStatus).toBe('duplicate');
      expect(d.truth.accountCode).toBe(orig.truth.accountCode);
      // 재전송은 같은 원본 행 — 파일에서도 같은 행으로 보여야 파일 경로 fingerprint 가 같다
      expect(d.rawData).toEqual(orig.rawData);
    }
  });

  it('중복 의심: 같은 날·가맹점·금액, 다른 승인번호·fingerprint (별개 거래)', () => {
    for (const d of withKind('possible_duplicate')) {
      const orig = byId.get(d.truth.possibleDuplicateOf!)!;
      expect(d.transactionDate).toBe(orig.transactionDate);
      expect(d.merchantBusinessNumber).toBe(orig.merchantBusinessNumber);
      expect(d.totalAmount).toBe(orig.totalAmount);
      expect(d.approvalNumber).not.toBe(orig.approvalNumber);
      expect(d.fingerprint).not.toBe(orig.fingerprint);
      expect(d.truth.expectedStatus).toBeUndefined();
    }
  });

  it('분류 불가: 우주·이력에 없는 상호, 업종 정보 없음', () => {
    for (const t of withKind('unclassifiable_merchant')) {
      expect(t.merchantId).toBeNull();
      expect(universeNames.has(t.merchantName)).toBe(false);
      expect(historyMerchantNames.has(`${t.clientCode}|${t.merchantName}`)).toBe(false);
      expect(t.merchantCategory).toBeNull();
    }
  });

  it('고액 자산: 노트북 2,300,000원 포함, 모두 212 비품·1대 취득가액(공급가액) 100만원 초과', () => {
    const assets = withKind('asset_purchase');
    expect(assets.some((t) => t.description === '노트북' && t.totalAmount === 2_300_000)).toBe(true);
    for (const t of assets) {
      expect(t.truth.accountCode).toBe('212');
      expect(t.supplyAmount).toBeGreaterThan(1_000_000);
      // 여러 대 묶음이면 거래단위별로는 즉시상각 대상일 수 있다 → 1대 구입만 둔다
      expect(t.description).not.toMatch(/[2-9]대/);
    }
  });

  it('접대: 골프장 2·주점류 3, 813 불공제(VAT-ENT-01)', () => {
    const ents = withKind('entertainment');
    expect(ents.filter((t) => /골프|CC/.test(t.merchantName))).toHaveLength(2);
    expect(ents.filter((t) => /주점|가라오케/.test(t.merchantName))).toHaveLength(3);
    for (const t of ents) expect(t.truth).toMatchObject({ accountCode: '813', deductible: false, nonDeductibleReasonCode: 'VAT-ENT-01' });
    expect(ents.some((t) => t.serviceCharge > 0)).toBe(true);
  });

  it('개인사용: 주말 마트·백화점, 법인 134 / 개인 338, 불공제', () => {
    for (const t of withKind('personal_use')) {
      expect(isWeekend(t.transactionDate), t.transactionDate).toBe(true);
      const c = ds.clients.find((x) => x.code === t.clientCode)!;
      expect(t.truth.accountCode).toBe(c.businessType === 'corporation' ? '134' : '338');
      expect(t.truth).toMatchObject({ deductible: false, nonDeductibleReasonCode: 'VAT-BIZ-01' });
    }
  });

  it('해외 SaaS: USD·해외·세액 0·831, 이력에 없는 가맹점', () => {
    for (const t of withKind('foreign_saas')) {
      expect(t).toMatchObject({ isForeign: true, currency: 'USD', vatAmount: 0, merchantBusinessNumber: null });
      expect(t.truth).toMatchObject({ accountCode: '831', vatType: 'purchase_no_evidence', deductible: false });
      expect(historyMerchantNames.has(`${t.clientCode}|${t.merchantName}`)).toBe(false);
    }
  });

  it('부가세 오류: 세액≠10% 2건, 공급가액+세액≠합계 2건', () => {
    const v = withKind('vat_mismatch');
    expect(v.filter((t) => t.evidenceType === 'tax_invoice' && t.vatAmount !== Math.trunc(t.supplyAmount / 10))).toHaveLength(2);
    expect(v.filter((t) => t.supplyAmount + t.vatAmount + t.serviceCharge !== t.totalAmount)).toHaveLength(2);
  });

  it('신규 고액: 이력에 없는 거래처의 300만원 이상 세금계산서', () => {
    for (const t of withKind('new_merchant_high_amount')) {
      expect(t.evidenceType).toBe('tax_invoice');
      expect(t.totalAmount).toBeGreaterThanOrEqual(3_000_000);
      expect(t.merchantId).toBeNull();
      expect(historyMerchantNames.has(`${t.clientCode}|${t.merchantName}`)).toBe(false);
    }
  });

  it("파싱 실패: 합계 '3,2OO' 은 parseWon 으로 읽을 수 없다", () => {
    expect(ds.failures).toHaveLength(1);
    const f = ds.failures[0]!;
    expect(f.rawData['합계']).toBe('3,2OO');
    expect(parseWon(f.rawData['합계'])).toBeNull();
    expect(parseWon(f.rawData['공급가액'])).toBe(2_909);
    expect(f.fileKind).toBe('card_purchase');
  });

  it('취소: 원거래와 정확히 반대 금액, 같은 계정', () => {
    const cancels = withKind('cancel_negative');
    expect(cancels.filter((t) => t.evidenceType === 'card')).toHaveLength(2);
    expect(cancels.filter((t) => t.evidenceType === 'cash_receipt')).toHaveLength(1);
    for (const t of cancels) {
      const orig = byId.get(t.truth.cancelOf!)!;
      expect(orig, t.id).toBeDefined();
      expect(t.truth.note).toContain(orig.id);
      expect(t.totalAmount).toBe(-orig.totalAmount);
      expect(t.supplyAmount).toBe(-orig.supplyAmount);
      expect(t.vatAmount).toBe(-orig.vatAmount);
      expect(t.truth.accountCode).toBe(orig.truth.accountCode);
      expect(t.transactionDate >= orig.transactionDate).toBe(true);
      if (t.evidenceType === 'card') expect(t.approvalNumber).toBe(orig.approvalNumber);
      else expect(t.rawData['거래구분']).toBe('취소거래');
    }
  });

  it('처리 변경: 쿠팡 이력은 소모품비뿐, 이번 건은 비품', () => {
    const [t] = withKind('treatment_changed');
    expect(t!.merchantName).toBe('쿠팡');
    expect(t!.truth.accountCode).toBe('212');
    const hist = ds.history.filter((h) => h.clientCode === t!.clientCode && h.merchantName === '쿠팡');
    expect(hist.length).toBeGreaterThan(20);
    expect(new Set(hist.map((h) => h.truth.accountCode))).toEqual(new Set(['830']));
  });

  it('계정 급증: 사건 1건에 거래 6건, 변화율 계산', () => {
    const e = ds.anomalies.entries.find((x) => x.kind === 'account_spike')!;
    expect(e.transactionIds).toHaveLength(6);
    expect(e.metric).toEqual({ current: 8_900_000, baseline: 2_400_000, changeRate: 270.8 });
    expect(e.description).toContain('2,400,000원');
  });
});
