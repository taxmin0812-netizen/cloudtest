/**
 * 자동화 KPI (/kpi) — 정의·산식은 docs/02-automation-matrix.md §4 가 기준 (metrics.ts 주석 참고).
 *
 *  #1 No-touch Rate            = no_touch ÷ total_transactions                     목표 ≥ 80% (12개월), 3개월 ≥ 55%
 *  #2 Auto Classification Rate = auto_classified ÷ classification_base            목표 ≥ 95%
 *  #3 Manual Review Rate       = reviewed ÷ total_transactions                     목표 ≤ 20%   (자동처리율 = 1 − #3)
 *  #4 Correction Rate          = corrected ÷ total_transactions                    목표 ≤ 6%
 *                                (보조: corrected ÷ reviewed = 엔진 추천 중 사람이 고친 비율)
 *  #5 Processing Time / Client = Σ 사람 활동초 ÷ 60 ÷ 활성 수임처                   목표 ≤ 80분 (+ 기계 처리시간 = 작업 실행초)
 *  #6 Exceptions / Client      = (거래예외 + 인건비예외 + 대사 blocking + 수집실패행 + 전송실패) ÷ 활성 수임처   목표 ≤ 50
 *  #7 Reconciliation Error     = 최신 phase 별 대사 보고서의 blocking 차이(검토대기 제외) 합                 목표 0
 *  #8 Payroll Manual Touches   = 급여 관련 audit data_change 건수 ÷ 활성 수임처                           목표 ≤ 10
 *  #9 Manual Touches/Client    = (Σ touch_count + 인건비 터치 + 운영 터치) ÷ 활성 수임처                   목표 ≤ 100
 * 사무소 합산은 분자 합 ÷ 분모 합 (가중). 수임처당 지표는 Σ ÷ 해당 기간 활성 수임처 수.
 * 보조 지표(§4.5): 자동승인 사후 수정률(< 1%, 2% 초과 경보), 자동승인 후 개입률(< 3%), 규칙 커버리지, 미검토 잔량,
 *                 반복 거래처 자동처리율(≥ 95%), 대사 성공률(100%), 데이터 유실(0).
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { clients, systemMetrics, type Database } from '@mintax/db';
import { requirePermission, type ServiceContext } from '../context';
import { getCurrentPeriod } from '../infra/settings';
import { addCounts, collectMetrics, emptyCounts, exceptionsOf, manualTouchesOf, type MetricCounts } from './metrics';
import { assertPeriod, clampLimit, hrefs, monthsEndingAt, num, optionalUuid, percent, ratio1 } from './shared';

export type KpiKey =
  | 'no_touch_rate'
  | 'auto_classification_rate'
  | 'manual_review_rate'
  | 'correction_rate'
  | 'processing_time_per_client'
  | 'exceptions_per_client'
  | 'reconciliation_error'
  | 'payroll_manual_touches'
  | 'manual_touches_per_client';

export interface KpiTarget {
  op: '>=' | '<=' | '=';
  value: number;
  /** 3개월 차 중간 목표 (있으면) */
  interim?: number;
  label: string;
}

export interface KpiValueDTO {
  key: KpiKey;
  label: string;
  value: number | null;
  unit: '%' | '분' | '건' | '회';
  numerator: number;
  denominator: number;
  target: KpiTarget;
  status: 'met' | 'not_met' | 'no_data';
  formula: string;
  href: string;
  /** 보조 값 (예: 수정률의 검토 대비 비율, 처리시간의 기계 처리분) */
  secondary?: { label: string; value: number | null; unit: string } | null;
}

export interface KpiGuardDTO {
  key: string;
  label: string;
  value: number | null;
  unit: '%' | '건';
  target: KpiTarget;
  status: 'met' | 'not_met' | 'no_data';
  formula: string;
}

export interface KpiClientRowDTO {
  clientId: string;
  clientName: string;
  total: number;
  noTouchRate: number | null;
  autoRate: number | null;
  exceptions: number;
  corrected: number;
  manualTouches: number;
  href: string;
}

export interface KpiResultDTO {
  period: string;
  clientId: string | null;
  activeClients: number;
  computedAt: string;
  kpis: KpiValueDTO[];
  guards: KpiGuardDTO[];
  /** UI 비교용 핵심 목표 */
  targets: { noTouchRate: number; repeatClientAutoRate: number; reconciliationSuccessRate: number; dataLoss: number };
  counts: MetricCounts;
  /** 사무소 전체 조회 시: 개선 여지가 큰 수임처 (No-touch 낮은 순) */
  byClient: KpiClientRowDTO[];
  /** 수정이 많은 계정 → 규칙 후보 */
  topCorrectedAccounts: Array<{ accountCode: string; accountLabel: string; corrections: number; merchants: string[]; href: string }>;
}

export const KPI_TARGETS = {
  noTouchRate: { op: '>=', value: 80, interim: 55, label: '≥ 80% (3개월 차 ≥ 55%)' },
  autoClassificationRate: { op: '>=', value: 95, interim: 85, label: '≥ 95% (3개월 차 ≥ 85%)' },
  manualReviewRate: { op: '<=', value: 20, interim: 45, label: '≤ 20% (3개월 차 ≤ 45%)' },
  correctionRate: { op: '<=', value: 6, interim: 15, label: '≤ 6% (3개월 차 ≤ 15%)' },
  processingMinutes: { op: '<=', value: 80, interim: 140, label: '≤ 80분 (3개월 차 ≤ 140분)' },
  exceptionsPerClient: { op: '<=', value: 50, interim: 110, label: '≤ 50 (3개월 차 ≤ 110)' },
  reconErrors: { op: '=', value: 0, label: '0건' },
  payrollTouches: { op: '<=', value: 10, interim: 16, label: '≤ 10 (3개월 차 ≤ 16)' },
  manualTouches: { op: '<=', value: 100, interim: 200, label: '≤ 100 (3개월 차 ≤ 200)' },
  autoApprovalError: { op: '<=', value: 1, label: '< 1% (2% 초과 시 자동승인 강등)' },
  autoTouched: { op: '<=', value: 3, label: '< 3%' },
  ruleCoverage: { op: '>=', value: 40, label: '≥ 40% (12개월)' },
  pendingReview: { op: '=', value: 0, label: '전송 시점 0건' },
  repeatAutoRate: { op: '>=', value: 95, label: '≥ 95%' },
  reconSuccess: { op: '>=', value: 100, label: '100%' },
  dataLoss: { op: '=', value: 0, label: '0건' },
} as const satisfies Record<string, KpiTarget>;

function statusOf(value: number | null, t: KpiTarget): 'met' | 'not_met' | 'no_data' {
  if (value === null) return 'no_data';
  if (t.op === '>=') return value >= t.value ? 'met' : 'not_met';
  if (t.op === '<=') return value <= t.value ? 'met' : 'not_met';
  return value === t.value ? 'met' : 'not_met';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 원천 집계 → KPI 9종 + 보조 지표 (순수 함수 — 단위 테스트 대상) */
export function buildKpis(m: MetricCounts, activeClients: number, period: string, clientId: string | null): { kpis: KpiValueDTO[]; guards: KpiGuardDTO[] } {
  const per = Math.max(activeClients, 0);
  const perClient = (v: number) => (per > 0 ? round1(v / per) : null);
  const exceptions = exceptionsOf(m);
  const touches = manualTouchesOf(m);
  const link = (metric: string) => hrefs.kpi({ period, client: clientId, metric });
  const noTouch = percent(m.noTouch, m.totalTransactions);
  const autoCls = percent(m.autoClassified, m.classificationBase);
  const review = percent(m.reviewed, m.totalTransactions);
  const corr = percent(m.corrected, m.totalTransactions);
  const minutes = per > 0 ? round1(m.processingSeconds / 60 / per) : null;
  const kpis: KpiValueDTO[] = [
    {
      key: 'no_touch_rate', label: 'No-touch Rate', value: noTouch, unit: '%', numerator: m.noTouch, denominator: m.totalTransactions,
      target: KPI_TARGETS.noTouchRate, status: statusOf(noTouch, KPI_TARGETS.noTouchRate),
      formula: '|E ∩ 완료상태(auto_approved·approved·exported·reconciled) ∩ touch_count=0| ÷ |E| (E = 중복·실패 제외)', href: link('no_touch'),
      secondary: { label: '자동확정 사후 수정률', value: percent(m.autoCorrected, m.autoApproved), unit: '%' },
    },
    {
      key: 'auto_classification_rate', label: 'Auto Classification Rate', value: autoCls, unit: '%', numerator: m.autoClassified, denominator: m.classificationBase,
      target: KPI_TARGETS.autoClassificationRate, status: statusOf(autoCls, KPI_TARGETS.autoClassificationRate),
      formula: '|C ∩ 엔진출처(manual·none 제외) ∩ 계정수정 없음| ÷ |C| (C = E − 제외)', href: link('auto_classification'),
    },
    {
      key: 'manual_review_rate', label: 'Manual Review Rate', value: review, unit: '%', numerator: m.reviewed, denominator: m.totalTransactions,
      target: KPI_TARGETS.manualReviewRate, status: statusOf(review, KPI_TARGETS.manualReviewRate),
      formula: '|E ∩ review_level ∈ (quick_review, must_review)| ÷ |E| — 자동처리율 = 1 − 이 값', href: link('manual_review'),
      secondary: { label: '미검토 잔량', value: m.pendingReview, unit: '건' },
    },
    {
      key: 'correction_rate', label: 'Correction Rate', value: corr, unit: '%', numerator: m.corrected, denominator: m.totalTransactions,
      target: KPI_TARGETS.correctionRate, status: statusOf(corr, KPI_TARGETS.correctionRate),
      formula: '|계정·부가세를 1회 이상 고친 E 거래| ÷ |E|', href: link('correction'),
      secondary: { label: '검토 추천 대비 수정 비율', value: percent(m.corrected, m.reviewed), unit: '%' },
    },
    {
      key: 'processing_time_per_client', label: 'Processing Time / Client', value: minutes, unit: '분', numerator: Math.round(m.processingSeconds / 60), denominator: per,
      target: KPI_TARGETS.processingMinutes, status: statusOf(minutes, KPI_TARGETS.processingMinutes),
      formula: 'Σ 사람 활동초(감사로그 간격, 같은 수임처 연속 ≤ 300초·전환 30초) ÷ 60 ÷ 활성 수임처', href: link('processing_time'),
      secondary: { label: '기계 처리시간(작업 실행)', value: per > 0 ? round1(m.systemSeconds / 60 / per) : null, unit: '분' },
    },
    {
      key: 'exceptions_per_client', label: 'Exceptions / Client', value: perClient(exceptions), unit: '건', numerator: exceptions, denominator: per,
      target: KPI_TARGETS.exceptionsPerClient, status: statusOf(perClient(exceptions), KPI_TARGETS.exceptionsPerClient),
      formula: '(거래예외 + 인건비예외 + 대사 blocking + 수집실패 행 + 전송실패) ÷ 활성 수임처', href: link('exceptions'),
    },
    {
      key: 'reconciliation_error', label: 'Reconciliation Error', value: m.reconReports > 0 || m.reconErrors > 0 ? m.reconErrors : null, unit: '건', numerator: m.reconErrors, denominator: m.reconReports,
      target: KPI_TARGETS.reconErrors, status: statusOf(m.reconReports > 0 ? m.reconErrors : null, KPI_TARGETS.reconErrors),
      formula: 'Σ phase 별 최신 대사 보고서의 blocking 차이 (pending_review 제외)', href: link('reconciliation'),
    },
    {
      key: 'payroll_manual_touches', label: 'Payroll Manual Touches', value: perClient(m.payrollManualTouches), unit: '회', numerator: m.payrollManualTouches, denominator: per,
      target: KPI_TARGETS.payrollTouches, status: statusOf(perClient(m.payrollManualTouches), KPI_TARGETS.payrollTouches),
      formula: '급여(payroll_item·payroll_month·열린 급여월의 employee) 사람 data_change 감사로그 ÷ 활성 수임처', href: link('payroll_touches'),
    },
    {
      key: 'manual_touches_per_client', label: 'Manual Touches / Client / Month', value: perClient(touches), unit: '회', numerator: touches, denominator: per,
      target: KPI_TARGETS.manualTouches, status: statusOf(perClient(touches), KPI_TARGETS.manualTouches),
      formula: '(Σ touch_count + 인건비 터치 + 운영 터치[수집·전송·신고]) ÷ 활성 수임처 — 규칙 작성·승인 제외', href: link('manual_touches'),
    },
  ];
  const aae = percent(m.autoCorrected, m.autoApproved);
  const at = percent(m.autoTouched, m.autoApproved);
  const cov = percent(m.userRule, m.totalTransactions);
  const rep = percent(m.repeatAuto, m.repeatBase);
  const recon = percent(m.reconCleanReports, m.reconReports);
  const guards: KpiGuardDTO[] = [
    { key: 'auto_approval_error_rate', label: '자동확정 사후 수정률', value: aae, unit: '%', target: KPI_TARGETS.autoApprovalError, status: statusOf(aae, KPI_TARGETS.autoApprovalError), formula: '|CORR ∩ review_level=auto| ÷ |E ∩ review_level=auto|' },
    { key: 'auto_touched_rate', label: '자동확정 후 개입률', value: at, unit: '%', target: KPI_TARGETS.autoTouched, status: statusOf(at, KPI_TARGETS.autoTouched), formula: '|E ∩ review_level=auto ∩ touch_count>0| ÷ |E ∩ review_level=auto|' },
    { key: 'rule_coverage', label: '규칙 커버리지', value: cov, unit: '%', target: KPI_TARGETS.ruleCoverage, status: statusOf(cov, KPI_TARGETS.ruleCoverage), formula: '|E ∩ classification_source=user_rule| ÷ |E|' },
    { key: 'pending_review', label: '미검토 잔량', value: m.totalTransactions > 0 ? m.pendingReview : null, unit: '건', target: KPI_TARGETS.pendingReview, status: statusOf(m.totalTransactions > 0 ? m.pendingReview : null, KPI_TARGETS.pendingReview), formula: '|E ∩ status=needs_review|' },
    { key: 'repeat_client_auto_rate', label: '반복 거래처 자동처리율', value: rep, unit: '%', target: KPI_TARGETS.repeatAutoRate, status: statusOf(rep, KPI_TARGETS.repeatAutoRate), formula: '|E ∩ 신규거래처 아님 ∩ review_level=auto| ÷ |E ∩ 신규거래처 아님|' },
    { key: 'reconciliation_success_rate', label: '대사 성공률', value: recon, unit: '%', target: KPI_TARGETS.reconSuccess, status: statusOf(recon, KPI_TARGETS.reconSuccess), formula: '차단 차이 0 인 최신 대사 보고서 ÷ 최신 대사 보고서 (phase 별)' },
    { key: 'data_loss', label: '데이터 유실', value: m.sourceRows > 0 || m.dataLoss > 0 ? m.dataLoss : null, unit: '건', target: KPI_TARGETS.dataLoss, status: statusOf(m.sourceRows > 0 || m.dataLoss > 0 ? m.dataLoss : null, KPI_TARGETS.dataLoss), formula: 'Σ(수집 건수 − 원본행 기록) + 거래가 없는 ok/중복 원본행' },
  ];
  return { kpis, guards };
}

/** KPI 계산 (라이브) — clientId 가 없으면 사무소 전체 (가중 합산) */
export async function computeKpis(ctx: ServiceContext, input: { period?: string; clientId?: string | null } = {}): Promise<KpiResultDTO> {
  requirePermission(ctx, 'transactions.read');
  const period = input.period ? assertPeriod(input.period) : await getCurrentPeriod(ctx);
  const clientId = optionalUuid(input.clientId, 'clientId', '수임처');
  const [metrics, activeClientRows, topCorr] = await Promise.all([
    collectMetrics(ctx.db, { periods: [period], clientIds: clientId ? [clientId] : null, now: ctx.now() }),
    ctx.db.select({ id: clients.id, name: clients.name, active: clients.active }).from(clients).where(clientId ? eq(clients.id, clientId) : undefined),
    ctx.db.execute<{ after_value: string; after_label: string | null; n: number; merchants: string[] }>(sql`
      select cc.after_value, max(cc.after_label) as after_label, count(*)::int as n,
        (array_agg(distinct t.merchant_name))[1:5] as merchants
      from classification_corrections cc join transactions t on t.id = cc.transaction_id
      where cc.field = 'account' and t.period = ${period} ${clientId ? sql`and t.client_id = ${clientId}::uuid` : sql``}
      group by cc.after_value order by n desc, cc.after_value limit 5
    `),
  ]);
  const names = new Map(activeClientRows.map((c) => [c.id, c] as const));
  let total = emptyCounts();
  let activeClients = 0;
  const byClient: KpiClientRowDTO[] = [];
  for (const [key, m] of metrics) {
    const cid = key.split('|')[0]!;
    const c = names.get(cid);
    if (!c || (!c.active && !clientId)) continue;
    total = addCounts(total, m);
    if (m.active) activeClients += 1;
    byClient.push({
      clientId: cid,
      clientName: c.name,
      total: m.totalTransactions,
      noTouchRate: percent(m.noTouch, m.totalTransactions),
      autoRate: percent(m.autoApproved, m.totalTransactions),
      exceptions: exceptionsOf(m),
      corrected: m.corrected,
      manualTouches: manualTouchesOf(m),
      href: hrefs.client(cid, 'overview', { period }),
    });
  }
  if (clientId) activeClients = total.active ? 1 : 0;
  byClient.sort((a, b) => (a.noTouchRate ?? 101) - (b.noTouchRate ?? 101) || b.exceptions - a.exceptions || a.clientName.localeCompare(b.clientName, 'ko'));
  const { kpis, guards } = buildKpis(total, activeClients, period, clientId);
  return {
    period,
    clientId,
    activeClients,
    computedAt: ctx.now().toISOString(),
    kpis,
    guards,
    targets: {
      noTouchRate: KPI_TARGETS.noTouchRate.value,
      repeatClientAutoRate: KPI_TARGETS.repeatAutoRate.value,
      reconciliationSuccessRate: KPI_TARGETS.reconSuccess.value,
      dataLoss: KPI_TARGETS.dataLoss.value,
    },
    counts: total,
    byClient: clientId ? [] : byClient.slice(0, 20),
    topCorrectedAccounts: topCorr.rows.map((r) => ({
      accountCode: r.after_value,
      accountLabel: r.after_label ? `${r.after_label}(${r.after_value})` : r.after_value,
      corrections: num(r.n),
      merchants: (r.merchants ?? []).filter(Boolean),
      href: hrefs.rules({ search: r.after_value, client: clientId }),
    })),
  };
}

export interface KpiTrendPointDTO {
  period: string;
  source: 'snapshot' | 'live';
  computedAt: string | null;
  totalTransactions: number;
  activeClients: number;
  noTouchRate: number | null;
  autoRate: number | null;
  manualReviewRate: number | null;
  correctionRate: number | null;
  /** 스냅샷에는 분자 컬럼이 없어 라이브 계산 월에만 값이 있다 */
  autoClassificationRate: number | null;
  exceptionsPerClient: number | null;
  manualTouchesPerClient: number | null;
  payrollTouchesPerClient: number | null;
  processingMinutesPerClient: number | null;
  reconErrors: number;
}

function trendPoint(period: string, source: 'snapshot' | 'live', computedAt: Date | null, m: MetricCounts, activeClients: number, exceptions: number, manualTouches: number): KpiTrendPointDTO {
  const autoRate = percent(m.autoApproved, m.totalTransactions);
  return {
    period,
    source,
    computedAt: computedAt ? computedAt.toISOString() : null,
    totalTransactions: m.totalTransactions,
    activeClients,
    noTouchRate: percent(m.noTouch, m.totalTransactions),
    autoRate,
    manualReviewRate: percent(m.reviewed, m.totalTransactions),
    correctionRate: percent(m.corrected, m.totalTransactions),
    autoClassificationRate: source === 'live' ? percent(m.autoClassified, m.classificationBase) : null,
    exceptionsPerClient: ratio1(exceptions, activeClients),
    manualTouchesPerClient: ratio1(manualTouches, activeClients),
    payrollTouchesPerClient: ratio1(m.payrollManualTouches, activeClients),
    processingMinutesPerClient: activeClients > 0 ? Math.round((m.processingSeconds / 60 / activeClients) * 10) / 10 : null,
    reconErrors: m.reconErrors,
  };
}

/**
 * 월별 추이 — 지난 달은 system_metrics 스냅샷(kpi_snapshot 작업), 이번 달과 스냅샷이 없는 달은 라이브 계산.
 */
export async function getKpiTrend(ctx: ServiceContext, input: { months?: number; clientId?: string | null; endPeriod?: string } = {}): Promise<{ points: KpiTrendPointDTO[]; targets: KpiResultDTO['targets'] }> {
  requirePermission(ctx, 'transactions.read');
  const months = clampLimit(input.months ?? 6, 6, 24);
  const clientId = optionalUuid(input.clientId, 'clientId', '수임처');
  const end = input.endPeriod ? assertPeriod(input.endPeriod, 'endPeriod') : await getCurrentPeriod(ctx);
  const periods = monthsEndingAt(end, months);
  const past = periods.slice(0, -1);
  const snaps = past.length
    ? await ctx.db
        .select()
        .from(systemMetrics)
        .innerJoin(clients, eq(clients.id, systemMetrics.clientId))
        .where(and(inArray(systemMetrics.period, past), isNotNull(systemMetrics.clientId), clientId ? eq(systemMetrics.clientId, clientId) : eq(clients.active, true)))
    : [];
  const byPeriod = new Map<string, { m: MetricCounts; exceptions: number; touches: number; clients: number; computedAt: Date | null }>();
  for (const { system_metrics: s } of snaps) {
    const e = byPeriod.get(s.period) ?? { m: emptyCounts(), exceptions: 0, touches: 0, clients: 0, computedAt: null };
    e.m.totalTransactions += s.totalTransactions;
    e.m.autoApproved += s.autoApproved;
    e.m.noTouch += s.noTouch;
    e.m.reviewed += s.reviewed;
    e.m.corrected += s.corrected;
    e.m.payrollManualTouches += s.payrollManualTouches;
    e.m.reconErrors += s.reconErrors;
    e.m.processingSeconds += s.processingSeconds;
    e.exceptions += s.exceptions;
    e.touches += s.manualTouches;
    e.clients += 1;
    e.computedAt = !e.computedAt || s.computedAt > e.computedAt ? s.computedAt : e.computedAt;
    byPeriod.set(s.period, e);
  }
  const liveNeeded = periods.filter((p) => p === end || !byPeriod.has(p));
  const live = await collectMetrics(ctx.db, { periods: liveNeeded, clientIds: clientId ? [clientId] : null, now: ctx.now() });
  const activeIds = clientId
    ? new Set([clientId])
    : new Set((await ctx.db.select({ id: clients.id }).from(clients).where(eq(clients.active, true))).map((r) => r.id));
  const liveAgg = new Map<string, { m: MetricCounts; clients: number }>();
  for (const [key, m] of live) {
    const [cid, p] = key.split('|') as [string, string];
    if (!activeIds.has(cid)) continue;
    const e = liveAgg.get(p) ?? { m: emptyCounts(), clients: 0 };
    e.m = addCounts(e.m, m);
    if (m.active) e.clients += 1;
    liveAgg.set(p, e);
  }
  const points = periods.map((p) => {
    const l = liveAgg.get(p);
    if (liveNeeded.includes(p)) {
      const m = l?.m ?? emptyCounts();
      return trendPoint(p, 'live', ctx.now(), m, l?.clients ?? 0, exceptionsOf(m), manualTouchesOf(m));
    }
    const s = byPeriod.get(p)!;
    return trendPoint(p, 'snapshot', s.computedAt, s.m, s.clients, s.exceptions, s.touches);
  });
  return {
    points,
    targets: {
      noTouchRate: KPI_TARGETS.noTouchRate.value,
      repeatClientAutoRate: KPI_TARGETS.repeatAutoRate.value,
      reconciliationSuccessRate: KPI_TARGETS.reconSuccess.value,
      dataLoss: KPI_TARGETS.dataLoss.value,
    },
  };
}

/**
 * KPI 스냅샷 저장 (kpi_snapshot 작업) — 수임처 × 기간 upsert (system_metrics_client_period_uq). 여러 번 실행해도 결과 동일.
 * 사무소 합계 행(client_id NULL)은 저장하지 않는다 (NULLS DISTINCT 로 중복이 쌓이므로 — docs/03 §14 G10).
 */
export async function snapshotKpis(db: Database, input: { periods: string[]; now: Date; clientIds?: string[] | null; onProgress?: (done: number, total: number) => Promise<void> }): Promise<{ periods: string[]; rows: number }> {
  const periods = input.periods.map((p) => assertPeriod(p));
  const metrics = await collectMetrics(db, { periods, clientIds: input.clientIds ?? null, now: input.now });
  const clientIds = new Set((await db.select({ id: clients.id }).from(clients)).map((c) => c.id));
  const values: Array<typeof systemMetrics.$inferInsert> = [];
  for (const [key, m] of metrics) {
    const [cid, period] = key.split('|') as [string, string];
    if (!clientIds.has(cid)) continue;
    values.push({
      clientId: cid,
      period,
      totalTransactions: m.totalTransactions,
      autoApproved: m.autoApproved,
      noTouch: m.noTouch,
      reviewed: m.reviewed,
      corrected: m.corrected,
      exceptions: exceptionsOf(m),
      manualTouches: manualTouchesOf(m),
      payrollManualTouches: m.payrollManualTouches,
      reconErrors: m.reconErrors,
      processingSeconds: m.processingSeconds,
      computedAt: input.now,
    });
  }
  let done = 0;
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500);
    await db
      .insert(systemMetrics)
      .values(chunk)
      .onConflictDoUpdate({
        target: [systemMetrics.clientId, systemMetrics.period],
        set: {
          totalTransactions: sql`excluded.total_transactions`,
          autoApproved: sql`excluded.auto_approved`,
          noTouch: sql`excluded.no_touch`,
          reviewed: sql`excluded.reviewed`,
          corrected: sql`excluded.corrected`,
          exceptions: sql`excluded.exceptions`,
          manualTouches: sql`excluded.manual_touches`,
          payrollManualTouches: sql`excluded.payroll_manual_touches`,
          reconErrors: sql`excluded.recon_errors`,
          processingSeconds: sql`excluded.processing_seconds`,
          computedAt: sql`excluded.computed_at`,
        },
      });
    done += chunk.length;
    await input.onProgress?.(done, values.length);
  }
  // 스냅샷 기간에 더 이상 활동이 없는 수임처의 옛 행은 0으로 맞춘다 (이력 삭제 대신)
  if (periods.length > 0) {
    const keep = new Set(values.map((v) => `${v.clientId}|${v.period}`));
    const stale = await db
      .select({ id: systemMetrics.id, clientId: systemMetrics.clientId, period: systemMetrics.period })
      .from(systemMetrics)
      .where(and(inArray(systemMetrics.period, periods), isNotNull(systemMetrics.clientId)));
    const staleIds = stale.filter((s) => !keep.has(`${s.clientId}|${s.period}`) && (!input.clientIds || input.clientIds.includes(s.clientId!))).map((s) => s.id);
    for (let i = 0; i < staleIds.length; i += 500) {
      await db
        .update(systemMetrics)
        .set({ totalTransactions: 0, autoApproved: 0, noTouch: 0, reviewed: 0, corrected: 0, exceptions: 0, manualTouches: 0, payrollManualTouches: 0, reconErrors: 0, processingSeconds: 0, computedAt: input.now })
        .where(inArray(systemMetrics.id, staleIds.slice(i, i + 500)));
    }
  }
  return { periods, rows: values.length };
}
