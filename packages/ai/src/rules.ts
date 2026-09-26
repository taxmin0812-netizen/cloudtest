import {
  DEFAULT_CONFIDENCE_POLICY,
  normalizeBusinessNumber,
  validateCondition,
  type AccountCode,
  type Condition,
  type CorrectionRecord,
} from '@mintax/core';
import { buildAccountMap, DEFAULT_ACCOUNT_CODES } from '@mintax/core/data/accounts';
import type { RuleSuggestion } from './types';

export interface SuggestRuleOptions {
  /** 같은 수정 N회 이상 → 규칙 제안 (기본 DEFAULT_CONFIDENCE_POLICY.ruleSuggestionThreshold = 3) */
  threshold?: number;
  /** 같은 상대방 수정 중 최다 계정 비율 하한 (기본 0.8) — 수정이 엇갈리면 제안하지 않는다 */
  minShare?: number;
  /** 계정명 표시용 계정과목표 (기본 core 기본표) */
  accounts?: readonly AccountCode[];
}

interface Group {
  clientId: string;
  merchantKey: string;
  biznos: Set<string>;
  missingBizno: boolean;
  byAfter: Map<string, { count: number; befores: Map<string, number>; last: string }>;
  total: number;
}

/**
 * 직원 계정 수정 이력 → 규칙 제안 (결정적).
 * - 계정(field='account') 수정만 사용. 수임처 + 상대방(사업자번호 우선, 없으면 상호키) 단위로 묶는다.
 * - 같은 계정으로 threshold 회 이상 수정 + 최다 계정 비율 ≥ minShare 일 때만 제안.
 * - 조건은 사업자번호가 모든 수정에 같게 있으면 merchantBusinessNumber = …, 아니면 merchantKey = ….
 */
export function suggestRulesFromCorrections(corrections: CorrectionRecord[], opts: SuggestRuleOptions = {}): RuleSuggestion[] {
  const threshold = opts.threshold ?? DEFAULT_CONFIDENCE_POLICY.ruleSuggestionThreshold;
  const minShare = opts.minShare ?? 0.8;
  const accounts = buildAccountMap(opts.accounts ?? DEFAULT_ACCOUNT_CODES);
  const groups = new Map<string, Group>();

  for (const c of corrections) {
    if (c.field !== 'account' || !c.after || !c.merchantKey) continue;
    const key = `${c.clientId}|${c.merchantKey}`;
    let g = groups.get(key);
    if (!g) {
      g = { clientId: c.clientId, merchantKey: c.merchantKey, biznos: new Set(), missingBizno: false, byAfter: new Map(), total: 0 };
      groups.set(key, g);
    }
    const bizno = normalizeBusinessNumber(c.merchantBusinessNumber);
    if (bizno) g.biznos.add(bizno);
    else g.missingBizno = true;
    g.total += 1;
    const after = String(c.after).trim();
    const a = g.byAfter.get(after) ?? { count: 0, befores: new Map<string, number>(), last: '' };
    a.count += 1;
    const before = c.before ? String(c.before).trim() : '미분류';
    a.befores.set(before, (a.befores.get(before) ?? 0) + 1);
    if (c.createdAt > a.last) a.last = c.createdAt;
    g.byAfter.set(after, a);
  }

  const out: Array<RuleSuggestion & { _sort: [number, string] }> = [];
  for (const g of groups.values()) {
    const ranked = [...g.byAfter.entries()].sort((x, y) => y[1].count - x[1].count || (x[1].last < y[1].last ? 1 : -1));
    const [accountCode, top] = ranked[0]!;
    if (top.count < threshold || top.count / g.total < minShare) continue;
    // 규칙이 원래 판단과 같은 계정이면 의미가 없다
    const befores = [...top.befores.entries()].filter(([b]) => b !== accountCode);
    if (befores.length === 0) continue;

    const accountName = accounts.get(accountCode)?.name ?? accountCode;
    const useBizno = g.biznos.size === 1 && !g.missingBizno;
    const bizno = useBizno ? [...g.biznos][0]! : null;
    const condition: Condition = bizno
      ? { field: 'merchantBusinessNumber', op: 'eq', value: bizno }
      : { field: 'merchantKey', op: 'eq', value: g.merchantKey };
    if (validateCondition(condition).length > 0) continue;

    const beforeText = befores
      .sort((x, y) => y[1] - x[1])
      .map(([b, n]) => `${b === '미분류' ? '미분류' : `${accounts.get(b)?.name ?? b}(${b})`} ${n}회`)
      .join(', ');
    const target = bizno ? `사업자번호 ${bizno.slice(0, 3)}-${bizno.slice(3, 5)}-${bizno.slice(5)} (${g.merchantKey})` : `상호 ${g.merchantKey}`;
    out.push({
      name: `${g.merchantKey} → ${accountName}`,
      condition,
      accountCode,
      rationale: `최근 ${target} 거래를 ${top.count}회 ${accountName}(${accountCode})로 수정했습니다 (이전 판단: ${beforeText}). 같은 거래를 자동 분류하도록 규칙을 제안합니다.`,
      clientId: g.clientId,
      supportCount: top.count,
      _sort: [top.count, g.merchantKey],
    });
  }
  return out
    .sort((a, b) => b._sort[0] - a._sort[0] || (a._sort[1] < b._sort[1] ? -1 : a._sort[1] > b._sort[1] ? 1 : 0))
    .map(({ _sort: _unused, ...rest }) => rest);
}
