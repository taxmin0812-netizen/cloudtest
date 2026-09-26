/** payroll 모듈 내부 헬퍼 (index.ts 에서 re-export 하지 않음) */

/** 중첩 객체까지 동결 — 세율·기준금액·공휴일·제출주기 데이터가 프로세스 안에서 몰래 바뀌지 않도록 (변경은 옵션 override 로만) */
export function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
  }
  return obj;
}
