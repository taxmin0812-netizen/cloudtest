import { describe, expect, it } from 'vitest';
import type { Condition } from '@mintax/core';
import { SYSTEM_DICTIONARY } from '@mintax/core/engine/classify-index';
import { DEFAULT_REVIEW_RULES } from '@mintax/core/engine/vat-risk-index';
import {
  conditionIdentifiesParty,
  conditionMentionsDirection,
  deriveDescriptionKeyword,
  describeRuleCondition,
  mappingConditionErrors,
  parseNumberInput,
  ruleConditionErrors,
  validationFailure,
} from './describe';
import { dictionaryIdForRow, systemRuleUuid, uuidV5 } from './system-ids';
import { buildConditionFromTransaction } from './preview';
import { normalizeReviewParams } from './review-rules';

describe('describeRuleCondition', () => {
  it('describes contract fields with Korean value labels', () => {
    const c: Condition = { all: [{ field: 'direction', op: 'eq', value: 'purchase' }, { field: 'merchantKey', op: 'eq', value: '쿠팡' }] };
    expect(describeRuleCondition(c)).toBe('매입/매출 = "매입" 그리고 상호키 = "쿠팡"');
  });
  it('describes engine virtual fields (searchText) and evidence lists', () => {
    const c = { all: [{ field: 'searchText', op: 'contains', value: ['골프', '유흥'] }, { field: 'evidenceType', op: 'in', value: ['card', 'cash_receipt'] }] } as unknown as Condition;
    const text = describeRuleCondition(c);
    expect(text).toContain('상호·업종·적요에 "골프, 유흥" 포함');
    expect(text).toContain('카드, 현금영수증');
  });
  it('handles empty / broken conditions', () => {
    expect(describeRuleCondition(null)).toMatch(/조건 없음/);
  });
});

describe('condition validation', () => {
  it('rejects unknown fields and oversized regex, accepts virtual fields only for vat/review rules', () => {
    expect(mappingConditionErrors({ field: 'merchantKey', op: 'eq', value: '쿠팡' })).toEqual([]);
    expect(mappingConditionErrors({ field: 'searchText', op: 'contains', value: '골프' }).length).toBeGreaterThan(0);
    expect(ruleConditionErrors({ field: 'searchText', op: 'contains', value: '골프' })).toEqual([]);
    expect(mappingConditionErrors({ field: 'description', op: 'regex', value: 'a'.repeat(300) }).join()).toMatch(/200자/);
    expect(mappingConditionErrors({ all: [] }).join()).toMatch(/하위 조건/);
    let deep: unknown = { field: 'merchantKey', op: 'eq', value: 'x' };
    for (let i = 0; i < 10; i++) deep = { not: deep };
    expect(mappingConditionErrors(deep).join()).toMatch(/깊습니다/);
  });
  it('builds ValidationError with field errors', () => {
    const e = validationFailure('규칙 조건을 확인하세요.', ['condition[0]: 알 수 없는 필드 foo', '그냥 오류']);
    expect(e.fieldErrors[0]).toEqual({ field: 'condition[0]', message: '알 수 없는 필드 foo' });
    expect(e.fieldErrors[1]!.field).toBe('input');
    expect(e.userMessage).toContain('알 수 없는 필드 foo');
  });
  it('detects party & direction', () => {
    expect(conditionIdentifiesParty({ all: [{ field: 'direction', op: 'eq', value: 'purchase' }, { field: 'merchantKey', op: 'eq', value: 'X' }] })).toBe(true);
    expect(conditionIdentifiesParty({ field: 'totalAmount', op: 'gt', value: 1 })).toBe(false);
    expect(conditionMentionsDirection({ all: [{ field: 'direction', op: 'eq', value: 'purchase' }] })).toBe(true);
    expect(conditionMentionsDirection({ field: 'merchantKey', op: 'eq', value: 'X' })).toBe(false);
  });
});

describe('keyword & number parsing', () => {
  it('derives a description keyword', () => {
    expect(deriveDescriptionKeyword('쿠팡 주문 12345 A4용지', '쿠팡')).toBe('A4용지');
    expect(deriveDescriptionKeyword('12345', '쿠팡')).toBeNull();
    expect(deriveDescriptionKeyword('', '쿠팡')).toBeNull();
  });
  it('parses amount inputs', () => {
    expect(parseNumberInput('3,000,000')).toBe(3_000_000);
    expect(parseNumberInput('₩300,000원')).toBe(300_000);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
    expect(parseNumberInput(12)).toBe(12);
  });
});

describe('system dictionary ids', () => {
  it('uuidV5 is deterministic, versioned and distinct', () => {
    const a = systemRuleUuid('SYS-TEL-01');
    expect(a).toBe(systemRuleUuid('SYS-TEL-01'));
    expect(a).not.toBe(systemRuleUuid('SYS-TEL-02'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // RFC 4122 test vector: uuidv5(DNS namespace, 'www.example.com')
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
  it('maps DB rows back to dictionary ids', () => {
    const e = SYSTEM_DICTIONARY[0]!;
    expect(dictionaryIdForRow({ id: systemRuleUuid(e.id), name: 'x', accountCode: 'y', origin: 'system_default', clientId: null })).toBe(e.id);
    expect(dictionaryIdForRow({ id: '00000000-0000-4000-8000-000000000000', name: e.name, accountCode: e.accountCode, origin: 'system_default', clientId: null })).toBe(e.id);
    expect(dictionaryIdForRow({ id: systemRuleUuid(e.id), name: 'x', accountCode: 'y', origin: 'user', clientId: 'c' })).toBeNull();
  });
});

describe('buildConditionFromTransaction', () => {
  const tx = { direction: 'purchase' as const, merchantKey: '쿠팡', merchantBusinessNumber: '1208800767', description: '쿠팡 A4용지 구매' };
  it('bizno scope', () => {
    expect(buildConditionFromTransaction(tx, 'bizno').condition).toEqual({
      all: [{ field: 'direction', op: 'eq', value: 'purchase' }, { field: 'merchantBusinessNumber', op: 'eq', value: '1208800767' }],
    });
    expect(() => buildConditionFromTransaction({ ...tx, merchantBusinessNumber: null }, 'bizno')).toThrow(/사업자번호/);
  });
  it('merchant and merchant+description scopes', () => {
    expect(buildConditionFromTransaction(tx, 'merchant').condition).toEqual({
      all: [{ field: 'direction', op: 'eq', value: 'purchase' }, { field: 'merchantKey', op: 'eq', value: '쿠팡' }],
    });
    const r = buildConditionFromTransaction(tx, 'merchant_and_description');
    expect(r.keyword).toBe('A4용지');
    expect(buildConditionFromTransaction(tx, 'merchant_and_description', '토너').keyword).toBe('토너');
    expect(() => buildConditionFromTransaction({ ...tx, description: '' }, 'merchant_and_description')).toThrow(/키워드/);
  });
});

describe('normalizeReviewParams', () => {
  const base = DEFAULT_REVIEW_RULES.find((r) => r.code === 'RISK-HIGH-AMOUNT')!.params;
  it('parses formatted numbers and rejects bad values', () => {
    expect(normalizeReviewParams({ threshold: '3,000,000' }, base)).toEqual({ params: { threshold: 3_000_000 }, errors: [] });
    expect(normalizeReviewParams({ threshold: 'abc' }, base).errors[0]).toMatch(/숫자/);
    expect(normalizeReviewParams({ threshold: -5 }, base).errors[0]).toMatch(/0 이상/);
  });
  it('keeps list params as lists', () => {
    const r = normalizeReviewParams({ keywords: '골프, 유흥 ,' }, { keywords: ['a'] });
    expect(r.params.keywords).toEqual(['골프', '유흥']);
    expect(normalizeReviewParams({ keywords: '' }, { keywords: ['a'] }).errors).toHaveLength(1);
    expect(normalizeReviewParams({ 'bad-name': 1 }, {}).errors).toHaveLength(1);
  });
});
