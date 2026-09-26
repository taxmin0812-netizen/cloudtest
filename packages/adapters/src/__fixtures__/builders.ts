/**
 * 테스트용 합성 샘플 (실데이터 아님).
 * 레이아웃은 docs/research/02-wemembers.md §2.5 관찰값을 따른다. 사업자번호는 체크섬이 맞는 가상 번호.
 * 파일은 테스트 안에서 버퍼로 생성한다 (xlsx / UTF-8 / CP949 CSV).
 */
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';

export function makeBizNo(prefix9: string): string {
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(prefix9[i]) * w[i]!;
  sum += Math.floor((Number(prefix9[8]) * 5) / 10);
  return prefix9 + String((10 - (sum % 10)) % 10);
}

export function dashed(bizno: string): string {
  return `${bizno.slice(0, 3)}-${bizno.slice(3, 5)}-${bizno.slice(5)}`;
}

export const CLIENT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '(주)민택스테스트',
  businessNumber: makeBizNo('214860001'),
};
export const OTHER_CLIENT = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '해피카페',
  businessNumber: makeBizNo('105810002'),
};

export const VENDOR_A = { name: '(주)오피스디포코리아', bizno: makeBizNo('120810003') };
export const VENDOR_B = { name: '스타벅스커피 강남점', bizno: makeBizNo('201810004') };
export const VENDOR_C = { name: '김밥천국 역삼점', bizno: makeBizNo('211190005') };
export const CUSTOMER_A = { name: '(주)가나상사', bizno: makeBizNo('134860006') };

// ────────────────────────────── 사업용 신용카드 (14열) ──────────────────────────────

export const CARD_HEADER = ['승인일자', '카드사', '카드번호', '가맹점사업자번호', '가맹점명', '공급가액', '세액', '비과세', '합계', '가맹점유형', '업태', '업종', '공제여부결정', '비고'];

/** 데이터 11행 + 합계행 1행 (= 데이터행 12). 1행은 요약, 2행이 헤더 */
export function cardPurchaseRows(): unknown[][] {
  return [
    ['총 사용금액 : 108,900'],
    CARD_HEADER,
    ['2026-09-01', '비씨카드 (주)', '4111-1111-1111-1111', dashed(VENDOR_B.bizno), VENDOR_B.name, 9091, 909, 0, 10000, '일반과세자', '음식', '커피전문점', '공제', ''],
    ['2026-09-02', '비씨카드 (주)', '4111-1111-1111-1111', dashed(VENDOR_A.bizno), VENDOR_A.name, '20,000', '2,000', '1,000', '23,000', '법인사업자', '도소매', '사무용품', '공제', ''],
    ['2026-09-03', '신한카드', '5555-5555-5555-4444', dashed(VENDOR_C.bizno), VENDOR_C.name, 5500, 0, 0, 5500, '간이과세자', '음식', '분식', '불공제', '간이과세자'],
    ['2026-09-04', '비씨카드 (주)', '4111-1111-1111-1111', dashed(VENDOR_B.bizno), VENDOR_B.name, -9091, -909, 0, -10000, '일반과세자', '음식', '커피전문점', '공제', '취소'],
    ['2026-09-05', '비씨카드 (주)', '4111-1111-1111-1111', dashed(VENDOR_B.bizno), VENDOR_B.name, 4546, 454, 0, 5000, '일반과세자', '음식', '커피전문점', '공제', ''],
    ['2026-09-05', '비씨카드 (주)', '4111-1111-1111-1111', dashed(VENDOR_B.bizno), VENDOR_B.name, 4546, 454, 0, 5000, '일반과세자', '음식', '커피전문점', '공제', ''],
    ['2026-09-06', '신한카드', '5555-5555-5555-4444', dashed(VENDOR_A.bizno), VENDOR_A.name, 1000, 100, 0, 1200, '법인사업자', '도소매', '사무용품', '공제', ''],
    ['2026-13-45', '신한카드', '5555-5555-5555-4444', dashed(VENDOR_A.bizno), VENDOR_A.name, 1000, 100, 0, 1100, '법인사업자', '도소매', '사무용품', '공제', ''],
    ['2026-09-07', '신한카드', '5555-5555-5555-4444', dashed(VENDOR_A.bizno), VENDOR_A.name, 'abc', 100, 0, 1100, '법인사업자', '도소매', '사무용품', '공제', ''],
    ['2026-09-08', '신한카드', '5555-5555-5555-4444', dashed(VENDOR_A.bizno), VENDOR_A.name, 60000, 6000, 0, 66000, '법인사업자', '도소매', '사무용품', '불공제', '선택불공제 카드 4111111111111111 참고'],
    ['2026-09-09', '신한카드', '5555-5555-5555-4444', '', 'AMAZON WEB SERVICES', '', '', '', 8800, '', '', '', '공제', '해외'],
    ['합계', '', '', '', '', 94692, 9108, 1000, 110200, '', '', '', '', ''],
  ];
}

// ────────────────────────────── 전자세금계산서 목록 (33열, 헤더 6행) ──────────────────────────────

export const TAX_INVOICE_HEADER = [
  '작성일자', '승인번호', '발급일자', '전송일자', '공급자사업자등록번호', '종사업장번호', '상호', '대표자명', '주소',
  '공급받는자사업자등록번호', '종사업장번호', '상호', '대표자명', '주소', '합계금액', '공급가액', '세액',
  '전자세금계산서분류', '전자세금계산서종류', '발급유형', '비고', '영수/청구 구분', '공급자 이메일', '공급받는자 이메일1',
  '공급받는자 이메일2', '품목일자', '품목명', '품목규격', '품목수량', '품목단가', '품목공급가액', '품목세액', '품목비고',
];

function invRow(p: {
  date: string;
  apv: string;
  sup: { name: string; bizno: string };
  buy: { name: string; bizno: string };
  supply: number | string;
  vat: number | string;
  total: number | string;
  item?: string;
  itemSupply?: number;
}): unknown[] {
  return [
    p.date, p.apv, p.date, p.date, dashed(p.sup.bizno), '', p.sup.name, '홍길동', '서울 강남구',
    p.buy.bizno.length === 10 ? dashed(p.buy.bizno) : p.buy.bizno, '', p.buy.name, '김철수', '서울 서초구',
    p.total, p.supply, p.vat, '일반', '일반', '전자발급', '', '청구', 'a@example.com', 'b@example.com', '',
    p.date, p.item ?? '사무용품', '', 1, p.itemSupply ?? p.supply, p.itemSupply ?? p.supply, p.vat, '',
  ];
}

const ME = () => ({ name: CLIENT.name, bizno: CLIENT.businessNumber });

/** 데이터행 9 (거래 5 + 병합 2 + 실패 2) */
export function taxInvoiceRows(): unknown[][] {
  return [
    ['전자세금계산서 목록조회'],
    ['조회기간 : 2026-09-01 ~ 2026-09-30'],
    ['조회구분 : 매입/매출 전체'],
    [],
    ['※ 본 자료는 조회용입니다.'],
    TAX_INVOICE_HEADER,
    invRow({ date: '20260910', apv: '20260910-41000012-00000001', sup: VENDOR_A, buy: ME(), supply: 100000, vat: 10000, total: 110000, item: 'A4 용지' }),
    invRow({ date: '20260911', apv: '20260911-41000012-00000002', sup: ME(), buy: CUSTOMER_A, supply: 500000, vat: 50000, total: 550000, item: '컨설팅' }),
    invRow({ date: '20260912', apv: '20260912-41000012-00000003', sup: VENDOR_A, buy: ME(), supply: -20000, vat: -2000, total: -22000, item: '반품' }),
    // 품목 2행(동일 금액 반복) → 1건으로 병합
    invRow({ date: '20260913', apv: '20260913-41000012-00000004', sup: VENDOR_A, buy: ME(), supply: 30000, vat: 3000, total: 33000, item: '토너', itemSupply: 20000 }),
    invRow({ date: '20260913', apv: '20260913-41000012-00000004', sup: VENDOR_A, buy: ME(), supply: 30000, vat: 3000, total: 33000, item: '드럼', itemSupply: 10000 }),
    // 품목 연속행(금액 빈칸) → 병합
    invRow({ date: '20260913', apv: '20260913-41000012-00000004', sup: { name: '', bizno: '' }, buy: { name: '', bizno: '' }, supply: '', vat: '', total: '', item: '케이블', itemSupply: 0 }),
    // 다른 수임처 자료 → 실패
    invRow({ date: '20260914', apv: '20260914-41000012-00000005', sup: VENDOR_A, buy: CUSTOMER_A, supply: 1000, vat: 100, total: 1100 }),
    // 개인에게 발급 (공급받는자 주민번호) → 매출, 주민번호 마스킹
    invRow({ date: '20260915', apv: '20260915-41000012-00000006', sup: ME(), buy: { name: '이영희', bizno: '900101-1234567' }, supply: 10000, vat: 1000, total: 11000 }),
    // 금액 불일치 → 실패
    invRow({ date: '20260916', apv: '20260916-41000012-00000007', sup: VENDOR_A, buy: ME(), supply: 10000, vat: 1000, total: 11001 }),
  ];
}

// ────────────────────────────── 전자계산서(면세) ──────────────────────────────

export const EXEMPT_INVOICE_HEADER = [
  '작성일자', '승인번호', '발급일자', '전송일자', '공급자사업자등록번호', '종사업장번호', '상호', '대표자명', '주소',
  '공급받는자사업자등록번호', '종사업장번호', '상호', '대표자명', '주소', '합계금액', '공급가액',
  '전자계산서분류', '전자계산서종류', '발급유형', '비고', '영수/청구 구분', '품목일자', '품목명', '품목공급가액',
];

export function exemptInvoiceRows(): unknown[][] {
  const r = (date: string, apv: string, sup: { name: string; bizno: string }, buy: { name: string; bizno: string }, supply: number, total: number) => [
    date, apv, date, date, dashed(sup.bizno), '', sup.name, '대표', '주소', dashed(buy.bizno), '', buy.name, '대표', '주소', total, supply,
    '일반', '일반', '전자발급', '', '영수', date, '농산물', supply,
  ];
  return [
    ['전자계산서 목록조회'],
    [],
    [],
    [],
    [],
    EXEMPT_INVOICE_HEADER,
    r('2026-09-03', '20260903-51000012-00000001', { name: '가락시장청과', bizno: makeBizNo('220810007') }, ME(), 300000, 300000),
    r('2026-09-04', '20260904-51000012-00000002', { name: '가락시장청과', bizno: makeBizNo('220810007') }, ME(), 120000, 125000),
  ];
}

// ────────────────────────────── 현금영수증 매입 ──────────────────────────────

export const CASH_HEADER = ['매입일시', '사용자명', '가맹점사업자번호', '가맹점명', '업종', '공급가액', '부가세', '봉사료', '매입금액', '승인번호', '발급수단', '거래구분', '공제여부', '비고'];

export function cashReceiptRows(): unknown[][] {
  return [
    ['현금영수증 매입내역(지출증빙) 조회'],
    CASH_HEADER,
    ['2026-09-01 12:30:11', '홍길동', dashed(VENDOR_C.bizno), VENDOR_C.name, '분식', 9091, 909, 0, 10000, 'C0000001', '사업자카드', '승인거래', '공제', ''],
    ['2026-09-02 09:10:00', '홍길동', dashed(VENDOR_A.bizno), VENDOR_A.name, '사무용품', 9091, 909, 0, 10000, 'C0000002', '사업자카드', '취소거래', '공제', ''],
    ['2026-09-03 18:00:00', '홍길동', dashed(VENDOR_A.bizno), VENDOR_A.name, '사무용품', '', '', '', 33000, 'C0000003', '사업자카드', '승인거래', '공제', '합계만 제공'],
    ['2026-09-04 10:00:00', '홍길동', dashed(VENDOR_B.bizno), VENDOR_B.name, '커피', 18182, 1818, 2000, 22000, 'C0000004', '휴대폰', '승인거래', '불공제', ''],
  ];
}

// ────────────────────────────── 카드매출 ──────────────────────────────

export const CARD_SALES_HEADER = ['승인일자', '카드사', '카드번호', '승인번호', '승인금액', '거래구분', '할부'];

export function cardSalesRows(): unknown[][] {
  return [
    ['신용카드 매출내역'],
    CARD_SALES_HEADER,
    ['2026-09-01', '국민카드', '9410-12**-****-3456', '30001234', 11000, '승인', '일시불'],
    ['2026-09-01', '삼성카드', '5310-45**-****-1111', '30001235', 55000, '승인', '3'],
    ['2026-09-02', '국민카드', '9410-12**-****-3456', '30001236', 11000, '취소', '일시불'],
  ];
}

// ────────────────────────────── WEHAGO 매입매출장 (역수입) ──────────────────────────────

export const LEDGER_HEADER = ['일자', '유형', '거래처코드', '거래처', '사업자번호', '품명', '공급가액', '부가세', '합계', '차변계정', '대변계정', '관리', '전표상태'];

export function wehagoLedgerRows(): unknown[][] {
  return [
    ['매입매출장'],
    LEDGER_HEADER,
    ['2026-09-01', '57.카과', '00101', VENDOR_B.name, dashed(VENDOR_B.bizno), '커피', 9091, 909, 10000, '811 복리후생비', '253 미지급금', 'M1', '승인'],
    ['2026-09-02', '51', '00102', VENDOR_A.name, dashed(VENDOR_A.bizno), 'A4 용지', 100000, 10000, 110000, '830 소모품비', '251 외상매입금', 'M2', '승인'],
    ['2026-09-11', '11', '00201', CUSTOMER_A.name, dashed(CUSTOMER_A.bizno), '컨설팅', 500000, 50000, 550000, '108 외상매출금', '401 상품매출', 'M3', '승인'],
    ['2026-09-12', '카과', '00101', VENDOR_B.name, '', '커피', 4546, 454, 5000, '811 복리후생비', '253 미지급금', 'M4', '승인'],
  ];
}

// ────────────────────────────── generic ──────────────────────────────

export function genericRows(): unknown[][] {
  return [
    ['날짜', '거래처', '금액', '메모'],
    ['2026-09-01', '동네철물점', 22000, '공구'],
    ['2026-09-02', '문구나라', 5500, '볼펜'],
  ];
}

// ────────────────────────────── 파일 버퍼 ──────────────────────────────

export async function toXlsxBuffer(sheets: Array<{ name: string; rows: unknown[][] }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((r, i) => {
      if (r.length === 0) return;
      const row = ws.getRow(i + 1);
      r.forEach((v, j) => {
        row.getCell(j + 1).value = v as ExcelJS.CellValue;
      });
      row.commit();
    });
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvText(rows: unknown[][], delimiter = ','): string {
  return rows.map((r) => r.map(csvCell).join(delimiter)).join('\r\n') + '\r\n';
}

export function toCsvBuffer(rows: unknown[][], encoding: 'utf8' | 'utf8bom' | 'cp949' = 'utf8', delimiter = ','): Buffer {
  const text = toCsvText(rows, delimiter);
  if (encoding === 'cp949') return iconv.encode(text, 'cp949');
  const b = Buffer.from(text, 'utf8');
  return encoding === 'utf8bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) : b;
}
