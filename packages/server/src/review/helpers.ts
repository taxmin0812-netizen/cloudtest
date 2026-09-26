/**
 * 예외 검토 (review area) — 순수 도우미. DB 없음, 단위 테스트 대상.
 */
import {
  formatWon,
  maskCardNumber,
  scrubSensitive,
  type ClassificationSource,
  type Direction,
  type ExceptionBucket,
  type ReviewLevel,
  type RiskFlag,
  type RiskSeverity,
  type TransactionStatus,
  type VatType,
} from '@mintax/core';
import { ValidationError } from '@mintax/security';
import type { RiskFlagShort, TxState } from './types';

// ────────────────────────────── 상수 ──────────────────────────────

export const ALL_BUCKETS: readonly ExceptionBucket[] = [
  'low_confidence', 'new_merchant', 'vat_review', 'account_conflict', 'changed_from_history', 'high_amount', 'duplicate',
  'unclassified', 'possible_asset', 'personal_use', 'entertainment', 'vehicle', 'foreign', 'spike', 'export_error',
];

export const BUCKET_LABELS: Readonly<Record<ExceptionBucket, string>> = Object.freeze({
  low_confidence: '저신뢰도',
  new_merchant: '신규 거래처',
  vat_review: '공제/불공제 검토',
  account_conflict: '계정 충돌',
  changed_from_history: '전월과 다른 분개',
  high_amount: '고액',
  duplicate: '중복 의심',
  unclassified: '미분류',
  possible_asset: '자산 가능성',
  personal_use: '개인사용 가능성',
  entertainment: '접대 관련',
  vehicle: '업무용승용차',
  foreign: '해외결제',
  spike: '전월 대비 급증',
  export_error: 'WEHAGO 전송오류',
});

export const REVIEW_LEVELS: readonly ReviewLevel[] = ['auto', 'quick_review', 'must_review'];

export const SOURCE_LABELS: Readonly<Record<ClassificationSource, string>> = Object.freeze({
  user_rule: '승인된 사용자 규칙',
  exact_history: '동일 사업자번호 과거 처리',
  name_history: '동일 상호 과거 처리',
  correction_memory: '최근 직원 수정 이력',
  industry_pattern: '동일 업종 반복 패턴',
  system_rule: '시스템 기본 사전',
  ai: 'AI 추천',
  manual: '담당자 직접 지정',
  none: '미분류',
});

export const VAT_TYPE_LABELS: Readonly<Record<VatType, string>> = Object.freeze({
  purchase_taxable: '과세매입',
  purchase_exempt: '면세매입',
  purchase_card: '카드과세매입',
  purchase_card_exempt: '카드면세매입',
  purchase_cash_receipt: '현금영수증매입',
  purchase_cash_receipt_exempt: '현금영수증면세매입',
  purchase_non_deductible: '불공제매입',
  purchase_no_evidence: '일반전표(부가세 무관)',
  sales_taxable: '과세매출',
  sales_exempt: '면세매출',
  sales_card: '카드매출',
  sales_cash_receipt: '현금영수증매출',
  sales_other: '기타매출',
});

export const ALL_VAT_TYPES = Object.keys(VAT_TYPE_LABELS) as VatType[];

export const STATUS_LABELS: Readonly<Record<TransactionStatus, string>> = Object.freeze({
  imported: '수집됨',
  classified: '분류됨',
  auto_approved: '자동확정',
  needs_review: '검토 필요',
  approved: '승인',
  excluded: '제외',
  duplicate: '중복',
  failed: '실패',
  exported: '전송됨',
  reconciled: '대사완료',
});

/** 예외함에 올라오는 export_error 행의 상태 (제외·중복·실패·대사완료는 제외) */
export const EXPORT_ERROR_STATUSES = ['approved', 'auto_approved', 'exported'] as const;

/** 사람이 계정을 고치면 해소되는 버킷 — 나머지 차단 위험(고액·자산 등)은 건별 확인이 필요하다 */
export const ACCOUNT_RESOLVABLE_BUCKETS: ReadonlySet<ExceptionBucket> = new Set<ExceptionBucket>([
  'low_confidence', 'new_merchant', 'account_conflict', 'changed_from_history', 'unclassified',
]);

/** 이미 WEHAGO 로 넘어간(사람이 파일을 받은) 전송파일 상태 */
export const TAKEN_EXPORT_STATUSES: ReadonlySet<string> = new Set(['downloaded', 'uploaded_confirmed']);

/** 수정·제외·되돌리기를 허용하되 파일을 차단해야 하는 전송파일 상태 (validating 은 작업 중인 파일 — 최선의 차단) */
export const BLOCKABLE_EXPORT_STATUSES: ReadonlySet<string> = new Set(['ready', 'validating']);

/**
 * 전송파일에 연결돼 있지만 아직 아무도 받지 않은 거래인가 (ready·validating·blocked·failed).
 * 이런 거래는 내용이 바뀌면 파일에서 풀고(export_job_id = null) ready/validating 파일은 차단한다.
 */
export function exportReleasable(exportJobId: string | null, exportStatus: string | null): boolean {
  return !!exportJobId && !!exportStatus && !TAKEN_EXPORT_STATUSES.has(exportStatus);
}

export const EXPORT_BLOCK_REASON = '포함 거래가 변경되었습니다. 파일을 다시 만드세요';

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;
export const MAX_BULK_IDS = 10_000;

/** 묶음(bulk) 수정 표식 — classification_corrections.reason 앞머리. 학습 임계치에는 묶음 1회로 센다 (docs/05 §5.3) */
export const BULK_REASON_PREFIX = 'bulk:';
const BULK_REASON_RE = /^bulk:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// ────────────────────────────── 입력 검증 ──────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function assertUuid(v: unknown, field: string, label = '거래'): string {
  if (!isUuid(v)) {
    throw new ValidationError(`${label} ID 형식이 올바르지 않습니다. 목록을 새로고침한 뒤 다시 시도하세요.`, [
      { field, message: 'UUID 형식이어야 합니다' },
    ]);
  }
  return v.toLowerCase();
}

export function assertPeriod(v: unknown, field = 'period'): string {
  if (typeof v !== 'string' || !PERIOD_RE.test(v)) {
    throw new ValidationError('처리 기간(월) 형식이 올바르지 않습니다. 예: 2026-09', [{ field, message: 'YYYY-MM 형식이어야 합니다' }]);
  }
  return v;
}

/** 거래 ID 목록: 형식 검증 + 중복 제거 (입력 순서 유지) */
export function normalizeIds(ids: unknown, field = 'ids', max = MAX_BULK_IDS): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('처리할 거래를 1건 이상 선택하세요.', [{ field, message: '비어 있습니다' }]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  ids.forEach((raw, i) => {
    const id = assertUuid(raw, `${field}.${i}`);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  });
  if (out.length > max) {
    throw new ValidationError(`한 번에 ${max.toLocaleString('ko-KR')}건까지 처리할 수 있습니다. 나눠서 처리하세요.`, [
      { field, message: `최대 ${max}건` },
    ]);
  }
  return out;
}

export function assertLimit(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_LIST_LIMIT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) {
    throw new ValidationError(`한 번에 1~${MAX_LIST_LIMIT}건까지 조회할 수 있습니다.`, [{ field: 'limit', message: `1~${MAX_LIST_LIMIT}` }]);
  }
  return n;
}

export function assertBuckets(v: unknown): ExceptionBucket[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new ValidationError('버킷 필터 형식이 올바르지 않습니다.', [{ field: 'buckets', message: '배열이어야 합니다' }]);
  const out: ExceptionBucket[] = [];
  for (const b of v) {
    if (!(ALL_BUCKETS as readonly unknown[]).includes(b)) {
      throw new ValidationError(`알 수 없는 버킷입니다: ${String(b).slice(0, 40)}`, [{ field: 'buckets', message: '알 수 없는 값' }]);
    }
    if (!out.includes(b as ExceptionBucket)) out.push(b as ExceptionBucket);
  }
  return out.length > 0 ? out : null;
}

export function assertReviewLevels(v: unknown): ReviewLevel[] | null {
  if (v === undefined || v === null) return null;
  const arr = Array.isArray(v) ? v : [v];
  const out: ReviewLevel[] = [];
  for (const l of arr) {
    if (!(REVIEW_LEVELS as readonly unknown[]).includes(l)) {
      throw new ValidationError('검토 수준 필터 값이 올바르지 않습니다. (auto / quick_review / must_review)', [{ field: 'reviewLevel', message: '알 수 없는 값' }]);
    }
    if (!out.includes(l as ReviewLevel)) out.push(l as ReviewLevel);
  }
  return out.length > 0 ? out : null;
}

/** 자유 텍스트 (사유·메모) — 앞뒤 공백 제거, 길이 제한, 민감정보 스크럽 */
export function cleanText(v: unknown, field: string, label: string, opts: { max?: number; required?: boolean } = {}): string | null {
  const max = opts.max ?? 500;
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (opts.required) throw new ValidationError(`${label}을(를) 입력하세요.`, [{ field, message: '필수 항목입니다' }]);
    return null;
  }
  if (typeof v !== 'string') throw new ValidationError(`${label} 형식이 올바르지 않습니다.`, [{ field, message: '문자열이어야 합니다' }]);
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`${label}은(는) ${max}자 이내로 입력하세요.`, [{ field, message: `최대 ${max}자` }]);
  return scrubSensitive(s);
}

// ────────────────────────────── 검색어 ──────────────────────────────

export interface ParsedSearch {
  /** ILIKE 패턴 (이스케이프 완료, 앞뒤 %) */
  like: string;
  /** 금액으로 해석 가능하면 원 단위 정수 */
  amount: number | null;
  /** 사업자번호 일부(숫자 3자리 이상) */
  digits: string | null;
}

export function parseSearch(v: unknown): ParsedSearch | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ValidationError('검색어 형식이 올바르지 않습니다.', [{ field: 'search', message: '문자열' }]);
  const s = v.trim().slice(0, 100);
  if (s === '') return null;
  const escaped = s.replace(/[\\%_]/g, (m) => `\\${m}`);
  const compact = s.replace(/[,\s원-]/g, '');
  const amount = /^\d{1,15}$/.test(compact) ? Number(compact) : null;
  const digits = /^\d{3,10}$/.test(s.replace(/-/g, '')) ? s.replace(/-/g, '') : null;
  return { like: `%${escaped}%`, amount: amount !== null && Number.isSafeInteger(amount) ? amount : null, digits };
}

// ────────────────────────────── 커서 (keyset) ──────────────────────────────

export type ExceptionSort = 'risk' | 'date' | 'amount' | 'confidence' | 'client';
export const EXCEPTION_SORTS: readonly ExceptionSort[] = ['risk', 'date', 'amount', 'confidence', 'client'];

export type CursorValue = string | number;

export interface CursorPayload {
  s: ExceptionSort;
  k: CursorValue[];
}

export function assertSort(v: unknown): ExceptionSort {
  if (v === undefined || v === null) return 'risk';
  if (!(EXCEPTION_SORTS as readonly unknown[]).includes(v)) {
    throw new ValidationError('정렬 기준이 올바르지 않습니다. (risk / date / amount / confidence / client)', [{ field: 'sort', message: '알 수 없는 값' }]);
  }
  return v as ExceptionSort;
}

export function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

/** 커서 해독 — 다른 정렬의 커서나 손상된 값은 ValidationError (첫 페이지부터 다시) */
export function decodeCursor(cursor: unknown, sort: ExceptionSort, keyCount: number): CursorValue[] | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  const fail = () =>
    new ValidationError('목록 위치 정보가 올바르지 않습니다. 필터나 정렬이 바뀌었을 수 있으니 목록을 처음부터 다시 불러오세요.', [
      { field: 'cursor', message: '잘못된 커서' },
    ]);
  if (typeof cursor !== 'string' || cursor.length > 2000) throw fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw fail();
  }
  const p = parsed as Partial<CursorPayload> | null;
  if (!p || p.s !== sort || !Array.isArray(p.k) || p.k.length !== keyCount) throw fail();
  for (const v of p.k) if (typeof v !== 'string' && typeof v !== 'number') throw fail();
  if (!isUuid(p.k[p.k.length - 1])) throw fail();
  return p.k as CursorValue[];
}

// ────────────────────────────── 위험 / 요약 ──────────────────────────────

const SEVERITY_RANK: Record<RiskSeverity, number> = { high: 2, warning: 1, info: 0 };

/** 심각도 높은 순 · 자동확정 차단 우선 */
export function shortRiskFlags(flags: readonly RiskFlag[] | null | undefined): RiskFlagShort[] {
  if (!Array.isArray(flags)) return [];
  return flags
    .filter((f): f is RiskFlag => !!f && typeof f === 'object')
    .map((f) => ({
      code: String(f.ruleCode ?? ''),
      label: String(f.ruleName ?? f.ruleCode ?? ''),
      bucket: f.bucket,
      severity: (f.severity in SEVERITY_RANK ? f.severity : 'info') as RiskSeverity,
      blocksAutoApproval: f.blocksAutoApproval === true,
      message: String(f.message ?? ''),
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        Number(b.blocksAutoApproval) - Number(a.blocksAutoApproval) ||
        a.code.localeCompare(b.code),
    );
}

export function accountLabel(code: string | null | undefined, name: string | null | undefined): string {
  if (!code) return '미분류';
  return name && name.trim() !== '' ? name : code;
}

export function deductibleLabel(d: boolean | null | undefined): string {
  return d === true ? '공제' : d === false ? '불공제' : '검토';
}

export function vatLabel(vatType: string | null | undefined, deductible: boolean | null | undefined): string {
  const t = vatType ? (VAT_TYPE_LABELS[vatType as VatType] ?? vatType) : '유형 미정';
  return `${t} · ${deductibleLabel(deductible)}`;
}

/** 감사로그·토스트 공용 거래 표시: "쿠팡 72,300원" */
export function txLabel(tx: { merchantName: string; totalAmount: number }): string {
  const name = tx.merchantName.trim() === '' ? '(상호 없음)' : tx.merchantName.trim();
  return `${name} ${formatWon(tx.totalAmount)}`;
}

export function clientScopeLabel(clientNames: readonly string[]): string {
  const uniq = [...new Set(clientNames)];
  if (uniq.length === 0) return '';
  return uniq.length === 1 ? ` (${uniq[0]})` : ` (${uniq.length}개 수임처)`;
}

/** 수정 요약: "쿠팡 72,300원 소모품비 → 상품 · 부가세 공제 → 불공제" */
export function correctionSummary(
  tx: { merchantName: string; totalAmount: number },
  before: Pick<TxState, 'accountCode' | 'accountName' | 'vatType' | 'deductible'>,
  after: Pick<TxState, 'accountCode' | 'accountName' | 'vatType' | 'deductible'>,
): string {
  const parts: string[] = [];
  if (before.accountCode !== after.accountCode) {
    parts.push(`${accountLabel(before.accountCode, before.accountName)} → ${accountLabel(after.accountCode, after.accountName)}`);
  }
  if (before.deductible !== after.deductible) {
    parts.push(`부가세 ${deductibleLabel(before.deductible)} → ${deductibleLabel(after.deductible)}`);
  } else if (before.vatType !== after.vatType) {
    const bt = before.vatType ? (VAT_TYPE_LABELS[before.vatType as VatType] ?? before.vatType) : '유형 미정';
    const at = after.vatType ? (VAT_TYPE_LABELS[after.vatType as VatType] ?? after.vatType) : '유형 미정';
    parts.push(`부가세 ${bt} → ${at}`);
  }
  if (parts.length === 0) parts.push(`${accountLabel(after.accountCode, after.accountName)} 확인`);
  return `${txLabel(tx)} ${parts.join(' · ')}`;
}

/** 그리드 한 줄 근거: 엔진 요약, 없으면 상태에 맞는 대체 문구 */
export function rowSummary(r: { classificationSummary: string | null; accountCode: string | null; status: string; buckets: readonly string[] }): string {
  const s = r.classificationSummary?.trim();
  if (s) return s;
  if (r.buckets.includes('export_error')) return 'WEHAGO 전송 검증에서 오류가 난 거래입니다';
  if (!r.accountCode) return '미분류: 계정을 지정해야 합니다';
  return '분류 근거 없음';
}

// ────────────────────────────── 상태 판단 ──────────────────────────────

export interface EligibilityRow {
  status: string;
  direction: Direction;
  accountCode: string | null;
  deductible: boolean | null;
  buckets: readonly string[];
  riskFlags: readonly RiskFlag[];
  exportStatus: string | null;
}

/** 이 행 상태로는 처리할 수 없을 때의 사유 (공통) */
export function blockedStatusReason(status: string): string | null {
  switch (status) {
    case 'excluded':
      return '제외된 거래입니다. 제외를 되돌린 뒤 처리하세요.';
    case 'duplicate':
      return '중복으로 판정된 거래입니다. 중복 해제 후 처리하세요.';
    case 'failed':
      return '정규화에 실패한 거래입니다. 원본을 고쳐 다시 올리세요.';
    case 'reconciled':
      return '이미 WEHAGO 대사까지 끝난 거래입니다. 정정 전송으로만 고칠 수 있습니다.';
    default:
      return null;
  }
}

export const TAKEN_EXPORT_MESSAGE =
  '이미 WEHAGO용 파일로 받은 거래입니다. WEHAGO에 전표가 있을 수 있어 MIN TAX OPS만 바꾸면 두 장부가 어긋납니다. 정정 전송으로 처리하세요.';

/** 차단 위험 중 계정 수정만으로 해소되지 않는 것 */
export function blockingRiskFlags(flags: readonly RiskFlag[]): RiskFlag[] {
  return (flags ?? []).filter((f) => f && f.blocksAutoApproval === true);
}

export function needsIndividualReview(flags: readonly RiskFlag[]): RiskFlag[] {
  return blockingRiskFlags(flags).filter((f) => !ACCOUNT_RESOLVABLE_BUCKETS.has(f.bucket));
}

/**
 * 승인 가능 여부. null = 승인 가능, 문자열 = 건너뛴 사유.
 * - needs_review / auto_approved 만 (approved + export_error 는 재확인으로 오류 해소 가능)
 * - 계정이 없거나, 매입인데 공제 여부가 비어 있으면 승인하지 않는다 (WEHAGO 파일에 넣을 수 없음)
 */
export function approvalBlockReason(r: EligibilityRow, opts: { excludeBlockingRisks?: boolean } = {}): string | null {
  const s = blockedStatusReason(r.status);
  if (s) return s;
  if (r.exportStatus && TAKEN_EXPORT_STATUSES.has(r.exportStatus)) return TAKEN_EXPORT_MESSAGE;
  const exportError = r.buckets.includes('export_error');
  if (r.status === 'approved' && !exportError) return '이미 승인된 거래입니다.';
  if (r.status === 'exported') return '이미 WEHAGO 전송파일에 포함된 거래입니다. 전송센터에서 처리하세요.';
  if (r.status === 'imported' || r.status === 'classified') return '아직 자동분류가 끝나지 않았습니다. 분류가 끝난 뒤 승인하세요.';
  if (!['needs_review', 'auto_approved', 'approved'].includes(r.status)) return `처리할 수 없는 상태입니다 (${r.status}).`;
  if (!r.accountCode) return '계정과목이 정해지지 않았습니다. 수정(M)으로 계정을 지정하세요.';
  if (r.direction === 'purchase' && r.deductible === null) return '부가세 공제/불공제가 정해지지 않았습니다. 부가세 칸에서 공제 또는 불공제를 선택하세요.';
  if (opts.excludeBlockingRisks) {
    const b = blockingRiskFlags(r.riskFlags);
    if (b.length > 0) return `자동확정 차단 위험(${[...new Set(b.map((f) => BUCKET_LABELS[f.bucket] ?? f.bucket))].join(', ')})이 있어 제외했습니다. 개별 검토하세요.`;
  }
  return null;
}

/** 수정 가능 여부 (승인 후 재수정 허용). null = 가능 */
export function correctionBlockReason(r: Pick<EligibilityRow, 'status' | 'exportStatus'>): string | null {
  const s = blockedStatusReason(r.status);
  if (s) return s;
  if (r.exportStatus && TAKEN_EXPORT_STATUSES.has(r.exportStatus)) return TAKEN_EXPORT_MESSAGE;
  if (r.status === 'exported' && !(r.exportStatus && !TAKEN_EXPORT_STATUSES.has(r.exportStatus))) {
    return '이미 WEHAGO 전송파일에 포함된 거래입니다. 정정 전송으로 처리하세요.';
  }
  return null;
}

/** 제외 가능 여부. null = 가능 */
export function exclusionBlockReason(r: Pick<EligibilityRow, 'status' | 'exportStatus'>): string | null {
  if (r.status === 'excluded') return '이미 제외된 거래입니다.';
  return correctionBlockReason(r);
}

// ────────────────────────────── 상태 스냅샷 ──────────────────────────────

/** 감사로그 before/after 비교용 핵심 필드가 같은가 (되돌리기 전 "그 뒤에 바뀌었는가" 검사) */
export function sameCoreState(a: Partial<TxState>, b: Partial<TxState>): boolean {
  return (
    (a.status ?? null) === (b.status ?? null) &&
    (a.accountCode ?? null) === (b.accountCode ?? null) &&
    (a.vatType ?? null) === (b.vatType ?? null) &&
    (a.deductible ?? null) === (b.deductible ?? null) &&
    (a.excludedReason ?? null) === (b.excludedReason ?? null)
  );
}

export function withoutBucket(buckets: readonly string[], bucket: string): ExceptionBucket[] {
  return buckets.filter((b) => b !== bucket) as ExceptionBucket[];
}

// ────────────────────────────── 학습: 묶음 수정 접기 ──────────────────────────────

export function bulkIdOf(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const m = BULK_REASON_RE.exec(reason);
  return m ? m[1]!.toLowerCase() : null;
}

export function bulkReason(batchId: string, userReason: string | null): string {
  return userReason ? `${BULK_REASON_PREFIX}${batchId} ${userReason}` : `${BULK_REASON_PREFIX}${batchId}`;
}

/** 사용자에게 보여줄 사유 (bulk 표식 제거) */
export function displayReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const r = reason.replace(BULK_REASON_RE, '').trim();
  return r === '' ? null : r;
}

/**
 * 같은 묶음(bulk)의 수정은 1건으로 접는다 — 한 번의 판단이 여러 번으로 계산돼 규칙이 성급하게 제안되지 않게.
 * 묶음마다 가장 이른 기록(시각 → 거래ID) 1건만 남긴다. 입력 순서는 유지.
 */
export function foldBulkCorrections<T extends { reason?: string | null; createdAt: string; transactionId: string }>(records: readonly T[]): T[] {
  const rep = new Map<string, T>();
  for (const r of records) {
    const b = bulkIdOf(r.reason);
    if (!b) continue;
    const cur = rep.get(b);
    if (!cur || r.createdAt < cur.createdAt || (r.createdAt === cur.createdAt && r.transactionId < cur.transactionId)) rep.set(b, r);
  }
  return records.filter((r) => {
    const b = bulkIdOf(r.reason);
    return !b || rep.get(b) === r;
  });
}

// ────────────────────────────── 원본 행 스크럽 ──────────────────────────────

const CARD_KEY_RE = /(카드\s*번호|card.?(no|num|number)|카드no)/i;
const SECRET_KEY_RE = /(주민|resident|rrn|jumin|계좌|account.?(no|num|number)|bank.?account|password|passwd|비밀번호|token|secret)/i;

/** 원본 행을 화면용으로 스크럽: 카드번호 마스킹, 주민번호·계좌·비밀값 가림, 긴 값 자르기 */
export function scrubRawData(raw: unknown, depth = 0): unknown {
  if (raw === null || raw === undefined) return raw ?? null;
  if (depth > 4) return '[생략]';
  if (typeof raw === 'string') return scrubSensitive(raw).slice(0, 500);
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) return raw.slice(0, 50).map((v) => scrubRawData(v, depth + 1));
  if (typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
      if (SECRET_KEY_RE.test(k)) out[k] = v === null || v === '' ? v : '***';
      else if (CARD_KEY_RE.test(k)) out[k] = v === null || v === '' ? v : maskCardNumber(v);
      else out[k] = scrubRawData(v, depth + 1);
    }
    return out;
  }
  return String(raw).slice(0, 200);
}

/** 카드 끝 4자리 ("1234-****-****-5678" → "5678") */
export function cardLast4(masked: string | null | undefined): string | null {
  if (!masked) return null;
  const d = masked.replace(/[^0-9]/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

/** KST 기준 오늘 00:00 의 UTC 시각 */
export function kstStartOfDay(now: Date): Date {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000);
}

export function toIso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
