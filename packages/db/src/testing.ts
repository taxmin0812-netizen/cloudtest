import { resetDatabase } from './reset';
import { runMigrations } from './migrate';
import { getDb, type Database } from './client';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://mintax:mintax_dev@localhost:5432/mintax_test';

/** 통합 테스트용: 테스트 DB 를 초기화하고 마이그레이션 적용 후 핸들 반환 */
export async function setupTestDatabase(url = TEST_DATABASE_URL): Promise<Database> {
  process.env.DATABASE_URL = url;
  await resetDatabase(url);
  await runMigrations(url);
  return getDb(url);
}
