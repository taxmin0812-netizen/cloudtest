/**
 * Rule Studio — 백테스트(미리보기)와 거래에서 규칙 만들기.
 */
import { sql } from 'drizzle-orm';
import { evaluateCondition, formatWon, type Condition, type Direction, type NormalizedTransaction } from '@mintax/core';
import { buildAccountMap, isAccountCompatible, transactionConditionContext } from '@mintax/core/engine/classify-index';
import { NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { FINALIZED_STATUSES, PENDING_STATUSES, addMonths, isUuid, kstDate } from '../classification/helpers';
import { loadAccountCodes } from '../classification/inputs';
import { createMappingRule, type MappingRuleDto, type VatOverrideInput } from './mapping-rules';
import {
  conditionIdentifiesParty,
  conditionMentionsDirection,
  deriveDescriptionKeyword,
  describeRuleCondition,
  mappingConditionErrors,
  validationFailure,
} from './describe';
import { requireAccount, requireClient } from './common';

export interface PreviewRuleInput {
  clientId: string;
  condition: Condition;
  accountCode: string;
  /** 백테스트 기간 (최근 N개월 확정 거래, 기본 3, 최대 24) */
  months?: number;
  /** 수정 중인 규칙 자신은 충돌 검사에서 제외 */
  excludeRuleId?: string;
  /** 바뀌는 거래 샘플 수 (기본 20, 최대 100) */
  sampleLimit?: number;
}

export interface RulePreviewSample {
  transactionId: string;
  transactionDate: string;
  merchantName: string;
  description: string;
  totalAmount: number;
  status: string;
  currentAccountCode: string | null;
  currentAccountName: string | null;
  newAccountCode: string;
  newAccountName: string;
}

export interface RulePreviewConflict {
  ruleId: string;
  name: string;
  accountCode: string;
  accountName: string;
  priority: number;
  /** 같은 거래에 함께 걸리는 건수 (결과 계정이 다른 것만) */
  overlap: number;
}

export interface RulePreviewResult {
  conditionText: string;
  accountCode: string;
  accountName: string;
  window: { from: string; to: string; months: number };
  /** 기간 안의 확정 거래 수 */
  scanned: number;
  /** 조건에 일치하는 확정 거래 */
  matchedHistory: number;
  /** 그 중 현재 계정이 다른 거래 (규칙이 있었다면 결과가 바뀌었을 거래) */
  wouldChange: number;
  unchanged: number;
  /** 아직 처리 전(imported/classified/needs_review) 거래 중 일치 — 다음 자동분류 때 이 규칙이 적용된다 */
  pendingMatched: number;
  samples: RulePreviewSample[];
  conflicts: RulePreviewConflict[];
  warnings: string[];
  /** 스캔 상한(50,000건)에 걸려 일부만 확인했는지 */
  truncated: boolean;
}

type PreviewRow = {
  id: string;
  transaction_date: string;
  direction: Direction;
  evidence_type: string;
  merchant_name: string;
  merchant_key: string;
  merchant_business_number: string | null;
  merchant_category: string | null;
  merchant_tax_type: string;
  description: string;
  supply_amount: number;
  vat_amount: number;
  total_amount: number;
  card_number_masked: string | null;
  currency: string;
  is_foreign: boolean;
  account_code: string | null;
  account_name: string | null;
  status: string;
  finalized: boolean;
};

const SCAN_LIMIT = 50_000;

function asTx(r: PreviewRow, clientId: string): NormalizedTransaction {
  return {
    clientId,
    businessNumber: '',
    source: 'manual',
    channel: 'manual_upload',
    direction: r.direction,
    transactionDate: r.transaction_date,
    evidenceType: r.evidence_type as NormalizedTransaction['evidenceType'],
    merchantName: r.merchant_name,
    merchantKey: r.merchant_key,
    merchantBusinessNumber: r.merchant_business_number,
    merchantCategory: r.merchant_category,
    merchantTaxType: (['general', 'simplified', 'exempt'].includes(r.merchant_tax_type) ? r.merchant_tax_type : 'unknown') as NormalizedTransaction['merchantTaxType'],
    description: r.description ?? '',
    supplyAmount: r.supply_amount,
    vatAmount: r.vat_amount,
    serviceCharge: 0,
    totalAmount: r.total_amount,
    cardNumberMasked: r.card_number_masked,
    approvalNumber: null,
    originalSourceId: null,
    currency: r.currency,
    isForeign: r.is_foreign,
    sourceDeductibleHint: null,
    rawData: {},
    sourceRowNumber: null,
    fingerprint: '',
  };
}

function safeEval(cond: Condition, cc: ReturnType<typeof transactionConditionContext>): boolean {
  try {
    return evaluateCondition(cond, cc);
  } catch {
    return false;
  }
}

/**
 * 규칙 백테스트: 최근 N개월 확정 거래 중 몇 건이 일치하고, 그 중 몇 건이 지금과 다른 계정이 되는지.
 * 활성화 전 안전장치 (Rule Studio "일치 27건 · 결과가 바뀌는 9건"). 권한: rules.read
 */
export async function previewRule(ctx: ServiceContext, input: PreviewRuleInput): Promise<RulePreviewResult> {
  requirePermission(ctx, 'rules.read');
  const errs = mappingConditionErrors(input.condition);
  if (errs.length > 0) throw validationFailure('규칙 조건을 확인하세요.', errs, 'condition');
  const client = await requireClient(ctx, input.clientId);
  const account = await requireAccount(ctx, input.accountCode);
  const months = Math.min(24, Math.max(1, Math.trunc(input.months ?? 3)));
  const sampleLimit = Math.min(100, Math.max(0, Math.trunc(input.sampleLimit ?? 20)));
  const today = kstDate(ctx.now());
  const from = `${addMonths(today.slice(0, 7), -(months - 1))}-01`;
  const final = sql.raw(`(${FINALIZED_STATUSES.map((s) => `'${s}'`).join(', ')})`);
  const pend = sql.raw(`(${PENDING_STATUSES.map((s) => `'${s}'`).join(', ')})`);

  const r = await ctx.db.execute<PreviewRow>(sql`
    select t.id, t.transaction_date, t.direction, t.evidence_type, t.merchant_name, t.merchant_key, t.merchant_business_number,
           t.merchant_category, t.merchant_tax_type, t.description, t.supply_amount, t.vat_amount, t.total_amount,
           t.card_number_masked, t.currency, t.is_foreign, t.account_code, t.account_name, t.status,
           (t.status in ${final}) as finalized
    from transactions t
    where t.client_id = ${client.id}
      and ((t.status in ${final} and t.transaction_date >= ${from} and t.transaction_date <= ${today}) or t.status in ${pend})
    order by t.transaction_date desc, t.id
    limit ${SCAN_LIMIT + 1}
  `);
  const truncated = r.rows.length > SCAN_LIMIT;
  const rows = truncated ? r.rows.slice(0, SCAN_LIMIT) : r.rows;
  const { accounts } = await loadAccountCodes(ctx.db);
  const accMap = buildAccountMap(accounts);
  const industry = { industry: client.industry as never };

  let scanned = 0;
  let matchedHistory = 0;
  let wouldChange = 0;
  let pendingMatched = 0;
  const samples: RulePreviewSample[] = [];
  const matchedCtx: Array<{ row: PreviewRow; cc: ReturnType<typeof transactionConditionContext> }> = [];
  for (const row of rows) {
    if (row.finalized) scanned += 1;
    const tx = asTx(row, client.id);
    const cc = transactionConditionContext(tx, industry, null);
    if (!safeEval(input.condition, cc)) continue;
    if (!isAccountCompatible(account.code, row.direction, accMap)) continue; // 엔진도 방향이 맞지 않는 계정 규칙은 적용하지 않는다
    matchedCtx.push({ row, cc });
    if (!row.finalized) {
      pendingMatched += 1;
      continue;
    }
    matchedHistory += 1;
    if (row.account_code !== account.code) {
      wouldChange += 1;
      if (samples.length < sampleLimit) {
        samples.push({
          transactionId: row.id,
          transactionDate: row.transaction_date,
          merchantName: row.merchant_name,
          description: row.description ?? '',
          totalAmount: row.total_amount,
          status: row.status,
          currentAccountCode: row.account_code,
          currentAccountName: row.account_name,
          newAccountCode: account.code,
          newAccountName: account.name,
        });
      }
    }
  }

  // 충돌: 같은 거래에 걸리는 다른 활성 규칙 (결과 계정이 다른 것)
  const others = await ctx.db.execute<{ id: string; name: string; condition: Condition; account_code: string; account_name: string; priority: number }>(sql`
    select id, name, condition, account_code, account_name, priority from mapping_rules
    where client_id = ${client.id} and status = 'active' and account_code <> ${account.code}
      ${input.excludeRuleId && isUuid(input.excludeRuleId) ? sql`and id <> ${input.excludeRuleId}` : sql``}
  `);
  const conflicts: RulePreviewConflict[] = [];
  for (const o of others.rows) {
    let overlap = 0;
    for (const m of matchedCtx) if (safeEval(o.condition, m.cc)) overlap += 1;
    if (overlap > 0) conflicts.push({ ruleId: o.id, name: o.name, accountCode: o.account_code, accountName: o.account_name, priority: o.priority, overlap });
  }
  conflicts.sort((a, b) => b.overlap - a.overlap || b.priority - a.priority);

  const warnings: string[] = [];
  if (!conditionIdentifiesParty(input.condition)) warnings.push('조건에 상호·사업자번호·적요가 없어 너무 많은 거래에 적용될 수 있습니다.');
  if (!conditionMentionsDirection(input.condition)) warnings.push('조건에 매입/매출 방향이 없습니다. 매입/매출 조건을 추가하는 것을 권장합니다.');
  if (matchedHistory === 0 && pendingMatched === 0) warnings.push(`최근 ${months}개월 거래 중 이 조건에 일치하는 거래가 없습니다. 조건을 확인하세요.`);
  if (matchedHistory > 0 && wouldChange * 2 > matchedHistory) {
    warnings.push(`일치 거래 ${matchedHistory}건 중 ${wouldChange}건이 지금과 다른 계정으로 바뀝니다. 과거 처리와 다른 규칙인지 확인하세요.`);
  }
  if (conflicts.length > 0) {
    const c = conflicts[0]!;
    warnings.push(`충돌: '${c.name}'(우선순위 ${c.priority}, ${c.accountCode} ${c.accountName}) 규칙도 같은 거래 ${c.overlap}건에 걸립니다.`);
  }
  if (truncated) warnings.push(`거래가 많아 최근 ${SCAN_LIMIT.toLocaleString('ko-KR')}건까지만 확인했습니다.`);

  return {
    conditionText: describeRuleCondition(input.condition),
    accountCode: account.code,
    accountName: account.name,
    window: { from, to: today, months },
    scanned,
    matchedHistory,
    wouldChange,
    unchanged: matchedHistory - wouldChange,
    pendingMatched,
    samples,
    conflicts,
    warnings,
    truncated,
  };
}

export type RuleScope = 'bizno' | 'merchant' | 'merchant_and_description';

export interface CreateRuleFromTransactionOptions {
  accountCode: string;
  scope: RuleScope;
  name?: string;
  /** merchant_and_description 일 때 적요 키워드 (생략하면 적요에서 자동 추출) */
  descriptionKeyword?: string;
  vatOverride?: VatOverrideInput;
  confidence?: number;
  priority?: number;
}

/** 거래 → 규칙 조건 (순수 함수, 단위 테스트 대상) */
export function buildConditionFromTransaction(
  tx: { direction: Direction; merchantKey: string; merchantBusinessNumber: string | null; description: string },
  scope: RuleScope,
  descriptionKeyword?: string,
): { condition: Condition; keyword: string | null } {
  const dir: Condition = { field: 'direction', op: 'eq', value: tx.direction };
  if (scope === 'bizno') {
    if (!tx.merchantBusinessNumber) {
      throw new ValidationError('이 거래에는 상대방 사업자번호가 없습니다. "상호 기준"으로 규칙을 만드세요.', [{ field: 'scope', message: '사업자번호 없음' }]);
    }
    return { condition: { all: [dir, { field: 'merchantBusinessNumber', op: 'eq', value: tx.merchantBusinessNumber }] }, keyword: null };
  }
  if (!tx.merchantKey) {
    throw new ValidationError('이 거래에는 상호가 없어 상호 기준 규칙을 만들 수 없습니다. 사업자번호 기준으로 만드세요.', [{ field: 'scope', message: '상호 없음' }]);
  }
  const merchant: Condition = { field: 'merchantKey', op: 'eq', value: tx.merchantKey };
  if (scope === 'merchant') return { condition: { all: [dir, merchant] }, keyword: null };
  const kw = descriptionKeyword?.trim() || deriveDescriptionKeyword(tx.description ?? '', tx.merchantKey);
  if (!kw) {
    throw new ValidationError('적요에서 규칙에 쓸 단어를 찾지 못했습니다. 적요 키워드를 직접 입력하거나 "상호 기준"으로 만드세요.', [
      { field: 'descriptionKeyword', message: '키워드 필요' },
    ]);
  }
  return { condition: { all: [dir, merchant, { field: 'description', op: 'contains', value: kw }] }, keyword: kw };
}

/**
 * 예외 검토 화면의 [규칙 R]: 거래 한 건에서 규칙을 만든다. 권한: rules.write (승인 권한 없으면 '제안').
 * 사람의 행동이므로 해당 거래의 touch_count 를 1 올린다.
 */
export async function createRuleFromTransaction(
  ctx: ServiceContext,
  transactionId: string,
  opts: CreateRuleFromTransactionOptions,
): Promise<MappingRuleDto> {
  requirePermission(ctx, 'rules.write');
  if (!isUuid(transactionId)) throw new NotFoundError('거래');
  const r = await ctx.db.execute<{
    id: string;
    client_id: string;
    direction: Direction;
    merchant_name: string;
    merchant_key: string;
    merchant_business_number: string | null;
    description: string;
    transaction_date: string;
    total_amount: number;
  }>(sql`
    select id, client_id, direction, merchant_name, merchant_key, merchant_business_number, description, transaction_date, total_amount
    from transactions where id = ${transactionId}
  `);
  const tx = r.rows[0];
  if (!tx) throw new NotFoundError('거래');
  if (!['bizno', 'merchant', 'merchant_and_description'].includes(opts.scope)) {
    throw new ValidationError('규칙 범위를 선택하세요 (사업자번호 / 상호 / 상호+적요).', [{ field: 'scope', message: '알 수 없는 범위' }]);
  }
  const { condition, keyword } = buildConditionFromTransaction(
    { direction: tx.direction, merchantKey: tx.merchant_key, merchantBusinessNumber: tx.merchant_business_number, description: tx.description },
    opts.scope,
    opts.descriptionKeyword,
  );
  const account = await requireAccount(ctx, opts.accountCode);
  const merchant = tx.merchant_name || tx.merchant_key;
  const name = opts.name?.trim() || `${merchant}${keyword ? `(${keyword})` : ''} → ${account.name}`;
  return ctx.db.transaction(async (trx) => {
    const tctx = withTx(ctx, trx);
    const rule = await createMappingRule(tctx, {
      clientId: tx.client_id,
      name: name.slice(0, 100),
      condition,
      accountCode: account.code,
      vatOverride: opts.vatOverride ?? null,
      confidence: opts.confidence,
      priority: opts.priority,
      suggestionReason: `거래에서 생성: ${tx.transaction_date} ${merchant} ${formatWon(tx.total_amount)}`,
    });
    await trx.execute(sql`update transactions set touch_count = touch_count + 1 where id = ${transactionId}`);
    return rule;
  });
}
