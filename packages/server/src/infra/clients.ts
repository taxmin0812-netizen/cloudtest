import { eq } from 'drizzle-orm';
import { clientBusinessProfiles, clients } from '@mintax/db';
import type { ClientProfile, IndustryKey } from '@mintax/core';
import { NotFoundError } from '@mintax/security';
import type { ServiceContext } from '../context';

export async function loadClientProfile(ctx: Pick<ServiceContext, 'db'>, clientId: string): Promise<ClientProfile & { code: string; ruleParams: Record<string, number | string | boolean> }> {
  const [row] = await ctx.db
    .select()
    .from(clients)
    .leftJoin(clientBusinessProfiles, eq(clientBusinessProfiles.clientId, clients.id))
    .where(eq(clients.id, clientId));
  if (!row) throw new NotFoundError('거래처');
  const c = row.clients;
  const p = row.client_business_profiles;
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    businessNumber: c.businessNumber,
    businessType: c.businessType,
    vatType: p?.vatType ?? 'general',
    industry: (p?.industry ?? 'other') as IndustryKey,
    industryCode: p?.industryCode ?? null,
    deemedInputTaxEligible: p?.deemedInputTaxEligible ?? false,
    nonDeductibleVehicles: p?.nonDeductibleVehicles ?? [],
    ruleParams: p?.ruleParams ?? {},
  };
}
