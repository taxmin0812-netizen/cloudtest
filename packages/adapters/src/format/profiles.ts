/**
 * 파일 형식 프로필 (데이터).
 *
 * 근거: docs/research/02-wemembers.md §2.5 (홈택스 원본 레이아웃 — 커뮤니티 코드 관찰, 원본 샘플 미확보),
 *       docs/research/01-wehago.md §2.4 (WEHAGO 매입매출장 엑셀 변환 항목 [공식 발췌]).
 * 실제 사무소 샘플로 확인되기 전까지 모든 프로필은 verified=false 이다.
 * 위멤버스 통합자료 엑셀의 열 구성은 공개 자료로 확인되지 않아(02 U2) 홈택스 프로필에 흔한 변형 별칭을 함께 넣었다.
 *
 * Desktop Bridge 스니퍼와 공유할 수 있도록 순수 JSON 호환 데이터로만 구성한다 (정규식은 문자열).
 */
import type { Direction, EvidenceType, TransactionSource } from '@mintax/core';
import type { CanonicalField } from './fields';

export interface ColumnSpec {
  field: CanonicalField;
  /** 어느 위치든 일치하면 매핑되는 제목 별칭 (normalizeHeader 기준 비교) */
  aliases: string[];
  /**
   * 같은 제목이 여러 번 나오는 형식용 (예: 세금계산서의 '상호'가 공급자·공급받는자에 두 번).
   * after/before 필드의 열 위치 사이에서만 매칭한다.
   */
  contextual?: { aliases: string[]; after?: CanonicalField; before?: CanonicalField };
  required?: boolean;
}

export type AmountComponent = 'supplyAmount' | 'vatAmount' | 'serviceCharge' | 'taxFreeAmount';

export interface AmountRule {
  /** 합계 = 이 항목들의 합 (검산식). 없는 열은 0 으로 본다 */
  components: AmountComponent[];
  /**
   * 합계만 있고 공급가액·세액이 없을 때:
   * - by_tax_type: 과세(또는 미상)면 10% 포함가 역산, 면세/간이면 합계=공급가액
   * - exempt: 합계=공급가액, 세액 0
   * - fail: 역산하지 않고 실패 처리
   */
  totalOnly: 'by_tax_type' | 'exempt' | 'fail';
  /** 세액 열이 없는 형식 (면세 계산서) */
  vatAlwaysZero?: boolean;
}

export type ProfileStatus = 'verified' | 'observed' | 'mock';

export interface FormatProfile {
  /** key_v{version} — import_jobs.format_profile 에 저장 */
  id: string;
  key: string;
  version: number;
  name: string;
  purpose: 'transactions' | 'reconciliation';
  source: TransactionSource;
  /** null = 행마다 결정(역수입 유형코드) 또는 사용자 지정 */
  evidenceType: EvidenceType | null;
  /** auto = 행마다 수임처 사업자번호가 공급자/공급받는자 중 어디인지로 결정. null = 행/사용자 지정 */
  direction: Direction | 'auto' | null;
  columns: ColumnSpec[];
  /** 헤더 판정용 필수 조합 — 하나라도 전부 매칭되면 후보 */
  anchors: CanonicalField[][];
  /**
   * 제목행에 이 제목(normalizeHeader 기준 정확 일치)이 하나라도 있으면 이 형식이 아니다.
   * 파일명·제목 힌트보다 우선하는 구조적 판별 근거 (예: 세금계산서 ↔ 계산서 분류 열).
   */
  rejectHeaders?: string[];
  headerScanRows: number;
  amountRule: AmountRule;
  /** 제목행·파일명에서 찾을 정규식(문자열) — 일치 시 가산점 */
  hintPatterns: string[];
  requiresUserMapping: boolean;
  status: ProfileStatus;
  verified: boolean;
  /** 근거·미확인 사항 (검증필요) */
  note: string;
  docsRef: string;
  /** 실제 샘플로 등록된 헤더 지문 (sha256). 비어 있으면 모든 지문이 '미등록' */
  knownHeaderFingerprints: string[];
  /** 동점일 때 우선순위 (높을수록 우선) */
  priority: number;
}

const DATE_ALIASES_CARD = ['승인일자', '거래일자', '이용일자', '사용일자', '승인일', '거래일', '승인일시', '거래일시', '이용일'];

export const HOMETAX_CARD_PURCHASE_V1: FormatProfile = {
  id: 'hometax_card_purchase_v1',
  key: 'hometax_card_purchase',
  version: 1,
  name: '사업용 신용카드 매입내역 (홈택스 매입세액 공제 확인/변경)',
  purpose: 'transactions',
  source: 'business_card',
  evidenceType: 'card',
  direction: 'purchase',
  columns: [
    { field: 'transactionDate', aliases: DATE_ALIASES_CARD, required: true },
    { field: 'cardCompany', aliases: ['카드사', '카드사명', '카드종류'] },
    { field: 'cardNumber', aliases: ['카드번호'] },
    { field: 'merchantBusinessNumber', aliases: ['가맹점사업자번호', '가맹점사업자등록번호', '가맹점사업자'], required: true },
    { field: 'merchantName', aliases: ['가맹점명', '가맹점상호', '가맹점'], required: true },
    { field: 'supplyAmount', aliases: ['공급가액'] },
    { field: 'vatAmount', aliases: ['세액', '부가세', '부가가치세', '부가세액'] },
    { field: 'taxFreeAmount', aliases: ['비과세', '면세금액'] },
    { field: 'serviceCharge', aliases: ['봉사료'] },
    { field: 'totalAmount', aliases: ['합계', '합계금액', '이용금액', '승인금액', '거래금액', '매입금액', '총금액'], required: true },
    { field: 'merchantTaxType', aliases: ['가맹점유형', '가맹점과세유형', '과세유형'] },
    { field: 'merchantBizType', aliases: ['업태'] },
    { field: 'merchantCategory', aliases: ['업종', '업종명', '가맹점업종'] },
    { field: 'deductibleDecision', aliases: ['공제여부결정', '공제여부', '공제구분', '매입세액공제여부'] },
    { field: 'deductibleNote', aliases: ['비고'] },
    { field: 'approvalNumber', aliases: ['승인번호'] },
    { field: 'currency', aliases: ['통화', '결제통화', '통화코드'] },
    { field: 'foreignAmount', aliases: ['외화금액', '현지금액', '현지통화금액', '해외이용금액'] },
    { field: 'overseasFlag', aliases: ['국내외구분', '해외여부', '국내해외구분', '해외구분'] },
  ],
  anchors: [
    ['transactionDate', 'merchantBusinessNumber', 'deductibleDecision'],
    ['transactionDate', 'cardNumber', 'merchantName', 'totalAmount'],
  ],
  headerScanRows: 30,
  amountRule: { components: ['supplyAmount', 'vatAmount', 'taxFreeAmount', 'serviceCharge'], totalOnly: 'by_tax_type' },
  hintPatterns: ['신용카드', '사업용\\s*카드', '카드\\s*매입'],
  requiresUserMapping: false,
  status: 'observed',
  verified: false,
  note:
    '검증필요: 14개 열(승인일자·카드사·카드번호·가맹점사업자번호·가맹점명·공급가액·세액·비과세·합계·가맹점유형·업태·업종·공제여부결정·비고)은 커뮤니티 코드 관찰값이다. ' +
    '검산식 합계=공급가액+세액+비과세(+봉사료)는 예시값 기반 추론. 승인번호 열이 없어 동일 거래 구분용 원천ID(card|…#순번)를 만든다. 위멤버스 변형 별칭(부가세·봉사료·공제여부)은 추정.',
  docsRef: 'docs/research/02-wemembers.md §2.5-(B), docs/integration-architecture.md §4.2',
  knownHeaderFingerprints: [],
  priority: 50,
};

export const HOMETAX_CASH_RECEIPT_PURCHASE_V1: FormatProfile = {
  id: 'hometax_cash_receipt_purchase_v1',
  key: 'hometax_cash_receipt_purchase',
  version: 1,
  name: '현금영수증 매입내역 (지출증빙)',
  purpose: 'transactions',
  source: 'cash_receipt',
  evidenceType: 'cash_receipt',
  direction: 'purchase',
  columns: [
    { field: 'transactionDate', aliases: ['매입일시', '거래일시', '거래일자', '매입일자', '사용일자', '발행일자', '승인일자', '거래일'], required: true },
    { field: 'merchantName', aliases: ['가맹점명', '가맹점상호', '상호', '사용처', '가맹점'], required: true },
    { field: 'merchantBusinessNumber', aliases: ['가맹점사업자번호', '가맹점사업자등록번호', '사업자번호', '사업자등록번호'] },
    { field: 'supplyAmount', aliases: ['공급가액'] },
    { field: 'vatAmount', aliases: ['부가세', '세액', '부가가치세'] },
    { field: 'serviceCharge', aliases: ['봉사료'] },
    { field: 'totalAmount', aliases: ['매입금액', '총금액', '합계', '합계금액', '거래금액', '금액', '사용금액'], required: true },
    { field: 'approvalNumber', aliases: ['승인번호'], required: true },
    { field: 'transactionKind', aliases: ['거래구분', '승인구분', '승인취소구분'] },
    { field: 'issueMethod', aliases: ['발급수단', '발행수단'] },
    { field: 'userName', aliases: ['사용자명', '사용자'] },
    { field: 'deductibleDecision', aliases: ['공제여부', '매입세액공제여부', '공제구분'] },
    { field: 'merchantCategory', aliases: ['업종', '업종명'] },
    { field: 'merchantCategoryCode', aliases: ['업종코드'] },
    { field: 'merchantBizType', aliases: ['업태'] },
    { field: 'note', aliases: ['비고', '사용구분'] },
  ],
  anchors: [['transactionDate', 'merchantName', 'approvalNumber', 'totalAmount']],
  headerScanRows: 30,
  amountRule: { components: ['supplyAmount', 'vatAmount', 'serviceCharge'], totalOnly: 'by_tax_type' },
  hintPatterns: ['현금영수증'],
  requiresUserMapping: false,
  status: 'observed',
  verified: false,
  note:
    '검증필요: 엑셀 헤더 원문은 미확인이며 크롤링 필드명(매입일시·가맹점명·공급가액·부가세·봉사료·매입금액·승인번호·거래구분·공제여부 등)을 별칭으로 사용했다. ' +
    '매입금액=공급가액+부가세+봉사료는 추론(커뮤니티 코드는 대체값으로만 사용). 거래구분이 "취소"면 음수로 처리한다.',
  docsRef: 'docs/research/02-wemembers.md §2.5-(C), U8',
  knownHeaderFingerprints: [],
  priority: 50,
};

/** 세금계산서·계산서 목록 공통 열 (공급자/공급받는자 블록의 중복 제목은 위치 문맥으로 구분) */
function invoiceColumns(kind: 'tax' | 'exempt'): ColumnSpec[] {
  const supplierCtx = { after: 'supplierBusinessNumber', before: 'buyerBusinessNumber' } as const;
  const buyerCtx = { after: 'buyerBusinessNumber' } as const;
  const cols: ColumnSpec[] = [
    { field: 'transactionDate', aliases: ['작성일자'], required: true },
    { field: 'approvalNumber', aliases: ['승인번호'], required: true },
    { field: 'issueDate', aliases: ['발급일자'] },
    { field: 'sendDate', aliases: ['전송일자'] },
    { field: 'supplierBusinessNumber', aliases: ['공급자사업자등록번호', '공급자사업자번호', '공급자등록번호'], required: true },
    { field: 'supplierSubNumber', aliases: ['공급자종사업장번호'], contextual: { aliases: ['종사업장번호'], ...supplierCtx } },
    { field: 'supplierName', aliases: ['공급자상호', '공급자명'], contextual: { aliases: ['상호', '상호명'], ...supplierCtx }, required: true },
    { field: 'supplierRepresentative', aliases: ['공급자대표자명'], contextual: { aliases: ['대표자명', '대표자'], ...supplierCtx } },
    { field: 'supplierAddress', aliases: ['공급자주소'], contextual: { aliases: ['주소'], ...supplierCtx } },
    { field: 'buyerBusinessNumber', aliases: ['공급받는자사업자등록번호', '공급받는자사업자번호', '공급받는자등록번호'], required: true },
    { field: 'buyerSubNumber', aliases: ['공급받는자종사업장번호'], contextual: { aliases: ['종사업장번호'], ...buyerCtx } },
    { field: 'buyerName', aliases: ['공급받는자상호', '공급받는자명'], contextual: { aliases: ['상호', '상호명'], ...buyerCtx }, required: true },
    { field: 'buyerRepresentative', aliases: ['공급받는자대표자명'], contextual: { aliases: ['대표자명', '대표자'], ...buyerCtx } },
    { field: 'buyerAddress', aliases: ['공급받는자주소'], contextual: { aliases: ['주소'], ...buyerCtx } },
    { field: 'totalAmount', aliases: ['합계금액', '합계'], required: true },
    { field: 'supplyAmount', aliases: ['공급가액'], required: true },
    { field: 'issueType', aliases: ['발급유형'] },
    { field: 'note', aliases: ['비고'] },
    { field: 'receiptOrClaim', aliases: ['영수청구구분', '영수청구'] },
    { field: 'supplierEmail', aliases: ['공급자이메일'] },
    { field: 'buyerEmail1', aliases: ['공급받는자이메일1', '공급받는자이메일'] },
    { field: 'buyerEmail2', aliases: ['공급받는자이메일2'] },
    { field: 'itemDate', aliases: ['품목일자'] },
    { field: 'itemName', aliases: ['품목명'] },
    { field: 'itemSpec', aliases: ['품목규격'] },
    { field: 'itemQuantity', aliases: ['품목수량'] },
    { field: 'itemUnitPrice', aliases: ['품목단가'] },
    { field: 'itemSupplyAmount', aliases: ['품목공급가액'] },
    { field: 'itemNote', aliases: ['품목비고'] },
  ];
  if (kind === 'tax') {
    cols.push(
      { field: 'vatAmount', aliases: ['세액', '부가세'], required: true },
      { field: 'itemVatAmount', aliases: ['품목세액'] },
      { field: 'invoiceClass', aliases: ['전자세금계산서분류', '세금계산서분류'] },
      { field: 'invoiceKind', aliases: ['전자세금계산서종류', '세금계산서종류'] },
    );
  } else {
    cols.push(
      // 면세 계산서 목록에 세액 열이 있는지는 미확인(02 U9) — 있으면 읽어서 0 인지 검사한다
      { field: 'vatAmount', aliases: ['세액', '부가세'] },
      { field: 'itemVatAmount', aliases: ['품목세액'] },
      { field: 'invoiceClass', aliases: ['전자계산서분류', '계산서분류'] },
      { field: 'invoiceKind', aliases: ['전자계산서종류', '계산서종류'] },
    );
  }
  return cols;
}

export const HOMETAX_TAX_INVOICE_V1: FormatProfile = {
  id: 'hometax_tax_invoice_v1',
  key: 'hometax_tax_invoice',
  version: 1,
  name: '전자세금계산서 목록 (매입/매출)',
  purpose: 'transactions',
  source: 'tax_invoice',
  evidenceType: 'tax_invoice',
  direction: 'auto',
  columns: invoiceColumns('tax'),
  anchors: [['transactionDate', 'approvalNumber', 'supplyAmount', 'supplierBusinessNumber', 'buyerBusinessNumber']],
  rejectHeaders: ['전자계산서분류', '전자계산서종류', '계산서분류', '계산서종류'],
  headerScanRows: 30,
  amountRule: { components: ['supplyAmount', 'vatAmount'], totalOnly: 'fail' },
  hintPatterns: ['세금계산서'],
  requiresUserMapping: false,
  status: 'observed',
  verified: false,
  note:
    '검증필요: 헤더 6행 위치는 커뮤니티 코드 3건 일치, 33열 순서는 1건 근거 → 행 번호·열 순서를 고정하지 않고 제목+위치 문맥으로 매핑한다. ' +
    '매입/매출은 수임처 사업자번호가 공급받는자/공급자 중 어디인지로 행마다 판정. 한 승인번호가 품목 여러 행일 수 있어(U6) 같은 승인번호 행은 묶는다.',
  docsRef: 'docs/research/02-wemembers.md §2.5-(A), U6',
  knownHeaderFingerprints: [],
  priority: 60,
};

export const HOMETAX_INVOICE_EXEMPT_V1: FormatProfile = {
  id: 'hometax_invoice_exempt_v1',
  key: 'hometax_invoice_exempt',
  version: 1,
  name: '전자계산서 목록 (면세, 매입/매출)',
  purpose: 'transactions',
  source: 'tax_invoice',
  evidenceType: 'invoice_exempt',
  direction: 'auto',
  columns: invoiceColumns('exempt'),
  anchors: [['transactionDate', 'approvalNumber', 'supplyAmount', 'supplierBusinessNumber', 'buyerBusinessNumber']],
  rejectHeaders: ['전자세금계산서분류', '전자세금계산서종류', '세금계산서분류', '세금계산서종류'],
  headerScanRows: 30,
  amountRule: { components: ['supplyAmount', 'vatAmount'], totalOnly: 'exempt', vatAlwaysZero: true },
  hintPatterns: ['(?<!세금)계산서', '면세'],
  requiresUserMapping: false,
  status: 'mock',
  verified: false,
  note:
    '검증필요: 전자계산서 목록이 세금계산서와 같은 레이아웃인지(세액 열 유무) 미확인(02 U9). 세액 열이 없으면 0 으로, 있으면 0 인지 검사하고 합계=공급가액으로 검산한다. ' +
    '세금계산서와의 구분은 분류/종류 열 제목(전자계산서분류 ↔ 전자세금계산서분류)이 파일명·제목 힌트보다 우선한다.',
  docsRef: 'docs/research/02-wemembers.md U9',
  knownHeaderFingerprints: [],
  priority: 55,
};

export const CARD_SALES_V1: FormatProfile = {
  id: 'card_sales_v1',
  key: 'card_sales',
  version: 1,
  name: '신용카드 매출내역 (카드사/여신금융협회 건별)',
  purpose: 'transactions',
  // TransactionSource 에 카드매출 전용 값이 없어 business_card + direction=sales 로 표기한다 (계약 확장 검토 필요)
  source: 'business_card',
  evidenceType: 'card',
  direction: 'sales',
  columns: [
    { field: 'transactionDate', aliases: ['승인일자', '매출일자', '거래일자', '승인일', '거래일', '승인일시', '거래일시', '매출일'], required: true },
    { field: 'cardCompany', aliases: ['카드사', '카드사명', '매입사', '매입카드사', '발급사'], required: true },
    { field: 'approvalNumber', aliases: ['승인번호'], required: true },
    { field: 'totalAmount', aliases: ['승인금액', '매출금액', '결제금액', '합계', '합계금액', '거래금액', '매출액'], required: true },
    { field: 'supplyAmount', aliases: ['공급가액'] },
    { field: 'vatAmount', aliases: ['부가세', '세액'] },
    { field: 'serviceCharge', aliases: ['봉사료'] },
    { field: 'cardNumber', aliases: ['카드번호'] },
    { field: 'transactionKind', aliases: ['거래구분', '승인구분', '승인취소구분', '구분', '상태'] },
    { field: 'installment', aliases: ['할부', '할부개월', '할부기간'] },
  ],
  anchors: [['transactionDate', 'cardCompany', 'approvalNumber', 'totalAmount']],
  headerScanRows: 30,
  amountRule: { components: ['supplyAmount', 'vatAmount', 'serviceCharge'], totalOnly: 'by_tax_type' },
  hintPatterns: ['카드\\s*매출', '매출\\s*내역', '여신'],
  requiresUserMapping: false,
  status: 'mock',
  verified: false,
  note:
    '검증필요: 카드매출 엑셀 열 구성은 공개 자료로 확인되지 않았다(02 §2.5-(D)). 홈택스 "신용카드 매출자료 조회"는 월·카드사별 합계 수준일 수 있어 건별 적재 대신 대사 기준값으로만 써야 할 수 있다. ' +
    '합계만 있으면 수임처 과세유형(면세사업자면 면세)으로 공급가액/세액을 역산하고 rawData.__derived 에 기록한다.',
  docsRef: 'docs/research/02-wemembers.md §2.5-(D)',
  knownHeaderFingerprints: [],
  priority: 40,
};

export const WEHAGO_LEDGER_PURCHASE_SALES_V1: FormatProfile = {
  id: 'wehago_ledger_purchase_sales_v1',
  key: 'wehago_ledger_purchase_sales',
  version: 1,
  name: 'WEHAGO 매입매출장 엑셀 변환 (역수입 대사용)',
  purpose: 'reconciliation',
  source: 'wehago',
  evidenceType: null,
  direction: null,
  columns: [
    { field: 'transactionDate', aliases: ['일자', '전표일자', '작성일자', '거래일자'], required: true },
    { field: 'counterpartyCode', aliases: ['거래처코드', '코드'] },
    { field: 'merchantName', aliases: ['거래처', '거래처명', '상호'], required: true },
    { field: 'merchantBusinessNumber', aliases: ['사업자번호', '사업자등록번호', '등록번호'] },
    { field: 'vatTypeCode', aliases: ['유형', '유형코드', '매입매출유형', '과세유형'], required: true },
    { field: 'description', aliases: ['품명', '품목', '적요'] },
    { field: 'supplyAmount', aliases: ['공급가액'], required: true },
    { field: 'vatAmount', aliases: ['부가세', '세액'], required: true },
    { field: 'totalAmount', aliases: ['합계', '합계금액'], required: true },
    { field: 'debitAccount', aliases: ['차변계정', '차변계정과목', '차변'] },
    { field: 'creditAccount', aliases: ['대변계정', '대변계정과목', '대변'] },
    { field: 'managementNumber', aliases: ['관리', '관리번호'] },
    { field: 'voucherStatus', aliases: ['전표상태', '상태'] },
    { field: 'directionLabel', aliases: ['구분', '매입매출구분', '매출매입구분'] },
    { field: 'approvalNumber', aliases: ['승인번호'] },
  ],
  anchors: [['transactionDate', 'vatTypeCode', 'supplyAmount', 'vatAmount', 'totalAmount']],
  headerScanRows: 30,
  amountRule: { components: ['supplyAmount', 'vatAmount'], totalOnly: 'fail' },
  hintPatterns: ['매입매출장', 'WEHAGO', '위하고'],
  requiresUserMapping: false,
  status: 'observed',
  verified: false,
  note:
    '검증필요: 변환 항목(일자·거래처·유형·품명·공급가액·부가세·합계·차변계정·대변계정·관리·전표상태)은 WEHAGO T 도움말 발췌 [공식]. ' +
    '실제 헤더 원문·사업자번호 포함 여부는 샘플 필요. 유형이 약칭(예: 카과)만 있으면 구분(매입/매출) 열이나 사용자 지정으로 방향을 정한다.',
  docsRef: 'docs/research/01-wehago.md §2.4, docs/integration-architecture.md §6.2',
  knownHeaderFingerprints: [],
  priority: 45,
};

export const GENERIC_V1: FormatProfile = {
  id: 'generic_v1',
  key: 'generic',
  version: 1,
  name: '기타 형식 (열 직접 지정 필요)',
  purpose: 'transactions',
  source: 'manual',
  evidenceType: null,
  direction: null,
  columns: [
    { field: 'transactionDate', aliases: ['일자', '거래일자', '날짜', '거래일', '승인일자', '작성일자', '사용일자', '이용일자', '매입일자', '매출일자', '거래일시'], required: true },
    { field: 'merchantName', aliases: ['거래처', '거래처명', '상호', '가맹점명', '가맹점', '사용처', '업체명'], required: true },
    { field: 'merchantBusinessNumber', aliases: ['사업자번호', '사업자등록번호', '가맹점사업자번호'] },
    { field: 'supplyAmount', aliases: ['공급가액', '공급가'] },
    { field: 'vatAmount', aliases: ['부가세', '세액', '부가가치세'] },
    { field: 'serviceCharge', aliases: ['봉사료'] },
    { field: 'totalAmount', aliases: ['합계', '합계금액', '금액', '총액', '총금액', '거래금액', '결제금액', '이용금액'], required: true },
    { field: 'description', aliases: ['적요', '내용', '품목', '품명', '메모'] },
    { field: 'note', aliases: ['비고'] },
    { field: 'approvalNumber', aliases: ['승인번호'] },
    { field: 'cardNumber', aliases: ['카드번호'] },
  ],
  anchors: [
    ['transactionDate', 'totalAmount'],
    ['transactionDate', 'supplyAmount'],
  ],
  headerScanRows: 30,
  amountRule: { components: ['supplyAmount', 'vatAmount', 'serviceCharge'], totalOnly: 'by_tax_type' },
  hintPatterns: [],
  requiresUserMapping: true,
  status: 'mock',
  verified: false,
  note: '알 수 없는 형식 — 열 매핑·증빙유형·매입/매출을 사용자가 확인해야 적재한다. 자동 제안 매핑은 참고용.',
  docsRef: 'docs/integration-architecture.md §4.2',
  knownHeaderFingerprints: [],
  priority: 0,
};

/** 등록된 프로필 (generic 은 항상 마지막 폴백) */
export const FORMAT_PROFILES: readonly FormatProfile[] = [
  HOMETAX_CARD_PURCHASE_V1,
  HOMETAX_CASH_RECEIPT_PURCHASE_V1,
  HOMETAX_TAX_INVOICE_V1,
  HOMETAX_INVOICE_EXEMPT_V1,
  CARD_SALES_V1,
  WEHAGO_LEDGER_PURCHASE_SALES_V1,
  GENERIC_V1,
];

export function getFormatProfile(id: string): FormatProfile | undefined {
  return FORMAT_PROFILES.find((p) => p.id === id || p.key === id);
}
