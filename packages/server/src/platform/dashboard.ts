/**
 * 대시보드 (/) — "오늘 사람이 처리할 일"만. 행동으로 이어지지 않는 수치(총 거래 수 자랑 등)는 두지 않는다 (docs/05 §5.1).
 *
 * 쿼리 수 고정 (수임처·거래 수와 무관): 거래 집계 1 + 기타(인건비·알림·작업·신고·AI) 1 + 전송센터 행 계산 6 = 8
 * - 자동처리율 = 엔진이 자동확정으로 보낸 거래(review_level='auto') ÷ KPI 모수 E (중복·실패 제외) — docs/02 §4.2 #3 의 1 − 검토비율과 같다
 *   (아직 분류 전인 거래는 자동으로 세지 않는다)
 * - No-touch = 사람 손길 0 + 완료 상태(auto_approved/approved/exported/reconciled) ÷ E — docs/02 §4.2 #1
 */
import { sql } from 'drizzle-orm';
import { previousYearMonth } from '@mintax/core';
import { requirePermission, type ServiceContext } from '../context';
import { getCurrentPeriod } from '../infra/settings';
import { computeTransferRows, type TransferRowDTO } from '../transfer';
import {
  ACCOUNT_GROUP_BUCKETS,
  FILING_DONE_STEPS,
  FILING_KIND_LABELS,
  FILING_STEP_LABELS,
  JOB_STATUS_LABELS,
  NOTIFICATION_KIND_LABELS,
  addDaysIso,
  assertPeriod,
  daysBetween,
  deltaPp,
  hrefs,
  iso,
  jobTypeLabel,
  kstDateOf,
  num,
  optionalUuid,
  percent,
  textArray,
} from './shared';

export type ActionBucketKey = 'vat_review' | 'account' | 'new_merchant' | 'payroll' | 'export_error' | 'reconciliation';

export interface ActionBucketDTO {
  key: ActionBucketKey;
  label: string;
  /** 건(거래) 또는 곳(수임처) — unit 참고 */
  count: number;
  unit: '건' | '곳';
  /** 거래 버킷의 금액 합계 (수임처 단위 버킷은 null) */
  amount: number | null;
  clients: number;
  href: string;
  /** 대표 예시 1건 */
  example: { merchantName: string; amount: number; clientName: string } | null;
  description: string;
}

export interface TransferReadyDTO {
  clientId: string;
  clientName: string;
  stageLabel: string;
  action: 'prepare' | 'download' | 'confirm_upload';
  actionLabel: string;
  approved: number;
  href: string;
}

export interface PayrollChangeClientDTO {
  clientId: string;
  clientName: string;
  payrollMonthId: string;
  status: string;
  changedEmployees: number;
  kinds: string[];
  href: string;
}

export interface FilingDueDTO {
  filingJobId: string;
  clientId: string;
  clientName: string;
  kind: string;
  kindLabel: string;
  period: string;
  dueDate: string;
  dDay: number;
  currentStep: string;
  currentStepLabel: string;
  href: string;
}

export interface ProblemBriefDTO {
  id: string;
  kind: string;
  kindLabel: string;
  severity: 'info' | 'warning' | 'high';
  title: string;
  body: string | null;
  href: string | null;
  clientId: string | null;
  clientName: string | null;
  read: boolean;
  createdAt: string;
}

export interface RunningJobDTO {
  id: string;
  type: string;
  typeLabel: string;
  status: string;
  statusLabel: string;
  progress: number;
  processedItems: number;
  totalItems: number;
  clientName: string | null;
  createdAt: string;
  startedAt: string | null;
  href: string;
}

export interface AiFindingBriefDTO {
  reviewId: string;
  index: number;
  clientId: string;
  clientName: string;
  code: string;
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'high';
  href: string;
}

export interface DashboardDTO {
  period: string;
  generatedAt: string;
  header: {
    period: string;
    /** 자동처리율 (%) — 분모 0 이면 null */
    autoRate: number | null;
    autoRateDeltaPp: number | null;
    noTouchRate: number | null;
    /** 수집 거래 (중복·실패 제외 E) */
    collected: number;
    /** 엔진 자동확정 거래 */
    autoProcessed: number;
    needsReview: number;
    needsReviewClients: number;
    /** 문제 수임처 수 (전송 차단 ∪ 대사 불일치 ∪ 수집 실패 행) */
    errors: number;
    links: { autoRate: string; noTouchRate: string; collected: string; autoProcessed: string; needsReview: string; errors: string };
  };
  actionBuckets: ActionBucketDTO[];
  transferReady: { count: number; clients: TransferReadyDTO[]; href: string };
  payrollChanges: { count: number; clients: PayrollChangeClientDTO[]; href: string; visible: boolean };
  filingDue: { count: number; items: FilingDueDTO[]; href: string };
  problems: { count: number; items: ProblemBriefDTO[]; href: string };
  runningJobs: { count: number; items: RunningJobDTO[] };
  aiFindings: { count: number; items: AiFindingBriefDTO[]; href: string };
  /** 처리할 일이 하나도 없음 */
  empty: boolean;
  emptyMessage: string | null;
}

interface TxAgg {
  period: string;
  e: number;
  auto_routed: number;
  no_touch: number;
  needs_review: number;
  needs_review_clients: number;
  vat_n: number;
  vat_amt: number;
  vat_c: number;
  acc_n: number;
  acc_amt: number;
  acc_c: number;
  new_n: number;
  new_amt: number;
  new_c: number;
  exp_n: number;
  exp_clients: string[] | null;
}

const LIST_LIMIT = 10;

/** 대시보드 */
export async function getDashboard(ctx: ServiceContext, input: { period?: string; assigneeId?: string | null } = {}): Promise<DashboardDTO> {
  requirePermission(ctx, 'transactions.read');
  const period = input.period ? assertPeriod(input.period) : await getCurrentPeriod(ctx);
  const assigneeId = optionalUuid(input.assigneeId, 'assigneeId', '담당자');
  const prev = previousYearMonth(period);
  const me = ctx.actor.userId;
  const today = kstDateOf(ctx.now());
  const dueLimit = addDaysIso(today, 7);
  const canPayroll = ctx.actor.permissions.has('payroll.read');
  const accountBuckets = textArray(ACCOUNT_GROUP_BUCKETS);
  const assigneeCond = assigneeId ? sql`and c.assignee_id = ${assigneeId}::uuid` : sql``;
  const nr = sql`t.status = 'needs_review'`;
  const vat = sql`${nr} and t.buckets @> '["vat_review"]'::jsonb`;
  const acc = sql`${nr} and t.buckets ?| ${accountBuckets}`;
  const nm = sql`${nr} and t.buckets @> '["new_merchant"]'::jsonb`;
  const exp = sql`t.buckets @> '["export_error"]'::jsonb and t.status in ('approved', 'auto_approved', 'exported')`;
  const doneFilter = textArray(FILING_DONE_STEPS);

  const [txRes, miscRes, transferRows] = await Promise.all([
    ctx.db.execute<TxAgg>(sql`
      select t.period,
        count(*) filter (where t.status not in ('duplicate', 'failed'))::int as e,
        count(*) filter (where t.status not in ('duplicate', 'failed') and t.review_level = 'auto')::int as auto_routed,
        count(*) filter (where t.status in ('auto_approved', 'approved', 'exported', 'reconciled') and t.touch_count = 0)::int as no_touch,
        count(*) filter (where ${nr})::int as needs_review,
        count(distinct t.client_id) filter (where ${nr})::int as needs_review_clients,
        count(*) filter (where ${vat})::int as vat_n,
        coalesce(sum(t.total_amount) filter (where ${vat}), 0)::bigint as vat_amt,
        count(distinct t.client_id) filter (where ${vat})::int as vat_c,
        count(*) filter (where ${acc})::int as acc_n,
        coalesce(sum(t.total_amount) filter (where ${acc}), 0)::bigint as acc_amt,
        count(distinct t.client_id) filter (where ${acc})::int as acc_c,
        count(*) filter (where ${nm})::int as new_n,
        coalesce(sum(t.total_amount) filter (where ${nm}), 0)::bigint as new_amt,
        count(distinct t.client_id) filter (where ${nm})::int as new_c,
        count(*) filter (where ${exp})::int as exp_n,
        array_agg(distinct t.client_id::text) filter (where ${exp}) as exp_clients
      from transactions t
      join clients c on c.id = t.client_id and c.active ${assigneeCond}
      where t.period in (${period}, ${prev})
      group by t.period
    `),
    ctx.db.execute<{
      examples: Array<{ key: string; merchant_name: string; total_amount: number; client_name: string }> | null;
      payroll: Array<{ client_id: string; client_name: string; payroll_month_id: string; status: string; changed: number; kinds: string[] | null }> | null;
      problem_count: number;
      problems: Array<{ id: string; kind: string; severity: 'info' | 'warning' | 'high'; title: string; body: string | null; href: string | null; client_id: string | null; client_name: string | null; read_at: string | null; created_at: string }> | null;
      job_count: number;
      jobs: Array<{ id: string; type: string; status: string; progress: number; processed_items: number; total_items: number; client_name: string | null; created_at: string; started_at: string | null }> | null;
      filing_count: number;
      filings: Array<{ id: string; client_id: string; client_name: string; kind: string; period: string; due_date: string; current_step: string }> | null;
      ai_count: number;
      ai: Array<{ review_id: string; idx: number; client_id: string; client_name: string; finding: Record<string, unknown> }> | null;
    }>(sql`
      select
        (select json_agg(x) from (
          select b.key, ex.merchant_name, ex.total_amount, ex.client_name
          from (values ('vat_review'), ('account'), ('new_merchant')) as b(key)
          cross join lateral (
            select t.merchant_name, t.total_amount, c.name as client_name
            from transactions t join clients c on c.id = t.client_id and c.active ${assigneeCond}
            where t.period = ${period} and t.status = 'needs_review'
              and case b.key when 'vat_review' then t.buckets @> '["vat_review"]'::jsonb
                             when 'account' then t.buckets ?| ${accountBuckets}
                             else t.buckets @> '["new_merchant"]'::jsonb end
            order by t.total_amount desc, t.id limit 1
          ) ex
        ) x) as examples,
        ${
          canPayroll
            ? sql`(select json_agg(x order by x.changed desc, x.client_name) from (
          select pm.client_id, c.name as client_name, pm.id as payroll_month_id, pm.status,
            count(*)::int as changed,
            (select jsonb_agg(distinct k) from payroll_items p2 cross join lateral jsonb_array_elements_text(p2.change_kinds) as k
              where p2.payroll_month_id = pm.id and p2.needs_review and p2.reviewed_at is null) as kinds
          from payroll_months pm
          join clients c on c.id = pm.client_id and c.active ${assigneeCond}
          join payroll_items pi on pi.payroll_month_id = pm.id and pi.needs_review and pi.reviewed_at is null
          where pm.period = ${period}
          group by pm.client_id, c.name, pm.id, pm.status
        ) x)`
            : sql`null::json`
        } as payroll,
        (select count(*)::int from notifications n
          where n.resolved_at is null and (n.user_id is null ${me ? sql`or n.user_id = ${me}::uuid` : sql``})) as problem_count,
        (select json_agg(x) from (
          select n.id, n.kind, n.severity, n.title, n.body, n.href, n.client_id, c.name as client_name, n.read_at, n.created_at
          from notifications n left join clients c on c.id = n.client_id
          where n.resolved_at is null and (n.user_id is null ${me ? sql`or n.user_id = ${me}::uuid` : sql``})
          order by case n.severity when 'high' then 0 when 'warning' then 1 else 2 end, n.created_at desc
          limit ${LIST_LIMIT}
        ) x) as problems,
        (select count(*)::int from jobs j where j.status in ('queued', 'running')) as job_count,
        (select json_agg(x) from (
          select j.id, j.type, j.status, j.progress, j.processed_items, j.total_items, c.name as client_name, j.created_at, j.started_at
          from jobs j
          left join clients c on c.id = case when j.payload ->> 'clientId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                             then (j.payload ->> 'clientId')::uuid end
          where j.status in ('queued', 'running')
          order by (j.status = 'running') desc, j.created_at asc
          limit ${LIST_LIMIT}
        ) x) as jobs,
        (select count(*)::int from filing_jobs f join clients c on c.id = f.client_id and c.active ${assigneeCond}
          where f.due_date is not null and f.due_date <= ${dueLimit}::date and not (f.current_step = any(${doneFilter}))) as filing_count,
        (select json_agg(x) from (
          select f.id, f.client_id, c.name as client_name, f.kind, f.period, f.due_date, f.current_step
          from filing_jobs f join clients c on c.id = f.client_id and c.active ${assigneeCond}
          where f.due_date is not null and f.due_date <= ${dueLimit}::date and not (f.current_step = any(${doneFilter}))
          order by f.due_date asc, c.name
          limit ${LIST_LIMIT}
        ) x) as filings,
        (select count(*)::int from (
          select distinct on (r.client_id, r.kind) r.id, r.findings from ai_reviews r
          join clients c on c.id = r.client_id and c.active ${assigneeCond}
          where r.period = ${period} and r.status = 'open'
          order by r.client_id, r.kind, r.created_at desc
        ) lr cross join lateral jsonb_array_elements(lr.findings) as f(finding)
          where f.finding ->> 'ackAt' is null) as ai_count,
        (select json_agg(x) from (
          select lr.id as review_id, (f.ord - 1)::int as idx, lr.client_id, lr.client_name, f.finding
          from (
            select distinct on (r.client_id, r.kind) r.id, r.client_id, c.name as client_name, r.findings from ai_reviews r
            join clients c on c.id = r.client_id and c.active ${assigneeCond}
            where r.period = ${period} and r.status = 'open'
            order by r.client_id, r.kind, r.created_at desc
          ) lr cross join lateral jsonb_array_elements(lr.findings) with ordinality as f(finding, ord)
          where f.finding ->> 'ackAt' is null
          order by case f.finding ->> 'severity' when 'high' then 0 when 'warning' then 1 else 2 end, lr.client_name
          limit 5
        ) x) as ai
    `),
    computeTransferRows(ctx.db, { period, assigneeId: assigneeId ?? undefined }),
  ]);

  const byPeriod = new Map(txRes.rows.map((r) => [r.period, r] as const));
  const cur = byPeriod.get(period);
  const old = byPeriod.get(prev);
  const e = num(cur?.e);
  const autoRouted = num(cur?.auto_routed);
  const autoRate = percent(autoRouted, e);
  const prevAutoRate = old ? percent(num(old.auto_routed), num(old.e)) : null;
  const misc = miscRes.rows[0]!;

  const blocked = transferRows.filter((r) => r.blockers.some((b) => b.code === 'export_blocked'));
  const mismatch = transferRows.filter((r) => r.reconStatus === 'mismatch');
  const failedRows = transferRows.filter((r) => r.failedRows > 0);
  const exportErrorClients = new Set<string>([...blocked.map((r) => r.clientId), ...(cur?.exp_clients ?? [])]);
  const problemClients = new Set<string>([...blocked, ...mismatch, ...failedRows].map((r) => r.clientId));
  for (const id of cur?.exp_clients ?? []) problemClients.add(id);

  const ex = new Map((misc.examples ?? []).map((x) => [x.key, { merchantName: x.merchant_name, amount: num(x.total_amount), clientName: x.client_name }] as const));
  const payroll = (misc.payroll ?? []).map<PayrollChangeClientDTO>((p) => ({
    clientId: p.client_id,
    clientName: p.client_name,
    payrollMonthId: p.payroll_month_id,
    status: p.status,
    changedEmployees: num(p.changed),
    kinds: Array.isArray(p.kinds) ? p.kinds : [],
    href: hrefs.payrollWizard(p.client_id, period),
  }));

  const actionBuckets: ActionBucketDTO[] = [
    {
      key: 'vat_review',
      label: '부가세 판단',
      count: num(cur?.vat_n),
      unit: '건',
      amount: num(cur?.vat_amt),
      clients: num(cur?.vat_c),
      href: hrefs.inbox({ period, bucket: 'vat_review' }),
      example: ex.get('vat_review') ?? null,
      description: '공제/불공제 판단이 필요한 거래',
    },
    {
      key: 'account',
      label: '계정분류',
      count: num(cur?.acc_n),
      unit: '건',
      amount: num(cur?.acc_amt),
      clients: num(cur?.acc_c),
      href: hrefs.inbox({ period, bucket: ACCOUNT_GROUP_BUCKETS.join(',') }),
      example: ex.get('account') ?? null,
      description: '저신뢰도 · 계정 충돌 · 미분류 · 전월과 다른 분개',
    },
    {
      key: 'new_merchant',
      label: '신규거래',
      count: num(cur?.new_n),
      unit: '건',
      amount: num(cur?.new_amt),
      clients: num(cur?.new_c),
      href: hrefs.inbox({ period, bucket: 'new_merchant' }),
      example: ex.get('new_merchant') ?? null,
      description: '처음 거래하는 상대방',
    },
    {
      key: 'payroll',
      label: '인건비 변동',
      count: payroll.length,
      unit: '곳',
      amount: null,
      clients: payroll.length,
      href: hrefs.payroll({ period, filter: 'changes' }),
      example: null,
      description: canPayroll ? `미검토 변동 ${payroll.reduce((s, p) => s + p.changedEmployees, 0)}명` : '인건비 조회 권한이 없습니다',
    },
    {
      key: 'export_error',
      label: 'WEHAGO 오류',
      count: exportErrorClients.size,
      unit: '곳',
      amount: null,
      clients: exportErrorClients.size,
      href: num(cur?.exp_n) > 0 && blocked.length === 0 ? hrefs.inbox({ period, bucket: 'export_error' }) : hrefs.transfer({ period, status: 'blocked' }),
      example: null,
      description: `전송파일 차단 ${blocked.length}곳 · 전송오류 거래 ${num(cur?.exp_n)}건`,
    },
    {
      key: 'reconciliation',
      label: 'Reconciliation 불일치',
      count: mismatch.length,
      unit: '곳',
      amount: null,
      clients: mismatch.length,
      href: hrefs.transfer({ period, recon: 'mismatch' }),
      example: null,
      description: `차단 차이 ${mismatch.reduce((s, r) => s + r.reconMismatch, 0)}건 (검토 대기 제외)`,
    },
  ];

  const ready = transferRows.filter((r) => r.eligibleForPrepare || r.nextAction.code === 'download' || r.nextAction.code === 'confirm_upload');
  const transferReady = ready.map<TransferReadyDTO>((r: TransferRowDTO) => {
    const action = r.eligibleForPrepare ? 'prepare' : r.nextAction.code === 'download' ? 'download' : 'confirm_upload';
    return {
      clientId: r.clientId,
      clientName: r.name,
      stageLabel: r.stageLabel,
      action,
      actionLabel: r.eligibleForPrepare ? '전송 준비' : r.nextAction.label,
      approved: r.approved,
      href: r.eligibleForPrepare ? hrefs.transfer({ period, client: r.clientId }) : (r.nextAction.href ?? hrefs.transfer({ period, client: r.clientId })),
    };
  });

  const filingItems = (misc.filings ?? []).map<FilingDueDTO>((f) => ({
    filingJobId: f.id,
    clientId: f.client_id,
    clientName: f.client_name,
    kind: f.kind,
    kindLabel: FILING_KIND_LABELS[f.kind] ?? f.kind,
    period: f.period,
    dueDate: f.due_date,
    dDay: daysBetween(today, f.due_date),
    currentStep: f.current_step,
    currentStepLabel: FILING_STEP_LABELS[f.current_step] ?? f.current_step,
    href: hrefs.filing({ period: f.period, client: f.client_id }),
  }));

  const problems = (misc.problems ?? []).map<ProblemBriefDTO>((n) => ({
    id: n.id,
    kind: n.kind,
    kindLabel: NOTIFICATION_KIND_LABELS[n.kind] ?? n.kind,
    severity: n.severity,
    title: n.title,
    body: n.body,
    href: n.href,
    clientId: n.client_id,
    clientName: n.client_name,
    read: n.read_at !== null,
    createdAt: iso(n.created_at)!,
  }));

  const jobs = (misc.jobs ?? []).map<RunningJobDTO>((j) => ({
    id: j.id,
    type: j.type,
    typeLabel: jobTypeLabel(j.type),
    status: j.status,
    statusLabel: JOB_STATUS_LABELS[j.status] ?? j.status,
    progress: num(j.progress),
    processedItems: num(j.processed_items),
    totalItems: num(j.total_items),
    clientName: j.client_name,
    createdAt: iso(j.created_at)!,
    startedAt: iso(j.started_at),
    href: hrefs.job(j.id),
  }));

  const ai = (misc.ai ?? []).map<AiFindingBriefDTO>((a) => {
    const f = a.finding as { code?: string; title?: string; detail?: string; severity?: 'info' | 'warning' | 'high'; action?: { href?: string } };
    return {
      reviewId: a.review_id,
      index: num(a.idx),
      clientId: a.client_id,
      clientName: a.client_name,
      code: String(f.code ?? ''),
      title: String(f.title ?? ''),
      detail: String(f.detail ?? ''),
      severity: f.severity ?? 'info',
      href: f.action?.href ?? hrefs.review({ period, client: a.client_id }),
    };
  });

  const needsReview = num(cur?.needs_review);
  const actionable =
    needsReview + actionBuckets.reduce((s, b) => s + b.count, 0) + transferReady.length + filingItems.length + num(misc.problem_count) + num(misc.ai_count);
  return {
    period,
    generatedAt: ctx.now().toISOString(),
    header: {
      period,
      autoRate,
      autoRateDeltaPp: deltaPp(autoRate, prevAutoRate),
      noTouchRate: percent(num(cur?.no_touch), e),
      collected: e,
      autoProcessed: autoRouted,
      needsReview,
      needsReviewClients: num(cur?.needs_review_clients),
      errors: problemClients.size,
      links: {
        autoRate: hrefs.kpi({ period, metric: 'auto_rate' }),
        noTouchRate: hrefs.kpi({ period, metric: 'no_touch' }),
        collected: hrefs.imports({ period }),
        autoProcessed: hrefs.kpi({ period, metric: 'auto_rate' }),
        needsReview: hrefs.inbox({ period }),
        errors: hrefs.transfer({ period, filter: 'problems' }),
      },
    },
    actionBuckets,
    transferReady: { count: transferReady.length, clients: transferReady.slice(0, 20), href: hrefs.transfer({ period }) },
    payrollChanges: { count: payroll.length, clients: payroll.slice(0, LIST_LIMIT), href: hrefs.payroll({ period, filter: 'changes' }), visible: canPayroll },
    filingDue: { count: num(misc.filing_count), items: filingItems, href: hrefs.filing({ due: '7' }) },
    problems: { count: num(misc.problem_count), items: problems, href: '/notifications' },
    runningJobs: { count: num(misc.job_count), items: jobs },
    aiFindings: { count: num(misc.ai_count), items: ai, href: hrefs.review({ period }) },
    empty: actionable === 0,
    emptyMessage:
      actionable === 0
        ? `검토할 거래가 없습니다. ${period} 자동처리율 ${autoRate === null ? '—' : `${autoRate}%`} · 다음 단계: WEHAGO 전송센터`
        : null,
  };
}
