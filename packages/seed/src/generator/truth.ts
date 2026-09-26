import type { EvidenceType, VatType, Won } from '@mintax/core';
import type { MerchantKind, MerchantTaxType, SyntheticClient, SyntheticMerchant } from './types';

/**
 * 정답 레이블 규칙 — 계정명 사전, 부가세 정답, 홈택스 공제여부 힌트.
 *
 * 부가세 정답은 사람이 검토를 마친 "확정값"이다 (엔진의 '검토' 결론도 여기서는 공제/불공제로 확정).
 * 판단 순서와 유형 매핑은 core engine/vat.ts(purchaseVatType)·data/vat-rules.ts 의 규칙 코드와 맞춘다.
 */

/** 이 생성기가 쓰는 계정 (코드 → 이름). core DEFAULT_ACCOUNT_CODES 와 일치해야 한다 (테스트로 확인). */
export const ACCOUNT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  '134': '가지급금',
  '146': '상품',
  '153': '원재료',
  '210': '공구와기구',
  '212': '비품',
  '338': '인출금',
  '401': '상품매출',
  '404': '제품매출',
  '811': '복리후생비',
  '812': '여비교통비',
  '813': '접대비(기업업무추진비)',
  '814': '통신비',
  '815': '수도광열비',
  '816': '전력비',
  '817': '세금과공과',
  '819': '지급임차료',
  '820': '수선비',
  '821': '보험료',
  '822': '차량유지비',
  '824': '운반비',
  '826': '도서인쇄비',
  '828': '포장비',
  '829': '사무용품비',
  '830': '소모품비',
  '831': '지급수수료',
  '833': '광고선전비',
  '837': '건물관리비',
  '904': '임대료',
});

export function accountNameOf(code: string): string {
  const name = ACCOUNT_NAMES[code];
  if (!name) throw new Error(`정의되지 않은 계정코드: ${code}`);
  return name;
}

/** 카드 공제 제외 업종 (시행령 제88조⑤ — 여객운송) */
const PASSENGER_KINDS: ReadonlySet<MerchantKind> = new Set(['taxi', 'train', 'airline']);

export interface VatTruthInput {
  direction: 'purchase' | 'sales';
  evidenceType: EvidenceType;
  vatAmount: Won;
  isForeign: boolean;
  merchantTaxType: MerchantTaxType | 'unknown';
  merchantKind: MerchantKind | null;
  sourceDeductibleHint: boolean | null;
  description: string;
  accountCode: string;
}

export interface VatTruth {
  vatType: VatType;
  deductible: boolean;
  nonDeductibleReasonCode: string | null;
}

/** 겸영 수임처에서 면세사업 전용으로 보는 매입 (합성 단순화: 그 외 공통매입은 과세 귀속으로 본다) */
const MIXED_EXEMPT_USE_KINDS: ReadonlySet<MerchantKind> = new Set(['medical_supplies', 'education_materials']);

function salesVatType(e: EvidenceType): VatType {
  switch (e) {
    case 'tax_invoice':
      return 'sales_taxable';
    case 'invoice_exempt':
      return 'sales_exempt';
    case 'card':
      return 'sales_card';
    case 'cash_receipt':
      return 'sales_cash_receipt';
    default:
      return 'sales_other';
  }
}

/** 공제/불공제 확정값 → WEHAGO 부가세 유형 (engine purchaseVatType 과 같은 규칙) */
export function purchaseVatTypeOf(
  t: Pick<VatTruthInput, 'evidenceType' | 'vatAmount' | 'isForeign' | 'merchantTaxType'>,
  deductible: boolean,
): VatType {
  if (t.isForeign) return 'purchase_no_evidence';
  const noVat = t.vatAmount === 0;
  switch (t.evidenceType) {
    case 'tax_invoice':
      return !deductible && !noVat ? 'purchase_non_deductible' : 'purchase_taxable';
    case 'invoice_exempt':
      return 'purchase_exempt';
    case 'card':
      if (noVat) return t.merchantTaxType === 'simplified' ? 'purchase_no_evidence' : 'purchase_card_exempt';
      return deductible ? 'purchase_card' : 'purchase_no_evidence';
    case 'cash_receipt':
      if (noVat) return t.merchantTaxType === 'simplified' ? 'purchase_no_evidence' : 'purchase_cash_receipt_exempt';
      return deductible ? 'purchase_cash_receipt' : 'purchase_no_evidence';
    default:
      return 'purchase_no_evidence';
  }
}

/**
 * 부가세 정답.
 * 순서: 해외 → 계산서 → 세액 0 → 면세사업자 수임처 → 접대비 → 불공제 차량 → 사업무관 → 여객운송 → 간이 가맹점 → 겸영 면세 귀속 → 공제
 */
export function vatTruthFor(t: VatTruthInput, client: Pick<SyntheticClient, 'vatType' | 'nonDeductibleVehicles'>): VatTruth {
  if (t.direction === 'sales') return { vatType: salesVatType(t.evidenceType), deductible: true, nonDeductibleReasonCode: null };
  const no = (reason: string | null): VatTruth => ({
    vatType: purchaseVatTypeOf(t, false),
    deductible: false,
    // 실제 부가세가 있는데 공제하지 않을 때만 사유 코드 (세액 0·해외·면세는 사유 아님)
    nonDeductibleReasonCode: t.vatAmount !== 0 && !t.isForeign ? reason : null,
  });
  if (t.isForeign) return no(null);
  if (t.evidenceType === 'invoice_exempt') return no(null);
  if (t.vatAmount === 0) return no(null);
  if (client.vatType === 'exempt') return no('VAT-EXM-01');
  if (t.accountCode === '813') return no('VAT-ENT-01');
  if (client.nonDeductibleVehicles.some((plate) => t.description.includes(plate))) return no('VAT-CAR-01');
  if (t.accountCode === '134' || t.accountCode === '338') return no('VAT-BIZ-01');
  if ((t.evidenceType === 'card' || t.evidenceType === 'cash_receipt') && t.merchantKind && PASSENGER_KINDS.has(t.merchantKind)) {
    return no('VAT-CARD-03');
  }
  if (t.evidenceType === 'card' && t.merchantTaxType === 'simplified' && t.sourceDeductibleHint === false) return no('VAT-CARD-09');
  if (client.vatType === 'mixed' && t.merchantKind && MIXED_EXEMPT_USE_KINDS.has(t.merchantKind)) return no('VAT-EXM-01');
  return { vatType: purchaseVatTypeOf(t, true), deductible: true, nonDeductibleReasonCode: null };
}

/**
 * 홈택스 카드·현금영수증 '공제여부결정' 합성값. 홈택스는 가맹점 기준으로만 판정한다고 가정한다(용도는 모름).
 * 면세·간이(세액 없음)·여객운송 → 불공제, 해외 → 자료 없음(null), 그 외 → 공제.
 */
export function hometaxDeductibleHint(merchant: Pick<SyntheticMerchant, 'kind' | 'taxType' | 'foreign'> | null, vatAmount: Won): boolean | null {
  if (!merchant) return true;
  if (merchant.foreign) return null;
  if (merchant.taxType === 'exempt' || vatAmount === 0) return false;
  if (PASSENGER_KINDS.has(merchant.kind)) return false;
  // 세액이 표시된 간이과세자 — 홈택스 판정 미상으로 둔다 (VAT-CARD-09 검토 대상)
  if (merchant.taxType === 'simplified') return null;
  return true;
}
