/**
 * WEHAGO 전송파일 준비 — 사전검증 → 파일 생성 → 재검증(1원 게이트) → 파일 기준 대사 → 저장.
 *
 * WEHAGO 전표 API 는 없다(NOT_AVAILABLE) → 엑셀 파일을 만들고 사람이 [엑셀서식 불러오기]로 올린다(FILE_BASED).
 * 1원이라도 차이가 나면 status 'ready' 가 되지 않는다 (차단 사유와 함께 blocked).
 * 거래 상태는 파일 생성만으로 바꾸지 않는다 (approved 유지, export_job_id 연결) → 업로드 확인 시 exported.
 */
import { and, desc, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { formatWon } from '@mintax/core';
import { DEFAULT_ACCOUNT_CODES } from '@mintax/core/engine/classify-index';
import { DEFAULT_VAT_RULES } from '@mintax/core/engine/vat-risk-index';
import {
  computeExportTotals,
  readTemplateWorkbook,
  validateExportRows,
  verifyExportFile,
  writeWehagoExport,
  isAdapterError,
  type ExportRow,
  type ParsedTemplateFile,
} from '@mintax/adapters';
import { accountCodes, exportItems, exportJobs, reconciliationJobs, transactions, type DbOrTx } from '@mintax/db';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { loadClientProfile } from '../infra/clients';
import { notifyProblem, resolveProblem } from '../infra/notify';
import { storeFile } from '../infra/storage';
import { executeReconciliation, lockClientPeriod, type ExecutedRecon } from '../reconciliation/run';
import {
  APPROVED_STATUSES,
  EVIDENCE_LABELS,
  EXPORT_KIND_LABELS,
  TEMPLATES_HREF,
  WEHAGO_FILE_NOTE,
  XLSX_MIME,
  addTotals,
  assertKind,
  assertPeriod,
  assertUuid,
  blockedReasonText,
  blockedSummary,
  checkCandidates,
  chunk,
  emptyTotalsDTO,
  exportFileName,
  importsHref,
  inboxHref,
  parseExportScope,
  reasonsFromAdapterIssues,
  reconciliationHref,
  routeForExport,
  scopeWarning,
  totalsMatch,
  totalsText,
  transferHref,
  warningsFromAdapterIssues,
  wehagoDuplicateGroups,
  type CandidateTx,
  type ExportScope,
} from './helpers';
import { validationOf, type ExportValidationJson } from './dto';
import { loadPartnerStore } from './partner-codes';
import { loadActiveTemplate, templateInfo, templateWarning, type ActiveTemplate } from './templates';
import type {
  ClientExportsResult,
  ComparisonRowDTO,
  ExportBlockReason,
  ExportComparisonDTO,
  PrepareExportBlocked,
  PrepareExportReady,
  PrepareExportResult,
  TotalsDTO,
  WehagoExportKind,
} from './types';

type ClientProfile = Awaited<ReturnType<typeof loadClientProfile>>;

const ITEM_CHUNK = 1000;
const TX_UPDATE_CHUNK = 1000;

// ────────────────────────────── 적재 ──────────────────────────────

export async function loadCandidates(db: DbOrTx, clientId: string, period: string, excludedEvidenceTypes: readonly string[]): Promise<CandidateTx[]> {
  const conds = [eq(transactions.clientId, clientId), eq(transactions.period, period), inArray(transactions.status, [...APPROVED_STATUSES])];
  if (excludedEvidenceTypes.length > 0) conds.push(notInArray(transactions.evidenceType, [...excludedEvidenceTypes]));
  const rows = await db
    .select({
      id: transactions.id,
      status: transactions.status,
      direction: transactions.direction,
      transactionDate: transactions.transactionDate,
      evidenceType: transactions.evidenceType,
      merchantName: transactions.merchantName,
      merchantBusinessNumber: transactions.merchantBusinessNumber,
      description: transactions.description,
      supplyAmount: transactions.supplyAmount,
      vatAmount: transactions.vatAmount,
      serviceCharge: transactions.serviceCharge,
      totalAmount: transactions.totalAmount,
      accountCode: transactions.accountCode,
      accountName: transactions.accountName,
      vatType: transactions.vatType,
      deductible: transactions.deductible,
      vatReasonCode: transactions.vatReasonCode,
      approvalNumber: transactions.approvalNumber,
      cardCompany: sql<string | null>`${transactions.rawData} ->> '카드사'`,
      exportJobId: transactions.exportJobId,
    })
    .from(transactions)
    .where(and(...conds))
    .orderBy(transactions.transactionDate, transactions.id);
  return rows;
}

/** 사용 가능한 계정코드 (DB 계정표가 비어 있으면 core 기본표) */
export async function loadAccountMap(db: DbOrTx): Promise<Map<string, string>> {
  const rows = await db.select({ code: accountCodes.code, name: accountCodes.name, active: accountCodes.active }).from(accountCodes);
  if (rows.length === 0) return new Map(DEFAULT_ACCOUNT_CODES.filter((a) => a.active).map((a) => [a.code, a.name] as const));
  return new Map(rows.filter((r) => r.active).map((r) => [r.code, r.name] as const));
}

const VAT_RULE_NAMES = new Map(DEFAULT_VAT_RULES.map((r) => [r.code, r.name] as const));

// ────────────────────────────── 파일 → 전송 항목 ──────────────────────────────

export interface ExportItemDraft {
  transactionId: string;
  rowNumber: number;
  supplyAmount: number;
  vatAmount: number;
  totalAmount: number;
  accountCode: string | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v).trim());

/**
 * 생성 파일을 다시 읽은 값으로 거래별 전송 항목을 만든다 (export_items = 파일에 실제로 들어간 금액).
 * 매입매출: 데이터 행 셀 값 / 일반전표: 추적 시트 금액(재검증에서 차변·대변 합과 대조됨) + 주 계정
 */
export function itemsFromParsedFile(parsed: ParsedTemplateFile, rows: readonly ExportRow[], kind: WehagoExportKind): ExportItemDraft[] {
  const byRow = new Map(parsed.dataRows.map((d) => [d.excelRow, d] as const));
  const byId = new Map(rows.map((r) => [r.transactionId, r] as const));
  const out: ExportItemDraft[] = [];
  if (parsed.trace) {
    for (const e of parsed.trace.entries) {
      const src = byId.get(e.id);
      if (kind === 'wehago_purchase_sales') {
        let s = 0;
        let v = 0;
        let t = 0;
        let account: string | null = null;
        for (let rn = e.firstRow; rn <= e.lastRow; rn++) {
          const d = byRow.get(rn);
          if (!d) continue;
          s += num(d.values.supplyAmount);
          v += num(d.values.vatAmount);
          t += num(d.values.totalAmount);
          account ??= text(d.values.accountCode);
        }
        out.push({ transactionId: e.id, rowNumber: e.firstRow, supplyAmount: s, vatAmount: v, totalAmount: t, accountCode: account ?? src?.accountCode ?? null });
      } else {
        const [s = 0, v = 0, t = 0] = e.amounts;
        out.push({ transactionId: e.id, rowNumber: e.firstRow, supplyAmount: s, vatAmount: v, totalAmount: t, accountCode: src?.accountCode ?? null });
      }
    }
    return out;
  }
  // 추적 시트가 없는 서식(현재 없음): 매입매출만 행 순서로 대응
  if (kind === 'wehago_purchase_sales' && parsed.dataRows.length === rows.length) {
    parsed.dataRows.forEach((d, i) => {
      out.push({
        transactionId: rows[i]!.transactionId,
        rowNumber: d.excelRow,
        supplyAmount: num(d.values.supplyAmount),
        vatAmount: num(d.values.vatAmount),
        totalAmount: num(d.values.totalAmount),
        accountCode: text(d.values.accountCode),
      });
    });
  }
  return out;
}

/** Source(DB 승인 거래) vs Export(파일 재읽기) — 건수·공급가액·부가세·합계, 증빙유형별·계정별 */
export function buildComparison(rows: readonly ExportRow[], items: readonly ExportItemDraft[], accountNames: ReadonlyMap<string, string>, verifySummary: string): ExportComparisonDTO {
  const source = emptyTotalsDTO();
  const exp = emptyTotalsDTO();
  const ev = new Map<string, { source: TotalsDTO; export: TotalsDTO }>();
  const acc = new Map<string, { source: TotalsDTO; export: TotalsDTO }>();
  const slot = (m: Map<string, { source: TotalsDTO; export: TotalsDTO }>, k: string) => {
    let e = m.get(k);
    if (!e) m.set(k, (e = { source: emptyTotalsDTO(), export: emptyTotalsDTO() }));
    return e;
  };
  const byId = new Map(rows.map((r) => [r.transactionId, r] as const));
  for (const r of rows) {
    addTotals(source, r);
    addTotals(slot(ev, r.evidenceType).source, r);
    addTotals(slot(acc, r.accountCode).source, r);
  }
  for (const i of items) {
    addTotals(exp, i);
    addTotals(slot(ev, byId.get(i.transactionId)?.evidenceType ?? 'unknown').export, i);
    addTotals(slot(acc, i.accountCode ?? '미분류').export, i);
  }
  const toRows = (m: Map<string, { source: TotalsDTO; export: TotalsDTO }>, label: (k: string) => string): ComparisonRowDTO[] =>
    [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => ({ key: k, label: label(k), source: v.source, export: v.export, match: totalsMatch(v.source, v.export) }));
  const byEvidenceType = toRows(ev, (k) => EVIDENCE_LABELS[k] ?? k);
  const byAccount = toRows(acc, (k) => (accountNames.get(k) ? `${k} ${accountNames.get(k)}` : k));
  const match = totalsMatch(source, exp) && byEvidenceType.every((r) => r.match) && byAccount.every((r) => r.match);
  return { source, export: exp, match, byEvidenceType, byAccount, verifySummary };
}

function comparisonDiffText(c: ExportComparisonDTO): string {
  const parts: string[] = [];
  const dims: Array<[keyof TotalsDTO, string]> = [
    ['count', '건수'],
    ['supplyAmount', '공급가액'],
    ['vatAmount', '부가세'],
    ['totalAmount', '합계'],
  ];
  for (const [k, l] of dims) {
    const d = c.export[k] - c.source[k];
    if (d !== 0) parts.push(`${l} ${k === 'count' ? `${d > 0 ? '+' : ''}${d}건` : `${d > 0 ? '+' : ''}${formatWon(d)}`}`);
  }
  if (parts.length === 0) {
    const bad = [...c.byEvidenceType, ...c.byAccount].find((r) => !r.match);
    if (bad) parts.push(`${bad.label} 소계 불일치`);
  }
  return parts.join(', ');
}

// ────────────────────────────── 차단 ──────────────────────────────

function readyReconReasons(pre: ExecutedRecon, clientId: string, period: string): ExportBlockReason[] {
  const out: ExportBlockReason[] = [];
  const pending = pre.result.pendingReview.count;
  if (pending > 0) {
    out.push({
      code: 'pending_review',
      message: `검토 대기 ${pending}건이 남아 있습니다.`,
      count: pending,
      href: inboxHref(clientId, period),
      actionLabel: `${pending}건 검토하기`,
    });
  }
  const failed = pre.discrepancies.filter((d) => d.blocking && d.kind === 'parse_failed');
  if (failed.length > 0) {
    out.push({
      code: 'parse_failed',
      message: `수집 실패 행 ${failed.length}건이 해소되지 않아 전송할 수 없습니다 (예: ${failed[0]!.message}).`,
      count: failed.length,
      href: importsHref(clientId, period, 'failed'),
      actionLabel: '실패 행 보기',
    });
  }
  const other = pre.discrepancies.filter((d) => d.blocking && d.kind !== 'parse_failed' && d.kind !== 'pending_review');
  if (other.length > 0) {
    out.push({
      code: 'recon_mismatch',
      message: `대사 불일치 ${other.length}건 (예: ${other[0]!.message})`,
      count: other.length,
      href: reconciliationHref(pre.id),
      actionLabel: '차이 보기',
      transactionIds: other.map((d) => d.transactionId).filter((x): x is string => !!x).slice(0, 50),
    });
  }
  return out;
}

/** 검토 대기·자동분류 대기만으로 막힌 경우는 정상 흐름이라 알림을 만들지 않는다 (문제 알림만) */
const NON_PROBLEM_CODES = new Set(['pending_review', 'empty']);

interface PrepCtx {
  ctx: ServiceContext;
  client: ClientProfile;
  period: string;
  kind: WehagoExportKind;
  active: ActiveTemplate;
  scope: ExportScope;
  warnings: string[];
  pre: ExecutedRecon;
}

async function persistBlocked(p: PrepCtx, reasons: ExportBlockReason[], opts: { existingJobId?: string | null; fileRecId?: string | null; totals?: TotalsDTO; extra?: Partial<ExportValidationJson> } = {}): Promise<PrepareExportBlocked> {
  const { ctx, client, period, kind, active } = p;
  const validation: ExportValidationJson = {
    attempt: 'prepare',
    template: { key: active.template.key, version: active.template.version, name: active.template.name, status: active.template.status, verified: active.template.verified, source: active.source, headerHash: active.headerHash },
    reasons,
    warnings: p.warnings,
    preReconciliationId: p.pre.id,
    reconciliationId: opts.fileRecId ?? null,
    scope: { excludedEvidenceTypes: p.scope.excludedEvidenceTypes, configured: p.scope.configured },
    ...opts.extra,
  };
  const blockedReason = blockedReasonText(reasons);
  const totals = opts.totals ?? emptyTotalsDTO();
  let jobId = opts.existingJobId ?? null;
  if (!jobId) {
    // 직전 시도가 파일 없는 차단이면 그 행을 갱신한다 (차단 시도마다 행이 쌓이지 않게 — 시도 이력은 감사로그에 남음)
    const [latest] = await ctx.db
      .select({ id: exportJobs.id, status: exportJobs.status, fileId: exportJobs.fileId })
      .from(exportJobs)
      .where(and(eq(exportJobs.clientId, client.id), eq(exportJobs.period, period), eq(exportJobs.kind, kind)))
      .orderBy(desc(exportJobs.createdAt))
      .limit(1);
    if (latest && latest.status === 'blocked' && !latest.fileId) jobId = latest.id;
  }
  const values = {
    status: 'blocked',
    templateKey: active.template.key,
    templateVersion: active.template.version,
    validation: validation as Record<string, unknown>,
    blockedReason,
    rowCount: totals.count,
    supplyAmount: totals.supplyAmount,
    vatAmount: totals.vatAmount,
    totalAmount: totals.totalAmount,
  };
  if (jobId) {
    await ctx.db.update(exportJobs).set({ ...values, createdBy: ctx.actor.userId, createdAt: sql`clock_timestamp()` }).where(eq(exportJobs.id, jobId));
  } else {
    const [row] = await ctx.db
      .insert(exportJobs)
      .values({ clientId: client.id, period, kind, ...values, createdBy: ctx.actor.userId, createdAt: sql`clock_timestamp()` })
      .returning({ id: exportJobs.id });
    jobId = row!.id;
  }
  await ctx.db.update(reconciliationJobs).set({ exportJobId: jobId }).where(eq(reconciliationJobs.id, p.pre.id));

  const summary = blockedSummary(client.name, period, kind, reasons);
  if (reasons.some((r) => !NON_PROBLEM_CODES.has(r.code))) {
    await notifyProblem(ctx, {
      kind: 'export_error',
      severity: reasons.some((r) => r.code === 'verify_failed' || r.code === 'recon_file_mismatch') ? 'high' : 'warning',
      title: `${client.name} ${period} WEHAGO ${EXPORT_KIND_LABELS[kind]} 전송 차단`,
      body: reasons.map((r) => `• ${r.message}`).join('\n'),
      href: transferHref(client.id, period),
      clientId: client.id,
      dedupeKey: `export_blocked:${client.id}:${period}:${kind}`,
    });
  }
  await writeAudit(ctx, {
    action: 'export.blocked',
    category: 'data_change',
    entityType: 'export_job',
    entityId: jobId,
    clientId: client.id,
    summary,
    before: null,
    after: { status: 'blocked', kind, reasons: reasons.map((r) => ({ code: r.code, count: r.count })) },
  });
  return {
    status: 'blocked',
    clientId: client.id,
    clientName: client.name,
    period,
    kind,
    exportJobId: jobId,
    reasons,
    warnings: p.warnings,
    preReconciliationId: p.pre.id,
    reconciliationId: opts.fileRecId ?? null,
    summary,
  };
}

// ────────────────────────────── 본체 ──────────────────────────────

async function prepareLocked(ctx: ServiceContext, client: ClientProfile, period: string, kind: WehagoExportKind): Promise<PrepareExportResult> {
  const active = await loadActiveTemplate(ctx, kind);
  const ps = kind === 'wehago_purchase_sales' ? active : await loadActiveTemplate(ctx, 'wehago_purchase_sales');
  const scope = parseExportScope(client.ruleParams);
  const warnings: string[] = [];
  const tw = templateWarning(active);
  if (tw) warnings.push(tw);
  if (active.template.status === 'mock') warnings.push('개발용(MOCK) 서식입니다 — 이 파일은 WEHAGO에 올리면 안 됩니다.');

  // 1) 전송 전 대사 — 기간 전체 (검토 대기·수집 실패·설명 안 되는 차이)
  const pre = await executeReconciliation(ctx, { clientId: client.id, period, phase: 'pre_export', mode: 'ready' });
  const p: PrepCtx = { ctx, client, period, kind, active, scope, warnings, pre };
  const reasons: ExportBlockReason[] = readyReconReasons(pre, client.id, period);
  if (active.errors.length > 0) {
    reasons.push({ code: 'template_invalid', message: `등록된 WEHAGO 서식에 오류가 있습니다: ${active.errors.join(' / ')}`, count: active.errors.length, href: TEMPLATES_HREF, actionLabel: '서식 다시 등록' });
  }

  // 2) 후보 거래 사전검증
  const cands = await loadCandidates(ctx.db, client.id, period, scope.excludedEvidenceTypes);
  const accounts = await loadAccountMap(ctx.db);
  const partners = await loadPartnerStore(ctx, client.id);
  const check = checkCandidates(cands, {
    kind,
    clientId: client.id,
    period,
    template: active.template,
    psTemplate: ps.template,
    accounts,
    partners,
    vatReasonName: (code) => VAT_RULE_NAMES.get(code) ?? null,
  });
  reasons.push(...check.reasons);
  if (check.inKind.length === 0 && check.reasons.length === 0) {
    reasons.push({
      code: 'empty',
      message: `전송할 승인 거래가 없습니다 (WEHAGO ${EXPORT_KIND_LABELS[kind]}).`,
      count: 0,
      href: inboxHref(client.id, period),
      actionLabel: '거래 보기',
    });
  }
  if (check.otherKind.length > 0) {
    const other = kind === 'wehago_purchase_sales' ? 'wehago_general_journal' : 'wehago_purchase_sales';
    warnings.push(`${EXPORT_KIND_LABELS[other]} 대상 ${check.otherKind.length}건은 이 파일에 포함되지 않았습니다 — ${EXPORT_KIND_LABELS[other]} 파일도 생성하세요.`);
  }
  if (scope.excludedEvidenceTypes.length > 0) {
    warnings.push(`전송 범위가 "WEHAGO 수집"인 원천(${scope.excludedEvidenceTypes.map((e) => EVIDENCE_LABELS[e] ?? e).join(', ')})은 파일에서 제외했습니다 — WEHAGO 역수입 대사로 확인하세요.`);
  }
  const sw = scopeWarning(scope, check.inKind.map((t) => t.evidenceType));
  if (sw) warnings.push(sw);
  if (reasons.length > 0) return persistBlocked(p, reasons);

  // 3) 어댑터 사전검증 (서식 규칙: 유형코드별 세액 규칙, 거래처코드, 사업자번호, 기간 등)
  const rows = check.rows;
  const v = validateExportRows(active.template, rows, { period });
  if (!v.ok) return persistBlocked(p, reasonsFromAdapterIssues(v.errors, client.id, period));
  warnings.push(...warningsFromAdapterIssues(v.warnings));
  const dups = wehagoDuplicateGroups(rows);
  if (dups.length > 0) {
    warnings.push(
      `WEHAGO 중복전표 기준(일자·사업자번호·금액·과세유형)이 같은 거래 ${dups.length}묶음 — WEHAGO가 중복으로 표시할 수 있습니다: ${dups
        .slice(0, 3)
        .map((d) => `${d.label} ${d.ids.length}건`)
        .join(', ')}${dups.length > 3 ? ' 외' : ''}. 서로 다른 거래가 맞는지 확인하세요.`,
    );
  }

  // 4) 파일 생성 + 재검증 (다시 읽어 1원 단위 비교)
  const expected = computeExportTotals(rows);
  let buffer: Buffer;
  try {
    buffer = await writeWehagoExport(active.template, rows, { period, generatedAt: ctx.now() });
  } catch (e) {
    if (isAdapterError(e)) {
      const errs = (e.details?.errors as Parameters<typeof reasonsFromAdapterIssues>[0] | undefined) ?? [];
      return persistBlocked(p, errs.length ? reasonsFromAdapterIssues(errs, client.id, period) : [{ code: 'write_failed', message: e.message, count: 1, href: null, actionLabel: null }]);
    }
    throw e;
  }
  const verify = await verifyExportFile(buffer, active.template, expected);
  const verifyJson = { ok: verify.ok, summary: verify.summary, traceFound: verify.traceFound, diffs: verify.diffs.slice(0, 100).map((d) => ({ code: d.code, message: d.message, blocking: d.blocking })) };
  const expectedTotals: TotalsDTO = { count: expected.count, supplyAmount: expected.supplyAmount, vatAmount: expected.vatAmount, totalAmount: expected.totalAmount };
  if (!verify.ok) {
    const blocking = verify.diffs.filter((d) => d.blocking);
    return persistBlocked(
      p,
      [
        {
          code: 'verify_failed',
          message: `생성 파일 재검증 실패 — 1원 차이도 전송하지 않습니다: ${blocking[0]?.message ?? verify.summary}${blocking.length > 1 ? ` 외 ${blocking.length - 1}건` : ''}`,
          count: blocking.length,
          href: transferHref(client.id, period),
          actionLabel: '전송센터',
          transactionIds: blocking.map((d) => d.transactionId).filter((x): x is string => !!x).slice(0, 50),
        },
      ],
      { totals: expectedTotals, extra: { verify: verifyJson } },
    );
  }
  for (const d of verify.diffs) if (!d.blocking) warnings.push(d.message);

  // 5) 파일 재읽기 → 전송 항목 + Source vs Export 비교
  const parsed = await readTemplateWorkbook(buffer, active.template);
  const items = itemsFromParsedFile(parsed, rows, kind);
  const comparison = buildComparison(rows, items, accounts, verify.summary);
  if (!comparison.match || items.length !== rows.length) {
    return persistBlocked(
      p,
      [
        {
          code: 'verify_failed',
          message: `생성 파일을 다시 읽은 합계가 승인 거래와 다릅니다 (${comparisonDiffText(comparison) || `항목 ${items.length}/${rows.length}건`}) — 1원 차이도 전송하지 않습니다.`,
          count: 1,
          href: transferHref(client.id, period),
          actionLabel: '전송센터',
        },
      ],
      { totals: expectedTotals, extra: { verify: verifyJson, comparison } },
    );
  }

  // 6) 전송파일 행 (validating) + 항목 저장
  const [{ n: prevFiles } = { n: 0 }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(exportJobs)
    .where(and(eq(exportJobs.clientId, client.id), eq(exportJobs.period, period), eq(exportJobs.kind, kind), isNotNull(exportJobs.fileId)));
  const version = Number(prevFiles) + 1;
  const fileName = exportFileName(client, period, kind, version);
  const tinfo = templateInfo(active);
  const baseValidation: ExportValidationJson = {
    attempt: 'prepare',
    version,
    fileName,
    fileRowCount: v.fileRowCount,
    template: { key: active.template.key, version: active.template.version, name: active.template.name, status: active.template.status, verified: active.template.verified, source: active.source, headerHash: active.headerHash },
    comparison,
    verify: verifyJson,
    warnings,
    preReconciliationId: pre.id,
    scope: { excludedEvidenceTypes: scope.excludedEvidenceTypes, configured: scope.configured },
    otherKindCount: check.otherKind.length,
  };
  const [job] = await ctx.db
    .insert(exportJobs)
    .values({
      clientId: client.id,
      period,
      kind,
      templateKey: active.template.key,
      templateVersion: active.template.version,
      status: 'validating',
      validation: baseValidation as Record<string, unknown>,
      rowCount: comparison.export.count,
      supplyAmount: comparison.export.supplyAmount,
      vatAmount: comparison.export.vatAmount,
      totalAmount: comparison.export.totalAmount,
      createdBy: ctx.actor.userId,
      createdAt: sql`clock_timestamp()`, // 같은 트랜잭션 안에서도 순서가 보이도록 (버전·최신 판정)
    })
    .returning({ id: exportJobs.id });
  const jobId = job!.id;
  for (const part of chunk(items, ITEM_CHUNK)) {
    await ctx.db.insert(exportItems).values(part.map((i) => ({ exportJobId: jobId, ...i })));
  }

  // 7) 파일 기준 대사 (이 전표 종류 범위) — export_items 를 DB 에서 다시 읽어 원본 등식을 1원 단위로 닫는다
  const fileRec = await executeReconciliation(ctx, { clientId: client.id, period, phase: 'pre_export', mode: 'file', exportJobIds: [jobId], exportJobId: jobId, scopeKind: kind });
  if (!fileRec.exportAllowed) {
    const blocking = fileRec.discrepancies.filter((d) => d.blocking);
    return persistBlocked(
      p,
      [
        {
          code: 'recon_file_mismatch',
          message: `전송파일 대사 불일치 ${blocking.length}건 (예: ${blocking[0]?.message ?? fileRec.result.summary})`,
          count: blocking.length,
          href: reconciliationHref(fileRec.id),
          actionLabel: '차이 보기',
        },
      ],
      { existingJobId: jobId, fileRecId: fileRec.id, totals: comparison.export, extra: { ...baseValidation, reconciliationId: fileRec.id } },
    );
  }

  // 8) 파일 저장 (암호화) + 준비 완료
  const stored = await storeFile(ctx, { data: buffer, originalName: fileName, mimeType: XLSX_MIME, purpose: 'wehago_export', clientId: client.id });

  // 이전 버전 처리 (docs/03 §8.3): 받지 않은 파일은 무효, 받은/올린 파일은 경고
  const prev = await ctx.db
    .select()
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.clientId, client.id),
        eq(exportJobs.period, period),
        eq(exportJobs.kind, kind),
        ne(exportJobs.id, jobId),
        isNotNull(exportJobs.fileId),
        inArray(exportJobs.status, ['ready', 'downloaded', 'uploaded_confirmed']),
        sql`not (${exportJobs.validation} ? 'supersededBy')`,
      ),
    );
  const superseded: string[] = [];
  for (const old of prev) {
    const ov = validationOf(old).version ?? 0;
    superseded.push(old.id);
    const mark = sql`${exportJobs.validation} || ${JSON.stringify({ supersededBy: jobId })}::jsonb`;
    if (old.status === 'ready') {
      await ctx.db
        .update(exportJobs)
        .set({ status: 'blocked', blockedReason: `새 버전 v${version}로 대체되었습니다 — v${version} 파일을 받으세요.`, validation: mark })
        .where(eq(exportJobs.id, old.id));
    } else {
      await ctx.db.update(exportJobs).set({ validation: mark }).where(eq(exportJobs.id, old.id));
      warnings.push(
        old.status === 'uploaded_confirmed'
          ? `v${ov} 파일은 WEHAGO 업로드가 확인되었습니다 (${old.rowCount}건 · 합계 ${formatWon(old.totalAmount)}). 새 파일을 올리기 전에 WEHAGO에서 v${ov} 전표를 반드시 삭제하세요 — 삭제하지 않으면 이중 기장됩니다.`
          : `v${ov} 파일을 이미 받았습니다. WEHAGO에 올렸다면 새 파일을 올리기 전에 v${ov} 전표를 지워야 합니다.`,
      );
    }
  }

  const finalValidation: ExportValidationJson = { ...baseValidation, fileSha256: stored.sha256, warnings, reconciliationId: fileRec.id, supersedes: superseded };
  await ctx.db.update(exportJobs).set({ status: 'ready', fileId: stored.id, validation: finalValidation as Record<string, unknown>, blockedReason: null }).where(eq(exportJobs.id, jobId));
  const ids = rows.map((r) => r.transactionId);
  for (const part of chunk(ids, TX_UPDATE_CHUNK)) {
    await ctx.db.update(transactions).set({ exportJobId: jobId }).where(inArray(transactions.id, part));
  }
  await ctx.db.update(reconciliationJobs).set({ exportJobId: jobId }).where(eq(reconciliationJobs.id, pre.id));
  await resolveProblem(ctx, `export_blocked:${client.id}:${period}:${kind}`);

  const summary = `${client.name} ${period} WEHAGO ${EXPORT_KIND_LABELS[kind]} 전송파일 v${version} 생성: ${totalsText(comparison.export)} (재검증 1원 단위 일치${active.template.verified ? '' : ' · 미검증 서식'})`;
  await writeAudit(ctx, {
    action: 'export.create',
    category: 'data_change',
    entityType: 'export_job',
    entityId: jobId,
    clientId: client.id,
    summary,
    before: superseded.length ? { supersededExportIds: superseded } : null,
    after: { status: 'ready', kind, version, fileName, totals: comparison.export, templateKey: active.template.key, templateVersion: active.template.version, templateVerified: active.template.verified },
  });

  const result: PrepareExportReady = {
    status: 'ready',
    clientId: client.id,
    clientName: client.name,
    period,
    kind,
    exportJobId: jobId,
    version,
    fileName,
    rowCount: comparison.export.count,
    fileRowCount: v.fileRowCount,
    totals: comparison.export,
    comparison,
    template: tinfo,
    warnings,
    preReconciliationId: pre.id,
    reconciliationId: fileRec.id,
    supersededExportIds: superseded,
    integrationStatus: 'FILE_BASED',
    nextStep: `${WEHAGO_FILE_NOTE} 올린 뒤 [업로드 완료 확인]을 누르고, WEHAGO 매입매출장 "엑셀 변환" 파일을 올려 반영 결과를 대사하세요.`,
    summary,
  };
  return result;
}

/**
 * WEHAGO 전송파일 준비 (사전검증 → 생성 → 재검증 → 대사 → 저장). 수임처·기간 단위로 직렬화된다.
 * 결과: { status: 'ready', ... } 또는 { status: 'blocked', reasons: [{ code, message, count, href }] }
 */
export async function prepareWehagoExport(ctx: ServiceContext, input: { clientId: string; period: string; kind: WehagoExportKind }): Promise<PrepareExportResult> {
  requirePermission(ctx, 'export.create');
  const clientId = assertUuid(input.clientId, 'clientId', '거래처');
  const period = assertPeriod(input.period);
  const kind = assertKind(input.kind);
  const client = await loadClientProfile(ctx, clientId);
  return ctx.db.transaction(async (tx) => {
    const tctx = withTx(ctx, tx);
    await lockClientPeriod(tctx, clientId, period);
    return prepareLocked(tctx, client, period, kind);
  });
}

/**
 * 수임처 한 곳의 이번 기간 전송파일을 필요한 종류만큼 준비한다 (매입매출 + 일반전표 대상이 있으면 일반전표).
 */
export async function prepareClientExports(ctx: ServiceContext, input: { clientId: string; period: string }): Promise<ClientExportsResult> {
  requirePermission(ctx, 'export.create');
  const clientId = assertUuid(input.clientId, 'clientId', '거래처');
  const period = assertPeriod(input.period);
  const client = await loadClientProfile(ctx, clientId);
  const kinds = await kindsNeeded(ctx, client, period);
  const results: PrepareExportResult[] = [];
  for (const kind of kinds) results.push(await prepareWehagoExport(ctx, { clientId, period, kind }));
  const blocked = results.filter((r): r is PrepareExportBlocked => r.status === 'blocked');
  const summary = blocked.length
    ? blocked.map((b) => b.summary).join(' / ')
    : results.map((r) => (r.status === 'ready' ? `${EXPORT_KIND_LABELS[r.kind]} v${r.version} ${totalsText(r.totals)}` : '')).join(' / ');
  return { clientId, clientName: client.name, period, status: blocked.length ? 'blocked' : 'ready', results, summary };
}

/** 이 기간 승인 거래의 전표 종류 (없으면 매입매출 — 차단 사유를 보여주기 위해) */
export async function kindsNeeded(ctx: ServiceContext, client: ClientProfile, period: string): Promise<WehagoExportKind[]> {
  const scope = parseExportScope(client.ruleParams);
  const ps = await loadActiveTemplate(ctx, 'wehago_purchase_sales');
  const rows = await ctx.db
    .select({
      direction: transactions.direction,
      evidenceType: transactions.evidenceType,
      vatType: transactions.vatType,
      deductible: transactions.deductible,
      // 경로 판정에는 세액 0 여부만 쓴다 (금액별로 묶지 않음)
      vatNonZero: sql<number>`(case when ${transactions.vatAmount} = 0 then 0 else 1 end)::int`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.clientId, client.id),
        eq(transactions.period, period),
        inArray(transactions.status, [...APPROVED_STATUSES]),
        ...(scope.excludedEvidenceTypes.length ? [notInArray(transactions.evidenceType, scope.excludedEvidenceTypes)] : []),
      ),
    )
    .groupBy(sql`1, 2, 3, 4, 5`);
  let psNeeded = false;
  let gjNeeded = false;
  for (const r of rows) {
    const route = routeForExport({ direction: r.direction, evidenceType: r.evidenceType, vatType: r.vatType, deductible: r.deductible, vatAmount: Number(r.vatNonZero) }, ps.template).route;
    if (route === 'wehago_general_journal') gjNeeded = true;
    else psNeeded = true;
  }
  const kinds: WehagoExportKind[] = [];
  if (psNeeded || !gjNeeded) kinds.push('wehago_purchase_sales');
  if (gjNeeded) kinds.push('wehago_general_journal');
  return kinds;
}

