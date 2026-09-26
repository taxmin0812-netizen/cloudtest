import { describe, expect, it } from 'vitest';
import {
  FILE_KINDS,
  HOMETAX_CARD_HEADERS,
  HOMETAX_CASH_RECEIPT_HEADERS,
  HOMETAX_INVOICE_EXEMPT_HEADERS,
  HOMETAX_TAX_INVOICE_HEADERS,
  WEMEMBERS_CARD_VARIANT_HEADERS,
  buildAllFiles,
  buildCardPurchaseFile,
  buildCashReceiptFile,
  buildClientFiles,
  buildExemptInvoiceFile,
  buildResendFile,
  buildTaxInvoiceFile,
  fileKindOf,
} from './files';
import { FILE_LAYOUTS } from './layouts';
import { generateDataset } from './index';
import { SCENARIO_A_CODE, SCENARIO_PAYROLL_CODE } from './clients';

const ds = generateDataset();

describe('헤더 상수 (docs/research/02-wemembers.md §2.5)', () => {
  it('홈택스 사업용카드 14열', () => {
    expect([...HOMETAX_CARD_HEADERS]).toEqual(['승인일자', '카드사', '카드번호', '가맹점사업자번호', '가맹점명', '공급가액', '세액', '비과세', '합계', '가맹점유형', '업태', '업종', '공제여부결정', '비고']);
    expect(WEMEMBERS_CARD_VARIANT_HEADERS).toHaveLength(15);
  });

  it('전자세금계산서 33열 (공급자/공급받는자 중복 제목), 계산서 24열, 현금영수증 14열', () => {
    expect(HOMETAX_TAX_INVOICE_HEADERS).toHaveLength(33);
    expect(HOMETAX_TAX_INVOICE_HEADERS.filter((h) => h === '상호')).toHaveLength(2);
    expect(HOMETAX_INVOICE_EXEMPT_HEADERS).toHaveLength(24);
    expect(HOMETAX_INVOICE_EXEMPT_HEADERS).not.toContain('세액');
    expect(HOMETAX_CASH_RECEIPT_HEADERS).toHaveLength(14);
  });

  it('레이아웃 키는 헤더와 같은 길이이고 고유', () => {
    for (const kind of FILE_KINDS) {
      const l = FILE_LAYOUTS[kind];
      expect(l.keys, kind).toHaveLength(l.headers.length);
      expect(new Set(l.keys).size, kind).toBe(l.keys.length);
      expect(l.verified).toBe(false);
    }
  });
});

describe('파일 생성', () => {
  const files = buildAllFiles(ds);

  it('모든 파일 종류가 한 번 이상 생성되고, 모든 당월 거래·실패행이 정확히 한 파일에 들어간다', () => {
    expect(new Set(files.map((f) => f.kind))).toEqual(new Set(FILE_KINDS));
    const ids = files.flatMap((f) => f.rowIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(ds.current.length + ds.failures.length);
    for (const t of ds.current) expect(fileKindOf(t)).not.toBeNull();
  });

  it('행 구조: 헤더 위치·열 수·데이터 행 수', () => {
    for (const f of files) {
      expect(f.rows[f.headerRowIndex]).toEqual(f.header);
      expect(f.rows.length - f.headerRowIndex - 1).toBe(f.dataRowCount);
      for (const r of f.rows.slice(f.headerRowIndex + 1)) expect(r).toHaveLength(f.header.length);
      expect(f.fileName).toMatch(/^C\d{3}_.+_202609\.xlsx$/);
    }
  });

  it('A거래처 카드 파일: 제목 1행 + 헤더, 합계 = 거래 합계, 총 사용금액 표시', () => {
    const f = buildCardPurchaseFile(ds, SCENARIO_A_CODE)!;
    expect(f.headerRowIndex).toBe(1);
    expect(f.dataRowCount).toBeGreaterThanOrEqual(480);
    expect(String(f.rows[0]![0])).toBe(`총 사용금액 : ${f.totals.totalAmount.toLocaleString('ko-KR')}`);
    const sum = f.rows.slice(2).reduce((a, r) => a + Number(r[8]), 0);
    expect(sum).toBe(f.totals.totalAmount);
    // 카드번호는 마스킹만
    for (const r of f.rows.slice(2)) expect(String(r[2])).toMatch(/^\d{4}-\*{4}-\*{4}-\d{4}$/);
  });

  it("C009 카드 파일에 파싱 실패 행('3,2OO')이 들어간다", () => {
    const f = buildCardPurchaseFile(ds, 'C009')!;
    expect(f.failureRowIds).toEqual(['C009-2026-09-F01']);
    const idx = f.rowIds.indexOf('C009-2026-09-F01');
    expect(f.rows[f.headerRowIndex + 1 + idx]![8]).toBe('3,2OO');
  });

  it('세금계산서 파일: 제목 5행 뒤 6행째 헤더, 공급자/공급받는자 위치', () => {
    const p = buildTaxInvoiceFile(ds, 'C004', 'purchase')!;
    expect(p.headerRowIndex).toBe(5);
    expect(String(p.rows[0]![0])).toContain('매입');
    const client = ds.clients.find((c) => c.code === 'C004')!;
    for (const r of p.rows.slice(6)) expect(String(r[9]).replace(/-/g, '')).toBe(client.businessNumber);
    const s = buildTaxInvoiceFile(ds, 'C004', 'sales')!;
    expect(String(s.rows[0]![0])).toContain('매출');
    for (const r of s.rows.slice(6)) expect(String(r[4]).replace(/-/g, '')).toBe(client.businessNumber);
  });

  it('계산서·현금영수증·재전송 파일', () => {
    expect(buildExemptInvoiceFile(ds, 'C003', 'purchase')!.dataRowCount).toBeGreaterThan(0);
    expect(buildExemptInvoiceFile(ds, 'C017', 'sales')!.dataRowCount).toBeGreaterThan(0);
    expect(buildCashReceiptFile(ds, 'C015')!.rows.slice(2).some((r) => r[11] === '취소거래')).toBe(true);
    const resend = buildResendFile(ds, 'C004')!;
    expect(resend.header.at(-1)).toBe('승인번호');
    expect(resend.dataRowCount).toBe(2);
    for (const r of resend.rows.slice(2)) expect(String(r[14])).toMatch(/^\d{8}$/);
    expect(buildResendFile(ds, SCENARIO_PAYROLL_CODE)).toBeNull();
  });

  it('시나리오상사 카드 파일은 정확히 500행, 실패행 없음', () => {
    const f = buildClientFiles(ds, SCENARIO_PAYROLL_CODE).find((x) => x.kind === 'card_purchase')!;
    expect(f.dataRowCount).toBe(500);
    expect(f.failureRowIds).toEqual([]);
  });

  it('결정적: 같은 데이터셋이면 같은 파일', () => {
    expect(buildCardPurchaseFile(ds, 'C005')).toEqual(buildCardPurchaseFile(ds, 'C005'));
  });
});
