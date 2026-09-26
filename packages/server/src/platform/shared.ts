/**
 * 플랫폼 영역 — 순수 도우미 (DB 없음, 단위 테스트 대상): 입력 검증, 기간 계산, 커서, 비율, 링크, 라벨, CSV, 검색어 해석.
 */
import { sql, type SQL } from 'drizzle-orm';
import { normalizeBusinessNumber, normalizeMerchantName, parseWon, previousYearMonth, type ExceptionBucket, type JobType } from '@mintax/core';
import { ValidationError } from '@mintax/security';

// ────────────────────────────── 입력 검증 ──────────────────────────────

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPeriod(v: unknown): v is string {
  return typeof v === 'string' && PERIOD_RE.test(v);
}

export function assertPeriod(v: unknown, field = 'period'): string {
  if (!isPeriod(v)) throw new ValidationError('기간은 YYYY-MM 형식으로 입력해 주세요. 예: 2026-09', [{ field, message: 'YYYY-MM' }]);
  return v;
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function assertUuid(v: unknown, field: string, label: string): string {
  if (!isUuid(v)) throw new ValidationError(`${label} 식별자가 올바르지 않습니다. 목록에서 다시 선택해 주세요.`, [{ field, message: 'uuid' }]);
  return v;
}

export function optionalUuid(v: unknown, field: string, label: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  return assertUuid(v, field, label);
}

export function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return s === '' ? null : s.slice(0, max);
}

// ────────────────────────────── 기간 (KST) ──────────────────────────────

const KST_MS = 9 * 3600_000;

/** 'YYYY-MM' 의 KST 1일 0시 (UTC Date) */
export function kstMonthStart(period: string): Date {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1) - KST_MS);
}

/** 시각 → KST 연월 */
export function kstPeriodOf(d: Date): string {
  const k = new Date(d.getTime() + KST_MS);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** KST 기준 날짜 'YYYY-MM-DD' */
export function kstDateOf(d: Date): string {
  const k = new Date(d.getTime() + KST_MS);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' + n일 */
export function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** 두 날짜 차이 (b - a, 일) */
export function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number) as [number, number, number];
  const pb = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86_400_000);
}

/** period 를 끝으로 하는 n개월 (오래된 달 → 최근 달) */
export function monthsEndingAt(period: string, n: number): string[] {
  const out = [period];
  let p = period;
  for (let i = 1; i < n; i++) {
    p = previousYearMonth(p);
    out.unshift(p);
  }
  return out;
}

// ────────────────────────────── 비율 ──────────────────────────────

/** 백분율 (소수 1자리). 분모 0 → null (측정 불가를 0% 로 속이지 않는다) */
export function percent(numerator: number, denominator: number): number | null {
  if (!denominator || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function ratio1(numerator: number, denominator: number): number | null {
  if (!denominator || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10) / 10;
}

export function deltaPp(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Math.round((current - previous) * 10) / 10;
}

// ────────────────────────────── SQL 조각 ──────────────────────────────

export function textArray(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::text[]`;
}

export function uuidArray(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::uuid[]`;
}

/** ILIKE 패턴 이스케이프 (앞뒤 %) */
export function likeContains(s: string): string {
  return `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export function likePrefix(s: string): string {
  return `${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

// ────────────────────────────── 커서 (keyset) ──────────────────────────────

export function encodeCursor(values: Record<string, string | number | null>): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: unknown): Record<string, unknown> | null {
  if (typeof cursor !== 'string' || cursor === '' || cursor.length > 500) return null;
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function invalidCursor(): ValidationError {
  return new ValidationError('목록 위치 정보가 올바르지 않습니다. 목록을 처음부터 다시 불러오세요.', [{ field: 'cursor', message: 'invalid' }]);
}

// ────────────────────────────── 링크 ──────────────────────────────

function qs(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const hrefs = {
  inbox: (p: { period: string; bucket?: string | null; client?: string | null; tx?: string | null; search?: string | null }) =>
    `/inbox${qs({ bucket: p.bucket, period: p.period, client: p.client, tx: p.tx, search: p.search })}`,
  transfer: (p: { period: string; client?: string | null; status?: string | null; recon?: string | null; filter?: string | null }) =>
    `/transfer${qs({ period: p.period, client: p.client, status: p.status, recon: p.recon, filter: p.filter })}`,
  imports: (p: { period?: string | null; client?: string | null; outcome?: string | null }) => `/imports${qs({ period: p.period, client: p.client, outcome: p.outcome })}`,
  payrollWizard: (clientId: string, period: string) => `/payroll/${clientId}/${period}`,
  payroll: (p: { period: string; filter?: string | null }) => `/payroll${qs({ period: p.period, filter: p.filter })}`,
  filing: (p: { period?: string | null; client?: string | null; due?: string | null }) => `/filing${qs({ period: p.period, client: p.client, due: p.due })}`,
  client: (clientId: string, tab?: string | null, extra: Record<string, string | null | undefined> = {}) => `/clients/${clientId}${qs({ tab, ...extra })}`,
  kpi: (p: { period?: string | null; client?: string | null; metric?: string | null }) => `/kpi${qs({ period: p.period, client: p.client, metric: p.metric })}`,
  review: (p: { period?: string | null; client?: string | null }) => `/review${qs({ period: p.period, client: p.client })}`,
  rules: (p: { rule?: string | null; client?: string | null; status?: string | null; search?: string | null } = {}) =>
    `/rules${qs({ rule: p.rule, client: p.client, status: p.status, search: p.search })}`,
  reconciliation: (id: string) => `/reconciliation/${id}`,
  exportJob: (id: string) => `/transfer/${id}`,
  job: (id: string) => `/jobs/${id}`,
  audit: (p: { entityType?: string | null; entityId?: string | null; client?: string | null } = {}) =>
    `/audit${qs({ entityType: p.entityType, entityId: p.entityId, client: p.client })}`,
  account: (code: string) => `/settings/accounts${qs({ code })}`,
  employee: (clientId: string, employeeId: string) => `/payroll/${clientId}/setup${qs({ employee: employeeId })}`,
  integrations: () => '/settings/integrations',
  systemErrors: (id?: string | null) => `/settings/system-errors${qs({ id })}`,
};

// ────────────────────────────── 라벨 ──────────────────────────────

export const JOB_TYPE_LABELS: Readonly<Record<JobType, string>> = Object.freeze({
  import_file: '자료 가져오기',
  classify_batch: '자동분류',
  export_wehago: 'WEHAGO 전송파일 생성',
  reconcile: '대사',
  payroll_prepare: '인건비 준비',
  ai_review: 'AI 장부검토',
  kpi_snapshot: 'KPI 집계',
});

export function jobTypeLabel(type: string): string {
  return (JOB_TYPE_LABELS as Record<string, string>)[type] ?? type;
}

export const JOB_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  queued: '대기',
  running: '실행 중',
  succeeded: '완료',
  partial: '부분 완료',
  failed: '실패',
  cancelled: '취소',
});

export const NOTIFICATION_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  export_error: 'WEHAGO 전송 오류',
  recon_mismatch: '대사 불일치',
  payroll_unreviewed: '인건비 미검토',
  import_failed: '자료 수집 실패',
  job_failed: '작업 실패',
  rule_suggested: '규칙 제안',
  filing_due: '신고 기한',
});

export const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({ high: 0, warning: 1, info: 2 });

export const FILING_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  withholding: '원천세',
  local_income_tax: '지방소득세(특별징수)',
  simplified_statement_earned: '간이지급명세서(근로)',
  simplified_statement_business: '간이지급명세서(사업)',
  daily_statement: '일용근로소득 지급명세서',
  vat: '부가가치세',
});

export const FILING_STEP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  payroll_input: '인건비 입력',
  earned_confirmed: '급여 확정',
  business_confirmed: '사업소득 확정',
  daily_confirmed: '일용직 확정',
  withholding_ready: '원천세 준비',
  simplified_statement_ready: '간이지급명세서 준비',
  local_tax_ready: '지방소득세 준비',
  filed: '신고 완료',
  receipt_collected: '접수증 수집',
  payment_slip_collected: '납부서 수집',
});

/** 신고 "끝나지 않은" 단계 판단: 신고 완료 이후 단계면 기한 알림 대상 아님 */
export const FILING_DONE_STEPS: readonly string[] = ['filed', 'receipt_collected', 'payment_slip_collected'];

export const EVIDENCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  tax_invoice: '세금계산서',
  invoice_exempt: '계산서',
  card: '카드',
  cash_receipt: '현금영수증',
  bank: '통장',
  other: '기타',
});

/** 대시보드 "계정분류" 묶음 버킷 */
export const ACCOUNT_GROUP_BUCKETS: readonly ExceptionBucket[] = ['low_confidence', 'account_conflict', 'unclassified', 'changed_from_history'];

// ────────────────────────────── CSV ──────────────────────────────

/** CSV 셀 — 따옴표 이스케이프 + 수식 주입 방지(=,+,-,@ 로 시작하면 ' 접두) */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

// ────────────────────────────── 검색어 해석 (Ctrl+K) ──────────────────────────────

export interface ParsedGlobalQuery {
  raw: string;
  /** 금액으로 읽히는 토큰 (72300, 72,300, 72,300원) */
  amounts: number[];
  /** 사업자번호 (하이픈 허용 10자리) */
  businessNumber: string | null;
  /** 기간 (2026-09, 2026.9, 9월 → 기준연도 적용) */
  period: string | null;
  /** 금액·기간·사업자번호를 뺀 나머지 글자 (숫자만인 토큰 제외) */
  text: string;
  /** 숫자 토큰까지 포함한 검색어 (수임처 코드·계정코드 검색용) */
  textAll: string;
  /** normalizeMerchantName(text) */
  merchantKey: string;
  /** 주민번호·카드번호처럼 보이는 입력 — 검색하지 않는다 */
  sensitive: boolean;
}

export function parseGlobalQuery(q: unknown, referenceYear: number): ParsedGlobalQuery {
  const raw = String(q ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, 100);
  const sensitive = /\d{6}\s*-?\s*[1-8]\d{6}/.test(raw) || /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/.test(raw);
  const amounts: number[] = [];
  let businessNumber: string | null = null;
  let period: string | null = null;
  const rest: string[] = [];
  const all: string[] = [];
  for (const tok of raw.split(/\s+/).filter(Boolean)) {
    const biz = /^\d{3}-?\d{2}-?\d{5}$/.test(tok) ? normalizeBusinessNumber(tok) : null;
    if (biz && !businessNumber) {
      businessNumber = biz;
      continue;
    }
    const pm = /^(\d{4})[-./](\d{1,2})$/.exec(tok) ?? null;
    if (pm && Number(pm[2]) >= 1 && Number(pm[2]) <= 12) {
      period = `${pm[1]}-${String(Number(pm[2])).padStart(2, '0')}`;
      continue;
    }
    const km = /^(\d{1,2})월$/.exec(tok);
    if (km && Number(km[1]) >= 1 && Number(km[1]) <= 12) {
      period = `${referenceYear}-${String(Number(km[1])).padStart(2, '0')}`;
      continue;
    }
    if (/^₩?\d{1,3}(,\d{3})+원?$/.test(tok) || /^₩?\d{2,13}원?$/.test(tok)) {
      const w = parseWon(tok.replace(/^₩/, ''));
      if (w !== null && w > 0) {
        amounts.push(w);
        // 순수 숫자는 수임처 코드·계정코드일 수도 있어 textAll 에 남긴다
        if (/^\d+$/.test(tok)) all.push(tok);
        continue;
      }
    }
    rest.push(tok);
    all.push(tok);
  }
  const text = sensitive ? '' : rest.join(' ');
  return {
    raw,
    amounts: sensitive ? [] : amounts,
    businessNumber: sensitive ? null : businessNumber,
    period,
    text,
    textAll: sensitive ? '' : all.join(' '),
    merchantKey: normalizeMerchantName(text),
    sensitive,
  };
}

// ────────────────────────────── 기타 ──────────────────────────────

export function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
