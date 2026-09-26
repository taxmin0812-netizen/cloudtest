import 'server-only';
import { getDb, type Database } from '@mintax/db';
import { assertSecurityConfig, createLogger } from '@mintax/security';

const log = createLogger('web');
let checked = false;

/** 웹 프로세스 공용 DB 핸들 + 최초 1회 보안 설정 점검 (운영에서 키 누락 시 즉시 실패) */
export function db(): Database {
  if (!checked) {
    checked = true;
    const { warnings } = assertSecurityConfig();
    for (const w of warnings) log.warn('security config', { warning: w });
  }
  return getDb();
}

export { log };
