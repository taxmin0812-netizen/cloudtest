import type { AccountCode, CorrectionRecord, Direction, HistoryEntry, LocalDate, UUID, Won } from '../types';
import { isAccountCompatible } from '../data/accounts';

/**
 * 과거 처리 이력(HistoryEntry) 인덱스·집계 도우미.
 * 모두 순수 함수이며, 입력 배열 순서와 무관하게 같은 결과를 낸다(결정성).
 */

// ────────────────────────────── 날짜 ──────────────────────────────

const DAY_MS = 86_400_000;

function dateToUtcMs(date: LocalDate): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}

/** to − from (일). 형식 오류면 0 */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const a = dateToUtcMs(from);
  const b = dateToUtcMs(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

/** ISO 시각 → KST 기준 'YYYY-MM-DD' (수정 시각 비교용) */
export function isoToKstDate(iso: string): LocalDate {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  return new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 최근성 가중치: 반감기(halfLifeDays)마다 절반. 기준일 이후(미래) 이력은 1.
 * asOf 가 없으면 가중치 없음(1).
 */
export function recencyWeight(date: LocalDate, asOf: LocalDate | null, halfLifeDays: number): number {
  if (!asOf || halfLifeDays <= 0) return 1;
  const age = daysBetween(date, asOf);
  if (age <= 0) return 1;
  return Math.pow(0.5, age / halfLifeDays);
}

// ────────────────────────────── 인덱스 ──────────────────────────────

export type MerchantRef = { merchantBusinessNumber: string | null; merchantKey: string };

/** 상대방 식별 키: 사업자번호 'b:1234567890' / 상호키 'k:쿠팡' */
export function biznoKey(bizno: string): string {
  return `b:${bizno}`;
}
export function merchantNameKey(merchantKey: string): string {
  return `k:${merchantKey}`;
}
/** 거래처 + 상대방 키 (학습 키 = client_id + merchant) */
export function historyKey(clientId: UUID, merchantRef: string): string {
  return `${clientId}|${merchantRef}`;
}

export interface HistoryIndex {
  /** clientId|b:bizno → 이력 (날짜 오름차순) */
  byBizno: Map<string, HistoryEntry[]>;
  /** clientId|k:merchantKey → 이력 (날짜 오름차순) */
  byKey: Map<string, HistoryEntry[]>;
  size: number;
}

/** 결정적 정렬: 일자 → 계정 → 금액 → 수정여부 */
export function compareHistory(a: HistoryEntry, b: HistoryEntry): number {
  if (a.transactionDate !== b.transactionDate) return a.transactionDate < b.transactionDate ? -1 : 1;
  if (a.accountCode !== b.accountCode) return a.accountCode < b.accountCode ? -1 : 1;
  if (a.totalAmount !== b.totalAmount) return a.totalAmount - b.totalAmount;
  if (a.corrected !== b.corrected) return a.corrected ? 1 : -1;
  return 0;
}

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/** 거래처별 이력 인덱스 (사업자번호·상호키 각각). 빈 상호키는 색인하지 않는다. */
export function buildHistoryIndex(entries: readonly HistoryEntry[]): HistoryIndex {
  const byBizno = new Map<string, HistoryEntry[]>();
  const byKey = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    if (e.merchantBusinessNumber) pushTo(byBizno, historyKey(e.clientId, biznoKey(e.merchantBusinessNumber)), e);
    if (e.merchantKey) pushTo(byKey, historyKey(e.clientId, merchantNameKey(e.merchantKey)), e);
  }
  for (const arr of byBizno.values()) arr.sort(compareHistory);
  for (const arr of byKey.values()) arr.sort(compareHistory);
  return { byBizno, byKey, size: entries.length };
}

/** 거래처 구분 없는 상대방 인덱스 (업종 패턴용) */
export interface MerchantIndex {
  byBizno: Map<string, HistoryEntry[]>;
  byKey: Map<string, HistoryEntry[]>;
}

export function buildMerchantIndex(entries: readonly HistoryEntry[]): MerchantIndex {
  const byBizno = new Map<string, HistoryEntry[]>();
  const byKey = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    if (e.merchantBusinessNumber) pushTo(byBizno, biznoKey(e.merchantBusinessNumber), e);
    if (e.merchantKey) pushTo(byKey, merchantNameKey(e.merchantKey), e);
  }
  return { byBizno, byKey };
}

/** 사업자번호 또는 상호키가 일치하는 항목 (중복 제거, 순서 무관) */
export function lookupMerchant(index: MerchantIndex, ref: MerchantRef): HistoryEntry[] {
  const a = ref.merchantBusinessNumber ? index.byBizno.get(biznoKey(ref.merchantBusinessNumber)) : undefined;
  const b = ref.merchantKey ? index.byKey.get(merchantNameKey(ref.merchantKey)) : undefined;
  if (!a) return b ? [...b] : [];
  if (!b) return [...a];
  const set = new Set<HistoryEntry>(a);
  for (const e of b) set.add(e);
  return [...set];
}

/** 거래 방향과 양립하는 계정의 이력만 */
export function filterCompatible(
  entries: readonly HistoryEntry[],
  direction: Direction,
  accounts: ReadonlyMap<string, AccountCode>,
): HistoryEntry[] {
  return entries.filter((e) => isAccountCompatible(e.accountCode, direction, accounts));
}

// ────────────────────────────── 집계 ──────────────────────────────

export interface AccountTally {
  accountCode: string;
  accountName: string;
  count: number;
  /** 최근성 × 수정 가중 합 */
  weight: number;
  correctedCount: number;
  lastUsedDate: LocalDate;
}

export interface HistoryStats {
  total: number;
  /** 가중치 내림차순 → 최근 사용일 내림차순 → 코드 오름차순 */
  tallies: AccountTally[];
  dominant: AccountTally | null;
  /** dominant 계정 건수 */
  consistentCount: number;
  /** consistentCount / total */
  ratio: number;
  lastUsedDate: LocalDate | null;
  /** |합계금액| 평균 (원 단위 반올림) */
  averageAmount: Won | null;
  correctedCount: number;
}

export interface TallyOptions {
  asOfDate: LocalDate | null;
  halfLifeDays: number;
  /** 사람이 수정해 확정한 이력의 가중 배수 */
  correctedWeight: number;
}

export const DEFAULT_TALLY_OPTIONS: TallyOptions = { asOfDate: null, halfLifeDays: 365, correctedWeight: 3 };

export function compareTally(a: AccountTally, b: AccountTally): number {
  if (Math.abs(a.weight - b.weight) > 1e-9) return b.weight - a.weight;
  if (a.lastUsedDate !== b.lastUsedDate) return a.lastUsedDate > b.lastUsedDate ? -1 : 1;
  if (a.count !== b.count) return b.count - a.count;
  return a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0;
}

/** 계정별 건수·가중치 집계. dominant = 가중치 최대 계정 (최근·수정 이력이 오래된 미수정 이력보다 무겁다) */
export function tallyHistory(entries: readonly HistoryEntry[], opts: TallyOptions = DEFAULT_TALLY_OPTIONS): HistoryStats {
  const m = new Map<string, AccountTally>();
  let amountSum = 0;
  let lastUsed: LocalDate | null = null;
  let corrected = 0;
  for (const e of entries) {
    const w = recencyWeight(e.transactionDate, opts.asOfDate, opts.halfLifeDays) * (e.corrected ? opts.correctedWeight : 1);
    let t = m.get(e.accountCode);
    if (!t) {
      t = { accountCode: e.accountCode, accountName: e.accountName, count: 0, weight: 0, correctedCount: 0, lastUsedDate: e.transactionDate };
      m.set(e.accountCode, t);
    }
    t.count += 1;
    t.weight += w;
    if (e.corrected) t.correctedCount += 1;
    if (e.transactionDate >= t.lastUsedDate) {
      t.lastUsedDate = e.transactionDate;
      t.accountName = e.accountName || t.accountName;
    }
    amountSum += Math.abs(e.totalAmount);
    if (lastUsed === null || e.transactionDate > lastUsed) lastUsed = e.transactionDate;
    if (e.corrected) corrected += 1;
  }
  const tallies = [...m.values()].sort(compareTally);
  const dominant = tallies[0] ?? null;
  const total = entries.length;
  return {
    total,
    tallies,
    dominant,
    consistentCount: dominant?.count ?? 0,
    ratio: total > 0 && dominant ? dominant.count / total : 0,
    lastUsedDate: lastUsed,
    averageAmount: total > 0 ? Math.round(amountSum / total) : null,
    correctedCount: corrected,
  };
}

/** 가중 다수 계정 */
export function dominantAccount(entries: readonly HistoryEntry[], opts: TallyOptions = DEFAULT_TALLY_OPTIONS): AccountTally | null {
  return tallyHistory(entries, opts).dominant;
}

/** 특정 계정의 일관성 */
export function consistency(entries: readonly HistoryEntry[], accountCode: string): { count: number; total: number; ratio: number } {
  let count = 0;
  for (const e of entries) if (e.accountCode === accountCode) count += 1;
  const total = entries.length;
  return { count, total, ratio: total > 0 ? count / total : 0 };
}

// ────────────────────────────── 수정 우선 원칙 ──────────────────────────────

/** 사람 수정의 기준점: 이 날짜(포함) 이후 이력만 유효 */
export interface CorrectionPoint {
  date: LocalDate;
  accountCode: string;
}

/** 이력 안의 가장 최근 수정 확정 항목 */
export function latestCorrectedEntry(entries: readonly HistoryEntry[]): HistoryEntry | null {
  let best: HistoryEntry | null = null;
  for (const e of entries) {
    if (!e.corrected) continue;
    if (!best || compareHistory(e, best) > 0) best = e;
  }
  return best;
}

/** 건수 기준 최다 계정 (동률은 최근 사용일 → 코드) */
export function majorityAccountByCount(entries: readonly HistoryEntry[]): string | null {
  const m = new Map<string, { count: number; last: LocalDate }>();
  for (const e of entries) {
    const t = m.get(e.accountCode);
    if (!t) m.set(e.accountCode, { count: 1, last: e.transactionDate });
    else {
      t.count += 1;
      if (e.transactionDate > t.last) t.last = e.transactionDate;
    }
  }
  let best: string | null = null;
  let bc = -1;
  let bl = '';
  for (const [code, t] of m) {
    if (t.count > bc || (t.count === bc && (t.last > bl || (t.last === bl && best !== null && code < best)))) {
      best = code;
      bc = t.count;
      bl = t.last;
    }
  }
  return best;
}

/**
 * 수정 우선 원칙: 가장 최근 사람 수정이 전체 이력의 과반(건수 최다) 계정과 다르면,
 * 수정 기준일(포함) 이후 이력만 유효로 본다. 옛 이력이 새 수정을 이겨서 같은 실수를 반복하는 일을 막는다.
 */
export function applyCorrectionPriority(
  sortedEntries: readonly HistoryEntry[],
  point: CorrectionPoint | null,
  majorityAccountCode: string | null,
): { effective: HistoryEntry[]; superseded: HistoryEntry[] } {
  if (!point || !majorityAccountCode || majorityAccountCode === point.accountCode) {
    return { effective: [...sortedEntries], superseded: [] };
  }
  const effective: HistoryEntry[] = [];
  const superseded: HistoryEntry[] = [];
  for (const e of sortedEntries) (e.transactionDate >= point.date ? effective : superseded).push(e);
  return { effective, superseded };
}

// ────────────────────────────── 수정 기록 인덱스 ──────────────────────────────

export interface CorrectionIndex {
  byBizno: Map<string, CorrectionRecord[]>;
  byKey: Map<string, CorrectionRecord[]>;
}

/** 계정(field='account') 수정 중 실제 변경된 것만 색인 */
export function buildCorrectionIndex(corrections: readonly CorrectionRecord[], clientId: UUID): CorrectionIndex {
  const byBizno = new Map<string, CorrectionRecord[]>();
  const byKey = new Map<string, CorrectionRecord[]>();
  for (const c of corrections) {
    if (c.clientId !== clientId || c.field !== 'account' || !c.after || c.after === c.before) continue;
    if (c.merchantBusinessNumber) pushTo(byBizno, biznoKey(c.merchantBusinessNumber), c);
    if (c.merchantKey) pushTo(byKey, merchantNameKey(c.merchantKey), c);
  }
  return { byBizno, byKey };
}

/** 상대방과 관련된 수정 기록. 양쪽 사업자번호가 모두 있고 다르면 다른 상대방으로 본다. */
export function lookupCorrections(index: CorrectionIndex, ref: MerchantRef): CorrectionRecord[] {
  const out = new Set<CorrectionRecord>();
  if (ref.merchantBusinessNumber) for (const c of index.byBizno.get(biznoKey(ref.merchantBusinessNumber)) ?? []) out.add(c);
  if (ref.merchantKey) {
    for (const c of index.byKey.get(merchantNameKey(ref.merchantKey)) ?? []) {
      if (ref.merchantBusinessNumber && c.merchantBusinessNumber && c.merchantBusinessNumber !== ref.merchantBusinessNumber) continue;
      out.add(c);
    }
  }
  return [...out].sort(compareCorrection);
}

/** 수정 시각 오름차순 (동시각은 거래ID·수정값으로 결정) */
export function compareCorrection(a: CorrectionRecord, b: CorrectionRecord): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.transactionId !== b.transactionId) return a.transactionId < b.transactionId ? -1 : 1;
  return a.after < b.after ? -1 : a.after > b.after ? 1 : 0;
}
