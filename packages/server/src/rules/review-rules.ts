/**
 * Rule Studio — 고위험(검토) 규칙 (review_rules). 금액 기준 등은 params 로만 (하드코딩 금지).
 * - 공통 규칙(client_id null): settings.write (관리자)
 * - 수임처 override(같은 code + client_id): rules.write
 * - 저장 전 validateReviewRule (core) + 파라미터 형식 검사 ("3,000,000" 같은 입력은 숫자로 변환)
 */
import { sql } from 'drizzle-orm';
import { reviewRules } from '@mintax/db';
import type { Condition, ExceptionBucket, RiskSeverity } from '@mintax/core';
import {
  DEFAULT_REVIEW_RULES,
  REVIEW_RULE_KINDS,
  bindParams,
  resolveRuleParams,
  resolveRulesForClient,
  validateReviewRule,
  type ReviewRuleDef,
  type ReviewRuleKind,
  type RuleParamValue,
} from '@mintax/core/engine/vat-risk-index';
import { ConflictError, NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { isUuid } from '../classification/helpers';
import { describeRuleCondition, parseNumberInput, ruleConditionErrors, validationFailure } from './describe';
import { assertText, isUniqueViolation, requireClient, requireScopePermission, toIso } from './common';

export interface ReviewRuleDto {
  id: string;
  code: string;
  name: string;
  kind: ReviewRuleKind;
  condition: Condition | null;
  /** 파라미터를 넣은 조건의 읽기 문장 */
  conditionText: string;
  params: Record<string, RuleParamValue>;
  /** clientId 로 조회했을 때 수임처 프로필 rule_params 까지 반영한 실제 값 */
  effectiveParams: Record<string, RuleParamValue> | null;
  bucket: ExceptionBucket;
  severity: RiskSeverity;
  blocksAutoApproval: boolean;
  messageTemplate: string;
  clientId: string | null;
  clientName: string | null;
  scope: 'global' | 'client';
  active: boolean;
  appliedCount: number;
  lastAppliedAt: string | null;
  updatedAt: string;
  updatedByName: string | null;
  isDefault: boolean;
  overridden: boolean;
  effective: boolean | null;
}

const DEFAULT_CODES = new Set(DEFAULT_REVIEW_RULES.map((r) => r.code));
const SEVERITY_LABEL: Record<RiskSeverity, string> = { info: '참고', warning: '주의', high: '높음' };

type Row = {
  id: string;
  code: string;
  name: string;
  kind: ReviewRuleKind;
  condition: Condition | null;
  params: Record<string, RuleParamValue>;
  bucket: ExceptionBucket;
  severity: RiskSeverity;
  blocks_auto_approval: boolean;
  message_template: string;
  client_id: string | null;
  client_name: string | null;
  active: boolean;
  applied_count: number;
  last_applied_at: Date | null;
  updated_at: Date;
  updated_by_name: string | null;
};

const SELECT = sql`
  select r.id, r.code, r.name, r.kind, r.condition, r.params, r.bucket, r.severity, r.blocks_auto_approval, r.message_template,
         r.client_id, c.name as client_name, r.active, r.applied_count, r.last_applied_at, r.updated_at, u.name as updated_by_name
  from review_rules r
  left join clients c on c.id = r.client_id
  left join users u on u.id = r.updated_by
`;

function toDef(r: Row): ReviewRuleDef {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    condition: r.condition,
    params: r.params ?? {},
    bucket: r.bucket,
    severity: r.severity,
    blocksAutoApproval: r.blocks_auto_approval,
    messageTemplate: r.message_template,
    clientId: r.client_id,
    active: r.active,
  };
}

function condText(cond: Condition | null, params: Record<string, RuleParamValue>): string {
  if (!cond) return '(추가 조건 없음)';
  try {
    return describeRuleCondition(bindParams(cond, params));
  } catch {
    return describeRuleCondition(cond);
  }
}

function toDto(r: Row, extra: { effectiveParams?: Record<string, RuleParamValue> | null; overridden?: boolean; effective?: boolean | null } = {}): ReviewRuleDto {
  const params = r.params ?? {};
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    condition: r.condition,
    conditionText: condText(r.condition, extra.effectiveParams ?? params),
    params,
    effectiveParams: extra.effectiveParams ?? null,
    bucket: r.bucket,
    severity: r.severity,
    blocksAutoApproval: r.blocks_auto_approval,
    messageTemplate: r.message_template,
    clientId: r.client_id,
    clientName: r.client_name,
    scope: r.client_id ? 'client' : 'global',
    active: r.active,
    appliedCount: r.applied_count,
    lastAppliedAt: toIso(r.last_applied_at),
    updatedAt: toIso(r.updated_at)!,
    updatedByName: r.updated_by_name,
    isDefault: DEFAULT_CODES.has(r.code),
    overridden: extra.overridden ?? false,
    effective: extra.effective ?? null,
  };
}

async function loadRow(ctx: Pick<ServiceContext, 'db'>, id: string): Promise<Row> {
  if (!isUuid(id)) throw new NotFoundError('위험 규칙');
  const r = await ctx.db.execute<Row>(sql`${SELECT} where r.id = ${id}`);
  if (!r.rows[0]) throw new NotFoundError('위험 규칙');
  return r.rows[0];
}

/** 위험 규칙 목록 (적용 횟수 포함). clientId 를 주면 공통 + override, 실제 적용 여부와 수임처 파라미터 반영값까지. 권한: rules.read */
export async function listReviewRules(ctx: ServiceContext, filter: { clientId?: string | null; includeInactive?: boolean } = {}): Promise<ReviewRuleDto[]> {
  requirePermission(ctx, 'rules.read');
  const conds = [sql`true`];
  if (filter.clientId === null) conds.push(sql`r.client_id is null`);
  else if (typeof filter.clientId === 'string') {
    if (!isUuid(filter.clientId)) throw new NotFoundError('거래처');
    conds.push(sql`(r.client_id is null or r.client_id = ${filter.clientId})`);
  }
  if (filter.includeInactive === false) conds.push(sql`r.active = true`);
  const r = await ctx.db.execute<Row>(sql`${SELECT} where ${sql.join(conds, sql` and `)} order by r.code, r.client_id nulls first`);
  if (typeof filter.clientId !== 'string') return r.rows.map((x) => toDto(x));
  const cid = filter.clientId;
  const prof = await ctx.db.execute<{ rule_params: Record<string, number | string | boolean> | null }>(sql`
    select rule_params from client_business_profiles where client_id = ${cid}
  `);
  const ruleParams = prof.rows[0]?.rule_params ?? {};
  const overriddenCodes = new Set(r.rows.filter((x) => x.client_id === cid).map((x) => x.code));
  const effectiveIds = new Set(resolveRulesForClient(r.rows.map(toDef), cid).map((x) => x.id));
  return r.rows.map((x) =>
    toDto(x, {
      effectiveParams: resolveRuleParams(toDef(x), ruleParams),
      overridden: !x.client_id && overriddenCodes.has(x.code),
      effective: effectiveIds.has(x.id),
    }),
  );
}

/**
 * 파라미터 입력 정리: 기존 값 형식에 맞춘다 (숫자 ← "3,000,000", 목록 ← "골프, 유흥").
 * 금액·건수·비율·개월 성격의 숫자는 0 이상이어야 한다.
 */
export function normalizeReviewParams(
  input: Record<string, unknown>,
  base: Record<string, RuleParamValue>,
): { params: Record<string, RuleParamValue>; errors: string[] } {
  const out: Record<string, RuleParamValue> = { ...base };
  const errors: string[] = [];
  for (const [k, raw] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)) {
      errors.push(`params.${k}: 파라미터 이름은 영문·숫자·_ 만 쓸 수 있습니다`);
      continue;
    }
    const prev = base[k];
    if (typeof prev === 'number' || (prev === undefined && (typeof raw === 'number' || parseNumberInput(raw) !== null))) {
      const n = parseNumberInput(raw);
      if (n === null) {
        errors.push(`params.${k}: 숫자를 입력하세요 (예: 3,000,000)`);
        continue;
      }
      if (n < 0 && /threshold|amount|count|ratio|months|min|max|hour|day/i.test(k)) {
        errors.push(`params.${k}: 0 이상이어야 합니다`);
        continue;
      }
      out[k] = n;
    } else if (Array.isArray(prev) || Array.isArray(raw)) {
      const list = Array.isArray(raw) ? raw.map((x) => String(x).trim()) : String(raw ?? '').split(',').map((s) => s.trim());
      const cleaned = list.filter(Boolean).slice(0, 500);
      if (cleaned.length === 0) {
        errors.push(`params.${k}: 최소 1개 이상의 값이 필요합니다`);
        continue;
      }
      out[k] = cleaned;
    } else if (typeof prev === 'boolean' || typeof raw === 'boolean') {
      if (typeof raw === 'boolean') out[k] = raw;
      else if (raw === 'true' || raw === 'false') out[k] = raw === 'true';
      else errors.push(`params.${k}: 예/아니오(true/false) 값이어야 합니다`);
    } else {
      const s = String(raw ?? '').trim();
      if (s.length > 500) errors.push(`params.${k}: 500자 이하여야 합니다`);
      else out[k] = s;
    }
  }
  return { params: out, errors };
}

export interface ReviewRuleInput {
  clientId: string | null;
  code: string;
  name: string;
  kind: ReviewRuleKind;
  condition?: Condition | null;
  params?: Record<string, unknown>;
  bucket: ExceptionBucket;
  severity: RiskSeverity;
  blocksAutoApproval?: boolean;
  messageTemplate: string;
  active?: boolean;
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,39}$/;

function validateDef(def: ReviewRuleDef): void {
  if (!CODE_RE.test(def.code)) {
    throw new ValidationError('규칙 코드는 영문·숫자로 시작하는 2~40자(영문·숫자·-·_·.)여야 합니다. 예: RISK-HIGH-AMOUNT', [{ field: 'code', message: '형식 오류' }]);
  }
  if (!REVIEW_RULE_KINDS.includes(def.kind)) {
    throw new ValidationError(`알 수 없는 규칙 종류입니다: ${String(def.kind)}`, [{ field: 'kind', message: REVIEW_RULE_KINDS.join(', ') }]);
  }
  const errs = [...validateReviewRule(def)];
  if (def.condition) {
    // $파라미터 치환 후 조건 크기·깊이 검사
    const bound = bindParams(def.condition, def.params);
    for (const e of ruleConditionErrors(bound)) if (!errs.includes(e)) errs.push(e);
  }
  if (errs.length > 0) throw validationFailure('위험 규칙 설정을 확인하세요.', errs, 'rule');
}

function snapshot(d: ReviewRuleDef): Record<string, unknown> {
  return {
    code: d.code,
    name: d.name,
    kind: d.kind,
    condition: d.condition ?? null,
    params: d.params,
    bucket: d.bucket,
    severity: d.severity,
    blocksAutoApproval: d.blocksAutoApproval,
    messageTemplate: d.messageTemplate,
    active: d.active ?? true,
    clientId: d.clientId ?? null,
  };
}

function paramDiff(a: Record<string, RuleParamValue>, b: Record<string, RuleParamValue>): string[] {
  const out: string[] = [];
  const fmt = (v: RuleParamValue | undefined) =>
    v === undefined ? '없음' : Array.isArray(v) ? `[${v.slice(0, 5).join(', ')}${v.length > 5 ? ` 외 ${v.length - 5}` : ''}]` : typeof v === 'number' ? v.toLocaleString('ko-KR') : String(v);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`${k} ${fmt(a[k])} → ${fmt(b[k])}`);
  }
  return out;
}

/** 위험 규칙 생성. 권한: rules.write (+ 공통은 settings.write) */
export async function createReviewRule(ctx: ServiceContext, input: ReviewRuleInput): Promise<ReviewRuleDto> {
  requirePermission(ctx, 'rules.write');
  const clientId = input.clientId ?? null;
  requireScopePermission(ctx, clientId);
  const { params, errors } = normalizeReviewParams(input.params ?? {}, {});
  if (errors.length > 0) throw validationFailure('규칙 파라미터를 확인하세요.', errors, 'params');
  const def: ReviewRuleDef = {
    code: typeof input.code === 'string' ? input.code.trim() : '',
    name: assertText(input.name, 'name', '규칙 이름', 100)!,
    kind: input.kind,
    condition: input.condition ?? null,
    params,
    bucket: input.bucket,
    severity: input.severity,
    blocksAutoApproval: input.blocksAutoApproval ?? true,
    messageTemplate: assertText(input.messageTemplate, 'messageTemplate', '안내 문구', 500)!,
    clientId,
    active: input.active ?? true,
  };
  validateDef(def);
  const client = clientId ? await requireClient(ctx, clientId) : null;
  const now = ctx.now();
  let id: string;
  try {
    const [row] = await ctx.db
      .insert(reviewRules)
      .values({
        code: def.code,
        name: def.name,
        kind: def.kind,
        condition: def.condition ?? null,
        params: def.params,
        bucket: def.bucket,
        severity: def.severity,
        blocksAutoApproval: def.blocksAutoApproval,
        messageTemplate: def.messageTemplate,
        clientId,
        active: def.active ?? true,
        updatedBy: ctx.actor.userId,
        updatedAt: now,
      })
      .returning({ id: reviewRules.id });
    id = row!.id;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(`${client ? `${client.name}에 ` : '공통 규칙에 '}같은 코드(${def.code})의 위험 규칙이 이미 있습니다. 기존 규칙을 수정하세요.`);
    }
    throw e;
  }
  await writeAudit(ctx, {
    action: 'review_rule.create',
    category: 'data_change',
    entityType: 'review_rule',
    entityId: id,
    clientId,
    summary: `위험 규칙 생성: ${def.code} '${def.name}' ${client ? `[${client.name}]` : '[공통]'} — 심각도 ${SEVERITY_LABEL[def.severity]}${def.blocksAutoApproval ? ', 자동확정 차단' : ''}`,
    after: snapshot(def),
    revertible: true,
  });
  return toDto(await loadRow(ctx, id));
}

export interface ReviewRulePatch {
  name?: string;
  condition?: Condition | null;
  /** 바꿀 파라미터만 (나머지는 유지). 예: { threshold: "3,000,000" } */
  params?: Record<string, unknown>;
  bucket?: ExceptionBucket;
  severity?: RiskSeverity;
  blocksAutoApproval?: boolean;
  messageTemplate?: string;
  active?: boolean;
}

/** 위험 규칙 수정 (파라미터 편집 포함, code·종류·범위는 고정). 권한: rules.write (+ 공통은 settings.write) */
export async function updateReviewRule(ctx: ServiceContext, id: string, patch: ReviewRulePatch): Promise<ReviewRuleDto> {
  requirePermission(ctx, 'rules.write');
  const before = await loadRow(ctx, id);
  requireScopePermission(ctx, before.client_id);
  const prev = toDef(before);
  const { params, errors } = normalizeReviewParams(patch.params ?? {}, prev.params);
  if (errors.length > 0) throw validationFailure('규칙 파라미터를 확인하세요.', errors, 'params');
  const next: ReviewRuleDef = {
    ...prev,
    name: patch.name !== undefined ? assertText(patch.name, 'name', '규칙 이름', 100)! : prev.name,
    condition: patch.condition !== undefined ? patch.condition : prev.condition,
    params,
    bucket: patch.bucket ?? prev.bucket,
    severity: patch.severity ?? prev.severity,
    blocksAutoApproval: patch.blocksAutoApproval ?? prev.blocksAutoApproval,
    messageTemplate: patch.messageTemplate !== undefined ? assertText(patch.messageTemplate, 'messageTemplate', '안내 문구', 500)! : prev.messageTemplate,
    active: patch.active ?? prev.active,
  };
  validateDef(next);
  const changes: string[] = [];
  if (next.name !== prev.name) changes.push(`이름 '${prev.name}' → '${next.name}'`);
  if (JSON.stringify(next.condition ?? null) !== JSON.stringify(prev.condition ?? null)) changes.push('조건 변경');
  changes.push(...paramDiff(prev.params, next.params));
  if (next.bucket !== prev.bucket) changes.push(`버킷 ${prev.bucket} → ${next.bucket}`);
  if (next.severity !== prev.severity) changes.push(`심각도 ${SEVERITY_LABEL[prev.severity]} → ${SEVERITY_LABEL[next.severity]}`);
  if (next.blocksAutoApproval !== prev.blocksAutoApproval) changes.push(next.blocksAutoApproval ? '자동확정 차단' : '자동확정 차단 해제');
  if (next.messageTemplate !== prev.messageTemplate) changes.push('안내 문구 변경');
  if (next.active !== prev.active) changes.push(next.active ? '사용' : '사용 안 함');
  if (changes.length === 0) return toDto(before);
  const now = ctx.now();
  await ctx.db.execute(sql`
    update review_rules set name = ${next.name}, condition = ${next.condition ? JSON.stringify(next.condition) : null}::jsonb,
      params = ${JSON.stringify(next.params)}::jsonb, bucket = ${next.bucket}, severity = ${next.severity},
      blocks_auto_approval = ${next.blocksAutoApproval}, message_template = ${next.messageTemplate}, active = ${next.active ?? true},
      updated_by = ${ctx.actor.userId}, updated_at = ${now.toISOString()}::timestamptz
    where id = ${id}
  `);
  await writeAudit(ctx, {
    action: 'review_rule.update',
    category: 'data_change',
    entityType: 'review_rule',
    entityId: id,
    clientId: before.client_id,
    summary: `위험 규칙 수정: ${prev.code} '${prev.name}' ${before.client_name ? `[${before.client_name}]` : '[공통]'} — ${changes.join(', ')}`,
    before: snapshot(prev),
    after: snapshot(next),
    revertible: true,
  });
  return toDto(await loadRow(ctx, id));
}

/** 파라미터만 수정 (예: 고액 기준 3,000,000). 권한: rules.write (+ 공통은 settings.write) */
export async function updateReviewRuleParams(ctx: ServiceContext, id: string, params: Record<string, unknown>): Promise<ReviewRuleDto> {
  requirePermission(ctx, 'rules.write');
  return updateReviewRule(ctx, id, { params });
}

/** 사용/사용 안 함. 권한: rules.write (+ 공통은 settings.write) */
export async function setReviewRuleActive(ctx: ServiceContext, id: string, active: boolean): Promise<ReviewRuleDto> {
  requirePermission(ctx, 'rules.write');
  return updateReviewRule(ctx, id, { active });
}

/** 공통 위험 규칙을 수임처용으로 덮어쓰기 (예: 이 수임처만 고액 기준 300만원). 권한: rules.write */
export async function overrideReviewRuleForClient(ctx: ServiceContext, globalRuleId: string, clientId: string, patch: ReviewRulePatch = {}): Promise<ReviewRuleDto> {
  requirePermission(ctx, 'rules.write');
  const base = await loadRow(ctx, globalRuleId);
  if (base.client_id !== null) {
    throw new ValidationError('수임처 규칙은 다시 덮어쓸 수 없습니다. 그 규칙을 직접 수정하세요.', [{ field: 'ruleId', message: '공통 규칙이 아님' }]);
  }
  const def = toDef(base);
  const { params, errors } = normalizeReviewParams(patch.params ?? {}, def.params);
  if (errors.length > 0) throw validationFailure('규칙 파라미터를 확인하세요.', errors, 'params');
  return createReviewRule(ctx, {
    clientId,
    code: def.code,
    name: patch.name ?? def.name,
    kind: def.kind,
    condition: patch.condition !== undefined ? patch.condition : def.condition,
    params,
    bucket: patch.bucket ?? def.bucket,
    severity: patch.severity ?? def.severity,
    blocksAutoApproval: patch.blocksAutoApproval ?? def.blocksAutoApproval,
    messageTemplate: patch.messageTemplate ?? def.messageTemplate,
    active: patch.active ?? def.active,
  });
}

/** 수임처 override 삭제 → 공통 규칙으로 되돌림. 권한: rules.write. 공통 규칙은 삭제 불가 */
export async function removeReviewRuleOverride(ctx: ServiceContext, id: string): Promise<{ removed: true; code: string }> {
  requirePermission(ctx, 'rules.write');
  const before = await loadRow(ctx, id);
  if (before.client_id === null) {
    throw new ValidationError('공통 위험 규칙은 삭제할 수 없습니다. 필요 없으면 "사용 안 함"으로 바꾸세요.', [{ field: 'id', message: '공통 규칙' }]);
  }
  await ctx.db.execute(sql`delete from review_rules where id = ${id}`);
  await writeAudit(ctx, {
    action: 'review_rule.remove_override',
    category: 'data_change',
    entityType: 'review_rule',
    entityId: id,
    clientId: before.client_id,
    summary: `위험 규칙 수임처 설정 삭제: ${before.code} '${before.name}' [${before.client_name ?? '거래처'}] → 공통 규칙 적용`,
    before: snapshot(toDef(before)),
    after: null,
    revertible: true,
  });
  return { removed: true, code: before.code };
}
