/**
 * 계정과목 판단 엔진 (core-classify) 공개 API.
 * import { classifyAccount, buildClassificationContext } from '@mintax/core/engine/classify-index';
 */
export { DEFAULT_ACCOUNT_CODES, buildAccountMap, isAccountCompatible } from '../data/accounts';
export {
  SYSTEM_DICTIONARY,
  SYSTEM_DICTIONARY_BY_ID,
  SYSTEM_RULE_MAX_CONFIDENCE,
  systemDictionaryRules,
  type SystemDictionaryEntry,
} from '../data/system-dictionary';
export {
  CLASSIFY_PARAMS,
  buildClassificationContext,
  classifyAccount,
  classifyAccounts,
  compilePrefilter,
  hasAccountConflict,
  transactionConditionContext,
  type ClassificationContext,
  type ClassificationContextInput,
  type ClassifyParams,
  type CompiledRule,
  type ConfidenceStep,
  type PrefilterToken,
} from './classify';
export {
  applyCorrectionPriority,
  buildCorrectionIndex,
  buildHistoryIndex,
  buildMerchantIndex,
  consistency,
  daysBetween,
  dominantAccount,
  isoToKstDate,
  latestCorrectedEntry,
  lookupMerchant,
  majorityAccountByCount,
  recencyWeight,
  tallyHistory,
  type AccountTally,
  type CorrectionPoint,
  type HistoryIndex,
  type HistoryStats,
  type MerchantIndex,
  type TallyOptions,
} from './history';
export { INDUSTRY_LABELS_KO, UNCLASSIFIED_SUMMARY, buildReasons, buildSummary, formatPercent, type ExplainFacts } from './explain';
export {
  AI_CAP_AI_ONLY,
  AI_CAP_WITH_HISTORY,
  buildAiClassificationInput,
  hasSimilarHistory,
  mergeAiSuggestion,
  type MergeAiOptions,
} from './ai-merge';
export {
  SUGGESTED_RULE_DEFAULTS,
  analyzeCorrections,
  buildCorrection,
  type CorrectionDraft,
  type CorrectionMeta,
  type RuleSuggestion,
} from './learning';
