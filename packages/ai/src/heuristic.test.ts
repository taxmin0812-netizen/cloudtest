import { describe, expect, it } from 'vitest';
import type { AIClassificationInput, IndustryKey } from '@mintax/core';
import { DEFAULT_ACCOUNT_CODES } from '@mintax/core/data/accounts';
import { classifyHeuristically, estimateAcquisitionAmount, HEURISTIC_CONFIDENCE_CAP, HeuristicProvider } from './heuristic';

const PURCHASE_CANDIDATES = DEFAULT_ACCOUNT_CODES.filter((a) => a.active && ['expense', 'cogs', 'asset'].includes(a.category)).map((a) => ({
  code: a.code,
  name: a.name,
}));
const SALES_CANDIDATES = DEFAULT_ACCOUNT_CODES.filter((a) => a.category === 'revenue').map((a) => ({ code: a.code, name: a.name }));

function input(over: Partial<AIClassificationInput> = {}): AIClassificationInput {
  return {
    merchantName: '',
    merchantCategory: null,
    description: '',
    totalAmount: 55_000,
    evidenceType: 'card',
    direction: 'purchase',
    industry: 'service',
    candidateAccounts: PURCHASE_CANDIDATES,
    similarExamples: [],
    ...over,
  };
}

const provider = new HeuristicProvider();

describe('HeuristicProvider.classifyTransaction', () => {
  it.each<[string, Partial<AIClassificationInput>, string]>([
    ['주유소', { merchantName: 'SK에너지 강남주유소', merchantCategory: '주유소' }, '822'],
    ['통신사 KT', { merchantName: 'KT 강남지사' }, '814'],
    ['KTX 는 통신비가 아님', { merchantName: 'KTX 서울역', merchantCategory: '철도' }, '812'],
    ['택시', { merchantName: '카카오T 택시' }, '812'],
    ['골프장 CC 접미', { merchantName: '(주)레이크사이드CC' }, '813'],
    ['음식점 식대', { merchantName: '본죽 역삼점', description: '직원 식대', merchantCategory: '일반음식점' }, '811'],
    ['택배', { merchantName: 'CJ대한통운' }, '824'],
    ['세무사 수수료', { merchantName: '김세무사사무소', description: '기장료' }, '831'],
    ['광고', { merchantName: '네이버', description: '네이버광고 충전' }, '833'],
    ['한전 (전력비)', { merchantName: '한국전력공사', evidenceType: 'tax_invoice' }, '816'],
    ['도시가스', { merchantName: '서울도시가스' }, '815'],
    ['보험', { merchantName: '삼성화재해상보험' }, '821'],
    ['문구', { merchantName: '알파문구 선릉점' }, '829'],
    ['서점', { merchantName: '교보문고 광화문점' }, '826'],
    ['편의점 CU', { merchantName: 'CU 역삼점' }, '830'],
    ['기부', { merchantName: '사회복지공동모금회', evidenceType: 'other' }, '953'],
  ])('%s → %s', (_label, over, code) => {
    const r = classifyHeuristically(input(over));
    expect(r?.accountCode).toBe(code);
    expect(r!.confidence).toBeLessThanOrEqual(HEURISTIC_CONFIDENCE_CAP);
    expect(r!.confidence).toBeGreaterThan(0);
  });

  it('주유소: 상호 + 가맹점 업종 신호로 60, 근거 문구', async () => {
    const r = await provider.classifyTransaction(input({ merchantName: 'SK에너지', merchantCategory: '주유소' }));
    expect(r).toEqual({
      accountCode: '822',
      accountName: '차량유지비',
      confidence: 60,
      rationale: '로컬 규칙 추론: 차량유지비 — 상호 키워드(SK에너지) · 가맹점 업종(주유·주유소)',
      provider: 'heuristic',
      model: null,
    });
  });

  it('신호가 없으면 null', async () => {
    expect(await provider.classifyTransaction(input({ merchantName: '(주)가나다상사', description: '' }))).toBeNull();
    expect(await provider.classifyTransaction(input({ merchantName: 'SK에너지', candidateAccounts: [] }))).toBeNull();
  });

  it('후보 목록에 없는 계정은 내지 않는다', () => {
    const candidates = PURCHASE_CANDIDATES.filter((c) => c.code !== '822');
    expect(classifyHeuristically(input({ merchantName: 'GS칼텍스 주유소', candidateAccounts: candidates }))).toBeNull();
  });

  it('사무소 코드체계가 달라도 계정명으로 후보를 찾는다 (5자리)', () => {
    const r = classifyHeuristically(
      input({
        merchantName: 'GS칼텍스',
        candidateAccounts: [
          { code: '81100', name: '복리후생비' },
          { code: '82200', name: '차량유지비' },
        ],
      }),
    );
    expect(r?.accountCode).toBe('82200');
    expect(r?.accountName).toBe('차량유지비');
  });

  it('전력비 계정이 없으면 수도광열비로 (altNames)', () => {
    const r = classifyHeuristically(
      input({ merchantName: '한국전력공사', candidateAccounts: PURCHASE_CANDIDATES.filter((c) => c.code !== '816') }),
    );
    expect(r?.accountCode).toBe('815');
  });

  it('즉시상각 기준: 100만원 이하 소모품비, 초과 비품', () => {
    expect(classifyHeuristically(input({ merchantName: '롯데하이마트', totalAmount: 550_000 }))?.accountCode).toBe('830');
    expect(classifyHeuristically(input({ merchantName: '롯데하이마트', totalAmount: 1_500_000 }))?.accountCode).toBe('212');
  });

  it('업종별: 음식점의 마트 매입은 원재료, 서비스업은 소모품비', () => {
    expect(classifyHeuristically(input({ merchantName: '이마트 성수점', industry: 'restaurant' }))?.accountCode).toBe('153');
    expect(classifyHeuristically(input({ merchantName: '이마트 성수점', industry: 'service' }))?.accountCode).toBe('830');
  });

  it('카페 업종은 커피 전문점 결제를 복리후생비로 추정하지 않는다', () => {
    expect(classifyHeuristically(input({ merchantName: '스타벅스 강남점', industry: 'service' }))?.accountCode).toBe('811');
    expect(classifyHeuristically(input({ merchantName: '스타벅스 강남점', industry: 'cafe' as IndustryKey }))).toBeNull();
  });

  it('같은 상대방 과거 처리 예시가 키워드보다 강하고, 상한 70 을 넘지 않는다', () => {
    const r = classifyHeuristically(
      input({
        merchantName: '다이소 역삼점',
        similarExamples: [{ merchantName: '다이소 역삼점', accountCode: '829', accountName: '사무용품비', count: 8 }],
      }),
    );
    expect(r?.accountCode).toBe('829');
    expect(r?.confidence).toBe(HEURISTIC_CONFIDENCE_CAP);
    expect(r?.rationale).toContain('같은 상대방 과거 처리 8회');
  });

  it('후보가 경합하면 감점하고 경합 후보를 밝힌다', () => {
    // 상호(주유) 3점 vs 적요(택배) 2점 → 차이 1 → 경합
    const r = classifyHeuristically(input({ merchantName: 'SK에너지', description: '택배' }));
    expect(r?.accountCode).toBe('822');
    expect(r?.confidence).toBe(40);
    expect(r?.rationale).toContain('경합 후보: 운반비');
  });

  it('매출: 키워드 우선, 없으면 업종 기본 매출계정 (낮은 신뢰도)', () => {
    const rent = classifyHeuristically(
      input({ direction: 'sales', industry: 'rental', description: '9월 월세', candidateAccounts: SALES_CANDIDATES }),
    );
    expect(rent?.accountCode).toBe('904');
    const mfg = classifyHeuristically(input({ direction: 'sales', industry: 'manufacturing', merchantName: '(주)고객사', candidateAccounts: SALES_CANDIDATES }));
    expect(mfg).toMatchObject({ accountCode: '404', accountName: '제품매출', confidence: 40 });
    const other = classifyHeuristically(input({ direction: 'sales', industry: 'other', merchantName: '(주)고객사', candidateAccounts: SALES_CANDIDATES }));
    expect(other?.accountCode).toBe('401');
  });

  it('매입 키워드는 매출 거래에 쓰지 않는다', () => {
    expect(classifyHeuristically(input({ direction: 'sales', merchantName: 'SK에너지', candidateAccounts: SALES_CANDIDATES, industry: 'other' }))?.accountCode).toBe('401');
  });

  it('결정적: 같은 입력은 같은 결과', () => {
    const a = classifyHeuristically(input({ merchantName: '쿠팡', description: '사무실 소모품' }));
    const b = classifyHeuristically(input({ merchantName: '쿠팡', description: '사무실 소모품' }));
    expect(a).toEqual(b);
  });
});

describe('HeuristicProvider.status', () => {
  it('LIVE, 로컬 규칙 기반', () => {
    const s = provider.status();
    expect(s).toMatchObject({ key: 'ai_provider.heuristic', status: 'LIVE', statusReason: '로컬 규칙 기반 추론 (LLM 아님)' });
    expect(s.capabilities).toContain('classifyTransaction');
    expect(provider.name).toBe('heuristic');
    expect(provider.model).toBeNull();
  });
});

describe('즉시상각 금액 기준 (검수 보강)', () => {
  it('취득가액 추정: 과세 증빙은 공급가액(부가세 제외), 면세사업자 업종·통장은 합계, 음수는 절대값', () => {
    expect(estimateAcquisitionAmount({ totalAmount: 1_100_000, evidenceType: 'card', industry: 'service' })).toBe(1_000_000);
    expect(estimateAcquisitionAmount({ totalAmount: 1_100_000, evidenceType: 'tax_invoice', industry: 'it_service' })).toBe(1_000_000);
    expect(estimateAcquisitionAmount({ totalAmount: 1_100_000, evidenceType: 'card', industry: 'academy' })).toBe(1_100_000);
    expect(estimateAcquisitionAmount({ totalAmount: 1_100_000, evidenceType: 'bank', industry: 'service' })).toBe(1_100_000);
    expect(estimateAcquisitionAmount({ totalAmount: -1_650_000, evidenceType: 'card', industry: 'service' })).toBe(1_500_000);
  });

  it('합계 108만원 노트북(공급가액 약 98만원)은 100만원 이하 → 소모품비, 면세사업자(학원)는 부가세 포함 취득가액이라 비품', () => {
    expect(classifyHeuristically(input({ merchantName: '롯데하이마트', description: '노트북', totalAmount: 1_080_000 }))?.accountCode).toBe('830');
    expect(classifyHeuristically(input({ merchantName: '롯데하이마트', description: '노트북', totalAmount: 1_080_000, industry: 'academy' }))?.accountCode).toBe('212');
    // 경계: 공급가액 정확히 100만원(합계 110만원)은 즉시상각 가능 범위
    expect(classifyHeuristically(input({ merchantName: '롯데하이마트', totalAmount: 1_100_000 }))?.accountCode).toBe('830');
    expect(classifyHeuristically(input({ merchantName: '롯데하이마트', totalAmount: 1_100_012 }))?.accountCode).toBe('212');
  });

  it('비품 취소·반품(음수 금액)도 비품으로 추천한다 (소모품비로 뒤집히지 않음)', () => {
    expect(classifyHeuristically(input({ merchantName: '롯데하이마트', totalAmount: -2_200_000 }))?.accountCode).toBe('212');
    expect(classifyHeuristically(input({ merchantName: '롯데하이마트', totalAmount: -330_000 }))?.accountCode).toBe('830');
  });
});

describe('성능 (검수 보강)', () => {
  it('1만 건 분류가 배치 예산 안에 끝난다 (사전 키워드 사전 정규화)', () => {
    const names = ['SK에너지 강남주유소', '스타벅스 역삼점', '쿠팡(주)', '알 수 없는 상호', '한국전력공사', '하이마트 강남', '(주)케이티'];
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < 10_000; i++) {
      const r = classifyHeuristically(
        input({ merchantName: names[i % names.length]!, merchantCategory: '일반음식점', description: `법인카드 결제 ${i}`, totalAmount: 10_000 + i }),
      );
      if (r) hits++;
    }
    expect(hits).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});
