import type { ClassificationEvidence, ClassificationSource, IndustryKey, LocalDate, Won } from '../types';
import { formatWon } from '../money';

/**
 * Explainability — 분류 근거를 사람이 읽는 한국어로.
 * Grid 에는 한 줄 요약(buildSummary), 설명 패널에는 근거 목록(buildReasons).
 */

export const UNCLASSIFIED_SUMMARY = '미분류: 과거 처리·규칙·사전 모두 해당 없음';

export const INDUSTRY_LABELS_KO: Record<IndustryKey, string> = {
  restaurant: '음식점',
  meat_restaurant: '정육식당',
  construction: '건설업',
  ecommerce: '전자상거래',
  interior: '인테리어',
  service: '서비스업',
  academy: '학원',
  clinic: '병·의원',
  wholesale_retail: '도소매',
  rental: '임대업',
  manufacturing: '제조업',
  it_service: 'IT·소프트웨어',
  design: '디자인',
  cafe: '카페',
  other: '기타',
};

/** 설명 생성에 필요한 사실 (classify 가 채운다) */
export interface ExplainFacts {
  source: ClassificationSource;
  /** 상대방 표시명 (원문 상호) */
  merchantName: string;
  accountName: string | null;
  evidence: ClassificationEvidence;
  /** 이력 매칭 방식 */
  matchedBy?: 'bizno' | 'name';
  /** 상호로 매칭했으나 사업자번호가 다른 이력이 섞임 */
  biznoMismatch?: boolean;
  ruleName?: string;
  ruleConditionText?: string;
  rulePriority?: number;
  ruleNote?: string;
  /** 최근 사람 수정 */
  correction?: { fromName: string | null; toName: string; count: number; date: LocalDate | null } | null;
  /** 수정 우선 원칙으로 제외된 옛 이력 수 */
  supersededCount?: number;
  industryLabel?: string;
  crossIndustry?: boolean;
  agreeingClientCount?: number;
  amount?: { value: Won; average: Won; ratio: number; deviated: boolean; penalty: number } | null;
  /** 다른 단계도 같은 계정을 지지 */
  corroborations?: string[];
  /** 경고 (계정표 없음, 비활성 등) */
  warnings?: string[];
  aiRationale?: string;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function merchantLabel(name: string): string {
  const s = name.trim();
  return s === '' ? '(상호 없음)' : s;
}

/** 한 줄 요약 (Grid 노출) */
export function buildSummary(f: ExplainFacts): string {
  const acc = f.accountName ?? '미분류';
  const m = merchantLabel(f.merchantName);
  const ev = f.evidence;
  switch (f.source) {
    case 'user_rule':
      return `사용자 규칙 「${f.ruleName ?? ev.ruleName ?? ''}」 적용 → ${acc}`;
    case 'exact_history':
    case 'name_history': {
      const n = ev.historyCount ?? 0;
      const k = ev.consistentCount ?? 0;
      const tail = f.source === 'name_history' ? ' (상호 일치)' : '';
      return n === k ? `${m}의 전기 ${n}건 모두 ${acc} 처리${tail}` : `${m}의 전기 ${n}건 중 ${k}건 ${acc} 처리${tail}`;
    }
    case 'correction_memory': {
      const c = f.correction;
      const times = c ? ` (${c.count}회)` : '';
      return c?.fromName ? `최근 수정 반영: ${m} ${c.fromName} → ${c.toName}${times}` : `최근 수정 반영: ${m} → ${acc}${times}`;
    }
    case 'industry_pattern': {
      const total = ev.peerClientCount ?? 0;
      const agree = f.agreeingClientCount ?? total;
      const scope = f.crossIndustry ? '타 업종 포함' : `동일 업종(${f.industryLabel ?? '기타'})`;
      return `${scope} 거래처 ${total}곳 중 ${agree}곳이 ${m}을(를) ${acc} 처리`;
    }
    case 'system_rule':
      return `시스템 기본사전: ${f.ruleName ?? ev.ruleName ?? ''} → ${acc}`;
    case 'ai':
      return `AI 추천: ${acc}${ev.aiProvider ? ` (${ev.aiProvider})` : ''} — 검토 필요`;
    case 'manual':
      return `직접 지정: ${acc}`;
    case 'none':
    default:
      return UNCLASSIFIED_SUMMARY;
  }
}

/** 상세 근거 목록 (설명 패널) */
export function buildReasons(f: ExplainFacts): string[] {
  const r: string[] = [];
  const ev = f.evidence;
  const n = ev.historyCount ?? 0;
  const k = ev.consistentCount ?? 0;

  switch (f.source) {
    case 'user_rule':
      r.push(`사용자 승인 규칙 「${f.ruleName ?? ev.ruleName ?? ''}」 일치`);
      if (f.ruleConditionText) r.push(`조건: ${f.ruleConditionText}`);
      if (f.rulePriority !== undefined) r.push(`우선순위 ${f.rulePriority}`);
      break;
    case 'exact_history':
    case 'name_history':
      r.push(n === k ? `동일 거래처 전기 ${k}건 동일처리` : `동일 거래처 전기 ${n}건 중 ${k}건 동일처리 (일관성 ${formatPercent(n > 0 ? k / n : 0)})`);
      if (f.matchedBy === 'bizno') r.push('동일 상대방(사업자번호 일치)');
      else r.push(f.biznoMismatch ? '상호 일치 (사업자번호 상이 — 지점·동명 업체 가능)' : '상호 일치 (사업자번호 없음)');
      break;
    case 'correction_memory':
      if (f.correction) {
        const from = f.correction.fromName ? `${f.correction.fromName} → ` : '';
        r.push(`직원 수정 ${f.correction.count}회: ${from}${f.correction.toName}${f.correction.date ? ` (최근 ${f.correction.date})` : ''}`);
      }
      r.push('수정 이력 기반 추천 — 빠른 검토 대상');
      break;
    case 'industry_pattern':
      r.push(
        f.crossIndustry
          ? `타 업종 포함 거래처 ${ev.peerClientCount ?? 0}곳 참조 (동일 업종 자료 부족)`
          : `동일 업종(${f.industryLabel ?? '기타'}) 거래처 ${ev.peerClientCount ?? 0}곳 참조`,
      );
      if (f.agreeingClientCount !== undefined && ev.peerClientCount)
        r.push(`거래처 일치율 ${formatPercent(f.agreeingClientCount / ev.peerClientCount)} (${f.agreeingClientCount}/${ev.peerClientCount}곳)`);
      if (n > 0) r.push(`참조 거래 ${n}건 중 ${k}건 동일계정`);
      r.push('이 거래처의 과거 처리 이력 없음');
      break;
    case 'system_rule':
      r.push(`시스템 기본사전 「${f.ruleName ?? ev.ruleName ?? ''}」 일치`);
      if (f.ruleNote) r.push(`참고: ${f.ruleNote}`);
      r.push('이 거래처의 과거 처리 이력 없음');
      break;
    case 'ai':
      if (f.aiRationale) r.push(`AI 근거: ${f.aiRationale}`);
      r.push('AI 추론은 신뢰도 상한이 적용되어 자동승인되지 않음');
      break;
    case 'none':
      r.push('동일 거래처 과거 처리 이력 없음');
      r.push('적용 가능한 사용자 규칙·시스템 사전 없음');
      r.push('동일 업종 참조 자료 없음');
      break;
    default:
      break;
  }

  // 이력 기반이 아닌 결정이어도 이력이 있으면 참고로 표시
  if ((f.source === 'user_rule' || f.source === 'correction_memory') && n > 0) {
    r.push(k === n ? `과거 ${n}건 처리 이력 참조` : `과거 ${n}건 중 ${k}건 동일계정`);
  }

  if (f.amount) {
    const avg = formatWon(f.amount.average);
    if (f.amount.deviated) {
      r.push(`금액 이례적: 평균 ${avg} 대비 ${f.amount.ratio.toFixed(1)}배 (신뢰도 -${f.amount.penalty})`);
    } else if (f.amount.ratio >= 0.5 && f.amount.ratio <= 2) {
      r.push(`평균금액 유사 (평균 ${avg})`);
    } else {
      r.push(`평균금액과 차이 있음 (평균 ${avg})`);
    }
  }

  if (f.supersededCount && f.supersededCount > 0) {
    r.push(`수정 이전 이력 ${f.supersededCount}건 제외 (최근 수정 우선)`);
  }

  if (f.source === 'exact_history' || f.source === 'name_history') {
    const cc = ev.correctionCount ?? 0;
    if (cc === 0) r.push('최근 수정이력 없음');
    else if (f.correction) r.push(`최근 수정 ${cc}회 반영 (${f.correction.toName})`);
    else r.push(`최근 수정 ${cc}회`);
    if (ev.lastUsedDate) r.push(`최근 처리일 ${ev.lastUsedDate}`);
  }

  for (const c of f.corroborations ?? []) r.push(c);
  for (const w of f.warnings ?? []) r.push(w);
  return r;
}
