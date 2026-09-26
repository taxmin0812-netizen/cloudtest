import { sha256Hex, type BusinessType, type IndustryKey, type VatTaxpayerType, type Won } from '@mintax/core';
import { checksumOf } from '../generator/canonical';
import { CURRENT_MONTH, DEFAULT_SEED, generateDataset, type SyntheticDataset, type SyntheticTransaction } from '../generator/index';
import { GOLDEN_CHECKSUM, GOLDEN_EXPECTED } from './expected';

export { GOLDEN_CHECKSUM, GOLDEN_EXPECTED } from './expected';
export { canonicalJson, checksumOf } from '../generator/canonical';

/**
 * 골든 데이터셋 — 엔진 회귀 검사용 고정 1,000건 원장.
 *
 * 비교 러너(엔진 출력 vs 정답)는 별도로 작성된다. 여기서는 데이터 + 기대 분포 + 체크섬만 제공한다.
 * 생성기를 바꾸면 GOLDEN_EXPECTED / GOLDEN_CHECKSUM 이 달라져 테스트가 실패한다 — 의도한 변경이면 expected.ts 를 함께 갱신한다.
 */
export const GOLDEN_SPEC = {
  version: 2,
  seed: DEFAULT_SEED,
  period: CURRENT_MONTH,
  size: 1000,
  selection:
    '2026-09 당월 거래 중 완전중복(기대 상태 duplicate)은 제외한다. 이상치·시나리오 표식이 있는 거래와 ' +
    '그 거래가 참조하는 원거래(중복 의심 상대·취소 원거래)는 모두 넣고, ' +
    '나머지는 거래처별 거래 수에 비례해(최대잔여법) 채운다. 거래처 안에서는 sha256(seed|golden|id) 오름차순으로 고르고, 최종 순서는 id 오름차순이다.',
} as const;

export interface GoldenItem {
  id: string;
  clientCode: string;
  industry: IndustryKey;
  clientVatType: VatTaxpayerType;
  clientBusinessType: BusinessType;
  clientNonDeductibleVehicles: string[];
  /** 입력 거래 + 정답(truth). 러너는 truth 를 떼고 엔진에 넣는다 */
  transaction: SyntheticTransaction;
}

export interface GoldenExpected {
  size: number;
  byDirection: Record<string, number>;
  byEvidence: Record<string, number>;
  byClient: Record<string, number>;
  /** 정답 계정코드별 건수 */
  byAccount: Record<string, number>;
  /** 매입 거래의 공제/불공제 정답 건수 */
  purchaseVat: { deductible: number; nonDeductible: number };
  /** 정답 부가세 유형별 건수 (매입·매출 전체) */
  byVatType: Record<string, number>;
  /** 매입 불공제 사유별 건수 ('없음' = 부가세 자체가 없는 불공제: 해외·면세·세액 0) */
  nonDeductibleByReason: Record<string, number>;
  byAnomaly: Record<string, number>;
  anomalyTransactions: number;
  scenarioTransactions: number;
  totals: { supplyAmount: Won; vatAmount: Won; totalAmount: Won };
}

export interface GoldenDataset {
  spec: typeof GOLDEN_SPEC;
  items: GoldenItem[];
  expected: GoldenExpected;
  checksum: string;
}

function inc(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function sortedRecord(rec: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]!]));
}

/** 골든 항목 선택 (결정적) */
export function selectGoldenTransactions(ds: SyntheticDataset, size: number = GOLDEN_SPEC.size): SyntheticTransaction[] {
  const eligible = ds.current.filter((t) => t.truth.expectedStatus !== 'duplicate');
  const flagged = eligible.filter((t) => t.anomalies.length > 0 || t.scenarioTags.length > 0);
  // 중복 의심·취소는 원거래가 같은 배치에 있어야 판정할 수 있다 → 원거래도 필수
  const referenced = new Set(flagged.flatMap((t) => [t.truth.possibleDuplicateOf, t.truth.cancelOf]).filter((x): x is string => !!x));
  const mandatory = eligible.filter((t) => t.anomalies.length > 0 || t.scenarioTags.length > 0 || referenced.has(t.id));
  const eligibleIds = new Set(eligible.map((t) => t.id));
  for (const id of referenced) if (!eligibleIds.has(id)) throw new Error(`골든 필수 원거래 ${id} 가 당월 거래에 없습니다`);
  if (mandatory.length > size) throw new Error(`필수 골든 거래(${mandatory.length})가 크기(${size})보다 많습니다`);
  const mandatoryIds = new Set(mandatory.map((t) => t.id));
  const rest = eligible.filter((t) => !mandatoryIds.has(t.id));
  if (rest.length < size - mandatory.length) throw new Error('골든 데이터셋을 채울 거래가 부족합니다');

  const byClient = new Map<string, SyntheticTransaction[]>();
  for (const t of rest) {
    const arr = byClient.get(t.clientCode) ?? [];
    arr.push(t);
    byClient.set(t.clientCode, arr);
  }
  // 최대잔여법 비례 배분
  const remaining = size - mandatory.length;
  const codes = ds.clients.map((c) => c.code).filter((c) => byClient.has(c));
  const quotas = codes.map((code) => {
    const exact = (remaining * byClient.get(code)!.length) / rest.length;
    return { code, base: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let left = remaining - quotas.reduce((a, q) => a + q.base, 0);
  const byFrac = [...quotas].sort((a, b) => b.frac - a.frac || (a.code < b.code ? -1 : 1));
  for (const q of byFrac) {
    if (left <= 0) break;
    q.base += 1;
    left -= 1;
  }
  const picked: SyntheticTransaction[] = [...mandatory];
  for (const q of quotas) {
    const keyed = byClient
      .get(q.code)!
      .map((t) => ({ t, k: sha256Hex(`${ds.seed}|golden|${t.id}`) }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    picked.push(...keyed.slice(0, q.base).map((x) => x.t));
  }
  return picked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function computeGoldenExpected(items: readonly GoldenItem[]): GoldenExpected {
  const byDirection: Record<string, number> = {};
  const byEvidence: Record<string, number> = {};
  const byClient: Record<string, number> = {};
  const byAccount: Record<string, number> = {};
  const byVatType: Record<string, number> = {};
  const nonDeductibleByReason: Record<string, number> = {};
  const byAnomaly: Record<string, number> = {};
  const purchaseVat = { deductible: 0, nonDeductible: 0 };
  const totals = { supplyAmount: 0, vatAmount: 0, totalAmount: 0 };
  let anomalyTransactions = 0;
  let scenarioTransactions = 0;
  for (const { transaction: t } of items) {
    inc(byDirection, t.direction);
    inc(byEvidence, `${t.direction}:${t.evidenceType}`);
    inc(byClient, t.clientCode);
    inc(byAccount, t.truth.accountCode);
    inc(byVatType, t.truth.vatType);
    if (t.direction === 'purchase') {
      if (t.truth.deductible) purchaseVat.deductible += 1;
      else {
        purchaseVat.nonDeductible += 1;
        inc(nonDeductibleByReason, t.truth.nonDeductibleReasonCode ?? '없음');
      }
    }
    for (const a of t.anomalies) inc(byAnomaly, a);
    if (t.anomalies.length > 0) anomalyTransactions += 1;
    if (t.scenarioTags.length > 0) scenarioTransactions += 1;
    totals.supplyAmount += t.supplyAmount;
    totals.vatAmount += t.vatAmount;
    totals.totalAmount += t.totalAmount;
  }
  return {
    size: items.length,
    byDirection: sortedRecord(byDirection),
    byEvidence: sortedRecord(byEvidence),
    byClient: sortedRecord(byClient),
    byAccount: sortedRecord(byAccount),
    purchaseVat,
    byVatType: sortedRecord(byVatType),
    nonDeductibleByReason: sortedRecord(nonDeductibleByReason),
    byAnomaly: sortedRecord(byAnomaly),
    anomalyTransactions,
    scenarioTransactions,
    totals,
  };
}

/** 골든 항목 체크섬 — sha256Hex(canonical JSON) */
export function goldenChecksum(items: readonly GoldenItem[]): string {
  return checksumOf(items);
}

/**
 * 골든 데이터셋 생성. 이미 만든 데이터셋을 넘기면 재생성하지 않는다 (같은 seed 여야 한다).
 */
export function buildGoldenDataset(opts: { dataset?: SyntheticDataset } = {}): GoldenDataset {
  const ds = opts.dataset ?? generateDataset({ seed: GOLDEN_SPEC.seed });
  if (ds.seed !== GOLDEN_SPEC.seed) throw new Error(`골든 데이터셋은 seed ${GOLDEN_SPEC.seed} 로만 만듭니다 (받은 값: ${ds.seed})`);
  const clientByCode = new Map(ds.clients.map((c) => [c.code, c]));
  const items: GoldenItem[] = selectGoldenTransactions(ds).map((t) => {
    const c = clientByCode.get(t.clientCode)!;
    return {
      id: t.id,
      clientCode: t.clientCode,
      industry: c.industry,
      clientVatType: c.vatType,
      clientBusinessType: c.businessType,
      clientNonDeductibleVehicles: [...c.nonDeductibleVehicles],
      transaction: t,
    };
  });
  return { spec: GOLDEN_SPEC, items, expected: computeGoldenExpected(items), checksum: goldenChecksum(items) };
}

/** 골든 데이터셋이 고정 기대값과 같은가 (회귀 러너의 사전 점검용) */
export function verifyGoldenDataset(g: GoldenDataset): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (g.items.length !== GOLDEN_SPEC.size) problems.push(`건수 ${g.items.length} ≠ ${GOLDEN_SPEC.size}`);
  if (checksumOf(g.expected) !== checksumOf(GOLDEN_EXPECTED)) problems.push('기대 분포가 GOLDEN_EXPECTED 와 다릅니다');
  if (g.checksum !== GOLDEN_CHECKSUM) problems.push(`체크섬 불일치: ${g.checksum} ≠ ${GOLDEN_CHECKSUM}`);
  return { ok: problems.length === 0, problems };
}
