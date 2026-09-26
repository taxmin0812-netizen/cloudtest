/**
 * 시스템 기본 사전(SYSTEM_DICTIONARY) ↔ mapping_rules 행 연결.
 *
 * mapping_rules.id 는 uuid 인데 사전 항목 id 는 'SYS-TEL-01' 같은 안정 문자열이다.
 * 사전 항목을 DB 에 넣을 때 사전 id 로부터 결정적 UUID(v5)를 만들어 쓰면,
 * - ensureDefaultRules 는 몇 번 실행해도 같은 행을 만든다 (멱등)
 * - 분류 엔진에는 사전 id 로 넘겨서 "DB system_default 가 같은 id 의 내장 사전을 덮어쓴다" 는 엔진 계약을 지킨다
 *   (사무소가 DB 에서 끈 사전 규칙은 내장 사전으로 되살아나지 않는다)
 */
import { createHash } from 'node:crypto';
import { SYSTEM_DICTIONARY } from '@mintax/core/engine/classify-index';

/** MIN TAX OPS 시스템 사전 네임스페이스 (임의 고정값) */
const NAMESPACE = '6f1c2a4e-9b7d-5c3e-8a21-4d0b7e9f3c55';

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** RFC 4122 UUID v5 (SHA-1, 네임스페이스 + 이름) */
export function uuidV5(name: string, namespace = NAMESPACE): string {
  const hash = createHash('sha1').update(uuidToBytes(namespace)).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 사전 항목 id → mapping_rules.id */
export function systemRuleUuid(dictionaryId: string): string {
  return uuidV5(`system-dictionary:${dictionaryId}`);
}

let uuidToDict: Map<string, string> | null = null;
let nameToDict: Map<string, string> | null = null;

function ensureMaps(): void {
  if (uuidToDict && nameToDict) return;
  uuidToDict = new Map();
  nameToDict = new Map();
  for (const e of SYSTEM_DICTIONARY) {
    uuidToDict.set(systemRuleUuid(e.id), e.id);
    nameToDict.set(`${e.name}|${e.accountCode}`, e.id);
  }
}

/**
 * system_default 행 → 대응하는 사전 id (없으면 null).
 * 1순위: 결정적 UUID 일치 (ensureDefaultRules 로 넣은 행)
 * 2순위: 이름 + 계정코드 일치 (다른 경로로 임의 UUID 로 넣은 사전 행 — 내장 사전과 이중 적용 방지)
 */
export function dictionaryIdForRow(row: { id: string; name: string; accountCode: string; origin: string; clientId: string | null }): string | null {
  if (row.origin !== 'system_default' || row.clientId !== null) return null;
  ensureMaps();
  return uuidToDict!.get(row.id) ?? nameToDict!.get(`${row.name}|${row.accountCode}`) ?? null;
}
