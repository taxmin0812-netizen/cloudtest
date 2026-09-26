/**
 * 자료 수집(imports) — 순수 도우미 (DB 없음, 단위 테스트 대상).
 */
import { randomBytes } from 'node:crypto';
import type { Direction, EvidenceType, IngestChannel } from '@mintax/core';

// ────────────────────────────── 상수 ──────────────────────────────

/** 수임처 자동 확정 기준 신뢰도 (파일명·제목행의 사업자번호, 데이터 열 반복 등) — 상호만 일치(70~78)는 사람에게 묻는다 */
export const CLIENT_AUTO_CONFIDENCE = 80;
/** 업로드 최대 크기 (바이트). 이보다 크면 기간을 나누어 올리도록 안내한다 */
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
/** DB 적재 청크 크기 */
export const TX_CHUNK = 500;
export const SOURCE_CHUNK = 1000;
/** 가져오기 중복 판정 advisory lock 네임스페이스 ('IMPT') — 전송·대사 잠금과 키 공간 분리 */
export const IMPORT_LOCK_NAMESPACE = 0x494d5054;

/** WEHAGO 이중 기장 가드 사유 (정확한 문구 — 화면·테스트 공유) */
export const WEHAGO_DUPLICATE_REASON = 'WEHAGO에 이미 전송된 거래와 동일(일자·사업자번호·금액·과세유형)';
export const WEHAGO_DUPLICATE_RULE_CODE = 'IMPORT_WEHAGO_DOUBLE_BOOKING';

/** import_jobs.message 의 상태 태그 (사람이 읽을 수 있는 형태로 두고, 상태 판정에도 쓴다) */
export const NEEDS_CLIENT_TAG = '[수임처 확인 필요]';
export const NEEDS_MAPPING_TAG = '[서식 확인 필요]';

export const INGEST_CHANNELS: readonly IngestChannel[] = [
  'wemembers_api',
  'wemembers_file',
  'download_watch',
  'cloud_folder',
  'desktop_bridge',
  'hometax_file',
  'manual_upload',
];

export const INGEST_CHANNEL_LABELS: Readonly<Record<IngestChannel, string>> = {
  wemembers_api: '위멤버스 API',
  wemembers_file: '위멤버스 파일',
  download_watch: '다운로드 폴더 (Bridge)',
  cloud_folder: '클라우드 폴더',
  desktop_bridge: 'Desktop Bridge',
  hometax_file: '홈택스 파일',
  manual_upload: '직접 업로드',
};

export function isIngestChannel(v: unknown): v is IngestChannel {
  return typeof v === 'string' && (INGEST_CHANNELS as readonly string[]).includes(v);
}

export function isValidPeriod(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}$/.test(v)) return false;
  const m = Number(v.slice(5, 7));
  return m >= 1 && m <= 12;
}

// ────────────────────────────── 요약 문구 ──────────────────────────────

export function formatCount(n: number): string {
  return n.toLocaleString('ko-KR');
}

export interface ImportCounts {
  totalRows: number;
  importedRows: number;
  duplicateRows: number;
  failedRows: number;
}

export type ImportState = 'needs_client' | 'needs_mapping' | 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

/**
 * 목록·상세의 한 줄 요약. 예: "1,048건 수집 · 1,046건 처리 · 2건 처리실패"
 * 처리 = 가져옴 + 중복(자동 처리). 중복이 있으면 "(중복 N건 포함)" 을 붙인다.
 */
export function buildImportSummary(c: ImportCounts, state: ImportState = 'succeeded'): string {
  if (state === 'needs_client') return '수임처 확인 필요 — 수임처를 선택하면 가져옵니다';
  if (state === 'needs_mapping') return '서식 확인 필요 — 열을 지정하면 가져옵니다';
  if (state === 'queued') return '대기 중';
  if (state === 'running') return '처리 중';
  if (state === 'failed' && c.totalRows === 0) return '가져오기 실패 — 사유를 확인하세요';
  const processed = c.importedRows + c.duplicateRows;
  const parts = [`${formatCount(c.totalRows)}건 수집`, `${formatCount(processed)}건 처리${c.duplicateRows > 0 ? `(중복 ${formatCount(c.duplicateRows)}건 포함)` : ''}`];
  if (c.failedRows > 0) parts.push(`${formatCount(c.failedRows)}건 처리실패`);
  return parts.join(' · ');
}

/** 알림 제목: "2건 처리실패 — 오류 항목을 확인하세요" */
export function failureNotificationTitle(failedRows: number): string {
  return `${formatCount(failedRows)}건 처리실패 — 오류 항목을 확인하세요`;
}

/** DB 상태 + 메시지 태그 → 화면 상태 */
export function deriveImportState(status: string, clientId: string | null, message: string | null): ImportState {
  if (status === 'queued' && message?.startsWith(NEEDS_MAPPING_TAG)) return 'needs_mapping';
  if (status === 'failed' && message?.startsWith(NEEDS_MAPPING_TAG)) return 'needs_mapping';
  if (status === 'queued' && !clientId) return 'needs_client';
  if (status === 'queued' || status === 'running' || status === 'succeeded' || status === 'partial' || status === 'failed') return status;
  return 'failed';
}

/** 행 계산 불변식: 수집 = 가져옴 + 중복 + 실패 */
export function checkRowAccounting(c: ImportCounts): string | null {
  const sum = c.importedRows + c.duplicateRows + c.failedRows;
  if (sum === c.totalRows && c.importedRows >= 0 && c.duplicateRows >= 0 && c.failedRows >= 0) return null;
  return `행 집계가 맞지 않습니다: 수집 ${formatCount(c.totalRows)}건 ≠ 가져옴 ${formatCount(c.importedRows)} + 중복 ${formatCount(
    c.duplicateRows,
  )} + 실패 ${formatCount(c.failedRows)} (= ${formatCount(sum)}). 데이터 유실을 막기 위해 적재를 취소했습니다. 관리자에게 문의하세요.`;
}

// ────────────────────────────── 경고 요약 ──────────────────────────────

export interface WarningLike {
  sourceRowNumber: number | null;
  code: string;
  message: string;
}

/** 행 단위 경고는 코드별로 묶어 "사유 (N건: 3, 5, 9행 …)" 로 줄인다 */
export function summarizeWarnings(warnings: readonly WarningLike[], maxRowsListed = 5): string[] {
  const groups = new Map<string, { message: string; rows: number[]; fileLevel: string[] }>();
  for (const w of warnings) {
    const g = groups.get(w.code) ?? { message: w.message, rows: [], fileLevel: [] };
    if (w.sourceRowNumber === null) {
      if (!g.fileLevel.includes(w.message)) g.fileLevel.push(w.message);
    } else {
      g.rows.push(w.sourceRowNumber);
    }
    groups.set(w.code, g);
  }
  const out: string[] = [];
  for (const g of groups.values()) {
    out.push(...g.fileLevel);
    if (g.rows.length === 1) out.push(`${g.rows[0]}행: ${g.message}`);
    else if (g.rows.length > 1) {
      const listed = g.rows.slice(0, maxRowsListed).join(', ');
      out.push(`${g.message} (${formatCount(g.rows.length)}건: ${listed}${g.rows.length > maxRowsListed ? ' …' : ''}행)`);
    }
  }
  return out;
}

// ────────────────────────────── 기간 ──────────────────────────────

/** 가져오기 대표 기간: 사용자가 지정하면 그 값, 아니면 가장 많은 달(동률이면 이른 달) */
export function chooseImportPeriod(periodCounts: ReadonlyMap<string, number>, requested: string | null | undefined): string | null {
  if (requested) return requested;
  let best: string | null = null;
  let bestCount = -1;
  for (const [p, n] of [...periodCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestCount) {
      best = p;
      bestCount = n;
    }
  }
  return best;
}

// ────────────────────────────── WEHAGO 이중 기장 가드 ──────────────────────────────

/**
 * WEHAGO(더존) 중복전표 판정 키: 일자 + 상대방 사업자번호 + 금액 + 과세유형 (research/01 §2.9).
 * 과세유형(매입매출 유형코드)은 분류 전에는 확정되지 않으므로 증빙 계열(세금계산서/계산서/카드/현금영수증) + 매입·매출로 근사한다.
 * 금액은 합계(공급가액 + 세액 + 봉사료) — 원천마다 공급가액/세액 분할 반올림이 달라도 같은 거래를 잡기 위해서다.
 * 사업자번호가 없으면 키를 만들지 않는다 (WEHAGO 도 판정하지 못함).
 */
export function wehagoTaxClass(evidenceType: EvidenceType | string): string {
  switch (evidenceType) {
    case 'tax_invoice':
      return '세금계산서';
    case 'invoice_exempt':
      return '계산서';
    case 'card':
      return '카드';
    case 'cash_receipt':
      return '현금영수증';
    default:
      return '기타';
  }
}

export function wehagoDuplicateKey(t: {
  direction: Direction | string;
  transactionDate: string;
  merchantBusinessNumber: string | null;
  totalAmount: number;
  evidenceType: EvidenceType | string;
}): string | null {
  if (!t.merchantBusinessNumber) return null;
  return [t.direction, t.transactionDate, t.merchantBusinessNumber, t.totalAmount, wehagoTaxClass(t.evidenceType)].join('|');
}

/**
 * 들어온 거래(키 목록) ↔ 이미 전송된 거래(키 목록) 1:1 매칭.
 * 이미 전송된 거래 하나는 한 번만 매칭된다 (같은 날 같은 금액 두 건 중 한 건만 이미 전송됐다면 한 건만 보류).
 * @param preConsumed fingerprint 로 이미 중복 처리된 전송 거래 id (다시 쓰지 않는다)
 * @returns incoming index → exported id
 */
export function matchWehagoDoubleBooking(
  incoming: ReadonlyArray<{ index: number; key: string | null }>,
  exported: ReadonlyArray<{ id: string; key: string | null }>,
  preConsumed: ReadonlySet<string> = new Set(),
): Map<number, string> {
  const pool = new Map<string, string[]>();
  for (const e of exported) {
    if (!e.key || preConsumed.has(e.id)) continue;
    const list = pool.get(e.key);
    if (list) list.push(e.id);
    else pool.set(e.key, [e.id]);
  }
  const out = new Map<number, string>();
  for (const i of incoming) {
    if (!i.key) continue;
    const list = pool.get(i.key);
    if (!list || list.length === 0) continue;
    out.set(i.index, list.shift()!);
  }
  return out;
}

// ────────────────────────────── 청크 ──────────────────────────────

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ────────────────────────────── Bridge 토큰 ──────────────────────────────

export const BRIDGE_TOKEN_PREFIX = 'mtb1';
const TOKEN_ID_RE = /^[a-f0-9]{16}$/;
const TOKEN_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/** 'mtb1.<16 hex id>.<43자 base64url 비밀>' — id 로 항목을 찾고 비밀은 HMAC 해시로만 비교한다 */
export function generateBridgeToken(): { id: string; token: string } {
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { id, token: `${BRIDGE_TOKEN_PREFIX}.${id}.${secret}` };
}

export function parseBridgeToken(token: unknown): { id: string } | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== BRIDGE_TOKEN_PREFIX) return null;
  if (!TOKEN_ID_RE.test(parts[1]!) || !TOKEN_SECRET_RE.test(parts[2]!)) return null;
  return { id: parts[1]! };
}

/** Bridge 메타데이터 sourceFolder → IngestChannel (desktop-bridge-design §4.3) */
export type BridgeSourceFolder = 'downloads' | 'inbox' | 'filing' | 'cloud_sync';

export function channelForBridgeFolder(sourceFolder: string | null | undefined): IngestChannel {
  return sourceFolder === 'downloads' ? 'download_watch' : 'desktop_bridge';
}

/** 경로에서 파일명만 (PC 사용자명 등 경로 정보는 저장하지 않는다) */
export function baseNameOf(p: string | null | undefined): string | null {
  if (!p) return null;
  const b = p.split(/[\\/]/).filter(Boolean).pop();
  return b ?? null;
}

/** "카드_202609.xlsx" → "카드_202609" */
export function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}
