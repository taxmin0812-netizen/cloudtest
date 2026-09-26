/**
 * WEHAGO 전송센터 — 수임처 파이프라인 단계 판정 (순수 함수).
 * 저장된 플래그가 아니라 데이터(거래 상태·전송파일·대사 결과)로 매번 계산한다 (docs/03 §2 표).
 */
import type { ClientPipelineStage } from '@mintax/core';
import { EXPORT_KIND_LABELS, exportHref, importsHref, inboxHref, reconciliationHref, transferHref } from '../export/helpers';
import type { WehagoExportKind } from '../export/types';

export type TransferStage = ClientPipelineStage | 'no_data';

export const TRANSFER_STAGES: readonly TransferStage[] = ['no_data', 'collected', 'auto_classified', 'needs_review', 'reviewed', 'export_ready', 'exported', 'reconciled'];

export const STAGE_LABELS_KO: Record<TransferStage, string> = {
  no_data: '자료 없음',
  collected: '수집완료',
  auto_classified: '자동분개완료',
  needs_review: '예외검토필요',
  reviewed: '검토완료',
  export_ready: '전송준비',
  exported: '전송',
  reconciled: '대사완료',
};

export interface ExportFact {
  id: string;
  kind: string;
  status: string;
  createdAt: Date;
  version: number | null;
  templateVerified: boolean | null;
  rowCount: number;
  totalAmount: number;
  blockedReason: string | null;
  hasFile: boolean;
  superseded: boolean;
  downloadedAt: Date | null;
  uploadConfirmedAt: Date | null;
}

export interface ReconFact {
  id: string;
  phase: 'pre_export' | 'post_export';
  exportAllowed: boolean;
  createdAt: Date;
  /** 검토 대기를 뺀 차단 차이 수 */
  mismatch: number;
  exportJobId: string | null;
}

export interface StageFacts {
  clientId: string;
  period: string;
  txCount: number;
  imports: number;
  unclassified: number;
  pending: number;
  approved: number;
  humanReviewed: number;
  /** 유효한 전송파일에 들지 않은 승인 거래 (전송 범위 제외 원천 제외) */
  stale: number;
  failedRows: number;
  /** 종류별 최신 시도 (차단 포함) */
  latestAttempts: ExportFact[];
  /** 종류별 최신 유효 파일 (ready/downloaded/uploaded_confirmed, 대체 안 됨) */
  validExports: ExportFact[];
  latestRecon: ReconFact | null;
  latestPostRecon: ReconFact | null;
}

export interface TransferBlocker {
  code: string;
  message: string;
  href: string | null;
}

export interface NextAction {
  code: 'import' | 'classify' | 'review' | 'prepare' | 'download' | 'confirm_upload' | 'reimport' | 'view_recon' | 'none';
  label: string;
  href: string | null;
}

export type ReconStatus = 'none' | 'balanced' | 'mismatch' | 'reconciled';

export interface StageResult {
  stage: TransferStage;
  blockers: TransferBlocker[];
  nextAction: NextAction;
  reconStatus: ReconStatus;
  /** 일괄 "전송 준비" 대상인가 */
  eligibleForPrepare: boolean;
}

export function computeTransferStage(f: StageFacts): StageResult {
  const blockers: TransferBlocker[] = [];
  const { clientId: c, period: p } = f;
  if (f.failedRows > 0) blockers.push({ code: 'parse_failed', message: `수집 실패 행 ${f.failedRows}건`, href: importsHref(c, p, 'failed') });
  if (f.unclassified > 0) blockers.push({ code: 'unclassified', message: `자동분류 대기 ${f.unclassified}건`, href: inboxHref(c, p) });
  if (f.pending > 0) blockers.push({ code: 'pending_review', message: `검토 대기 ${f.pending}건`, href: inboxHref(c, p) });

  const validIds = new Set(f.validExports.map((e) => e.id));
  for (const a of f.latestAttempts) {
    if (a.status === 'blocked' && !validIds.has(a.id) && !a.superseded) {
      blockers.push({ code: 'export_blocked', message: `${EXPORT_KIND_LABELS[a.kind as WehagoExportKind] ?? a.kind} 전송 차단: ${a.blockedReason ?? '사전검증 실패'}`, href: transferHref(c, p) });
    }
  }
  if (f.stale > 0 && f.validExports.length > 0) {
    blockers.push({ code: 'export_stale', message: `전송파일에 없는 승인 거래 ${f.stale}건 — 파일을 다시 만드세요`, href: transferHref(c, p) });
  }

  let reconStatus: ReconStatus = 'none';
  const lr = f.latestRecon;
  if (lr) {
    if (lr.phase === 'post_export' && lr.exportAllowed) reconStatus = 'reconciled';
    else if (lr.mismatch > 0) reconStatus = 'mismatch';
    else reconStatus = 'balanced';
  }
  if (reconStatus === 'mismatch' && lr) blockers.push({ code: 'recon_mismatch', message: `대사 불일치 ${lr.mismatch}건`, href: reconciliationHref(lr.id) });

  const hasData = f.txCount > 0 || f.imports > 0;
  let stage: TransferStage;
  if (!hasData) stage = 'no_data';
  else if (f.unclassified > 0) stage = 'collected';
  else if (f.pending > 0) stage = 'needs_review';
  else if (f.validExports.length === 0 || f.stale > 0) stage = f.humanReviewed > 0 ? 'reviewed' : 'auto_classified';
  else if (f.validExports.some((e) => e.status === 'ready')) stage = 'export_ready';
  else {
    const newest = Math.max(...f.validExports.map((e) => e.createdAt.getTime()));
    const post = f.latestPostRecon;
    stage = post && post.exportAllowed && post.createdAt.getTime() >= newest ? 'reconciled' : 'exported';
  }

  // 미검증 서식으로 올린 기간은 역수입 대사 전까지 "WEHAGO 반영 미확인"
  if (stage === 'exported' && f.validExports.some((e) => e.templateVerified === false)) {
    blockers.push({ code: 'wehago_unverified', message: 'WEHAGO 반영 미확인 — 매입매출장을 올려 대사하세요 (검증필요 서식)', href: transferHref(c, p) });
  }

  const eligibleForPrepare = (stage === 'auto_classified' || stage === 'reviewed') && f.approved > 0 && f.failedRows === 0;
  let nextAction: NextAction;
  switch (stage) {
    case 'no_data':
      nextAction = { code: 'import', label: '자료 수집', href: importsHref(c, p) };
      break;
    case 'collected':
      nextAction = { code: 'classify', label: '자동분류 실행', href: inboxHref(c, p) };
      break;
    case 'needs_review':
      nextAction = { code: 'review', label: `${f.pending}건 검토하기`, href: inboxHref(c, p) };
      break;
    case 'auto_classified':
    case 'reviewed':
      nextAction = f.failedRows > 0 ? { code: 'import', label: '실패 행 확인', href: importsHref(c, p, 'failed') } : { code: 'prepare', label: '전송 준비', href: transferHref(c, p) };
      break;
    case 'export_ready': {
      const r = f.validExports.find((e) => e.status === 'ready')!;
      nextAction = { code: 'download', label: '업로드 파일 받기', href: exportHref(r.id) };
      break;
    }
    case 'exported': {
      const d = f.validExports.find((e) => e.status === 'downloaded');
      nextAction = d ? { code: 'confirm_upload', label: '업로드 완료 확인', href: exportHref(d.id) } : reconStatus === 'mismatch' && lr ? { code: 'view_recon', label: '차이 보기', href: reconciliationHref(lr.id) } : { code: 'reimport', label: 'WEHAGO 결과 대사', href: transferHref(c, p) };
      break;
    }
    default:
      nextAction = { code: 'none', label: '—', href: null };
  }
  return { stage, blockers, nextAction, reconStatus, eligibleForPrepare };
}
