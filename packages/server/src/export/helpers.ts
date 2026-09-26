/**
 * WEHAGO Bridge — 순수 도우미 (DB 없음, 단위 테스트 대상).
 * 경로 판정(매입매출/일반전표), 수임처 전송 범위, 사전검증 사유, 파일명, 링크.
 */
import { formatBusinessNumber, formatWon, normalizeMerchantName, type EvidenceType, type JournalLine, type NormalizedTransaction, type VatType } from '@mintax/core';
import { buildJournalEntry, validateBalanced } from '@mintax/core/engine/vat-risk-index';
import { resolveWehagoVatCode, type ExportIssue, type ExportRow, type WehagoTemplate } from '@mintax/adapters';
import { ValidationError } from '@mintax/security';
import type { ExportBlockReason, TotalsDTO, WehagoExportKind } from './types';

export const EXPORT_KINDS: readonly WehagoExportKind[] = ['wehago_purchase_sales', 'wehago_general_journal'];

export const EXPORT_KIND_LABELS: Record<WehagoExportKind, string> = {
  wehago_purchase_sales: '매입매출',
  wehago_general_journal: '일반전표',
};

export const EXPORT_STATUS_LABELS: Record<string, string> = {
  validating: '검증 중',
  blocked: '차단',
  ready: '전송준비',
  downloaded: '파일 받음',
  uploaded_confirmed: '업로드 확인',
  failed: '실패',
};

/** 전송 대상(승인 계열) 거래 상태 */
export const APPROVED_STATUSES = ['approved', 'auto_approved', 'exported', 'reconciled'] as const;
/** 검토 전 상태 */
export const UNREVIEWED_STATUSES = ['imported', 'classified', 'needs_review'] as const;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 수임처·기간 단위 전송/대사 직렬화 잠금 네임스페이스 (pg_advisory_xact_lock(ns, hashtext(client||period))) */
export const EXPORT_LOCK_NAMESPACE = 72_010;

export const EVIDENCE_LABELS: Record<string, string> = {
  tax_invoice: '세금계산서',
  invoice_exempt: '계산서',
  card: '카드',
  cash_receipt: '현금영수증',
  bank: '통장',
  other: '기타',
  unknown: '미상',
};

export const WEHAGO_FILE_NOTE =
  'WEHAGO 전표 API가 없어(공개 API 미확인) 파일로 전달합니다. 파일을 받아 WEHAGO [엑셀서식 불러오기]로 직원이 직접 올려야 합니다.';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertPeriod(period: unknown): string {
  if (typeof period !== 'string' || !PERIOD_RE.test(period)) {
    throw new ValidationError('처리 기간 형식이 올바르지 않습니다. 예: 2026-09', [{ field: 'period', message: 'YYYY-MM' }]);
  }
  return period;
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function assertUuid(v: unknown, field: string, what: string): string {
  if (!isUuid(v)) throw new ValidationError(`${what} 식별자가 올바르지 않습니다.`, [{ field, message: 'uuid' }]);
  return v;
}

export function assertKind(kind: unknown): WehagoExportKind {
  if (kind === 'wehago_purchase_sales' || kind === 'wehago_general_journal') return kind;
  throw new ValidationError('전송 종류는 매입매출(wehago_purchase_sales) 또는 일반전표(wehago_general_journal)여야 합니다.', [
    { field: 'kind', message: 'wehago_purchase_sales | wehago_general_journal' },
  ]);
}

export function templateKindOf(kind: WehagoExportKind): 'purchase_sales' | 'general_journal' {
  return kind === 'wehago_purchase_sales' ? 'purchase_sales' : 'general_journal';
}

// ────────────────────────────── 링크 ──────────────────────────────

export function inboxHref(clientId: string, period: string, filter?: string): string {
  return `/inbox?client=${clientId}&period=${period}${filter ? `&filter=${filter}` : ''}`;
}
export function transferHref(clientId: string, period: string): string {
  return `/transfer?client=${clientId}&period=${period}`;
}
export function exportHref(exportJobId: string): string {
  return `/transfer/${exportJobId}`;
}
export function reconciliationHref(id: string): string {
  return `/reconciliation/${id}`;
}
export function importsHref(clientId: string, period: string, outcome?: string): string {
  return `/imports?client=${clientId}&period=${period}${outcome ? `&outcome=${outcome}` : ''}`;
}
export function partnerCodesHref(clientId: string, period: string): string {
  return `/transfer/partners?client=${clientId}&period=${period}`;
}
export const TEMPLATES_HREF = '/settings/templates';

// ────────────────────────────── 파일명 ──────────────────────────────

/** "C001_에이플러스디자인_2026-09_매입매출.xlsx" (v2 부터 _v2) */
export function exportFileName(client: { code: string; name: string }, period: string, kind: WehagoExportKind, version: number): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '').trim();
  const v = version > 1 ? `_v${version}` : '';
  return `${clean(client.code)}_${clean(client.name)}_${period}_${EXPORT_KIND_LABELS[kind]}${v}.xlsx`;
}

// ────────────────────────────── 금액 ──────────────────────────────

export function emptyTotalsDTO(): TotalsDTO {
  return { count: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0 };
}

export function addTotals(t: TotalsDTO, a: { supplyAmount: number; vatAmount: number; totalAmount: number }): void {
  t.count += 1;
  t.supplyAmount += a.supplyAmount;
  t.vatAmount += a.vatAmount;
  t.totalAmount += a.totalAmount;
}

export function totalsMatch(a: TotalsDTO, b: TotalsDTO): boolean {
  return a.count === b.count && a.supplyAmount === b.supplyAmount && a.vatAmount === b.vatAmount && a.totalAmount === b.totalAmount;
}

export function totalsText(t: TotalsDTO): string {
  return `${t.count.toLocaleString('ko-KR')}건 · 공급가액 ${formatWon(t.supplyAmount)} · 부가세 ${formatWon(t.vatAmount)} · 합계 ${formatWon(t.totalAmount)}`;
}

// ────────────────────────────── 수임처 전송 범위 (이중 기장 방지) ──────────────────────────────

export type ExportScopeMode = 'wehago_collects' | 'mintax_exports' | 'none';

export interface ExportScope {
  /** 명시 설정 (client_business_profiles.rule_params 의 export_scope.<증빙유형>) */
  byEvidence: Partial<Record<string, ExportScopeMode>>;
  /** export_scope.* 키가 하나라도 있는가 */
  configured: boolean;
  /** WEHAGO 가 직접 수집하는 원천 → 전송파일·전송 대사에서 제외 */
  excludedEvidenceTypes: string[];
}

const SCOPE_MODES = new Set<ExportScopeMode>(['wehago_collects', 'mintax_exports', 'none']);

/**
 * docs/integration-architecture.md §8 — 저장 위치: rule_params['export_scope.<evidenceType>'].
 * 명시적으로 wehago_collects 인 원천만 제외한다. 설정이 없는 원천은 포함하되 이중 기장 경고를 낸다
 * (문서 기본값 wehago_collects 로 두면 설정 전 수임처의 전송파일이 비어 버리므로 — 경고로 알리는 쪽을 택함).
 */
export function parseExportScope(ruleParams: Record<string, unknown> | null | undefined): ExportScope {
  const byEvidence: Partial<Record<string, ExportScopeMode>> = {};
  let configured = false;
  for (const [k, v] of Object.entries(ruleParams ?? {})) {
    const m = /^export_scope\.(\w+)$/.exec(k);
    if (!m) continue;
    configured = true;
    if (typeof v === 'string' && SCOPE_MODES.has(v as ExportScopeMode)) byEvidence[m[1]!] = v as ExportScopeMode;
  }
  const excludedEvidenceTypes = Object.entries(byEvidence)
    .filter(([, mode]) => mode === 'wehago_collects')
    .map(([ev]) => ev)
    .sort();
  return { byEvidence, configured, excludedEvidenceTypes };
}

export function scopeWarning(scope: ExportScope, presentEvidence: Iterable<string>): string | null {
  const unset = [...new Set(presentEvidence)].filter((e) => !scope.byEvidence[e]).sort();
  if (unset.length === 0) return null;
  return (
    `이중 기장 주의: 전송 범위가 설정되지 않은 원천(${unset.map((e) => EVIDENCE_LABELS[e] ?? e).join(', ')})을 전송파일에 포함했습니다. ` +
    'WEHAGO T 자동전표처리가 같은 자료를 홈택스에서 직접 수집하고 있다면 이중 기장됩니다 — WEHAGO 쪽 수집을 끄거나 수임처 전송 범위를 "WEHAGO 수집"으로 설정하세요.'
  );
}

// ────────────────────────────── 경로 판정 (매입매출 / 일반전표) ──────────────────────────────

export type ExportRoute = WehagoExportKind | 'unroutable';

export interface RouteInput {
  direction: 'purchase' | 'sales';
  evidenceType: string;
  vatType: string | null;
  deductible: boolean | null;
  vatAmount: number;
}

export interface RouteResult {
  route: ExportRoute;
  /** unroutable 사유 */
  problem?: 'vat_type_missing' | 'vat_code_unmapped';
  reason?: string;
}

/**
 * 거래 → WEHAGO 전표 종류.
 * - 적격증빙 없음(purchase_no_evidence), 세액 0 불공제 매입 → 일반전표 (adapters resolveWehagoVatCode 규칙과 동일)
 * - 서식에 유형코드 매핑이 없는 부가세 유형은 일반전표로 조용히 돌리지 않고 차단 사유로 올린다.
 */
export function routeForExport(tx: RouteInput, psTemplate: WehagoTemplate): RouteResult {
  if (!tx.vatType) return { route: 'unroutable', problem: 'vat_type_missing', reason: '부가세 유형이 정해지지 않았습니다.' };
  if (!(tx.vatType in psTemplate.vatTypeCodes)) {
    return { route: 'unroutable', problem: 'vat_code_unmapped', reason: `WEHAGO 유형코드 매핑 없음: ${tx.vatType}` };
  }
  const res = resolveWehagoVatCode(
    { vatType: tx.vatType as VatType, deductible: tx.deductible, direction: tx.direction, vatAmount: tx.vatAmount, evidenceType: tx.evidenceType as EvidenceType },
    psTemplate,
  );
  if (res.kind === 'code') return { route: 'wehago_purchase_sales' };
  const intended =
    tx.vatType === 'purchase_no_evidence' ||
    (tx.direction === 'purchase' && tx.deductible === false && tx.vatType !== 'purchase_non_deductible' && tx.vatAmount === 0);
  if (intended) return { route: 'wehago_general_journal' };
  return { route: 'unroutable', problem: 'vat_code_unmapped', reason: `WEHAGO 유형코드 매핑 없음: ${tx.vatType}` };
}

// ────────────────────────────── WEHAGO 거래처코드 ──────────────────────────────

export interface PartnerCodeStore {
  byBizNo: Record<string, { code: string; name: string; source: 'manual' | 'wehago_ledger'; updatedAt: string }>;
  byName: Record<string, { code: string; name: string; source: 'manual' | 'wehago_ledger'; updatedAt: string }>;
}

export function emptyPartnerStore(): PartnerCodeStore {
  return { byBizNo: {}, byName: {} };
}

export function lookupPartnerCode(store: PartnerCodeStore, bizNo: string | null, merchantName: string): string | null {
  if (bizNo && store.byBizNo[bizNo]) return store.byBizNo[bizNo]!.code;
  const key = normalizeMerchantName(merchantName);
  if (key && store.byName[key]) return store.byName[key]!.code;
  return null;
}

// ────────────────────────────── 사전검증 ──────────────────────────────

/** DB 에서 읽은 전송 후보 거래 (승인 계열) */
export interface CandidateTx {
  id: string;
  status: string;
  direction: 'purchase' | 'sales';
  transactionDate: string;
  evidenceType: string;
  merchantName: string;
  merchantBusinessNumber: string | null;
  description: string;
  supplyAmount: number;
  vatAmount: number;
  serviceCharge: number;
  totalAmount: number;
  accountCode: string | null;
  accountName: string | null;
  vatType: string | null;
  deductible: boolean | null;
  vatReasonCode: string | null;
  approvalNumber: string | null;
  cardCompany: string | null;
  exportJobId: string | null;
}

export interface CheckContext {
  kind: WehagoExportKind;
  clientId: string;
  period: string;
  /** 출력 서식 (kind 에 해당) */
  template: WehagoTemplate;
  /** 경로 판정용 매입매출 서식 */
  psTemplate: WehagoTemplate;
  /** 사용 가능한 계정코드 → 계정명 */
  accounts: ReadonlyMap<string, string>;
  partners: PartnerCodeStore;
  /** 불공제 사유 코드 → 사람이 읽는 이름 */
  vatReasonName?: (code: string) => string | null;
}

export interface CheckResult {
  reasons: ExportBlockReason[];
  rows: ExportRow[];
  /** kind 에 해당하는 후보 거래 (차단 여부와 무관) */
  inKind: CandidateTx[];
  /** 다른 전표 종류로 가는 거래 */
  otherKind: CandidateTx[];
  routes: Map<string, RouteResult>;
}

const MAX_IDS = 50;

function reason(code: string, message: string, ids: string[], href: string | null, actionLabel: string | null): ExportBlockReason {
  return { code, message, count: ids.length, href, actionLabel, transactionIds: ids.slice(0, MAX_IDS) };
}

function label(t: Pick<CandidateTx, 'transactionDate' | 'merchantName' | 'totalAmount'>): string {
  return `${t.transactionDate} ${t.merchantName || '(상호 없음)'} ${formatWon(t.totalAmount)}`;
}

/** DB 거래 → core 분개 입력 (buildJournalEntry 가 쓰는 필드만) */
export function journalInput(t: CandidateTx): NormalizedTransaction {
  return {
    direction: t.direction,
    evidenceType: t.evidenceType,
    transactionDate: t.transactionDate,
    merchantName: t.merchantName,
    merchantBusinessNumber: t.merchantBusinessNumber,
    description: t.description,
    supplyAmount: t.supplyAmount,
    vatAmount: t.vatAmount,
    serviceCharge: t.serviceCharge,
    totalAmount: t.totalAmount,
    originalSourceId: null,
    fingerprint: t.id,
  } as unknown as NormalizedTransaction;
}

/**
 * 후보 거래를 사전검증하고 전송 행을 만든다.
 * 사유가 하나라도 있으면 rows 는 참고용이며 파일을 만들면 안 된다.
 */
export function checkCandidates(cands: readonly CandidateTx[], c: CheckContext): CheckResult {
  const routes = new Map<string, RouteResult>();
  const inKind: CandidateTx[] = [];
  const otherKind: CandidateTx[] = [];
  const vatMissing: string[] = [];
  const unmapped = new Map<string, string[]>();
  const noAccount: string[] = [];
  const unbalanced: Array<{ id: string; text: string }> = [];
  const noPartner: string[] = [];
  const noPartnerNames = new Set<string>();
  const undecided: string[] = [];
  const rows: ExportRow[] = [];

  for (const t of cands) {
    const r = routeForExport(t, c.psTemplate);
    routes.set(t.id, r);
    if (r.route === 'unroutable') {
      if (r.problem === 'vat_type_missing') vatMissing.push(t.id);
      else {
        const k = t.vatType ?? '(없음)';
        (unmapped.get(k) ?? unmapped.set(k, []).get(k)!).push(t.id);
      }
      continue;
    }
    if (r.route !== c.kind) {
      otherKind.push(t);
      continue;
    }
    inKind.push(t);

    const code = t.accountCode?.trim() ?? '';
    const accountName = code ? c.accounts.get(code) : undefined;
    if (!code || accountName === undefined) {
      noAccount.push(t.id);
      continue;
    }
    let lines: JournalLine[] = [];
    try {
      const entry = buildJournalEntry(
        journalInput(t),
        { accountCode: code, accountName: t.accountName || accountName, deductible: t.deductible, vatType: t.vatType as VatType },
        { transactionId: t.id },
      );
      const bal = validateBalanced(entry);
      if (!bal.balanced) {
        unbalanced.push({ id: t.id, text: `${label(t)} 차변 ${formatWon(bal.debit)} ≠ 대변 ${formatWon(bal.credit)}` });
        continue;
      }
      lines = entry.lines;
    } catch (e) {
      unbalanced.push({ id: t.id, text: `${label(t)} 분개 생성 실패: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    let counterpartyCode: string | null = null;
    if (c.kind === 'wehago_purchase_sales') {
      counterpartyCode = lookupPartnerCode(c.partners, t.merchantBusinessNumber, t.merchantName);
      if (!counterpartyCode && c.template.requireCounterpartyCode) {
        noPartner.push(t.id);
        noPartnerNames.add(t.merchantBusinessNumber ?? normalizeMerchantName(t.merchantName));
        continue;
      }
      if (t.direction === 'purchase' && t.deductible === null && t.vatAmount !== 0) {
        undecided.push(t.id);
        continue;
      }
    }

    rows.push({
      transactionId: t.id,
      date: t.transactionDate,
      direction: t.direction,
      evidenceType: t.evidenceType as EvidenceType,
      vatType: t.vatType as VatType,
      deductible: t.deductible,
      nonDeductibleReason: t.deductible === false && t.vatReasonCode ? (c.vatReasonName?.(t.vatReasonCode) ?? t.vatReasonCode) : null,
      counterpartyCode,
      counterpartyName: t.merchantName,
      counterpartyBusinessNumber: t.merchantBusinessNumber,
      description: t.description || null,
      supplyAmount: t.supplyAmount,
      vatAmount: t.vatAmount,
      serviceCharge: t.serviceCharge,
      totalAmount: t.totalAmount,
      accountCode: code,
      accountName: t.accountName || accountName,
      cardCompany: t.cardCompany,
      approvalNumber: t.approvalNumber,
      journalLines: c.kind === 'wehago_general_journal' ? lines : undefined,
    });
  }

  const reasons: ExportBlockReason[] = [];
  const inbox = (f?: string) => inboxHref(c.clientId, c.period, f);
  if (vatMissing.length) {
    reasons.push(reason('vat_type_missing', `부가세 유형이 정해지지 않은 승인 거래 ${vatMissing.length}건이 있습니다.`, vatMissing, inbox('vat_review'), `${vatMissing.length}건 검토하기`));
  }
  for (const [vatType, ids] of [...unmapped].sort(([a], [b]) => a.localeCompare(b))) {
    reasons.push(reason('vat_code_unmapped', `WEHAGO 유형코드 매핑 없음: ${vatType} (${ids.length}건) — 서식의 유형코드 표를 확인하세요.`, ids, TEMPLATES_HREF, 'WEHAGO 서식 확인'));
  }
  if (noAccount.length) {
    reasons.push(reason('missing_account', `WEHAGO 파일 생성 중 ${noAccount.length}건의 계정코드를 찾지 못했습니다.`, noAccount, inbox('account_missing'), `${noAccount.length}건 검토하기`));
  }
  if (unbalanced.length) {
    const ids = unbalanced.map((u) => u.id);
    reasons.push(reason('unbalanced', `차대 불일치 ${unbalanced.length}건 (예: ${unbalanced[0]!.text}).`, ids, inbox(), `${unbalanced.length}건 확인하기`));
  }
  if (noPartner.length) {
    reasons.push(
      reason(
        'missing_counterparty_code',
        `WEHAGO 거래처코드가 연결되지 않은 거래처 ${noPartnerNames.size}곳(${noPartner.length}건)이 있습니다 — WEHAGO 거래처등록의 코드를 연결하세요.`,
        noPartner,
        partnerCodesHref(c.clientId, c.period),
        '거래처코드 연결',
      ),
    );
  }
  if (undecided.length) {
    reasons.push(reason('deductible_undecided', `매입세액 공제 여부가 확정되지 않은 거래 ${undecided.length}건이 있습니다.`, undecided, inbox('vat_review'), `${undecided.length}건 검토하기`));
  }
  return { reasons, rows, inKind, otherKind, routes };
}

/** 어댑터 사전검증 오류 → 차단 사유 (코드별 묶음) */
export function reasonsFromAdapterIssues(errors: readonly ExportIssue[], clientId: string, period: string): ExportBlockReason[] {
  const groups = new Map<string, ExportIssue[]>();
  for (const e of errors) (groups.get(e.code) ?? groups.set(e.code, []).get(e.code)!).push(e);
  const out: ExportBlockReason[] = [];
  for (const [code, list] of groups) {
    const ids = [...new Set(list.map((e) => e.transactionId).filter((x): x is string => !!x))];
    const n = list.length;
    const first = list[0]!.message;
    let message: string;
    let href: string | null = inboxHref(clientId, period);
    let actionLabel: string | null = ids.length ? `${ids.length}건 확인하기` : null;
    switch (code) {
      case 'invalid_account':
      case 'invalid_line_account':
        message = `WEHAGO 파일 생성 중 ${n}건의 계정코드를 찾지 못했습니다.`;
        break;
      case 'unbalanced':
      case 'sum_mismatch':
      case 'journal_total_mismatch':
        message = `차대 불일치 ${n}건 (예: ${first}).`;
        break;
      case 'missing_counterparty_code':
        message = `WEHAGO 거래처코드가 없는 거래 ${n}건이 있습니다.`;
        href = partnerCodesHref(clientId, period);
        actionLabel = '거래처코드 연결';
        break;
      case 'invalid_bizno':
      case 'bizno_checksum':
        message = `상대방 사업자번호 오류 ${n}건 (예: ${first}).`;
        break;
      case 'deductible_undecided':
        message = `매입세액 공제 여부가 확정되지 않은 거래 ${n}건이 있습니다.`;
        href = inboxHref(clientId, period, 'vat_review');
        break;
      case 'template_invalid':
        message = `WEHAGO 서식 오류: ${first}`;
        href = TEMPLATES_HREF;
        actionLabel = '서식 다시 등록';
        break;
      case 'out_of_period':
        message = `전송 기간 밖 일자 ${n}건 (예: ${first}).`;
        break;
      default:
        message = n > 1 ? `${first} 외 ${n - 1}건` : first;
    }
    out.push({ code: `adapter_${code}`, message, count: n, href, actionLabel, transactionIds: ids.slice(0, MAX_IDS) });
  }
  return out;
}

/** 어댑터 경고 → 사람이 읽는 경고 문장 (코드별 1줄) */
export function warningsFromAdapterIssues(warnings: readonly ExportIssue[]): string[] {
  const groups = new Map<string, ExportIssue[]>();
  for (const w of warnings) {
    if (w.code === 'unverified_template') continue; // 서식 경고는 별도 문구로 낸다
    (groups.get(w.code) ?? groups.set(w.code, []).get(w.code)!).push(w);
  }
  const out: string[] = [];
  for (const [code, list] of groups) {
    if (code === 'needs_reason') out.push(`불공제(54) ${list.length}건 — WEHAGO에서 불공제사유 번호를 선택해야 합니다.`);
    else out.push(list.length > 1 ? `${list[0]!.message} 외 ${list.length - 1}건` : list[0]!.message);
  }
  return out;
}

/**
 * WEHAGO 중복전표 기준(일자 + 사업자번호 + 금액 + 과세유형 — research/01 §2.9)으로
 * 같은 파일 안에서 WEHAGO 가 중복으로 표시할 수 있는 거래 묶음.
 */
export function wehagoDuplicateGroups(rows: ReadonlyArray<Pick<ExportRow, 'transactionId' | 'date' | 'counterpartyBusinessNumber' | 'totalAmount' | 'vatType' | 'direction' | 'counterpartyName'>>): Array<{ key: string; ids: string[]; label: string }> {
  const map = new Map<string, { ids: string[]; label: string }>();
  for (const r of rows) {
    if (!r.counterpartyBusinessNumber) continue;
    const key = [r.direction, r.date, r.counterpartyBusinessNumber, r.totalAmount, r.vatType].join('|');
    const e = map.get(key);
    if (e) e.ids.push(r.transactionId);
    else map.set(key, { ids: [r.transactionId], label: `${r.date} ${r.counterpartyName} (${formatBusinessNumber(r.counterpartyBusinessNumber)}) ${formatWon(r.totalAmount)}` });
  }
  return [...map.entries()].filter(([, v]) => v.ids.length > 1).map(([key, v]) => ({ key, ...v }));
}

export function blockedSummary(clientName: string, period: string, kind: WehagoExportKind, reasons: readonly ExportBlockReason[]): string {
  const head = `${clientName} ${period} ${EXPORT_KIND_LABELS[kind]} 전송 차단`;
  if (reasons.length === 0) return head;
  return `${head}: ${reasons[0]!.message}${reasons.length > 1 ? ` 외 ${reasons.length - 1}건` : ''}`;
}

/** 사용자에게 보여줄 한 줄 차단 사유 (export_jobs.blocked_reason) */
export function blockedReasonText(reasons: readonly ExportBlockReason[]): string {
  return reasons.map((r) => r.message).join(' / ').slice(0, 2000);
}

/** 'YYYYMMDD' (KST) */
export function kstCompactDate(d: Date): string {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}${String(k.getUTCDate()).padStart(2, '0')}`;
}

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
