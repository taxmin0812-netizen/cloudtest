/**
 * 인건비 Automation Studio + 월 급여 마법사(7단계) + 원천세 신고 연계.
 *
 * 연동 상태 (정직하게): WEHAGO 급여 API 없음 → 급여자료는 FILE_BASED(엑셀). 급여 서식 열 구성 미확인 → 등록 전 MOCK.
 * 홈택스·위택스 전자신고 API 없음 → 신고는 사람이 제출(FILE_BASED), MIN TAX OPS 는 준비·검증·기한·증빙 관리.
 */
import { registerJobHandler } from '../jobs/registry';
import { runPayrollPrepareJob } from './job';

// 직원 (Automation Studio)
export {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  resignEmployee,
  revealEmployeeSensitive,
  importEmployees,
  importEmployeesFile,
  parseIncomeTypeWord,
  ID_NUMBER_CONTEXT,
  BANK_ACCOUNT_CONTEXT,
} from './employees';
// 마법사 1~4단계
export {
  startPayrollMonth,
  getPayrollMonth,
  findPayrollMonth,
  applyPayrollRows,
  importPayrollFile,
  getPayrollDiff,
  approveChanges,
  confirmNewAndResigned,
  updatePayrollItem,
  validatePayrollMonth,
  reopenPayrollMonth,
} from './wizard';
// 5단계 — WEHAGO 급여 파일
export {
  generatePayrollExports,
  downloadPayrollExport,
  confirmPayrollUpload,
  getPayrollTemplates,
  registerPayrollTemplate,
  confirmPayrollTemplateVerified,
  PAYROLL_EXPORT_KIND_LABELS,
  PAYROLL_EXPORT_NOTE,
  MOCK_TEMPLATE_WARNING,
} from './exports';
// 6단계 — 원천세 요약
export { getWithholdingSummary, EXTRA_HOLIDAYS_SETTING } from './withholding';
// 7단계 — 확정 + 신고 연계
export { markReadyForFiling } from './confirm';
// payroll_prepare 작업
export { runPayrollPrepareForAll, preparePayrollForAll, runPayrollPrepareJob } from './job';
export {
  CHANGE_KIND_LABELS,
  PAYROLL_STATUS_LABELS,
  WIZARD_STEP_LABELS,
  maskBankAccount,
  containsRawRrn,
  type LineAmounts,
  type MoneyTotals,
} from './helpers';
export type * from './types';

/** 작업 처리기 등록: payroll_prepare */
export function registerPayrollJobHandlers(): void {
  registerJobHandler('payroll_prepare', runPayrollPrepareJob);
}
