import type { Won } from '@mintax/core';
import type { SyntheticFileKind } from './types';

/**
 * 원천 파일 레이아웃 (헤더 목록) — 합성 파일과 거래 rawData 의 열 이름.
 *
 * 근거: docs/research/02-wemembers.md §2.5 (홈택스 원본 엑셀, 커뮤니티 코드 관찰값 — 원본 샘플 미확보, 검증필요).
 * - 사업용카드: (B) 14열 — 승인일자·카드사·카드번호·가맹점사업자번호·가맹점명·공급가액·세액·비과세·합계·가맹점유형·업태·업종·공제여부결정·비고
 * - 현금영수증 매입: (C) 크롤링 필드명 (엑셀 원문 헤더 미확인, U8)
 * - 전자세금계산서: (A) 33열, 헤더 6행 (순서는 커뮤니티 1건 근거)
 * - 전자계산서: 세금계산서에서 세액 열을 뺀 형태로 가정 (U9 미확인)
 * - 카드매출·현금영수증 매출: 공개 레이아웃 미확인 → adapters 합성 픽스처와 같은 헤더 사용
 * 위멤버스 통합자료 엑셀 레이아웃은 공개 자료로 확인되지 않았다 (U2). 실제 샘플을 받으면 이 상수와 adapters 프로필을 함께 갱신한다.
 */

export const HOMETAX_CARD_HEADERS = [
  '승인일자', '카드사', '카드번호', '가맹점사업자번호', '가맹점명', '공급가액', '세액', '비과세', '합계',
  '가맹점유형', '업태', '업종', '공제여부결정', '비고',
] as const;

export const HOMETAX_CASH_RECEIPT_HEADERS = [
  '매입일시', '사용자명', '가맹점사업자번호', '가맹점명', '업종', '공급가액', '부가세', '봉사료', '매입금액',
  '승인번호', '발급수단', '거래구분', '공제여부', '비고',
] as const;

export const HOMETAX_TAX_INVOICE_HEADERS = [
  '작성일자', '승인번호', '발급일자', '전송일자', '공급자사업자등록번호', '종사업장번호', '상호', '대표자명', '주소',
  '공급받는자사업자등록번호', '종사업장번호', '상호', '대표자명', '주소', '합계금액', '공급가액', '세액',
  '전자세금계산서분류', '전자세금계산서종류', '발급유형', '비고', '영수/청구 구분', '공급자 이메일', '공급받는자 이메일1',
  '공급받는자 이메일2', '품목일자', '품목명', '품목규격', '품목수량', '품목단가', '품목공급가액', '품목세액', '품목비고',
] as const;

export const HOMETAX_INVOICE_EXEMPT_HEADERS = [
  '작성일자', '승인번호', '발급일자', '전송일자', '공급자사업자등록번호', '종사업장번호', '상호', '대표자명', '주소',
  '공급받는자사업자등록번호', '종사업장번호', '상호', '대표자명', '주소', '합계금액', '공급가액',
  '전자계산서분류', '전자계산서종류', '발급유형', '비고', '영수/청구 구분', '품목일자', '품목명', '품목공급가액',
] as const;

export const CARD_SALES_HEADERS = ['승인일자', '카드사', '카드번호', '승인번호', '승인금액', '거래구분', '할부'] as const;

/** 홈택스 현금영수증 매출 다운로드 필드 (hometaxbot 관찰, 02 §2.5-C) — adapters 프로필 없음 */
export const CASH_RECEIPT_SALES_HEADERS = [
  '매출일시', '공급가액', '부가세', '봉사료', '총금액', '승인번호', '발행구분', '거래구분', '비고', '신분확인뒷4자리',
] as const;

/** 공급자/공급받는자 블록의 같은 제목을 rawData 키로 구분 */
const INVOICE_PARTY_KEYS = [
  '공급자사업자등록번호', '공급자종사업장번호', '공급자상호', '공급자대표자명', '공급자주소',
  '공급받는자사업자등록번호', '공급받는자종사업장번호', '공급받는자상호', '공급받는자대표자명', '공급받는자주소',
];

export const HOMETAX_TAX_INVOICE_KEYS: readonly string[] = [
  '작성일자', '승인번호', '발급일자', '전송일자', ...INVOICE_PARTY_KEYS, '합계금액', '공급가액', '세액',
  ...HOMETAX_TAX_INVOICE_HEADERS.slice(17),
];

export const HOMETAX_INVOICE_EXEMPT_KEYS: readonly string[] = [
  '작성일자', '승인번호', '발급일자', '전송일자', ...INVOICE_PARTY_KEYS, '합계금액', '공급가액',
  ...HOMETAX_INVOICE_EXEMPT_HEADERS.slice(16),
];

export interface FileLayout {
  kind: SyntheticFileKind;
  label: string;
  headers: readonly string[];
  /** rawData 키 (headers 와 같은 길이) */
  keys: readonly string[];
  /** 헤더 위 제목·조회조건 행 수 (= 헤더 행 0-base 위치) */
  preambleRows: number;
  /** 대응하는 adapters FormatProfile id (없으면 null) */
  profileId: string | null;
  docsRef: string;
  verified: false;
}

export const FILE_LAYOUTS: Readonly<Record<SyntheticFileKind, FileLayout>> = {
  card_purchase: {
    kind: 'card_purchase', label: '사업용 신용카드 매입내역 (홈택스 매입세액 공제 확인/변경)',
    headers: HOMETAX_CARD_HEADERS, keys: HOMETAX_CARD_HEADERS, preambleRows: 1,
    profileId: 'hometax_card_purchase_v1', docsRef: 'docs/research/02-wemembers.md §2.5-(B)', verified: false,
  },
  card_purchase_resend: {
    // 같은 홈택스 엑셀이 Desktop Bridge 로 다시 들어온 경우. 승인번호 열을 더한 변형을 쓰면 원본(승인번호 없음)과
    // fingerprint 기준(승인번호 vs 복합키)이 달라져 완전중복이 잡히지 않는다 → 원본과 같은 14열을 쓴다.
    kind: 'card_purchase_resend', label: '사업용 신용카드 매입내역 재전송분 (Desktop Bridge, 원본과 같은 14열)',
    headers: HOMETAX_CARD_HEADERS, keys: HOMETAX_CARD_HEADERS, preambleRows: 1,
    profileId: 'hometax_card_purchase_v1', docsRef: 'docs/research/02-wemembers.md §2.5-(B), 멱등키(승인번호 없음 → 복합키)', verified: false,
  },
  cash_receipt_purchase: {
    kind: 'cash_receipt_purchase', label: '현금영수증 매입내역 (지출증빙)',
    headers: HOMETAX_CASH_RECEIPT_HEADERS, keys: HOMETAX_CASH_RECEIPT_HEADERS, preambleRows: 1,
    profileId: 'hometax_cash_receipt_purchase_v1', docsRef: 'docs/research/02-wemembers.md §2.5-(C), U8', verified: false,
  },
  tax_invoice_purchase: {
    kind: 'tax_invoice_purchase', label: '전자세금계산서 목록 (매입)',
    headers: HOMETAX_TAX_INVOICE_HEADERS, keys: HOMETAX_TAX_INVOICE_KEYS, preambleRows: 5,
    profileId: 'hometax_tax_invoice_v1', docsRef: 'docs/research/02-wemembers.md §2.5-(A)', verified: false,
  },
  tax_invoice_sales: {
    kind: 'tax_invoice_sales', label: '전자세금계산서 목록 (매출)',
    headers: HOMETAX_TAX_INVOICE_HEADERS, keys: HOMETAX_TAX_INVOICE_KEYS, preambleRows: 5,
    profileId: 'hometax_tax_invoice_v1', docsRef: 'docs/research/02-wemembers.md §2.5-(A)', verified: false,
  },
  invoice_exempt_purchase: {
    kind: 'invoice_exempt_purchase', label: '전자계산서 목록 (매입, 면세)',
    headers: HOMETAX_INVOICE_EXEMPT_HEADERS, keys: HOMETAX_INVOICE_EXEMPT_KEYS, preambleRows: 5,
    profileId: 'hometax_invoice_exempt_v1', docsRef: 'docs/research/02-wemembers.md U9', verified: false,
  },
  invoice_exempt_sales: {
    kind: 'invoice_exempt_sales', label: '전자계산서 목록 (매출, 면세)',
    headers: HOMETAX_INVOICE_EXEMPT_HEADERS, keys: HOMETAX_INVOICE_EXEMPT_KEYS, preambleRows: 5,
    profileId: 'hometax_invoice_exempt_v1', docsRef: 'docs/research/02-wemembers.md U9', verified: false,
  },
  card_sales: {
    kind: 'card_sales', label: '신용카드 매출내역 (건별)',
    headers: CARD_SALES_HEADERS, keys: CARD_SALES_HEADERS, preambleRows: 1,
    profileId: 'card_sales_v1', docsRef: 'docs/research/02-wemembers.md §2.5-(D) (레이아웃 미확인)', verified: false,
  },
  cash_receipt_sales: {
    kind: 'cash_receipt_sales', label: '현금영수증 매출내역',
    headers: CASH_RECEIPT_SALES_HEADERS, keys: CASH_RECEIPT_SALES_HEADERS, preambleRows: 1,
    profileId: null, docsRef: 'docs/research/02-wemembers.md §2.5-(C) hometaxbot 매출 필드', verified: false,
  },
};

// ────────────────────────────── 행 → rawData ──────────────────────────────

export interface PartyInfo {
  businessNumber: string;
  name: string;
  representativeName: string;
  address: string;
  email: string;
}

export interface CardRowSource {
  date: string;
  cardCompany: string;
  cardMasked: string;
  merchantBusinessNumber: string;
  merchantName: string;
  supply: Won | string;
  vat: Won | string;
  serviceCharge: Won | string;
  total: Won | string;
  merchantTypeLabel: string;
  bizType: string;
  category: string;
  deductibleLabel: string;
  note: string;
}

/** 홈택스 카드 14열 행. 원본 엑셀에 승인번호 열이 없으므로 승인번호는 rawData 에 넣지 않는다 (02 §멱등키). */
export function cardPurchaseRaw(s: CardRowSource): Record<string, unknown> {
  return {
    승인일자: s.date,
    카드사: s.cardCompany,
    카드번호: s.cardMasked,
    가맹점사업자번호: s.merchantBusinessNumber,
    가맹점명: s.merchantName,
    공급가액: s.supply,
    세액: s.vat,
    비과세: s.serviceCharge,
    합계: s.total,
    가맹점유형: s.merchantTypeLabel,
    업태: s.bizType,
    업종: s.category,
    공제여부결정: s.deductibleLabel,
    비고: s.note,
  };
}

export interface CashRowSource {
  dateTime: string;
  userName: string;
  merchantBusinessNumber: string;
  merchantName: string;
  category: string;
  supply: Won;
  vat: Won;
  serviceCharge: Won;
  total: Won;
  approvalNumber: string;
  cancel: boolean;
  deductibleLabel: string;
  note: string;
}

export function cashReceiptPurchaseRaw(s: CashRowSource): Record<string, unknown> {
  return {
    매입일시: s.dateTime,
    사용자명: s.userName,
    가맹점사업자번호: s.merchantBusinessNumber,
    가맹점명: s.merchantName,
    업종: s.category,
    공급가액: s.supply,
    부가세: s.vat,
    봉사료: s.serviceCharge,
    매입금액: s.total,
    승인번호: s.approvalNumber,
    발급수단: '사업자번호',
    거래구분: s.cancel ? '취소거래' : '승인거래',
    공제여부: s.deductibleLabel,
    비고: s.note,
  };
}

export interface InvoiceRowSource {
  date: string;
  sendDate: string;
  approvalNumber: string;
  supplier: PartyInfo;
  buyer: PartyInfo;
  supply: Won;
  vat: Won;
  total: Won;
  itemName: string;
  note: string;
}

export function taxInvoiceRaw(s: InvoiceRowSource): Record<string, unknown> {
  return {
    작성일자: s.date,
    승인번호: s.approvalNumber,
    발급일자: s.date,
    전송일자: s.sendDate,
    ...partyRaw(s.supplier, s.buyer),
    합계금액: s.total,
    공급가액: s.supply,
    세액: s.vat,
    전자세금계산서분류: '전자세금계산서',
    전자세금계산서종류: '일반',
    발급유형: '정발급',
    비고: s.note,
    '영수/청구 구분': '청구',
    '공급자 이메일': s.supplier.email,
    '공급받는자 이메일1': s.buyer.email,
    '공급받는자 이메일2': '',
    품목일자: s.date.slice(5).replace('-', ''),
    품목명: s.itemName,
    품목규격: '',
    품목수량: 1,
    품목단가: s.supply,
    품목공급가액: s.supply,
    품목세액: s.vat,
    품목비고: '',
  };
}

export function exemptInvoiceRaw(s: InvoiceRowSource): Record<string, unknown> {
  return {
    작성일자: s.date,
    승인번호: s.approvalNumber,
    발급일자: s.date,
    전송일자: s.sendDate,
    ...partyRaw(s.supplier, s.buyer),
    합계금액: s.total,
    공급가액: s.supply,
    전자계산서분류: '전자계산서',
    전자계산서종류: '일반',
    발급유형: '정발급',
    비고: s.note,
    '영수/청구 구분': '청구',
    품목일자: s.date.slice(5).replace('-', ''),
    품목명: s.itemName,
    품목공급가액: s.supply,
  };
}

function partyRaw(sup: PartyInfo, buy: PartyInfo): Record<string, unknown> {
  return {
    공급자사업자등록번호: sup.businessNumber,
    공급자종사업장번호: '',
    공급자상호: sup.name,
    공급자대표자명: sup.representativeName,
    공급자주소: sup.address,
    공급받는자사업자등록번호: buy.businessNumber,
    공급받는자종사업장번호: '',
    공급받는자상호: buy.name,
    공급받는자대표자명: buy.representativeName,
    공급받는자주소: buy.address,
  };
}

export function cardSalesRaw(s: { date: string; cardCompany: string; cardMasked: string; approvalNumber: string; total: Won; cancel: boolean }): Record<string, unknown> {
  return {
    승인일자: s.date,
    카드사: s.cardCompany,
    카드번호: s.cardMasked,
    승인번호: s.approvalNumber,
    승인금액: s.total,
    거래구분: s.cancel ? '취소' : '승인',
    할부: '일시불',
  };
}

export function cashReceiptSalesRaw(s: { dateTime: string; supply: Won; vat: Won; total: Won; approvalNumber: string }): Record<string, unknown> {
  return {
    매출일시: s.dateTime,
    공급가액: s.supply,
    부가세: s.vat,
    봉사료: 0,
    총금액: s.total,
    승인번호: s.approvalNumber,
    발행구분: '소득공제',
    거래구분: '승인거래',
    비고: '',
    신분확인뒷4자리: '****',
  };
}

/** 가맹점유형 라벨 (홈택스 카드 엑셀 관찰값) */
export function merchantTypeLabel(m: { corporate: boolean; taxType: 'general' | 'simplified' | 'exempt'; foreign?: boolean }): string {
  if (m.foreign) return '';
  if (m.taxType === 'exempt') return '면세사업자';
  if (m.taxType === 'simplified') return '간이과세자';
  return m.corporate ? '법인사업자' : '일반과세자';
}

export function deductibleLabel(hint: boolean | null): string {
  return hint === null ? '' : hint ? '공제' : '불공제';
}
