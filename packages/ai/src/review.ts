import {
  normalizeMerchantName,
  previousYearMonth,
  type EvidenceType,
  type ExceptionBucket,
  type IndustryKey,
  type LedgerAnomaly,
  type RiskSeverity,
  type UUID,
  type Won,
  type YearMonth,
} from '@mintax/core';
import { buildAccountMap, DEFAULT_ACCOUNT_CODES } from '@mintax/core/data/accounts';
import { EVIDENCE_TYPE_LABELS } from './explain';
import { changeRatePercent, formatCount, formatManwon, formatPp, formatRate, formatRatio, round1 } from './format';
import type {
  AnomalyInput,
  LedgerReviewInput,
  MetricSeries,
  MonthlyLedgerSummary,
  SourceCountKey,
  SourceCounts,
  VatPeriodReviewInput,
} from './types';

/**
 * Smart Tax Review Agent — 결정적(deterministic) 장부 검토 규칙.
 *
 * 모든 임계값은 REVIEW_PARAMS 에 있다. 사무소 설정으로 덮어쓸 때는 mergeReviewParams() 를 쓴다.
 * 법정 기준(즉시상각 100만원 등)은 docs/research/04 근거, 그 외 비율·금액 기준은 실무 기본값 [검증필요 — 사무소 조정].
 * metric.changeRate 는 % 단위 (47 = +47%).
 */

export interface NewAccountFollowUp {
  /** 상세 문구 뒤에 붙는 확인 요청 */
  check: string;
  actionLabel: string;
  bucket?: ExceptionBucket;
  severity?: RiskSeverity;
  /** Inbox 대신 이동할 경로 (예: 급여 화면). {clientId} {period} 치환 */
  hrefTemplate?: string;
}

export const REVIEW_PARAMS = {
  /** 전월 대비 매출/매입 */
  totals: {
    /** 전월 금액이 이 미만이면 증감률 판단 생략 (소액 노이즈) */
    minBaseline: 1_000_000,
    /** 매입 +30% 이상이면서 매출 증가율보다 divergenceGap 이상 크면 '매입 급증 확인' */
    purchaseSpikeRate: 30,
    /** 매출 +50% 이상이면서 매입 증가율보다 divergenceGap 이상 크면 '매출 급증 확인' (매입 증빙 누락 의심) */
    salesSpikeRate: 50,
    divergenceGap: 20,
    /** 매출 -30% 이하 → 매출 누락 확인 */
    salesDropRate: -30,
    /** 매입 -40% 이하 → 매입 증빙 누락 확인 */
    purchaseDropRate: -40,
    /** 증가율이 이 이상이면 high */
    highRate: 100,
    /** 매출 감소율이 이 이하이면 high */
    highDropRate: -60,
  },
  /** 계정별 최근 N개월 평균 대비 이번 달 */
  accountSpike: {
    lookbackMonths: 3,
    /** 과거 월 요약이 최소 이만큼 있어야 판단 */
    minHistoryMonths: 1,
    /** 이번 달 ≥ 평균 × ratio */
    ratio: 2,
    highRatio: 3,
    /** 이번 달 금액 하한 */
    minAmount: 1_000_000,
    /** 평균 대비 증가액 하한 */
    minIncrease: 500_000,
    /** 대체·결제 계정 (월 합계 비교가 무의미) */
    excludeCodes: ['101', '102', '103', '108', '135', '251', '253', '254', '255'],
  },
  /** 신규 계정 등장 */
  newAccount: {
    /** 과거 몇 개월 안에 한 번도 없었으면 신규 */
    lookbackMonths: 12,
    /** 추정(newAccounts 미지정) 시 이번 달 금액 하한 */
    minAmount: 50_000,
    excludeCodes: ['101', '102', '103', '108', '135', '251', '253', '254', '255'],
    followUps: {
      '822': {
        check: '차량등록정보(차종·정원·배기량)를 확인하세요. 개별소비세 과세 승용차면 매입세액 불공제·운행기록부 대상입니다.',
        actionLabel: '차량 관련 거래 확인',
        bucket: 'vehicle',
        severity: 'warning',
      },
      '208': {
        check: '차량등록증(차종·정원)으로 업무용승용차 해당 여부와 감가상각 한도를 확인하세요.',
        actionLabel: '차량 취득 거래 확인',
        bucket: 'vehicle',
        severity: 'warning',
      },
      '813': {
        check: '3만원 초과 건의 적격증빙과 기업업무추진비 한도 관리 대상인지 확인하세요.',
        actionLabel: '접대 관련 거래 확인',
        bucket: 'entertainment',
        severity: 'warning',
      },
      '134': {
        check: '대표자 인출·업무무관 지출 여부와 인정이자 계산 대상인지 확인하세요.',
        actionLabel: '가지급금 거래 확인',
        bucket: 'personal_use',
        severity: 'high',
      },
      '338': {
        check: '사업과 무관한 지출(가사비용)인지 확인하세요.',
        actionLabel: '인출금 거래 확인',
        bucket: 'personal_use',
        severity: 'warning',
      },
      '819': {
        check: '임대차계약서와 세금계산서 수취 여부, 임차보증금 계상을 확인하세요.',
        actionLabel: '임차료 거래 확인',
        severity: 'info',
      },
      '801': {
        check: '인건비 신고(원천세·간이지급명세서) 대상자 등록 여부를 확인하세요.',
        actionLabel: '급여 화면 열기',
        severity: 'warning',
        hrefTemplate: '/payroll/{clientId}/{period}',
      },
      '805': {
        check: '일용근로소득 지급명세서 대상자(성명·식별번호) 등록 여부를 확인하세요.',
        actionLabel: '급여 화면 열기',
        severity: 'warning',
        hrefTemplate: '/payroll/{clientId}/{period}',
      },
      '951': {
        check: '차입 약정서와 차입금 계정 계상 여부를 확인하세요.',
        actionLabel: '이자비용 거래 확인',
        severity: 'info',
      },
      '953': {
        check: '기부금 영수증과 손금(필요경비) 한도 대상 여부를 확인하세요.',
        actionLabel: '기부금 거래 확인',
        severity: 'info',
      },
    } as Record<string, NewAccountFollowUp>,
    /** 고정자산 계정 기본 후속조치 */
    fixedAssetFollowUp: {
      check: '자산 계상·감가상각 대상인지와 부가세 신고 시 고정자산 매입 구분을 확인하세요.',
      actionLabel: '자산 거래 확인',
      bucket: 'possible_asset',
      severity: 'warning',
    } as NewAccountFollowUp,
    defaultFollowUp: {
      check: '계정 분류가 적정한지 확인하세요.',
      actionLabel: '거래 확인',
      severity: 'info',
    } as NewAccountFollowUp,
  },
  /** 위멤버스 원천 vs 처리 건수 */
  sourceGap: {
    /** 허용 차이 (건) */
    tolerance: 0,
    /** 이 이상 차이면 high */
    highGap: 10,
  },
  /** 부가세: 카드·현금영수증 매출 원천 vs 장부 반영 */
  vatSales: {
    /** 차이가 원천의 이 % 이상이고 */
    gapRate: 1,
    /** 이 금액 이상이면 판단 */
    minGap: 100_000,
    highGapRate: 10,
  },
  /** 부가세: 불공제 매입세액 비율 변화 */
  nonDeductible: {
    /** 직전 기간 대비 %p 변화 */
    deltaPp: 10,
    /** 이번 기간 매입세액 합계 하한 */
    minTotalVat: 100_000,
  },
  /** 부가세: 고정자산 매입 */
  fixedAsset: {
    /**
     * 자산 계정으로 계상된 매입은 금액과 무관하게 신고서 고정자산매입분 대상이다 (공급가액 절대값 기준 하한, 기본 1원).
     * 즉시상각(100만원)은 법인세·소득세 기준이라 여기서 거르지 않고 안내 문구로만 쓴다.
     */
    minSupply: 1,
    /** 즉시상각 가능 안내 기준 — 법인세법 시행령 제31조④, 소득세법 시행령 제67조④ (docs/research/04 §1.8) */
    immediateExpenseLimit: 1_000_000,
    /** 매입세액 합계가 이 이상이면 설비투자 조기환급 검토 문구 추가 [검증필요] */
    earlyRefundHintVat: 1_000_000,
  },
  /** 부가세: 의제매입세액공제 후보 */
  deemed: {
    /** 계산서 / 카드·현금영수증 면세분만 (시행령 제84조⑤) */
    evidenceTypes: ['invoice_exempt', 'card', 'cash_receipt'] as EvidenceType[],
    /** 면세 농·축·수·임산물 추정 키워드 [추론·검증필요] */
    keywords: [
      '농산물', '축산물', '수산물', '임산물', '정육', '축산', '한우', '한돈', '돼지고기', '소고기', '닭', '계육', '계란', '달걀',
      '채소', '야채', '청과', '과일', '쌀', '미곡', '잡곡', '곡물', '밀가루', '생선', '수산', '활어', '건어물', '마른김', '해조류', '미역', '멸치',
      '두부', '콩나물', '버섯', '소금', '농협', '수협', '축협', '하나로마트', '농산', '청과물', '공판장', '도매시장',
    ],
    /** 의제매입 대상 업종 추정 (설정이 꺼져 있으면 설정 확인 안내) */
    industries: ['restaurant', 'meat_restaurant', 'cafe', 'manufacturing'] as IndustryKey[],
    minAmount: 100_000,
  },
  /** 범용 시계열 급증 (detectAnomaly.series) */
  series: {
    lookbackMonths: 3,
    minHistoryMonths: 1,
    ratio: 2,
    highRatio: 3,
    minAmount: 1_000_000,
    minIncrease: 500_000,
  },
};

export type ReviewParams = typeof REVIEW_PARAMS;
export type ReviewParamsOverride = { [K in keyof ReviewParams]?: Partial<ReviewParams[K]> };

/**
 * 섹션 단위 얕은 병합 (followUps 는 키 단위 병합).
 * 사무소 설정(JSON)에서 온 값은 검증한다: 알 수 없는 섹션·키, undefined/null, 기본값과 타입이 다른 값
 * (숫자 자리에 문자열·NaN 등)은 무시하고 기본값을 유지한다 — 임계값이 NaN 이 되어 검사가 조용히 꺼지는 것을 막는다.
 */
export function mergeReviewParams(override?: ReviewParamsOverride): ReviewParams {
  if (!override) return REVIEW_PARAMS;
  const out = { ...REVIEW_PARAMS } as Record<string, unknown>;
  const defaults = REVIEW_PARAMS as unknown as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(override)) {
    const base = defaults[k];
    if (!base || !v || typeof v !== 'object') continue;
    const merged: Record<string, unknown> = { ...base };
    for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
      if (!(pk in base) || !isCompatibleParam(base[pk], pv)) continue;
      merged[pk] = pv;
    }
    if (k === 'newAccount' && isPlainObject((v as Record<string, unknown>).followUps)) {
      merged.followUps = { ...REVIEW_PARAMS.newAccount.followUps, ...((v as Record<string, unknown>).followUps as Record<string, NewAccountFollowUp>) };
    }
    out[k] = merged;
  }
  return out as ReviewParams;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCompatibleParam(base: unknown, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof base === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (Array.isArray(base)) return Array.isArray(value);
  if (isPlainObject(base)) return isPlainObject(value);
  return typeof value === typeof base;
}

// ────────────────────────────── 공통 ──────────────────────────────

const SEVERITY_RANK: Record<RiskSeverity, number> = { high: 0, warning: 1, info: 2 };

export function sortAnomalies(list: LedgerAnomaly[]): LedgerAnomaly[] {
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => SEVERITY_RANK[x.a.severity] - SEVERITY_RANK[y.a.severity] || x.i - y.i)
    .map((x) => x.a);
}

/** '/inbox?client=…&period=…&bucket=…' — 값이 없는 파라미터는 생략 */
export function reviewHref(path: string, params: Record<string, string | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

function inbox(clientId: UUID, period: YearMonth, extra: Record<string, string | undefined> = {}): string {
  return reviewHref('/inbox', { client: clientId, period, ...extra });
}

const ACCOUNT_MAP = buildAccountMap(DEFAULT_ACCOUNT_CODES);

function accountLabel(code: string, name?: string): string {
  const n = name || ACCOUNT_MAP.get(code)?.name || code;
  return `${n}(${code})`;
}

function isYearMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** period 기준 과거 n개월 목록 (가까운 달부터) */
export function priorMonths(period: YearMonth, n: number): YearMonth[] {
  const out: YearMonth[] = [];
  let p = period;
  for (let i = 0; i < n; i++) {
    p = previousYearMonth(p);
    out.push(p);
  }
  return out;
}

/** 월 요약 색인. 형식이 잘못된 항목은 건너뛰고 byAccount 누락은 빈 객체로 본다 (검토가 예외로 멈추지 않도록) */
function indexMonthly(monthly: MonthlyLedgerSummary[] | undefined): Map<YearMonth, MonthlyLedgerSummary> {
  const m = new Map<YearMonth, MonthlyLedgerSummary>();
  for (const s of monthly ?? []) {
    if (!s || typeof s.period !== 'string' || !isYearMonth(s.period)) continue;
    m.set(s.period, s.byAccount ? s : { ...s, byAccount: {} });
  }
  return m;
}

// ────────────────────────────── 1. 전월 대비 매출/매입 ──────────────────────────────

export function checkMonthlyTotals(input: LedgerReviewInput, params: ReviewParams = REVIEW_PARAMS): LedgerAnomaly[] {
  const p = params.totals;
  const byPeriod = indexMonthly(input.monthly);
  const cur = byPeriod.get(input.period);
  const prev = byPeriod.get(previousYearMonth(input.period));
  if (!cur || !prev) return [];
  const pr = prev.purchases >= p.minBaseline ? changeRatePercent(cur.purchases, prev.purchases) : null;
  const sr = prev.sales >= p.minBaseline ? changeRatePercent(cur.sales, prev.sales) : null;
  const out: LedgerAnomaly[] = [];
  const cid = input.clientId;
  const purchaseText = pr === null ? '' : `매입 ${formatRate(pr)} (${formatManwon(prev.purchases)} → ${formatManwon(cur.purchases)})`;
  const salesText = sr === null ? '매출은 전월 비교 불가' : `매출 ${formatRate(sr)} (${formatManwon(prev.sales)} → ${formatManwon(cur.sales)})`;

  if (pr !== null && pr >= p.purchaseSpikeRate && pr - (sr ?? 0) >= p.divergenceGap) {
    // 매출이 비교 불가(전월 소액·0)이면 '매출보다 N%p' 비교 문구를 만들지 않는다
    const divergence = sr === null ? '' : ` 매입 증가가 매출보다 ${formatPp(round1(pr - sr)).replace('+', '')} 큽니다.`;
    out.push({
      code: 'REV-PURCHASE-SPIKE',
      clientId: cid,
      title: '매입 급증 확인',
      detail: `전월 대비 ${purchaseText}, ${salesText}.${divergence} 재고·자산 매입, 선급 거래, 중복 입력 여부를 확인하세요.`,
      severity: pr >= p.highRate ? 'high' : 'warning',
      metric: { current: cur.purchases, baseline: prev.purchases, changeRate: pr },
      action: { label: '매입 거래 보기', href: inbox(cid, input.period, { direction: 'purchase' }) },
    });
  }
  if (sr !== null && sr >= p.salesSpikeRate && sr - (pr ?? 0) >= p.divergenceGap) {
    const purchasePart = pr === null ? '매입은 전월 비교 불가' : `매입 ${formatRate(pr)}`;
    out.push({
      code: 'REV-SALES-SPIKE',
      clientId: cid,
      title: '매출 급증 확인',
      detail: `전월 대비 ${salesText}, ${purchasePart}. 매출 증가에 비해 매입이 적습니다. 매입 증빙 누락(카드 미등록·세금계산서 미수취) 여부를 확인하세요.`,
      severity: 'info',
      metric: { current: cur.sales, baseline: prev.sales, changeRate: sr },
      action: { label: '매입 증빙 확인', href: inbox(cid, input.period, { direction: 'purchase' }) },
    });
  }
  if (sr !== null && sr <= p.salesDropRate) {
    out.push({
      code: 'REV-SALES-DROP',
      clientId: cid,
      title: '매출 급감 확인',
      detail: `전월 대비 ${salesText}. 카드·현금영수증 매출 누락이나 기간 귀속 오류가 없는지 확인하세요.`,
      severity: sr <= p.highDropRate ? 'high' : 'warning',
      metric: { current: cur.sales, baseline: prev.sales, changeRate: sr },
      action: { label: '매출 거래 보기', href: inbox(cid, input.period, { direction: 'sales' }) },
    });
  }
  if (pr !== null && pr <= p.purchaseDropRate) {
    out.push({
      code: 'REV-PURCHASE-DROP',
      clientId: cid,
      title: '매입 급감 확인',
      detail: `전월 대비 ${purchaseText}. 사업용카드 미등록, 세금계산서 미수취 등 매입 증빙 누락 여부를 확인하세요.`,
      severity: 'info',
      metric: { current: cur.purchases, baseline: prev.purchases, changeRate: pr },
      action: { label: '매입 거래 보기', href: inbox(cid, input.period, { direction: 'purchase' }) },
    });
  }
  return out;
}

// ────────────────────────────── 2. 계정별 N개월 평균 대비 ──────────────────────────────

export function checkAccountSpikes(input: LedgerReviewInput, params: ReviewParams = REVIEW_PARAMS): LedgerAnomaly[] {
  const p = params.accountSpike;
  const byPeriod = indexMonthly(input.monthly);
  const cur = byPeriod.get(input.period);
  if (!cur) return [];
  const history = priorMonths(input.period, p.lookbackMonths)
    .map((m) => byPeriod.get(m))
    .filter((s): s is MonthlyLedgerSummary => !!s);
  if (history.length < Math.max(1, p.minHistoryMonths)) return [];
  const exclude = new Set(p.excludeCodes);
  const out: LedgerAnomaly[] = [];
  const codes = Object.keys(cur.byAccount).sort();
  for (const code of codes) {
    if (exclude.has(code)) continue;
    const entry = cur.byAccount[code]!;
    const current = entry.total;
    const avg = Math.round(history.reduce((s, h) => s + (h.byAccount[code]?.total ?? 0), 0) / history.length);
    if (avg <= 0) continue; // 과거 없음 → 신규 계정 검사에서 다룸
    const ratio = current / avg;
    if (current < p.minAmount || ratio < p.ratio || current - avg < p.minIncrease) continue;
    const label = accountLabel(code, entry.name);
    const window = history.length === 1 ? '전월' : `${history.length}개월 평균`;
    out.push({
      code: 'REV-ACCOUNT-SPIKE',
      clientId: input.clientId,
      title: `${entry.name || label} 급증`,
      detail: `${label} ${window} ${formatManwon(avg)} → 이번달 ${formatManwon(current)} (${formatRatio(ratio)}, +${formatManwon(current - avg)}). 거래 내용과 계정 분류를 확인하세요.`,
      severity: ratio >= p.highRatio ? 'high' : 'warning',
      metric: { current, baseline: avg, changeRate: changeRatePercent(current, avg) ?? 0 },
      action: { label: `${entry.name || code} 거래 보기`, href: inbox(input.clientId, input.period, { bucket: 'spike', account: code }) },
    });
  }
  return out;
}

// ────────────────────────────── 3. 신규 계정 ──────────────────────────────

export function detectNewAccounts(input: LedgerReviewInput, params: ReviewParams = REVIEW_PARAMS): string[] {
  const p = params.newAccount;
  const byPeriod = indexMonthly(input.monthly);
  const cur = byPeriod.get(input.period);
  if (!cur) return [];
  const history = priorMonths(input.period, p.lookbackMonths)
    .map((m) => byPeriod.get(m))
    .filter((s): s is MonthlyLedgerSummary => !!s);
  if (history.length === 0) return []; // 비교할 과거가 없으면 판단하지 않는다
  const exclude = new Set(p.excludeCodes);
  return Object.keys(cur.byAccount)
    .filter((code) => !exclude.has(code))
    .filter((code) => (cur.byAccount[code]?.total ?? 0) >= p.minAmount)
    .filter((code) => history.every((h) => !h.byAccount[code] || h.byAccount[code]!.total === 0))
    .sort();
}

export function checkNewAccounts(input: LedgerReviewInput, params: ReviewParams = REVIEW_PARAMS): LedgerAnomaly[] {
  const p = params.newAccount;
  const cur = indexMonthly(input.monthly).get(input.period);
  const codes = input.newAccounts ? [...new Set(input.newAccounts)] : detectNewAccounts(input, params);
  return codes.map((code) => {
    const entry = cur?.byAccount[code];
    const name = entry?.name || ACCOUNT_MAP.get(code)?.name || code;
    const acc = ACCOUNT_MAP.get(code);
    const f = p.followUps[code] ?? (acc?.isFixedAsset ? p.fixedAssetFollowUp : p.defaultFollowUp);
    const amount = entry ? ` (${formatManwon(entry.total)})` : '';
    const href = f.hrefTemplate
      ? f.hrefTemplate.replace('{clientId}', encodeURIComponent(input.clientId)).replace('{period}', encodeURIComponent(input.period))
      : inbox(input.clientId, input.period, { bucket: f.bucket, account: code });
    const anomaly: LedgerAnomaly = {
      code: 'REV-NEW-ACCOUNT',
      clientId: input.clientId,
      title: `${name} 신규 발생`,
      detail: `${accountLabel(code, name)}이(가) 이번 달 처음 발생했습니다${amount}. ${f.check}`,
      severity: f.severity ?? 'info',
      action: { label: f.actionLabel, href },
    };
    return anomaly;
  });
}

// ────────────────────────────── 4. 원천 vs 처리 건수 ──────────────────────────────


export function sourceCountLabel(key: SourceCountKey): string {
  const [ev, dir] = key.split(':') as [EvidenceType, 'purchase' | 'sales' | undefined];
  const base = EVIDENCE_TYPE_LABELS[ev] ?? ev;
  return dir ? `${base} ${dir === 'purchase' ? '매입' : '매출'}` : base;
}

function countOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

export function checkSourceGaps(
  clientId: UUID,
  period: YearMonth,
  counts: SourceCounts | undefined,
  params: ReviewParams = REVIEW_PARAMS,
): LedgerAnomaly[] {
  if (!counts) return [];
  const p = params.sourceGap;
  const out: LedgerAnomaly[] = [];
  const wemembers = counts.wemembers ?? {};
  const processed = counts.processed ?? {};
  const keys = [...new Set([...Object.keys(wemembers), ...Object.keys(processed)])].sort() as SourceCountKey[];
  for (const key of keys) {
    const src = countOf(wemembers[key]);
    const done = countOf(processed[key]);
    const gap = src - done;
    if (Math.abs(gap) <= p.tolerance) continue;
    const label = sourceCountLabel(key);
    const [evidence, direction] = key.split(':');
    const href = reviewHref('/imports', { client: clientId, period, evidence, direction });
    if (gap > 0) {
      out.push({
        code: 'REV-SOURCE-GAP',
        clientId,
        title: `${label} 미처리 ${formatCount(gap)}`,
        detail: `${label} 위멤버스 ${formatCount(src)} vs 처리 ${formatCount(done)} → 미처리 ${formatCount(gap)} 확인. 정규화 실패·중복 제외·수집 누락 여부를 확인하세요.`,
        severity: gap >= p.highGap ? 'high' : 'warning',
        metric: { current: done, baseline: src, changeRate: changeRatePercent(done, src) ?? 0 },
        action: { label: '미처리 자료 확인', href },
      });
    } else {
      out.push({
        code: 'REV-SOURCE-EXCESS',
        clientId,
        title: `${label} 처리 건수 초과 ${formatCount(-gap)}`,
        detail: `${label} 위멤버스 ${formatCount(src)} vs 처리 ${formatCount(done)} → 처리 건수가 ${formatCount(-gap)} 많습니다. 중복 수집이나 수기 입력 여부를 확인하세요.`,
        severity: 'warning',
        metric: { current: done, baseline: src, changeRate: changeRatePercent(done, src) ?? 0 },
        action: { label: '수집 내역 확인', href },
      });
    }
  }
  return out;
}

// ────────────────────────────── 5. 부가세 과세기간 ──────────────────────────────

/** 매출 누락 가능성: 카드·현금영수증 매출 원천 vs 장부 반영 */
export function checkSalesOmission(
  clientId: UUID,
  period: YearMonth,
  vat: VatPeriodReviewInput,
  params: ReviewParams = REVIEW_PARAMS,
): LedgerAnomaly[] {
  const p = params.vatSales;
  const out: LedgerAnomaly[] = [];
  const items: Array<{ kind: string; evidence: EvidenceType; cmp: VatPeriodReviewInput['cardSales'] }> = [
    { kind: '신용카드 매출', evidence: 'card', cmp: vat.cardSales },
    { kind: '현금영수증 매출', evidence: 'cash_receipt', cmp: vat.cashReceiptSales },
  ];
  for (const { kind, evidence, cmp } of items) {
    if (!cmp || !(cmp.source >= 0) || !(cmp.reported >= 0)) continue;
    const gap = cmp.source - cmp.reported;
    const base = Math.max(cmp.source, 1);
    const gapRate = round1((Math.abs(gap) / base) * 100);
    if (Math.abs(gap) < p.minGap || gapRate < p.gapRate) continue;
    const href = inbox(clientId, period, { direction: 'sales', evidence });
    if (gap > 0) {
      out.push({
        code: 'VAT-SALES-OMISSION',
        clientId,
        title: '매출 누락 가능성',
        detail: `${vat.label} ${kind} 원천자료 ${formatManwon(cmp.source)} vs 장부 반영 ${formatManwon(cmp.reported)} → ${formatManwon(gap)}(${gapRate}%) 적게 반영되었습니다. 매출 누락·기간 귀속을 확인하세요.`,
        severity: gapRate >= p.highGapRate ? 'high' : 'warning',
        metric: { current: cmp.reported, baseline: cmp.source, changeRate: changeRatePercent(cmp.reported, cmp.source) ?? 0 },
        action: { label: `${kind} 확인`, href },
      });
    } else {
      out.push({
        code: 'VAT-SALES-EXCESS',
        clientId,
        title: `${kind} 과다 반영 가능성`,
        detail: `${vat.label} ${kind} 장부 반영 ${formatManwon(cmp.reported)}이(가) 원천자료 ${formatManwon(cmp.source)}보다 ${formatManwon(-gap)}(${gapRate}%) 많습니다. 중복 반영이나 다른 기간 매출 포함 여부를 확인하세요.`,
        severity: 'info',
        metric: { current: cmp.reported, baseline: cmp.source, changeRate: changeRatePercent(cmp.reported, cmp.source) ?? 0 },
        action: { label: `${kind} 확인`, href },
      });
    }
  }
  return out;
}

/** 불공제 매입세액 비율 급변 */
export function checkNonDeductibleShift(
  clientId: UUID,
  period: YearMonth,
  vat: VatPeriodReviewInput,
  params: ReviewParams = REVIEW_PARAMS,
): LedgerAnomaly[] {
  const p = params.nonDeductible;
  const iv = vat.inputVat;
  if (!iv || !iv.previous) return [];
  const curTotal = iv.current.deductible + iv.current.nonDeductible;
  const prevTotal = iv.previous.deductible + iv.previous.nonDeductible;
  if (curTotal < p.minTotalVat || prevTotal <= 0) return [];
  const curRatio = round1((iv.current.nonDeductible / curTotal) * 100);
  const prevRatio = round1((iv.previous.nonDeductible / prevTotal) * 100);
  const delta = round1(curRatio - prevRatio);
  if (Math.abs(delta) < p.deltaPp) return [];
  const direction = delta > 0 ? '늘었습니다' : '줄었습니다';
  const hint =
    delta > 0
      ? '불공제 사유(접대·비영업용 승용차·면세사업 관련) 분류가 과도하지 않은지 확인하세요.'
      : '불공제 대상(접대·비영업용 승용차·면세사업 관련)을 공제로 처리하지 않았는지 확인하세요.';
  return [
    {
      code: 'VAT-NONDEDUCT-SHIFT',
      clientId,
      title: '불공제 비율 급변',
      detail: `${vat.label} 불공제 매입세액 비율이 직전 기간 ${prevRatio}% → 이번 기간 ${curRatio}% (${formatPp(delta)})로 ${direction}. 불공제 ${formatManwon(iv.current.nonDeductible)} / 매입세액 ${formatManwon(curTotal)}. ${hint}`,
      severity: 'warning',
      metric: { current: curRatio, baseline: prevRatio, changeRate: delta },
      action: { label: '공제/불공제 검토', href: inbox(clientId, period, { bucket: 'vat_review' }) },
    },
  ];
}

/** 고정자산 매입 — 부가세 신고서 고정자산매입 구분·건물등감가상각자산취득명세서 */
export function checkFixedAssetPurchases(
  clientId: UUID,
  period: YearMonth,
  vat: VatPeriodReviewInput,
  params: ReviewParams = REVIEW_PARAMS,
): LedgerAnomaly[] {
  const p = params.fixedAsset;
  // 반품·수정세금계산서(음수)도 합계에 넣어 순액으로 보여준다
  const items = (vat.fixedAssetPurchases ?? []).filter((x) => Number.isFinite(x.supplyAmount) && x.supplyAmount !== 0 && Math.abs(x.supplyAmount) >= p.minSupply);
  if (items.length === 0) return [];
  const supply = items.reduce((s, x) => s + x.supplyAmount, 0);
  const tax = items.reduce((s, x) => s + (Number.isFinite(x.vatAmount) ? x.vatAmount : 0), 0);
  const top = [...items].sort((a, b) => Math.abs(b.supplyAmount) - Math.abs(a.supplyAmount)).slice(0, 3);
  const examples = top.map((x) => `${x.date} ${x.merchantName} ${x.accountName} ${formatManwon(x.supplyAmount)}`).join(', ');
  const small = items.filter((x) => x.supplyAmount > 0 && x.supplyAmount <= p.immediateExpenseLimit);
  const smallNote =
    small.length > 0
      ? ` 이 중 ${formatCount(small.length)}(${formatManwon(small.reduce((s, x) => s + x.supplyAmount, 0))})은 거래단위 ${formatManwon(p.immediateExpenseLimit)} 이하로 즉시상각(비용 처리)도 가능합니다. 자산으로 유지하면 고정자산매입분에 포함하세요.`
      : '';
  const refund = tax >= p.earlyRefundHintVat ? ' 사업설비 취득분은 조기환급 대상인지도 검토하세요.' : '';
  return [
    {
      code: 'VAT-FIXED-ASSET',
      clientId,
      title: `고정자산 매입 ${formatCount(items.length)}`,
      detail: `${vat.label} 고정자산 매입 ${formatCount(items.length)} 공급가액 ${formatManwon(supply)}(세액 ${formatManwon(tax)}): ${examples}${items.length > 3 ? ' 외' : ''}. 신고서 고정자산매입분 구분과 건물등감가상각자산취득명세서 작성을 확인하세요.${smallNote}${refund}`,
      severity: 'info',
      metric: { current: supply, baseline: 0, changeRate: 0 },
      action: { label: '자산 매입 확인', href: inbox(clientId, period, { bucket: 'possible_asset' }) },
    },
  ];
}

function matchesDeemedKeyword(x: { merchantName: string; description?: string; merchantCategory?: string | null }, keywords: string[]): boolean {
  const text = normalizeMerchantName(`${x.merchantName} ${x.description ?? ''} ${x.merchantCategory ?? ''}`);
  return keywords.some((k) => text.includes(normalizeMerchantName(k)));
}

/** 의제매입세액공제 가능 항목 (대상 업종) */
export function checkDeemedInputTax(
  clientId: UUID,
  period: YearMonth,
  industry: IndustryKey | undefined,
  vat: VatPeriodReviewInput,
  params: ReviewParams = REVIEW_PARAMS,
): LedgerAnomaly[] {
  const p = params.deemed;
  const evidence = new Set(p.evidenceTypes);
  const candidates = (vat.exemptPurchases ?? []).filter(
    (x) => !x.claimedAsDeemed && evidence.has(x.evidenceType) && x.amount > 0 && matchesDeemedKeyword(x, p.keywords),
  );
  const total = candidates.reduce((s, x) => s + x.amount, 0);
  if (candidates.length === 0 || total < p.minAmount) return [];
  const href = inbox(clientId, period, { direction: 'purchase', evidence: 'invoice_exempt' });
  const summary = `면세 농·축·수산물 매입 ${formatCount(candidates.length)} ${formatManwon(total)}`;

  if (vat.vatType === 'simplified') {
    if (!vat.deemedInputTaxEligible) return [];
    return [
      {
        code: 'VAT-DEEMED-SIMPLIFIED',
        clientId,
        title: '간이과세자 의제매입 설정 확인',
        detail: `${vat.label} ${summary}이(가) 있으나 간이과세자는 2021-07-01 이후 의제매입세액공제를 받을 수 없습니다. 수임처 설정(의제매입 대상)을 확인하세요.`,
        severity: 'warning',
        action: { label: '수임처 설정 확인', href: reviewHref(`/clients/${encodeURIComponent(clientId)}`, {}) },
      },
    ];
  }
  if (vat.vatType === 'exempt') return [];
  if (vat.deemedInputTaxEligible) {
    return [
      {
        code: 'VAT-DEEMED-CANDIDATE',
        clientId,
        title: '의제매입세액공제 검토',
        detail: `${vat.label} ${summary}이(가) 의제매입 미반영 상태입니다. 계산서·카드(면세분) 증빙으로 공제신고서 반영 여부를 확인하세요. 공제율·한도는 업종·과세표준에 따라 다릅니다 (예: 음식점 개인 8/108).`,
        severity: 'warning',
        metric: { current: total, baseline: 0, changeRate: 0 },
        action: { label: '면세 매입 확인', href },
      },
    ];
  }
  if (industry && p.industries.includes(industry)) {
    return [
      {
        code: 'VAT-DEEMED-SETTING',
        clientId,
        title: '의제매입 대상 여부 확인',
        detail: `${vat.label} ${summary}이(가) 있는데 수임처가 의제매입 대상으로 설정되어 있지 않습니다. 업종·과세유형을 확인하세요.`,
        severity: 'info',
        action: { label: '수임처 설정 확인', href: reviewHref(`/clients/${encodeURIComponent(clientId)}`, {}) },
      },
    ];
  }
  return [];
}

export function checkVatPeriod(
  clientId: UUID,
  period: YearMonth,
  industry: IndustryKey | undefined,
  vat: VatPeriodReviewInput | undefined,
  params: ReviewParams = REVIEW_PARAMS,
): LedgerAnomaly[] {
  if (!vat) return [];
  return [
    ...checkSalesOmission(clientId, period, vat, params),
    ...checkNonDeductibleShift(clientId, period, vat, params),
    ...checkFixedAssetPurchases(clientId, period, vat, params),
    ...checkDeemedInputTax(clientId, period, industry, vat, params),
  ];
}

// ────────────────────────────── 6. 범용 시계열 ──────────────────────────────

export function checkSeriesSpikes(
  clientId: UUID,
  period: YearMonth,
  series: MetricSeries[] | undefined,
  params: ReviewParams = REVIEW_PARAMS,
): LedgerAnomaly[] {
  if (!series?.length) return [];
  const p = params.series;
  const out: LedgerAnomaly[] = [];
  const window = priorMonths(period, p.lookbackMonths);
  for (const s of series) {
    const byPeriod = new Map<YearMonth, Won>();
    for (const pt of s.points) if (isYearMonth(pt.period)) byPeriod.set(pt.period, (byPeriod.get(pt.period) ?? 0) + pt.value);
    const current = byPeriod.get(period);
    if (current === undefined) continue;
    const hist = window.filter((m) => byPeriod.has(m)).map((m) => byPeriod.get(m)!);
    if (hist.length < Math.max(1, p.minHistoryMonths)) continue;
    const avg = Math.round(hist.reduce((a, b) => a + b, 0) / hist.length);
    if (avg <= 0) continue;
    const ratio = current / avg;
    if (current < p.minAmount || ratio < p.ratio || current - avg < p.minIncrease) continue;
    const win = hist.length === 1 ? '전월' : `${hist.length}개월 평균`;
    out.push({
      code: 'ANOM-SERIES-SPIKE',
      clientId,
      title: `${s.label} 급증`,
      detail: `${s.label} ${win} ${formatManwon(avg)} → 이번달 ${formatManwon(current)} (${formatRatio(ratio)}, +${formatManwon(current - avg)}).`,
      severity: ratio >= p.highRatio ? 'high' : 'warning',
      metric: { current, baseline: avg, changeRate: changeRatePercent(current, avg) ?? 0 },
      action: { label: `${s.label} 확인`, href: s.href ?? inbox(clientId, period, { bucket: s.bucket ?? 'spike' }) },
    });
  }
  return out;
}

// ────────────────────────────── 조합 ──────────────────────────────

/** 월 장부 검토 전체 (결정적). 심각도 순 정렬 */
export function runLedgerReview(input: LedgerReviewInput, params: ReviewParams = REVIEW_PARAMS): LedgerAnomaly[] {
  return sortAnomalies([
    ...checkMonthlyTotals(input, params),
    ...checkAccountSpikes(input, params),
    ...checkNewAccounts(input, params),
    ...checkSourceGaps(input.clientId, input.period, input.sourceCounts, params),
    ...checkVatPeriod(input.clientId, input.period, input.industry, input.vat, params),
  ]);
}

/** 이상 탐지 (시계열 + 원천 건수 + 부가세 기간). 심각도 순 정렬 */
export function runAnomalyDetection(input: AnomalyInput, params: ReviewParams = REVIEW_PARAMS): LedgerAnomaly[] {
  return sortAnomalies([
    ...checkSeriesSpikes(input.clientId, input.period, input.series, params),
    ...checkSourceGaps(input.clientId, input.period, input.sourceCounts, params),
    ...checkVatPeriod(input.clientId, input.period, input.industry, input.vat, params),
  ]);
}
