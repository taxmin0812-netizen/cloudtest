import type { Database, DbOrTx } from '@mintax/db';
import type { Permission, Role } from '@mintax/core';

/** 요청 주체. 시스템 작업(worker)은 kind: 'system' */
export interface Actor {
  kind: 'user' | 'system';
  userId: string | null;
  name: string;
  role: Role | 'system';
  permissions: ReadonlySet<Permission>;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
}

export interface ServiceContext {
  db: Database;
  actor: Actor;
  /** 테스트에서 시간 고정용 */
  now: () => Date;
}

export const ALL_PERMISSIONS: Permission[] = [
  'transactions.read', 'transactions.review', 'rules.read', 'rules.write', 'rules.approve', 'export.create', 'export.download',
  'payroll.read', 'payroll.write', 'payroll.sensitive', 'filing.write', 'clients.read', 'clients.write', 'imports.create',
  'audit.read', 'audit.revert', 'settings.write', 'users.manage', 'integrations.developer',
];

export function systemActor(name = 'MIN TAX OPS 시스템'): Actor {
  return { kind: 'system', userId: null, name, role: 'system', permissions: new Set(ALL_PERMISSIONS) };
}

export function createContext(db: Database, actor: Actor, now: () => Date = () => new Date()): ServiceContext {
  return { db, actor, now };
}

/** 트랜잭션 안에서 ctx.db 를 tx 로 바꿔 끼운 컨텍스트 */
export function withTx(ctx: ServiceContext, tx: DbOrTx): ServiceContext {
  return { ...ctx, db: tx as unknown as Database };
}
