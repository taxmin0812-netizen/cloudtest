/**
 * 학습 루프 — 직원 수정(classification_corrections) → 반복 수정 감지 → 영구 규칙 "제안" (절대 자동 활성화하지 않음).
 *
 * - core analyzeCorrections 를 그대로 쓴다. 단, 묶음 수정(reason 'bulk:{감사로그ID}')은 1건으로 접어서 넘긴다
 *   (docs/05 §5.3: 한 번의 판단이 여러 번으로 세어져 규칙이 성급하게 제안되는 것 방지).
 * - 수임처 단위 advisory lock 으로 같은 제안이 동시에 두 번 만들어지지 않게 한다 (정확히 1회).
 */
import { sql } from 'drizzle-orm';
import { mappingRules, type Database } from '@mintax/db';
import type { AccountCode, Condition, Direction, MappingRule, MappingRuleOrigin, MappingRuleStatus } from '@mintax/core';
import { analyzeCorrections, type DirectedCorrectionRecord } from '@mintax/core/engine/classify-index';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { notifyProblem } from '../infra/notify';
import { getConfidencePolicy } from '../infra/settings';
import { accountLabel, assertPeriod, assertUuid, foldBulkCorrections } from './helpers';
import { loadAccountMap, systemContext } from './shared';
import type { LearningSummary, RuleSuggestionDto } from './types';

/** 학습에 쓰는 수정 기록 기간 (분류 엔진과 같은 12개월) */
const LEARNING_WINDOW_DAYS = 365;

export interface MerchantRef {
  clientId: string;
  merchantKey: string;
  merchantBusinessNumber: string | null;
  /** 안내 문구용 표시 상호 */
  merchantName: string;
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

async function loadClientRules(db: Database, clientId: string): Promise<MappingRule[]> {
  const r = await db.execute<MappingRuleRow>(sql`
    select id, client_id, name, condition, account_code, account_name, vat_override, confidence, priority, status, origin
    from mapping_rules where client_id = ${clientId}::uuid
  `);
  return r.rows.map((x) => ({
    id: x.id,
    clientId: x.client_id,
    name: x.name,
    condition: x.condition,
    accountCode: x.account_code,
    accountName: x.account_name,
    vatOverride: x.vat_override ?? null,
    confidence: x.confidence,
    priority: x.priority,
    status: x.status,
    origin: x.origin,
  }));
}

function merchantCond(m: Pick<MerchantRef, 'merchantKey' | 'merchantBusinessNumber'>, alias: 'c' | 't') {
  const key = sql.raw(`${alias}.merchant_key`);
  const biz = sql.raw(`${alias}.merchant_business_number`);
  return m.merchantBusinessNumber ? sql`(${key} = ${m.merchantKey} or ${biz} = ${m.merchantBusinessNumber})` : sql`${key} = ${m.merchantKey}`;
}

/**
 * 이 수임처·상대방의 수정 기록을 분석해 임계치(정책 ruleSuggestionThreshold, 기본 3)에 닿았고
 * 같은 결과의 규칙(활성·제안·거절·비활성)이 없으면 mapping_rules 에 status 'suggested' / origin 'system_suggested' 로 넣는다.
 * 반드시 호출자의 DB 트랜잭션 안에서 부른다 (advisory xact lock).
 */
export async function suggestRuleForMerchant(ctx: ServiceContext, m: MerchantRef, deps: { accounts?: Map<string, AccountCode> } = {}): Promise<RuleSuggestionDto | null> {
  await ctx.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`review.learning:${m.clientId}`}))`);
  const since = new Date(ctx.now().getTime() - LEARNING_WINDOW_DAYS * 86_400_000).toISOString();
  // 트랜잭션 안(단일 커넥션)이므로 순차 실행
  const corrR = await ctx.db.execute<{
    transaction_id: string;
    merchant_key: string;
    merchant_business_number: string | null;
    before_value: string | null;
    after_value: string;
    user_id: string | null;
    created_at: Date | string;
    reason: string | null;
    direction: Direction | null;
  }>(sql`
    select c.transaction_id, c.merchant_key, c.merchant_business_number, c.before_value, c.after_value, c.user_id, c.created_at,
           c.reason, t.direction
    from classification_corrections c
    left join transactions t on t.id = c.transaction_id
    where c.client_id = ${m.clientId}::uuid and c.field = 'account' and c.created_at >= ${since}::timestamptz
      and ${merchantCond(m, 'c')}
    order by c.created_at asc
  `);
  const rules = await loadClientRules(ctx.db, m.clientId);
  const policy = await getConfidencePolicy(ctx);
  const accounts = deps.accounts ?? (await loadAccountMap(ctx.db)).map;
  const records: DirectedCorrectionRecord[] = corrR.rows.map((c) => {
    const rec: DirectedCorrectionRecord = {
      clientId: m.clientId,
      merchantKey: c.merchant_key,
      merchantBusinessNumber: c.merchant_business_number,
      field: 'account',
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
  const folded = foldBulkCorrections(records);
  const suggestions = analyzeCorrections(folded, rules, policy, accounts);
  const s = suggestions.find((x) =>
    m.merchantBusinessNumber ? x.merchantBusinessNumber === m.merchantBusinessNumber : x.merchantKey === m.merchantKey && !x.merchantBusinessNumber,
  ) ?? suggestions.find((x) => x.merchantKey === m.merchantKey);
  if (!s) return null;

  const now = ctx.now();
  const [rule] = await ctx.db
    .insert(mappingRules)
    .values({
      clientId: m.clientId,
      name: s.rule.name,
      condition: s.rule.condition,
      accountCode: s.rule.accountCode,
      accountName: s.rule.accountName,
      vatOverride: null,
      confidence: s.rule.confidence,
      priority: s.rule.priority,
      status: 'suggested',
      origin: 'system_suggested',
      suggestionReason: s.suggestionReason,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: mappingRules.id });
  const ruleId = rule!.id;

  // 이 제안을 뒷받침한 수정 기록 연결 (묶음으로 접힌 형제 기록 포함)
  await ctx.db.execute(sql`
    update classification_corrections c set suggested_rule_id = ${ruleId}::uuid
    where c.client_id = ${m.clientId}::uuid and c.field = 'account' and c.after_value = ${s.toAccountCode}
      and c.suggested_rule_id is null and c.created_at >= ${since}::timestamptz and ${merchantCond(m, 'c')}
  `);

  const toName = accountLabel(s.toAccountCode, s.rule.accountName);
  const display = m.merchantName.trim() || s.merchantKey;
  const sys = systemContext(ctx);
  await writeAudit(sys, {
    action: 'rule.suggest',
    category: 'data_change',
    entityType: 'mapping_rule',
    entityId: ruleId,
    clientId: m.clientId,
    summary: `규칙 제안: ${display} → ${toName} (${s.suggestionReason})`,
    before: null,
    after: {
      name: s.rule.name,
      condition: s.rule.condition as unknown as Record<string, unknown>,
      accountCode: s.rule.accountCode,
      accountName: s.rule.accountName,
      status: 'suggested',
      origin: 'system_suggested',
      suggestionReason: s.suggestionReason,
      correctionCount: s.correctionCount,
      direction: s.direction,
      triggeredBy: ctx.actor.name,
    },
  });
  await notifyProblem(ctx, {
    kind: 'rule_suggested',
    severity: 'info',
    title: `규칙 제안: ${display} → ${toName}`,
    body: `${s.suggestionReason}. 규칙 승인 권한자가 확인하면 다음 달부터 자동 처리됩니다.`,
    href: `/rules?status=suggested&client=${m.clientId}`,
    clientId: m.clientId,
    dedupeKey: `rule_suggested:${ruleId}`,
  });

  return {
    id: ruleId,
    name: s.rule.name,
    accountCode: s.toAccountCode,
    accountName: toName,
    correctionCount: s.correctionCount,
    suggestionReason: s.suggestionReason,
    message: `동일 수정 ${s.correctionCount}회 — '${display} → ${toName}'을 영구 규칙으로 등록하시겠습니까?`,
  };
}

/**
 * 학습 요약 — "수정한 38건을 다음 처리에 학습했습니다".
 * 기준: 이 기간(period) 거래에 대한 수정 기록. userId 를 주면 그 직원의 수정만.
 */
export async function getLearningSummary(ctx: ServiceContext, input: { period: string; userId?: string | null }): Promise<LearningSummary> {
  requirePermission(ctx, 'transactions.read');
  const period = assertPeriod(input?.period);
  const userId = input?.userId ? assertUuid(input.userId, 'userId', '사용자') : null;
  const userCond = userId ? sql` and c.user_id = ${userId}::uuid` : sql``;

  const [totR, ruleR, topR] = await Promise.all([
    ctx.db.execute<{ corrections: number; txs: number; account_n: number; vat_n: number; merchants: number; bulk_ops: number }>(sql`
      select count(*)::int as corrections,
             count(distinct c.transaction_id)::int as txs,
             (count(*) filter (where c.field = 'account'))::int as account_n,
             (count(*) filter (where c.field = 'vat'))::int as vat_n,
             count(distinct c.client_id::text || '|' || coalesce(c.merchant_business_number, c.merchant_key))::int as merchants,
             count(distinct substring(c.reason from '^bulk:([0-9a-fA-F-]{36})'))::int as bulk_ops
      from classification_corrections c
      join transactions t on t.id = c.transaction_id
      where t.period = ${period}${userCond}
    `),
    ctx.db.execute<{ status: string; n: number }>(sql`
      select r.status, count(*)::int as n from mapping_rules r
      where r.id in (
        select distinct c.suggested_rule_id from classification_corrections c
        join transactions t on t.id = c.transaction_id
        where t.period = ${period}${userCond} and c.suggested_rule_id is not null
      )
      group by r.status
    `),
    ctx.db.execute<{ merchant_name: string; from_label: string | null; to_label: string | null; after_value: string; n: number }>(sql`
      select max(t.merchant_name) as merchant_name, max(c.before_label) as from_label, max(c.after_label) as to_label, c.after_value,
             count(*)::int as n
      from classification_corrections c
      join transactions t on t.id = c.transaction_id
      where t.period = ${period}${userCond} and c.field = 'account'
      group by c.client_id, coalesce(c.merchant_business_number, c.merchant_key), c.after_value
      order by n desc, merchant_name asc
      limit 5
    `),
  ]);
  const t = totR.rows[0] ?? { corrections: 0, txs: 0, account_n: 0, vat_n: 0, merchants: 0, bulk_ops: 0 };
  const byStatus = new Map(ruleR.rows.map((r) => [r.status, r.n]));
  const rulesSuggested = ruleR.rows.reduce((s, r) => s + r.n, 0);
  const rulesApproved = byStatus.get('active') ?? 0;
  let message: string;
  if (t.txs === 0) message = `${period} 수정 기록이 없습니다. 자동분류 결과를 그대로 확정했습니다.`;
  else {
    message = `수정한 ${t.txs.toLocaleString('ko-KR')}건을 다음 처리에 학습했습니다`;
    if (rulesSuggested > 0) message += ` · 규칙 제안 ${rulesSuggested}건${rulesApproved > 0 ? ` (승인 ${rulesApproved}건)` : ''}`;
  }
  return {
    period,
    userId,
    corrections: t.corrections,
    correctedTransactions: t.txs,
    accountCorrections: t.account_n,
    vatCorrections: t.vat_n,
    merchants: t.merchants,
    bulkOperations: t.bulk_ops,
    rulesSuggested,
    rulesApproved,
    rulesPending: byStatus.get('suggested') ?? 0,
    rulesRejected: byStatus.get('rejected') ?? 0,
    topCorrections: topR.rows.map((r) => ({
      merchantName: r.merchant_name,
      fromLabel: r.from_label ?? '미분류',
      toLabel: r.to_label ?? r.after_value,
      count: r.n,
    })),
    message,
  };
}

