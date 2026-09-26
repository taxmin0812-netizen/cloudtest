import { describe, expect, it } from 'vitest';
import { ANOMALY_SPECS, generateDataset } from '../generator/index';
import {
  GOLDEN_CHECKSUM,
  GOLDEN_EXPECTED,
  GOLDEN_SPEC,
  buildGoldenDataset,
  computeGoldenExpected,
  goldenChecksum,
  selectGoldenTransactions,
  verifyGoldenDataset,
} from './index';

const ds = generateDataset();
const golden = buildGoldenDataset({ dataset: ds });

describe('골든 데이터셋', () => {
  it('정확히 1,000건, id 고유·정렬, 완전중복 제외', () => {
    expect(golden.items).toHaveLength(GOLDEN_SPEC.size);
    const ids = golden.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(golden.items.every((i) => i.transaction.truth.expectedStatus !== 'duplicate')).toBe(true);
    expect(golden.items.every((i) => i.transaction.period === '2026-09')).toBe(true);
  });

  it('완전중복을 뺀 모든 이상치·시나리오 거래를 포함', () => {
    const ids = new Set(golden.items.map((i) => i.id));
    for (const t of ds.current) {
      if (t.truth.expectedStatus === 'duplicate') continue;
      if (t.anomalies.length > 0 || t.scenarioTags.length > 0) expect(ids.has(t.id), t.id).toBe(true);
    }
    for (const [kind, spec] of Object.entries(ANOMALY_SPECS)) {
      if (kind === 'exact_duplicate' || kind === 'parse_failure' || kind === 'account_spike') continue;
      expect(golden.expected.byAnomaly[kind], kind).toBe(spec.count);
    }
  });

  it('중복 의심·취소 거래의 원거래도 골든에 있다 (같은 배치에서만 판정 가능)', () => {
    const ids = new Set(golden.items.map((i) => i.id));
    let refs = 0;
    for (const { transaction: t } of golden.items) {
      for (const ref of [t.truth.possibleDuplicateOf, t.truth.cancelOf]) {
        if (!ref) continue;
        refs += 1;
        expect(ids.has(ref), `${t.id} → ${ref}`).toBe(true);
      }
    }
    expect(refs).toBe(ANOMALY_SPECS.possible_duplicate.count + ANOMALY_SPECS.cancel_negative.count);
  });

  it('모든 거래처가 들어가고 거래처 정보가 붙어 있다', () => {
    expect(Object.keys(golden.expected.byClient).sort()).toEqual(ds.clients.map((c) => c.code).sort());
    for (const it of golden.items) {
      const c = ds.clients.find((x) => x.code === it.clientCode)!;
      expect(it).toMatchObject({ industry: c.industry, clientVatType: c.vatType, clientBusinessType: c.businessType });
      expect(it.clientNonDeductibleVehicles).toEqual(c.nonDeductibleVehicles);
    }
  });

  it('기대 분포 = 정답에서 계산한 값 = 고정값 GOLDEN_EXPECTED', () => {
    expect(computeGoldenExpected(golden.items)).toEqual(golden.expected);
    // 이 단언이 깨지면: 생성기가 바뀐 것. 의도한 변경이면 golden.expected / golden.checksum 으로 expected.ts 를 갱신한다.
    expect(golden.expected).toEqual(GOLDEN_EXPECTED);
    expect(golden.checksum).toBe(GOLDEN_CHECKSUM);
    expect(verifyGoldenDataset(golden)).toEqual({ ok: true, problems: [] });
  });

  it('기대 분포의 내부 합이 맞다', () => {
    const e = GOLDEN_EXPECTED;
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    for (const r of [e.byDirection, e.byEvidence, e.byClient, e.byAccount, e.byVatType]) expect(sum(r)).toBe(e.size);
    expect(e.purchaseVat.deductible + e.purchaseVat.nonDeductible).toBe(e.byDirection['purchase']);
    expect(sum(e.nonDeductibleByReason)).toBe(e.purchaseVat.nonDeductible);
    // 부가세 공제/불공제 모두 의미 있는 비중
    expect(e.purchaseVat.nonDeductible).toBeGreaterThan(50);
  });

  it('결정적: 다시 만들어도 같은 체크섬, 선택 함수 단독 호출과 일치', () => {
    expect(goldenChecksum(buildGoldenDataset({ dataset: ds }).items)).toBe(golden.checksum);
    expect(selectGoldenTransactions(ds).map((t) => t.id)).toEqual(golden.items.map((i) => i.id));
  });

  it('다른 seed 데이터셋은 거부, 필수 거래가 크기보다 많으면 오류', () => {
    expect(() => buildGoldenDataset({ dataset: { ...ds, seed: 1 } })).toThrow();
    expect(() => selectGoldenTransactions(ds, 10)).toThrow();
  });

  it('verifyGoldenDataset 은 변조를 잡는다', () => {
    const tampered = { ...golden, items: golden.items.slice(1), checksum: 'x' };
    const r = verifyGoldenDataset(tampered);
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThanOrEqual(2);
  });
});
