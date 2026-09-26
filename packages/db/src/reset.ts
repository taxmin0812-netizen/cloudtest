import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from './client';

/** 개발/테스트 DB 초기화. 운영 DB 보호: NODE_ENV=production 이면 거부. */
export async function resetDatabase(url = process.env.DATABASE_URL): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('운영 환경에서는 DB 초기화를 할 수 없습니다.');
  const db = getDb(url);
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  resetDatabase()
    .then(() => console.log('database reset'))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
