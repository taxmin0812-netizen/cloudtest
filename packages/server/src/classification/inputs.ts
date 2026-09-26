/**
 * 분류 입력 적재 — 한 수임처·한 기간을 분류하는 데 필요한 모든 자료를 몇 번의 집계 SQL 로 읽는다 (N+1 없음).
 *
 * - 거래처 프로필, 규칙(수임처 + 공통 system_default), 수임처 확정 이력(24개월), 타 수임처 이력(배치 상대방으로 제한, 집계),
 *   수정 기록(12개월), 계정과목표, 부가세·위험 규칙(수임처 override 포함), 계정별 월합계, 신뢰도 정책.
 * - 이력은 "확정" 상태(approved / auto_approved / exported / reconciled) + account_code 가 있는 거래만. 분류 대상 거래는 제외.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@mintax/db';
import {
  DEFAULT_ACCOUNT_CODES,
  type DirectedCorrectionRecord,
  type DirectedHistoryEntry,
} from '@mintax/core/engine/classify-index';
import {
  DEFAULT_REVIEW_RULES,
  DEFAULT_VAT_RULES,
  REVIEW_RULE_KINDS,
  resolveRuleParams,
  resolveRulesForClient,
  type AccountMonthlyTotal,
  type ReviewRuleDef,
  type ReviewRuleKind,
  type VatRuleDef,
} from '@mintax/core/engine/vat-risk-index';
import type {
  AccountCode,
  ClientProfile,
  Condition,
  ConfidencePolicy,
  Direction,
  ExceptionBucket,
  IndustryKey,
  MappingRule,
  MappingRuleOrigin,
  MappingRuleStatus,
  RiskSeverity,
} from '@mintax/core';
import { getConfidencePolicy } from '../infra/settings';
import { loadClientProfile } from '../infra/clients';
import { dictionaryIdForRow } from '../rules/system-ids';
import { FINALIZED_STATUSES, PENDING_STATUSES, addMonths, assertPeriod, periodBounds, trailingWindow } from './helpers';

export type LoadedClientProfile = ClientProfile & { code: string; ruleParams: Record<string, number | string | boolean> };

export interface LoadClassificationInputsOptions {
  clientId: string;
  period: string;
  /** 타 수임처 이력 조회 대상 상대방 (정규화 상호키). 생략하면 이 기간 미처리 거래의 상대방 */
  merchantKeys?: readonly string[];
  /** 타 수임처 이력 조회 대상 상대방 사업자번호 */
  bizNos?: readonly string[];
  /** 이력·월합계에서 뺄 거래 (지금 분류하는 거래) */
  excludeTransactionIds?: readonly string[];
  /** 수임처 이력 기간 (기본 24개월) */
  historyMonths?: number;
  /** 수정 기록 기간 (기본 12개월) */
  correctionMonths?: number;
  /** 타 수임처 집계 1행을 이력 항목 몇 개까지 펼칠지 (기본 20) */
  peerExpandCap?: number;
}

export interface ClassificationInputs {
  client: LoadedClientProfile;
  period: string;
  periodStart: string;
  periodEnd: string;
  /** 엔진 기준일 (기간 말일) */
  asOfDate: string;
  /** 엔진용 규칙 (사전 행은 사전 id 로 치환) */
  rules: MappingRule[];
  /** 엔진 규칙 id → mapping_rules.id (적용 횟수 기록·근거 링크용) */
  ruleDbIds: Map<string, string>;
  history: DirectedHistoryEntry[];
  peerHistory: DirectedHistoryEntry[];
  corrections: DirectedCorrectionRecord[];
  accounts: AccountCode[];
  accountsSource: 'db' | 'default';
  vatRules: VatRuleDef[];
  vatRulesSource: 'db' | 'default' | 'default+client';
  reviewRules: ReviewRuleDef[];
  reviewRulesSource: 'db' | 'default' | 'default+client';
  accountMonthlyTotals: Record<string, AccountMonthlyTotal[]>;
  policy: ConfidencePolicy;
  stats: {
    historyRows: number;
    peerGroups: number;
    peerEntries: number;
    peerClients: number;
    corrections: number;
    mappingRules: number;
    loadMs: number;
  };
}

const FINAL = sql.raw(`(${FINALIZED_STATUSES.map((s) => `'${s}'`).join(', ')})`);

function uuidArray(ids: readonly string[]) {
  return sql`${sql.param([...ids])}::uuid[]`;
}
function textArray(values: readonly string[]) {
  return sql`${sql.param([...values])}::text[]`;
}

/** 계정과목표: account_codes 테이블, 비어 있으면 DEFAULT_ACCOUNT_CODES */
export async function loadAccountCodes(db: Database): Promise<{ accounts: AccountCode[]; source: 'db' | 'default' }> {
  const r = await db.execute<{
    code: string;
    name: string;
    category: AccountCode['category'];
    is_fixed_asset: boolean;
    vat_non_deductible_hint: boolean;
    active: boolean;
  }>(sql`select code, name, category, is_fixed_asset, vat_non_deductible_hint, active from account_codes order by code`);
  if (r.rows.length === 0) return { accounts: DEFAULT_ACCOUNT_CODES.map((a) => ({ ...a })), source: 'default' };
  return {
    accounts: r.rows.map((a) => ({
      code: a.code,
      name: a.name,
      category: a.category,
      isFixedAsset: a.is_fixed_asset,
      vatNonDeductibleHint: a.vat_non_deductible_hint,
      active: a.active,
    })),
    source: 'db',
  };
}

type MappingRuleRow = {
  id: string;
  client_id: string | null;
  name: string;
  condition: Condition;
  account_code: string;
  account_name: string;
  vat_override: { deductible: boolean; reasonCode?: string } | null;
  confidence: number;
  priority: number;
  status: MappingRuleStatus;
  origin: MappingRuleOrigin;
};

/**
 * 엔진용 매핑 규칙: 이 수임처의 활성 규칙 + 공통(system_default) 규칙 전부(비활성 포함 — DB 에서 끈 사전 규칙이 내장 사전을 끄도록).
 */
export async function loadMappingRulesForClient(db: Database, clientId: string): Promise<{ rules: MappingRule[]; ruleDbIds: Map<string, string> }> {
  const r = await db.execute<MappingRuleRow>(sql`
    select id, client_id, name, condition, account_code, account_name, vat_override, confidence, priority, status, origin
    from mapping_rules
    where (client_id = ${clientId} and status = 'active')
       or (origin = 'system_default' and (client_id is null or client_id = ${clientId}))
  `);
  const ruleDbIds = new Map<string, string>();
  const rules: MappingRule[] = [];
  for (const row of r.rows) {
    const dictId = dictionaryIdForRow({ id: row.id, name: row.name, accountCode: row.account_code, origin: row.origin, clientId: row.client_id });
    const engineId = dictId ?? row.id;
    ruleDbIds.set(engineId, row.id);
    ruleDbIds.set(row.id, row.id);
    rules.push({
      id: engineId,
      clientId: row.client_id,
      name: row.name,
      condition: row.condition,
      accountCode: row.account_code,
      accountName: row.account_name,
      vatOverride: row.vat_override ?? null,
      confidence: row.confidence,
      priority: row.priority,
      status: row.status,
      origin: row.origin,
    });
  }
  return { rules, ruleDbIds };
}

type VatRuleRow = {
  id: string;
  code: string;
  name: string;
  condition: Condition;
  outcome: VatRuleDef['outcome'];
  reason_text: string;
  legal_basis: string | null;
  confidence: number;
  priority: number;
  client_id: string | null;
  active: boolean;
};

/** 부가세 규칙: 공통 + 이 수임처 override. 공통 행이 하나도 없으면 DEFAULT_VAT_RULES 를 공통으로 쓴다 */
export async function loadVatRulesForClient(db: Database, clientId: string): Promise<{ rules: VatRuleDef[]; source: ClassificationInputs['vatRulesSource'] }> {
  const r = await db.execute<VatRuleRow>(sql`
    select id, code, name, condition, outcome, reason_text, legal_basis, confidence, priority, client_id, active
    from vat_rules where client_id is null or client_id = ${clientId}
  `);
  const rows: VatRuleDef[] = r.rows.map((x) => ({
    id: x.id,
    code: x.code,
    name: x.name,
    condition: x.condition,
    outcome: x.outcome,
    reasonText: x.reason_text,
    legalBasis: x.legal_basis,
    confidence: x.confidence,
    priority: x.priority,
    clientId: x.client_id,
    active: x.active,
  }));
  const hasGlobal = rows.some((x) => !x.clientId);
  if (hasGlobal) return { rules: rows, source: 'db' };
  const defaults = DEFAULT_VAT_RULES.map((d) => ({ ...d, clientId: null, active: true }));
  return { rules: [...defaults, ...rows], source: rows.length > 0 ? 'default+client' : 'default' };
}

type ReviewRuleRow = {
  id: string;
  code: string;
  name: string;
  kind: string;
  condition: Condition | null;
  params: Record<string, number | string | boolean | string[]>;
  bucket: ExceptionBucket;
  severity: RiskSeverity;
  blocks_auto_approval: boolean;
  message_template: string;
  client_id: string | null;
  active: boolean;
};

/** 위험 규칙: 공통 + 이 수임처 override. 공통 행이 없으면 DEFAULT_REVIEW_RULES */
export async function loadReviewRulesForClient(db: Database, clientId: string): Promise<{ rules: ReviewRuleDef[]; source: ClassificationInputs['reviewRulesSource'] }> {
  const r = await db.execute<ReviewRuleRow>(sql`
    select id, code, name, kind, condition, params, bucket, severity, blocks_auto_approval, message_template, client_id, active
    from review_rules where client_id is null or client_id = ${clientId}
  `);
  const rows: ReviewRuleDef[] = r.rows
    .filter((x) => (REVIEW_RULE_KINDS as readonly string[]).includes(x.kind))
    .map((x) => ({
      id: x.id,
      code: x.code,
      name: x.name,
      kind: x.kind as ReviewRuleKind,
      condition: x.condition ?? null,
      params: x.params ?? {},
      bucket: x.bucket,
      severity: x.severity,
      blocksAutoApproval: x.blocks_auto_approval,
      messageTemplate: x.message_template,
      clientId: x.client_id,
      active: x.active,
    }));
  const hasGlobal = rows.some((x) => !x.clientId);
  if (hasGlobal) return { rules: rows, source: 'db' };
  const defaults = DEFAULT_REVIEW_RULES.map((d) => ({ ...d, clientId: null, active: true }));
  return { rules: [...defaults, ...rows], source: rows.length > 0 ? 'default+client' : 'default' };
}

/** account_spike 규칙이 보는 최대 개월 수 (수임처 파라미터 override 반영, 기본 3) */
export function spikeLookbackMonths(rules: readonly ReviewRuleDef[], clientId: string, ruleParams: Record<string, number | string | boolean>): number {
  let max = 3;
  for (const r of resolveRulesForClient(rules, clientId)) {
    if (r.kind !== 'account_spike') continue;
    const n = Math.trunc(Number(resolveRuleParams(r, ruleParams).lookbackMonths));
    if (Number.isFinite(n) && n > max) max = Math.min(n, 24);
  }
  return max;
}

/**
 * 분류에 필요한 입력 전부. DB 호출: 프로필 1 + 규칙 3 + 계정 1 + 정책 1 + 이력 1 + 타 수임처 1 + 수정 1 + 월합계 1 (+ 상대방 목록 1).
 */
export async function loadClassificationInputs(db: Database, opts: LoadClassificationInputsOptions): Promise<ClassificationInputs> {
  const t0 = performance.now();
  const period = assertPeriod(opts.period);
  const { clientId } = opts;
  const { start: periodStart, end: periodEnd } = periodBounds(period);
  const historyWindow = trailingWindow(period, opts.historyMonths ?? 24);
  const exclude = [...new Set(opts.excludeTransactionIds ?? [])];
  const excludeCond = exclude.length > 0 ? sql`and t.id <> all(${uuidArray(exclude)})` : sql``;
  const cap = Math.max(1, Math.trunc(opts.peerExpandCap ?? 20));

  const client = await loadClientProfile({ db }, clientId);

  // 배치 상대방 (타 수임처 이력 제한용)
  let merchantKeys = opts.merchantKeys ? [...opts.merchantKeys] : null;
  let bizNos = opts.bizNos ? [...opts.bizNos] : null;
  if (!merchantKeys && !bizNos) {
    const pend = sql.raw(`(${PENDING_STATUSES.map((s) => `'${s}'`).join(', ')})`);
    const r = await db.execute<{ merchant_key: string; merchant_business_number: string | null }>(sql`
      select distinct merchant_key, merchant_business_number from transactions t
      where t.client_id = ${clientId} and t.period = ${period} and t.status in ${pend}
    `);
    merchantKeys = r.rows.map((x) => x.merchant_key);
    bizNos = r.rows.map((x) => x.merchant_business_number).filter((x): x is string => !!x);
  }
  const keys = [...new Set((merchantKeys ?? []).filter((k) => k && k.trim() !== ''))];
  const biz = [...new Set((bizNos ?? []).filter((b) => b && b.trim() !== ''))];

  const [mapping, vat, review, accts, policy] = await Promise.all([
    loadMappingRulesForClient(db, clientId),
    loadVatRulesForClient(db, clientId),
    loadReviewRulesForClient(db, clientId),
    loadAccountCodes(db),
    getConfidencePolicy({ db }),
  ]);

  // ── 수임처 확정 이력 (24개월, 분류 대상 제외) ──
  const histR = await db.execute<{
    merchant_key: string;
    merchant_business_number: string | null;
    account_code: string;
    account_name: string | null;
    transaction_date: string;
    total_amount: number;
    direction: Direction;
    corrected: boolean;
  }>(sql`
    select t.merchant_key, t.merchant_business_number, t.account_code, t.account_name, t.transaction_date, t.total_amount, t.direction,
           (coalesce(t.classification_source, '') = 'manual' or c.transaction_id is not null) as corrected
    from transactions t
    left join (
      select distinct transaction_id from classification_corrections where client_id = ${clientId} and field = 'account'
    ) c on c.transaction_id = t.id
    where t.client_id = ${clientId}
      and t.status in ${FINAL}
      and t.account_code is not null
      and t.transaction_date >= ${historyWindow.from} and t.transaction_date <= ${historyWindow.to}
      ${excludeCond}
  `);
  const history: DirectedHistoryEntry[] = histR.rows.map((x) => ({
    clientId,
    merchantKey: x.merchant_key,
    merchantBusinessNumber: x.merchant_business_number,
    accountCode: x.account_code,
    accountName: x.account_name ?? x.account_code,
    transactionDate: x.transaction_date,
    totalAmount: x.total_amount,
    corrected: x.corrected,
    industry: client.industry,
    direction: x.direction,
  }));

  // ── 타 수임처 이력: 배치 상대방으로 제한, (수임처·업종·상대방·방향·계정) 단위 집계 ──
  const peerHistory: DirectedHistoryEntry[] = [];
  let peerGroups = 0;
  const peerClientSet = new Set<string>();
  if (keys.length > 0 || biz.length > 0) {
    const partyCond =
      keys.length > 0 && biz.length > 0
        ? sql`(t.merchant_key = any(${textArray(keys)}) or t.merchant_business_number = any(${textArray(biz)}))`
        : keys.length > 0
          ? sql`t.merchant_key = any(${textArray(keys)})`
          : sql`t.merchant_business_number = any(${textArray(biz)})`;
    const peerR = await db.execute<{
      client_id: string;
      industry: string | null;
      merchant_key: string;
      merchant_business_number: string | null;
      direction: Direction;
      account_code: string;
      account_name: string | null;
      cnt: number;
      last_date: string;
      amount_sum: number;
      corrected: number;
    }>(sql`
      with cand as (
        select t.id, t.client_id, t.merchant_key, t.merchant_business_number, t.direction, t.account_code, t.account_name,
               t.transaction_date, t.total_amount, t.classification_source
        from transactions t
        where t.client_id <> ${clientId}
          and t.status in ${FINAL}
          and t.account_code is not null
          and t.transaction_date >= ${historyWindow.from} and t.transaction_date <= ${historyWindow.to}
          and ${partyCond}
      ),
      corr as (
        select distinct cc.transaction_id from classification_corrections cc
        where cc.field = 'account' and cc.transaction_id in (select id from cand)
      )
      select cand.client_id, p.industry, cand.merchant_key, cand.merchant_business_number, cand.direction, cand.account_code,
             max(cand.account_name) as account_name,
             count(*)::int as cnt,
             max(cand.transaction_date) as last_date,
             sum(abs(cand.total_amount))::bigint as amount_sum,
             (count(*) filter (where coalesce(cand.classification_source, '') = 'manual' or corr.transaction_id is not null))::int as corrected
      from cand
      left join client_business_profiles p on p.client_id = cand.client_id
      left join corr on corr.transaction_id = cand.id
      group by cand.client_id, p.industry, cand.merchant_key, cand.merchant_business_number, cand.direction, cand.account_code
    `);
    peerGroups = peerR.rows.length;
    for (const g of peerR.rows) {
      peerClientSet.add(g.client_id);
      const n = Math.min(g.cnt, cap);
      // 펼친 항목 수가 줄어도 수정 비율은 유지 (수정이 있었으면 최소 1)
      const correctedN = g.corrected > 0 ? Math.max(1, Math.round((g.corrected / g.cnt) * n)) : 0;
      const avg = Math.round(g.amount_sum / Math.max(1, g.cnt));
      for (let i = 0; i < n; i++) {
        peerHistory.push({
          clientId: g.client_id,
          merchantKey: g.merchant_key,
          merchantBusinessNumber: g.merchant_business_number,
          accountCode: g.account_code,
          accountName: g.account_name ?? g.account_code,
          transactionDate: g.last_date,
          totalAmount: avg,
          corrected: i < correctedN,
          industry: (g.industry ?? 'other') as IndustryKey,
          direction: g.direction,
        });
      }
    }
  }

  // ── 수정 기록 (기간 말 기준 최근 12개월 ~ 현재) ──
  const corrFrom = `${addMonths(period, -Math.max(1, Math.trunc(opts.correctionMonths ?? 12)))}-01`;
  const corrR = await db.execute<{
    transaction_id: string;
    merchant_key: string;
    merchant_business_number: string | null;
    field: 'account' | 'vat';
    before_value: string | null;
    after_value: string;
    user_id: string | null;
    created_at: Date | string;
    reason: string | null;
    direction: Direction | null;
  }>(sql`
    select c.transaction_id, c.merchant_key, c.merchant_business_number, c.field, c.before_value, c.after_value, c.user_id,
           c.created_at, c.reason, t.direction
    from classification_corrections c
    left join transactions t on t.id = c.transaction_id
    where c.client_id = ${clientId} and c.created_at >= ${corrFrom}::date
    order by c.created_at asc
  `);
  const corrections: DirectedCorrectionRecord[] = corrR.rows.map((c) => {
    const rec: DirectedCorrectionRecord = {
      clientId,
      merchantKey: c.merchant_key,
      merchantBusinessNumber: c.merchant_business_number,
      field: c.field,
      before: c.before_value,
      after: c.after_value,
      userId: c.user_id ?? '',
      transactionId: c.transaction_id,
      createdAt: c.created_at instanceof Date ? c.created_at.toISOString() : new Date(c.created_at).toISOString(),
      direction: c.direction,
    };
    if (c.reason) rec.reason = c.reason;
    return rec;
  });

  // ── 계정별 월합계 (급증 규칙용, 이번 배치 제외) ──
  const lookback = spikeLookbackMonths(review.rules, clientId, client.ruleParams);
  const fromPeriod = addMonths(period, -lookback);
  const totalsR = await db.execute<{ account_code: string; period: string; total: number }>(sql`
    select t.account_code, t.period, sum(t.total_amount)::bigint as total
    from transactions t
    where t.client_id = ${clientId}
      and t.account_code is not null
      and t.status not in ('duplicate', 'excluded', 'failed')
      and t.period >= ${fromPeriod} and t.period <= ${period}
      ${excludeCond}
    group by t.account_code, t.period
  `);
  const accountMonthlyTotals: Record<string, AccountMonthlyTotal[]> = {};
  for (const row of totalsR.rows) {
    (accountMonthlyTotals[row.account_code] ??= []).push({ period: row.period, total: row.total });
  }

  return {
    client,
    period,
    periodStart,
    periodEnd,
    asOfDate: periodEnd,
    rules: mapping.rules,
    ruleDbIds: mapping.ruleDbIds,
    history,
    peerHistory,
    corrections,
    accounts: accts.accounts,
    accountsSource: accts.source,
    vatRules: vat.rules,
    vatRulesSource: vat.source,
    reviewRules: review.rules,
    reviewRulesSource: review.source,
    accountMonthlyTotals,
    policy,
    stats: {
      historyRows: history.length,
      peerGroups,
      peerEntries: peerHistory.length,
      peerClients: peerClientSet.size,
      corrections: corrections.length,
      mappingRules: mapping.rules.length,
      loadMs: Math.round(performance.now() - t0),
    },
  };
}
