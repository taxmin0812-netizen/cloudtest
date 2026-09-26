/**
 * 자동분개 오케스트레이션 — 한 수임처·한 기간의 미처리 거래를 계정 → (AI) → 부가세 → 위험 → 판단 순서로 분류하고 저장한다.
 *
 * 원칙
 * - 사람이 이미 검토한 거래(reviewed_by 있음)와 확정 상태(approved/exported/…)는 건드리지 않는다.
 * - 쓰기는 한 DB 트랜잭션 안에서 청크(500건) 단위 일괄 처리: classification_results INSERT, transactions UPDATE ... FROM (VALUES ...).
 * - 사람 손길(touch_count)은 기록하지 않는다 (시스템 작업).
 * - 배치당 감사로그 1건: "9월 카드매입 500건 자동분류: 470건 자동확정, 30건 검토필요".
 */
import { sql } from 'drizzle-orm';
import { classificationResults, type Database } from '@mintax/db';
import {
  buildAiClassificationInput,
  buildClassificationContext,
  classifyAccount,
  hasSimilarHistory,
  mergeAiSuggestion,
  type ClassificationContext,
} from '@mintax/core/engine/classify-index';
import {
  adjustedVatConfidence,
  buildClientHistoryIndex,
  classifyVat,
  decide,
  evaluateRisks,
  lookupMerchantHistory,
  prepareRiskBatch,
  purchaseVatType,
  resolveRulesForClient,
  type VatOverride,
} from '@mintax/core/engine/vat-risk-index';
import type {
  AccountClassification,
  AIClassificationSuggestion,
  ClassificationSource,
  EvidenceType,
  ExceptionBucket,
  NormalizedTransaction,
  TransactionDecision,
  TransactionSource,
  IngestChannel,
  TransactionStatus,
  VatClassification,
} from '@mintax/core';
import { createAIProvider, type AIProvider } from '@mintax/ai';
import { NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { recordSystemError } from '../infra/system-errors';
import { loadClassificationInputs, type ClassificationInputs } from './inputs';
import {
  ENGINE_VERSION,
  RECLASSIFIABLE_STATUSES,
  assertPeriod,
  assertUuid,
  batchLabel,
  chunk,
  classificationSummaryText,
  emptyBucketCounts,
  emptySourceCounts,
  kstDate,
  mapWithConcurrency,
  withTimeout,
  yieldToEventLoop,
} from './helpers';

export interface ClassifyClientPeriodOptions {
  clientId: string;
  period: string;
  /** 분류 대상 상태 (기본 ['imported','classified']) */
  onlyStatuses?: TransactionStatus[];
  /** needs_review 도 다시 분류 (새 규칙 반영 등) */
  reclassifyNeedsReview?: boolean;
  /** 사람이 검토한 거래(reviewed_by 있음)도 다시 분류 — 명시 요청일 때만. 기본 false */
  includeReviewed?: boolean;
  jobId?: string | null;
  onProgress?: (processed: number, total: number) => void | Promise<void>;
  /** AI Provider 주입 (테스트). null = AI 사용 안 함. 생략 = createAIProvider() (환경변수 기준) */
  aiProvider?: AIProvider | null;
  /** 배치당 AI 에 물어볼 최대 상대방 수 (기본: 로컬 휴리스틱 500, 외부 LLM 30) */
  aiMaxMerchants?: number;
  /** 쓰기 청크 크기 (기본 500) */
  chunkSize?: number;
}

export interface ClassifyClientPeriodResult {
  clientId: string;
  period: string;
  /** 분류한 거래 수 */
  total: number;
  autoApproved: number;
  needsReview: number;
  unclassified: number;
  byBucket: Record<ExceptionBucket, number>;
  bySource: Record<ClassificationSource, number>;
  /** 최종 계정이 AI 추천으로 정해진 거래 수 */
  aiUsed: number;
  /** AI Provider 호출 수 (상대방 단위 캐시) */
  aiCalls: number;
  /** AI 호출 실패 수 (실패해도 파이프라인은 계속 — 해당 거래는 검토로 감) */
  aiFailed: number;
  /** AI 상한(aiMaxMerchants)을 넘어 AI 를 묻지 않은 상대방 수 */
  aiSkippedMerchants: number;
  aiProvider: string | null;
  /** 읽은 뒤 사람이 먼저 처리해서 건드리지 않은 거래 수 */
  skipped: number;
  /** 엔진 오류로 '미분류·검토필요' 처리한 거래 수 */
  errors: number;
  engineVersion: string;
  /** 배치 구성 라벨 ("카드매입" 등) */
  label: string;
  summary: string;
  durationMs: number;
  timings: { loadMs: number; computeMs: number; writeMs: number };
}

type BatchRow = {
  id: string;
  client_id: string;
  business_number: string;
  source: string;
  channel: string;
  direction: 'purchase' | 'sales';
  transaction_date: string;
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
  raw_data: Record<string, unknown> | null;
  fingerprint: string;
};

function toNormalized(r: BatchRow): NormalizedTransaction {
  const taxType = r.merchant_tax_type;
  return {
    clientId: r.client_id,
    businessNumber: r.business_number,
    source: r.source as TransactionSource,
    channel: r.channel as IngestChannel,
    direction: r.direction,
    transactionDate: r.transaction_date,
    evidenceType: r.evidence_type as EvidenceType,
    merchantName: r.merchant_name,
    merchantKey: r.merchant_key,
    merchantBusinessNumber: r.merchant_business_number,
    merchantCategory: r.merchant_category,
    merchantTaxType: taxType === 'general' || taxType === 'simplified' || taxType === 'exempt' ? taxType : 'unknown',
    description: r.description ?? '',
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
    rawData: r.raw_data ?? {},
    sourceRowNumber: null,
    fingerprint: r.fingerprint,
  };
}

let defaultProvider: AIProvider | null = null;
function getDefaultAiProvider(): AIProvider {
  defaultProvider ??= createAIProvider();
  return defaultProvider;
}

/** 테스트·설정 변경 후 Provider 재생성 */
export function resetClassificationAiProvider(): void {
  defaultProvider = null;
}

/** 분류 중 예외가 난 거래 — 조용히 버리지 않고 미분류·반드시 검토로 남긴다 */
function errorDecision(tx: NormalizedTransaction): TransactionDecision {
  const account: AccountClassification = {
    accountCode: null,
    accountName: null,
    confidence: 0,
    source: 'none',
    summary: '자동분류 중 오류가 발생해 사람이 확인해야 합니다',
    reasons: ['분류 엔진 처리 중 오류가 발생했습니다. 계정과 부가세를 직접 지정해 주세요. (오류는 시스템 오류 목록에 기록되었습니다)'],
    evidence: {},
    alternatives: [],
  };
  const vat: VatClassification = {
    vatType: tx.direction === 'sales' ? 'sales_other' : purchaseVatType(tx, null),
    deductible: null,
    nonDeductibleReasonCode: null,
    confidence: 0,
    summary: '검토 필요 — 자동분류 오류',
    reasons: [],
    ruleIds: [],
  };
  return { account, vat, risks: [], reviewLevel: 'must_review', status: 'needs_review', buckets: ['unclassified', 'vat_review', 'low_confidence'] };
}

interface Computed {
  tx: NormalizedTransaction;
  id: string;
  decision: TransactionDecision;
  score: number;
}

/** 엔진 규칙 id(사전 id 포함) → mapping_rules.id 로 근거를 바꿔 UI 가 규칙으로 바로 이동할 수 있게 한다 */
function withDbRuleId(acc: AccountClassification, ruleDbIds: Map<string, string>): AccountClassification {
  const rid = acc.evidence.ruleId;
  if (rid === undefined || rid === null) return acc;
  const dbId = ruleDbIds.get(String(rid));
  if (!dbId || dbId === rid) return acc;
  return { ...acc, evidence: { ...acc.evidence, ruleId: dbId } };
}

async function runAi(
  txs: readonly NormalizedTransaction[],
  accounts: AccountClassification[],
  ctx: ClassificationContext,
  provider: AIProvider,
  maxMerchants: number,
): Promise<{ calls: number; failed: number; skippedMerchants: number; firstError: unknown }> {
  const quick = ctx.policy.quickReviewMin;
  const groups = new Map<string, number[]>();
  accounts.forEach((acc, i) => {
    if (acc.source === 'user_rule' || acc.source === 'manual') return;
    if (acc.source !== 'none' && acc.confidence >= quick) return;
    const tx = txs[i]!;
    const key = `${tx.direction}|${tx.merchantKey || tx.merchantName}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });
  if (groups.size === 0) return { calls: 0, failed: 0, skippedMerchants: 0, firstError: null };
  // 영향이 큰(거래가 많은) 상대방부터
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const selected = ordered.slice(0, Math.max(0, maxMerchants));
  let failed = 0;
  let firstError: unknown = null;
  const suggestions = await mapWithConcurrency(selected, 4, async ([, idx]) => {
    const first = txs[idx[0]!]!;
    try {
      // buildAiClassificationInput 은 상호·적요를 scrubForAi 로 가리고 사업자번호·카드번호·원본행을 넣지 않는다
      const input = buildAiClassificationInput(first, ctx);
      return await withTimeout(provider.classifyTransaction(input), 30_000, 'AI 분류');
    } catch (e) {
      failed += 1;
      firstError ??= e;
      return null as AIClassificationSuggestion | null;
    }
  });
  selected.forEach(([, idx], gi) => {
    const suggestion = suggestions[gi] ?? null;
    if (!suggestion) return;
    const similar = hasSimilarHistory(txs[idx[0]!]!, ctx);
    for (const i of idx) {
      accounts[i] = mergeAiSuggestion(accounts[i]!, suggestion, { direction: txs[i]!.direction, context: ctx, hasSimilarHistory: similar });
    }
  });
  return { calls: selected.length, failed, skippedMerchants: ordered.length - selected.length, firstError };
}

/**
 * 한 수임처·한 기간 자동분류. 권한: transactions.review (worker 는 시스템 actor).
 */
export async function classifyClientPeriod(ctx: ServiceContext, opts: ClassifyClientPeriodOptions): Promise<ClassifyClientPeriodResult> {
  requirePermission(ctx, 'transactions.review');
  const started = performance.now();
  const period = assertPeriod(opts.period);
  const clientId = assertUuid(opts.clientId, '거래처');
  const statuses = new Set<TransactionStatus>(opts.onlyStatuses && opts.onlyStatuses.length > 0 ? opts.onlyStatuses : ['imported', 'classified']);
  if (opts.reclassifyNeedsReview) statuses.add('needs_review');
  for (const s of statuses) {
    if (!(RECLASSIFIABLE_STATUSES as readonly string[]).includes(s)) {
      throw new ValidationError(
        `'${s}' 상태의 거래는 다시 자동분류할 수 없습니다. 사람이 확정했거나 전송·대사된 거래는 재분류로 덮어쓰지 않습니다.`,
        [{ field: 'onlyStatuses', message: `허용: ${RECLASSIFIABLE_STATUSES.join(', ')}` }],
      );
    }
  }
  const statusList = [...statuses];
  const includeReviewed = opts.includeReviewed === true;
  const chunkSize = Math.min(1000, Math.max(50, Math.trunc(opts.chunkSize ?? 500)));
  const db = ctx.db;

  // ── 1. 분류 대상 적재 ──
  const tLoad = performance.now();
  const reviewedCond = includeReviewed ? sql`` : sql`and t.reviewed_by is null`;
  const batchR = await db.execute<BatchRow>(sql`
    select t.id, t.client_id, t.business_number, t.source, t.channel, t.direction, t.transaction_date, t.evidence_type,
           t.merchant_name, t.merchant_key, t.merchant_business_number, t.merchant_category, t.merchant_tax_type, t.description,
           t.supply_amount, t.vat_amount, t.service_charge, t.total_amount, t.card_number_masked, t.approval_number,
           t.original_source_id, t.currency, t.is_foreign, t.source_deductible_hint, t.raw_data, t.fingerprint
    from transactions t
    where t.client_id = ${clientId} and t.period = ${period}
      and t.status = any(${sql.param(statusList)}::text[])
      ${reviewedCond}
    order by t.transaction_date, t.id
  `);
  const rows = batchR.rows;
  const total = rows.length;
  const empty = (): ClassifyClientPeriodResult => ({
    clientId,
    period,
    total: 0,
    autoApproved: 0,
    needsReview: 0,
    unclassified: 0,
    byBucket: emptyBucketCounts(),
    bySource: emptySourceCounts(),
    aiUsed: 0,
    aiCalls: 0,
    aiFailed: 0,
    aiSkippedMerchants: 0,
    aiProvider: null,
    skipped: 0,
    errors: 0,
    engineVersion: ENGINE_VERSION,
    label: '거래',
    summary: `${Number(period.slice(5, 7))}월 자동분류 대상 거래가 없습니다`,
    durationMs: Math.round(performance.now() - started),
    timings: { loadMs: Math.round(performance.now() - tLoad), computeMs: 0, writeMs: 0 },
  });
  if (total === 0) {
    // 거래처 존재 확인 (없으면 NotFoundError)
    await loadClassificationInputsGuard(db, clientId);
    return empty();
  }
  await opts.onProgress?.(0, total);

  const txs = rows.map(toNormalized);
  const ids = rows.map((r) => r.id);
  const inputs = await loadClassificationInputs(db, {
    clientId,
    period,
    merchantKeys: txs.map((t) => t.merchantKey),
    bizNos: txs.map((t) => t.merchantBusinessNumber).filter((b): b is string => !!b),
    excludeTransactionIds: ids,
  });
  const loadMs = Math.round(performance.now() - tLoad);

  // ── 2. 판단 ──
  const tCompute = performance.now();
  const { client, policy } = inputs;
  const engineCtx = buildClassificationContext({
    client,
    rules: inputs.rules,
    history: inputs.history,
    peerHistory: inputs.peerHistory,
    corrections: inputs.corrections,
    accounts: inputs.accounts,
    policy,
    asOfDate: inputs.asOfDate,
  });

  const failedIdx = new Set<number>();
  let firstEngineError: unknown = null;
  const accounts: AccountClassification[] = new Array(total);
  for (let i = 0; i < total; i++) {
    try {
      accounts[i] = classifyAccount(txs[i]!, engineCtx);
    } catch (e) {
      failedIdx.add(i);
      firstEngineError ??= e;
      accounts[i] = errorDecision(txs[i]!).account;
    }
    if (i % 2000 === 1999) await yieldToEventLoop();
  }

  // AI: 미분류·저신뢰 거래만, 상대방 단위 캐시, 상한 N
  const provider = opts.aiProvider === null ? null : (opts.aiProvider ?? getDefaultAiProvider());
  let ai = { calls: 0, failed: 0, skippedMerchants: 0, firstError: null as unknown };
  if (provider) {
    const max = opts.aiMaxMerchants ?? (provider.name === 'heuristic' ? 500 : 30);
    const aiAccounts = accounts.map((a, i) => (failedIdx.has(i) ? { ...a, source: 'manual' as const } : a)); // 오류 건은 AI 대상 제외
    ai = await runAi(txs, aiAccounts, engineCtx, provider, max);
    for (let i = 0; i < total; i++) if (!failedIdx.has(i)) accounts[i] = aiAccounts[i]!;
  }

  // 위험 평가 준비 (배치 1회)
  const historyIndex = buildClientHistoryIndex(inputs.history);
  const riskCtx = prepareRiskBatch({
    client,
    rules: inputs.reviewRules,
    clientHistoryIndex: historyIndex,
    batch: txs,
    accountMonthlyTotals: inputs.accountMonthlyTotals,
    batchAccountCodes: accounts.map((a) => a.accountCode),
    ruleParams: client.ruleParams,
  });
  const mappingById = new Map(inputs.rules.map((r) => [String(r.id), r]));

  const computed: Computed[] = new Array(total);
  for (let i = 0; i < total; i++) {
    const tx = txs[i]!;
    let decision: TransactionDecision;
    if (failedIdx.has(i)) decision = errorDecision(tx);
    else {
      try {
        const acc = accounts[i]!;
        let override: VatOverride | null = null;
        if (acc.source === 'user_rule' && acc.evidence.ruleId !== undefined) {
          const rule = mappingById.get(String(acc.evidence.ruleId));
          if (rule?.vatOverride) {
            override = {
              deductible: rule.vatOverride.deductible,
              reasonCode: rule.vatOverride.reasonCode ?? null,
              ruleId: inputs.ruleDbIds.get(String(rule.id)) ?? String(rule.id),
              ruleName: rule.name,
            };
          }
        }
        const vat = classifyVat(tx, acc, { client, rules: inputs.vatRules, override });
        const risks = evaluateRisks(tx, acc, vat, riskCtx, { inBatch: true });
        decision = decide(tx, withDbRuleId(acc, inputs.ruleDbIds), vat, risks, policy, {
          isNewMerchant: !lookupMerchantHistory(historyIndex, tx),
        });
      } catch (e) {
        failedIdx.add(i);
        firstEngineError ??= e;
        decision = errorDecision(tx);
      }
    }
    const unclassified = !decision.account.accountCode;
    const score = Math.min(unclassified ? 0 : decision.account.confidence, adjustedVatConfidence(decision.vat, policy));
    computed[i] = { tx, id: ids[i]!, decision, score };
    if (i % 2000 === 1999) await yieldToEventLoop();
  }
  const computeMs = Math.round(performance.now() - tCompute);

  if (firstEngineError) {
    await recordSystemError(ctx, {
      area: 'classify',
      error: firstEngineError,
      userMessage: `자동분류 중 ${failedIdx.size}건에서 오류가 발생해 '미분류·검토필요'로 남겼습니다.`,
      context: { clientId, period, failed: failedIdx.size, engineVersion: ENGINE_VERSION },
    });
  }
  if (ai.firstError) {
    await recordSystemError(ctx, {
      area: 'classify',
      error: ai.firstError,
      userMessage: `AI 분류 추천 ${ai.failed}건이 실패했습니다. 해당 거래는 검토필요로 남습니다.`,
      context: { clientId, period, provider: provider?.name ?? null, failed: ai.failed },
    });
  }

  // ── 3. 저장 (한 트랜잭션) ──
  const tWrite = performance.now();
  const label = batchLabel(txs);
  const now = ctx.now();
  const vatDbIds = new Set(inputs.vatRules.map((r) => r.id).filter((x): x is string => !!x));
  const reviewCodeToId = new Map<string, string>();
  for (const r of resolveRulesForClient(inputs.reviewRules, clientId)) if (r.id) reviewCodeToId.set(r.code, r.id);

  const outcome = await db.transaction(async (trx) => {
    const tctx = withTx(ctx, trx);
    // 같은 수임처·기간 동시 분류 직렬화
    await trx.execute(sql`select pg_advisory_xact_lock(hashtext(${`classify:${clientId}:${period}`}))`);
    const reviewedLock = includeReviewed ? sql`` : sql`and reviewed_by is null`;
    const eligibleR = await trx.execute<{ id: string }>(sql`
      select id from transactions
      where id = any(${sql.param(ids)}::uuid[]) and status = any(${sql.param(statusList)}::text[]) ${reviewedLock}
      for update
    `);
    const eligible = new Set(eligibleR.rows.map((r) => r.id));
    const toWrite = computed.filter((c) => eligible.has(c.id));

    let autoApproved = 0;
    let needsReview = 0;
    let unclassified = 0;
    let aiUsed = 0;
    const byBucket = emptyBucketCounts();
    const bySource = emptySourceCounts();
    const mappingCounts = new Map<string, number>();
    const vatCounts = new Map<string, number>();
    const reviewCounts = new Map<string, number>();
    const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

    for (const c of toWrite) {
      const d = c.decision;
      if (d.status === 'auto_approved') autoApproved += 1;
      else needsReview += 1;
      if (!d.account.accountCode) unclassified += 1;
      for (const b of d.buckets) byBucket[b] = (byBucket[b] ?? 0) + 1;
      bySource[d.account.source] = (bySource[d.account.source] ?? 0) + 1;
      if (d.account.source === 'ai') aiUsed += 1;
      if ((d.account.source === 'user_rule' || d.account.source === 'system_rule') && d.account.evidence.ruleId !== undefined) {
        const dbId = inputs.ruleDbIds.get(String(d.account.evidence.ruleId));
        if (dbId) inc(mappingCounts, dbId);
      }
      const primaryVat = d.vat.ruleIds[0];
      if (primaryVat && vatDbIds.has(primaryVat)) inc(vatCounts, primaryVat);
      for (const f of d.risks) {
        const rid = reviewCodeToId.get(f.ruleCode);
        if (rid) inc(reviewCounts, rid);
      }
    }

    let written = 0;
    for (const part of chunk(toWrite, chunkSize)) {
      await trx.insert(classificationResults).values(
        part.map((c) => ({
          transactionId: c.id,
          engineVersion: ENGINE_VERSION,
          account: c.decision.account,
          vat: c.decision.vat,
          risks: c.decision.risks,
          reviewLevel: c.decision.reviewLevel,
          batchJobId: opts.jobId ?? null,
          createdAt: now,
        })),
      );
      const values = part.map((c) => {
        const a = c.decision.account;
        const v = c.decision.vat;
        return sql`(${c.id}::uuid, ${a.accountCode}::text, ${a.accountName}::text, ${a.accountCode ? a.confidence : 0}::int,
          ${a.source}::text, ${a.summary}::text, ${v.vatType}::text, ${v.deductible}::boolean, ${v.confidence}::int,
          ${v.nonDeductibleReasonCode}::text, ${c.score}::int, ${c.decision.reviewLevel}::text,
          ${JSON.stringify(c.decision.buckets)}::jsonb, ${JSON.stringify(c.decision.risks)}::jsonb, ${c.decision.status}::text)`;
      });
      await trx.execute(sql`
        update transactions as t set
          account_code = v.account_code, account_name = v.account_name, account_confidence = v.account_confidence,
          classification_source = v.classification_source, classification_summary = v.classification_summary,
          vat_type = v.vat_type, deductible = v.deductible, vat_confidence = v.vat_confidence, vat_reason_code = v.vat_reason_code,
          confidence_score = v.confidence_score, review_level = v.review_level, buckets = v.buckets, risk_flags = v.risk_flags,
          status = v.status, updated_at = ${now.toISOString()}::timestamptz
        from (values ${sql.join(values, sql`, `)}) as v(id, account_code, account_name, account_confidence, classification_source,
          classification_summary, vat_type, deductible, vat_confidence, vat_reason_code, confidence_score, review_level, buckets,
          risk_flags, status)
        where t.id = v.id
      `);
      written += part.length;
      await opts.onProgress?.(Math.min(total, written), total);
    }

    // 규칙 적용 통계 (집계 후 한 문장씩)
    const bump = async (table: 'mapping_rules' | 'vat_rules' | 'review_rules', counts: Map<string, number>) => {
      if (counts.size === 0) return;
      const vals = [...counts.entries()].map(([id, n]) => sql`(${id}::uuid, ${n}::int)`);
      await trx.execute(sql`
        update ${sql.identifier(table)} as r set applied_count = r.applied_count + v.n, last_applied_at = ${now.toISOString()}::timestamptz
        from (values ${sql.join(vals, sql`, `)}) as v(id, n) where r.id = v.id
      `);
    };
    await bump('mapping_rules', mappingCounts);
    await bump('vat_rules', vatCounts);
    await bump('review_rules', reviewCounts);

    const skipped = total - toWrite.length;
    const summary = classificationSummaryText({
      period,
      label,
      total: toWrite.length,
      autoApproved,
      needsReview,
      skipped,
      currentYear: Number(kstDate(now).slice(0, 4)),
    });
    if (toWrite.length > 0) {
      await writeAudit(tctx, {
        action: 'classification.batch',
        category: 'system',
        entityType: 'client_period',
        entityId: `${clientId}:${period}`,
        clientId,
        summary,
        after: {
          period,
          engineVersion: ENGINE_VERSION,
          jobId: opts.jobId ?? null,
          total: toWrite.length,
          autoApproved,
          needsReview,
          unclassified,
          skipped,
          errors: failedIdx.size,
          aiUsed,
          aiProvider: provider?.name ?? null,
          byBucket: Object.fromEntries(Object.entries(byBucket).filter(([, n]) => n > 0)),
          bySource: Object.fromEntries(Object.entries(bySource).filter(([, n]) => n > 0)),
          rulesApplied: { mapping: sumValues(mappingCounts), vat: sumValues(vatCounts), review: sumValues(reviewCounts) },
        },
      });
    }
    return { autoApproved, needsReview, unclassified, byBucket, bySource, aiUsed, skipped, written: toWrite.length, summary };
  });
  const writeMs = Math.round(performance.now() - tWrite);
  if (outcome.skipped > 0) await opts.onProgress?.(total, total);

  return {
    clientId,
    period,
    total: outcome.written,
    autoApproved: outcome.autoApproved,
    needsReview: outcome.needsReview,
    unclassified: outcome.unclassified,
    byBucket: outcome.byBucket,
    bySource: outcome.bySource,
    aiUsed: outcome.aiUsed,
    aiCalls: ai.calls,
    aiFailed: ai.failed,
    aiSkippedMerchants: ai.skippedMerchants,
    aiProvider: provider?.name ?? null,
    skipped: outcome.skipped,
    errors: failedIdx.size,
    engineVersion: ENGINE_VERSION,
    label,
    summary: outcome.summary,
    durationMs: Math.round(performance.now() - started),
    timings: { loadMs, computeMs, writeMs },
  };
}

function sumValues(m: Map<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}

/** 대상 거래가 0건일 때도 존재하지 않는 거래처면 NotFoundError 를 낸다 */
async function loadClassificationInputsGuard(db: Database, clientId: string): Promise<void> {
  const r = await db.execute<{ id: string }>(sql`select id from clients where id = ${clientId}`);
  if (r.rows.length === 0) throw new NotFoundError('거래처');
}

export type { ClassificationInputs };
