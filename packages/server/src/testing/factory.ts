import { randomUUID } from 'node:crypto';
import { clientBusinessProfiles, clients, users, type Database } from '@mintax/db';
import type { IndustryKey, Permission, Role } from '@mintax/core';
import { permissionsOf } from '@mintax/security';
import { createContext, type Actor, type ServiceContext } from '../context';

/** 통합 테스트용 팩토리 — 실제 DB 에 최소 레코드를 만든다 */
let seq = 0;

export async function createTestUser(db: Database, role: Role = 'staff', name = '테스트담당자'): Promise<{ id: string; actor: Actor }> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({ email: `user${seq}-${randomUUID().slice(0, 6)}@test.local`, name, passwordHash: 'scrypt$test$invalid', role })
    .returning({ id: users.id });
  const actor: Actor = { kind: 'user', userId: u!.id, name, role, permissions: new Set(permissionsOf(role) as Permission[]) };
  return { id: u!.id, actor };
}

/** 체크섬이 유효한 가짜 사업자번호 생성 */
export function fakeBusinessNumber(n: number): string {
  const base = String(100000000 + ((n * 7919) % 899999999)).slice(0, 9);
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(base[i]) * w[i]!;
  sum += Math.floor((Number(base[8]) * 5) / 10);
  return base + String((10 - (sum % 10)) % 10);
}

export async function createTestClient(
  db: Database,
  opts: { name?: string; industry?: IndustryKey; vatType?: 'general' | 'simplified' | 'exempt' | 'mixed'; businessType?: 'corporation' | 'individual' } = {},
): Promise<{ id: string; businessNumber: string; code: string; name: string }> {
  seq += 1;
  const businessNumber = fakeBusinessNumber(seq + Math.floor(Math.random() * 100000));
  const code = `T${String(seq).padStart(3, '0')}${randomUUID().slice(0, 4)}`;
  const name = opts.name ?? `테스트거래처${seq}`;
  const [c] = await db
    .insert(clients)
    .values({ code, name, businessNumber, businessType: opts.businessType ?? 'corporation' })
    .returning({ id: clients.id });
  await db.insert(clientBusinessProfiles).values({ clientId: c!.id, industry: opts.industry ?? 'service', vatType: opts.vatType ?? 'general' });
  return { id: c!.id, businessNumber, code, name };
}

export function testContext(db: Database, actor: Actor, now = new Date('2026-09-26T09:00:00+09:00')): ServiceContext {
  return createContext(db, actor, () => now);
}
