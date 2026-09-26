import { sha256Hex } from './hash';
import type { NormalizedTransaction } from './types';

/**
 * 중복 판정용 fingerprint.
 *
 * 1순위: 원천 시스템 고유 ID / 승인번호 (세금계산서 승인번호는 전국 유일, 카드 승인번호는 카드+일자+금액과 결합)
 * 2순위: 일자 + 상대방(사업자번호 또는 상호키) + 금액 + 증빙유형 + 카드번호
 *
 * 같은 거래가 위멤버스 파일과 Desktop Bridge 로 두 번 들어와도 같은 값이 나와야 한다.
 * 채널(channel)·파일명·행번호는 절대 포함하지 않는다.
 */
export type FingerprintInput = Pick<
  NormalizedTransaction,
  | 'clientId'
  | 'direction'
  | 'evidenceType'
  | 'transactionDate'
  | 'merchantBusinessNumber'
  | 'merchantKey'
  | 'totalAmount'
  | 'supplyAmount'
  | 'vatAmount'
  | 'cardNumberMasked'
  | 'approvalNumber'
  | 'originalSourceId'
>;

export function computeFingerprint(t: FingerprintInput): string {
  const party = t.merchantBusinessNumber || t.merchantKey;
  let basis: string;
  if (t.evidenceType === 'tax_invoice' || t.evidenceType === 'invoice_exempt') {
    // 전자(세금)계산서 승인번호는 국세청 발급 고유번호
    basis = t.approvalNumber
      ? ['inv', t.clientId, t.direction, t.approvalNumber].join('|')
      : ['inv', t.clientId, t.direction, t.transactionDate, party, t.supplyAmount, t.vatAmount].join('|');
  } else if (t.approvalNumber) {
    basis = ['apv', t.clientId, t.direction, t.evidenceType, t.transactionDate, t.approvalNumber, t.totalAmount, t.cardNumberMasked ?? ''].join('|');
  } else if (t.originalSourceId) {
    basis = ['src', t.clientId, t.direction, t.evidenceType, t.originalSourceId].join('|');
  } else {
    basis = ['row', t.clientId, t.direction, t.evidenceType, t.transactionDate, party, t.totalAmount, t.cardNumberMasked ?? ''].join('|');
  }
  return sha256Hex(basis);
}

/**
 * "중복 의심" 키 — 승인번호가 달라도 같은 날 같은 상대방 같은 금액이면 의심 (Risk rule 용, 자동 중복처리 아님)
 */
export function possibleDuplicateKey(t: Pick<FingerprintInput, 'clientId' | 'transactionDate' | 'merchantBusinessNumber' | 'merchantKey' | 'totalAmount'>): string {
  return [t.clientId, t.transactionDate, t.merchantBusinessNumber || t.merchantKey, t.totalAmount].join('|');
}
