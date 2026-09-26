/**
 * WEHAGO Bridge — 전송파일(엑셀) 생성 · 재검증 · 다운로드 · 업로드 확인 · 역수입 대사 · 서식 관리.
 *
 * 연동 상태 (정직하게): WEHAGO 전표 API 는 확인되지 않았다(NOT_AVAILABLE) → 파일 기반(FILE_BASED).
 * MIN TAX OPS 는 파일을 만들고 검증할 뿐, WEHAGO 에 올리는 것은 사람이다.
 */
import { registerJobHandler } from '../jobs/registry';
import { runExportWehagoJob } from './job';

export { prepareWehagoExport, prepareClientExports, kindsNeeded, buildComparison, itemsFromParsedFile, loadCandidates, loadAccountMap, type ExportItemDraft } from './prepare';
export { downloadExport, confirmWehagoUpload, exportStaleness } from './download';
export { importWehagoLedger } from './ledger';
export { getExportJob, listExportJobs, toExportJobDTO } from './dto';
export {
  getActiveTemplate,
  previewWehagoTemplate,
  registerWehagoTemplate,
  resetWehagoTemplate,
  confirmWehagoTemplateVerified,
  loadActiveTemplate,
  templateInfo,
  DEFAULT_TEMPLATE_WARNING,
  OFFICE_TEMPLATE_WARNING,
  type ActiveTemplate,
  type TemplateUploadInput,
} from './templates';
export { getWehagoPartnerCodes, saveWehagoPartnerCodes, listUnmappedPartners, type PartnerCodeInput } from './partner-codes';
export { runExportBatch, runExportWehagoJob, requestWehagoExport, batchSummary, type ExportWehagoPayload, type ExportBatchResult, type ExportBatchClientOutcome } from './job';
export {
  EXPORT_KINDS,
  EXPORT_KIND_LABELS,
  EXPORT_STATUS_LABELS,
  WEHAGO_FILE_NOTE,
  checkCandidates,
  exportFileName,
  parseExportScope,
  routeForExport,
  wehagoDuplicateGroups,
  type CandidateTx,
  type ExportScope,
  type ExportRoute,
} from './helpers';
export type * from './types';

/** 작업 처리기 등록: export_wehago */
export function registerExportJobHandlers(): void {
  registerJobHandler('export_wehago', runExportWehagoJob);
}
