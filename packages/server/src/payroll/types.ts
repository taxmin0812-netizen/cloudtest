/**
 * 인건비 area DTO — Next.js 서버 컴포넌트/route handler 가 그대로 쓰는 JSON 직렬화 가능한 값만 담는다.
 * 금액은 number(원), 시각은 ISO 문자열, 날짜는 'YYYY-MM-DD'.
 * 주민번호·계좌 원문은 revealEmployeeSensitive 결과 외에는 어떤 DTO 에도 담지 않는다.
 */
import type { IncomeType, IntegrationStatus, PayrollChangeKind, RiskSeverity } from '@mintax/core';
import type { PayrollDiffSummary } from '@mintax/core/payroll/index';
import type { LineAmounts, MoneyTotals } from './helpers';

// ────────────────────────────── 직원 ──────────────────────────────

export type EmployeeStatus = 'active' | 'resigned' | 'not_started' | 'inactive';

export interface EmployeeDTO {
  id: string;
  clientId: string;
  name: string;
  incomeType: IncomeType;
  incomeTypeLabel: string;
  /** WEHAGO 사원코드/소득자코드 (없으면 자동 부여값) */
  employeeCode: string;
  employeeCodeSource: 'auto' | 'user';
  hasIdNumber: boolean;
  /** 900101-1****** — 원문은 절대 담지 않는다 */
  idNumberMasked: string | null;
  isForeigner: boolean;
  hireDate: string | null;
  resignDate: string | null;
  status: EmployeeStatus;
  baseSalary: number;
  allowances: Record<string, number>;
  nonTaxable: Record<string, number>;
  dailyWage: number | null;
  businessIncomeCode: string | null;
  paymentDay: number | null;
  bankName: string | null;
  hasBankAccount: boolean;
  bankAccountMasked: string | null;
  dependents: number;
  reportStatus: string | null;
  active: boolean;
  /** 예: '주민번호 미등록 — 신고 불가' */
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateEmployeeInput {
  clientId: string;
  name: string;
  incomeType: IncomeType;
  /** 주민(외국인)등록번호 원문 — 암호화 저장 후 버린다 */
  idNumber?: string | null;
  hireDate?: string | null;
  resignDate?: string | null;
  baseSalary?: number;
  allowances?: Record<string, number>;
  nonTaxable?: Record<string, number>;
  dailyWage?: number | null;
  businessIncomeCode?: string | null;
  paymentDay?: number | null;
  bankName?: string | null;
  bankAccount?: string | null;
  dependents?: number;
  reportStatus?: string | null;
  employeeCode?: string | null;
}

export type UpdateEmployeePatch = Partial<Omit<CreateEmployeeInput, 'clientId'>> & { active?: boolean };

export type SensitiveField = 'idNumber' | 'bankAccount';

export interface RevealedSensitiveDTO {
  employeeId: string;
  field: SensitiveField;
  /** 1회 표시용 원문. 화면은 표시 후 즉시 버린다 (저장·로그 금지) */
  value: string;
  masked: string;
  revealedAt: string;
  /** 권장 표시 시간(초) */
  displaySeconds: number;
  auditLogId: string;
}

export interface EmployeeImportRow {
  name: string;
  incomeType?: IncomeType | string | null;
  employeeCode?: string | null;
  idNumber?: string | null;
  hireDate?: string | null;
  resignDate?: string | null;
  baseSalary?: number | null;
  dailyWage?: number | null;
  businessIncomeCode?: string | null;
  paymentDay?: number | null;
  bankName?: string | null;
  bankAccount?: string | null;
  dependents?: number | null;
  /** 원본 행 번호 (오류 안내용) */
  rowNumber?: number;
}

export interface EmployeeImportResult {
  clientId: string;
  created: number;
  updated: number;
  unchanged: number;
  failed: Array<{ rowNumber: number | null; name: string; reason: string }>;
  employees: EmployeeDTO[];
  summary: string;
}

// ────────────────────────────── 급여 월 ──────────────────────────────

export interface PayrollMonthDTO {
  id: string;
  clientId: string;
  clientName: string;
  period: string;
  paymentPeriod: string;
  wizardStep: number;
  wizardStepLabel: string;
  status: string;
  statusLabel: string;
  diffSummary: Record<string, number>;
  totals: MoneyTotals & { byIncomeType: Record<IncomeType, MoneyTotals> };
  pendingReview: number;
  manualTouches: number;
  confirmedAt: string | null;
  confirmedBy: string | null;
  previousPeriod: string;
  previousMonthId: string | null;
  previousStatus: string | null;
  semiannual: boolean;
  warnings: string[];
  href: string;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollItemDTO {
  id: string;
  payrollMonthId: string;
  employeeId: string;
  name: string;
  employeeCode: string;
  incomeType: IncomeType;
  incomeTypeLabel: string;
  idNumberMasked: string | null;
  hasIdNumber: boolean;
  taxablePay: number;
  nonTaxablePay: number;
  grossPay: number;
  allowances: Record<string, number>;
  workDays: number | null;
  incomeTax: number;
  localIncomeTax: number;
  otherDeductions: number;
  netPay: number;
  paymentDate: string | null;
  changeKinds: string[];
  needsReview: boolean;
  reviewed: boolean;
  reviewedAt: string | null;
  origin: string;
}

export interface PayrollMonthDetailDTO extends PayrollMonthDTO {
  items: PayrollItemDTO[];
  exports: PayrollExportJobDTO[];
}

export interface StartPayrollMonthResult extends PayrollMonthDTO {
  created: boolean;
  carried: { carriedForward: number; fromMaster: number; excluded: Array<{ employeeId: string; name: string; reason: string }>; notes: string[] };
}

export type PayrollDecision = 'resigned' | 'keep' | 'on_leave';

export interface PayrollChangeDTO {
  employeeId: string;
  itemId: string | null;
  name: string;
  incomeType: IncomeType;
  incomeTypeLabel: string;
  kinds: PayrollChangeKind[];
  kindLabels: string[];
  severity: RiskSeverity;
  messages: string[];
  previous: LineAmounts | null;
  current: LineAmounts | null;
  changeRate: number | null;
  grossDelta: number | null;
  idNumberMasked: string | null;
  /** 사람이 확인했는가 (승인·수정·결정) */
  reviewed: boolean;
  reviewedAt: string | null;
  decision: PayrollDecision | null;
  /** 가능한 행동 */
  actions: Array<'approve' | 'edit' | PayrollDecision>;
}

export interface PayrollDiffDTO {
  payrollMonthId: string;
  clientId: string;
  clientName: string;
  period: string;
  paymentPeriod: string;
  previousPeriod: string;
  previousMonthId: string | null;
  previousStatus: string | null;
  summary: PayrollDiffSummary;
  summaryText: string;
  /** 검토 대상 (needsReview 또는 사람이 이미 처리한 행) — 미처리 먼저 */
  changes: PayrollChangeDTO[];
  pendingCount: number;
  reviewedCount: number;
  unchangedCount: number;
  unchangedGrossPay: number;
  wizardStep: number;
  status: string;
  warnings: string[];
}

export interface PayrollRowInput {
  employeeId?: string | null;
  employeeCode?: string | null;
  name?: string | null;
  taxablePay?: number | null;
  nonTaxablePay?: number | null;
  /** 과세/비과세 없이 지급총액만 있으면 전액 과세로 본다 (경고) */
  grossPay?: number | null;
  allowances?: Record<string, number> | null;
  workDays?: number | null;
  incomeTax?: number | null;
  localIncomeTax?: number | null;
  otherDeductions?: number | null;
  paymentDate?: string | null;
  rowNumber?: number | null;
}

export interface ApplyPayrollRowsInput {
  payrollMonthId: string;
  rows: PayrollRowInput[];
  /** true: 수임처 제출 자료가 전체 명단 → 명단에 없는 전월 복사 행은 빼고 '이번 달 명단 없음' 으로 검토 */
  fullRoster?: boolean;
  sourceName?: string;
}

export interface ApplyPayrollRowsResult {
  payrollMonthId: string;
  matched: number;
  changed: number;
  unchanged: number;
  added: number;
  removedNotInRoster: Array<{ employeeId: string; name: string }>;
  unmatched: Array<{ rowNumber: number | null; name: string; reason: string }>;
  notes: string[];
  diff: PayrollDiffDTO;
  summary: string;
}

export interface UpdatePayrollItemInput {
  itemId: string;
  taxablePay?: number;
  nonTaxablePay?: number;
  /** 근로소득만 (사업·일용은 자동 계산) */
  incomeTax?: number;
  workDays?: number;
  allowances?: Record<string, number>;
  otherDeductions?: number;
  paymentDate?: string | null;
  note?: string;
}

export interface UpdatePayrollItemResult {
  item: PayrollItemDTO;
  basis: string[];
  warnings: string[];
  manualTouches: number;
}

export interface ApproveChangesResult {
  approved: number;
  alreadyReviewed: number;
  diff: PayrollDiffDTO;
}

export interface PayrollValidationIssue {
  itemId: string | null;
  employeeId: string | null;
  name: string | null;
  code: string;
  severity: RiskSeverity;
  blocking: boolean;
  message: string;
}

export interface PayrollValidationDTO {
  payrollMonthId: string;
  ok: boolean;
  checkedAt: string;
  counts: { high: number; warning: number; info: number; blocking: number };
  issues: PayrollValidationIssue[];
  totals: MoneyTotals & { byIncomeType: Record<IncomeType, MoneyTotals> };
  summary: string;
}

// ────────────────────────────── WEHAGO 급여 파일 ──────────────────────────────

export type PayrollExportKind = 'payroll_earned' | 'payroll_business' | 'payroll_daily';

export interface PayrollExportJobDTO {
  id: string;
  kind: PayrollExportKind | string;
  kindLabel: string;
  status: string;
  templateKey: string;
  templateVersion: string;
  templateStatus: string;
  templateVerified: boolean;
  rowCount: number;
  grossPay: number;
  incomeTax: number;
  localIncomeTax: number;
  netPay: number;
  containsIdNumbers: boolean;
  uploadAllowed: boolean;
  warnings: string[];
  blockedReason: string | null;
  fileId: string | null;
  fileName: string | null;
  createdAt: string;
  downloadedAt: string | null;
  integrationStatus: IntegrationStatus;
}

export interface PayrollExportsResult {
  payrollMonthId: string;
  jobs: PayrollExportJobDTO[];
  warnings: string[];
  integrationStatus: IntegrationStatus;
  note: string;
  summary: string;
}

export interface PayrollExportDownload {
  fileName: string;
  mimeType: string;
  data: Buffer;
  sizeBytes: number;
  sha256: string;
  warnings: string[];
  exportJob: PayrollExportJobDTO;
}

export interface PayrollTemplateInfoDTO {
  kind: PayrollExportKind;
  key: string;
  version: string;
  name: string;
  status: string;
  verified: boolean;
  source: 'default' | 'office';
  columns: Array<{ header: string; field: string; required: boolean }>;
  warning: string | null;
  note: string;
}

// ────────────────────────────── 원천세 요약 ──────────────────────────────

export interface StatementSummaryDTO {
  kind: 'earned' | 'business' | 'daily';
  label: string;
  rows: number;
  persons: number;
  paidAmount: number;
  incomeTax: number;
  localIncomeTax: number;
  cycle: string;
  submissionPeriod: { from: string; to: string };
  dueDate: string;
  shiftNote: string | null;
  /** filing_jobs.period 로 쓰일 값 */
  filingPeriod: string;
  status: string;
  note: string | null;
}

export interface WithholdingSummaryDTO {
  payrollMonthId: string;
  clientId: string;
  clientName: string;
  period: string;
  paymentPeriod: string;
  semiannual: boolean;
  /** filing_jobs(withholding).period — 반기납부면 반기 마지막 달 */
  filingPeriod: string;
  rows: Array<{ code: string; label: string; persons: number; totalPay: number; incomeTax: number; isSubtotal: boolean }>;
  total: { persons: number; totalPay: number; incomeTax: number };
  localIncomeTax: { declared: number; expected: number; matches: boolean; byIncomeType: Record<IncomeType, number>; dueDate: string };
  dueDate: string;
  dueNote: string | null;
  statements: StatementSummaryDTO[];
  itemTotals: MoneyTotals & { byIncomeType: Record<IncomeType, MoneyTotals> };
  consistency: { ok: boolean; mismatches: string[] };
  blocked: boolean;
  blockedReasons: string[];
  warnings: string[];
  notCovered: string[];
  integrationStatus: IntegrationStatus;
  note: string;
}

export interface ReadyForFilingResult {
  month: PayrollMonthDTO;
  alreadyConfirmed: boolean;
  exports: PayrollExportJobDTO[];
  filingJobs: Array<{ id: string; kind: string; label: string; period: string; dueDate: string | null; currentStep: string; created: boolean }>;
  withholding: WithholdingSummaryDTO;
  warnings: string[];
  summary: string;
}

// ────────────────────────────── payroll_prepare 작업 ──────────────────────────────

export interface PayrollPreparePayload {
  period?: string;
  clientIds?: string[];
  payrollMonthId?: string;
}

export interface PayrollPrepareClientOutcome {
  clientId: string;
  clientName: string;
  payrollMonthId: string | null;
  created: boolean;
  status: 'no_changes' | 'needs_review' | 'locked' | 'failed';
  pendingReview: number;
  headcount: number;
  summary: string;
  error?: { code: string; message: string };
}

export interface PayrollPrepareJobResult {
  period: string;
  clients: number;
  noChanges: number;
  needsReview: number;
  locked: number;
  failed: number;
  perClient: PayrollPrepareClientOutcome[];
  summary: string;
  durationMs: number;
}
