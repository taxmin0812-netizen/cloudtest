/**
 * 대사 엔진 (Reconciliation) — 원본(위멤버스 등) ↔ MIN TAX OPS ↔ 전송파일 ↔ WEHAGO, 1원 단위.
 * 등식과 차이 분류는 core reconcile() 이 기준이고, 여기서는 입력 범위(수임처×기간)를 정확히 모으고 이력으로 저장한다.
 */
import { registerJobHandler } from '../jobs/registry';
import { runReconcileJob } from './job';

export {
  runReconciliation,
  getReconciliation,
  listReconciliations,
  executeReconciliation,
  applyPostExportOutcome,
  latestTakenExport,
  toReconciliationDTO,
  type RunReconciliationInput,
  type ExecuteReconOptions,
  type ExecutedRecon,
  type ReconReportMeta,
  type PostExportOutcome,
} from './run';
export { loadReconInput, type ReconLoadOptions, type LoadedReconInput } from './load';
export { parseWehagoLedger, type ParsedLedger, type ParsedLedgerRow } from './ledger';
export { stageLine, discrepancyDTOs, mismatchDiscrepancies, wehagoMatched, STAGE_LABELS, DISCREPANCY_LABELS } from './helpers';
export { runReconcileJob } from './job';
export type * from './types';

/** 작업 처리기 등록: reconcile */
export function registerReconciliationJobHandlers(): void {
  registerJobHandler('reconcile', runReconcileJob);
}
