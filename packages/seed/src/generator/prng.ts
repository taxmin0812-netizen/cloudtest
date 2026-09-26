/**
 * 결정적 난수 생성기 (mulberry32).
 *
 * - 같은 seed → 같은 수열. 전역 난수·현재 시각은 절대 쓰지 않는다 (index.test.ts 가 소스를 검사).
 * - 스트림 분리: rngFor(seed, 'tx', 'C001', '2026-09') 처럼 라벨로 하위 시드를 만들면
 *   거래처 하나를 추가·수정해도 다른 거래처의 데이터가 바뀌지 않는다.
 */

/** 문자열 → 32bit 해시 (FNV-1a + murmur3 finalizer) */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max] 정수 (양끝 포함) */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: max(${max}) < min(${min})`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: 빈 배열');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** 가중치 선택 (weight ≤ 0 인 항목은 선택되지 않음) */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T {
    let total = 0;
    for (const it of items) total += Math.max(0, weightOf(it));
    if (total <= 0) throw new Error('Rng.weighted: 가중치 합이 0');
    let r = this.next() * total;
    for (const it of items) {
      const w = Math.max(0, weightOf(it));
      if (r < w) return it;
      r -= w;
    }
    return items[items.length - 1]!;
  }

  /** Fisher–Yates (원본 불변) */
  shuffle<T>(items: readonly T[]): T[] {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  /** 중복 없이 n개 (순서는 섞임) */
  sample<T>(items: readonly T[], n: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, Math.min(n, items.length)));
  }

  /** 정규분포 근사 (Box–Muller) */
  normal(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 로그정규 금액 — 중앙값 median, 흩어짐 sigma, [min,max] 로 자르고 unit 단위 반올림 */
  amount(median: number, sigma: number, min: number, max: number, unit = 100): number {
    const raw = Math.exp(Math.log(median) + sigma * this.normal());
    const clamped = Math.min(max, Math.max(min, raw));
    return Math.max(unit, Math.round(clamped / unit) * unit);
  }
}

/** 라벨로 분리된 하위 스트림 */
export function rngFor(seed: number, ...labels: Array<string | number>): Rng {
  return new Rng(hash32(`${seed}|${labels.join('|')}`));
}
