import type {
  AmountTotals,
  EvidenceType,
  LocalDate,
  ReconDiscrepancy,
  ReconStage,
  ReconciliationReport,
  TransactionStatus,
  Won,
} from '../types';
import { addToTotals, emptyTotals, formatWon, totalsEqual } from '../money';
import { normalizeMerchantName } from '../normalize';

// ═══════════════════════════════ 입력 ═══════════════════════════════

/** transaction_sources 한 행 (원본 파일 행) */
export interface ReconSourceRow {
  rowNumber: number;
  outcome: 'ok' | 'duplicate' | 'failed';
  transactionId?: string | null;
  date?: LocalDate | null;
  merchantName?: string | null;
  supplyAmount?: Won | null;
  vatAmount?: Won | null;
  totalAmount?: Won | null;
  errorReason?: string | null;
}

export interface ReconTransaction {
  id: string;
  status: TransactionStatus;
  evidenceType: EvidenceType | string;
  accountCode: string | null;
  accountName: string | null;
  supplyAmount: Won;
  vatAmount: Won;
  totalAmount: Won;
  transactionDate: LocalDate;
  merchantName: string;
  duplicateReason?: string | null;
  excludedReason?: string | null;
}

/** export_items 한 행 (전송파일) */
export interface ReconExportRow {
  transactionId: string | null;
  supplyAmount: Won;
  vatAmount: Won;
  totalAmount: Won;
  accountCode: string | null;
  rowNumber?: number;
}

/** WEHAGO 매입매출장 역수입 행 */
export interface ReconWehagoRow {
  date: LocalDate;
  merchantName: string;
  supplyAmount: Won;
  vatAmount: Won;
  totalAmount: Won;
  accountCode?: string | null;
}

export interface ReconcileInput {
  source: { rows: readonly ReconSourceRow[] };
  transactions: readonly ReconTransaction[];
  /** 전송파일 행. 없으면 '전송 전' 대사 — 승인 거래를 전송 준비분으로 본다 */
  exportRows?: readonly ReconExportRow[];
  /** WEHAGO 역수입 행 (전송 후 대사) */
  wehagoRows?: readonly ReconWehagoRow[];
  scope: { period: string; clientName: string };
}

// ═══════════════════════════════ 출력 ═══════════════════════════════

export type ReconTerm = 'export' | 'duplicate' | 'excluded' | 'failed' | 'pending';

export interface ReconEquation {
  /** 'file' = 전송파일 기준, 'ready' = 전송 전(승인분 = 전송 준비분) */
  exportBasis: 'file' | 'ready';
  source: AmountTotals;
  terms: Record<ReconTerm, AmountTotals>;
  /** source − Σ terms (모든 차원 0 이어야 균형) */
  residual: AmountTotals;
}

export interface ReconcileResult extends ReconciliationReport {
  equation: ReconEquation;
  /** 전송되어야 할 승인 거래 합계 */
  expected: AmountTotals;
  /** 검토 대기 (미검토) 합계 */
  pendingReview: AmountTotals;
  /** 계정코드 → 계정명 (byAccount 표시용) */
  accountNames: Record<string, string>;
}

// ═══════════════════════════════ 내부 ═══════════════════════════════

type Category = ReconTerm | 'unexplained';

interface Amounts {
  supplyAmount: Won;
  vatAmount: Won;
  totalAmount: Won;
}

interface Unit {
  rows: ReconSourceRow[];
  tx: ReconTransaction | null;
  /** 원본 행 금액 (없으면 거래 금액) */
  amounts: Amounts;
  /** 원본 행에 세 금액이 모두 있었는가 */
  rowAmountsKnown: boolean;
  category: Category;
  outcome: ReconSourceRow['outcome'] | 'transaction';
}

const APPROVED: ReadonlySet<string> = new Set(['approved', 'auto_approved', 'exported', 'reconciled']);
const UNREVIEWED: ReadonlySet<string> = new Set(['imported', 'classified', 'needs_review']);
const UNKNOWN_EVIDENCE = 'unknown';
const UNCLASSIFIED = '미분류';

const TERM_LABEL: Record<ReconTerm, string> = { export: '전송', duplicate: '중복', excluded: '제외', failed: '실패', pending: '대기' };
const DIMS = [
  ['supplyAmount', '공급가액'],
  ['vatAmount', '부가세'],
  ['totalAmount', '합계'],
] as const;

function rowAmounts(rows: readonly ReconSourceRow[]): { amounts: Amounts; known: boolean } {
  const a: Amounts = { supplyAmount: 0, vatAmount: 0, totalAmount: 0 };
  let known = rows.length > 0;
  for (const r of rows) {
    for (const [k] of DIMS) {
      const v = r[k];
      if (typeof v === 'number' && Number.isFinite(v)) a[k] += v;
      else known = false;
    }
  }
  return { amounts: a, known };
}

function txAmounts(t: ReconTransaction): Amounts {
  return { supplyAmount: t.supplyAmount, vatAmount: t.vatAmount, totalAmount: t.totalAmount };
}

function sameAmounts(a: Amounts, b: Amounts): boolean {
  return a.supplyAmount === b.supplyAmount && a.vatAmount === b.vatAmount && a.totalAmount === b.totalAmount;
}

function diffText(actual: Amounts, expected: Amounts): string {
  return DIMS.filter(([k]) => actual[k] !== expected[k])
    .map(([k, label]) => `${label} ${formatWon(actual[k])} ≠ ${formatWon(expected[k])}, 차이 ${formatWon(Math.abs(actual[k] - expected[k]))}`)
    .join(' / ');
}

function totalsText(t: AmountTotals): string {
  return `${t.count}건 ${formatWon(t.totalAmount)}`;
}

function residualText(r: AmountTotals): string {
  const parts: string[] = [];
  if (r.count !== 0) parts.push(`건수 ${r.count > 0 ? '+' : ''}${r.count}건`);
  for (const [k, label] of DIMS) if (r[k] !== 0) parts.push(`${label} ${r[k] > 0 ? '+' : ''}${formatWon(r[k])}`);
  return parts.join(', ');
}

function subtract(a: AmountTotals, ...bs: AmountTotals[]): AmountTotals {
  const r = { ...a };
  for (const b of bs) {
    r.count -= b.count;
    r.supplyAmount -= b.supplyAmount;
    r.vatAmount -= b.vatAmount;
    r.totalAmount -= b.totalAmount;
  }
  return r;
}

const isZero = (t: AmountTotals) => t.count === 0 && t.supplyAmount === 0 && t.vatAmount === 0 && t.totalAmount === 0;

function rowLabel(rows: readonly ReconSourceRow[]): string {
  return rows.length ? `${rows.map((r) => r.rowNumber).join('·')}행` : '원본 행 없음';
}

/** "2026-09-12 ABC마트 32,500원" (알 수 있는 정보만) */
function describe(u: Unit): string {
  const r0 = u.rows[0];
  const date = u.tx?.transactionDate ?? r0?.date ?? null;
  const merchant = u.tx?.merchantName ?? r0?.merchantName ?? null;
  const parts = [date, merchant, formatWon(u.amounts.totalAmount)].filter((x): x is string => !!x);
  return date || merchant ? parts.join(' ') : `${rowLabel(u.rows)} ${formatWon(u.amounts.totalAmount)}`;
}

type Breakdown = Record<string, Partial<Record<ReconStage, AmountTotals>>>;
type TermBreakdown = Map<string, { source: AmountTotals; terms: AmountTotals }>;

function bump(map: Breakdown, key: string, stage: ReconStage, a: Amounts): void {
  const e = (map[key] ??= {});
  addToTotals((e[stage] ??= emptyTotals()), a);
}

function bumpTerm(map: TermBreakdown, key: string, side: 'source' | 'terms', a: Amounts): void {
  let e = map.get(key);
  if (!e) map.set(key, (e = { source: emptyTotals(), terms: emptyTotals() }));
  addToTotals(e[side], a);
}

// ═══════════════════════════════ 대사 ═══════════════════════════════

/**
 * 대사 등식 (수임처·기간·차원별, 1원도 허용하지 않음):
 *   원본 = 전송(또는 전송준비) + 중복 + 제외 + 실패 + 대기
 * - 전송 항은 전송파일 행 금액으로 계산한다 → 전송파일의 1원 차이도 잔차로 드러난다.
 * - 증빙유형별·계정별 소계도 각각 닫혀야 한다 (합계가 우연히 상쇄되는 경우 차단).
 * - exportAllowed = 균형 ∧ 검토 대기 0 ∧ 차단 사유 0 ∧ 전송 합계 = 승인 거래 합계
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const fileMode = input.exportRows !== undefined;
  const txById = new Map(input.transactions.map((t) => [t.id, t] as const));
  const discrepancies: ReconDiscrepancy[] = [];

  // ── 1. 원본 행 → 거래 단위 (여러 행이 한 거래로 묶인 경우 한 단위) ──
  const units: Unit[] = [];
  const groups = new Map<string, ReconSourceRow[]>();
  for (const row of input.source.rows) {
    if (row.outcome !== 'failed' && row.transactionId) {
      const g = groups.get(row.transactionId);
      if (g) g.push(row);
      else {
        const arr = [row];
        groups.set(row.transactionId, arr);
        units.push({ rows: arr, tx: null, amounts: { supplyAmount: 0, vatAmount: 0, totalAmount: 0 }, rowAmountsKnown: false, category: 'pending', outcome: row.outcome });
      }
    } else {
      units.push({ rows: [row], tx: null, amounts: { supplyAmount: 0, vatAmount: 0, totalAmount: 0 }, rowAmountsKnown: false, category: 'pending', outcome: row.outcome });
    }
  }
  // 원본 행이 없는 거래 (수기 입력 등) → 거래 자체를 원본으로 본다
  const linked = new Set(groups.keys());
  for (const t of input.transactions) {
    if (!linked.has(t.id)) units.push({ rows: [], tx: t, amounts: txAmounts(t), rowAmountsKnown: false, category: 'pending', outcome: 'transaction' });
  }

  // ── 2. 금액 확정 + 분류 ──
  const exportByTx = new Map<string, ReconExportRow[]>();
  for (const r of input.exportRows ?? []) {
    if (!r.transactionId) continue;
    const arr = exportByTx.get(r.transactionId);
    if (arr) arr.push(r);
    else exportByTx.set(r.transactionId, [r]);
  }

  for (const u of units) {
    if (u.outcome !== 'transaction') {
      const id = u.rows[0]!.transactionId;
      u.tx = u.outcome !== 'failed' && id ? txById.get(id) ?? null : null;
      const ra = rowAmounts(u.rows);
      u.rowAmountsKnown = ra.known;
      u.amounts = ra.known || !u.tx ? ra.amounts : txAmounts(u.tx);
    }
    const t = u.tx;
    if (u.outcome === 'failed' || t?.status === 'failed') u.category = 'failed';
    else if (u.outcome === 'duplicate' || t?.status === 'duplicate') u.category = 'duplicate';
    else if (!t) u.category = 'unexplained';
    else if (t.status === 'excluded') u.category = 'excluded';
    else if (fileMode) u.category = exportByTx.has(t.id) ? 'export' : 'pending';
    else u.category = APPROVED.has(t.status) ? 'export' : 'pending';
  }

  // ── 3. 등식 ──
  const terms: Record<ReconTerm, AmountTotals> = {
    export: emptyTotals(),
    duplicate: emptyTotals(),
    excluded: emptyTotals(),
    failed: emptyTotals(),
    pending: emptyTotals(),
  };
  const source = emptyTotals();
  const processed = emptyTotals();
  const expected = emptyTotals();
  const pendingReview = emptyTotals();
  const byEvidenceType: Breakdown = {};
  const byAccount: Breakdown = {};
  const evTerms: TermBreakdown = new Map();
  const accTerms: TermBreakdown = new Map();
  const accountNames: Record<string, string> = {};
  const evKey = (t: ReconTransaction | null) => (t ? String(t.evidenceType) : UNKNOWN_EVIDENCE);
  const accKey = (t: ReconTransaction | null) => t?.accountCode ?? UNCLASSIFIED;

  for (const u of units) {
    const ek = evKey(u.tx);
    const ak = accKey(u.tx);
    if (u.tx?.accountCode && u.tx.accountName) accountNames[u.tx.accountCode] = u.tx.accountName;
    addToTotals(source, u.amounts);
    bump(byEvidenceType, ek, 'source', u.amounts);
    bump(byAccount, ak, 'source', u.amounts);
    bumpTerm(evTerms, ek, 'source', u.amounts);
    bumpTerm(accTerms, ak, 'source', u.amounts);

    if (u.tx && u.category !== 'duplicate' && u.category !== 'failed') {
      addToTotals(processed, txAmounts(u.tx));
      bump(byEvidenceType, ek, 'processed', txAmounts(u.tx));
      bump(byAccount, ak, 'processed', txAmounts(u.tx));
    }
    if (u.tx && APPROVED.has(u.tx.status) && (u.category === 'export' || u.category === 'pending')) addToTotals(expected, txAmounts(u.tx));
    if (u.category === 'unexplained') continue;

    if (u.category === 'export') {
      if (!fileMode) {
        // 전송 전: 승인 거래 금액이 곧 전송될 금액
        const a = txAmounts(u.tx!);
        addToTotals(terms.export, a);
        bump(byEvidenceType, ek, 'export', a);
        bump(byAccount, ak, 'export', a);
        bumpTerm(evTerms, ek, 'terms', a);
        bumpTerm(accTerms, ak, 'terms', a);
      }
      continue; // 파일 모드는 아래에서 전송파일 행으로 계산
    }
    addToTotals(terms[u.category], u.amounts);
    bumpTerm(evTerms, ek, 'terms', u.amounts);
    bumpTerm(accTerms, ak, 'terms', u.amounts);
  }

  // 전송파일 행
  const unitByTx = new Map<string, Unit>();
  for (const u of units) if (u.tx && !unitByTx.has(u.tx.id)) unitByTx.set(u.tx.id, u);
  if (fileMode) {
    for (const r of input.exportRows!) {
      const u = r.transactionId ? unitByTx.get(r.transactionId) ?? null : null;
      const t = u?.tx ?? (r.transactionId ? txById.get(r.transactionId) ?? null : null);
      const ek = evKey(t);
      const ak = r.accountCode ?? accKey(t);
      addToTotals(terms.export, r);
      bump(byEvidenceType, ek, 'export', r);
      bump(byAccount, ak, 'export', r);
      bumpTerm(evTerms, ek, 'terms', r);
      bumpTerm(accTerms, ak, 'terms', r);
    }
  }

  const residual = subtract(source, terms.export, terms.duplicate, terms.excluded, terms.failed, terms.pending);

  // ── 4. 차이 설명 ──
  for (const u of units) {
    const t = u.tx;
    const base = { transactionId: t?.id, sourceRowNumber: u.rows[0]?.rowNumber, date: t?.transactionDate ?? u.rows[0]?.date ?? undefined, merchantName: t?.merchantName ?? u.rows[0]?.merchantName ?? undefined, amount: u.amounts.totalAmount };
    switch (u.category) {
      case 'duplicate': {
        const reason = t?.duplicateReason;
        discrepancies.push({ kind: 'duplicate_excluded', ...base, blocking: false, message: `${describe(u)} 거래가 중복판정으로 제외되었습니다.${reason ? ` 사유: ${reason}` : ''}` });
        break;
      }
      case 'excluded': {
        const reason = t?.excludedReason;
        discrepancies.push({ kind: 'user_excluded', ...base, blocking: false, message: `${describe(u)} 거래가 사용자에 의해 제외되었습니다.${reason ? ` 사유: ${reason}` : ' (제외 사유 미기재)'}` });
        break;
      }
      case 'failed': {
        const r0 = u.rows[0];
        const reason = r0?.errorReason?.trim() || '알 수 없는 오류로 수집 실패';
        const label = r0 ? `${rowLabel(u.rows)}: ` : `${describe(u)}: `;
        const tail = /실패/.test(reason) ? '' : ' (수집 실패)';
        const amt = u.rowAmountsKnown ? ` — 합계 ${formatWon(u.amounts.totalAmount)}` : '';
        discrepancies.push({ kind: 'parse_failed', ...base, blocking: true, message: `${label}${reason}${tail}${amt}` });
        break;
      }
      case 'unexplained':
        discrepancies.push({ kind: 'unexplained', ...base, blocking: true, message: `${rowLabel(u.rows)}: 원본 행에 연결된 거래를 찾을 수 없어 처리 결과를 확인할 수 없습니다.` });
        break;
      case 'pending':
        if (t && APPROVED.has(t.status) && fileMode) {
          discrepancies.push({
            kind: 'missing_in_export',
            ...base,
            blocking: true,
            message: t.status === 'approved' || t.status === 'auto_approved'
              ? `${describe(u)} 거래가 승인되었으나 전송파일에 없습니다.`
              : `${describe(u)} 거래가 전송완료 상태이나 이번 전송파일에 없습니다.`,
          });
        }
        if (t && UNREVIEWED.has(t.status)) addToTotals(pendingReview, txAmounts(t));
        break;
      default:
        break;
    }
    // 원본 행 금액 ≠ 처리된 거래 금액
    if (t && u.rowAmountsKnown && u.category !== 'failed' && !sameAmounts(u.amounts, txAmounts(t))) {
      discrepancies.push({ kind: 'amount_mismatch', ...base, blocking: true, message: `${describe(u)}: 원본 금액과 처리된 거래 금액이 다릅니다 (${diffText(u.amounts, txAmounts(t))}).` });
    }
  }

  if (pendingReview.count > 0) {
    discrepancies.push({
      kind: 'pending_review',
      amount: pendingReview.totalAmount,
      blocking: true,
      message: `검토 대기 ${pendingReview.count}건(합계 ${formatWon(pendingReview.totalAmount)})이 남아 있어 전송할 수 없습니다.`,
    });
  }

  let exportRowIssues = 0;
  if (fileMode) {
    const seenTx = new Map<string, number>();
    input.exportRows!.forEach((r, i) => {
      const rowNo = r.rowNumber ?? i + 1;
      const u = r.transactionId ? unitByTx.get(r.transactionId) ?? null : null;
      const push = (kind: ReconDiscrepancy['kind'], message: string) => {
        exportRowIssues++;
        discrepancies.push({ kind, transactionId: r.transactionId ?? undefined, date: u?.tx?.transactionDate, merchantName: u?.tx?.merchantName, amount: r.totalAmount, blocking: true, message });
      };
      if (!u || !u.tx) {
        push('extra_in_export', `전송파일 ${rowNo}행(합계 ${formatWon(r.totalAmount)})은 원본 자료에 없는 거래입니다.`);
        return;
      }
      const t = u.tx;
      const times = (seenTx.get(t.id) ?? 0) + 1;
      seenTx.set(t.id, times);
      if (times === 2) push('extra_in_export', `${describe(u)} 거래가 전송파일에 ${exportByTx.get(t.id)!.length}번 들어 있습니다.`);
      if (times > 1) return;
      if (u.category === 'duplicate' || u.category === 'excluded' || u.category === 'failed') {
        const st = u.category === 'duplicate' ? '중복판정' : u.category === 'excluded' ? '사용자 제외' : '수집 실패';
        push('extra_in_export', `${describe(u)} 거래는 ${st} 상태인데 전송파일에 포함되어 있습니다.`);
        return;
      }
      if (UNREVIEWED.has(t.status)) push('extra_in_export', `${describe(u)} 거래는 검토가 끝나지 않았는데 전송파일에 포함되어 있습니다.`);
      if (!sameAmounts(r, txAmounts(t))) {
        push('amount_mismatch', `${describe(u)}: 전송파일 금액이 거래 금액과 다릅니다 (${diffText(r, txAmounts(t))}).`);
      }
      if (r.accountCode && t.accountCode && r.accountCode !== t.accountCode) {
        push('unexplained', `${describe(u)}: 전송파일 계정(${r.accountCode})이 거래 계정(${t.accountCode}${t.accountName ? ` ${t.accountName}` : ''})과 다릅니다.`);
      }
    });
    if (!totalsEqual(terms.export, expected) && exportRowIssues === 0 && !discrepancies.some((d) => d.kind === 'missing_in_export')) {
      discrepancies.push({
        kind: 'amount_mismatch',
        amount: terms.export.totalAmount - expected.totalAmount,
        blocking: true,
        message: `전송파일 합계(${totalsText(terms.export)})가 승인 거래 합계(${totalsText(expected)})와 일치하지 않습니다 (${residualText(subtract(terms.export, expected))}). 1원 차이도 전송할 수 없습니다.`,
      });
    }
  }

  // 원 단위 정수 검사
  const nonInteger = [
    ...input.source.rows.flatMap((r) => [r.supplyAmount, r.vatAmount, r.totalAmount]),
    ...input.transactions.flatMap((t) => [t.supplyAmount, t.vatAmount, t.totalAmount]),
    ...(input.exportRows ?? []).flatMap((r) => [r.supplyAmount, r.vatAmount, r.totalAmount]),
  ].some((v) => typeof v === 'number' && !Number.isSafeInteger(v));
  if (nonInteger) discrepancies.push({ kind: 'unexplained', blocking: true, message: '원 단위 정수가 아닌 금액이 있어 1원 단위 대사를 할 수 없습니다.' });

  const totalBalanced = isZero(residual);
  if (!totalBalanced && !discrepancies.some((d) => d.blocking)) {
    discrepancies.push({ kind: 'unexplained', amount: residual.totalAmount, blocking: true, message: `원본과 처리 결과 사이에 설명되지 않는 차이가 있습니다 (${residualText(residual)}).` });
  }

  // 소계 검사 (합계가 상쇄되어 맞는 경우)
  let breakdownBalanced = true;
  const checkBreakdown = (map: TermBreakdown, label: (k: string) => string) => {
    for (const [k, e] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
      const r = subtract(e.source, e.terms);
      if (isZero(r)) continue;
      breakdownBalanced = false;
      if (totalBalanced) discrepancies.push({ kind: 'unexplained', blocking: true, message: `${label(k)} 소계가 맞지 않습니다 (${residualText(r)}).` });
    }
  };
  checkBreakdown(evTerms, (k) => `증빙유형 '${EVIDENCE_LABEL[k] ?? k}'`);
  checkBreakdown(accTerms, (k) => `계정 '${k}${accountNames[k] ? ` ${accountNames[k]}` : ''}'`);

  // ── 5. WEHAGO 역수입 대사 ──
  const stages: Partial<Record<ReconStage, AmountTotals>> = { source, processed, export: { ...terms.export } };
  if (input.wehagoRows) {
    const w = compareWehago(input, units, fileMode, byAccount);
    stages.wehago = w.totals;
    discrepancies.push(...w.discrepancies);
  }

  const balanced = totalBalanced && breakdownBalanced && !nonInteger;
  const blockingCount = discrepancies.filter((d) => d.blocking).length;
  const exportMatchesExpected = totalsEqual(terms.export, expected);
  const exportAllowed = balanced && pendingReview.count === 0 && blockingCount === 0 && exportMatchesExpected && expected.count > 0;

  const exportLabel = fileMode ? '전송' : '전송준비';
  const eq =
    `원본 ${totalsText(source)} = ${exportLabel} ${totalsText(terms.export)}` +
    (['duplicate', 'excluded', 'failed', 'pending'] as const).map((k) => ` + ${TERM_LABEL[k]} ${totalsText(terms[k])}`).join('');
  const verdict = totalBalanced ? '1원 단위까지 일치합니다' : `설명되지 않은 차이: ${residualText(residual)}`;
  let tail: string;
  if (exportAllowed) tail = '전송 가능합니다.';
  else if (expected.count === 0 && blockingCount === 0) tail = '전송할 승인 거래가 없습니다.';
  else tail = `전송할 수 없습니다 (차단 사유 ${blockingCount}건${pendingReview.count ? `, 검토 대기 ${pendingReview.count}건` : ''}).`;
  const summary = `[${input.scope.clientName} ${input.scope.period}] ${eq}. ${verdict}. ${tail}`;

  return {
    stages,
    byEvidenceType,
    byAccount,
    discrepancies,
    balanced,
    exportAllowed,
    summary,
    equation: { exportBasis: fileMode ? 'file' : 'ready', source, terms, residual },
    expected,
    pendingReview,
    accountNames,
  };
}

const EVIDENCE_LABEL: Record<string, string> = {
  tax_invoice: '세금계산서',
  invoice_exempt: '계산서',
  card: '카드',
  cash_receipt: '현금영수증',
  bank: '통장',
  other: '기타',
  unknown: '미상',
};

interface WehagoCompare {
  totals: AmountTotals;
  discrepancies: ReconDiscrepancy[];
}

/**
 * 전송분 ↔ WEHAGO 역수입 비교. 1차: 일자+합계+상호(정규화), 2차: 일자+합계 (거래처명 표기가 다른 경우).
 * 누락은 차단, WEHAGO 에만 있는 전표는 알림(WEHAGO 가 직접 수집한 전표일 수 있음).
 */
function compareWehago(input: ReconcileInput, units: readonly Unit[], fileMode: boolean, byAccount: Breakdown): WehagoCompare {
  const rows = input.wehagoRows!;
  const totals = emptyTotals();
  for (const r of rows) {
    addToTotals(totals, r);
    if (r.accountCode) bump(byAccount, r.accountCode, 'wehago', r);
  }

  // 비교 기준 = 전송파일 행 (전송 전이면 전송준비 거래)
  interface Item { date: string; merchantName: string; a: Amounts; accountCode: string | null; transactionId?: string }
  const unitByTx = new Map(units.filter((u) => u.tx).map((u) => [u.tx!.id, u] as const));
  const items: Item[] = fileMode
    ? input.exportRows!.map((r) => {
        const t = r.transactionId ? unitByTx.get(r.transactionId)?.tx ?? null : null;
        return { date: t?.transactionDate ?? '', merchantName: t?.merchantName ?? '', a: r, accountCode: r.accountCode ?? t?.accountCode ?? null, transactionId: r.transactionId ?? undefined };
      })
    : units
        .filter((u) => u.category === 'export' && u.tx)
        .map((u) => ({ date: u.tx!.transactionDate, merchantName: u.tx!.merchantName, a: txAmounts(u.tx!), accountCode: u.tx!.accountCode, transactionId: u.tx!.id }));

  const used = new Array<boolean>(rows.length).fill(false);
  const k1 = new Map<string, number[]>();
  const k2 = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const a = `${r.date}|${r.totalAmount}`;
    const b = `${a}|${normalizeMerchantName(r.merchantName)}`;
    (k1.get(b) ?? k1.set(b, []).get(b)!).push(i);
    (k2.get(a) ?? k2.set(a, []).get(a)!).push(i);
  });
  const take = (list: number[] | undefined): number | null => {
    if (!list) return null;
    for (const i of list) {
      if (!used[i]) {
        used[i] = true;
        return i;
      }
    }
    return null;
  };

  const out: ReconDiscrepancy[] = [];
  const label = (date: string, m: string, total: Won) => [date, m, formatWon(total)].filter(Boolean).join(' ');
  for (const it of items) {
    const a = `${it.date}|${it.a.totalAmount}`;
    const idx = take(k1.get(`${a}|${normalizeMerchantName(it.merchantName)}`)) ?? take(k2.get(a));
    const base = { transactionId: it.transactionId, date: it.date || undefined, merchantName: it.merchantName || undefined, amount: it.a.totalAmount };
    if (idx === null) {
      out.push({ kind: 'missing_in_wehago', ...base, blocking: true, message: `${label(it.date, it.merchantName, it.a.totalAmount)} 거래가 WEHAGO에 반영되지 않았습니다.` });
      continue;
    }
    const w = rows[idx]!;
    if (!sameAmounts(w, it.a)) {
      out.push({ kind: 'amount_mismatch', ...base, blocking: true, message: `${label(it.date, it.merchantName, it.a.totalAmount)}: WEHAGO 금액이 전송 금액과 다릅니다 (${diffText(w, it.a)}).` });
    }
    if (w.accountCode && it.accountCode && w.accountCode !== it.accountCode) {
      out.push({ kind: 'unexplained', ...base, blocking: true, message: `${label(it.date, it.merchantName, it.a.totalAmount)}: WEHAGO 계정(${w.accountCode})이 전송 계정(${it.accountCode})과 다릅니다.` });
    }
  }
  rows.forEach((r, i) => {
    if (used[i]) return;
    out.push({
      kind: 'extra_in_wehago',
      date: r.date,
      merchantName: r.merchantName,
      amount: r.totalAmount,
      blocking: false,
      message: `WEHAGO에만 있는 전표입니다: ${label(r.date, r.merchantName, r.totalAmount)} (WEHAGO에서 직접 입력·수집한 전표인지 확인하세요).`,
    });
  });
  return { totals, discrepancies: out };
}
