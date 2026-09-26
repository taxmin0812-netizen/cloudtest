import { describe, expect, it } from 'vitest';
import { cardPurchaseRows, CLIENT, dashed, makeBizNo, OTHER_CLIENT, taxInvoiceRows, VENDOR_A } from './__fixtures__/builders';
import { detectClientFromFile, type ClientRef } from './client-match';

const clients: ClientRef[] = [
  { id: CLIENT.id, businessNumber: CLIENT.businessNumber, name: CLIENT.name },
  { id: OTHER_CLIENT.id, businessNumber: dashed(OTHER_CLIENT.businessNumber), name: OTHER_CLIENT.name },
  { id: 'vendor-as-client', businessNumber: VENDOR_A.bizno, name: VENDOR_A.name },
];

describe('detectClientFromFile', () => {
  it('세금계산서: 대부분 행에 반복되는 공급받는자/공급자 사업자번호가 수임처', () => {
    const r = detectClientFromFile({ rows: taxInvoiceRows(), fileName: '세금계산서.xlsx' }, clients.slice(0, 2));
    expect(r.best?.clientId).toBe(CLIENT.id);
    expect(r.best!.confidence).toBeGreaterThanOrEqual(85);
    expect(r.best!.reasons[0]).toContain('행에 사업자번호');
    expect(r.ambiguous).toBe(false);
  });

  it('거래 상대방으로 자주 등장한 다른 수임처는 낮은 순위 (차이가 작으면 사람 확인)', () => {
    const r = detectClientFromFile({ rows: taxInvoiceRows() }, clients);
    expect(r.best?.clientId).toBe(CLIENT.id);
    const vendor = r.candidates.find((c) => c.clientId === 'vendor-as-client')!;
    expect(vendor.confidence).toBeLessThan(r.best!.confidence);
    expect(r.ambiguous).toBe(true);
  });

  it('파일명 사업자번호 (하이픈 유무 무관)', () => {
    const r = detectClientFromFile({ rows: cardPurchaseRows(), fileName: `${CLIENT.businessNumber}_카드_202609.xlsx` }, clients);
    expect(r.best?.clientId).toBe(CLIENT.id);
    expect(r.best!.confidence).toBe(90);
    const r2 = detectClientFromFile({ fileName: `카드 ${dashed(OTHER_CLIENT.businessNumber)}.csv` }, clients);
    expect(r2.best?.clientId).toBe(OTHER_CLIENT.id);
  });

  it('파일명 상호 (정규화 비교)', () => {
    const r = detectClientFromFile({ fileName: '해피 카페_2026-09_현금영수증.csv' }, clients);
    expect(r.best?.clientId).toBe(OTHER_CLIENT.id);
    expect(r.best!.confidence).toBe(70);
  });

  it('제목행 사업자번호 + 파일명 상호가 일치하면 가산', () => {
    const rows = [[`사업자등록번호 : ${dashed(CLIENT.businessNumber)}`], ...cardPurchaseRows()];
    const r = detectClientFromFile({ rows, fileName: '민택스테스트 카드.xlsx' }, clients);
    expect(r.best?.clientId).toBe(CLIENT.id);
    expect(r.best!.confidence).toBe(98);
    expect(r.best!.reasons).toHaveLength(2);
  });

  it('근거가 없으면 best=null, ambiguous', () => {
    const r = detectClientFromFile({ rows: cardPurchaseRows(), fileName: 'download (3).xlsx' }, clients);
    expect(r.best).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it('두 수임처가 비슷하면 ambiguous', () => {
    const r = detectClientFromFile({ fileName: `${CLIENT.businessNumber}_${OTHER_CLIENT.businessNumber}.xlsx` }, clients);
    expect(r.candidates).toHaveLength(2);
    expect(r.ambiguous).toBe(true);
  });

  it('등록되지 않은 사업자번호는 무시', () => {
    const r = detectClientFromFile({ fileName: `${makeBizNo('999990000')}.xlsx` }, clients);
    expect(r.candidates).toEqual([]);
  });
});
