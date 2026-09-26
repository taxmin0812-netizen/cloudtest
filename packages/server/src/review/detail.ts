/**
 * 거래 상세 (Explainability 패널): 분류 근거·부가세 규칙·위험·같은 상대방 이력·수정 이력·적용 규칙·원본 행·변경 이력.
 * 쿼리는 모두 인덱스 조회 (거래 1 + 병렬 8). 원본 행은 스크럽(카드번호 마스킹·주민번호/계좌 가림) 후 반환.
 */
import { sql } from 'drizzle-orm';
import {
  evaluateCondition,
  type AccountClassification,
  type ClassificationSource,
  type Condition,
  type ExceptionBucket,
  type NormalizedTransaction,
  type ReviewLevel,
  type RiskFlag,
  type TransactionStatus,
  type VatClassification,
  type VatType,
} from '@mintax/core';
import { transactionConditionContext } from '@mintax/core/engine/classify-index';
import { DEFAULT_VAT_RULES } from '@mintax/core/engine/vat-risk-index';
import { NotFoundError } from '@mintax/security';
import { hasPermission, requirePermission, type ServiceContext } from '../context';
import {
  BUCKET_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
  VAT_TYPE_LABELS,
  assertUuid,
  bulkIdOf,
  cardLast4,
  displayReason,
  rowSummary,
  scrubRawData,
  shortRiskFlags,
  toIso,
} from './helpers';
import { textArray } from './shared';
import type { TransactionDetail } from './types';

type TxRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_code: string;
  industry: string | null;
  period: string;
  transaction_date: string;
  direction: 'purchase' | 'sales';
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
  currency: string;
  is_foreign: boolean;
  card_number_masked: string | null;
  approval_number: string | null;
  original_source_id: string | null;
  source_deductible_hint: boolean | null;
  fingerprint: string;
  business_number: string;
  raw_data: Record<string, unknown> | null;
  status: TransactionStatus;
  touch_count: number;
  reviewed_by: string | null;
  reviewer_name: string | null;
  reviewed_at: Date | string | null;
  excluded_reason: string | null;
  duplicate_of_id: string | null;
  duplicate_reason: string | null;
  export_job_id: string | null;
  export_status: string | null;
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
  import_job_id: string | null;
};

export async function getTransactionDetail(ctx: ServiceContext, id: string): Promise<TransactionDetail> {
  requirePermission(ctx, 'transactions.read');
  const txId = assertUuid(id, 'id');
  const r = await ctx.db.execute<TxRow>(sql`
    select t.*, c.name as client_name, c.code as client_code, p.industry, u.name as reviewer_name, ej.status as export_status
    from transactions t
    join clients c on c.id = t.client_id
    left join client_business_profiles p on p.client_id = t.client_id
    left join users u on u.id = t.reviewed_by
    left join export_jobs ej on ej.id = t.export_job_id
    where t.id = ${txId}::uuid
  `);
  const t = r.rows[0];
  if (!t) throw new NotFoundError('거래');
  const bizno = t.merchant_business_number;
  const party = bizno ? sql`(x.merchant_business_number = ${bizno} or x.merchant_key = ${t.merchant_key})` : sql`x.merchant_key = ${t.merchant_key}`;

  const [crR, histR, corrR, rulesR, srcR, auditR, simR] = await Promise.all([
    ctx.db.execute<{ engine_version: string; account: AccountClassification; vat: VatClassification; created_at: Date | string; runs: number }>(sql`
      select r.engine_version, r.account, r.vat, r.created_at, count(*) over ()::int as runs
      from classification_results r where r.transaction_id = ${txId}::uuid
      order by r.created_at desc limit 1
    `),
    ctx.db.execute<{
      id: string;
      period: string;
      transaction_date: string;
      total_amount: number;
      account_code: string | null;
      account_name: string | null;
      status: TransactionStatus;
      classification_source: string | null;
      reviewed_by: string | null;
      corrected: boolean;
    }>(sql`
      select x.id, x.period, x.transaction_date, x.total_amount, x.account_code, x.account_name, x.status, x.classification_source,
             x.reviewed_by,
             (x.classification_source = 'manual' or exists (
               select 1 from classification_corrections cc where cc.transaction_id = x.id and cc.field = 'account'
             )) as corrected
      from transactions x
      where x.client_id = ${t.client_id}::uuid and x.id <> ${txId}::uuid and ${party}
        and x.status not in ('duplicate', 'failed')
      order by x.transaction_date desc, x.id desc
      limit 20
    `),
    ctx.db.execute<{
      id: string;
      transaction_id: string;
      field: 'account' | 'vat';
      before_value: string | null;
      before_label: string | null;
      after_value: string;
      after_label: string | null;
      before_source: string | null;
      before_confidence: number | null;
      reason: string | null;
      user_name: string | null;
      created_at: Date | string;
      suggested_rule_id: string | null;
    }>(sql`
      select x.id, x.transaction_id, x.field, x.before_value, x.before_label, x.after_value, x.after_label, x.before_source,
             x.before_confidence, x.reason, u.name as user_name, x.created_at, x.suggested_rule_id
      from classification_corrections x
      left join users u on u.id = x.user_id
      where x.client_id = ${t.client_id}::uuid and ${party}
      order by x.created_at desc
      limit 50
    `),
    ctx.db.execute<{
      id: string;
      client_id: string | null;
      name: string;
      condition: Condition;
      account_code: string;
      account_name: string;
      status: string;
      origin: string;
      priority: number;
      confidence: number;
      suggestion_reason: string | null;
    }>(sql`
      select id, client_id, name, condition, account_code, account_name, status, origin, priority, confidence, suggestion_reason
      from mapping_rules
      where (client_id = ${t.client_id}::uuid and status in ('active', 'suggested'))
         or (client_id is null and status = 'active')
    `),
    ctx.db.execute<{ row_number: number; raw_data: Record<string, unknown>; import_job_id: string; format_profile: string | null; file_name: string | null }>(sql`
      select s.row_number, s.raw_data, s.import_job_id, j.format_profile, f.original_name as file_name
      from transaction_sources s
      left join import_jobs j on j.id = s.import_job_id
      left join files f on f.id = j.file_id
      where s.transaction_id = ${txId}::uuid
      order by s.created_at asc
      limit 1
    `),
    ctx.db.execute<{ id: string; action: string; actor_name: string; summary: string; created_at: Date | string; revertible: boolean; reverted_by_id: string | null; revert_of_id: string | null }>(sql`
      select id, action, actor_name, summary, created_at, revertible, reverted_by_id, revert_of_id
      from audit_logs where entity_type = 'transaction' and entity_id = ${txId}
      order by created_at desc, id desc
      limit 50
    `),
    ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from transactions x
      where x.client_id = ${t.client_id}::uuid and x.id <> ${txId}::uuid and x.period = ${t.period} and x.status = 'needs_review'
        and x.reviewed_by is null and x.direction = ${t.direction}
        and ${bizno ? sql`x.merchant_business_number = ${bizno}` : sql`x.merchant_key = ${t.merchant_key}`}
    `),
  ]);

  const engine = crR.rows[0] ?? null;

  // 부가세 규칙 근거 (엔진 ruleIds = DB id 또는 기본 규칙 code)
  const ruleRefs = engine?.vat?.ruleIds ?? [];
  let vatRules: TransactionDetail['vatRules'] = [];
  if (ruleRefs.length > 0) {
    const vr = await ctx.db.execute<{ id: string; code: string; name: string; outcome: string; reason_text: string; legal_basis: string | null }>(sql`
      select id, code, name, outcome, reason_text, legal_basis from vat_rules
      where id::text = any(${textArray(ruleRefs)}) or (code = any(${textArray(ruleRefs)}) and (client_id is null or client_id = ${t.client_id}::uuid))
    `);
    const byRef = new Map<string, (typeof vr.rows)[number]>();
    for (const x of vr.rows) {
      byRef.set(x.id, x);
      if (!byRef.has(x.code)) byRef.set(x.code, x);
    }
    const seen = new Set<string>();
    for (const ref of ruleRefs) {
      const x = byRef.get(ref);
      const d = x ? null : DEFAULT_VAT_RULES.find((v) => v.code === ref || v.id === ref);
      const item = x
        ? { code: x.code, name: x.name, outcome: x.outcome, reasonText: x.reason_text, legalBasis: x.legal_basis }
        : d
          ? { code: d.code, name: d.name, outcome: d.outcome, reasonText: d.reasonText, legalBasis: d.legalBasis }
          : null;
      if (item && !seen.has(item.code)) {
        seen.add(item.code);
        vatRules.push(item);
      }
    }
    vatRules = vatRules.slice(0, 10);
  }

  // 적용 가능한 매핑 규칙 (조건을 이 거래로 평가)
  const normalized: NormalizedTransaction = {
    clientId: t.client_id,
    businessNumber: t.business_number,
    source: t.source as NormalizedTransaction['source'],
    channel: t.channel as NormalizedTransaction['channel'],
    direction: t.direction,
    transactionDate: t.transaction_date,
    evidenceType: t.evidence_type as NormalizedTransaction['evidenceType'],
    merchantName: t.merchant_name,
    merchantKey: t.merchant_key,
    merchantBusinessNumber: t.merchant_business_number,
    merchantCategory: t.merchant_category,
    merchantTaxType: (['general', 'simplified', 'exempt'].includes(t.merchant_tax_type) ? t.merchant_tax_type : 'unknown') as NormalizedTransaction['merchantTaxType'],
    description: t.description,
    supplyAmount: t.supply_amount,
    vatAmount: t.vat_amount,
    serviceCharge: t.service_charge,
    totalAmount: t.total_amount,
    cardNumberMasked: t.card_number_masked,
    approvalNumber: t.approval_number,
    originalSourceId: t.original_source_id,
    currency: t.currency,
    isForeign: t.is_foreign,
    sourceDeductibleHint: t.source_deductible_hint,
    rawData: {},
    sourceRowNumber: null,
    fingerprint: t.fingerprint,
  };
  const condCtx = transactionConditionContext(normalized, { industry: (t.industry ?? 'other') as never }, null);
  const engineRuleId = engine?.account?.evidence?.ruleId !== undefined ? String(engine.account.evidence.ruleId) : null;
  const engineRuleName = engine?.account?.evidence?.ruleName ?? null;
  const applicableRules: TransactionDetail['applicableRules'] = [];
  for (const rule of rulesR.rows) {
    let match = false;
    try {
      match = evaluateCondition(rule.condition, condCtx);
    } catch {
      match = false;
    }
    if (!match) continue;
    applicableRules.push({
      id: rule.id,
      name: rule.name,
      accountCode: rule.account_code,
      accountName: rule.account_name,
      status: rule.status,
      origin: rule.origin,
      priority: rule.priority,
      confidence: rule.confidence,
      scope: rule.client_id ? 'client' : 'global',
      usedByEngine: engineRuleId === rule.id || (!!engineRuleName && engineRuleName === rule.name && engine?.account?.accountCode === rule.account_code),
      suggestionReason: rule.suggestion_reason,
    });
  }
  applicableRules.sort((a, b) => Number(b.usedByEngine) - Number(a.usedByEngine) || (a.scope === b.scope ? 0 : a.scope === 'client' ? -1 : 1) || b.priority - a.priority);

  const buckets = Array.isArray(t.buckets) ? t.buckets : [];
  const src = srcR.rows[0];
  const canRevert = hasPermission(ctx, 'audit.revert');
  const current = {
    accountCode: t.account_code,
    accountName: t.account_name,
    confidence: t.account_confidence,
    source: t.classification_source,
    sourceLabel: t.classification_source ? SOURCE_LABELS[t.classification_source] ?? t.classification_source : '미분류',
    summary: rowSummary({ classificationSummary: t.classification_summary, accountCode: t.account_code, status: t.status, buckets }),
    vatType: t.vat_type,
    vatTypeLabel: t.vat_type ? VAT_TYPE_LABELS[t.vat_type as VatType] ?? t.vat_type : null,
    deductible: t.deductible,
    vatConfidence: t.vat_confidence,
    vatReasonCode: t.vat_reason_code,
    confidenceScore: t.confidence_score,
    reviewLevel: t.review_level,
  };

  return {
    transaction: {
      id: t.id,
      clientId: t.client_id,
      clientName: t.client_name,
      clientCode: t.client_code,
      period: t.period,
      date: t.transaction_date,
      direction: t.direction,
      source: t.source,
      channel: t.channel,
      evidenceType: t.evidence_type,
      merchantName: t.merchant_name,
      merchantKey: t.merchant_key,
      merchantBusinessNumber: t.merchant_business_number,
      merchantCategory: t.merchant_category,
      merchantTaxType: t.merchant_tax_type,
      description: t.description,
      supplyAmount: t.supply_amount,
      vatAmount: t.vat_amount,
      serviceCharge: t.service_charge,
      totalAmount: t.total_amount,
      currency: t.currency,
      isForeign: t.is_foreign,
      cardLast4: cardLast4(t.card_number_masked),
      approvalNumber: t.approval_number,
      status: t.status,
      statusLabel: STATUS_LABELS[t.status] ?? t.status,
      touchCount: t.touch_count,
      reviewedBy: t.reviewed_by ? { id: t.reviewed_by, name: t.reviewer_name ?? '(삭제된 사용자)' } : null,
      reviewedAt: toIso(t.reviewed_at),
      excludedReason: t.excluded_reason,
      duplicateOfId: t.duplicate_of_id,
      duplicateReason: t.duplicate_reason,
      exportJob: t.export_job_id ? { id: t.export_job_id, status: t.export_status ?? 'unknown' } : null,
    },
    classification: {
      current,
      engine: engine
        ? { account: engine.account, vat: engine.vat, engineVersion: engine.engine_version, classifiedAt: toIso(engine.created_at), runs: engine.runs }
        : null,
      overriddenByHuman:
        !!engine && (engine.account?.accountCode !== t.account_code || engine.vat?.deductible !== t.deductible || engine.vat?.vatType !== t.vat_type),
      buckets: buckets.map((b) => ({ bucket: b, label: BUCKET_LABELS[b] ?? b })),
    },
    vatRules,
    riskFlags: shortRiskFlags(t.risk_flags),
    merchantHistory: histR.rows.map((h) => ({
      id: h.id,
      period: h.period,
      date: h.transaction_date,
      totalAmount: h.total_amount,
      accountCode: h.account_code,
      accountName: h.account_name,
      status: h.status,
      corrected: h.corrected,
      processedBy: h.reviewed_by ? 'human' : h.status === 'auto_approved' || h.status === 'exported' || h.status === 'reconciled' ? 'auto' : 'pending',
    })),
    corrections: corrR.rows.map((c) => ({
      id: c.id,
      transactionId: c.transaction_id,
      field: c.field,
      before: c.before_value,
      beforeLabel: c.before_label,
      after: c.after_value,
      afterLabel: c.after_label,
      beforeSource: c.before_source,
      beforeConfidence: c.before_confidence,
      reason: displayReason(c.reason),
      bulk: bulkIdOf(c.reason) !== null,
      userName: c.user_name,
      createdAt: toIso(c.created_at)!,
      suggestedRuleId: c.suggested_rule_id,
    })),
    applicableRules: applicableRules.slice(0, 20),
    sourceRow: src
      ? {
          fileName: src.file_name,
          importJobId: src.import_job_id,
          formatProfile: src.format_profile,
          rowNumber: src.row_number,
          rawData: scrubRawData(src.raw_data) as Record<string, unknown>,
        }
      : t.raw_data && Object.keys(t.raw_data).length > 0
        ? { fileName: null, importJobId: t.import_job_id, formatProfile: null, rowNumber: null, rawData: scrubRawData(t.raw_data) as Record<string, unknown> }
        : null,
    auditTrail: auditR.rows.map((a) => ({
      id: a.id,
      action: a.action,
      actorName: a.actor_name,
      summary: a.summary,
      createdAt: toIso(a.created_at)!,
      revertible: a.revertible,
      reverted: !!a.reverted_by_id,
      revertOfId: a.revert_of_id,
      canRevert: canRevert && a.revertible && !a.reverted_by_id,
    })),
    similarPending: simR.rows[0]?.n ?? 0,
  };
}
