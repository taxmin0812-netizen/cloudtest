/**
 * 대사 — 순수 도우미 (보고서 → 화면 DTO, 단계 요약 문장, 차이 링크).
 */
import { formatWon, type AmountTotals, type ReconDiscrepancy, type ReconStage } from '@mintax/core';
import type { ReconcileResult } from '@mintax/core/engine/vat-risk-index';
import { EVIDENCE_LABELS, importsHref, inboxHref, transferHref } from '../export/helpers';
import type { ReconciliationDiscrepancyDTO, ReconciliationStageDTO } from './types';

export const STAGE_LABELS: Record<ReconStage, string> = {
  source: '위멤버스(원본)',
  processed: 'MIN TAX OPS',
  export: '전송파일',
  wehago: 'WEHAGO',
};

export const STAGE_ORDER: readonly ReconStage[] = ['source', 'processed', 'export', 'wehago'];

export const DISCREPANCY_LABELS: Record<ReconDiscrepancy['kind'], string> = {
  duplicate_excluded: '중복 제외',
  user_excluded: '사용자 제외',
  parse_failed: '수집 실패',
  pending_review: '검토 대기',
  missing_in_export: '전송 누락',
  extra_in_export: '전송 초과',
  amount_mismatch: '금액 불일치',
  missing_in_wehago: 'WEHAGO 누락',
  extra_in_wehago: 'WEHAGO에만 있음',
  unexplained: '설명 안 됨',
};

function totals(t: AmountTotals | undefined): { count: number; supplyAmount: number; vatAmount: number; totalAmount: number } {
  return { count: t?.count ?? 0, supplyAmount: t?.supplyAmount ?? 0, vatAmount: t?.vatAmount ?? 0, totalAmount: t?.totalAmount ?? 0 };
}

/**
 * "위멤버스(원본) 512건 / MIN TAX OPS 500건 / 전송파일 500건 / WEHAGO 498건"
 * mode=ready(전송 전)이면 전송파일 대신 "전송준비" 로 표기한다.
 */
export function stageLine(stages: Partial<Record<ReconStage, AmountTotals>>, mode: 'ready' | 'file' | 'verify'): string {
  const parts: string[] = [];
  for (const s of STAGE_ORDER) {
    const t = stages[s];
    if (!t) continue;
    const label = s === 'export' && mode !== 'file' ? '전송준비' : STAGE_LABELS[s];
    parts.push(`${label} ${t.count.toLocaleString('ko-KR')}건`);
  }
  return parts.join(' / ');
}

export function stageDTOs(stages: Partial<Record<ReconStage, AmountTotals>>, mode: 'ready' | 'file' | 'verify'): ReconciliationStageDTO[] {
  return STAGE_ORDER.filter((s) => stages[s]).map((s) => ({
    stage: s,
    label: s === 'export' && mode !== 'file' ? '전송준비' : STAGE_LABELS[s],
    ...totals(stages[s]),
  }));
}

export function breakdownDTOs(
  map: Record<string, Partial<Record<ReconStage, AmountTotals>>>,
  labelOf: (k: string) => string,
): Array<{ key: string; label: string; stages: Partial<Record<ReconStage, ReturnType<typeof totals>>> }> {
  return Object.keys(map)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => {
      const stages: Partial<Record<ReconStage, ReturnType<typeof totals>>> = {};
      for (const s of STAGE_ORDER) if (map[k]![s]) stages[s] = totals(map[k]![s]);
      return { key: k, label: labelOf(k), stages };
    });
}

export function evidenceLabel(k: string): string {
  return EVIDENCE_LABELS[k] ?? k;
}

/** 차이 → 클릭하면 이동할 곳 */
export function discrepancyHref(d: ReconDiscrepancy, clientId: string, period: string): string | null {
  switch (d.kind) {
    case 'pending_review':
      return inboxHref(clientId, period);
    case 'parse_failed':
      return importsHref(clientId, period, 'failed');
    case 'duplicate_excluded':
      return d.transactionId ? `/transactions/${d.transactionId}` : inboxHref(clientId, period, 'duplicate');
    case 'user_excluded':
      return d.transactionId ? `/transactions/${d.transactionId}` : null;
    case 'missing_in_export':
    case 'extra_in_export':
      return transferHref(clientId, period);
    case 'missing_in_wehago':
    case 'extra_in_wehago':
      return transferHref(clientId, period);
    default:
      return d.transactionId ? `/transactions/${d.transactionId}` : null;
  }
}

export function discrepancyDTOs(list: readonly ReconDiscrepancy[], clientId: string, period: string): ReconciliationDiscrepancyDTO[] {
  return list.map((d) => ({
    kind: d.kind,
    kindLabel: DISCREPANCY_LABELS[d.kind] ?? d.kind,
    message: d.message,
    blocking: d.blocking,
    transactionId: d.transactionId ?? null,
    sourceRowNumber: d.sourceRowNumber ?? null,
    date: d.date ?? null,
    merchantName: d.merchantName ?? null,
    amount: d.amount ?? null,
    href: discrepancyHref(d, clientId, period),
  }));
}

/** 전송·대사 차단 사유 중 "WEHAGO/파일 불일치" 성격만 (검토 대기 제외) */
export function mismatchDiscrepancies(list: readonly ReconDiscrepancy[]): ReconDiscrepancy[] {
  return list.filter((d) => d.blocking && d.kind !== 'pending_review');
}

/** 알림 본문: 차단 사유 앞 3건 */
export function mismatchBody(list: readonly ReconDiscrepancy[]): string {
  const m = mismatchDiscrepancies(list);
  const head = m.slice(0, 3).map((d) => `• ${d.message}`).join('\n');
  return m.length > 3 ? `${head}\n외 ${m.length - 3}건` : head;
}

/** WEHAGO 반영 확인 기준: 원본 등식 균형 + (검토대기 외) 차단 차이 0 + 전송 합계 = 승인 합계 */
export function wehagoMatched(r: Pick<ReconcileResult, 'balanced' | 'discrepancies' | 'expected' | 'stages'>, extra: readonly ReconDiscrepancy[], fileMode: boolean): boolean {
  if (!r.balanced) return false;
  if (mismatchDiscrepancies([...r.discrepancies, ...extra]).length > 0) return false;
  if (r.expected.count === 0) return false;
  if (fileMode) {
    const e = r.stages.export;
    if (!e || e.count !== r.expected.count || e.supplyAmount !== r.expected.supplyAmount || e.vatAmount !== r.expected.vatAmount || e.totalAmount !== r.expected.totalAmount) return false;
  }
  return true;
}

export function amountText(t: AmountTotals | undefined): string {
  return t ? `${t.count}건 ${formatWon(t.totalAmount)}` : '-';
}

