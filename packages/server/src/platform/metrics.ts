/**
 * KPI 원천 집계 (docs/02-automation-matrix.md §4 — 산식의 기준). 수임처 × 기간 단위로 분자·분모를 모은다.
 *
 * 공통 정의 (§4.1)
 *   TX(c,p)  = client_id = c AND period = p (거래일 기준 귀속)
 *   E        = TX AND status NOT IN ('duplicate','failed')          ← KPI 모수
 *   C        = E AND status <> 'excluded'                           ← 분류 모수
 *   DONE     = status IN ('auto_approved','approved','exported','reconciled')
 *              (approved 는 touch_count = 0 조건과 함께일 때만 — 사람 승인은 touch_count ≥ 1 이므로 사실상 시스템 확정분)
 *   CORR     = classification_corrections 가 1건 이상 있는 E 거래
 *
 * 여러 기간·수임처를 한 번에 계산한다 (쿼리 수 고정: 6개, 기간·수임처 수와 무관).
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@mintax/db';
import { kstMonthStart, num, textArray, uuidArray } from './shared';

export interface MetricCounts {
  /** |E| */
  totalTransactions: number;
  /** 엔진이 자동확정으로 보낸 E (review_level = 'auto', 현재 상태 무관) */
  autoApproved: number;
  /** |E ∩ DONE ∩ touch_count = 0| */
  noTouch: number;
  /** |E ∩ review_level ∈ (quick_review, must_review)| — 검토로 라우팅된 건 */
  reviewed: number;
  /** |CORR| */
  corrected: number;
  correctedAccount: number;
  correctedVat: number;
  /** |C ∩ 엔진출처 ∩ 계정수정 없음| */
  autoClassified: number;
  /** |C| */
  classificationBase: number;
  /** Σ touch_count (TX 전체) */
  txTouches: number;
  autoCorrected: number;
  autoTouched: number;
  /** 거래 예외 (버킷 있음 + 검토 라우팅) */
  txExceptions: number;
  payrollExceptions: number;
  importFailedRows: number;
  exportFailed: number;
  /** 최신 phase 별 대사 보고서의 blocking 차이 (pending_review 제외) */
  reconErrors: number;
  /** 대사 보고서가 있는 phase 수 / 그중 차단 차이 0 */
  reconReports: number;
  reconCleanReports: number;
  payrollManualTouches: number;
  opsTouches: number;
  /** 사람 활동 초 (audit 간격 기반, §4.3 KPI 5) */
  processingSeconds: number;
  /** 작업(job) 실행 초 — 기계 처리시간 (payload 에 clientId/period 가 있는 작업) */
  systemSeconds: number;
  pendingReview: number;
  userRule: number;
  /** 반복 상대방 (new_merchant 아님) 거래 / 그중 자동확정 */
  repeatBase: number;
  repeatAuto: number;
  /** 원본 행 대비 유실: 수집 건수 − 원본행 기록 + 거래가 없는 ok/duplicate 행 */
  dataLoss: number;
  sourceRows: number;
  /** 이 수임처·기간에 활동이 있는가 (거래·급여월·수집) */
  active: boolean;
}

export function emptyCounts(): MetricCounts {
  return {
    totalTransactions: 0, autoApproved: 0, noTouch: 0, reviewed: 0, corrected: 0, correctedAccount: 0, correctedVat: 0,
    autoClassified: 0, classificationBase: 0, txTouches: 0, autoCorrected: 0, autoTouched: 0, txExceptions: 0,
    payrollExceptions: 0, importFailedRows: 0, exportFailed: 0, reconErrors: 0, reconReports: 0, reconCleanReports: 0,
    payrollManualTouches: 0, opsTouches: 0, processingSeconds: 0, systemSeconds: 0, pendingReview: 0, userRule: 0,
    repeatBase: 0, repeatAuto: 0, dataLoss: 0, sourceRows: 0, active: false,
  };
}

/** KPI 6: 예외 = 거래 예외 + 인건비 예외 + 대사 blocking + 수집 실패 행 + 전송 실패 */
export function exceptionsOf(m: MetricCounts): number {
  return m.txExceptions + m.payrollExceptions + m.reconErrors + m.importFailedRows + m.exportFailed;
}

/** KPI 9: 수동 터치 = Σ touch_count + 인건비 터치 + 운영 터치 (규칙 작성·승인은 학습 투자라 제외) */
export function manualTouchesOf(m: MetricCounts): number {
  return m.txTouches + m.payrollManualTouches + m.opsTouches;
}

export function addCounts(a: MetricCounts, b: MetricCounts): MetricCounts {
  const out = { ...a };
  for (const k of Object.keys(b) as Array<keyof MetricCounts>) {
    if (k === 'active') out.active = a.active || b.active;
    else (out[k] as number) = (a[k] as number) + (b[k] as number);
  }
  return out;
}

export type MetricKey = `${string}|${string}`;
export const metricKey = (clientId: string, period: string): MetricKey => `${clientId}|${period}`;

const UUID_RX = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * 수임처 × 기간별 원천 집계.
 * @param now 사람 활동 시간 창의 끝 (재계산 시점)
 */
export async function collectMetrics(db: Database, input: { periods: string[]; clientIds?: string[] | null; now: Date }): Promise<Map<MetricKey, MetricCounts>> {
  const periods = [...new Set(input.periods)].sort();
  const out = new Map<MetricKey, MetricCounts>();
  if (periods.length === 0) return out;
  const P = textArray(periods);
  const ids = input.clientIds && input.clientIds.length > 0 ? input.clientIds : null;
  const txClient = ids ? sql`and t.client_id = any(${uuidArray(ids)})` : sql``;
  const clientCol = (col: string) => (ids ? sql`and ${sql.raw(col)} = any(${uuidArray(ids)})` : sql``);
  const from = kstMonthStart(periods[0]!).toISOString();
  const to = input.now.toISOString();
  const E = sql`t.status not in ('duplicate', 'failed')`;

  const get = (clientId: string, period: string): MetricCounts => {
    const k = metricKey(clientId, period);
    let m = out.get(k);
    if (!m) out.set(k, (m = emptyCounts()));
    return m;
  };

  const [txR, payR, reconR, opsR, auditR, jobR] = await Promise.all([
    db.execute<Record<string, unknown> & { client_id: string; period: string }>(sql`
      with corr as (
        select cc.transaction_id, bool_or(cc.field = 'account') as acct, bool_or(cc.field = 'vat') as vat
        from classification_corrections cc
        join transactions t on t.id = cc.transaction_id
        where t.period = any(${P}) ${txClient}
        group by cc.transaction_id
      )
      select t.client_id, t.period,
        count(*) filter (where ${E})::int as total,
        count(*) filter (where ${E} and t.review_level = 'auto')::int as auto_approved,
        count(*) filter (where ${E} and t.touch_count = 0 and t.status in ('auto_approved', 'approved', 'exported', 'reconciled'))::int as no_touch,
        count(*) filter (where ${E} and t.review_level in ('quick_review', 'must_review'))::int as reviewed,
        count(*) filter (where ${E} and corr.transaction_id is not null)::int as corrected,
        count(*) filter (where ${E} and coalesce(corr.acct, false))::int as corrected_account,
        count(*) filter (where ${E} and coalesce(corr.vat, false))::int as corrected_vat,
        count(*) filter (where ${E} and t.status <> 'excluded' and t.account_code is not null
          and coalesce(t.classification_source, 'none') not in ('manual', 'none') and not coalesce(corr.acct, false))::int as auto_classified,
        count(*) filter (where ${E} and t.status <> 'excluded')::int as classification_base,
        coalesce(sum(t.touch_count), 0)::int as tx_touches,
        count(*) filter (where ${E} and t.review_level = 'auto' and corr.transaction_id is not null)::int as auto_corrected,
        count(*) filter (where ${E} and t.review_level = 'auto' and t.touch_count > 0)::int as auto_touched,
        count(*) filter (where ${E} and jsonb_array_length(t.buckets) > 0 and t.review_level in ('quick_review', 'must_review'))::int as tx_exceptions,
        count(*) filter (where ${E} and t.status = 'needs_review')::int as pending_review,
        count(*) filter (where ${E} and t.classification_source = 'user_rule')::int as user_rule,
        count(*) filter (where ${E} and not (t.buckets @> '["new_merchant"]'::jsonb))::int as repeat_base,
        count(*) filter (where ${E} and not (t.buckets @> '["new_merchant"]'::jsonb) and t.review_level = 'auto')::int as repeat_auto
      from transactions t
      left join corr on corr.transaction_id = t.id
      where t.period = any(${P}) ${txClient}
      group by t.client_id, t.period
    `),
    db.execute<{ client_id: string; period: string; payroll_exceptions: number }>(sql`
      select pm.client_id, pm.period, count(pi.id) filter (where pi.needs_review)::int as payroll_exceptions
      from payroll_months pm
      left join payroll_items pi on pi.payroll_month_id = pm.id
      where pm.period = any(${P}) ${clientCol('pm.client_id')}
      group by pm.client_id, pm.period
    `),
    db.execute<{ client_id: string; period: string; recon_errors: number; reports: number; clean: number }>(sql`
      select r.client_id, r.period,
        coalesce(sum(r.errs), 0)::int as recon_errors, count(*)::int as reports, count(*) filter (where r.errs = 0)::int as clean
      from (
        select l.client_id, l.period,
          (select count(*) from jsonb_array_elements(coalesce(l.report -> 'discrepancies', '[]'::jsonb)) d
            where coalesce((d ->> 'blocking')::boolean, false) and coalesce(d ->> 'kind', '') <> 'pending_review') as errs
        from (
          select distinct on (client_id, period, phase) client_id, period, report
          from reconciliation_jobs
          where period = any(${P}) ${clientCol('client_id')}
          order by client_id, period, phase, created_at desc
        ) l
      ) r
      group by r.client_id, r.period
    `),
    db.execute<{ client_id: string; period: string; k: string; n: number }>(sql`
      select ij.client_id, ij.period, 'import_failed' as k, coalesce(sum(ij.failed_rows), 0)::int as n
      from import_jobs ij where ij.period = any(${P}) and ij.client_id is not null ${clientCol('ij.client_id')}
      group by ij.client_id, ij.period
      union all
      select ij.client_id, ij.period, 'declared_rows', coalesce(sum(ij.total_rows), 0)::int
      from import_jobs ij where ij.period = any(${P}) and ij.client_id is not null and ij.status in ('succeeded', 'partial') ${clientCol('ij.client_id')}
      group by ij.client_id, ij.period
      union all
      select ij.client_id, ij.period, 'source_rows', count(ts.id)::int
      from import_jobs ij join transaction_sources ts on ts.import_job_id = ij.id
      where ij.period = any(${P}) and ij.client_id is not null and ij.status in ('succeeded', 'partial') ${clientCol('ij.client_id')}
      group by ij.client_id, ij.period
      union all
      select ij.client_id, ij.period, 'orphan_rows', count(ts.id)::int
      from import_jobs ij join transaction_sources ts on ts.import_job_id = ij.id
      left join transactions tx on tx.id = ts.transaction_id
      where ij.period = any(${P}) and ij.client_id is not null and ts.outcome in ('ok', 'duplicate') and tx.id is null ${clientCol('ij.client_id')}
      group by ij.client_id, ij.period
      union all
      select e.client_id, e.period, 'export_failed', count(*)::int
      from export_jobs e where e.period = any(${P}) and e.status = 'failed' ${clientCol('e.client_id')}
      group by e.client_id, e.period
    `),
    db.execute<{ client_id: string; period: string; processing_seconds: number; payroll_touches: number; ops_touches: number }>(sql`
      with ev as (
        select a.actor_id, a.client_id, a.category, a.entity_type, a.entity_id, a.created_at,
          lag(a.created_at) over w as prev_at, lag(a.client_id) over w as prev_client
        from audit_logs a
        where a.actor_id is not null and a.category in ('data_change', 'download')
          and a.created_at >= ${from}::timestamptz and a.created_at < ${to}::timestamptz
        window w as (partition by a.actor_id order by a.created_at, a.id)
      ),
      sec as (
        select ev.*,
          case when ev.client_id is not null and ev.prev_client = ev.client_id
               then least(extract(epoch from ev.created_at - ev.prev_at), 300) else 30 end as secs,
          case when ev.entity_id ~* ${UUID_RX} then ev.entity_id::uuid end as eid
        from ev
      ),
      attr as (
        select s.client_id, s.secs, s.category, s.entity_type, pme.period as employee_period,
          coalesce(t.period, ij.period, ej.period, fj.period, fjr.period, pm.period, pmi.period, pme.period,
                   to_char(s.created_at at time zone 'Asia/Seoul', 'YYYY-MM')) as period
        from sec s
        left join transactions t on t.id = case when s.entity_type = 'transaction' then s.eid end
        left join import_jobs ij on ij.id = case when s.entity_type = 'import_job' then s.eid end
        left join export_jobs ej on ej.id = case when s.entity_type = 'export_job' then s.eid end
        left join filing_jobs fj on fj.id = case when s.entity_type = 'filing_job' then s.eid end
        left join filing_results fr on fr.id = case when s.entity_type = 'filing_result' then s.eid end
        left join filing_jobs fjr on fjr.id = fr.filing_job_id
        left join payroll_months pm on pm.id = case when s.entity_type = 'payroll_month' then s.eid end
        left join payroll_items pit on pit.id = case when s.entity_type = 'payroll_item' then s.eid end
        left join payroll_months pmi on pmi.id = pit.payroll_month_id
        left join lateral (
          select p.period from payroll_months p
          where s.entity_type = 'employee' and p.client_id = s.client_id
            and s.created_at >= p.created_at and s.created_at < coalesce(p.confirmed_at, 'infinity'::timestamptz)
          order by p.created_at desc limit 1
        ) pme on true
      )
      select client_id, period,
        coalesce(sum(secs), 0)::int as processing_seconds,
        count(*) filter (where category = 'data_change' and (entity_type in ('payroll_item', 'payroll_month')
          or (entity_type = 'employee' and employee_period is not null)))::int as payroll_touches,
        count(*) filter (where entity_type in ('import_job', 'export_job', 'filing_job', 'filing_result'))::int as ops_touches
      from attr
      where client_id is not null and period = any(${P}) ${clientCol('client_id')}
      group by client_id, period
    `),
    db.execute<{ client_id: string; period: string; secs: number }>(sql`
      select c.cid as client_id, j.payload ->> 'period' as period,
        coalesce(sum(extract(epoch from (j.finished_at - j.started_at)) / greatest(1, c.n)), 0)::int as secs
      from jobs j
      cross join lateral (
        select x.cid, count(*) over () as n from (
          select (j.payload ->> 'clientId')::uuid as cid where coalesce(j.payload ->> 'clientId', '') ~* ${UUID_RX}
          union
          select v::uuid from jsonb_array_elements_text(case when jsonb_typeof(j.payload -> 'clientIds') = 'array' then j.payload -> 'clientIds' else '[]'::jsonb end) v
          where v ~* ${UUID_RX}
        ) x
      ) c
      where j.finished_at is not null and j.started_at is not null and j.payload ->> 'period' = any(${P}) ${clientCol('c.cid')}
      group by c.cid, j.payload ->> 'period'
    `),
  ]);

  for (const r of txR.rows) {
    const m = get(r.client_id, r.period);
    m.totalTransactions = num(r.total);
    m.autoApproved = num(r.auto_approved);
    m.noTouch = num(r.no_touch);
    m.reviewed = num(r.reviewed);
    m.corrected = num(r.corrected);
    m.correctedAccount = num(r.corrected_account);
    m.correctedVat = num(r.corrected_vat);
    m.autoClassified = num(r.auto_classified);
    m.classificationBase = num(r.classification_base);
    m.txTouches = num(r.tx_touches);
    m.autoCorrected = num(r.auto_corrected);
    m.autoTouched = num(r.auto_touched);
    m.txExceptions = num(r.tx_exceptions);
    m.pendingReview = num(r.pending_review);
    m.userRule = num(r.user_rule);
    m.repeatBase = num(r.repeat_base);
    m.repeatAuto = num(r.repeat_auto);
    m.active = true;
  }
  for (const r of payR.rows) {
    const m = get(r.client_id, r.period);
    m.payrollExceptions = num(r.payroll_exceptions);
    m.active = true;
  }
  for (const r of reconR.rows) {
    const m = get(r.client_id, r.period);
    m.reconErrors = num(r.recon_errors);
    m.reconReports = num(r.reports);
    m.reconCleanReports = num(r.clean);
  }
  const declared = new Map<MetricKey, number>();
  for (const r of opsR.rows) {
    const m = get(r.client_id, r.period);
    const k = metricKey(r.client_id, r.period);
    if (r.k === 'import_failed') {
      m.importFailedRows = num(r.n);
      m.active = true;
    } else if (r.k === 'declared_rows') declared.set(k, num(r.n));
    else if (r.k === 'source_rows') m.sourceRows = num(r.n);
    else if (r.k === 'orphan_rows') m.dataLoss += num(r.n);
    else if (r.k === 'export_failed') m.exportFailed = num(r.n);
  }
  for (const [k, n] of declared) {
    const m = out.get(k)!;
    m.dataLoss += Math.max(0, n - m.sourceRows);
  }
  for (const r of auditR.rows) {
    const m = get(r.client_id, r.period);
    m.processingSeconds = num(r.processing_seconds);
    m.payrollManualTouches = num(r.payroll_touches);
    m.opsTouches = num(r.ops_touches);
  }
  for (const r of jobR.rows) {
    const m = get(r.client_id, r.period);
    m.systemSeconds = num(r.secs);
  }
  return out;
}
