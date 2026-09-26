import { describe, expect, it } from 'vitest';
import { buildReasons, buildSummary, formatPercent, INDUSTRY_LABELS_KO, UNCLASSIFIED_SUMMARY, type ExplainFacts } from './explain';

const base = (p: Partial<ExplainFacts>): ExplainFacts => ({
  source: 'none',
  merchantName: 'ABC쇼핑',
  accountName: '소모품비',
  evidence: {},
  ...p,
});

describe('buildSummary', () => {
  it('history summaries', () => {
    expect(buildSummary(base({ source: 'exact_history', evidence: { historyCount: 14, consistentCount: 14 } }))).toBe('ABC쇼핑의 전기 14건 모두 소모품비 처리');
    expect(buildSummary(base({ source: 'exact_history', evidence: { historyCount: 14, consistentCount: 12 } }))).toBe('ABC쇼핑의 전기 14건 중 12건 소모품비 처리');
    expect(buildSummary(base({ source: 'name_history', evidence: { historyCount: 3, consistentCount: 3 } }))).toBe('ABC쇼핑의 전기 3건 모두 소모품비 처리 (상호 일치)');
  });

  it('rule / correction / industry / system / ai / none', () => {
    expect(buildSummary(base({ source: 'user_rule', ruleName: '쿠팡 → 상품', accountName: '상품' }))).toBe('사용자 규칙 「쿠팡 → 상품」 적용 → 상품');
    expect(
      buildSummary(base({ source: 'correction_memory', merchantName: '쿠팡', accountName: '상품', correction: { fromName: '소모품비', toName: '상품', count: 2, date: '2026-09-01' } })),
    ).toBe('최근 수정 반영: 쿠팡 소모품비 → 상품 (2회)');
    expect(
      buildSummary(base({ source: 'industry_pattern', merchantName: '쿠팡', industryLabel: '건설업', agreeingClientCount: 4, evidence: { peerClientCount: 5 } })),
    ).toBe('동일 업종(건설업) 거래처 5곳 중 4곳이 쿠팡을(를) 소모품비 처리');
    expect(buildSummary(base({ source: 'system_rule', ruleName: '통신사', accountName: '통신비' }))).toBe('시스템 기본사전: 통신사 → 통신비');
    expect(buildSummary(base({ source: 'ai', evidence: { aiProvider: 'heuristic' } }))).toBe('AI 추천: 소모품비 (heuristic) — 검토 필요');
    expect(buildSummary(base({ source: 'none', accountName: null }))).toBe(UNCLASSIFIED_SUMMARY);
    expect(buildSummary(base({ source: 'exact_history', merchantName: '  ', evidence: { historyCount: 1, consistentCount: 1 } }))).toContain('(상호 없음)');
  });
});

describe('buildReasons', () => {
  it('matches the spec example for exact history', () => {
    const r = buildReasons(
      base({
        source: 'exact_history',
        matchedBy: 'bizno',
        evidence: { historyCount: 11, consistentCount: 11, correctionCount: 0, lastUsedDate: '2026-08-01' },
        amount: { value: 30_000, average: 32_000, ratio: 30_000 / 32_000, deviated: false, penalty: 0 },
      }),
    );
    expect(r.slice(0, 4)).toEqual(['동일 거래처 전기 11건 동일처리', '동일 상대방(사업자번호 일치)', '평균금액 유사 (평균 32,000원)', '최근 수정이력 없음']);
  });

  it('describes deviations, superseded history, corroborations and warnings', () => {
    const r = buildReasons(
      base({
        source: 'name_history',
        matchedBy: 'name',
        evidence: { historyCount: 4, consistentCount: 3, correctionCount: 2 },
        amount: { value: 500_000, average: 30_000, ratio: 16.7, deviated: true, penalty: 5 },
        supersededCount: 6,
        correction: { fromName: '소모품비', toName: '상품', count: 2, date: null },
        corroborations: ['시스템 기본사전도 동일 계정'],
        warnings: ['경고'],
      }),
    );
    expect(r).toContain('동일 거래처 전기 4건 중 3건 동일처리 (일관성 75%)');
    expect(r).toContain('상호 일치 (사업자번호 없음)');
    expect(r).toContain('금액 이례적: 평균 30,000원 대비 16.7배 (신뢰도 -5)');
    expect(r).toContain('수정 이전 이력 6건 제외 (최근 수정 우선)');
    expect(r).toContain('최근 수정 2회 반영 (상품)');
    expect(r).toContain('시스템 기본사전도 동일 계정');
    expect(r[r.length - 1]).toBe('경고');
  });

  it('non-history sources', () => {
    expect(buildReasons(base({ source: 'none' }))).toContain('동일 거래처 과거 처리 이력 없음');
    expect(buildReasons(base({ source: 'system_rule', ruleName: 'KT', ruleNote: '메모' }))).toContain('참고: 메모');
    expect(buildReasons(base({ source: 'user_rule', ruleName: 'R', ruleConditionText: '상호에 "쿠팡" 포함', rulePriority: 100 }))).toEqual([
      '사용자 승인 규칙 「R」 일치',
      '조건: 상호에 "쿠팡" 포함',
      '우선순위 100',
    ]);
    expect(buildReasons(base({ source: 'industry_pattern', crossIndustry: true, agreeingClientCount: 3, evidence: { peerClientCount: 3, historyCount: 6, consistentCount: 6 } }))).toContain(
      '거래처 일치율 100% (3/3곳)',
    );
    expect(buildReasons(base({ source: 'ai', aiRationale: '업종상 소모품' }))).toContain('AI 근거: 업종상 소모품');
  });

  it('helpers', () => {
    expect(formatPercent(0.857)).toBe('86%');
    expect(INDUSTRY_LABELS_KO.construction).toBe('건설업');
  });
});
