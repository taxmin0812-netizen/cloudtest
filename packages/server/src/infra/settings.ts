import { eq } from 'drizzle-orm';
import { settings } from '@mintax/db';
import { DEFAULT_CONFIDENCE_POLICY, type ConfidencePolicy } from '@mintax/core';
import type { ServiceContext } from '../context';
import { writeAudit } from './audit';

/** 설정 키 목록 (값은 JSON) */
export const SETTING_KEYS = {
  confidencePolicy: 'confidence_policy',
  currentPeriod: 'current_period',
  payrollLargeChangePct: 'payroll_large_change_pct',
  wehagoPurchaseTemplate: 'wehago_template_purchase_sales',
  wehagoJournalTemplate: 'wehago_template_general_journal',
  aiProvider: 'ai_provider',
} as const;

export async function getSetting<T>(ctx: Pick<ServiceContext, 'db'>, key: string, fallback: T): Promise<T> {
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, key));
  return row ? (row.value as T) : fallback;
}

export async function setSetting(ctx: ServiceContext, key: string, value: unknown, summary?: string): Promise<void> {
  const before = await getSetting<unknown>(ctx, key, null);
  await ctx.db
    .insert(settings)
    .values({ key, value, updatedBy: ctx.actor.userId, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: ctx.actor.userId, updatedAt: ctx.now() } });
  await writeAudit(ctx, {
    action: 'settings.update',
    category: 'data_change',
    entityType: 'setting',
    entityId: key,
    summary: summary ?? `설정 변경: ${key}`,
    before: { value: before as never },
    after: { value: value as never },
    revertible: true,
  });
}

export async function getConfidencePolicy(ctx: Pick<ServiceContext, 'db'>): Promise<ConfidencePolicy> {
  const v = await getSetting<Partial<ConfidencePolicy>>(ctx, SETTING_KEYS.confidencePolicy, {});
  return { ...DEFAULT_CONFIDENCE_POLICY, ...v };
}

/** 업무 기준월 (기본: 전월 — 9월 말에는 9월 자료를 처리) */
export async function getCurrentPeriod(ctx: Pick<ServiceContext, 'db'> & { now: () => Date }): Promise<string> {
  const v = await getSetting<string | null>(ctx, SETTING_KEYS.currentPeriod, null);
  if (v && /^\d{4}-\d{2}$/.test(v)) return v;
  const kst = new Date(ctx.now().getTime() + 9 * 3600 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
}
