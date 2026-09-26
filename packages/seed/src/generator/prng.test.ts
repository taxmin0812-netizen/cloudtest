import { describe, expect, it } from 'vitest';
import { canonicalJson, checksumOf } from './canonical';
import { Rng, hash32, rngFor } from './prng';

describe('prng', () => {
  it('같은 seed → 같은 수열, 다른 seed → 다른 수열', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 20 }, () => a.next());
    const sb = Array.from({ length: 20 }, () => b.next());
    const sc = Array.from({ length: 20 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    for (const v of sa) expect(v >= 0 && v < 1).toBe(true);
  });

  it('mulberry32 첫 값이 고정되어 있다 (구현이 바뀌면 전체 데이터가 바뀜)', () => {
    expect(new Rng(1).next()).toBeCloseTo(0.6270739405881613, 15);
    expect(hash32('20260926|client|C001')).toBe(hash32('20260926|client|C001'));
    expect(hash32('a')).not.toBe(hash32('b'));
  });

  it('rngFor 는 라벨별로 독립 스트림', () => {
    const x = rngFor(1, 'tx', 'C001').next();
    const y = rngFor(1, 'tx', 'C002').next();
    expect(x).not.toBe(y);
    expect(rngFor(1, 'tx', 'C001').next()).toBe(x);
  });

  it('int 는 양끝 포함 범위, 잘못된 범위는 오류', () => {
    const r = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(1, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
    expect(() => r.int(5, 1)).toThrow();
  });

  it('weighted 는 가중치 0 항목을 고르지 않는다', () => {
    const r = new Rng(9);
    for (let i = 0; i < 500; i++) expect(r.weighted(['a', 'b', 'c'], (x) => (x === 'b' ? 0 : 1))).not.toBe('b');
    expect(() => r.weighted(['a'], () => 0)).toThrow();
  });

  it('shuffle 은 순열, sample 은 중복 없음, pick 빈 배열은 오류', () => {
    const r = new Rng(11);
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const sh = r.shuffle(src);
    expect([...sh].sort()).toEqual(src);
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const s = r.sample(src, 5);
    expect(new Set(s).size).toBe(5);
    expect(r.sample(src, 99)).toHaveLength(8);
    expect(() => r.pick([])).toThrow();
  });

  it('amount 는 [min,max] 안의 unit 배수 정수', () => {
    const r = new Rng(13);
    for (let i = 0; i < 1000; i++) {
      const v = r.amount(30_000, 0.8, 5_000, 200_000, 100);
      expect(Number.isSafeInteger(v)).toBe(true);
      expect(v % 100).toBe(0);
      expect(v).toBeGreaterThanOrEqual(5_000);
      expect(v).toBeLessThanOrEqual(200_000);
    }
  });
});

describe('canonical JSON / checksum', () => {
  it('키 순서와 무관, undefined 는 제외', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined, 2], c: 'x' }, z: undefined })).toBe('{"a":{"c":"x","d":[1,null,2]},"b":1}');
    expect(checksumOf({ a: 1, b: 2 })).toBe(checksumOf({ b: 2, a: 1 }));
  });

  it('빈 객체의 sha256 은 표준값', () => {
    expect(checksumOf({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('유한하지 않은 숫자는 거부', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
});
