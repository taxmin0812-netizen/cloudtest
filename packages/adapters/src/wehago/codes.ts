/**
 * 더존(WEHAGO / Smart A) 매입매출 유형코드·분개유형·일반전표 구분 코드표 (데이터).
 *
 * 근거: docs/research/01-wehago.md §2.5, §2.6 — WEHAGO 고객센터 검색 발췌 [공식, 스니펫] + 제3자 코드표 교차.
 * 팩트체크에서 원문 재검증은 하지 못했다 → verified=false. 11~24 / 51~62 가 전체 목록인지도 미확인(25·63·64 관찰).
 * 템플릿이 이 표를 기본값으로 복사해 쓰며, 사무소가 실제 WEHAGO 화면 목록으로 덮어쓸 수 있다.
 */
import type { Direction, EvidenceType } from '@mintax/core';

export type VatTaxNature = 'taxable' | 'zero_rated' | 'exempt' | 'non_deductible' | 'none';

export interface DouzoneVatTypeEntry {
  code: string;
  /** WEHAGO 화면 약칭 */
  label: string;
  direction: Direction;
  evidenceType: EvidenceType;
  /** 세액 규칙: exempt/zero_rated 는 세액 0 이어야 한다 */
  nature: VatTaxNature;
  /** ◎(질의어 무관 발췌·전체목록 확인) = true, ○(부분 확인) = false */
  confirmedInSnippet: boolean;
  description: string;
}

export const DOUZONE_VAT_TYPE_TABLE: readonly DouzoneVatTypeEntry[] = [
  { code: '11', label: '과세', direction: 'sales', evidenceType: 'tax_invoice', nature: 'taxable', confirmedInSnippet: true, description: '세금계산서 발행 과세 매출' },
  { code: '12', label: '영세', direction: 'sales', evidenceType: 'tax_invoice', nature: 'zero_rated', confirmedInSnippet: true, description: '영세율 세금계산서 매출' },
  { code: '13', label: '면세', direction: 'sales', evidenceType: 'invoice_exempt', nature: 'exempt', confirmedInSnippet: true, description: '계산서 발행 면세 매출' },
  { code: '14', label: '건별', direction: 'sales', evidenceType: 'other', nature: 'taxable', confirmedInSnippet: true, description: '증빙 없는 과세 매출' },
  { code: '15', label: '간이', direction: 'sales', evidenceType: 'other', nature: 'taxable', confirmedInSnippet: false, description: '간이과세 관련 매출' },
  { code: '16', label: '수출', direction: 'sales', evidenceType: 'other', nature: 'zero_rated', confirmedInSnippet: false, description: '직수출 등 영세 매출' },
  { code: '17', label: '카과', direction: 'sales', evidenceType: 'card', nature: 'taxable', confirmedInSnippet: true, description: '신용카드 과세 매출' },
  { code: '18', label: '카면', direction: 'sales', evidenceType: 'card', nature: 'exempt', confirmedInSnippet: false, description: '신용카드 면세 매출' },
  { code: '19', label: '카영', direction: 'sales', evidenceType: 'card', nature: 'zero_rated', confirmedInSnippet: false, description: '신용카드 영세 매출' },
  { code: '20', label: '면건', direction: 'sales', evidenceType: 'other', nature: 'exempt', confirmedInSnippet: false, description: '증빙 없는 면세 매출' },
  { code: '21', label: '전자', direction: 'sales', evidenceType: 'other', nature: 'taxable', confirmedInSnippet: false, description: '전자적 결제수단 매출' },
  { code: '22', label: '현과', direction: 'sales', evidenceType: 'cash_receipt', nature: 'taxable', confirmedInSnippet: true, description: '현금영수증 과세 매출' },
  { code: '23', label: '현면', direction: 'sales', evidenceType: 'cash_receipt', nature: 'exempt', confirmedInSnippet: true, description: '현금영수증 면세 매출' },
  { code: '24', label: '현영', direction: 'sales', evidenceType: 'cash_receipt', nature: 'zero_rated', confirmedInSnippet: true, description: '현금영수증 영세 매출' },
  { code: '51', label: '과세', direction: 'purchase', evidenceType: 'tax_invoice', nature: 'taxable', confirmedInSnippet: true, description: '세금계산서 수취 과세 매입(공제)' },
  { code: '52', label: '영세', direction: 'purchase', evidenceType: 'tax_invoice', nature: 'zero_rated', confirmedInSnippet: true, description: '영세율 세금계산서 수취' },
  { code: '53', label: '면세', direction: 'purchase', evidenceType: 'invoice_exempt', nature: 'exempt', confirmedInSnippet: true, description: '계산서 수취 면세 매입' },
  { code: '54', label: '불공', direction: 'purchase', evidenceType: 'tax_invoice', nature: 'non_deductible', confirmedInSnippet: true, description: '매입세액 불공제 (불공제사유 선택 필요)' },
  { code: '55', label: '수입', direction: 'purchase', evidenceType: 'tax_invoice', nature: 'taxable', confirmedInSnippet: true, description: '세관장 발행 수입세금계산서' },
  { code: '56', label: '금전', direction: 'purchase', evidenceType: 'other', nature: 'taxable', confirmedInSnippet: false, description: '금전등록기 영수증 [커뮤니티]' },
  { code: '57', label: '카과', direction: 'purchase', evidenceType: 'card', nature: 'taxable', confirmedInSnippet: true, description: '신용카드 과세 매입(공제)' },
  { code: '58', label: '카면', direction: 'purchase', evidenceType: 'card', nature: 'exempt', confirmedInSnippet: true, description: '신용카드 면세 매입' },
  { code: '59', label: '카영', direction: 'purchase', evidenceType: 'card', nature: 'zero_rated', confirmedInSnippet: true, description: '신용카드 영세 매입' },
  { code: '60', label: '면건', direction: 'purchase', evidenceType: 'other', nature: 'exempt', confirmedInSnippet: true, description: '증빙 없는 면세 매입' },
  { code: '61', label: '현과', direction: 'purchase', evidenceType: 'cash_receipt', nature: 'taxable', confirmedInSnippet: true, description: '현금영수증 과세 매입(공제)' },
  { code: '62', label: '현면', direction: 'purchase', evidenceType: 'cash_receipt', nature: 'exempt', confirmedInSnippet: true, description: '현금영수증 면세 매입' },
];

export function findVatTypeByCode(code: string, table: readonly DouzoneVatTypeEntry[] = DOUZONE_VAT_TYPE_TABLE): DouzoneVatTypeEntry | undefined {
  return table.find((e) => e.code === code);
}

/**
 * 매입매출장의 '유형' 셀 해석: "57", "57.카과", "카과", "57 카과" 모두 허용.
 * 약칭만 있으면 매입/매출이 겹치므로(예: 카과 17/57) direction 이 필요하다.
 */
export function parseVatTypeCell(
  value: string,
  direction: Direction | null,
  table: readonly DouzoneVatTypeEntry[] = DOUZONE_VAT_TYPE_TABLE,
): { entry: DouzoneVatTypeEntry | null; ambiguous: boolean } {
  const s = value.normalize('NFKC').replace(/\s+/g, '');
  const m = /^(\d{2})(?:[.\-:)]?(.*))?$/.exec(s);
  if (m) {
    const e = findVatTypeByCode(m[1]!, table);
    return { entry: e ?? null, ambiguous: false };
  }
  const matches = table.filter((e) => e.label === s);
  if (matches.length === 0) return { entry: null, ambiguous: false };
  if (matches.length === 1) return { entry: matches[0]!, ambiguous: false };
  if (!direction) return { entry: null, ambiguous: true };
  return { entry: matches.find((e) => e.direction === direction) ?? null, ambiguous: false };
}

/** 매입매출전표 분개유형 (01 §2.6 [공식 발췌], 재검증 안 됨) */
export const DOUZONE_JOURNAL_TYPE_CODES = {
  none: '0', // 분개없음
  cash: '1', // 현금
  credit: '2', // 외상
  mixed: '3', // 혼합
  card: '4', // 카드
} as const;
export type JournalTypeKey = keyof typeof DOUZONE_JOURNAL_TYPE_CODES;

/** 일반전표 구분 (01 §2.3 [공식 발췌], 재검증 안 됨) */
export const DOUZONE_SLIP_SIDE_CODES = {
  withdrawal: '1', // 출금
  deposit: '2', // 입금
  debit: '3', // 차변
  credit: '4', // 대변
  closingDebit: '5', // 결차
  closingCredit: '6', // 결대
} as const;
