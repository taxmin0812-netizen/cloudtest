import type { AccountCode, CorrectionRecord, Direction, HistoryEntry, LocalDate, UUID, Won } from '../types';
import { accountDirection, isAccountCompatible } from '../data/accounts';

/**
 * 과거 처리 이력(HistoryEntry) 인덱스·집계 도우미.
 * 모두 순수 함수이며, 입력 배열 순서와 무관하게 같은 결과를 낸다(결정성).
 */

/**
 * 계약 타입(HistoryEntry·CorrectionRecord)에는 매입/매출 구분이 없다.
 * 호출자(서버)가 transactions.direction 을 조인해 넘겨주면 엔진은 이를 엄격히 적용하고,
 * 없으면 계정 성격으로 추정한다(자산·부채 계정은 추정 불가 → 자동승인 제한).
 */
export type DirectedHistoryEntry = HistoryEntry & { direction?: Direction | null };
export type DirectedCorrectionRecord = CorrectionRecord & { direction?: Direction | null };

// ────────────────────────────── 날짜 ──────────────────────────────

const DAY_MS = 86_400_000;

const OFFSET_RE = /(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * ISO 시각 → epoch ms. 시간대 표기가 없는 시각('2026-09-05T10:00:00', '2026-09-05 10:00:00')과
 * 날짜만 있는 값은 KST(+09:00)로 해석한다 — 실행 머신의 시간대에 따라 결과가 달라지지 않도록.
 */
export function parseInstant(iso: string): number {
  const s = String(iso ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00+09:00`);
  const t = s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  if (/T\d{2}:\d{2}/.test(t) && !OFFSET_RE.test(t)) return Date.parse(`${t}+09:00`);
  return Date.parse(t);
}

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
  const t = parseInstant(iso);
  if (Number.isNaN(t)) return String(iso ?? '').slice(0, 10);
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
  byBizno: Map<string, DirectedHistoryEntry[]>;
  /** clientId|k:merchantKey → 이력 (날짜 오름차순) */
  byKey: Map<string, DirectedHistoryEntry[]>;
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
export function buildHistoryIndex(entries: readonly DirectedHistoryEntry[]): HistoryIndex {
  const byBizno = new Map<string, DirectedHistoryEntry[]>();
  const byKey = new Map<string, DirectedHistoryEntry[]>();
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
  byBizno: Map<string, DirectedHistoryEntry[]>;
  byKey: Map<string, DirectedHistoryEntry[]>;
}

export function buildMerchantIndex(entries: readonly DirectedHistoryEntry[]): MerchantIndex {
  const byBizno = new Map<string, DirectedHistoryEntry[]>();
  const byKey = new Map<string, DirectedHistoryEntry[]>();
  for (const e of entries) {
    if (e.merchantBusinessNumber) pushTo(byBizno, biznoKey(e.merchantBusinessNumber), e);
    if (e.merchantKey) pushTo(byKey, merchantNameKey(e.merchantKey), e);
  }
  return { byBizno, byKey };
}

/** 사업자번호 또는 상호키가 일치하는 항목 (중복 제거, 순서 무관) */
export function lookupMerchant(index: MerchantIndex, ref: MerchantRef): DirectedHistoryEntry[] {
  const a = ref.merchantBusinessNumber ? index.byBizno.get(biznoKey(ref.merchantBusinessNumber)) : undefined;
  const b = ref.merchantKey ? index.byKey.get(merchantNameKey(ref.merchantKey)) : undefined;
  if (!a) return b ? [...b] : [];
  if (!b) return [...a];
  const set = new Set<DirectedHistoryEntry>(a);
  for (const e of b) set.add(e);
  return [...set];
}

/**
 * 거래 방향과 양립하는 이력만.
 * 이력에 direction 이 있으면 그것을 엄격히 따르고, 없으면 계정 성격(매입에 수익 계정 불가 등)으로 거른다.
 */
export function filterCompatible<T extends DirectedHistoryEntry>(
  entries: readonly T[],
  direction: Direction,
  accounts: ReadonlyMap<string, AccountCode>,
): T[] {
  return entries.filter((e) => (!e.direction || e.direction === direction) && isAccountCompatible(e.accountCode, direction, accounts));
}

/** 방향 근거 수: 명시 direction, 없으면 계정 성격(비용·원가=매입, 수익=매출). 자산·부채 계정은 세지 않는다 */
export interface DirectionSignals {
  purchase: number;
  sales: number;
}

export function countDirectionSignals(
  items: Iterable<{ direction?: Direction | null; accountCode: string }>,
  accounts: ReadonlyMap<string, AccountCode>,
): DirectionSignals {
  const s: DirectionSignals = { purchase: 0, sales: 0 };
  for (const e of items) {
    const d = e.direction ?? accountDirection(e.accountCode, accounts);
    if (d === 'purchase') s.purchase += 1;
    else if (d === 'sales') s.sales += 1;
  }
  return s;
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
export function applyCorrectionPriority<T extends HistoryEntry>(
  sortedEntries: readonly T[],
  point: CorrectionPoint | null,
  majorityAccountCode: string | null,
): { effective: T[]; superseded: T[] } {
  if (!point || !majorityAccountCode || majorityAccountCode === point.accountCode) {
    return { effective: [...sortedEntries], superseded: [] };
  }
  const effective: T[] = [];
  const superseded: T[] = [];
  for (const e of sortedEntries) (e.transactionDate >= point.date ? effective : superseded).push(e);
  return { effective, superseded };
}

// ────────────────────────────── 수정 기록 인덱스 ──────────────────────────────

export interface CorrectionIndex {
  byBizno: Map<string, DirectedCorrectionRecord[]>;
  byKey: Map<string, DirectedCorrectionRecord[]>;
}

/** 계정(field='account') 수정 중 실제 변경된 것만 색인 */
export function buildCorrectionIndex(corrections: readonly DirectedCorrectionRecord[], clientId: UUID): CorrectionIndex {
  const byBizno = new Map<string, DirectedCorrectionRecord[]>();
  const byKey = new Map<string, DirectedCorrectionRecord[]>();
  for (const c of corrections) {
    if (c.clientId !== clientId || c.field !== 'account' || !c.after || c.after === c.before) continue;
    if (c.merchantBusinessNumber) pushTo(byBizno, biznoKey(c.merchantBusinessNumber), c);
    if (c.merchantKey) pushTo(byKey, merchantNameKey(c.merchantKey), c);
  }
  return { byBizno, byKey };
}

/** 상대방과 관련된 수정 기록. 양쪽 사업자번호가 모두 있고 다르면 다른 상대방으로 본다. */
export function lookupCorrections(index: CorrectionIndex, ref: MerchantRef): DirectedCorrectionRecord[] {
  const out = new Set<DirectedCorrectionRecord>();
  if (ref.merchantBusinessNumber) for (const c of index.byBizno.get(biznoKey(ref.merchantBusinessNumber)) ?? []) out.add(c);
  if (ref.merchantKey) {
    for (const c of index.byKey.get(merchantNameKey(ref.merchantKey)) ?? []) {
      if (ref.merchantBusinessNumber && c.merchantBusinessNumber && c.merchantBusinessNumber !== ref.merchantBusinessNumber) continue;
      out.add(c);
    }
  }
  return [...out].sort(compareCorrection);
}

/**
 * 거래 1건당 가장 최근 수정만 남긴다 (정렬: 수정 시각 오름차순).
 * 같은 거래를 여러 번 고친 것은 "반복 수정"이 아니며, 되돌린 수정은 최종값만 의미가 있다.
 */
export function latestCorrectionPerTransaction<T extends CorrectionRecord>(records: readonly T[]): T[] {
  const m = new Map<string, T>();
  for (const c of records) {
    const k = `${c.clientId}|${c.transactionId}`;
    const prev = m.get(k);
    if (!prev || compareCorrection(c, prev) > 0) m.set(k, c);
  }
  return [...m.values()].sort(compareCorrection);
}

/** 수정 시각 오름차순 (동시각은 거래ID·수정값으로 결정) */
export function compareCorrection(a: CorrectionRecord, b: CorrectionRecord): number {
  const ta = parseInstant(a.createdAt);
  const tb = parseInstant(b.createdAt);
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.transactionId !== b.transactionId) return a.transactionId < b.transactionId ? -1 : 1;
  return a.after < b.after ? -1 : a.after > b.after ? 1 : 0;
}
