import type { NormalizedTransaction } from '../types';
import { computeFingerprint } from '../fingerprint';
import { formatWon } from '../money';

export interface DuplicateHit {
  tx: NormalizedTransaction;
  /** incoming 배열 안의 위치 (0-base) */
  index: number;
  /** 'existing:<id>' 또는 'batch:<index>' */
  duplicateOf: string;
  /** 사용자에게 보여줄 한국어 사유 */
  reason: string;
}

export interface DedupeResult {
  unique: NormalizedTransaction[];
  duplicates: DuplicateHit[];
}

/** fingerprint 가 무엇을 기준으로 만들어졌는지 (fingerprint.ts 의 우선순위와 동일) */
export function describeDuplicateBasis(tx: NormalizedTransaction): string {
  if (tx.evidenceType === 'tax_invoice' || tx.evidenceType === 'invoice_exempt') {
    return tx.approvalNumber ? `국세청 승인번호 ${tx.approvalNumber} 동일` : '작성일자·상대방·공급가액·세액 동일';
  }
  if (tx.approvalNumber) return `승인번호 ${tx.approvalNumber}·일자·금액${tx.cardNumberMasked ? '·카드번호' : ''} 동일`;
  if (tx.originalSourceId) return `원천 시스템 ID ${tx.originalSourceId} 동일`;
  return `일자·상대방·금액·증빙유형${tx.cardNumberMasked ? '·카드번호' : ''} 동일`;
}

function label(tx: NormalizedTransaction): string {
  return `${tx.transactionDate} ${tx.merchantName || '(상호 없음)'} ${formatWon(tx.totalAmount)}`;
}

function fingerprintOf(tx: NormalizedTransaction): string {
  return tx.fingerprint || computeFingerprint(tx);
}

/**
 * 중복 판정. 어떤 행도 버리지 않는다 — 모든 입력은 unique 또는 duplicates 중 정확히 한 곳에 들어간다.
 * - 이미 등록된 거래(existing)와 fingerprint 가 같으면 'existing:<id>'
 * - 같은 파일(incoming) 안에서 앞 행과 같으면 'batch:<앞 행 index>'
 * - fingerprint 는 채널·파일명·행번호를 포함하지 않으므로 경로가 달라도 같은 거래는 같은 값이다.
 */
export function detectDuplicates(
  incoming: readonly NormalizedTransaction[],
  existing: ReadonlyArray<{ id: string; fingerprint: string }>,
): DedupeResult {
  const known = new Map<string, string>();
  for (const e of existing) if (e.fingerprint && !known.has(e.fingerprint)) known.set(e.fingerprint, e.id);

  const seen = new Map<string, number>();
  const unique: NormalizedTransaction[] = [];
  const duplicates: DuplicateHit[] = [];

  incoming.forEach((tx, index) => {
    const fp = fingerprintOf(tx);
    const existingId = known.get(fp);
    if (existingId !== undefined) {
      duplicates.push({
        tx,
        index,
        duplicateOf: `existing:${existingId}`,
        reason: `${label(tx)} 거래는 이미 등록된 거래와 같아 중복으로 판정했습니다 (${describeDuplicateBasis(tx)}).`,
      });
      return;
    }
    const first = seen.get(fp);
    if (first !== undefined) {
      const firstTx = incoming[first]!;
      const where = firstTx.sourceRowNumber !== null ? `${firstTx.sourceRowNumber}행과` : `${first + 1}번째 거래와`;
      duplicates.push({
        tx,
        index,
        duplicateOf: `batch:${first}`,
        reason: `${label(tx)} 거래는 같은 자료의 ${where} 같아 중복으로 판정했습니다 (${describeDuplicateBasis(tx)}).`,
      });
      return;
    }
    seen.set(fp, index);
    unique.push(tx);
  });

  return { unique, duplicates };
}
