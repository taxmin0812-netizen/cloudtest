/**
 * 분류 오케스트레이션 — 순수 도우미 (DB 없음, 단위 테스트 대상).
 */
import type { ClassificationSource, Direction, EvidenceType, ExceptionBucket, TransactionStatus } from '@mintax/core';
import { NotFoundError, ValidationError } from '@mintax/security';

/** classification_results.engine_version */
export const ENGINE_VERSION = 'engine-2026.09';

/** 과거 이력으로 인정하는 확정 상태 (사람 승인 · 자동확정 · 전송 · 대사완료) */
export const FINALIZED_STATUSES = ['approved', 'auto_approved', 'exported', 'reconciled'] as const satisfies readonly TransactionStatus[];

/** 아직 사람이 처리하지 않은 상태 (대기 건수 집계용) */
export const PENDING_STATUSES = ['imported', 'classified', 'needs_review'] as const satisfies readonly TransactionStatus[];

/**
 * 분류 엔진이 다시 판단할 수 있는 상태.
 * approved / exported / reconciled / excluded / duplicate / failed 는 사람 확정 또는 대사 대상이므로 절대 재분류하지 않는다.
 * auto_approved 는 "새 규칙을 기존 자동확정분에도 적용" 처럼 사람이 명시적으로 요청할 때만 허용한다.
 */
export const RECLASSIFIABLE_STATUSES = ['imported', 'classified', 'needs_review', 'auto_approved'] as const satisfies readonly TransactionStatus[];

export const ALL_BUCKETS: readonly ExceptionBucket[] = [
  'low_confidence', 'new_merchant', 'vat_review', 'account_conflict', 'changed_from_history', 'high_amount', 'duplicate',
  'unclassified', 'possible_asset', 'personal_use', 'entertainment', 'vehicle', 'foreign', 'spike', 'export_error',
];

export function emptyBucketCounts(): Record<ExceptionBucket, number> {
  const out = {} as Record<ExceptionBucket, number>;
  for (const b of ALL_BUCKETS) out[b] = 0;
  return out;
}

export const ALL_SOURCES: readonly ClassificationSource[] = [
  'user_rule', 'exact_history', 'name_history', 'correction_memory', 'industry_pattern', 'system_rule', 'ai', 'manual', 'none',
];

export function emptySourceCounts(): Record<ClassificationSource, number> {
  const out = {} as Record<ClassificationSource, number>;
  for (const s of ALL_SOURCES) out[s] = 0;
  return out;
}

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' 검증. 잘못되면 한국어 ValidationError */
export function assertPeriod(period: unknown, field = 'period'): string {
  if (typeof period !== 'string' || !PERIOD_RE.test(period)) {
    throw new ValidationError('처리 기간(월) 형식이 올바르지 않습니다. 예: 2026-09', [
      { field, message: 'YYYY-MM 형식이어야 합니다' },
    ]);
  }
  return period;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 'YYYY-MM' 에 n 개월 더한 'YYYY-MM' (음수 가능) */
export function addMonths(period: string, n: number): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

/** 기간의 첫날·말일 ('YYYY-MM-DD') */
export function periodBounds(period: string): { start: string; end: string } {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${pad2(last)}` };
}

/** 기간 말일 기준 최근 N 개월 창 (말일 포함, 시작일 포함). 예: 2026-09, 24 → 2024-10-01 ~ 2026-09-30 */
export function trailingWindow(period: string, months: number): { from: string; to: string } {
  const startPeriod = addMonths(period, -(Math.max(1, Math.trunc(months)) - 1));
  return { from: `${startPeriod}-01`, to: periodBounds(period).end };
}

/** Date → KST 'YYYY-MM-DD' */
export function kstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 배열을 size 단위로 나눈다 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const EVIDENCE_LABEL: Record<EvidenceType, string> = {
  tax_invoice: '세금계산서',
  invoice_exempt: '계산서',
  card: '카드',
  cash_receipt: '현금영수증',
  bank: '통장',
  other: '기타증빙',
};

/**
 * 배치 구성 라벨: 증빙·방향이 하나로 같으면 "카드매입" / "세금계산서 매출", 섞였으면 "거래".
 */
export function batchLabel(items: Iterable<{ evidenceType: string; direction: Direction | string }>): string {
  let ev: string | null = null;
  let dir: string | null = null;
  let mixed = false;
  let any = false;
  for (const t of items) {
    any = true;
    if (ev === null) {
      ev = t.evidenceType;
      dir = t.direction;
    } else if (ev !== t.evidenceType || dir !== t.direction) {
      mixed = true;
      break;
    }
  }
  if (!any || mixed || ev === null) return '거래';
  const e = EVIDENCE_LABEL[ev as EvidenceType] ?? '거래';
  const d = dir === 'sales' ? '매출' : '매입';
  return ev === 'card' ? `카드${d}` : `${e} ${d}`;
}

/** 'YYYY-MM' → '9월' (연도가 다르면 '2025년 9월') */
export function monthLabel(period: string, currentYear?: number): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  return currentYear !== undefined && currentYear !== y ? `${y}년 ${m}월` : `${m}월`;
}

/** 라벨 여러 개 → 하나 (모두 같으면 그 값, 아니면 '거래') */
export function unifyLabels(labels: readonly string[]): string {
  const set = new Set(labels.filter(Boolean));
  if (set.size === 1) return [...set][0]!;
  return '거래';
}

/** "9월 카드매입 500건 자동분류: 470건 자동확정, 30건 검토필요" */
export function classificationSummaryText(input: {
  period: string;
  label: string;
  total: number;
  autoApproved: number;
  needsReview: number;
  skipped?: number;
  currentYear?: number;
}): string {
  const base = `${monthLabel(input.period, input.currentYear)} ${input.label} ${input.total.toLocaleString('ko-KR')}건 자동분류: ${input.autoApproved.toLocaleString('ko-KR')}건 자동확정, ${input.needsReview.toLocaleString('ko-KR')}건 검토필요`;
  return input.skipped ? `${base} (사람이 먼저 처리한 ${input.skipped.toLocaleString('ko-KR')}건은 건드리지 않음)` : base;
}

/** "9월 카드매입 자동처리 전체 거래처 154곳 → 149곳 자동처리 / 5곳 검토필요" */
export function fanOutSummaryText(input: {
  period: string;
  label: string;
  clients: number;
  autoCompleted: number;
  needsReview: number;
  failed: number;
  currentYear?: number;
}): string {
  const head = `${monthLabel(input.period, input.currentYear)} ${input.label} 자동처리 전체 거래처 ${input.clients}곳 → ${input.autoCompleted}곳 자동처리 / ${input.needsReview}곳 검토필요`;
  return input.failed > 0 ? `${head} / ${input.failed}곳 실패` : head;
}

/**
 * 제한된 동시성으로 비동기 작업 실행 (AI 호출용). 결과 순서는 입력 순서와 같다.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Promise 에 시간 제한 (초과 시 reject) */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 시간 초과 (${ms}ms)`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** 이벤트 루프 양보 (긴 동기 계산 중 진행률·하트비트가 돌 수 있도록) */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** id 형식이 틀리면 DB 오류(500) 대신 NotFoundError(404) — "찾을 수 없습니다" */
export function assertUuid(v: unknown, what: string): string {
  if (!isUuid(v)) throw new NotFoundError(what);
  return v;
}
