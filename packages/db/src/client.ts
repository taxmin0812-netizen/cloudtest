import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** 트랜잭션 내부 핸들도 동일 API 사용 */
export type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

// bigint(int8) → number (원 단위 금액은 Number.MAX_SAFE_INTEGER 이내)
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint overflow: ${v}`);
  return n;
});
// date → 'YYYY-MM-DD' 문자열 그대로
pg.types.setTypeParser(1082, (v) => v);

const pools = new Map<string, pg.Pool>();

export function getPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error('DATABASE_URL 환경변수가 설정되지 않았습니다. .env.example 을 참고하세요.');
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : undefined,
    });
    pools.set(url, pool);
  }
  return pool;
}

const dbs = new Map<string, Database>();

export function getDb(url = process.env.DATABASE_URL): Database {
  const key = url ?? '';
  let db = dbs.get(key);
  if (!db) {
    db = drizzle(getPool(url), { schema });
    dbs.set(key, db);
  }
  return db;
}

export async function closeDb(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
  dbs.clear();
}
