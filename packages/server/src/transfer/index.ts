/**
 * WEHAGO 전송센터 — 수임처별 파이프라인(수집 → 자동분개 → 예외검토 → 검토완료 → 전송준비 → 전송 → 대사완료).
 * 전송파일 작업(export_wehago) 처리기는 export 영역(registerExportJobHandlers)에 있다.
 */
export { getTransferBoard, prepareTransferBatch, computeTransferRows, type TransferBoardDTO, type TransferRowDTO, type TransferExportDTO, type TransferBatchRequestResult } from './board';
export {
  computeTransferStage,
  STAGE_LABELS_KO,
  TRANSFER_STAGES,
  type TransferStage,
  type StageFacts,
  type StageResult,
  type TransferBlocker,
  type NextAction,
  type ReconStatus,
  type ExportFact,
  type ReconFact,
} from './stage';
