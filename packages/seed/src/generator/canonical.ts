import { sha256Hex } from '@mintax/core';

/**
 * 정규(canonical) JSON — 객체 키를 사전순으로 정렬하고 undefined 는 뺀다.
 * 같은 데이터면 생성 순서와 무관하게 같은 문자열 → 같은 체크섬.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

function normalizeForJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: 유한하지 않은 숫자 ${value}`);
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalizeForJson(v)));
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const v = src[k];
      if (v === undefined) continue;
      out[k] = normalizeForJson(v);
    }
    return out;
  }
  throw new Error(`canonicalJson: 지원하지 않는 값 형식 ${typeof value}`);
}

/** sha256Hex(canonicalJson(value)) */
export function checksumOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
