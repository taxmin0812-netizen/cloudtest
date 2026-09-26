/**
 * 기본 규칙 시드 — 시드 로더·첫 기동에서 호출한다 (멱등).
 * - DEFAULT_VAT_RULES / DEFAULT_REVIEW_RULES → vat_rules / review_rules (공통, client_id null). (code, client_id) 유일 → 이미 있으면 건너뜀
 * - SYSTEM_DICTIONARY → mapping_rules (origin system_default, client_id null). 사전 id 로 만든 결정적 UUID → 이미 있으면 건너뜀
 * 사무소가 바꾼 값(조건·신뢰도·비활성)은 절대 덮어쓰지 않는다.
 */
import { mappingRules, reviewRules, vatRules, type Database } from '@mintax/db';
import { systemDictionaryRules } from '@mintax/core/engine/classify-index';
import { DEFAULT_REVIEW_RULES, DEFAULT_VAT_RULES } from '@mintax/core/engine/vat-risk-index';
import { loadAccountCodes } from '../classification/inputs';
import { systemRuleUuid } from './system-ids';

export interface EnsureDefaultRulesResult {
  vatRulesInserted: number;
  reviewRulesInserted: number;
  systemRulesInserted: number;
}

export async function ensureDefaultRules(db: Database): Promise<EnsureDefaultRulesResult> {
  const { accounts } = await loadAccountCodes(db);
  const vat = await db
    .insert(vatRules)
    .values(
      DEFAULT_VAT_RULES.map((r) => ({
        code: r.code,
        name: r.name,
        condition: r.condition,
        outcome: r.outcome,
        reasonText: r.reasonText,
        legalBasis: r.legalBasis,
        confidence: r.confidence,
        priority: r.priority,
        clientId: null,
        active: true,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: vatRules.id });
  const review = await db
    .insert(reviewRules)
    .values(
      DEFAULT_REVIEW_RULES.map((r) => ({
        code: r.code,
        name: r.name,
        kind: r.kind,
        condition: r.condition ?? null,
        params: r.params,
        bucket: r.bucket,
        severity: r.severity,
        blocksAutoApproval: r.blocksAutoApproval,
        messageTemplate: r.messageTemplate,
        clientId: null,
        active: true,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: reviewRules.id });
  const sys = await db
    .insert(mappingRules)
    .values(
      systemDictionaryRules(accounts).map((r) => ({
        id: systemRuleUuid(String(r.id)),
        clientId: null,
        name: r.name,
        condition: r.condition,
        accountCode: r.accountCode,
        accountName: r.accountName,
        vatOverride: null,
        confidence: r.confidence,
        priority: r.priority,
        status: 'active' as const,
        origin: 'system_default' as const,
        suggestionReason: `시스템 기본 사전 ${String(r.id)}`,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: mappingRules.id });
  return { vatRulesInserted: vat.length, reviewRulesInserted: review.length, systemRulesInserted: sys.length };
}
