import { computeFingerprint, isValidBusinessNumber, vatOf } from '@mintax/core';
import { describe, expect, it } from 'vitest';
import { FILE_LAYOUTS } from './layouts';
import { generateDataset } from './index';
import { SCENARIO_A_CODE, SCENARIO_PAYROLL_CODE, SPIKE_CLIENT_CODE } from './clients';
import { fileKindOf } from './files';
import { isSyntheticBusinessNumber } from './ids';
import { acquisitionCostOf, truthAccountFor } from './merchants';
import {
  CURRENT_MONTH,
  HISTORY_MONTHS,
  SCENARIO1_CARD_COUNT,
  SCENARIO1_LOW_CONFIDENCE,
  SCENARIO1_NEW_MERCHANTS,
  SCENARIO1_REGULAR,
  SPIKE_PLAN,
  isWeekend,
  toHistoryEntry,
  toNormalizedTransaction,
} from './transactions';
import { accountNameOf, vatTruthFor } from './truth';
import type { SyntheticTransaction } from './types';

const ds = generateDataset();
const all = [...ds.history, ...ds.current];
const clientByCode = new Map(ds.clients.map((c) => [c.code, c]));
const merchantById = new Map(ds.merchants.map((m) => [m.id, m]));
const isCardPurchase = (t: SyntheticTransaction) => t.direction === 'purchase' && t.evidenceType === 'card' && t.channel !== 'desktop_bridge';

describe('기간·상태·볼륨', () => {
  it('모든 거래처가 6개월 이력(2026-03~08)과 9월 당월 자료를 가진다', () => {
    for (const c of ds.clients) {
      const months = new Set(ds.history.filter((t) => t.clientCode === c.code).map((t) => t.period));
      expect([...months].sort(), c.code).toEqual([...HISTORY_MONTHS]);
      expect(ds.current.some((t) => t.clientCode === c.code)).toBe(true);
    }
    expect(ds.current.every((t) => t.period === CURRENT_MONTH && t.transactionDate.startsWith(CURRENT_MONTH))).toBe(true);
    expect(ds.history.every((t) => t.transactionDate.startsWith(t.period))).toBe(true);
  });

  it('이력은 approved/exported, 당월은 imported', () => {
    for (const t of ds.history) expect(t.status).toBe(t.period === '2026-08' ? 'approved' : 'exported');
    for (const t of ds.current) expect(t.status).toBe('imported');
  });

  it('월별 사업용카드 50~600건 (거래처·월마다)', () => {
    const counts = new Map<string, number>();
    for (const t of all) if (isCardPurchase(t)) counts.set(`${t.clientCode}|${t.period}`, (counts.get(`${t.clientCode}|${t.period}`) ?? 0) + 1);
    expect(counts.size).toBe(ds.clients.length * 7);
    for (const [k, n] of counts) {
      expect(n, k).toBeGreaterThanOrEqual(50);
      expect(n, k).toBeLessThanOrEqual(600);
    }
  });

  it('A거래처 2026-09 카드 480~520건', () => {
    const n = ds.current.filter((t) => t.clientCode === SCENARIO_A_CODE && isCardPurchase(t)).length;
    expect(n).toBeGreaterThanOrEqual(480);
    expect(n).toBeLessThanOrEqual(520);
    expect(ds.stats.cardPurchasesByClientCurrent[SCENARIO_A_CODE]).toBe(n);
  });

  it('증빙 다양성: 카드·현금영수증·세금계산서·계산서 매입 + 매출', () => {
    const kinds = new Set(ds.current.map((t) => `${t.direction}:${t.evidenceType}`));
    for (const k of ['purchase:card', 'purchase:cash_receipt', 'purchase:tax_invoice', 'purchase:invoice_exempt', 'sales:tax_invoice', 'sales:invoice_exempt', 'sales:card', 'sales:cash_receipt']) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it('id 고유, 이력 약 2%는 사람 수정 표시', () => {
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    const purchases = ds.history.filter((t) => t.direction === 'purchase');
    const ratio = purchases.filter((t) => t.truth.corrected).length / purchases.length;
    expect(ratio).toBeGreaterThan(0.01);
    expect(ratio).toBeLessThan(0.03);
  });
});

describe('금액·식별자 정합성', () => {
  const mismatch = (t: SyntheticTransaction) => t.anomalies.includes('vat_mismatch');

  it('모든 금액은 원 단위 정수, 공급가액+세액+봉사료 = 합계 (부가세 오류 이상치 제외)', () => {
    const bad: string[] = [];
    for (const t of all) {
      if (![t.supplyAmount, t.vatAmount, t.serviceCharge, t.totalAmount].every(Number.isSafeInteger)) bad.push(`${t.id} 정수 아님`);
      if (!mismatch(t) && t.supplyAmount + t.vatAmount + t.serviceCharge !== t.totalAmount) bad.push(`${t.id} 합계 불일치`);
    }
    expect(bad).toEqual([]);
  });

  it('세금계산서 세액 = 공급가액 10% (절사), 계산서·면세·해외는 세액 0', () => {
    for (const t of all) {
      if (t.evidenceType === 'tax_invoice' && !mismatch(t)) expect(t.vatAmount, t.id).toBe(vatOf(t.supplyAmount));
      if (t.evidenceType === 'invoice_exempt' || t.isForeign || (t.direction === 'purchase' && t.merchantTaxType === 'exempt')) expect(t.vatAmount, t.id).toBe(0);
    }
  });

  it('상대방 사업자번호는 유효·합성이거나 null (해외·카드/현금 매출만 null)', () => {
    const bad: string[] = [];
    for (const t of all) {
      if (t.merchantBusinessNumber === null) {
        if (!(t.isForeign || (t.direction === 'sales' && (t.evidenceType === 'card' || t.evidenceType === 'cash_receipt')))) bad.push(`${t.id} 번호 없음`);
      } else if (!isValidBusinessNumber(t.merchantBusinessNumber) || !isSyntheticBusinessNumber(t.merchantBusinessNumber)) {
        bad.push(`${t.id} 번호 오류`);
      }
      if (t.businessNumber !== clientByCode.get(t.clientCode)!.businessNumber) bad.push(`${t.id} 거래처 번호`);
    }
    expect(bad).toEqual([]);
  });

  it('fingerprint = computeFingerprint(clientId=거래처 코드)', () => {
    for (const t of all.slice(0, 3000)) expect(t.fingerprint).toBe(computeFingerprint({ ...t, clientId: t.clientCode }));
  });

  it('카드 매입은 거래처 카드, 승인번호는 거래처 안에서 고유 (완전중복·취소 제외)', () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    for (const t of all) {
      if (t.evidenceType === 'card' && t.direction === 'purchase' && !clientByCode.get(t.clientCode)!.cards.some((c) => c.masked === t.cardNumberMasked)) {
        bad.push(`${t.id} 카드`);
      }
      if (!t.approvalNumber || t.anomalies.includes('exact_duplicate') || t.anomalies.includes('cancel_negative')) continue;
      const key = `${t.clientCode}|${t.approvalNumber}`;
      if (seen.has(key)) bad.push(`${key} 중복`);
      seen.add(key);
    }
    expect(bad).toEqual([]);
  });

  it('당월 rawData 는 원본 레이아웃의 열 이름을 가진다, 이력은 최소 표식만', () => {
    const bad: string[] = [];
    for (const t of ds.current) {
      const kind = fileKindOf(t)!;
      for (const k of FILE_LAYOUTS[kind].keys) if (!(k in t.rawData)) bad.push(`${t.id} ${k}`);
    }
    expect(bad).toEqual([]);
    for (const t of ds.history.slice(0, 100)) expect(t.rawData).toEqual({ 원천: '합성 이력' });
  });
});

describe('정답 레이블', () => {
  it('계정명·부가세 정답이 규칙과 일치', () => {
    const bad: string[] = [];
    for (const t of all) {
      if (t.truth.accountName !== accountNameOf(t.truth.accountCode)) bad.push(`${t.id} 계정명`);
      const client = clientByCode.get(t.clientCode)!;
      const m = t.merchantId ? merchantById.get(t.merchantId) : undefined;
      const vt = vatTruthFor(
        {
          direction: t.direction,
          evidenceType: t.evidenceType,
          vatAmount: t.vatAmount,
          isForeign: t.isForeign,
          merchantTaxType: t.merchantTaxType,
          merchantKind: m?.kind ?? (t.direction === 'purchase' ? 'unknown' : null),
          sourceDeductibleHint: t.sourceDeductibleHint,
          description: t.description,
          accountCode: t.truth.accountCode,
        },
        client,
      );
      if (t.truth.vatType !== vt.vatType || t.truth.deductible !== vt.deductible || t.truth.nonDeductibleReasonCode !== vt.nonDeductibleReasonCode) bad.push(`${t.id} 부가세`);
    }
    expect(bad).toEqual([]);
  });

  it('일반 거래의 계정 = truthAccountFor(가맹점 종류 × 업종 × 금액)', () => {
    let checked = 0;
    const bad: string[] = [];
    for (const t of all) {
      if (t.direction !== 'purchase' || !t.merchantId || t.anomalies.length > 0) continue;
      if (t.scenarioTags.length > 0) continue;
      if (t.clientCode === SPIKE_CLIENT_CODE && t.truth.accountCode === '813') continue;
      if (t.clientCode === SCENARIO_PAYROLL_CODE && t.merchantName === '쿠팡') continue;
      const m = merchantById.get(t.merchantId)!;
      const c = clientByCode.get(t.clientCode)!;
      if (t.truth.accountCode !== truthAccountFor(m.kind, c.industry, t.totalAmount, acquisitionCostOf(t, c.vatType))) bad.push(t.id);
      checked += 1;
    }
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThan(25_000);
  });

  it('매출 계정: 제조 404 / 임대 904 / 그 외 401', () => {
    for (const t of all.filter((x) => x.direction === 'sales')) {
      const ind = clientByCode.get(t.clientCode)!.industry;
      expect(t.truth.accountCode).toBe(ind === 'manufacturing' ? '404' : ind === 'rental' ? '904' : '401');
      expect(t.truth.deductible).toBe(true);
    }
  });

  it('불공제 사유 분포: 면세사업자·접대비·차량·여객운송 등이 모두 나타난다', () => {
    const reasons = new Set(all.map((t) => t.truth.nonDeductibleReasonCode).filter(Boolean));
    for (const r of ['VAT-EXM-01', 'VAT-ENT-01', 'VAT-CAR-01', 'VAT-CARD-03', 'VAT-BIZ-01']) expect(reasons.has(r), r).toBe(true);
    // 불공제 차량 연결 거래는 설명에 차량번호가 있다
    for (const t of all.filter((x) => x.truth.nonDeductibleReasonCode === 'VAT-CAR-01')) {
      expect(clientByCode.get(t.clientCode)!.nonDeductibleVehicles.some((p) => t.description.includes(p))).toBe(true);
    }
  });

  it('같은 거래처·같은 가맹점 이력은 (금액 구간이 같으면) 같은 계정 — 학습 가능한 이력', () => {
    const groups = new Map<string, Set<string>>();
    for (const t of ds.history) {
      if (t.direction !== 'purchase' || !t.merchantId) continue;
      if (t.clientCode === SCENARIO_PAYROLL_CODE && t.merchantName === '쿠팡') continue;
      const m = merchantById.get(t.merchantId)!;
      if (['electronics', 'furniture', 'mart', 'hardware_tools', 'ecommerce_market'].includes(m.kind)) continue;
      const key = `${t.clientCode}|${t.merchantId}`;
      const s = groups.get(key) ?? new Set<string>();
      s.add(t.truth.accountCode);
      groups.set(key, s);
    }
    for (const [k, s] of groups) expect(s.size, k).toBe(1);
  });
});

describe('시나리오상사 (시나리오 1: 카드 500건)', () => {
  const sept = ds.current.filter((t) => t.clientCode === SCENARIO_PAYROLL_CODE && isCardPurchase(t));
  const hist = ds.history.filter((t) => t.clientCode === SCENARIO_PAYROLL_CODE && isCardPurchase(t));

  it('2026-09 카드 정확히 500건, 모두 평일, 이상치 주입 없음', () => {
    expect(sept).toHaveLength(SCENARIO1_CARD_COUNT);
    expect(sept.every((t) => !isWeekend(t.transactionDate))).toBe(true);
    expect(ds.current.filter((t) => t.clientCode === SCENARIO_PAYROLL_CODE && t.anomalies.some((a) => a !== 'correction_target'))).toHaveLength(0);
    expect(ds.failures.filter((f) => f.clientCode === SCENARIO_PAYROLL_CODE)).toHaveLength(0);
  });

  it('예외 설계 30건: 신규 10·저신뢰 6·공제검토 5·고액 3·계정충돌 3·자산 2·해외 1', () => {
    const counts: Record<string, number> = {};
    for (const t of sept) {
      const tag = t.scenarioTags.find((x) => x.startsWith('scenario1:') && x !== 'scenario1:correction');
      if (tag) counts[tag.slice('scenario1:'.length)] = (counts[tag.slice('scenario1:'.length)] ?? 0) + 1;
    }
    expect(counts).toEqual({ new_merchant: 10, low_confidence: 6, vat_review: 5, high_amount: 3, account_conflict: 3, possible_asset: 2, foreign: 1 });
    expect(sept.filter((t) => t.scenarioTags.includes('scenario1:correction'))).toHaveLength(4);
    const coupang = sept.filter((t) => t.merchantName === '쿠팡');
    expect(coupang.map((t) => t.truth.accountCode)).toEqual(['829', '829', '829']);
  });

  it('신규 10곳은 이력에 없고, 저신뢰 6곳은 이력에 정확히 1회', () => {
    const histNames = hist.map((t) => t.merchantName);
    for (const n of SCENARIO1_NEW_MERCHANTS) expect(histNames.includes(n), n).toBe(false);
    for (const lc of SCENARIO1_LOW_CONFIDENCE) expect(histNames.filter((x) => x === lc.name), lc.name).toHaveLength(1);
  });

  it('정규 470건은 이력 10회 이상·계정 일관 가맹점', () => {
    const regular = sept.filter((t) => t.scenarioTags.length === 0);
    expect(regular).toHaveLength(470);
    const regularNames = new Set([...SCENARIO1_REGULAR.map((r) => r.name), 'KT', 'SK텔레콤', 'LG유플러스']);
    for (const t of regular) {
      expect(regularNames.has(t.merchantName), t.merchantName).toBe(true);
      const h = hist.filter((x) => x.merchantName === t.merchantName);
      expect(h.length, t.merchantName).toBeGreaterThanOrEqual(6);
      expect(new Set(h.map((x) => x.truth.accountCode)).size).toBe(1);
      expect(h[0]!.truth.accountCode).toBe(t.truth.accountCode);
      expect(t.totalAmount).toBeLessThan(1_000_000);
    }
  });

  it('쿠팡 이력은 830 7회·829 5회로 갈린다', () => {
    const acc = hist.filter((t) => t.merchantName === '쿠팡').map((t) => t.truth.accountCode);
    expect(acc.filter((a) => a === '830')).toHaveLength(7);
    expect(acc.filter((a) => a === '829')).toHaveLength(5);
  });
});

describe('접대비 급증 (C004)', () => {
  const sum = (period: string) =>
    [...ds.history, ...ds.current]
      .filter((t) => t.clientCode === SPIKE_CLIENT_CODE && t.period === period && t.truth.accountCode === '813' && t.channel !== 'desktop_bridge')
      .reduce((a, t) => a + t.totalAmount, 0);

  it('월별 합계가 계획과 같고 3개월 평균 240만원 → 이번달 890만원', () => {
    for (const m of HISTORY_MONTHS) expect(sum(m), m).toBe(SPIKE_PLAN.historyTotals[m]);
    expect((sum('2026-06') + sum('2026-07') + sum('2026-08')) / 3).toBe(2_400_000);
    expect(sum(CURRENT_MONTH)).toBe(8_900_000);
    expect(ds.ledgerAnomalies[0]).toMatchObject({ clientCode: SPIKE_CLIENT_CODE, accountCode: '813', baseline: 2_400_000, current: 8_900_000 });
  });
});

describe('로더용 변환', () => {
  it('toNormalizedTransaction: clientId 주입·fingerprint 재계산·합성 메타 제거', () => {
    const t = ds.current[0]!;
    const n = toNormalizedTransaction(t, '11111111-1111-4111-8111-111111111111');
    expect(n.clientId).toBe('11111111-1111-4111-8111-111111111111');
    expect(n.fingerprint).toBe(computeFingerprint(n));
    expect(n.fingerprint).not.toBe(t.fingerprint);
    for (const k of ['id', 'clientCode', 'period', 'status', 'merchantId', 'truth', 'anomalies', 'scenarioTags']) expect(k in n).toBe(false);
    expect(Object.keys(n).sort()).toEqual(
      [
        'clientId', 'businessNumber', 'source', 'channel', 'direction', 'transactionDate', 'evidenceType', 'merchantName', 'merchantKey',
        'merchantBusinessNumber', 'merchantCategory', 'merchantTaxType', 'description', 'supplyAmount', 'vatAmount', 'serviceCharge',
        'totalAmount', 'cardNumberMasked', 'approvalNumber', 'originalSourceId', 'currency', 'isForeign', 'sourceDeductibleHint', 'rawData',
        'sourceRowNumber', 'fingerprint',
      ].sort(),
    );
  });

  it('toHistoryEntry', () => {
    const t = ds.history.find((x) => x.truth.corrected)!;
    const h = toHistoryEntry(t, 'uuid-1', 'design');
    expect(h).toMatchObject({ clientId: 'uuid-1', accountCode: t.truth.accountCode, corrected: true, industry: 'design', totalAmount: t.totalAmount });
  });
});
