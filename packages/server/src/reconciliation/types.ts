/**
 * 대사 (Reconciliation) — 화면/API DTO.
 */
import type { ReconDiscrepancy, ReconStage } from '@mintax/core';

export type ReconPhase = 'pre_export' | 'post_export';
/** ready = 전송 전(승인 거래 = 전송준비), file = 전송파일 행 기준, verify = 전송파일 없이 원본 ↔ WEHAGO 검증 */
export type ReconMode = 'ready' | 'file' | 'verify';

export interface ReconciliationStageDTO {
  stage: ReconStage;
  label: string;
  count: number;
  supplyAmount: number;
  vatAmount: number;
  totalAmount: number;
}

export interface ReconciliationDiscrepancyDTO {
  kind: ReconDiscrepancy['kind'];
  kindLabel: string;
  message: string;
  blocking: boolean;
  transactionId: string | null;
  sourceRowNumber: number | null;
  date: string | null;
  merchantName: string | null;
  amount: number | null;
  href: string | null;
}

export interface ReconTotalsDTO {
  count: number;
  supplyAmount: number;
  vatAmount: number;
  totalAmount: number;
}

export interface ReconciliationDTO {
  id: string;
  clientId: string;
  clientName: string;
  period: string;
  phase: ReconPhase;
  mode: ReconMode;
  /** 전송 종류 범위 (null = 기간 전체) */
  scopeKind: string | null;
  exportJobId: string | null;
  balanced: boolean;
  exportAllowed: boolean;
  /** WEHAGO 반영 일치 (post_export) */
  wehagoMatched: boolean | null;
  summary: string;
  /** "위멤버스(원본) 512건 / MIN TAX OPS 500건 / 전송파일 500건 / WEHAGO 498건" */
  stageLine: string;
  stages: ReconciliationStageDTO[];
  equation: {
    basis: 'file' | 'ready';
    source: ReconTotalsDTO;
    terms: Record<'export' | 'duplicate' | 'excluded' | 'failed' | 'pending', ReconTotalsDTO>;
    residual: ReconTotalsDTO;
  };
  expected: ReconTotalsDTO;
  pendingReview: ReconTotalsDTO;
  byEvidenceType: Array<{ key: string; label: string; stages: Partial<Record<ReconStage, ReconTotalsDTO>> }>;
  byAccount: Array<{ key: string; label: string; stages: Partial<Record<ReconStage, ReconTotalsDTO>> }>;
  discrepancies: ReconciliationDiscrepancyDTO[];
  blockingCount: number;
  explainedCount: number;
  excludedEvidenceTypes: string[];
  wehago: {
    fileId: string | null;
    fileName: string | null;
    rows: number;
    failures: number;
    outOfPeriod: number;
    excludedByScope: number;
  } | null;
  createdAt: string;
  createdBy: string | null;
}

export interface ReconciliationListItemDTO {
  id: string;
  clientId: string;
  clientName: string;
  period: string;
  phase: ReconPhase;
  mode: ReconMode;
  exportJobId: string | null;
  balanced: boolean;
  exportAllowed: boolean;
  blockingCount: number;
  summary: string;
  stageLine: string;
  createdAt: string;
}
