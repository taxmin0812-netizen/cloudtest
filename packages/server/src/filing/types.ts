/**
 * 원천세 Control Tower DTO — JSON 직렬화 가능한 값만 (금액 number, 시각 ISO 문자열).
 */
import type { FilingStep, IntegrationStatus } from '@mintax/core';
import type { BoardAction, BoardStep, FilingKind } from './steps';

export interface FilingBoardRowDTO {
  clientId: string;
  clientName: string;
  clientCode: string;
  assigneeId: string | null;
  cycle: 'monthly' | 'semiannual';
  cycleLabel: string;
  /** 이 지급월에 신고해야 하는 작업의 가장 빠른 기한 */
  dueDate: string | null;
  dDay: number | null;
  dDayLabel: string | null;
  steps: BoardStep[];
  blockers: string[];
  nextAction: BoardAction | null;
  complete: boolean;
  overdue: boolean;
  filingDueThisPeriod: boolean;
  payrollMonths: Array<{ id: string; period: string; status: string; wizardStep: number; pendingReview: number; href: string }>;
  jobs: FilingJobSummaryDTO[];
}

export interface FilingJobSummaryDTO {
  id: string;
  kind: FilingKind;
  kindLabel: string;
  period: string;
  dueDate: string | null;
  currentStep: FilingStep;
  currentStepLabel: string;
  persons: number;
  totalPay: number;
  incomeTax: number;
  localIncomeTax: number;
  monthsIncluded: string[];
  filedAt: string | null;
  receipts: number;
  paymentSlips: number;
  amendmentWarning: string | null;
}

export interface FilingBoardDTO {
  period: string;
  today: string;
  rows: FilingBoardRowDTO[];
  summary: {
    clients: number;
    dueSoonUnfiled: number;
    overdue: number;
    receiptsMissing: number;
    payrollUnconfirmed: number;
    complete: number;
  };
  stepLabels: Array<{ step: FilingStep; label: string }>;
  integration: { status: IntegrationStatus; message: string };
}

export interface FilingResultDTO {
  id: string;
  filingJobId: string;
  kind: 'receipt' | 'payment_slip' | 'filed_data' | string;
  kindLabel: string;
  fileId: string | null;
  fileName: string | null;
  receiptNumber: string | null;
  amount: number | null;
  filedAt: string | null;
  collectedVia: string;
  createdAt: string;
  /** 같은 신고를 다시 전송하면 최종분이 유효 → 가장 늦은 접수증을 정본으로 표시 */
  canonical: boolean;
}

export interface FilingJobDTO extends FilingJobSummaryDTO {
  clientId: string;
  clientName: string;
  steps: Record<string, string | null>;
  channelStatus: string;
  channelNote: string;
  results: FilingResultDTO[];
  warnings: string[];
  payload: {
    months: Array<{ paymentPeriod: string; attributionPeriod: string; payrollMonthId: string; persons: number; totalPay: number; incomeTax: number; localIncomeTax: number; rows: number }>;
    withholdingRows: Array<{ code: string; label: string; persons: number; totalPay: number; incomeTax: number; isSubtotal: boolean }>;
  };
}

export interface MarkFiledResult {
  job: FilingJobDTO;
  integrationStatus: IntegrationStatus;
  note: string;
  warnings: string[];
}

export interface UploadFilingResultOutput {
  result: FilingResultDTO;
  job: FilingJobDTO;
  duplicate: boolean;
  amountSource: 'input' | 'file_name' | 'file_text' | null;
  warnings: string[];
}

export interface ReviewExcelResult {
  exportJobId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
  sizeBytes: number;
  sha256: string;
  sheets: string[];
}
