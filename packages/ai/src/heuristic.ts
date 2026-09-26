import {
  normalizeMerchantName,
  splitVatInclusive,
  type AIClassificationInput,
  type AIClassificationSuggestion,
  type CorrectionRecord,
  type EvidenceType,
  type IndustryKey,
  type IntegrationDescriptor,
  type LedgerAnomaly,
  type Won,
} from '@mintax/core';
import { explainClassificationText } from './explain';
import { HEURISTIC_ACCOUNT_KEYWORDS, SALES_ACCOUNT_PREFERENCES, type HeuristicKeywordEntry } from './keywords';
import { mergeReviewParams, runAnomalyDetection, runLedgerReview, type ReviewParams, type ReviewParamsOverride } from './review';
import { suggestRulesFromCorrections, type SuggestRuleOptions } from './rules';
import type { AIProvider, AnomalyInput, ExplainInput, LedgerReviewInput, RuleSuggestion } from './types';

/** 휴리스틱 추천 신뢰도 상한 (CONFIDENCE_LADDER 'AI 추론만 존재' 70) */
export const HEURISTIC_CONFIDENCE_CAP = 70;

export const HEURISTIC_PARAMS = {
  /** 신뢰도 = base + score × perScore (상한 HEURISTIC_CONFIDENCE_CAP) */
  base: 35,
  perScore: 5,
  merchantHit: 3,
  extraMerchantHit: 1,
  descriptionHit: 2,
  categoryHit: 2,
  industryBoost: 1,
  /** 같은 상대방 과거 처리 예시: bonus + min(count, exampleCountCap) */
  exactExampleBonus: 4,
  exampleCountCap: 4,
  /** 비슷한 상호(앞 2글자) 예시, count ≥ 2 일 때만 */
  similarExampleBonus: 1,
  /** 1·2위 점수 차가 이 이하면 경합 → 감점 */
  tieGap: 1,
  tiePenalty: 10,
  floor: 30,
  /** 매출 업종 기본 계정 (키워드 없음) 점수 */
  salesDefaultScore: 1,
};

type Candidate = AIClassificationInput['candidateAccounts'][number];

interface Scored {
  candidate: Candidate;
  score: number;
  signals: string[];
}

function textKey(s: string | null | undefined): string {
  return s ? normalizeMerchantName(s) : '';
}

const ASCII_LETTER = /[A-Z]/;

/** 사전 키워드를 한 번만 정규화해 둔다 (거래마다 수백 번 normalize 하던 비용 제거 — 1만 건 배치 대비) */
interface CompiledKeyword {
  /** 신호 표시용 원문 ('^'·'$' 제거) */
  label: string;
  key: string;
  mode: 'contains' | 'prefix' | 'suffix';
}

interface CompiledEntry {
  entry: HeuristicKeywordEntry;
  keywords: CompiledKeyword[];
  categoryKeywords: Array<{ label: string; key: string }>;
  exclude: string[];
  nameKeys: string[];
}

function compileEntry(entry: HeuristicKeywordEntry): CompiledEntry {
  const keywords: CompiledKeyword[] = [];
  for (const kw of entry.keywords) {
    const mode = kw.startsWith('^') ? 'prefix' : kw.endsWith('$') ? 'suffix' : 'contains';
    const label = kw.replace(/^\^|\$$/g, '');
    const key = textKey(label);
    if (key) keywords.push({ label: mode === 'contains' ? kw : label, key, mode });
  }
  return {
    entry,
    keywords,
    categoryKeywords: (entry.categoryKeywords ?? []).map((kw) => ({ label: kw, key: textKey(kw) })).filter((x) => !!x.key),
    exclude: (entry.exclude ?? []).map(textKey).filter((k) => !!k),
    nameKeys: [entry.name, ...(entry.altNames ?? [])].map(textKey).filter((k) => !!k),
  };
}

const compiledCache = new WeakMap<readonly HeuristicKeywordEntry[], CompiledEntry[]>();

function compiledEntries(entries: readonly HeuristicKeywordEntry[]): CompiledEntry[] {
  let c = compiledCache.get(entries);
  if (!c) {
    c = entries.map(compileEntry);
    compiledCache.set(entries, c);
  }
  return c;
}

/** 상호 키워드 매칭. prefix = 상호 시작(영문 끝이면 다음 글자가 영문이 아닐 것), suffix = 상호 끝 */
function matchMerchantKeyword(kw: CompiledKeyword, merchant: string): boolean {
  if (!merchant) return false;
  if (kw.mode === 'prefix') {
    if (!merchant.startsWith(kw.key)) return false;
    return !(ASCII_LETTER.test(kw.key.charAt(kw.key.length - 1)) && ASCII_LETTER.test(merchant.charAt(kw.key.length)));
  }
  return kw.mode === 'suffix' ? merchant.endsWith(kw.key) : merchant.includes(kw.key);
}

function resolveCandidate(c: CompiledEntry, candidates: Candidate[], candidateNameKeys: string[]): Candidate | null {
  const byCode = candidates.find((x) => x.code === c.entry.code);
  if (byCode) return byCode;
  for (const n of c.nameKeys) {
    const i = candidateNameKeys.indexOf(n);
    if (i >= 0) return candidates[i]!;
  }
  return null;
}

/** 부가세를 따로 공제받을 수 있는 증빙 (합계금액에 10% 부가세 포함으로 본다) */
const VAT_SEPARABLE_EVIDENCE: ReadonlySet<EvidenceType> = new Set<EvidenceType>(['tax_invoice', 'card', 'cash_receipt']);
/** 면세사업자 업종 — 매입세액 불공제라 취득가액에 부가세가 포함된다 */
const VAT_EXEMPT_INDUSTRIES: ReadonlySet<IndustryKey> = new Set<IndustryKey>(['academy', 'clinic']);

/**
 * 즉시상각(100만원)·금액 범위 판단용 취득가액 추정.
 * - 법인세법 시행령 제31조④ 의 기준은 "취득가액" 이므로 매입세액을 공제받는 과세사업자는 공급가액(부가세 제외)으로 본다.
 * - 면세사업자 업종·부가세 비구분 증빙(통장·기타)은 합계금액 그대로.
 * - 취소·반품(음수)은 절대값으로 판단한다 (자산 취소분이 소모품비로 추천되지 않도록).
 * 입력에 공급가액이 없어 10% 역산 추정이다 [추론 — 간이과세 가맹점·면세 품목이면 오차].
 */
export function estimateAcquisitionAmount(input: Pick<AIClassificationInput, 'totalAmount' | 'evidenceType' | 'industry'>): Won {
  const abs = Math.abs(Number.isFinite(input.totalAmount) ? input.totalAmount : 0);
  if (VAT_SEPARABLE_EVIDENCE.has(input.evidenceType) && !VAT_EXEMPT_INDUSTRIES.has(input.industry)) {
    return splitVatInclusive(abs).supplyAmount;
  }
  return abs;
}

function scoreEntry(
  c: CompiledEntry,
  input: AIClassificationInput,
  amount: Won,
  merchant: string,
  desc: string,
  cat: string,
): { score: number; signals: string[] } {
  const P = HEURISTIC_PARAMS;
  const entry = c.entry;
  if ((entry.direction ?? 'purchase') !== input.direction) return { score: 0, signals: [] };
  if (entry.onlyIndustries && !entry.onlyIndustries.includes(input.industry)) return { score: 0, signals: [] };
  if (entry.skipIndustries?.includes(input.industry)) return { score: 0, signals: [] };
  if (entry.minTotal !== undefined && amount < entry.minTotal) return { score: 0, signals: [] };
  if (entry.maxTotal !== undefined && amount > entry.maxTotal) return { score: 0, signals: [] };
  if (c.exclude.some((k) => merchant.includes(k) || desc.includes(k))) return { score: 0, signals: [] };
  const merchantHits: string[] = [];
  const descHits: string[] = [];
  const catHits: string[] = [];
  for (const kw of c.keywords) {
    if (matchMerchantKeyword(kw, merchant)) merchantHits.push(kw.label);
    if (kw.mode === 'contains') {
      if (desc.includes(kw.key)) descHits.push(kw.label);
      if (cat.includes(kw.key)) catHits.push(kw.label);
    }
  }
  for (const kw of c.categoryKeywords) {
    if (cat.includes(kw.key) && !catHits.includes(kw.label)) catHits.push(kw.label);
  }
  let score = 0;
  const signals: string[] = [];
  if (merchantHits.length > 0) {
    score += P.merchantHit + (merchantHits.length > 1 ? P.extraMerchantHit : 0);
    signals.push(`상호 키워드(${merchantHits.slice(0, 3).join('·')})`);
  }
  if (descHits.length > 0) {
    score += P.descriptionHit;
    signals.push(`적요 키워드(${descHits.slice(0, 3).join('·')})`);
  }
  if (catHits.length > 0) {
    score += P.categoryHit;
    signals.push(`가맹점 업종(${catHits.slice(0, 3).join('·')})`);
  }
  if (score > 0 && entry.boostIndustries?.includes(input.industry)) {
    score += P.industryBoost;
    signals.push('수임처 업종 가중');
  }
  return { score, signals };
}

/**
 * 로컬 규칙 기반 계정 추천 (결정적, 외부 전송 없음).
 * - 후보 계정(candidateAccounts) 밖의 코드는 절대 내지 않는다.
 * - 신호가 없으면 null. 신뢰도 상한 70.
 */
export function classifyHeuristically(input: AIClassificationInput): Omit<AIClassificationSuggestion, 'provider' | 'model'> | null {
  const P = HEURISTIC_PARAMS;
  const candidates = input.candidateAccounts ?? [];
  if (candidates.length === 0) return null;
  const merchant = textKey(input.merchantName);
  const desc = textKey(input.description);
  const cat = textKey(input.merchantCategory);
  const amount = estimateAcquisitionAmount(input);
  const candidateNameKeys = candidates.map((c) => textKey(c.name));
  const scored = new Map<string, Scored>();
  const add = (candidate: Candidate, score: number, signals: string[]) => {
    const prev = scored.get(candidate.code);
    if (!prev) scored.set(candidate.code, { candidate, score, signals: [...signals] });
    else {
      // 같은 계정에 여러 사전 항목이 맞으면 최고점 + 신호 합집합
      prev.score = Math.max(prev.score, score);
      for (const s of signals) if (!prev.signals.includes(s)) prev.signals.push(s);
    }
  };

  for (const c of compiledEntries(HEURISTIC_ACCOUNT_KEYWORDS)) {
    const { score, signals } = scoreEntry(c, input, amount, merchant, desc, cat);
    if (score <= 0) continue;
    const candidate = resolveCandidate(c, candidates, candidateNameKeys);
    if (candidate) add(candidate, score, signals);
  }

  // 같은 수임처 과거 처리 예시
  for (const ex of input.similarExamples ?? []) {
    const candidate = candidates.find((c) => c.code === ex.accountCode);
    if (!candidate || ex.count <= 0) continue;
    const exKey = textKey(ex.merchantName);
    if (exKey && exKey === merchant) {
      const bonus = P.exactExampleBonus + Math.min(ex.count, P.exampleCountCap);
      const cur = scored.get(candidate.code);
      const signal = `같은 상대방 과거 처리 ${ex.count}회`;
      if (cur) {
        cur.score += bonus;
        if (!cur.signals.includes(signal)) cur.signals.push(signal);
      } else scored.set(candidate.code, { candidate, score: bonus, signals: [signal] });
    } else if (ex.count >= 2 && exKey.slice(0, 2) === merchant.slice(0, 2) && merchant.length >= 2) {
      const cur = scored.get(candidate.code);
      const signal = `유사 상호 과거 처리(${ex.merchantName} ${ex.count}회)`;
      if (cur) {
        cur.score += P.similarExampleBonus;
        if (!cur.signals.includes(signal)) cur.signals.push(signal);
      } else scored.set(candidate.code, { candidate, score: P.similarExampleBonus, signals: [signal] });
    }
  }

  // 매출: 키워드가 없으면 업종 기본 매출계정 (약한 신호)
  if (scored.size === 0 && input.direction === 'sales') {
    const prefs = SALES_ACCOUNT_PREFERENCES[input.industry] ?? SALES_ACCOUNT_PREFERENCES.default;
    for (const name of prefs) {
      const i = candidateNameKeys.indexOf(textKey(name));
      const hit = i >= 0 ? candidates[i] : undefined;
      if (hit) {
        scored.set(hit.code, { candidate: hit, score: P.salesDefaultScore, signals: ['수임처 업종 기본 매출계정'] });
        break;
      }
    }
  }

  if (scored.size === 0) return null;
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score || (a.candidate.code < b.candidate.code ? -1 : 1));
  const best = ranked[0]!;
  const second = ranked[1];
  let confidence = Math.min(HEURISTIC_CONFIDENCE_CAP, P.base + best.score * P.perScore);
  const contested = !!second && second.score >= best.score - P.tieGap;
  if (contested) confidence = Math.max(P.floor, confidence - P.tiePenalty);
  const rationale =
    `로컬 규칙 추론: ${best.candidate.name} — ${best.signals.join(' · ')}` +
    (contested ? ` (경합 후보: ${second!.candidate.name})` : '');
  return { accountCode: best.candidate.code, accountName: best.candidate.name, confidence: Math.round(confidence), rationale };
}

export interface HeuristicProviderOptions {
  reviewParams?: ReviewParamsOverride;
  ruleOptions?: SuggestRuleOptions;
}

export const HEURISTIC_PROVIDER_CAPABILITIES = [
  'classifyTransaction',
  'reviewLedger',
  'detectAnomaly',
  'explainClassification',
  'suggestRule',
] as const;

/** 기본 AI Provider — 로컬·결정적·네트워크 없음 */
export class HeuristicProvider implements AIProvider {
  readonly name = 'heuristic';
  readonly model: string | null = null;
  private readonly params: ReviewParams;
  private readonly ruleOptions: SuggestRuleOptions;

  constructor(opts: HeuristicProviderOptions = {}) {
    this.params = mergeReviewParams(opts.reviewParams);
    this.ruleOptions = opts.ruleOptions ?? {};
  }

  status(): IntegrationDescriptor {
    return {
      key: 'ai_provider.heuristic',
      name: '로컬 휴리스틱',
      status: 'LIVE',
      statusReason: '로컬 규칙 기반 추론 (LLM 아님)',
      capabilities: [...HEURISTIC_PROVIDER_CAPABILITIES],
      docsRef: 'docs/integration-architecture.md',
    };
  }

  async classifyTransaction(input: AIClassificationInput): Promise<AIClassificationSuggestion | null> {
    const r = classifyHeuristically(input);
    return r ? { ...r, provider: this.name, model: this.model } : null;
  }

  async reviewLedger(input: LedgerReviewInput): Promise<LedgerAnomaly[]> {
    return runLedgerReview(input, this.params);
  }

  async detectAnomaly(input: AnomalyInput): Promise<LedgerAnomaly[]> {
    return runAnomalyDetection(input, this.params);
  }

  async explainClassification(input: ExplainInput): Promise<string> {
    return explainClassificationText(input);
  }

  async suggestRule(input: { corrections: CorrectionRecord[] }): Promise<RuleSuggestion[]> {
    return suggestRulesFromCorrections(input.corrections ?? [], this.ruleOptions);
  }
}
