import { describe, expect, it } from 'vitest';
import type { ConditionContext } from '../dsl';
import { evaluateCondition, validateCondition } from '../dsl';
import { normalizeMerchantName } from '../normalize';
import { compilePrefilter } from '../engine/classify';
import { buildAccountMap, DEFAULT_ACCOUNT_CODES, isAccountCompatible } from './accounts';
import { SYSTEM_DICTIONARY, SYSTEM_DICTIONARY_BY_ID, systemDictionaryRules } from './system-dictionary';

describe('DEFAULT_ACCOUNT_CODES', () => {
  const map = buildAccountMap(DEFAULT_ACCOUNT_CODES);

  it('contains the core Douzone/WEHAGO codes with unique codes', () => {
    const required: Record<string, string> = {
      '101': '현금',
      '103': '보통예금',
      '108': '외상매출금',
      '135': '부가세대급금',
      '146': '상품',
      '153': '원재료',
      '206': '기계장치',
      '208': '차량운반구',
      '212': '비품',
      '251': '외상매입금',
      '253': '미지급금',
      '254': '예수금',
      '255': '부가세예수금',
      '401': '상품매출',
      '404': '제품매출',
      '801': '급여',
      '811': '복리후생비',
      '812': '여비교통비',
      '814': '통신비',
      '815': '수도광열비',
      '817': '세금과공과',
      '819': '지급임차료',
      '820': '수선비',
      '821': '보험료',
      '822': '차량유지비',
      '824': '운반비',
      '825': '교육훈련비',
      '826': '도서인쇄비',
      '830': '소모품비',
      '831': '지급수수료',
      '833': '광고선전비',
      '837': '건물관리비',
    };
    for (const [code, name] of Object.entries(required)) expect(map.get(code)?.name, code).toBe(name);
    expect(map.get('813')?.name).toContain('기업업무추진비');
    expect(map.get('813')?.vatNonDeductibleHint).toBe(true);
    expect(map.get('212')?.isFixedAsset).toBe(true);
    expect(new Set(DEFAULT_ACCOUNT_CODES.map((a) => a.code)).size).toBe(DEFAULT_ACCOUNT_CODES.length);
    expect(DEFAULT_ACCOUNT_CODES.every((a) => a.active && /^\d{3}$/.test(a.code))).toBe(true);
  });

  it('isAccountCompatible guards direction vs category', () => {
    expect(isAccountCompatible('830', 'purchase', map)).toBe(true);
    expect(isAccountCompatible('401', 'purchase', map)).toBe(false);
    expect(isAccountCompatible('401', 'sales', map)).toBe(true);
    expect(isAccountCompatible('830', 'sales', map)).toBe(false);
    expect(isAccountCompatible('212', 'sales', map)).toBe(true);
    expect(isAccountCompatible('99999', 'sales', map)).toBe(true);
  });

  it('buildAccountMap: later entries override', () => {
    const m = buildAccountMap([...DEFAULT_ACCOUNT_CODES, { code: '830', name: '소모품', category: 'expense', active: true }]);
    expect(m.get('830')?.name).toBe('소모품');
  });
});

describe('SYSTEM_DICTIONARY', () => {
  const map = buildAccountMap(DEFAULT_ACCOUNT_CODES);

  it('entries are valid, unique, capped at 90 and point to known expense accounts', () => {
    const ids = new Set<string>();
    for (const e of SYSTEM_DICTIONARY) {
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      expect(e.confidence).toBeLessThanOrEqual(90);
      expect(e.confidence).toBeGreaterThan(0);
      expect(validateCondition(e.matcher), e.id).toEqual([]);
      expect(map.get(e.accountCode)?.category, e.id).toBe('expense');
      expect(e.note.length).toBeGreaterThan(0);
      // 모든 항목이 키워드 사전필터 대상 (성능)
      expect(compilePrefilter(e.matcher), e.id).not.toBeNull();
    }
    expect(SYSTEM_DICTIONARY_BY_ID.get('SYS-TEL-01')?.accountCode).toBe('814');
  });

  it('systemDictionaryRules → active system_default rules with names from the chart', () => {
    const rules = systemDictionaryRules();
    expect(rules).toHaveLength(SYSTEM_DICTIONARY.length);
    for (const r of rules) {
      expect(r).toMatchObject({ clientId: null, status: 'active', origin: 'system_default' });
      expect(r.accountName).toBe(map.get(r.accountCode)!.name);
    }
    const custom = systemDictionaryRules([{ code: '814', name: '통신요금', category: 'expense', active: true }]);
    expect(custom.find((r) => r.id === 'SYS-TEL-01')!.accountName).toBe('통신요금');
    expect(custom.find((r) => r.id === 'SYS-UTL-01')!.accountName).toBe('수도광열비');
  });

  const ctxOf = (name: string, extra: Partial<ConditionContext> = {}): ConditionContext => ({
    merchantName: name,
    merchantKey: normalizeMerchantName(name),
    merchantBusinessNumber: null,
    merchantCategory: null,
    description: '',
    direction: 'purchase',
    ...extra,
  });

  it('prefilter is a necessary condition for every entry (no false negatives) on a varied corpus', () => {
    const corpus = [
      '(주)케이티', 'KT', 'KTX', 'KT&G', 'SKT', 'SK텔레콤', 'LG U+', '한국전력공사', '한전', '대한전선', '서울도시가스', 'ADOBE', 'AWS', 'MICROSOFT*365',
      'NOTION.SO', '카페24', '가비아', '세무회계 민', '에스원', 'S1', '쿠팡', '쿠팡이츠', '다이소', '모닝글로리', '이마트', '이마트24', '하이마트',
      '스타벅스', '카페 봄', 'GS25', '씨유 역삼점', '할매국밥', 'GS칼텍스', 'S-OIL', '하이패스', '주차장', '카카오T', '코레일', '에스알', '호텔신라',
      '우체국', 'CJ대한통운', '용달화물', '교보문고', '킨코스', '네이버광고', '메타', 'FACEBK', '현수막나라', '국민연금공단', '역삼세무서',
      '삼성화재', '한화생명', '코웨이', '관리사무소', '휴넷', '꽃집', '골프존', '아무상호',
    ];
    const extras: Array<Partial<ConditionContext>> = [{}, { description: '통신요금 자동이체' }, { merchantCategory: '일반음식점' }, { description: '월세 9월분' }];
    for (const e of SYSTEM_DICTIONARY) {
      const tokens = compilePrefilter(e.matcher)!;
      for (const name of corpus) {
        for (const x of extras) {
          const c = ctxOf(name, x);
          if (!evaluateCondition(e.matcher, c)) continue;
          const text = (f: string) => String(c[f as keyof ConditionContext] ?? '').normalize('NFKC').toUpperCase();
          expect(tokens.some((t) => text(t.field).includes(t.token)), `${e.id} / ${name}`).toBe(true);
        }
      }
    }
  });

  it('sales transactions never match', () => {
    for (const e of SYSTEM_DICTIONARY) expect(evaluateCondition(e.matcher, ctxOf('(주)케이티', { direction: 'sales' }))).toBe(false);
  });
});
