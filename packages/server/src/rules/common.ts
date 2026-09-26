/**
 * rules 영역 공통 도우미 (DB 접근 포함).
 */
import { sql } from 'drizzle-orm';
import type { AccountCode, Permission } from '@mintax/core';
import { NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { loadAccountCodes } from '../classification/inputs';
import { isUuid } from '../classification/helpers';

export function toIso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

/**
 * 권한 검사 + 거부 시 보안 감사로그 (규칙 승인처럼 4-eyes 가 걸린 작업).
 * "담당자가 규칙 승인 시도 → 403 + 감사 security 로그" (docs/06 §시나리오)
 */
export async function requirePermissionAudited(
  ctx: ServiceContext,
  permission: Permission,
  attempt: { what: string; entityType: string; entityId?: string | null; clientId?: string | null },
): Promise<void> {
  try {
    requirePermission(ctx, permission);
  } catch (e) {
    await writeAudit(ctx, {
      action: 'security.permission_denied',
      category: 'security',
      entityType: attempt.entityType,
      entityId: attempt.entityId ?? null,
      clientId: attempt.clientId && isUuid(attempt.clientId) ? attempt.clientId : null,
      summary: `권한 없음: ${ctx.actor.name}님이 ${attempt.what}을(를) 시도했습니다 (필요 권한: ${permission})`,
      after: { permission, role: ctx.actor.role },
    }).catch(() => undefined);
    throw e;
  }
}

/** 거래처 이름 (없으면 NotFoundError) */
export async function requireClient(ctx: Pick<ServiceContext, 'db'>, clientId: string): Promise<{ id: string; name: string; industry: string }> {
  if (!isUuid(clientId)) throw new NotFoundError('거래처');
  const r = await ctx.db.execute<{ id: string; name: string; industry: string | null }>(sql`
    select c.id, c.name, p.industry from clients c left join client_business_profiles p on p.client_id = c.id where c.id = ${clientId}
  `);
  const row = r.rows[0];
  if (!row) throw new NotFoundError('거래처');
  return { id: row.id, name: row.name, industry: row.industry ?? 'other' };
}

/** 계정과목 확인 — 계정과목표에 있고 사용 중이어야 한다 */
export async function requireAccount(ctx: Pick<ServiceContext, 'db'>, code: unknown, field = 'accountCode'): Promise<AccountCode> {
  const c = typeof code === 'string' ? code.trim() : '';
  if (!c) throw new ValidationError('계정과목을 선택하세요.', [{ field, message: '계정코드가 비어 있습니다' }]);
  const { accounts } = await loadAccountCodes(ctx.db);
  const acc = accounts.find((a) => a.code === c);
  if (!acc) {
    throw new ValidationError(`계정과목표에 없는 계정코드(${c})입니다. 계정과목 목록에서 선택하세요.`, [{ field, message: '계정과목표에 없는 코드' }]);
  }
  if (!acc.active) {
    throw new ValidationError(`사용하지 않는 계정(${acc.code} ${acc.name})입니다. 다른 계정을 선택하거나 계정과목 설정에서 사용으로 바꾸세요.`, [
      { field, message: '비활성 계정' },
    ]);
  }
  return acc;
}

export function assertIntRange(v: unknown, min: number, max: number, field: string, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`${label}은(는) ${min}~${max} 사이 정수여야 합니다.`, [{ field, message: `${min}~${max} 정수` }]);
  }
  return v;
}

export function assertText(v: unknown, field: string, label: string, max = 200, required = true): string | null {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw new ValidationError(`${label}을(를) 입력하세요.`, [{ field, message: '필수 입력' }]);
    return null;
  }
  if (typeof v !== 'string') throw new ValidationError(`${label} 형식이 올바르지 않습니다.`, [{ field, message: '문자열이어야 합니다' }]);
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`${label}은(는) ${max}자 이하로 입력하세요.`, [{ field, message: `${max}자 이하` }]);
  return s;
}

/** 공통(client_id null) 규칙은 설정 권한(관리자)만 */
export function requireScopePermission(ctx: ServiceContext, clientId: string | null): void {
  if (clientId === null) requirePermission(ctx, 'settings.write');
}

/** PostgreSQL unique 위반인가 */
export function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === 'object' && cur !== null && (cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
