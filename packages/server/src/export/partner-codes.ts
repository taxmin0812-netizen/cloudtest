/**
 * WEHAGO 거래처코드 연결 (매입매출전표는 거래처코드 필수 — research/01 §2.4).
 *
 * 거래처(사업자번호) → WEHAGO 거래처코드 매핑 테이블이 아직 없어(docs/03 §14 G2) settings 에 수임처별로 둔다:
 *   settings['wehago_partner_codes:<clientId>'] = { byBizNo, byName }
 * 채우는 방법: (1) 사람이 연결(saveWehagoPartnerCodes) (2) WEHAGO 매입매출장 역수입 시 자동 학습(learnPartnerCodes).
 * 코드를 추측해 만들지 않는다 — 없는 코드는 차단 사유로 올린다.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { normalizeBusinessNumber, normalizeMerchantName } from '@mintax/core';
import { settings, transactions } from '@mintax/db';
import { ValidationError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { getSetting } from '../infra/settings';
import { loadClientProfile } from '../infra/clients';
import { APPROVED_STATUSES, assertPeriod, assertUuid, emptyPartnerStore, lookupPartnerCode, type PartnerCodeStore } from './helpers';
import type { PartnerCodeDTO, UnmappedPartnerDTO } from './types';

export function partnerSettingKey(clientId: string): string {
  return `wehago_partner_codes:${clientId}`;
}

const CODE_RE = /^[0-9A-Za-z-]{1,20}$/;

export async function loadPartnerStore(ctx: Pick<ServiceContext, 'db'>, clientId: string): Promise<PartnerCodeStore> {
  const v = await getSetting<Partial<PartnerCodeStore> | null>(ctx, partnerSettingKey(clientId), null);
  return { byBizNo: { ...(v?.byBizNo ?? {}) }, byName: { ...(v?.byName ?? {}) } };
}

async function saveStore(ctx: ServiceContext, clientId: string, store: PartnerCodeStore): Promise<void> {
  await ctx.db
    .insert(settings)
    .values({ key: partnerSettingKey(clientId), value: store, updatedBy: ctx.actor.userId, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value: store, updatedBy: ctx.actor.userId, updatedAt: ctx.now() } });
}

function toDTOs(store: PartnerCodeStore): PartnerCodeDTO[] {
  const out: PartnerCodeDTO[] = [];
  for (const [biz, v] of Object.entries(store.byBizNo)) out.push({ businessNumber: biz, merchantKey: null, merchantName: v.name, code: v.code, source: v.source, updatedAt: v.updatedAt });
  for (const [key, v] of Object.entries(store.byName)) out.push({ businessNumber: null, merchantKey: key, merchantName: v.name, code: v.code, source: v.source, updatedAt: v.updatedAt });
  return out.sort((a, b) => a.merchantName.localeCompare(b.merchantName, 'ko'));
}

export async function getWehagoPartnerCodes(ctx: ServiceContext, clientId: string): Promise<PartnerCodeDTO[]> {
  requirePermission(ctx, 'export.create');
  assertUuid(clientId, 'clientId', '거래처');
  return toDTOs(await loadPartnerStore(ctx, clientId));
}

export interface PartnerCodeInput {
  businessNumber?: string | null;
  merchantName?: string | null;
  code: string;
}

/** 사람이 WEHAGO 거래처등록의 코드를 연결한다. 사업자번호가 있으면 사업자번호 기준, 없으면 상호 기준. */
export async function saveWehagoPartnerCodes(ctx: ServiceContext, input: { clientId: string; entries: PartnerCodeInput[] }): Promise<PartnerCodeDTO[]> {
  requirePermission(ctx, 'export.create');
  const clientId = assertUuid(input.clientId, 'clientId', '거래처');
  const client = await loadClientProfile(ctx, clientId);
  const entries = input.entries ?? [];
  if (entries.length === 0) throw new ValidationError('연결할 거래처코드가 없습니다.', [{ field: 'entries', message: '1건 이상' }]);
  const errors: Array<{ field: string; message: string }> = [];
  entries.forEach((e, i) => {
    if (!CODE_RE.test((e.code ?? '').trim())) errors.push({ field: `entries.${i}.code`, message: 'WEHAGO 거래처코드(숫자/영문, 20자 이내)' });
    if (!normalizeBusinessNumber(e.businessNumber ?? null) && !normalizeMerchantName(e.merchantName ?? '')) {
      errors.push({ field: `entries.${i}`, message: '사업자번호 또는 상호가 필요합니다' });
    }
  });
  if (errors.length) throw new ValidationError('거래처코드 입력값을 확인해 주세요.', errors);

  const store = await loadPartnerStore(ctx, clientId);
  const now = ctx.now().toISOString();
  const changes: Array<{ target: string; before: string | null; after: string }> = [];
  for (const e of entries) {
    const code = e.code.trim();
    const biz = normalizeBusinessNumber(e.businessNumber ?? null);
    const name = (e.merchantName ?? '').trim() || biz || '';
    if (biz) {
      changes.push({ target: `${name}(${biz})`, before: store.byBizNo[biz]?.code ?? null, after: code });
      store.byBizNo[biz] = { code, name, source: 'manual', updatedAt: now };
    } else {
      const key = normalizeMerchantName(name);
      changes.push({ target: name, before: store.byName[key]?.code ?? null, after: code });
      store.byName[key] = { code, name, source: 'manual', updatedAt: now };
    }
  }
  await saveStore(ctx, clientId, store);
  const head = changes.slice(0, 3).map((c) => `${c.target} ${c.before ? `${c.before} → ` : '→ '}${c.after}`).join(', ');
  await writeAudit(ctx, {
    action: 'wehago_partner_code.update',
    category: 'data_change',
    entityType: 'client',
    entityId: clientId,
    clientId,
    summary: `${client.name} WEHAGO 거래처코드 ${changes.length}건 연결: ${head}${changes.length > 3 ? ` 외 ${changes.length - 3}건` : ''}`,
    before: { codes: changes.map((c) => ({ target: c.target, code: c.before })) },
    after: { codes: changes.map((c) => ({ target: c.target, code: c.after })) },
    revertible: true,
  });
  return toDTOs(store);
}

/** 이 기간 승인 거래 중 WEHAGO 거래처코드가 없는 거래처 목록 (연결 화면용) */
export async function listUnmappedPartners(ctx: ServiceContext, input: { clientId: string; period: string }): Promise<UnmappedPartnerDTO[]> {
  requirePermission(ctx, 'export.create');
  const clientId = assertUuid(input.clientId, 'clientId', '거래처');
  const period = assertPeriod(input.period);
  const store = await loadPartnerStore(ctx, clientId);
  const rows = await ctx.db
    .select({
      merchantName: transactions.merchantName,
      businessNumber: transactions.merchantBusinessNumber,
      count: sql<number>`count(*)::int`,
      total: sql<number>`sum(${transactions.totalAmount})::bigint`,
    })
    .from(transactions)
    .where(and(eq(transactions.clientId, clientId), eq(transactions.period, period), inArray(transactions.status, [...APPROVED_STATUSES])))
    .groupBy(transactions.merchantName, transactions.merchantBusinessNumber);
  const merged = new Map<string, UnmappedPartnerDTO>();
  for (const r of rows) {
    if (lookupPartnerCode(store, r.businessNumber, r.merchantName)) continue;
    const key = r.businessNumber ?? normalizeMerchantName(r.merchantName);
    const e = merged.get(key);
    if (e) {
      e.transactionCount += Number(r.count);
      e.totalAmount += Number(r.total);
    } else merged.set(key, { merchantName: r.merchantName, businessNumber: r.businessNumber, transactionCount: Number(r.count), totalAmount: Number(r.total) });
  }
  return [...merged.values()].sort((a, b) => b.transactionCount - a.transactionCount || a.merchantName.localeCompare(b.merchantName, 'ko'));
}

/**
 * WEHAGO 매입매출장(역수입)의 거래처코드를 학습한다. 사람이 연결한 코드는 덮어쓰지 않는다.
 * 반환: 새로 알게 된 코드 수.
 */
export async function learnPartnerCodes(
  ctx: ServiceContext,
  clientId: string,
  rows: ReadonlyArray<{ code: string | null; businessNumber: string | null; merchantName: string }>,
): Promise<number> {
  const store = await loadPartnerStore(ctx, clientId);
  const now = ctx.now().toISOString();
  const learned: string[] = [];
  for (const r of rows) {
    const code = (r.code ?? '').trim();
    if (!CODE_RE.test(code)) continue;
    const biz = normalizeBusinessNumber(r.businessNumber);
    if (biz) {
      if (store.byBizNo[biz]) continue;
      store.byBizNo[biz] = { code, name: r.merchantName, source: 'wehago_ledger', updatedAt: now };
      learned.push(`${r.merchantName} → ${code}`);
    } else {
      const key = normalizeMerchantName(r.merchantName);
      if (!key || store.byName[key]) continue;
      store.byName[key] = { code, name: r.merchantName, source: 'wehago_ledger', updatedAt: now };
      learned.push(`${r.merchantName} → ${code}`);
    }
  }
  if (learned.length === 0) return 0;
  await saveStore(ctx, clientId, store);
  await writeAudit(ctx, {
    action: 'wehago_partner_code.learn',
    category: 'data_change',
    entityType: 'client',
    entityId: clientId,
    clientId,
    summary: `WEHAGO 매입매출장에서 거래처코드 ${learned.length}건 학습: ${learned.slice(0, 3).join(', ')}${learned.length > 3 ? ` 외 ${learned.length - 3}건` : ''}`,
    before: null,
    after: { learned: learned.slice(0, 200) },
  });
  return learned.length;
}

export { emptyPartnerStore };
