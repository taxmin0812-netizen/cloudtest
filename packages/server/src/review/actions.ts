/**
 * 예외 처리 — 승인 · 수정(학습) · 같은 가맹점 일괄 적용 · 묶음 수정 · 제외.
 *
 * 공통 원칙
 * - 첫 줄 requirePermission('transactions.review'). 한 작업 = 한 DB 트랜잭션 (거래 + 수정기록 + 감사로그 + 규칙 제안).
 * - 사람 처리 1회 = touch_count +1 (거래마다). 묶음 처리도 영향받은 거래마다 +1 로 센다: 각 거래의 확정이 사람의 판단이기 때문이다.
 *   (KPI "사람이 만진 거래" 를 과소 집계하지 않는다. 대신 학습 임계치에는 묶음 1회로 센다.)
 * - 감사로그는 거래마다 되돌릴 수 있게(revertible) 남기고, 여러 건이면 묶음 감사로그(되돌리기 핸들)를 하나 더 남긴다.
 * - 받기 전(ready) 전송파일에 포함된 거래를 바꾸면 그 파일을 차단하고, 이미 받은(downloaded·uploaded_confirmed) 파일이면 거부한다.
 */
import { sql } from 'drizzle-orm';
import { classificationCorrections } from '@mintax/db';
import {
  type AccountClassification,
  type AccountCode,
  type ClientProfile,
  type RiskFlag,
  type VatType,
} from '@mintax/core';
import { classifyVat, purchaseVatType, type VatRuleDef } from '@mintax/core/engine/vat-risk-index';
import { isAccountCompatible } from '@mintax/core/engine/classify-index';
import { AppError, NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit, writeAuditMany } from '../infra/audit';
import { loadClientProfile } from '../infra/clients';
import { recordSystemError } from '../infra/system-errors';
import {
  ALL_VAT_TYPES,
  BUCKET_LABELS,
  TAKEN_EXPORT_MESSAGE,
  TAKEN_EXPORT_STATUSES,
  accountLabel,
  approvalBlockReason,
  assertUuid,
  blockingRiskFlags,
  bulkReason,
  cleanText,
  clientScopeLabel,
  correctionBlockReason,
  correctionSummary,
  deductibleLabel,
  exclusionBlockReason,
  exportReleasable,
  needsIndividualReview,
  normalizeIds,
  txLabel,
  vatLabel,
  withoutBucket,
} from './helpers';
import { suggestRuleForMerchant } from './learning';
import {
  blockExportJobsForChange,
  loadAccountMap,
  loadExceptionRowsByIds,
  loadVatRules,
  lockActionRows,
  opContext,
  textArray,
  toNormalized,
  txAuditEntry,
  uuidArray,
  writeTxStates,
  type ActionRow,
} from './shared';
import type {
  ApplySimilarInput,
  ApprovalPreview,
  ApproveInput,
  ApproveResult,
  BulkCorrectInput,
  BulkCorrectResult,
  CorrectInput,
  CorrectResult,
  ExcludeInput,
  ExcludeResult,
  RuleSuggestionDto,
  SimilarScope,
  SkippedItem,
  TxState,
} from './types';

const NOT_FOUND_REASON = '거래를 찾을 수 없습니다. 목록을 새로고침하세요.';

function eligibilityOf(row: ActionRow) {
  return {
    status: row.status,
    direction: row.direction,
    accountCode: row.state.accountCode,
    deductible: row.state.deductible,
    buckets: row.state.buckets,
    riskFlags: row.riskFlags,
    exportStatus: row.exportStatus,
  };
}

/** 받기 전 전송파일에 연결된 거래인가 → 내용이 바뀌면 파일에서 풀고 파일을 차단한다 */
function releasesExport(row: ActionRow): boolean {
  return exportReleasable(row.state.exportJobId, row.exportStatus);
}

/**
 * 사람 처리 후 상태. contentChanged=true(수정·제외)면 받기 전 전송파일에서 거래를 푼다.
 * 승인은 내용이 그대로라 전송파일 연결을 유지한다.
 */
function reviewedState(ctx: ServiceContext, row: ActionRow, patch: Partial<TxState>, contentChanged = false): TxState {
  const releases = contentChanged && releasesExport(row);
  return {
    ...row.state,
    reviewedBy: ctx.actor.userId,
    reviewedAt: ctx.now().toISOString(),
    buckets: withoutBucket(row.state.buckets, 'export_error'),
    exportJobId: releases ? null : row.state.exportJobId,
    ...patch,
  };
}

/**
 * 거래별 감사로그 + (여러 건이면) 묶음 감사로그. 반환: 되돌리기 핸들 (1건 = 그 거래 로그, 여러 건 = 묶음 로그).
 * batchId 를 미리 받으면(묶음 수정: 수정기록 reason 에 넣어야 해서 먼저 만든 경우) 그 묶음에 붙인다.
 */
async function auditTxChanges(
  ctx: ServiceContext,
  spec: {
    action: string;
    batchAction: string;
    batchSummary: string;
    items: Array<{ row: ActionRow; before: TxState; after: TxState; summary: string; extra?: Record<string, unknown> }>;
    batchId?: string | null;
    batchExtra?: Record<string, unknown>;
  },
): Promise<string | null> {
  if (spec.items.length === 0) return spec.batchId ?? null;
  if (spec.items.length === 1 && !spec.batchId) {
    const it = spec.items[0]!;
    return writeAudit(ctx, txAuditEntry(spec.action, it.row, it.before, it.after, it.summary, { after: it.extra ?? {} }));
  }
  const batchId = spec.batchId ?? (await writeBatchAudit(ctx, spec.batchAction, spec.batchSummary, spec.items.map((i) => i.row), spec.action, spec.batchExtra));
  await writeAuditMany(
    ctx,
    spec.items.map((it) => txAuditEntry(spec.action, it.row, it.before, it.after, it.summary, { after: { ...(it.extra ?? {}), batchId } })),
  );
  return batchId;
}

async function writeBatchAudit(
  ctx: ServiceContext,
  action: string,
  summary: string,
  rows: readonly ActionRow[],
  childAction: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const clients = [...new Set(rows.map((r) => r.clientId))];
  return writeAudit(ctx, {
    action,
    category: 'data_change',
    entityType: 'transaction_batch',
    entityId: null,
    clientId: clients.length === 1 ? clients[0]! : null,
    summary: summary.slice(0, 500),
    before: null,
    after: {
      childAction,
      count: rows.length,
      clientIds: clients.slice(0, 50),
      totalAmount: rows.reduce((s, r) => s + r.totalAmount, 0),
      ...extra,
    },
    revertible: true,
  });
}

/** 내용이 바뀐 거래만 넘긴다 — 받기 전(ready·validating) 파일 차단 + 알림 */
async function blockExportsFor(ctx: ServiceContext, rows: ReadonlyArray<ActionRow>): Promise<void> {
  const changes = rows.filter(releasesExport).map((r) => ({ exportJobId: r.state.exportJobId!, label: txLabel(r) }));
  if (changes.length > 0) await blockExportJobsForChange(ctx, changes);
}

// ═══════════════════════════════ 승인 ═══════════════════════════════

/**
 * 일괄 승인 (A / Shift+A). needs_review · auto_approved (+ 전송오류 버킷이 붙은 approved 재확인)만.
 * 계정이 없거나 매입 공제여부가 비어 있으면 건너뛴다 (사유 반환). excludeBlockingRisks=true 면 차단 위험 거래도 건너뛴다.
 */
export async function approveTransactions(ctx: ServiceContext, input: ApproveInput): Promise<ApproveResult> {
  requirePermission(ctx, 'transactions.review');
  const ids = normalizeIds(input?.ids);
  const note = cleanText(input?.note, 'note', '메모', { max: 200 });
  const op = opContext(ctx);
  return op.db.transaction(async (trx) => {
    const tctx = withTx(op, trx);
    const rows = await lockActionRows(tctx.db, ids);
    const skipped: SkippedItem[] = [];
    const items: Array<{ row: ActionRow; before: TxState; after: TxState; summary: string; extra?: Record<string, unknown> }> = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) {
        skipped.push({ id, reason: NOT_FOUND_REASON });
        continue;
      }
      const reason = approvalBlockReason(eligibilityOf(row), { excludeBlockingRisks: input?.excludeBlockingRisks === true });
      if (reason) {
        skipped.push({ id, reason });
        continue;
      }
      const after = reviewedState(tctx, row, { status: 'approved' });
      const summary = `${txLabel(row)} ${accountLabel(row.state.accountCode, row.state.accountName)} 승인${note ? ` — ${note}` : ''}`;
      items.push({ row, before: row.state, after, summary, extra: note ? { note } : {} });
    }
    if (items.length === 0) return { approved: 0, approvedIds: [], skipped, auditLogId: null };
    await writeTxStates(tctx.db, items.map((i) => ({ id: i.row.id, state: i.after })), tctx.now());
    const auditLogId = await auditTxChanges(tctx, {
      action: 'transaction.approve',
      batchAction: 'transaction.approve_bulk',
      batchSummary: `${items.length}건 일괄 승인${clientScopeLabel(items.map((i) => i.row.clientName))}${note ? ` — ${note}` : ''}`,
      items,
    });
    return { approved: items.length, approvedIds: items.map((i) => i.row.id), skipped, auditLogId };
  });
}

/**
 * 일괄 승인 사전 점검 (Shift+A 다이얼로그): "선택 42건 중 39건을 승인합니다. 3건은 자동확정 차단 위험(고액 2, 자산 가능성 1)이 있어 제외했습니다."
 * 읽기 전용.
 */
export async function previewApproval(ctx: ServiceContext, input: { ids: string[] }): Promise<ApprovalPreview> {
  requirePermission(ctx, 'transactions.review');
  const ids = normalizeIds(input?.ids);
  const rows = await lockActionRows(ctx.db, ids, { lock: false });
  const approvableIds: string[] = [];
  let amount = 0;
  const blockedByRisk: ApprovalPreview['blockedByRisk'] = [];
  const ineligible: SkippedItem[] = [];
  const bucketTally = new Map<string, number>();
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      ineligible.push({ id, reason: NOT_FOUND_REASON });
      continue;
    }
    const reason = approvalBlockReason(eligibilityOf(row));
    if (reason) {
      ineligible.push({ id, reason });
      continue;
    }
    const blocking = blockingRiskFlags(row.riskFlags);
    if (blocking.length > 0) {
      const buckets = [...new Set(blocking.map((f) => f.bucket))];
      for (const b of buckets.slice(0, 1)) bucketTally.set(b, (bucketTally.get(b) ?? 0) + 1);
      blockedByRisk.push({
        id,
        merchantName: row.merchantName,
        totalAmount: row.totalAmount,
        buckets,
        reason: blocking.map((f) => f.message || f.ruleName).filter(Boolean).slice(0, 2).join(' / ') || '자동확정 차단 위험',
      });
      continue;
    }
    approvableIds.push(id);
    amount += row.totalAmount;
  }
  let message = `선택 ${ids.length.toLocaleString('ko-KR')}건 중 ${approvableIds.length.toLocaleString('ko-KR')}건을 승인합니다.`;
  if (blockedByRisk.length > 0) {
    const detail = [...bucketTally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([b, n]) => `${BUCKET_LABELS[b as keyof typeof BUCKET_LABELS] ?? b} ${n}`)
      .join(', ');
    message += ` ${blockedByRisk.length}건은 자동확정 차단 위험(${detail})이 있어 제외했습니다.`;
  }
  if (ineligible.length > 0) message += ` ${ineligible.length}건은 승인할 수 없는 상태입니다.`;
  return { selected: ids.length, approvable: { count: approvableIds.length, amount, ids: approvableIds }, blockedByRisk, ineligible, message };
}

// ═══════════════════════════════ 수정 (공통 계산) ═══════════════════════════════

interface CorrectionTarget {
  account: AccountCode | null;
  vatType: VatType | null;
  vatDeductible: boolean | null;
  reason: string | null;
}

interface CorrectionDeps {
  client: ClientProfile | null;
  vatRules: VatRuleDef[] | null;
  manualVatTxIds: ReadonlySet<string>;
}

interface ComputedCorrection {
  after: TxState;
  accountChanged: boolean;
  vatChanged: boolean;
  vatExplicit: boolean;
  vatReevaluated: CorrectResult['vatReevaluated'];
  needsVatDecision: boolean;
  warnings: string[];
}

function validateTarget(input: { accountCode?: unknown; vatType?: unknown; vatDeductible?: unknown; reason?: unknown }, accounts: Map<string, AccountCode>): CorrectionTarget {
  const hasAccount = input.accountCode !== undefined && input.accountCode !== null && String(input.accountCode).trim() !== '';
  const hasVatType = input.vatType !== undefined && input.vatType !== null;
  const hasDed = input.vatDeductible !== undefined && input.vatDeductible !== null;
  if (!hasAccount && !hasVatType && !hasDed) {
    throw new ValidationError('바꿀 계정과목 또는 부가세 판단을 선택하세요.', [{ field: 'accountCode', message: '계정·부가세 중 하나는 필요합니다' }]);
  }
  let account: AccountCode | null = null;
  if (hasAccount) {
    const code = String(input.accountCode).trim();
    const acc = accounts.get(code);
    if (!acc) {
      throw new ValidationError(`계정코드 ${code.slice(0, 20)}을(를) 계정과목표에서 찾을 수 없습니다. 코드·이름으로 다시 검색하세요.`, [
        { field: 'accountCode', message: '없는 계정' },
      ]);
    }
    if (!acc.active) {
      throw new ValidationError(`${acc.code} ${acc.name}은(는) 사용하지 않는 계정입니다. 다른 계정을 선택하세요.`, [{ field: 'accountCode', message: '비활성 계정' }]);
    }
    account = acc;
  }
  if (hasVatType && !(ALL_VAT_TYPES as readonly unknown[]).includes(input.vatType)) {
    throw new ValidationError('부가세 유형 값이 올바르지 않습니다.', [{ field: 'vatType', message: '알 수 없는 유형' }]);
  }
  if (hasDed && typeof input.vatDeductible !== 'boolean') {
    throw new ValidationError('공제 여부는 공제 또는 불공제로 선택하세요.', [{ field: 'vatDeductible', message: 'true | false' }]);
  }
  return {
    account,
    vatType: hasVatType ? (input.vatType as VatType) : null,
    vatDeductible: hasDed ? (input.vatDeductible as boolean) : null,
    reason: cleanText(input.reason, 'reason', '수정 사유', { max: 300 }),
  };
}

function impliedDeductible(vatType: VatType, current: boolean | null): boolean | null {
  switch (vatType) {
    case 'purchase_non_deductible':
    case 'purchase_no_evidence':
      return false;
    case 'purchase_taxable':
    case 'purchase_card':
    case 'purchase_cash_receipt':
      return true;
    default:
      return current ?? true;
  }
}

function manualAccountClassification(acc: AccountCode): AccountClassification {
  return {
    accountCode: acc.code,
    accountName: acc.name,
    confidence: 100,
    source: 'manual',
    summary: `담당자 지정: ${acc.name}`,
    reasons: [],
    evidence: {},
    alternatives: [],
  };
}

/**
 * 한 거래에 대한 수정 결과 계산 (DB 없음). 행 단위 사유는 문자열로 throw 하지 않고 { skip } 으로 돌려준다.
 * - 계정: 사람이 지정 → confidence 100 · source 'manual'
 * - 부가세: 사람이 지정하면 그대로(신뢰도 100). 계정만 바꿨으면 엔진으로 다시 판단 (접대비 → 불공제 등).
 *   다시 판단이 '판단불가'면 기존 판단을 유지하고 경고. 전에 사람이 부가세를 고친 거래는 다시 판단하지 않는다.
 * - 상태: 계정이 있고 (매출이거나 공제여부가 정해졌으면) 승인, 아니면 검토 필요로 남긴다 (사람 처리 표시는 함).
 */
function computeCorrection(
  ctx: ServiceContext,
  row: ActionRow,
  target: CorrectionTarget,
  deps: CorrectionDeps,
  summaryPrefix: string,
): ComputedCorrection | { skip: string } {
  const cur = row.state;
  const warnings: string[] = [];
  const acc = target.account;
  if (acc && !isAccountCompatible(acc.code, row.direction, new Map([[acc.code, acc]]))) {
    return {
      skip:
        row.direction === 'purchase'
          ? `매입 거래에 매출 계정(${acc.code} ${acc.name})을 지정할 수 없습니다.`
          : `매출 거래에 비용 계정(${acc.code} ${acc.name})을 지정할 수 없습니다.`,
    };
  }
  const accountChanged = !!acc && acc.code !== cur.accountCode;

  // ── 부가세 ──
  let vatType = cur.vatType;
  let deductible = cur.deductible;
  let vatConfidence = cur.vatConfidence;
  let vatReasonCode = cur.vatReasonCode;
  let vatReevaluated: ComputedCorrection['vatReevaluated'] = null;
  const vatExplicit = target.vatType !== null || target.vatDeductible !== null;
  if (vatExplicit) {
    if (row.direction === 'sales') {
      if (target.vatDeductible === false) return { skip: '매출 거래는 매입세액 공제/불공제 대상이 아닙니다. 부가세 유형만 바꿀 수 있습니다.' };
      if (target.vatType && !target.vatType.startsWith('sales_')) return { skip: '매출 거래에는 매출 부가세 유형만 지정할 수 있습니다.' };
      deductible = true;
      vatType = target.vatType ?? cur.vatType;
    } else {
      if (target.vatType && !target.vatType.startsWith('purchase_')) return { skip: '매입 거래에는 매입 부가세 유형만 지정할 수 있습니다.' };
      deductible = target.vatDeductible ?? (target.vatType ? impliedDeductible(target.vatType, cur.deductible) : cur.deductible);
      vatType = target.vatType ?? purchaseVatType(toNormalized(row), deductible);
    }
    vatConfidence = 100;
    vatReasonCode = deductible === false ? (cur.deductible === false && cur.vatReasonCode ? cur.vatReasonCode : 'MANUAL') : null;
  } else if (accountChanged && acc && deps.client && deps.vatRules && !deps.manualVatTxIds.has(row.id)) {
    try {
      const v = classifyVat(toNormalized(row), manualAccountClassification(acc), { client: deps.client, rules: deps.vatRules });
      if (v.deductible !== null || cur.deductible === null) {
        if (v.vatType !== cur.vatType || v.deductible !== cur.deductible) {
          vatReevaluated = { before: vatLabel(cur.vatType, cur.deductible), after: vatLabel(v.vatType, v.deductible), summary: v.summary };
        }
        vatType = v.vatType;
        deductible = v.deductible;
        vatConfidence = v.confidence;
        vatReasonCode = v.nonDeductibleReasonCode;
      } else {
        warnings.push(`계정 변경 후 부가세 규칙이 판단하지 못해 기존 판단(${deductibleLabel(cur.deductible)})을 유지했습니다. 부가세 칸을 확인하세요.`);
      }
    } catch {
      warnings.push('부가세를 다시 판단하지 못해 기존 판단을 유지했습니다. 부가세 칸을 확인하세요.');
    }
  }
  const vatChanged = vatType !== cur.vatType || deductible !== cur.deductible;

  // ── 계정 ──
  let accountCode = cur.accountCode;
  let accountName = cur.accountName;
  let accountConfidence = cur.accountConfidence;
  let classificationSource = cur.classificationSource;
  let classificationSummary = cur.classificationSummary;
  if (accountChanged && acc) {
    accountCode = acc.code;
    accountName = acc.name;
    accountConfidence = 100;
    classificationSource = 'manual';
    classificationSummary = `${summaryPrefix}: ${accountLabel(cur.accountCode, cur.accountName)} → ${acc.name}`;
  }

  const needsVatDecision = row.direction === 'purchase' && deductible === null;
  if (!accountCode) warnings.push('계정과목이 아직 정해지지 않아 검토 필요 상태로 남겼습니다.');
  if (needsVatDecision) warnings.push('부가세 공제/불공제가 정해지지 않아 검토 필요 상태로 남겼습니다. 부가세 칸에서 선택하세요.');
  const approved = !!accountCode && !needsVatDecision;
  const scores = [accountConfidence, vatConfidence].filter((n): n is number => typeof n === 'number');
  const after = reviewedState(
    ctx,
    row,
    {
    status: approved ? 'approved' : 'needs_review',
    accountCode,
    accountName,
    accountConfidence,
    classificationSource,
    classificationSummary,
    vatType,
    deductible,
    vatConfidence,
    vatReasonCode,
    confidenceScore: scores.length > 0 ? Math.min(...scores) : cur.confidenceScore,
    },
    accountChanged || vatChanged,
  );
  return { after, accountChanged, vatChanged, vatExplicit, vatReevaluated, needsVatDecision, warnings };
}

async function loadCorrectionDeps(ctx: ServiceContext, rows: readonly ActionRow[], target: CorrectionTarget): Promise<Map<string, CorrectionDeps>> {
  const out = new Map<string, CorrectionDeps>();
  const ids = rows.map((r) => r.id);
  const manual = new Set<string>();
  if (ids.length > 0) {
    const r = await ctx.db.execute<{ transaction_id: string }>(sql`
      select distinct transaction_id from classification_corrections where field = 'vat' and transaction_id = any(${uuidArray(ids)})
    `);
    for (const x of r.rows) manual.add(x.transaction_id);
  }
  const needVatEngine = !!target.account && target.vatType === null && target.vatDeductible === null;
  for (const clientId of new Set(rows.map((r) => r.clientId))) {
    let client: ClientProfile | null = null;
    let vatRules: VatRuleDef[] | null = null;
    if (needVatEngine) {
      client = await loadClientProfile(ctx, clientId);
      vatRules = await loadVatRules(ctx.db, clientId);
    }
    out.set(clientId, { client, vatRules, manualVatTxIds: manual });
  }
  return out;
}

function dedKey(d: boolean | null): string {
  return d === true ? 'deductible' : d === false ? 'non_deductible' : 'review';
}

/** 수정 기록 (학습 데이터) 삽입 → id 목록 (거래별) */
async function insertCorrections(
  ctx: ServiceContext,
  items: ReadonlyArray<{ row: ActionRow; c: ComputedCorrection }>,
  reasonFor: (row: ActionRow) => string | null,
): Promise<Map<string, string[]>> {
  const values: Array<typeof classificationCorrections.$inferInsert> = [];
  const now = ctx.now();
  for (const { row, c } of items) {
    const cur = row.state;
    const base = {
      transactionId: row.id,
      clientId: row.clientId,
      merchantKey: row.merchantKey,
      merchantBusinessNumber: row.merchantBusinessNumber,
      reason: reasonFor(row),
      userId: ctx.actor.userId,
      createdAt: now,
    };
    if (c.accountChanged) {
      values.push({
        ...base,
        field: 'account',
        beforeValue: cur.accountCode,
        beforeLabel: cur.accountName,
        afterValue: c.after.accountCode!,
        afterLabel: c.after.accountName,
        beforeSource: cur.classificationSource,
        beforeConfidence: cur.accountConfidence,
      });
    }
    if (c.vatExplicit && c.vatChanged) {
      values.push({
        ...base,
        field: 'vat',
        beforeValue: `${cur.vatType ?? ''}:${dedKey(cur.deductible)}`,
        beforeLabel: vatLabel(cur.vatType, cur.deductible),
        afterValue: `${c.after.vatType ?? ''}:${dedKey(c.after.deductible)}`,
        afterLabel: vatLabel(c.after.vatType, c.after.deductible),
        beforeSource: cur.vatConfidence === 100 && cur.classificationSource === 'manual' ? 'manual' : 'vat_engine',
        beforeConfidence: cur.vatConfidence,
      });
    }
  }
  const out = new Map<string, string[]>();
  for (let i = 0; i < values.length; i += 500) {
    const rows = await ctx.db
      .insert(classificationCorrections)
      .values(values.slice(i, i + 500))
      .returning({ id: classificationCorrections.id, transactionId: classificationCorrections.transactionId });
    for (const r of rows) (out.get(r.transactionId) ?? out.set(r.transactionId, []).get(r.transactionId)!).push(r.id);
  }
  return out;
}

/** 규칙 제안 (학습). 실패해도 수정 자체는 살린다 — savepoint 로 격리하고 system_errors 에 남긴다. */
async function learnSafely(ctx: ServiceContext, rows: readonly ActionRow[], accounts: Map<string, AccountCode>): Promise<RuleSuggestionDto | null> {
  const seen = new Set<string>();
  let first: RuleSuggestionDto | null = null;
  for (const row of rows) {
    const key = `${row.clientId}|${row.merchantBusinessNumber ? `b:${row.merchantBusinessNumber}` : `k:${row.merchantKey}`}`;
    if (seen.has(key) || seen.size >= 50) continue;
    seen.add(key);
    try {
      const s = await ctx.db.transaction(async (sp) =>
        suggestRuleForMerchant(
          withTx(ctx, sp),
          { clientId: row.clientId, merchantKey: row.merchantKey, merchantBusinessNumber: row.merchantBusinessNumber, merchantName: row.merchantName },
          { accounts },
        ),
      );
      first ??= s;
    } catch (e) {
      await recordSystemError(ctx, {
        area: 'review',
        error: e,
        userMessage: '수정은 저장했지만 규칙 제안 분석에 실패했습니다.',
        context: { clientId: row.clientId, transactionId: row.id },
      });
    }
  }
  return first;
}

// ── 같은 가맹점 미검토 ──

function similarCond(row: Pick<ActionRow, 'id' | 'clientId' | 'direction' | 'merchantKey' | 'merchantBusinessNumber' | 'period'>, targetCode: string, scope: SimilarScope) {
  const party = row.merchantBusinessNumber ? sql`t.merchant_business_number = ${row.merchantBusinessNumber}` : sql`t.merchant_key = ${row.merchantKey}`;
  const periodCond = scope === 'period' ? sql` and t.period = ${row.period}` : sql``;
  return sql`t.client_id = ${row.clientId}::uuid and t.id <> ${row.id}::uuid and t.status = 'needs_review' and t.reviewed_by is null
    and t.direction = ${row.direction} and ${party} and t.account_code is distinct from ${targetCode}${periodCond}`;
}

const RESOLVABLE = ['low_confidence', 'new_merchant', 'account_conflict', 'changed_from_history', 'unclassified'];

async function countSimilarPending(ctx: ServiceContext, row: ActionRow, targetCode: string): Promise<{ applicable: number; individual: number }> {
  const r = await ctx.db.execute<{ applicable: number; individual: number }>(sql`
    select (count(*) filter (where not x.individual))::int as applicable, (count(*) filter (where x.individual))::int as individual
    from (
      select exists (
        select 1 from jsonb_array_elements(t.risk_flags) f
        where coalesce((f->>'blocksAutoApproval')::boolean, false) and not (f->>'bucket' = any(${textArray(RESOLVABLE)}))
      ) as individual
      from transactions t where ${similarCond(row, targetCode, 'period')}
    ) x
  `);
  return { applicable: r.rows[0]?.applicable ?? 0, individual: r.rows[0]?.individual ?? 0 };
}

// ═══════════════════════════════ 수정 (단건) ═══════════════════════════════

/**
 * 단건 수정 (M · 대안 1/2/3). 계정/부가세를 바꾸고 승인 → 수정기록(학습) → 감사로그(되돌리기 가능) → 규칙 제안 분석.
 * 아무것도 바뀌지 않았으면 승인과 같게 처리한다 (M 후 그대로 Enter).
 */
export async function correctTransaction(ctx: ServiceContext, input: CorrectInput): Promise<CorrectResult> {
  requirePermission(ctx, 'transactions.review');
  const id = assertUuid(input?.id, 'id');
  const op = opContext(ctx);
  const { map: accounts } = await loadAccountMap(op.db);
  const target = validateTarget(input ?? {}, accounts);

  const result = await op.db.transaction(async (trx) => {
    const tctx = withTx(op, trx);
    const row = (await lockActionRows(tctx.db, [id], { withRaw: true })).get(id);
    if (!row) throw new NotFoundError('거래');
    const blocked = correctionBlockReason(row);
    if (blocked) throw stateError(blocked, row);
    const deps = (await loadCorrectionDeps(tctx, [row], target)).get(row.clientId)!;
    const c = computeCorrection(tctx, row, target, deps, '담당자 수정');
    if ('skip' in c) throw new ValidationError(c.skip, [{ field: 'accountCode', message: c.skip }]);

    // 바뀐 것이 없음 → 승인과 같음 (이미 승인된 거래면 아무것도 쓰지 않는다)
    if (!c.accountChanged && !c.vatChanged) {
      if (row.status === 'approved' && !row.state.buckets.includes('export_error')) {
        return { row, c, changed: false, correctionIds: [] as string[], auditLogId: null as string | null, suggestion: null, noop: true };
      }
      const reason = approvalBlockReason(eligibilityOf(row));
      if (reason) throw new ValidationError(reason, [{ field: 'accountCode', message: reason }]);
      const after = reviewedState(tctx, row, { status: 'approved' });
      await writeTxStates(tctx.db, [{ id: row.id, state: after }], tctx.now());
      const auditLogId = await writeAudit(
        tctx,
        txAuditEntry('transaction.approve', row, row.state, after, `${txLabel(row)} ${accountLabel(row.state.accountCode, row.state.accountName)} 승인 (변경 없이 확정)`),
      );
      return { row, c: { ...c, after }, changed: false, correctionIds: [] as string[], auditLogId, suggestion: null, noop: false };
    }

    const correctionMap = await insertCorrections(tctx, [{ row, c }], () => target.reason);
    const correctionIds = correctionMap.get(row.id) ?? [];
    await writeTxStates(tctx.db, [{ id: row.id, state: c.after }], tctx.now());
    const summary = correctionSummary(row, row.state, c.after) + (target.reason ? ` — ${target.reason}` : '');
    const auditLogId = await writeAudit(
      tctx,
      txAuditEntry('transaction.correct', row, row.state, c.after, summary, {
        after: { correctionIds, reason: target.reason, vatReevaluated: c.vatReevaluated },
      }),
    );
    await blockExportsFor(tctx, [row]);
    const suggestion = c.accountChanged ? await learnSafely(tctx, [row], accounts) : null;
    return { row, c, changed: true, correctionIds, auditLogId, suggestion, noop: false };
  });

  const { row, c } = result;
  let similarPending: CorrectResult['similarPending'] = null;
  if (result.changed && c.accountChanged && c.after.accountCode) {
    const n = await countSimilarPending(ctx, row, c.after.accountCode);
    if (n.applicable > 0) {
      similarPending = {
        count: n.applicable,
        message: `같은 가맹점 미검토 ${n.applicable}건에도 적용할까요?${n.individual > 0 ? ` (${n.individual}건은 고액 등 위험이 있어 개별 검토)` : ''}`,
      };
    }
  }
  const tx = (await loadExceptionRowsByIds(ctx.db, [row.id])).get(row.id)!;
  return {
    transaction: tx,
    changed: result.changed,
    correctionIds: result.correctionIds,
    auditLogId: result.auditLogId,
    vatReevaluated: c.vatReevaluated,
    needsVatDecision: c.needsVatDecision,
    ruleSuggestion: result.suggestion,
    similarPending,
    warnings: result.noop ? ['변경 사항이 없습니다. 이미 승인된 거래입니다.'] : c.warnings,
  };
}

function stateError(message: string, row: ActionRow): AppError {
  const taken = message === TAKEN_EXPORT_MESSAGE || (row.exportStatus && TAKEN_EXPORT_STATUSES.has(row.exportStatus));
  return new AppError({
    code: taken ? 'ALREADY_EXPORTED' : 'INVALID_STATE',
    httpStatus: 409,
    userMessage: message,
    action: taken ? { label: '정정 전송', href: `/transfer?client=${row.clientId}&period=${row.period}` } : undefined,
    details: { status: row.status, exportStatus: row.exportStatus },
  });
}

// ═══════════════════════════════ 묶음 수정 (빠른 검토 M · 같은 가맹점 적용) ═══════════════════════════════

async function bulkCorrectCore(
  ctx: ServiceContext,
  rows: ActionRow[],
  target: CorrectionTarget,
  accounts: Map<string, AccountCode>,
  opts: { batchAction: string; batchSummary: (n: number) => string; summaryPrefix: string; preSkipped?: SkippedItem[] },
): Promise<BulkCorrectResult> {
  const skipped: SkippedItem[] = [...(opts.preSkipped ?? [])];
  const warnings = new Set<string>();
  const depsByClient = await loadCorrectionDeps(ctx, rows, target);
  const computed: Array<{ row: ActionRow; c: ComputedCorrection }> = [];
  for (const row of rows) {
    const blocked = correctionBlockReason(row);
    if (blocked) {
      skipped.push({ id: row.id, reason: blocked });
      continue;
    }
    const c = computeCorrection(ctx, row, target, depsByClient.get(row.clientId)!, opts.summaryPrefix);
    if ('skip' in c) {
      skipped.push({ id: row.id, reason: c.skip });
      continue;
    }
    if (!c.accountChanged && !c.vatChanged) {
      // 이미 같은 값 — 검토 대기면 승인으로, 이미 승인이면 건너뜀
      const reason = row.status === 'approved' && !row.state.buckets.includes('export_error') ? '이미 같은 값으로 승인된 거래입니다.' : approvalBlockReason(eligibilityOf(row));
      if (reason) {
        skipped.push({ id: row.id, reason });
        continue;
      }
      computed.push({ row, c: { ...c, after: reviewedState(ctx, row, { status: 'approved' }) } });
      continue;
    }
    for (const w of c.warnings) warnings.add(w);
    computed.push({ row, c });
  }
  if (computed.length === 0) return { count: 0, updatedIds: [], skipped, auditLogId: null, ruleSuggestion: null, warnings: [...warnings] };

  // 묶음 감사로그를 먼저 만들어 수정기록 reason 에 'bulk:{id}' 로 남긴다 (학습 임계치 1회)
  const multi = computed.length > 1;
  const batchId = multi
    ? await writeBatchAudit(ctx, opts.batchAction, opts.batchSummary(computed.length), computed.map((x) => x.row), 'transaction.correct', {
        accountCode: target.account?.code ?? null,
        accountName: target.account?.name ?? null,
        vatDeductible: target.vatDeductible,
        vatType: target.vatType,
        reason: target.reason,
      })
    : null;
  const changedItems = computed.filter((x) => x.c.accountChanged || x.c.vatChanged);
  const correctionMap = await insertCorrections(ctx, changedItems, () => (batchId ? bulkReason(batchId, target.reason) : target.reason));
  await writeTxStates(ctx.db, computed.map((x) => ({ id: x.row.id, state: x.c.after })), ctx.now());
  const auditLogId = await auditTxChanges(ctx, {
    action: 'transaction.correct',
    batchAction: opts.batchAction,
    batchSummary: opts.batchSummary(computed.length),
    batchId,
    items: computed.map(({ row, c }) => ({
      row,
      before: row.state,
      after: c.after,
      summary: correctionSummary(row, row.state, c.after) + (target.reason ? ` — ${target.reason}` : ''),
      extra: { correctionIds: correctionMap.get(row.id) ?? [], reason: target.reason, vatReevaluated: c.vatReevaluated },
    })),
  });
  await blockExportsFor(ctx, changedItems.map((x) => x.row));
  const learnRows = changedItems.filter((x) => x.c.accountChanged).map((x) => x.row);
  const ruleSuggestion = learnRows.length > 0 ? await learnSafely(ctx, learnRows, accounts) : null;
  return {
    count: computed.length,
    updatedIds: computed.map((x) => x.row.id),
    skipped,
    auditLogId,
    ruleSuggestion,
    warnings: [...warnings],
  };
}

/**
 * 묶음 수정 (빠른 검토 "M 묶음 계정 변경" 등): 선택한 거래 모두에 같은 계정/부가세를 지정.
 * 거래마다 수정기록을 남기되 학습(규칙 제안 임계치)에는 1회로 센다.
 */
export async function correctTransactions(ctx: ServiceContext, input: BulkCorrectInput): Promise<BulkCorrectResult> {
  requirePermission(ctx, 'transactions.review');
  const ids = normalizeIds(input?.ids);
  const op = opContext(ctx);
  const { map: accounts } = await loadAccountMap(op.db);
  const target = validateTarget(input ?? {}, accounts);
  return op.db.transaction(async (trx) => {
    const tctx = withTx(op, trx);
    const locked = await lockActionRows(tctx.db, ids, { withRaw: true });
    const preSkipped: SkippedItem[] = ids.filter((id) => !locked.has(id)).map((id) => ({ id, reason: NOT_FOUND_REASON }));
    const rows = ids.map((id) => locked.get(id)).filter((r): r is ActionRow => !!r);
    const label = target.account ? `→ ${target.account.name}` : `부가세 ${deductibleLabel(target.vatDeductible)}`;
    return bulkCorrectCore(tctx, rows, target, accounts, {
      batchAction: 'transaction.correct_bulk',
      batchSummary: (n) => `${n}건 묶음 수정 ${label}${clientScopeLabel(rows.map((r) => r.clientName))}${target.reason ? ` — ${target.reason}` : ''}`,
      summaryPrefix: '담당자 묶음 수정',
      preSkipped,
    });
  });
}

/**
 * 같은 가맹점 미검토 거래에 방금 한 수정을 적용 ("같은 가맹점 미검토 5건에도 적용할까요?").
 * 대상: 같은 수임처·같은 상대방(사업자번호 우선, 없으면 상호키)·같은 매입/매출, needs_review 이고 사람이 아직 안 본 거래,
 *       계정이 다른 것. scope 'period'(기본)는 같은 기간만, 'all_pending' 은 모든 기간.
 * 고액·자산 등 계정 수정으로 해소되지 않는 차단 위험이 있는 거래는 건너뛴다 (예외함에 남아 개별 검토).
 * touch_count: 영향받은 거래마다 +1 (각 거래의 확정이 사람의 판단). 학습에는 묶음 1회.
 */
export async function applyCorrectionToSimilar(ctx: ServiceContext, input: ApplySimilarInput): Promise<BulkCorrectResult> {
  requirePermission(ctx, 'transactions.review');
  const sourceId = assertUuid(input?.transactionId, 'transactionId');
  const scope: SimilarScope = input?.scope ?? 'period';
  if (scope !== 'period' && scope !== 'all_pending') {
    throw new ValidationError('적용 범위가 올바르지 않습니다. (period / all_pending)', [{ field: 'scope', message: '알 수 없는 값' }]);
  }
  const op = opContext(ctx);
  const { map: accounts } = await loadAccountMap(op.db);
  return op.db.transaction(async (trx) => {
    const tctx = withTx(op, trx);
    const source = (await lockActionRows(tctx.db, [sourceId], { lock: false })).get(sourceId);
    if (!source) throw new NotFoundError('기준 거래');
    const code = source.state.accountCode;
    if (source.state.classificationSource !== 'manual' || !code) {
      throw new ValidationError('담당자가 계정을 수정한 거래만 기준으로 쓸 수 있습니다. 먼저 수정(M)한 뒤 적용하세요.', [
        { field: 'transactionId', message: '수정되지 않은 거래' },
      ]);
    }
    const acc = accounts.get(code);
    if (!acc || !acc.active) {
      throw new ValidationError(`기준 거래의 계정(${code})을 계정과목표에서 찾을 수 없거나 사용하지 않는 계정입니다.`, [{ field: 'transactionId', message: '계정 없음' }]);
    }
    const r = await tctx.db.execute<{ id: string }>(sql`
      select t.id from transactions t where ${similarCond(source, code, scope)} order by t.transaction_date, t.id limit 5000
    `);
    const candidateIds = r.rows.map((x) => x.id);
    if (candidateIds.length === 0) return { count: 0, updatedIds: [], skipped: [], auditLogId: null, ruleSuggestion: null, warnings: [] };
    const locked = await lockActionRows(tctx.db, candidateIds, { withRaw: true });
    const preSkipped: SkippedItem[] = [];
    const rows: ActionRow[] = [];
    for (const id of candidateIds) {
      const row = locked.get(id);
      if (!row || row.status !== 'needs_review' || row.state.reviewedBy) continue; // 그 사이 다른 사람이 처리
      const individual = needsIndividualReview(row.riskFlags as RiskFlag[]);
      if (individual.length > 0) {
        const labels = [...new Set(individual.map((f) => BUCKET_LABELS[f.bucket] ?? f.bucket))].join(', ');
        preSkipped.push({ id, reason: `${labels} 위험이 있어 개별 검토가 필요합니다.` });
        continue;
      }
      rows.push(row);
    }
    const target: CorrectionTarget = { account: acc, vatType: null, vatDeductible: null, reason: `같은 가맹점 일괄 적용 (기준: ${txLabel(source)} ${source.transactionDate})` };
    return bulkCorrectCore(tctx, rows, target, accounts, {
      batchAction: 'transaction.correct_similar',
      batchSummary: (n) => `같은 가맹점 ${n}건 일괄 수정: ${source.merchantName} → ${acc.name}${clientScopeLabel([source.clientName])}`,
      summaryPrefix: '같은 가맹점 일괄 수정',
      preSkipped,
    });
  });
}

// ═══════════════════════════════ 제외 ═══════════════════════════════

/** 제외 (E) — 삭제하지 않고 status 'excluded' + 사유. 사유 없이는 제외할 수 없다. */
export async function excludeTransactions(ctx: ServiceContext, input: ExcludeInput): Promise<ExcludeResult> {
  requirePermission(ctx, 'transactions.review');
  const ids = normalizeIds(input?.ids);
  const reason = cleanText(input?.reason, 'reason', '제외 사유', { max: 200, required: true })!;
  const op = opContext(ctx);
  return op.db.transaction(async (trx) => {
    const tctx = withTx(op, trx);
    const rows = await lockActionRows(tctx.db, ids);
    const skipped: SkippedItem[] = [];
    const items: Array<{ row: ActionRow; before: TxState; after: TxState; summary: string; extra?: Record<string, unknown> }> = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) {
        skipped.push({ id, reason: NOT_FOUND_REASON });
        continue;
      }
      const blocked = exclusionBlockReason(row);
      if (blocked) {
        skipped.push({ id, reason: blocked });
        continue;
      }
      const after = reviewedState(tctx, row, { status: 'excluded', excludedReason: reason }, true);
      items.push({ row, before: row.state, after, summary: `${txLabel(row)} 제외 — ${reason}`, extra: { reason } });
    }
    if (items.length === 0) return { excluded: 0, excludedIds: [], skipped, auditLogId: null };
    await writeTxStates(tctx.db, items.map((i) => ({ id: i.row.id, state: i.after })), tctx.now());
    const auditLogId = await auditTxChanges(tctx, {
      action: 'transaction.exclude',
      batchAction: 'transaction.exclude_bulk',
      batchSummary: `${items.length}건 일괄 제외${clientScopeLabel(items.map((i) => i.row.clientName))} — ${reason}`,
      items,
    });
    await blockExportsFor(tctx, items.map((i) => i.row));
    return { excluded: items.length, excludedIds: items.map((i) => i.row.id), skipped, auditLogId };
  });
}
