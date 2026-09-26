/**
 * 예외 검토 (review area) — DB 공용 도우미 (행 잠금·상태 쓰기·계정/부가세 규칙 적재·전송파일 차단·감사로그).
 * 서비스 함수가 아니므로 권한 검사는 호출하는 서비스가 한다.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '@mintax/db';
import {
  type AccountCode,
  type ClassificationSource,
  type Condition,
  type Direction,
  type ExceptionBucket,
  type NormalizedTransaction,
  type ReviewLevel,
  type RiskFlag,
  type TransactionStatus,
} from '@mintax/core';
import { DEFAULT_ACCOUNT_CODES, buildAccountMap } from '@mintax/core/engine/classify-index';
import { DEFAULT_VAT_RULES, type VatRuleDef } from '@mintax/core/engine/vat-risk-index';
import { systemActor, type ServiceContext } from '../context';
import { writeAudit, type AuditEntry } from '../infra/audit';
import { notifyProblem } from '../infra/notify';
import {
  BLOCKABLE_EXPORT_STATUSES,
  EXPORT_BLOCK_REASON,
  chunk,
  rowSummary,
  shortRiskFlags,
  toIso,
} from './helpers';
import type { AlternativeDto, ExceptionRow, TxState } from './types';

export const CHUNK = 500;

export function uuidArray(ids: readonly string[]): SQL {
  return sql`${sql.param([...ids])}::uuid[]`;
}
export function textArray(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::text[]`;
}

/** 한 작업(승인 42건 등)의 모든 기록이 같은 시각을 갖도록 시계를 고정한 컨텍스트 */
export function opContext(ctx: ServiceContext): ServiceContext {
  const fixed = ctx.now();
  return { ...ctx, now: () => fixed };
}

export function systemContext(ctx: ServiceContext): ServiceContext {
  return { ...ctx, actor: systemActor() };
}

// ────────────────────────────── 처리 대상 행 ──────────────────────────────

export interface ActionRow {
  id: string;
  clientId: string;
  clientName: string;
  businessNumber: string;
  period: string;
  status: TransactionStatus;
  direction: Direction;
  transactionDate: string;
  source: string;
  channel: string;
  evidenceType: string;
  merchantName: string;
  merchantKey: string;
  merchantBusinessNumber: string | null;
  merchantCategory: string | null;
  merchantTaxType: string;
  description: string;
  supplyAmount: number;
  vatAmount: number;
  serviceCharge: number;
  totalAmount: number;
  cardNumberMasked: string | null;
  approvalNumber: string | null;
  originalSourceId: string | null;
  currency: string;
  isForeign: boolean;
  sourceDeductibleHint: boolean | null;
  fingerprint: string;
  rawData: Record<string, unknown>;
  reviewLevel: ReviewLevel | null;
  riskFlags: RiskFlag[];
  touchCount: number;
  exportStatus: string | null;
  state: TxState;
}

type RawActionRow = {
  id: string;
  client_id: string;
  client_name: string;
  business_number: string;
  period: string;
  status: TransactionStatus;
  direction: Direction;
  transaction_date: string;
  source: string;
  channel: string;
  evidence_type: string;
  merchant_name: string;
  merchant_key: string;
  merchant_business_number: string | null;
  merchant_category: string | null;
  merchant_tax_type: string;
  description: string;
  supply_amount: number;
  vat_amount: number;
  service_charge: number;
  total_amount: number;
  card_number_masked: string | null;
  approval_number: string | null;
  original_source_id: string | null;
  currency: string;
  is_foreign: boolean;
  source_deductible_hint: boolean | null;
  fingerprint: string;
  raw_data: Record<string, unknown> | null;
  account_code: string | null;
  account_name: string | null;
  account_confidence: number | null;
  classification_source: ClassificationSource | null;
  classification_summary: string | null;
  vat_type: string | null;
  deductible: boolean | null;
  vat_confidence: number | null;
  vat_reason_code: string | null;
  confidence_score: number | null;
  review_level: ReviewLevel | null;
  buckets: ExceptionBucket[] | null;
  risk_flags: RiskFlag[] | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  excluded_reason: string | null;
  export_job_id: string | null;
  export_status: string | null;
  touch_count: number;
};

function mapActionRow(r: RawActionRow): ActionRow {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    businessNumber: r.business_number,
    period: r.period,
    status: r.status,
    direction: r.direction,
    transactionDate: r.transaction_date,
    source: r.source,
    channel: r.channel,
    evidenceType: r.evidence_type,
    merchantName: r.merchant_name,
    merchantKey: r.merchant_key,
    merchantBusinessNumber: r.merchant_business_number,
    merchantCategory: r.merchant_category,
    merchantTaxType: r.merchant_tax_type,
    description: r.description,
    supplyAmount: r.supply_amount,
    vatAmount: r.vat_amount,
    serviceCharge: r.service_charge,
    totalAmount: r.total_amount,
    cardNumberMasked: r.card_number_masked,
    approvalNumber: r.approval_number,
    originalSourceId: r.original_source_id,
    currency: r.currency,
    isForeign: r.is_foreign,
    sourceDeductibleHint: r.source_deductible_hint,
    fingerprint: r.fingerprint,
    rawData: r.raw_data ?? {},
    reviewLevel: r.review_level,
    riskFlags: Array.isArray(r.risk_flags) ? r.risk_flags : [],
    touchCount: r.touch_count,
    exportStatus: r.export_status,
    state: {
      status: r.status,
      accountCode: r.account_code,
      accountName: r.account_name,
      accountConfidence: r.account_confidence,
      classificationSource: r.classification_source,
      classificationSummary: r.classification_summary,
      vatType: r.vat_type,
      deductible: r.deductible,
      vatConfidence: r.vat_confidence,
      vatReasonCode: r.vat_reason_code,
      confidenceScore: r.confidence_score,
      reviewedBy: r.reviewed_by,
      reviewedAt: toIso(r.reviewed_at),
      excludedReason: r.excluded_reason,
      buckets: Array.isArray(r.buckets) ? r.buckets : [],
      exportJobId: r.export_job_id,
    },
  };
}

/**
 * 처리 대상 거래를 잠그고 읽는다 (SELECT … FOR UPDATE, id 순서 — 교착 방지). 1000건 단위.
 * withRaw: 부가세 재판단에 원본 행(시각 등)이 필요할 때만 raw_data 를 읽는다.
 */
export async function lockActionRows(db: Database, ids: readonly string[], opts: { withRaw?: boolean; lock?: boolean } = {}): Promise<Map<string, ActionRow>> {
  const out = new Map<string, ActionRow>();
  const raw = opts.withRaw ? sql`t.raw_data` : sql`null::jsonb`;
  const lock = opts.lock === false ? sql`` : sql`for update of t`;
  for (const part of chunk([...ids].sort(), 1000)) {
    const r = await db.execute<RawActionRow>(sql`
      select t.id, t.client_id, c.name as client_name, t.business_number, t.period, t.status, t.direction, t.transaction_date,
             t.source, t.channel, t.evidence_type, t.merchant_name, t.merchant_key, t.merchant_business_number, t.merchant_category,
             t.merchant_tax_type, t.description, t.supply_amount, t.vat_amount, t.service_charge, t.total_amount,
             t.card_number_masked, t.approval_number, t.original_source_id, t.currency, t.is_foreign, t.source_deductible_hint,
             t.fingerprint, ${raw} as raw_data,
             t.account_code, t.account_name, t.account_confidence, t.classification_source, t.classification_summary,
             t.vat_type, t.deductible, t.vat_confidence, t.vat_reason_code, t.confidence_score, t.review_level, t.buckets,
             t.risk_flags, t.reviewed_by, t.reviewed_at, t.excluded_reason, t.export_job_id, ej.status as export_status,
             t.touch_count
      from transactions t
      join clients c on c.id = t.client_id
      left join export_jobs ej on ej.id = t.export_job_id
      where t.id = any(${uuidArray(part)})
      order by t.id
      ${lock}
    `);
    for (const row of r.rows) out.set(row.id, mapActionRow(row));
  }
  return out;
}

/** 엔진 입력용 NormalizedTransaction (부가세 재판단) */
export function toNormalized(r: ActionRow): NormalizedTransaction {
  return {
    clientId: r.clientId,
    businessNumber: r.businessNumber,
    source: r.source as NormalizedTransaction['source'],
    channel: r.channel as NormalizedTransaction['channel'],
    direction: r.direction,
    transactionDate: r.transactionDate,
    evidenceType: r.evidenceType as NormalizedTransaction['evidenceType'],
    merchantName: r.merchantName,
    merchantKey: r.merchantKey,
    merchantBusinessNumber: r.merchantBusinessNumber,
    merchantCategory: r.merchantCategory,
    merchantTaxType: (['general', 'simplified', 'exempt'].includes(r.merchantTaxType) ? r.merchantTaxType : 'unknown') as NormalizedTransaction['merchantTaxType'],
    description: r.description,
    supplyAmount: r.supplyAmount,
    vatAmount: r.vatAmount,
    serviceCharge: r.serviceCharge,
    totalAmount: r.totalAmount,
    cardNumberMasked: r.cardNumberMasked,
    approvalNumber: r.approvalNumber,
    originalSourceId: r.originalSourceId,
    currency: r.currency,
    isForeign: r.isForeign,
    sourceDeductibleHint: r.sourceDeductibleHint,
    rawData: r.rawData,
    sourceRowNumber: null,
    fingerprint: r.fingerprint,
  };
}

// ────────────────────────────── 상태 쓰기 ──────────────────────────────

/**
 * 거래 상태를 일괄 기록 (UPDATE … FROM VALUES, 500건 단위). touch_count 는 행마다 +touchInc (기본 1 — 사람 처리 1회).
 * reviewed_by 가 그 사이 삭제된 사용자면 null 로 둔다 (FK 위반으로 되돌리기가 실패하지 않게).
 */
export async function writeTxStates(db: Database, entries: ReadonlyArray<{ id: string; state: TxState; touchInc?: number }>, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  for (const part of chunk(entries, CHUNK)) {
    const values = part.map(({ id, state: s, touchInc }) => sql`(${id}::uuid, ${s.status}::text, ${s.accountCode}::text, ${s.accountName}::text,
      ${s.accountConfidence}::int, ${s.classificationSource}::text, ${s.classificationSummary}::text, ${s.vatType}::text,
      ${s.deductible}::boolean, ${s.vatConfidence}::int, ${s.vatReasonCode}::text, ${s.confidenceScore}::int,
      ${s.reviewedBy}::uuid, ${s.reviewedAt}::timestamptz, ${s.excludedReason}::text, ${JSON.stringify(s.buckets ?? [])}::jsonb,
      ${s.exportJobId}::uuid, ${touchInc ?? 1}::int)`);
    await db.execute(sql`
      update transactions as t set
        status = v.status, account_code = v.account_code, account_name = v.account_name, account_confidence = v.account_confidence,
        classification_source = v.classification_source, classification_summary = v.classification_summary,
        vat_type = v.vat_type, deductible = v.deductible, vat_confidence = v.vat_confidence, vat_reason_code = v.vat_reason_code,
        confidence_score = v.confidence_score,
        reviewed_by = case when v.reviewed_by is null then null else (select u.id from users u where u.id = v.reviewed_by) end,
        reviewed_at = v.reviewed_at, excluded_reason = v.excluded_reason, buckets = v.buckets, export_job_id = v.export_job_id,
        touch_count = t.touch_count + v.touch_inc, updated_at = ${nowIso}::timestamptz
      from (values ${sql.join(values, sql`, `)}) as v(id, status, account_code, account_name, account_confidence, classification_source,
        classification_summary, vat_type, deductible, vat_confidence, vat_reason_code, confidence_score, reviewed_by, reviewed_at,
        excluded_reason, buckets, export_job_id, touch_inc)
      where t.id = v.id
    `);
  }
}

/** 거래 감사로그 1건 (before/after = TxState, 민감정보 없음) */
export function txAuditEntry(
  action: string,
  row: Pick<ActionRow, 'id' | 'clientId'>,
  before: TxState,
  after: TxState,
  summary: string,
  extra: { before?: Record<string, unknown>; after?: Record<string, unknown>; revertible?: boolean; revertOfId?: string | null } = {},
): AuditEntry {
  return {
    action,
    category: 'data_change',
    entityType: 'transaction',
    entityId: row.id,
    clientId: row.clientId,
    summary: summary.slice(0, 500),
    before: { ...before, ...(extra.before ?? {}) } as Record<string, unknown>,
    after: { ...after, ...(extra.after ?? {}) } as Record<string, unknown>,
    revertible: extra.revertible ?? true,
    revertOfId: extra.revertOfId ?? null,
  };
}

// ────────────────────────────── 계정과목 / 부가세 규칙 ──────────────────────────────

/** 계정과목표: account_codes, 비어 있으면 DEFAULT_ACCOUNT_CODES (분류 엔진과 같은 기준) */
export async function loadAccountMap(db: Database): Promise<{ map: Map<string, AccountCode>; source: 'db' | 'default' }> {
  const r = await db.execute<{ code: string; name: string; category: AccountCode['category']; is_fixed_asset: boolean; vat_non_deductible_hint: boolean; active: boolean }>(
    sql`select code, name, category, is_fixed_asset, vat_non_deductible_hint, active from account_codes`,
  );
  if (r.rows.length === 0) return { map: buildAccountMap(DEFAULT_ACCOUNT_CODES), source: 'default' };
  return {
    map: buildAccountMap(
      r.rows.map((a) => ({
        code: a.code,
        name: a.name,
        category: a.category,
        isFixedAsset: a.is_fixed_asset,
        vatNonDeductibleHint: a.vat_non_deductible_hint,
        active: a.active,
      })),
    ),
    source: 'db',
  };
}

/** 부가세 규칙: 공통 + 수임처 override. 공통 행이 없으면 DEFAULT_VAT_RULES 를 공통으로 (분류 엔진과 같은 기준) */
export async function loadVatRules(db: Database, clientId: string): Promise<VatRuleDef[]> {
  const r = await db.execute<{
    id: string;
    code: string;
    name: string;
    condition: Condition;
    outcome: VatRuleDef['outcome'];
    reason_text: string;
    legal_basis: string | null;
    confidence: number;
    priority: number;
    client_id: string | null;
    active: boolean;
  }>(sql`
    select id, code, name, condition, outcome, reason_text, legal_basis, confidence, priority, client_id, active
    from vat_rules where client_id is null or client_id = ${clientId}::uuid
  `);
  const rows: VatRuleDef[] = r.rows.map((x) => ({
    id: x.id,
    code: x.code,
    name: x.name,
    condition: x.condition,
    outcome: x.outcome,
    reasonText: x.reason_text,
    legalBasis: x.legal_basis,
    confidence: x.confidence,
    priority: x.priority,
    clientId: x.client_id,
    active: x.active,
  }));
  if (rows.some((x) => !x.clientId)) return rows;
  return [...DEFAULT_VAT_RULES.map((d) => ({ ...d, clientId: null, active: true })), ...rows];
}

// ────────────────────────────── 전송파일 차단 ──────────────────────────────

/**
 * 아직 아무도 받지 않은(ready) 전송파일에 포함된 거래가 바뀌면 그 파일을 즉시 차단한다 (docs/03 §4.2 이중 기장 방지).
 * 차단은 시스템 조치로 감사로그를 남기고, 문제 알림(export_error)을 만든다. 반환: 차단한 파일 수.
 */
export async function blockExportJobsForChange(ctx: ServiceContext, changes: ReadonlyArray<{ exportJobId: string; label: string }>): Promise<number> {
  const byJob = new Map<string, string[]>();
  for (const c of changes) (byJob.get(c.exportJobId) ?? byJob.set(c.exportJobId, []).get(c.exportJobId)!).push(c.label);
  if (byJob.size === 0) return 0;
  const statuses = [...BLOCKABLE_EXPORT_STATUSES];
  const r = await ctx.db.execute<{ id: string; client_id: string; period: string }>(sql`
    update export_jobs set status = 'blocked', blocked_reason = ${EXPORT_BLOCK_REASON}
    where id = any(${uuidArray([...byJob.keys()])}) and status = any(${textArray(statuses)})
    returning id, client_id, period
  `);
  const sys = systemContext(ctx);
  for (const job of r.rows) {
    const labels = byJob.get(job.id) ?? [];
    const detail = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` 외 ${labels.length - 3}건` : '');
    await writeAudit(sys, {
      action: 'export.block',
      category: 'system',
      entityType: 'export_job',
      entityId: job.id,
      clientId: job.client_id,
      summary: `WEHAGO 전송파일 차단 (${job.period}): 포함 거래 변경 — ${detail}`,
      before: { status: 'ready' },
      after: { status: 'blocked', blockedReason: EXPORT_BLOCK_REASON, changedBy: ctx.actor.name },
    });
    await notifyProblem(ctx, {
      kind: 'export_error',
      severity: 'warning',
      title: `${job.period} WEHAGO 전송파일을 다시 만들어야 합니다`,
      body: `${ctx.actor.name}님이 파일에 포함된 거래를 변경했습니다 (${detail}). 받기 전인 파일이라 차단했습니다. 전송센터에서 파일을 다시 만드세요.`,
      href: `/transfer?client=${job.client_id}&period=${job.period}`,
      clientId: job.client_id,
      dedupeKey: `export_blocked:${job.id}`,
    });
  }
  return r.rows.length;
}

// ────────────────────────────── 예외함 행 (목록·처리결과 공용) ──────────────────────────────

export const EXCEPTION_ROW_COLUMNS = sql`t.id, t.client_id, c.name as client_name, t.period, t.transaction_date, t.direction, t.merchant_name,
  t.merchant_business_number, t.description, t.supply_amount, t.vat_amount, t.total_amount, t.evidence_type, t.account_code,
  t.account_name, t.classification_source, t.vat_type, t.deductible, t.confidence_score, t.account_confidence, t.vat_confidence,
  t.classification_summary, t.buckets, t.risk_flags, t.review_level, t.status, t.touch_count, t.reviewed_at`;

export type RawExceptionRow = {
  id: string;
  client_id: string;
  client_name: string;
  period: string;
  transaction_date: string;
  direction: Direction;
  merchant_name: string;
  merchant_business_number: string | null;
  description: string;
  supply_amount: number;
  vat_amount: number;
  total_amount: number;
  evidence_type: string;
  account_code: string | null;
  account_name: string | null;
  classification_source: ClassificationSource | null;
  vat_type: string | null;
  deductible: boolean | null;
  confidence_score: number | null;
  account_confidence: number | null;
  vat_confidence: number | null;
  classification_summary: string | null;
  buckets: ExceptionBucket[] | null;
  risk_flags: RiskFlag[] | null;
  review_level: ReviewLevel | null;
  status: TransactionStatus;
  touch_count: number;
  reviewed_at: Date | string | null;
  alternatives: unknown;
};

function mapAlternatives(raw: unknown, current: string | null): AlternativeDto[] {
  if (!Array.isArray(raw)) return [];
  const out: AlternativeDto[] = [];
  for (const a of raw as Array<Record<string, unknown>>) {
    if (!a || typeof a !== 'object' || typeof a.accountCode !== 'string' || a.accountCode === current) continue;
    if (out.some((o) => o.accountCode === a.accountCode)) continue;
    out.push({
      accountCode: a.accountCode,
      accountName: typeof a.accountName === 'string' ? a.accountName : a.accountCode,
      confidence: typeof a.confidence === 'number' ? Math.round(a.confidence) : 0,
      source: (typeof a.source === 'string' ? a.source : 'none') as ClassificationSource,
    });
  }
  return out.sort((x, y) => y.confidence - x.confidence).slice(0, 3);
}

export function mapExceptionRow(r: RawExceptionRow): ExceptionRow {
  const buckets = Array.isArray(r.buckets) ? r.buckets : [];
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    period: r.period,
    date: r.transaction_date,
    direction: r.direction,
    merchantName: r.merchant_name,
    merchantBusinessNumber: r.merchant_business_number,
    description: r.description,
    supplyAmount: r.supply_amount,
    vatAmount: r.vat_amount,
    totalAmount: r.total_amount,
    evidenceType: r.evidence_type,
    accountCode: r.account_code,
    accountName: r.account_name,
    classificationSource: r.classification_source,
    vatType: r.vat_type,
    deductible: r.deductible,
    confidence: r.confidence_score,
    accountConfidence: r.account_confidence,
    vatConfidence: r.vat_confidence,
    summary: rowSummary({ classificationSummary: r.classification_summary, accountCode: r.account_code, status: r.status, buckets }),
    buckets,
    riskFlags: shortRiskFlags(r.risk_flags),
    reviewLevel: r.review_level,
    status: r.status,
    alternatives: mapAlternatives(r.alternatives, r.account_code),
    touchCount: r.touch_count,
    reviewedAt: toIso(r.reviewed_at),
  };
}

/** 최신 분류 결과의 대안 후보 (행마다 인덱스 1회 조회: classification_results_tx_idx) */
export const LATEST_ALTERNATIVES_JOIN = (alias: SQL) => sql`left join lateral (
    select r.account -> 'alternatives' as alternatives from classification_results r
    where r.transaction_id = ${alias} order by r.created_at desc limit 1
  ) cr on true`;

export async function loadExceptionRowsByIds(db: Database, ids: readonly string[]): Promise<Map<string, ExceptionRow>> {
  const out = new Map<string, ExceptionRow>();
  if (ids.length === 0) return out;
  for (const part of chunk(ids, 1000)) {
    const r = await db.execute<RawExceptionRow>(sql`
      select ${EXCEPTION_ROW_COLUMNS}, cr.alternatives
      from transactions t
      join clients c on c.id = t.client_id
      ${LATEST_ALTERNATIVES_JOIN(sql`t.id`)}
      where t.id = any(${uuidArray(part)})
    `);
    for (const row of r.rows) out.set(row.id, mapExceptionRow(row));
  }
  return out;
}
