/**
 * Rule Studio — 부가세 공제/불공제 규칙 (vat_rules).
 * - 공통 규칙(client_id null): settings.write (관리자)
 * - 수임처 override(같은 code + client_id): rules.write
 * - 삭제 대신 비활성화. 수임처 override 만 "공통 규칙으로 되돌리기"(행 삭제)가 가능하며 전체 행을 감사로그에 남긴다.
 */
import { sql } from 'drizzle-orm';
import { vatRules } from '@mintax/db';
import type { Condition } from '@mintax/core';
import { DEFAULT_VAT_RULES, resolveRulesForClient, type VatRuleOutcome } from '@mintax/core/engine/vat-risk-index';
import { ConflictError, NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { isUuid } from '../classification/helpers';
import { describeRuleCondition, ruleConditionErrors, validationFailure } from './describe';
import { assertIntRange, assertText, isUniqueViolation, requireClient, requireScopePermission, toIso } from './common';

export interface VatRuleDto {
  id: string;
  code: string;
  name: string;
  condition: Condition;
  conditionText: string;
  outcome: VatRuleOutcome;
  outcomeLabel: string;
  reasonText: string;
  legalBasis: string | null;
  confidence: number;
  priority: number;
  clientId: string | null;
  clientName: string | null;
  scope: 'global' | 'client';
  active: boolean;
  appliedCount: number;
  lastAppliedAt: string | null;
  updatedAt: string;
  updatedByName: string | null;
  /** 기본 제공 규칙(DEFAULT_VAT_RULES) code 인가 */
  isDefault: boolean;
  /** clientId 로 조회했을 때: 이 공통 규칙은 수임처 override 에 가려져 적용되지 않는다 */
  overridden: boolean;
  /** clientId 로 조회했을 때: 이 수임처에 실제로 적용되는 규칙인가 */
  effective: boolean | null;
}

const OUTCOMES: readonly VatRuleOutcome[] = ['non_deductible', 'deductible', 'review'];
const OUTCOME_LABEL: Record<VatRuleOutcome, string> = { non_deductible: '불공제', deductible: '공제', review: '검토' };
const DEFAULT_CODES = new Set(DEFAULT_VAT_RULES.map((r) => r.code));

type Row = {
  id: string;
  code: string;
  name: string;
  condition: Condition;
  outcome: VatRuleOutcome;
  reason_text: string;
  legal_basis: string | null;
  confidence: number;
  priority: number;
  client_id: string | null;
  client_name: string | null;
  active: boolean;
  applied_count: number;
  last_applied_at: Date | null;
  updated_at: Date;
  updated_by_name: string | null;
};

const SELECT = sql`
  select v.id, v.code, v.name, v.condition, v.outcome, v.reason_text, v.legal_basis, v.confidence, v.priority, v.client_id,
         c.name as client_name, v.active, v.applied_count, v.last_applied_at, v.updated_at, u.name as updated_by_name
  from vat_rules v
  left join clients c on c.id = v.client_id
  left join users u on u.id = v.updated_by
`;

function toDto(r: Row, overridden = false, effective: boolean | null = null): VatRuleDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    condition: r.condition,
    conditionText: describeRuleCondition(r.condition),
    outcome: r.outcome,
    outcomeLabel: OUTCOME_LABEL[r.outcome] ?? r.outcome,
    reasonText: r.reason_text,
    legalBasis: r.legal_basis,
    confidence: r.confidence,
    priority: r.priority,
    clientId: r.client_id,
    clientName: r.client_name,
    scope: r.client_id ? 'client' : 'global',
    active: r.active,
    appliedCount: r.applied_count,
    lastAppliedAt: toIso(r.last_applied_at),
    updatedAt: toIso(r.updated_at)!,
    updatedByName: r.updated_by_name,
    isDefault: DEFAULT_CODES.has(r.code),
    overridden,
    effective,
  };
}

async function loadRow(ctx: Pick<ServiceContext, 'db'>, id: string): Promise<Row> {
  if (!isUuid(id)) throw new NotFoundError('부가세 규칙');
  const r = await ctx.db.execute<Row>(sql`${SELECT} where v.id = ${id}`);
  if (!r.rows[0]) throw new NotFoundError('부가세 규칙');
  return r.rows[0];
}

/**
 * 부가세 규칙 목록 (적용 횟수 포함). clientId 를 주면 공통 + 그 수임처 override, 실제 적용 여부(effective)까지. 권한: rules.read
 */
export async function listVatRules(ctx: ServiceContext, filter: { clientId?: string | null; includeInactive?: boolean } = {}): Promise<VatRuleDto[]> {
  requirePermission(ctx, 'rules.read');
  const conds = [sql`true`];
  if (filter.clientId === null) conds.push(sql`v.client_id is null`);
  else if (typeof filter.clientId === 'string') {
    if (!isUuid(filter.clientId)) throw new NotFoundError('거래처');
    conds.push(sql`(v.client_id is null or v.client_id = ${filter.clientId})`);
  }
  if (filter.includeInactive === false) conds.push(sql`v.active = true`);
  const r = await ctx.db.execute<Row>(sql`${SELECT} where ${sql.join(conds, sql` and `)} order by v.priority desc, v.code, v.client_id nulls first`);
  if (typeof filter.clientId !== 'string') return r.rows.map((x) => toDto(x));
  const cid = filter.clientId;
  const overriddenCodes = new Set(r.rows.filter((x) => x.client_id === cid).map((x) => x.code));
  const effectiveIds = new Set(resolveRulesForClient(r.rows.map((x) => ({ ...x, clientId: x.client_id })), cid).map((x) => x.id));
  return r.rows.map((x) => toDto(x, !x.client_id && overriddenCodes.has(x.code), effectiveIds.has(x.id)));
}

export interface VatRuleInput {
  /** null = 공통 규칙 (관리자) */
  clientId: string | null;
  code: string;
  name: string;
  condition: Condition;
  outcome: VatRuleOutcome;
  reasonText: string;
  /** 근거 조문 — 불공제·검토 규칙은 필수 */
  legalBasis?: string | null;
  confidence?: number;
  priority?: number;
  active?: boolean;
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,39}$/;

interface Validated {
  code: string;
  name: string;
  condition: Condition;
  outcome: VatRuleOutcome;
  reasonText: string;
  legalBasis: string | null;
  confidence: number;
  priority: number;
  active: boolean;
}

function validate(input: Omit<VatRuleInput, 'clientId'>): Validated {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!CODE_RE.test(code)) {
    throw new ValidationError('규칙 코드는 영문·숫자로 시작하는 2~40자(영문·숫자·-·_·.)여야 합니다. 예: VAT-CAR-01', [{ field: 'code', message: '형식 오류' }]);
  }
  const name = assertText(input.name, 'name', '규칙 이름', 100)!;
  const errs = ruleConditionErrors(input.condition);
  if (errs.length > 0) throw validationFailure('규칙 조건을 확인하세요.', errs, 'condition');
  if (!OUTCOMES.includes(input.outcome)) {
    throw new ValidationError('결과는 공제 / 불공제 / 검토 중 하나여야 합니다.', [{ field: 'outcome', message: '알 수 없는 결과' }]);
  }
  const reasonText = assertText(input.reasonText, 'reasonText', '사유 문구', 500)!;
  const legalBasis = assertText(input.legalBasis, 'legalBasis', '근거 조문', 200, input.outcome !== 'deductible');
  const confidence = assertIntRange(input.confidence ?? 90, 0, 100, 'confidence', '신뢰도');
  const priority = assertIntRange(input.priority ?? 100, -10000, 10000, 'priority', '우선순위');
  return { code, name, condition: input.condition, outcome: input.outcome, reasonText, legalBasis, confidence, priority, active: input.active ?? true };
}

function snapshot(v: Validated | Row): Record<string, unknown> {
  const r = v as Record<string, unknown>;
  return {
    code: r.code,
    name: r.name,
    condition: r.condition,
    conditionText: describeRuleCondition(r.condition as Condition),
    outcome: r.outcome,
    reasonText: r.reasonText ?? r.reason_text,
    legalBasis: r.legalBasis ?? r.legal_basis ?? null,
    confidence: r.confidence,
    priority: r.priority,
    active: r.active,
    clientId: r.client_id ?? r.clientId ?? null,
  };
}

/** 부가세 규칙 생성. 권한: rules.write (+ 공통은 settings.write) */
export async function createVatRule(ctx: ServiceContext, input: VatRuleInput): Promise<VatRuleDto> {
  requirePermission(ctx, 'rules.write');
  const clientId = input.clientId ?? null;
  requireScopePermission(ctx, clientId);
  const v = validate(input);
  const client = clientId ? await requireClient(ctx, clientId) : null;
  const now = ctx.now();
  let id: string;
  try {
    const [row] = await ctx.db
      .insert(vatRules)
      .values({
        code: v.code,
        name: v.name,
        condition: v.condition,
        outcome: v.outcome,
        reasonText: v.reasonText,
        legalBasis: v.legalBasis,
        confidence: v.confidence,
        priority: v.priority,
        clientId,
        active: v.active,
        updatedBy: ctx.actor.userId,
        updatedAt: now,
      })
      .returning({ id: vatRules.id });
    id = row!.id;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(`${client ? `${client.name}에 ` : '공통 규칙에 '}같은 코드(${v.code})의 부가세 규칙이 이미 있습니다. 기존 규칙을 수정하세요.`);
    }
    throw e;
  }
  await writeAudit(ctx, {
    action: 'vat_rule.create',
    category: 'data_change',
    entityType: 'vat_rule',
    entityId: id,
    clientId,
    summary: `부가세 규칙 생성: ${v.code} '${v.name}' ${client ? `[${client.name}]` : '[공통]'} → ${OUTCOME_LABEL[v.outcome]} (${describeRuleCondition(v.condition)})`,
    after: snapshot({ ...v, clientId } as Validated),
    revertible: true,
  });
  return toDto(await loadRow(ctx, id));
}

export type VatRulePatch = Partial<Omit<VatRuleInput, 'clientId' | 'code'>>;

/** 부가세 규칙 수정 (code·범위는 바꿀 수 없음). 권한: rules.write (+ 공통은 settings.write) */
export async function updateVatRule(ctx: ServiceContext, id: string, patch: VatRulePatch): Promise<VatRuleDto> {
  requirePermission(ctx, 'rules.write');
  const before = await loadRow(ctx, id);
  requireScopePermission(ctx, before.client_id);
  const merged = validate({
    code: before.code,
    name: patch.name ?? before.name,
    condition: patch.condition ?? before.condition,
    outcome: patch.outcome ?? before.outcome,
    reasonText: patch.reasonText ?? before.reason_text,
    legalBasis: patch.legalBasis !== undefined ? patch.legalBasis : before.legal_basis,
    confidence: patch.confidence ?? before.confidence,
    priority: patch.priority ?? before.priority,
    active: patch.active ?? before.active,
  });
  const changes: string[] = [];
  if (merged.name !== before.name) changes.push(`이름 '${before.name}' → '${merged.name}'`);
  if (JSON.stringify(merged.condition) !== JSON.stringify(before.condition)) changes.push(`조건 ${describeRuleCondition(before.condition)} → ${describeRuleCondition(merged.condition)}`);
  if (merged.outcome !== before.outcome) changes.push(`결과 ${OUTCOME_LABEL[before.outcome]} → ${OUTCOME_LABEL[merged.outcome]}`);
  if (merged.reasonText !== before.reason_text) changes.push('사유 문구 변경');
  if (merged.legalBasis !== before.legal_basis) changes.push(`근거 ${before.legal_basis ?? '없음'} → ${merged.legalBasis ?? '없음'}`);
  if (merged.confidence !== before.confidence) changes.push(`신뢰도 ${before.confidence} → ${merged.confidence}`);
  if (merged.priority !== before.priority) changes.push(`우선순위 ${before.priority} → ${merged.priority}`);
  if (merged.active !== before.active) changes.push(merged.active ? '사용' : '사용 안 함');
  if (changes.length === 0) return toDto(before);
  const now = ctx.now();
  await ctx.db.execute(sql`
    update vat_rules set name = ${merged.name}, condition = ${JSON.stringify(merged.condition)}::jsonb, outcome = ${merged.outcome},
      reason_text = ${merged.reasonText}, legal_basis = ${merged.legalBasis}, confidence = ${merged.confidence}, priority = ${merged.priority},
      active = ${merged.active}, updated_by = ${ctx.actor.userId}, updated_at = ${now.toISOString()}::timestamptz
    where id = ${id}
  `);
  await writeAudit(ctx, {
    action: 'vat_rule.update',
    category: 'data_change',
    entityType: 'vat_rule',
    entityId: id,
    clientId: before.client_id,
    summary: `부가세 규칙 수정: ${before.code} '${before.name}' ${before.client_name ? `[${before.client_name}]` : '[공통]'} — ${changes.join(', ')}`,
    before: snapshot(before),
    after: snapshot({ ...merged, clientId: before.client_id } as Validated),
    revertible: true,
  });
  return toDto(await loadRow(ctx, id));
}

/** 사용/사용 안 함. 권한: rules.write (+ 공통은 settings.write) */
export async function setVatRuleActive(ctx: ServiceContext, id: string, active: boolean): Promise<VatRuleDto> {
  requirePermission(ctx, 'rules.write');
  const before = await loadRow(ctx, id);
  requireScopePermission(ctx, before.client_id);
  return updateVatRule(ctx, id, { active });
}

/**
 * 공통 규칙을 수임처용으로 덮어쓰기 (같은 code, client_id 지정). 권한: rules.write
 * 예) 이 수임처는 차량 관련 매입을 공제로 본다 (화물차 보유)
 */
export async function overrideVatRuleForClient(ctx: ServiceContext, globalRuleId: string, clientId: string, patch: VatRulePatch = {}): Promise<VatRuleDto> {
  requirePermission(ctx, 'rules.write');
  const base = await loadRow(ctx, globalRuleId);
  if (base.client_id !== null) {
    throw new ValidationError('수임처 규칙은 다시 덮어쓸 수 없습니다. 그 규칙을 직접 수정하세요.', [{ field: 'ruleId', message: '공통 규칙이 아님' }]);
  }
  return createVatRule(ctx, {
    clientId,
    code: base.code,
    name: patch.name ?? base.name,
    condition: patch.condition ?? base.condition,
    outcome: patch.outcome ?? base.outcome,
    reasonText: patch.reasonText ?? base.reason_text,
    legalBasis: patch.legalBasis !== undefined ? patch.legalBasis : base.legal_basis,
    confidence: patch.confidence ?? base.confidence,
    priority: patch.priority ?? base.priority,
    active: patch.active ?? base.active,
  });
}

/** 수임처 override 삭제 → 공통 규칙으로 되돌림. 권한: rules.write. 공통 규칙은 삭제 불가(비활성화만) */
export async function removeVatRuleOverride(ctx: ServiceContext, id: string): Promise<{ removed: true; code: string }> {
  requirePermission(ctx, 'rules.write');
  const before = await loadRow(ctx, id);
  if (before.client_id === null) {
    throw new ValidationError('공통 부가세 규칙은 삭제할 수 없습니다. 필요 없으면 "사용 안 함"으로 바꾸세요.', [{ field: 'id', message: '공통 규칙' }]);
  }
  await ctx.db.execute(sql`delete from vat_rules where id = ${id}`);
  await writeAudit(ctx, {
    action: 'vat_rule.remove_override',
    category: 'data_change',
    entityType: 'vat_rule',
    entityId: id,
    clientId: before.client_id,
    summary: `부가세 규칙 수임처 설정 삭제: ${before.code} '${before.name}' [${before.client_name ?? '거래처'}] → 공통 규칙 적용`,
    before: snapshot(before),
    after: null,
    revertible: true,
  });
  return { removed: true, code: before.code };
}
