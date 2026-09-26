/**
 * Rule Studio — 계정 매핑 규칙 (mapping_rules).
 *
 * 상태: suggested(System Suggested / 담당자 초안) → active(User Approved) → disabled, 또는 suggested → rejected
 * - 담당자(rules.write)가 만든 규칙은 '제안' — 팀장 이상(rules.approve)이 승인해야 분류에 쓰인다 (4-eyes).
 * - rules.approve 권한자가 만들면 바로 활성.
 * - 공통 규칙(client_id null, origin system_default)은 관리자(settings.write)만.
 * - 모든 변경은 감사로그 (전 → 후, 사람이 읽는 요약).
 */
import { sql } from 'drizzle-orm';
import { mappingRules } from '@mintax/db';
import type { Condition, MappingRuleOrigin, MappingRuleStatus } from '@mintax/core';
import { ConflictError, NotFoundError, ValidationError } from '@mintax/security';
import { hasPermission, requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { notifyProblem, resolveProblem } from '../infra/notify';
import { isUuid } from '../classification/helpers';
import { dictionaryIdForRow } from './system-ids';
import { describeMappingRule, describeRuleCondition, mappingConditionErrors, validationFailure } from './describe';
import {
  assertIntRange,
  assertText,
  requireAccount,
  requireClient,
  requirePermissionAudited,
  requireScopePermission,
  toIso,
} from './common';

export type VatOverrideInput = { deductible: boolean; reasonCode?: string } | null;

export interface MappingRuleDto {
  id: string;
  clientId: string | null;
  clientName: string | null;
  scope: 'client' | 'global';
  name: string;
  condition: Condition;
  /** 읽기 문장: 매입/매출 = "매입" 그리고 상호키 = "쿠팡" */
  conditionText: string;
  accountCode: string;
  accountName: string;
  vatOverride: VatOverrideInput;
  confidence: number;
  priority: number;
  status: MappingRuleStatus;
  origin: MappingRuleOrigin;
  suggestionReason: string | null;
  appliedCount: number;
  lastAppliedAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 정리 대상: 활성인데 90일 동안 적용 0회 */
  stale: boolean;
  /** 시스템 기본 사전 항목 id (SYS-...) */
  dictionaryId: string | null;
}

export interface ListMappingRulesFilter {
  /** 문자열: 그 거래처 규칙 / null: 공통 규칙만 / 생략: 전체 */
  clientId?: string | null;
  /** clientId 지정 시 공통(system_default) 규칙도 함께 */
  includeGlobal?: boolean;
  status?: MappingRuleStatus | MappingRuleStatus[];
  origin?: MappingRuleOrigin | MappingRuleOrigin[];
  /** 이름·계정·조건 검색 */
  search?: string;
  limit?: number;
}

type RuleRow = {
  id: string;
  client_id: string | null;
  client_name: string | null;
  name: string;
  condition: Condition;
  account_code: string;
  account_name: string;
  vat_override: VatOverrideInput;
  confidence: number;
  priority: number;
  status: MappingRuleStatus;
  origin: MappingRuleOrigin;
  suggestion_reason: string | null;
  applied_count: number;
  last_applied_at: Date | null;
  created_by: string | null;
  created_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const STALE_DAYS = 90;
const STATUSES: readonly MappingRuleStatus[] = ['suggested', 'active', 'disabled', 'rejected'];
const ORIGINS: readonly MappingRuleOrigin[] = ['user', 'system_suggested', 'system_default'];

function toDto(r: RuleRow, now: Date): MappingRuleDto {
  const staleBefore = now.getTime() - STALE_DAYS * 86_400_000;
  const lastUse = r.last_applied_at ? new Date(r.last_applied_at).getTime() : null;
  const stale =
    r.status === 'active' && (lastUse === null ? new Date(r.created_at).getTime() < staleBefore : lastUse < staleBefore);
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    scope: r.client_id ? 'client' : 'global',
    name: r.name,
    condition: r.condition,
    conditionText: describeRuleCondition(r.condition),
    accountCode: r.account_code,
    accountName: r.account_name,
    vatOverride: r.vat_override ?? null,
    confidence: r.confidence,
    priority: r.priority,
    status: r.status,
    origin: r.origin,
    suggestionReason: r.suggestion_reason,
    appliedCount: r.applied_count,
    lastAppliedAt: toIso(r.last_applied_at),
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    approvedBy: r.approved_by,
    approvedByName: r.approved_by_name,
    approvedAt: toIso(r.approved_at),
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
    stale,
    dictionaryId: dictionaryIdForRow({ id: r.id, name: r.name, accountCode: r.account_code, origin: r.origin, clientId: r.client_id }),
  };
}

const SELECT = sql`
  select r.id, r.client_id, c.name as client_name, r.name, r.condition, r.account_code, r.account_name, r.vat_override,
         r.confidence, r.priority, r.status, r.origin, r.suggestion_reason, r.applied_count, r.last_applied_at,
         r.created_by, cu.name as created_by_name, r.approved_by, au.name as approved_by_name, r.approved_at,
         r.created_at, r.updated_at
  from mapping_rules r
  left join clients c on c.id = r.client_id
  left join users cu on cu.id = r.created_by
  left join users au on au.id = r.approved_by
`;

async function loadRow(ctx: Pick<ServiceContext, 'db'>, ruleId: string): Promise<RuleRow> {
  if (!isUuid(ruleId)) throw new NotFoundError('규칙');
  const r = await ctx.db.execute<RuleRow>(sql`${SELECT} where r.id = ${ruleId}`);
  const row = r.rows[0];
  if (!row) throw new NotFoundError('규칙');
  return row;
}

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
  return v === undefined ? undefined : Array.isArray(v) ? v : [v];
}

/** 규칙 목록 (적용 횟수·마지막 적용·읽기 문장 포함). 권한: rules.read */
export async function listMappingRules(ctx: ServiceContext, filter: ListMappingRulesFilter = {}): Promise<MappingRuleDto[]> {
  requirePermission(ctx, 'rules.read');
  const conds = [sql`true`];
  if (filter.clientId === null) conds.push(sql`r.client_id is null`);
  else if (typeof filter.clientId === 'string') {
    if (!isUuid(filter.clientId)) throw new NotFoundError('거래처');
    conds.push(filter.includeGlobal ? sql`(r.client_id = ${filter.clientId} or r.client_id is null)` : sql`r.client_id = ${filter.clientId}`);
  }
  const statuses = asArray(filter.status)?.filter((s) => STATUSES.includes(s));
  if (statuses && statuses.length > 0) conds.push(sql`r.status = any(${sql.param(statuses)}::text[])`);
  const origins = asArray(filter.origin)?.filter((o) => ORIGINS.includes(o));
  if (origins && origins.length > 0) conds.push(sql`r.origin = any(${sql.param(origins)}::text[])`);
  if (filter.search && filter.search.trim() !== '') {
    const q = `%${filter.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(sql`(r.name ilike ${q} or r.account_code ilike ${q} or r.account_name ilike ${q} or r.condition::text ilike ${q} or c.name ilike ${q})`);
  }
  const limit = Math.min(2000, Math.max(1, Math.trunc(filter.limit ?? 500)));
  const r = await ctx.db.execute<RuleRow>(sql`
    ${SELECT}
    where ${sql.join(conds, sql` and `)}
    order by case r.status when 'suggested' then 0 when 'active' then 1 when 'disabled' then 2 else 3 end,
             (r.client_id is null), r.priority desc, r.name, r.id
    limit ${limit}
  `);
  const now = ctx.now();
  return r.rows.map((row) => toDto(row, now));
}

/** 상태별 규칙 수 (Rule Studio 탭 배지). 권한: rules.read */
export async function countMappingRulesByStatus(
  ctx: ServiceContext,
  filter: { clientId?: string | null } = {},
): Promise<Record<MappingRuleStatus, number>> {
  requirePermission(ctx, 'rules.read');
  const cond =
    filter.clientId === null
      ? sql`client_id is null`
      : typeof filter.clientId === 'string' && isUuid(filter.clientId)
        ? sql`client_id = ${filter.clientId}`
        : sql`true`;
  const r = await ctx.db.execute<{ status: MappingRuleStatus; n: number }>(sql`
    select status, count(*)::int as n from mapping_rules where ${cond} group by status
  `);
  const out: Record<MappingRuleStatus, number> = { suggested: 0, active: 0, disabled: 0, rejected: 0 };
  for (const x of r.rows) out[x.status] = x.n;
  return out;
}

/** 규칙 1건. 권한: rules.read */
export async function getMappingRule(ctx: ServiceContext, ruleId: string): Promise<MappingRuleDto> {
  requirePermission(ctx, 'rules.read');
  return toDto(await loadRow(ctx, ruleId), ctx.now());
}

export interface CreateMappingRuleInput {
  /** null = 공통 규칙 (관리자 전용, 시스템 사전과 같은 수준: 신뢰도 상한 90) */
  clientId: string | null;
  name: string;
  condition: Condition;
  accountCode: string;
  vatOverride?: VatOverrideInput;
  /** 기본 99 (공통 규칙은 기본 85, 상한 90) */
  confidence?: number;
  /** 기본 100 */
  priority?: number;
  /** 규칙 근거 메모 (예: 거래에서 만듦) */
  suggestionReason?: string | null;
}

function validateVatOverride(v: unknown): VatOverrideInput {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || typeof (v as { deductible?: unknown }).deductible !== 'boolean') {
    throw new ValidationError('부가세 지정은 공제/불공제 중 하나여야 합니다.', [{ field: 'vatOverride', message: 'deductible(true/false) 필요' }]);
  }
  const o = v as { deductible: boolean; reasonCode?: unknown };
  const out: { deductible: boolean; reasonCode?: string } = { deductible: o.deductible };
  if (o.reasonCode !== undefined && o.reasonCode !== null && String(o.reasonCode).trim() !== '') out.reasonCode = String(o.reasonCode).trim().slice(0, 50);
  return out;
}

function snapshot(r: Pick<RuleRow, 'name' | 'client_id' | 'condition' | 'account_code' | 'account_name' | 'confidence' | 'priority' | 'status' | 'vat_override'>): Record<string, unknown> {
  return {
    name: r.name,
    clientId: r.client_id,
    condition: r.condition,
    conditionText: describeRuleCondition(r.condition),
    accountCode: r.account_code,
    accountName: r.account_name,
    confidence: r.confidence,
    priority: r.priority,
    status: r.status,
    vatOverride: r.vat_override ?? null,
  };
}

/** updated_at 은 항상 증가 (같은 시각 두 번 수정해도 낙관적 잠금이 동작하도록) */
function nextUpdatedAt(ctx: ServiceContext, prev: Date | string): Date {
  const now = ctx.now();
  const p = new Date(prev).getTime();
  return now.getTime() > p ? now : new Date(p + 1);
}

const STATUS_LABEL: Record<MappingRuleStatus, string> = { suggested: '제안', active: '활성', disabled: '비활성', rejected: '거절' };

function scopeLabel(clientName: string | null): string {
  return clientName ? `[${clientName}]` : '[공통]';
}

async function notifySuggested(ctx: ServiceContext, rule: { id: string; name: string; clientId: string | null; clientName: string | null; accountCode: string; accountName: string }, reason: string): Promise<void> {
  await notifyProblem(ctx, {
    kind: 'rule_suggested',
    severity: 'info',
    title: `규칙 승인 요청: ${rule.name}`,
    body: `${rule.clientName ?? '공통'} · ${rule.accountCode} ${rule.accountName} — ${reason}. 팀장 이상이 Rule Studio 에서 백테스트를 확인하고 승인해야 분류에 쓰입니다.`,
    href: `/rules?ruleId=${rule.id}`,
    clientId: rule.clientId,
    dedupeKey: `rule_suggested:${rule.id}`,
  });
}

/**
 * 규칙 생성. 권한: rules.write (+ 공통 규칙은 settings.write).
 * rules.approve 권한자 → 바로 활성, 아니면 '제안' (승인 대기 알림).
 */
export async function createMappingRule(ctx: ServiceContext, input: CreateMappingRuleInput): Promise<MappingRuleDto> {
  requirePermission(ctx, 'rules.write');
  const clientId = input.clientId ?? null;
  requireScopePermission(ctx, clientId);
  const name = assertText(input.name, 'name', '규칙 이름', 100)!;
  const errs = mappingConditionErrors(input.condition);
  if (errs.length > 0) throw validationFailure('규칙 조건을 확인하세요.', errs, 'condition');
  const global = clientId === null;
  const confidence = assertIntRange(input.confidence ?? (global ? 85 : 99), 0, global ? 90 : 100, 'confidence', global ? '공통 규칙 신뢰도' : '신뢰도');
  const priority = assertIntRange(input.priority ?? 100, -10000, 10000, 'priority', '우선순위');
  const vatOverride = validateVatOverride(input.vatOverride);
  const client = clientId ? await requireClient(ctx, clientId) : null;
  const account = await requireAccount(ctx, input.accountCode);

  const dup = await ctx.db.execute<{ id: string; name: string; status: string }>(sql`
    select id, name, status from mapping_rules
    where ${clientId ? sql`client_id = ${clientId}` : sql`client_id is null`}
      and condition = ${JSON.stringify(input.condition)}::jsonb and status in ('active', 'suggested')
    limit 1
  `);
  if (dup.rows[0]) {
    const d = dup.rows[0];
    throw new ConflictError(`같은 조건의 규칙 '${d.name}'(${STATUS_LABEL[d.status as MappingRuleStatus] ?? d.status})이 이미 있습니다. 기존 규칙을 수정하세요.`);
  }

  const canApprove = hasPermission(ctx, 'rules.approve');
  const status: MappingRuleStatus = global || canApprove ? 'active' : 'suggested';
  const now = ctx.now();
  const origin: MappingRuleOrigin = global ? 'system_default' : 'user';
  const [row] = await ctx.db
    .insert(mappingRules)
    .values({
      clientId,
      name,
      condition: input.condition,
      accountCode: account.code,
      accountName: account.name,
      vatOverride,
      confidence,
      priority,
      status,
      origin,
      suggestionReason: input.suggestionReason ?? null,
      createdBy: ctx.actor.userId,
      approvedBy: status === 'active' ? ctx.actor.userId : null,
      approvedAt: status === 'active' ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: mappingRules.id });
  const id = row!.id;
  const text = describeMappingRule({ condition: input.condition, accountCode: account.code, accountName: account.name });
  await writeAudit(ctx, {
    action: 'rule.create',
    category: 'data_change',
    entityType: 'mapping_rule',
    entityId: id,
    clientId,
    summary: `규칙 생성(${STATUS_LABEL[status]}): '${name}' ${scopeLabel(client?.name ?? null)} — ${text}`,
    before: null,
    after: snapshot({ name, client_id: clientId, condition: input.condition, account_code: account.code, account_name: account.name, confidence, priority, status, vat_override: vatOverride }),
    revertible: true,
  });
  if (status === 'suggested') {
    await notifySuggested(
      ctx,
      { id, name, clientId, clientName: client?.name ?? null, accountCode: account.code, accountName: account.name },
      `${ctx.actor.name}님이 작성한 규칙`,
    );
  }
  return toDto(await loadRow(ctx, id), now);
}

export interface UpdateMappingRulePatch {
  name?: string;
  condition?: Condition;
  accountCode?: string;
  vatOverride?: VatOverrideInput;
  confidence?: number;
  priority?: number;
  /** 낙관적 잠금: 화면이 본 updatedAt (다르면 ConflictError) */
  expectedUpdatedAt?: string;
}

/**
 * 규칙 수정. 권한: rules.write — 활성 규칙은 전 거래에 영향을 주므로 rules.approve 도 필요, 공통 규칙은 settings.write.
 */
export async function updateMappingRule(ctx: ServiceContext, ruleId: string, patch: UpdateMappingRulePatch): Promise<MappingRuleDto> {
  requirePermission(ctx, 'rules.write');
  const before = await loadRow(ctx, ruleId);
  requireScopePermission(ctx, before.client_id);
  if (before.status === 'active') {
    await requirePermissionAudited(ctx, 'rules.approve', { what: `활성 규칙 '${before.name}' 수정`, entityType: 'mapping_rule', entityId: ruleId, clientId: before.client_id });
  }
  if (patch.expectedUpdatedAt && toIso(before.updated_at) !== new Date(patch.expectedUpdatedAt).toISOString()) {
    throw new ConflictError('다른 사용자가 이 규칙을 먼저 변경했습니다. 화면을 새로고침한 뒤 다시 수정하세요.');
  }
  const global = before.client_id === null;
  const next = { ...before };
  const changes: string[] = [];
  if (patch.name !== undefined) {
    const name = assertText(patch.name, 'name', '규칙 이름', 100)!;
    if (name !== before.name) {
      changes.push(`이름 '${before.name}' → '${name}'`);
      next.name = name;
    }
  }
  if (patch.condition !== undefined) {
    const errs = mappingConditionErrors(patch.condition);
    if (errs.length > 0) throw validationFailure('규칙 조건을 확인하세요.', errs, 'condition');
    if (JSON.stringify(patch.condition) !== JSON.stringify(before.condition)) {
      changes.push(`조건 ${describeRuleCondition(before.condition)} → ${describeRuleCondition(patch.condition)}`);
      next.condition = patch.condition;
    }
  }
  if (patch.accountCode !== undefined && patch.accountCode !== before.account_code) {
    const acc = await requireAccount(ctx, patch.accountCode);
    changes.push(`계정 ${before.account_code} ${before.account_name} → ${acc.code} ${acc.name}`);
    next.account_code = acc.code;
    next.account_name = acc.name;
  }
  if (patch.vatOverride !== undefined) {
    const v = validateVatOverride(patch.vatOverride);
    if (JSON.stringify(v) !== JSON.stringify(before.vat_override ?? null)) {
      const label = (x: VatOverrideInput) => (x ? (x.deductible ? '공제' : '불공제') : '없음');
      changes.push(`부가세 지정 ${label(before.vat_override)} → ${label(v)}`);
      next.vat_override = v;
    }
  }
  if (patch.confidence !== undefined) {
    const c = assertIntRange(patch.confidence, 0, global ? 90 : 100, 'confidence', global ? '공통 규칙 신뢰도' : '신뢰도');
    if (c !== before.confidence) {
      changes.push(`신뢰도 ${before.confidence} → ${c}`);
      next.confidence = c;
    }
  }
  if (patch.priority !== undefined) {
    const p = assertIntRange(patch.priority, -10000, 10000, 'priority', '우선순위');
    if (p !== before.priority) {
      changes.push(`우선순위 ${before.priority} → ${p}`);
      next.priority = p;
    }
  }
  if (changes.length === 0) return toDto(before, ctx.now());
  const now = nextUpdatedAt(ctx, before.updated_at);
  const res = await ctx.db.execute(sql`
    update mapping_rules set name = ${next.name}, condition = ${JSON.stringify(next.condition)}::jsonb, account_code = ${next.account_code},
      account_name = ${next.account_name}, vat_override = ${next.vat_override ? JSON.stringify(next.vat_override) : null}::jsonb,
      confidence = ${next.confidence}, priority = ${next.priority}, updated_at = ${now.toISOString()}::timestamptz
    where id = ${ruleId} and updated_at = ${toIso(before.updated_at)}::timestamptz
  `);
  if ((res.rowCount ?? 0) === 0) throw new ConflictError('다른 사용자가 이 규칙을 먼저 변경했습니다. 화면을 새로고침한 뒤 다시 수정하세요.');
  await writeAudit(ctx, {
    action: 'rule.update',
    category: 'data_change',
    entityType: 'mapping_rule',
    entityId: ruleId,
    clientId: before.client_id,
    summary: `규칙 수정: '${before.name}' ${scopeLabel(before.client_name)} — ${changes.join(', ')}`,
    before: snapshot(before),
    after: snapshot(next),
    revertible: true,
  });
  return toDto(await loadRow(ctx, ruleId), now);
}

async function transition(
  ctx: ServiceContext,
  before: RuleRow,
  to: MappingRuleStatus,
  action: string,
  summaryVerb: string,
  reason?: string | null,
): Promise<MappingRuleDto> {
  const now = nextUpdatedAt(ctx, before.updated_at);
  const approving = to === 'active';
  const res = await ctx.db.execute(sql`
    update mapping_rules set status = ${to}, updated_at = ${now.toISOString()}::timestamptz
      ${approving ? sql`, approved_by = ${ctx.actor.userId}, approved_at = ${now.toISOString()}::timestamptz` : sql``}
    where id = ${before.id} and status = ${before.status}
  `);
  if ((res.rowCount ?? 0) === 0) throw new ConflictError('다른 사용자가 이 규칙의 상태를 먼저 바꿨습니다. 화면을 새로고침하세요.');
  const r = reason ? assertText(reason, 'reason', '사유', 500, false) : null;
  await writeAudit(ctx, {
    action,
    category: 'data_change',
    entityType: 'mapping_rule',
    entityId: before.id,
    clientId: before.client_id,
    summary: `${summaryVerb}: '${before.name}' ${scopeLabel(before.client_name)} — ${describeMappingRule({ condition: before.condition, accountCode: before.account_code, accountName: before.account_name })} (${STATUS_LABEL[before.status]} → ${STATUS_LABEL[to]})${r ? ` · 사유: ${r}` : ''}`,
    before: { status: before.status },
    after: { status: to, ...(r ? { reason: r } : {}) },
    revertible: true,
  });
  if (before.status === 'suggested') await resolveProblem(ctx, `rule_suggested:${before.id}`);
  return toDto(await loadRow(ctx, before.id), now);
}

/** System Suggested → User Approved. 권한: rules.approve (거부 시 보안 감사) */
export async function approveSuggestedRule(ctx: ServiceContext, ruleId: string): Promise<MappingRuleDto> {
  await requirePermissionAudited(ctx, 'rules.approve', { what: '규칙 승인', entityType: 'mapping_rule', entityId: ruleId });
  const before = await loadRow(ctx, ruleId);
  if (before.status !== 'suggested') {
    throw new ConflictError(`이 규칙은 승인 대기(제안) 상태가 아닙니다 (현재: ${STATUS_LABEL[before.status]}). 화면을 새로고침하세요.`);
  }
  requireScopePermission(ctx, before.client_id);
  // 승인 시점에 계정이 여전히 유효한지 확인 (계정과목표가 바뀌었을 수 있음)
  await requireAccount(ctx, before.account_code);
  return transition(ctx, before, 'active', 'rule.approve', '규칙 승인');
}

/** 제안 거절. 권한: rules.approve */
export async function rejectSuggestedRule(ctx: ServiceContext, ruleId: string, reason?: string | null): Promise<MappingRuleDto> {
  await requirePermissionAudited(ctx, 'rules.approve', { what: '규칙 거절', entityType: 'mapping_rule', entityId: ruleId });
  const before = await loadRow(ctx, ruleId);
  if (before.status !== 'suggested') {
    throw new ConflictError(`이 규칙은 승인 대기(제안) 상태가 아닙니다 (현재: ${STATUS_LABEL[before.status]}). 화면을 새로고침하세요.`);
  }
  return transition(ctx, before, 'rejected', 'rule.reject', '규칙 거절', reason);
}

/** 규칙 끄기 (삭제하지 않는다). 권한: rules.write (+ 공통 규칙은 settings.write) */
export async function disableMappingRule(ctx: ServiceContext, ruleId: string, reason?: string | null): Promise<MappingRuleDto> {
  requirePermission(ctx, 'rules.write');
  const before = await loadRow(ctx, ruleId);
  requireScopePermission(ctx, before.client_id);
  if (before.status !== 'active' && before.status !== 'suggested') {
    throw new ConflictError(`이미 ${STATUS_LABEL[before.status]} 상태인 규칙입니다.`);
  }
  return transition(ctx, before, 'disabled', 'rule.disable', '규칙 비활성화', reason);
}

/** 꺼진 규칙 다시 켜기 = 활성화이므로 승인 권한. 권한: rules.approve (+ 공통 규칙은 settings.write) */
export async function enableMappingRule(ctx: ServiceContext, ruleId: string): Promise<MappingRuleDto> {
  await requirePermissionAudited(ctx, 'rules.approve', { what: '규칙 다시 켜기', entityType: 'mapping_rule', entityId: ruleId });
  const before = await loadRow(ctx, ruleId);
  requireScopePermission(ctx, before.client_id);
  if (before.status !== 'disabled') throw new ConflictError(`비활성 상태인 규칙만 다시 켤 수 있습니다 (현재: ${STATUS_LABEL[before.status]}).`);
  await requireAccount(ctx, before.account_code);
  return transition(ctx, before, 'active', 'rule.enable', '규칙 다시 켜기');
}

