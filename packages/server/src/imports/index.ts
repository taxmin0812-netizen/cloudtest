/**
 * 자료 수집 (Data Import / Integration Layer — 서버).
 * Adapter B(위멤버스 파일)·C(다운로드 폴더)·D(클라우드 폴더, Bridge 경유)·E(Desktop Bridge) 공통 입구.
 */
import { registerJobHandler } from '../jobs/registry';
import { runImportFileJob } from './process';

export { uploadImportFile, confirmImport, createImport, type ImportFilePayload, type CreateImportOptions } from './upload';
export { runImportFileJob, type ImportFileJobResult } from './process';
export { getImportJob, listImportJobs, getImportFailures, downloadImportErrorReport, getImportDetection, type ImportDetectionPreviewDTO } from './queries';
export {
  createBridgeToken,
  listBridgeTokens,
  revokeBridgeToken,
  verifyBridgeToken,
  bridgeUpload,
  bridgeResults,
  bridgeDownloadResult,
  resetBridgeRateLimits,
  BRIDGE_CONNECTION_KEY,
  BRIDGE_PERMISSIONS,
  BRIDGE_RATE_LIMITS,
} from './bridge';
export { DuplicateImportFileError, ImportRejectedError, BridgeAuthError, importHref } from './errors';
export {
  buildImportSummary,
  deriveImportState,
  failureNotificationTitle,
  wehagoDuplicateKey,
  INGEST_CHANNEL_LABELS,
  CLIENT_AUTO_CONFIDENCE,
  MAX_IMPORT_FILE_BYTES,
  WEHAGO_DUPLICATE_REASON,
  WEHAGO_DUPLICATE_RULE_CODE,
  type ImportState,
} from './helpers';
export type * from './types';

/** 작업 처리기 등록: import_file */
export function registerImportsJobHandlers(): void {
  registerJobHandler('import_file', runImportFileJob);
}
