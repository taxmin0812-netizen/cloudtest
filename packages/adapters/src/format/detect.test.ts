import { describe, expect, it } from 'vitest';
import {
  cardPurchaseRows,
  cardSalesRows,
  cashReceiptRows,
  exemptInvoiceRows,
  genericRows,
  taxInvoiceRows,
  TAX_INVOICE_HEADER,
  toXlsxBuffer,
  wehagoLedgerRows,
} from '../__fixtures__/builders';
import { readTabularFile } from '../file/read';
import { normalizeHeader } from '../util/text';
import {
  buildColumnMapFromHeaders,
  confirmColumnMapping,
  detectFormat,
  detectFormatInFile,
  headerFingerprintOf,
  MIN_AUTO_CONFIDENCE,
  resolveColumns,
} from './detect';
import { FORMAT_PROFILES, GENERIC_V1, getFormatProfile, HOMETAX_TAX_INVOICE_V1 } from './profiles';

describe('normalizeHeader', () => {
  it('공백·개행·단위·기호를 제거한다', () => {
    expect(normalizeHeader(' 공급가액\n(원) ')).toBe('공급가액');
    expect(normalizeHeader('영수/청구 구분')).toBe('영수청구구분');
    expect(normalizeHeader('*승인번호')).toBe('승인번호');
    expect(normalizeHeader('공급받는자 이메일1')).toBe('공급받는자이메일1');
  });
});

describe('detectFormat — 프로필별', () => {
  it('사업용 신용카드: 2행 헤더(1행 요약)', () => {
    const d = detectFormat(cardPurchaseRows());
    expect(d.profile.id).toBe('hometax_card_purchase_v1');
    expect(d.headerRowIndex).toBe(1);
    expect(d.confidence).toBeGreaterThanOrEqual(90);
    expect(d.missingColumns).toEqual([]);
    expect(d.requiresUserMapping).toBe(false);
    expect(d.columnMap.deductibleDecision).toBe(12);
    expect(d.columnMap.taxFreeAmount).toBe(7);
    expect(d.headerFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(d.fingerprintKnown).toBe(false);
  });

  it('전자세금계산서: 6행 헤더, 중복 제목(상호·대표자명·종사업장번호)은 위치 문맥으로 구분', () => {
    const d = detectFormat(taxInvoiceRows());
    expect(d.profile.id).toBe('hometax_tax_invoice_v1');
    expect(d.headerRowIndex).toBe(5);
    expect(d.requiresUserMapping).toBe(false);
    expect(d.columnMap.supplierName).toBe(6);
    expect(d.columnMap.buyerName).toBe(11);
    expect(d.columnMap.supplierSubNumber).toBe(5);
    expect(d.columnMap.buyerSubNumber).toBe(10);
    expect(d.columnMap.supplierAddress).toBe(8);
    expect(d.columnMap.buyerAddress).toBe(13);
    expect(d.columnMap.itemSupplyAmount).toBe(30);
    expect(d.columnMap.supplyAmount).toBe(15);
    expect(d.columnMap.receiptOrClaim).toBe(21);
  });

  it('2013년 변형(맨 앞 번호, 주소 없음, 매입 기타 열)도 제목 기반으로 매핑', () => {
    const old = ['번호', '작성일자', '승인번호', '발급일자', '전송일자', '공급자사업자등록번호', '종사업장번호', '상호', '대표자명', '공급받는자사업자등록번호', '종사업장번호', '상호', '대표자명', '합계금액', '공급가액', '세액', '비고', '기타'];
    const d = detectFormat([['제목'], old]);
    expect(d.profile.id).toBe('hometax_tax_invoice_v1');
    expect(d.columnMap.supplierName).toBe(7);
    expect(d.columnMap.buyerName).toBe(11);
    expect(d.columnMap.transactionDate).toBe(1);
    // 다른 레이아웃 → 다른 지문
    expect(d.headerFingerprint).not.toBe(headerFingerprintOf(TAX_INVOICE_HEADER));
  });

  it('전자계산서(면세): 세액 열 없음 → 면세 프로필', () => {
    const d = detectFormat(exemptInvoiceRows());
    expect(d.profile.id).toBe('hometax_invoice_exempt_v1');
    expect(d.headerRowIndex).toBe(5);
  });

  it('현금영수증 매입', () => {
    const d = detectFormat(cashReceiptRows());
    expect(d.profile.id).toBe('hometax_cash_receipt_purchase_v1');
    expect(d.headerRowIndex).toBe(1);
    expect(d.columnMap.totalAmount).toBe(8);
    expect(d.columnMap.serviceCharge).toBe(7);
  });

  it('카드매출', () => {
    const d = detectFormat(cardSalesRows());
    expect(d.profile.id).toBe('card_sales_v1');
    expect(d.profile.direction).toBe('sales');
  });

  it('WEHAGO 매입매출장 역수입', () => {
    const d = detectFormat(wehagoLedgerRows(), { fileName: '매입매출장_202609.xlsx' });
    expect(d.profile.id).toBe('wehago_ledger_purchase_sales_v1');
    expect(d.profile.purpose).toBe('reconciliation');
  });

  it('알 수 없는 형식은 generic + 사용자 매핑 필요', () => {
    const d = detectFormat(genericRows());
    expect(d.profile.id).toBe(GENERIC_V1.id);
    expect(d.requiresUserMapping).toBe(true);
    expect(d.confidence).toBeLessThanOrEqual(50);
    expect(d.columnMap.transactionDate).toBe(0);
    expect(d.columnMap.merchantName).toBe(1);
    expect(d.columnMap.totalAmount).toBe(2);
    expect(d.missingColumns).toEqual([]);
    const noName = detectFormat([['날짜', '금액', '메모']]);
    expect(noName.profile.id).toBe('generic_v1');
    expect(noName.missingColumns).toEqual(['가맹점명/상호']);
  });

  it('아무 앵커도 없으면 confidence 0 generic', () => {
    const d = detectFormat([['a', 'b'], ['1', '2']]);
    expect(d.profile.id).toBe('generic_v1');
    expect(d.confidence).toBe(0);
    expect(d.headerRowIndex).toBe(0);
    expect(d.requiresUserMapping).toBe(true);
  });

  it('빈 시트', () => {
    const d = detectFormat([]);
    expect(d.headerRowIndex).toBe(-1);
    expect(d.headerFingerprint).toBeNull();
  });

  it('필수 열 누락 시 missingColumns 와 사용자 확인 요구', () => {
    const rows = [['승인일자', '카드번호', '가맹점명', '합계']];
    const d = detectFormat(rows);
    expect(d.profile.id).toBe('hometax_card_purchase_v1');
    expect(d.missingColumns).toContain('가맹점 사업자번호');
    expect(d.requiresUserMapping).toBe(true);
    expect(d.confidence).toBeLessThan(100);
  });

  it('제목행 힌트로 매입/매출 방향을 읽는다', () => {
    const rows = taxInvoiceRows();
    rows[0] = ['매입 전자세금계산서 목록조회'];
    expect(detectFormat(rows).directionHint).toBe('purchase');
    expect(detectFormat(taxInvoiceRows(), { fileName: '매출_세금계산서.xlsx' }).directionHint).toBe('sales');
  });

  it('후보 목록은 신뢰도 내림차순', () => {
    const d = detectFormat(taxInvoiceRows());
    const confs = d.candidates.map((c) => c.confidence);
    expect([...confs].sort((a, b) => b - a)).toEqual(confs);
    expect(d.candidates[0]!.profileId).toBe('hometax_tax_invoice_v1');
    expect(MIN_AUTO_CONFIDENCE).toBe(60);
  });
});

describe('detectFormatInFile', () => {
  it('여러 시트 중 인식되는 시트를 고른다', async () => {
    const buf = await toXlsxBuffer([
      { name: '안내', rows: [['이 파일은 테스트입니다']] },
      { name: '카드', rows: cardPurchaseRows() },
    ]);
    const f = await readTabularFile(buf, 'x.xlsx');
    const r = detectFormatInFile(f);
    expect(r.sheetName).toBe('카드');
    expect(r.sheetIndex).toBe(1);
    expect(r.detection.profile.id).toBe('hometax_card_purchase_v1');
  });
});

describe('열 매핑 유틸', () => {
  it('resolveColumns 는 같은 열을 두 필드에 쓰지 않는다', () => {
    const map = resolveColumns(HOMETAX_TAX_INVOICE_V1, TAX_INVOICE_HEADER);
    const idx = Object.values(map);
    expect(new Set(idx).size).toBe(idx.length);
  });

  it('buildColumnMapFromHeaders / confirmColumnMapping (generic)', () => {
    const rows = genericRows();
    const { columnMap, unresolved } = buildColumnMapFromHeaders(rows[0]!, {
      transactionDate: '날짜',
      merchantName: '거래처',
      totalAmount: 2,
      description: '메모',
      approvalNumber: '없는열',
    });
    expect(columnMap).toEqual({ transactionDate: 0, merchantName: 1, totalAmount: 2, description: 3 });
    expect(unresolved).toEqual(['approvalNumber']);
    const d = confirmColumnMapping(GENERIC_V1, rows, 0, columnMap);
    expect(d.userConfirmed).toBe(true);
    expect(d.requiresUserMapping).toBe(false);
  });

  it('프로필 데이터 무결성: id 규칙·필수 앵커·verified=false', () => {
    for (const p of FORMAT_PROFILES) {
      expect(p.id).toBe(`${p.key}_v${p.version}`);
      expect(getFormatProfile(p.id)).toBe(p);
      for (const combo of p.anchors) for (const f of combo) expect(p.columns.some((c) => c.field === f)).toBe(true);
      expect(p.verified).toBe(false);
      expect(p.note.length).toBeGreaterThan(10);
      expect(() => JSON.parse(JSON.stringify(p))).not.toThrow();
    }
  });
});

describe('리뷰 보강: 구조가 파일명 힌트보다 우선', () => {
  it('세금계산서 목록을 "계산서"·"면세" 파일명으로 올려도 세금계산서로 판정 (영세율 오분류 방지)', () => {
    const rows = taxInvoiceRows().slice(5); // 제목 없이 헤더부터
    for (const fileName of ['매입_계산서_202609.xlsx', '면세.xlsx']) {
      const d = detectFormat(rows, { fileName });
      expect(d.profile.id, fileName).toBe('hometax_tax_invoice_v1');
      expect(d.candidates.map((c) => c.profileId)).not.toContain('hometax_invoice_exempt_v1');
    }
  });

  it('전자계산서 목록을 "세금계산서" 파일명으로 올려도 면세 계산서로 판정', () => {
    const d = detectFormat(exemptInvoiceRows().slice(5), { fileName: '세금계산서_매입.xlsx' });
    expect(d.profile.id).toBe('hometax_invoice_exempt_v1');
    expect(d.requiresUserMapping).toBe(false);
  });

  it('필수 열이 빠진 후보는 힌트 점수로 완비된 후보를 이기지 못한다', () => {
    // 분류 열이 없어 구조로만 가리기 어려운 경우: 세액 열 없는 목록 + 세금계산서 힌트 → 필수(세액)가 빠진 세금계산서보다 면세가 우선
    const header = ['작성일자', '승인번호', '공급자사업자등록번호', '상호', '공급받는자사업자등록번호', '상호', '합계금액', '공급가액'];
    const d = detectFormat([header], { fileName: '전자세금계산서.xlsx' });
    expect(d.profile.id).toBe('hometax_invoice_exempt_v1');
    expect(d.missingFields).toEqual([]);
  });
});

describe('리뷰 보강: 여러 시트', () => {
  it('선택되지 않은 거래자료 시트를 알려 주고, 시트를 지정해 판정할 수 있다', async () => {
    const buf = await toXlsxBuffer([
      { name: '카드', rows: cardPurchaseRows() },
      { name: '현금영수증', rows: cashReceiptRows() },
      { name: '메모', rows: [['안녕하세요']] },
    ]);
    const file = await readTabularFile(buf, 'x.xlsx');
    const r = detectFormatInFile(file);
    expect(r.otherDataSheets.map((o) => o.sheetName)).toHaveLength(1);
    const other = r.otherDataSheets[0]!;
    expect(file.sheets[other.sheetIndex]!.name).not.toBe(r.sheetName);
    const forced = detectFormatInFile(file, { sheetIndex: other.sheetIndex });
    expect(forced.sheetName).toBe(other.sheetName);
    expect(forced.detection.profile.id).toBe(other.profileId);
    expect(() => detectFormatInFile(file, { sheetIndex: 9 })).toThrowError(/시트 번호/);
  });
});


describe('자동 적재 기준 설정', () => {
  it('minAutoConfidence 를 올리면 같은 파일도 사용자 확인을 요구한다', () => {
    expect(detectFormat(cardPurchaseRows()).requiresUserMapping).toBe(false);
    expect(detectFormat(cardPurchaseRows(), { minAutoConfidence: 101 }).requiresUserMapping).toBe(true);
  });
});
