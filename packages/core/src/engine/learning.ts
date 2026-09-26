import type {
  AccountClassification,
  AccountCode,
  ClassificationSource,
  Condition,
  ConfidencePolicy,
  CorrectionRecord,
  Direction,
  MappingRule,
  NormalizedTransaction,
  UUID,
} from '../types';
import { evaluateCondition, type ConditionContext } from '../dsl';
import { sha256Hex } from '../hash';
import { formatBusinessNumber } from '../normalize';
import { accountDirection, buildAccountMap, DEFAULT_ACCOUNT_CODES } from '../data/accounts';
import { compareCorrection, latestCorrectionPerTransaction, type DirectedCorrectionRecord } from './history';

/**
 * 학습 루프 — 직원 수정(CorrectionRecord)에서 영구 규칙 "제안"을 만든다.
 * 제안은 항상 status 'suggested' / origin 'system_suggested' 이며, 사람이 승인(rules.approve)해야 active 가 된다.
 */

export interface RuleSuggestion {
  /** 제안 규칙 (status 'suggested', origin 'system_suggested'). id 는 결정적 해시 — DB 저장 시 새 UUID 로 바꿔도 된다 */
  rule: MappingRule;
  /** mapping_rules.suggestion_reason — 예: "동일 수정 3회: 소모품비 → 상품" */
  suggestionReason: string;
  clientId: UUID;
  merchantKey: string;
  merchantBusinessNumber: string | null;
  field: 'account';
  fromAccountCode: string | null;
  toAccountCode: string;
  /**
   * 규칙 조건에 넣은 거래 방향. 수정 기록의 direction(있으면) 또는 계정 성격으로 추정.
   * null = 추정 불가 → 방향 조건 없이 제안하고 suggestionReason 에 확인 요청을 남긴다.
   */
  direction: Direction | null;
  /** 반복 수정 횟수 (거래 수 기준 — 같은 거래를 여러 번 고친 것은 1회) */
  correctionCount: number;
  /** classification_corrections.suggested_rule_id 연결 대상 */
  transactionIds: UUID[];
  /** 같은 상대방에 다른 계정으로 걸려 있는 활성 규칙 (승인 시 대체 검토) */
  conflictingRuleIds: string[];
  firstCorrectedAt: string;
  lastCorrectedAt: string;
}

export const SUGGESTED_RULE_DEFAULTS = { confidence: 99, priority: 100 } as const;

function accountMapOf(accounts: readonly AccountCode[] | ReadonlyMap<string, AccountCode>): ReadonlyMap<string, AccountCode> {
  return accounts instanceof Map ? accounts : buildAccountMap(accounts as readonly AccountCode[]);
}

function isAccountChange(c: CorrectionRecord): boolean {
  return c.field === 'account' && typeof c.after === 'string' && c.after.trim() !== '' && c.after !== c.before;
}

/** 규칙이 이 상대방을 덮는가 (방향을 모르면 양방향 평가) */
function ruleMatchesMerchant(cond: Condition, merchantKey: string, bizno: string | null, direction: Direction | null): boolean {
  const directions: readonly Direction[] = direction ? [direction] : ['purchase', 'sales'];
  for (const direction of directions) {
    const ctx: ConditionContext = { merchantKey, merchantName: merchantKey, merchantBusinessNumber: bizno, direction };
    try {
      if (evaluateCondition(cond, ctx)) return true;
    } catch {
      // 손상된 조건은 무시
    }
  }
  return false;
}

function mostFrequent(values: Array<string | null>): string | null {
  const m = new Map<string, number>();
  for (const v of values) m.set(v ?? '', (m.get(v ?? '') ?? 0) + 1);
  let best: string | null = null;
  let bc = -1;
  for (const [k, n] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (n > bc) {
      best = k;
      bc = n;
    }
  }
  return best === '' ? null : best;
}

/**
 * 수정 기록 묶음의 거래 방향.
 * 명시 direction 이 하나로 모이면 그것, 없으면 수정값(→ 없으면 수정 전 값) 계정 성격. 끝내 모르면 null.
 */
function inferDirection(records: readonly DirectedCorrectionRecord[], accounts: ReadonlyMap<string, AccountCode>): Direction | null {
  const explicit = new Set(records.map((r) => r.direction).filter((d): d is Direction => !!d));
  if (explicit.size === 1) return [...explicit][0]!;
  if (explicit.size > 1) return null;
  const byAfter = accountDirection(records[0]?.after ?? null, accounts);
  if (byAfter) return byAfter;
  const byBefore = new Set(records.map((r) => accountDirection(r.before, accounts)).filter((d): d is Direction => !!d));
  return byBefore.size === 1 ? [...byBefore][0]! : null;
}

/**
 * 반복 수정 → 규칙 제안.
 * 같은 (거래처, 상대방[사업자번호 우선, 없으면 상호키], field='account', 수정값) 이 threshold 건(거래 수) 이상이고,
 * 그 수정값이 해당 상대방의 가장 최근 수정과 같으며, 같은 결과의 규칙(활성·제안·거절·비활성)이 없을 때만 제안한다.
 * 제안 규칙은 매입/매출 방향 조건을 함께 건다 — "쿠팡 → 상품" 규칙이 쿠팡에 대한 매출에 적용되면 안 되기 때문.
 */
export function analyzeCorrections(
  corrections: readonly DirectedCorrectionRecord[],
  existingRules: readonly MappingRule[],
  policy: ConfidencePolicy,
  accounts: readonly AccountCode[] | ReadonlyMap<string, AccountCode> = DEFAULT_ACCOUNT_CODES,
): RuleSuggestion[] {
  const threshold = Math.max(1, policy.ruleSuggestionThreshold);
  const accMap = accountMapOf(accounts);
  const nameOf = (code: string | null) => (code ? (accMap.get(code)?.name ?? code) : '미분류');
  // 거래 1건당 최종 수정만: 같은 거래를 여러 번 고치거나 되돌린 것은 반복 수정이 아니다
  const list = latestCorrectionPerTransaction(corrections.filter((c) => c.field === 'account')).filter(isAccountChange);

  // 상호키 → 사업자번호 (한 상호키에 사업자번호가 하나뿐이면 같은 상대방으로 묶는다)
  const keyBiznos = new Map<string, Set<string>>();
  for (const c of list) {
    if (!c.merchantBusinessNumber || !c.merchantKey) continue;
    const k = `${c.clientId}|${c.merchantKey}`;
    (keyBiznos.get(k) ?? keyBiznos.set(k, new Set()).get(k)!).add(c.merchantBusinessNumber);
  }
  const identity = (c: CorrectionRecord): { bizno: string | null; id: string } => {
    let bizno = c.merchantBusinessNumber;
    if (!bizno) {
      const s = keyBiznos.get(`${c.clientId}|${c.merchantKey}`);
      if (s && s.size === 1) bizno = [...s][0]!;
    }
    return { bizno, id: `${c.clientId}|${bizno ? `b:${bizno}` : `k:${c.merchantKey}`}` };
  };

  const groups = new Map<string, { bizno: string | null; records: DirectedCorrectionRecord[] }>();
  for (const c of list) {
    const { bizno, id } = identity(c);
    const g = groups.get(id);
    if (g) g.records.push(c);
    else groups.set(id, { bizno, records: [c] });
  }

  const out: RuleSuggestion[] = [];
  for (const g of groups.values()) {
    const records = [...g.records].sort(compareCorrection);
    const latest = records[records.length - 1]!;
    const same = records.filter((r) => r.after === latest.after);
    if (same.length < threshold) continue;

    const clientId = latest.clientId;
    const merchantKey = mostFrequent(same.map((r) => r.merchantKey)) ?? latest.merchantKey;
    const bizno = g.bizno;
    const direction = inferDirection(same, accMap);
    const clientRules = existingRules.filter((r) => r.clientId === clientId && ruleMatchesMerchant(r.condition, merchantKey, bizno, direction));
    // 이미 같은 결과를 내는 규칙이 있거나(활성), 제안 중이거나, 사람이 거절·비활성화했으면 다시 제안하지 않는다
    if (clientRules.some((r) => r.accountCode === latest.after)) continue;
    const conflictingRuleIds = clientRules
      .filter((r) => r.status === 'active' && r.accountCode !== latest.after)
      .map((r) => String(r.id))
      .sort();

    const fromCode = mostFrequent(same.map((r) => r.before));
    const toName = nameOf(latest.after);
    const party: Condition = bizno
      ? { field: 'merchantBusinessNumber', op: 'eq', value: bizno }
      : { field: 'merchantKey', op: 'eq', value: merchantKey };
    const condition: Condition = direction ? { all: [{ field: 'direction', op: 'eq', value: direction }, party] } : party;
    const label = merchantKey || formatBusinessNumber(bizno);
    let suggestionReason = `동일 수정 ${same.length}회: ${nameOf(fromCode)} → ${toName}`;
    if (!direction) suggestionReason += ' (매입/매출 방향 미확인 — 승인 전 조건 확인)';
    if (conflictingRuleIds.length > 0) suggestionReason += ' (기존 활성 규칙과 다름 — 대체 검토)';
    const idBasis = [clientId, bizno ? `b:${bizno}` : `k:${merchantKey}`, 'account', latest.after].join('|');
    const dirLabel = direction === 'purchase' ? ' (매입)' : direction === 'sales' ? ' (매출)' : '';

    out.push({
      rule: {
        id: `suggested-${sha256Hex(idBasis).slice(0, 24)}`,
        clientId,
        name: `${label}${dirLabel} → ${toName}`,
        condition,
        accountCode: latest.after,
        accountName: toName,
        vatOverride: null,
        confidence: SUGGESTED_RULE_DEFAULTS.confidence,
        priority: SUGGESTED_RULE_DEFAULTS.priority,
        status: 'suggested',
        origin: 'system_suggested',
      },
      suggestionReason,
      clientId,
      merchantKey,
      merchantBusinessNumber: bizno,
      field: 'account',
      fromAccountCode: fromCode,
      toAccountCode: latest.after,
      direction,
      correctionCount: same.length,
      transactionIds: [...new Set(same.map((r) => r.transactionId))].sort(),
      conflictingRuleIds,
      firstCorrectedAt: same[0]!.createdAt,
      lastCorrectedAt: latest.createdAt,
    });
  }
  return out.sort(
    (a, b) =>
      (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0) ||
      b.correctionCount - a.correctionCount ||
      (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0),
  );
}

// ────────────────────────────── 수정 기록 생성 ──────────────────────────────

/**
 * classification_corrections 저장용 (CorrectionRecord + 표시·분석 컬럼).
 * direction 은 테이블 컬럼이 없으므로 저장하지 않아도 된다 — 읽을 때 transactions.direction 을 조인해 채우면 학습이 방향을 구분한다.
 */
export interface CorrectionDraft extends DirectedCorrectionRecord {
  field: 'account';
  beforeLabel: string | null;
  afterLabel: string | null;
  beforeSource: ClassificationSource;
  beforeConfidence: number;
}

export interface CorrectionMeta {
  tx: Pick<NormalizedTransaction, 'clientId' | 'merchantKey' | 'merchantBusinessNumber'> & Partial<Pick<NormalizedTransaction, 'direction'>>;
  transactionId: UUID;
  userId: UUID;
  /** ISO 시각 — core 는 시계를 직접 읽지 않으므로 호출자가 넘긴다 */
  createdAt: string;
  reason?: string;
  accounts?: readonly AccountCode[] | ReadonlyMap<string, AccountCode>;
}

/**
 * 엔진 판단(before) → 사람 수정(afterCode) 기록. 계정이 바뀌지 않았으면 null (학습 데이터 아님).
 */
export function buildCorrection(before: AccountClassification, afterCode: string, meta: CorrectionMeta): CorrectionDraft | null {
  const after = String(afterCode ?? '').trim();
  if (after === '') throw new Error('buildCorrection: 수정 계정코드가 비어 있습니다');
  if (after === before.accountCode) return null;
  const accMap = accountMapOf(meta.accounts ?? DEFAULT_ACCOUNT_CODES);
  const draft: CorrectionDraft = {
    clientId: meta.tx.clientId,
    merchantKey: meta.tx.merchantKey,
    merchantBusinessNumber: meta.tx.merchantBusinessNumber,
    field: 'account',
    before: before.accountCode,
    after,
    userId: meta.userId,
    transactionId: meta.transactionId,
    createdAt: meta.createdAt,
    beforeLabel: before.accountName,
    afterLabel: accMap.get(after)?.name ?? null,
    beforeSource: before.source,
    beforeConfidence: before.confidence,
  };
  if (meta.tx.direction) draft.direction = meta.tx.direction;
  if (meta.reason) draft.reason = meta.reason;
  return draft;
}
