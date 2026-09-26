/**
 * Rule Studio (rules area) 공개 API.
 */
export { ensureDefaultRules, type EnsureDefaultRulesResult } from './defaults';
export { dictionaryIdForRow, systemRuleUuid, uuidV5 } from './system-ids';
export {
  conditionIdentifiesParty,
  conditionMentionsDirection,
  deriveDescriptionKeyword,
  describeMappingRule,
  describeRuleCondition,
  mappingConditionErrors,
  parseNumberInput,
  ruleConditionErrors,
} from './describe';
export {
  approveSuggestedRule,
  countMappingRulesByStatus,
  createMappingRule,
  disableMappingRule,
  enableMappingRule,
  getMappingRule,
  listMappingRules,
  rejectSuggestedRule,
  updateMappingRule,
  type CreateMappingRuleInput,
  type ListMappingRulesFilter,
  type MappingRuleDto,
  type UpdateMappingRulePatch,
  type VatOverrideInput,
} from './mapping-rules';
export {
  buildConditionFromTransaction,
  createRuleFromTransaction,
  previewRule,
  type CreateRuleFromTransactionOptions,
  type PreviewRuleInput,
  type RulePreviewConflict,
  type RulePreviewResult,
  type RulePreviewSample,
  type RuleScope,
} from './preview';
export {
  createVatRule,
  listVatRules,
  overrideVatRuleForClient,
  removeVatRuleOverride,
  setVatRuleActive,
  updateVatRule,
  type VatRuleDto,
  type VatRuleInput,
  type VatRulePatch,
} from './vat-rules';
export {
  createReviewRule,
  listReviewRules,
  normalizeReviewParams,
  overrideReviewRuleForClient,
  removeReviewRuleOverride,
  setReviewRuleActive,
  updateReviewRule,
  updateReviewRuleParams,
  type ReviewRuleDto,
  type ReviewRuleInput,
  type ReviewRulePatch,
} from './review-rules';
