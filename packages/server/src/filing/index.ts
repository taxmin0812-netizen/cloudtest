/**
 * 원천세 Control Tower — 신고 10단계 보드 · 신고 완료 표시 · 접수증/납부서 · 급여 검토표 엑셀.
 *
 * 연동 상태 (정직하게): 홈택스·위택스 전자신고 API 없음 → FILE_BASED.
 * MIN TAX OPS 는 신고를 제출하지 않는다. WEHAGO 가 만든 신고 파일을 사람이 제출하고, 결과(접수증·납부서)를 올린다.
 */
export { getFilingBoard, toJobSummary, FILING_INTEGRATION_MESSAGE } from './board';
export { getFilingJob, markFiled, uploadFilingResult, parseAmountHint, parseReceiptNumberHint } from './results';
export { generateReviewExcel } from './review-excel';
export { syncFilingJobsForMonth, detachMonthFromFilingJobs, FILING_CHANNEL_NOTE, type FilingPayload, type FilingMonthEntry, type SyncedFilingJob } from './sync';
export {
  FILING_STEPS,
  FILING_STEP_LABELS,
  FILING_KINDS,
  FILING_KIND_LABELS,
  READY_STEP_OF,
  currentStepOf,
  deriveBoardRow,
  type FilingKind,
  type StepStatus,
  type BoardStep,
  type BoardAction,
  type BoardClientInput,
} from './steps';
export type * from './types';
