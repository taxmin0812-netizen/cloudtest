/**
 * WEHAGO Bridge (전송파일) — 화면/API 로 내보내는 DTO.
 * 모두 JSON 직렬화 가능한 평범한 객체다 (금액 number, 시각 ISO 문자열).
 */
import type { IntegrationStatus } from '@mintax/core';

export type WehagoExportKind = 'wehago_purchase_sales' | 'wehago_general_journal';

export interface TotalsDTO {
  count: number;
  supplyAmount: number;
  vatAmount: number;
  totalAmount: number;
}

/** 전송 차단 사유 — "검토 대기 3건이 남아 있습니다 [3건 검토하기]" */
export interface ExportBlockReason {
  code: string;
  message: string;
  count: number;
  href: string | null;
  actionLabel: string | null;
  /** 관련 거래 (최대 50개) */
  transactionIds?: string[];
}

export interface TemplateInfoDTO {
  kind: WehagoExportKind;
  key: string;
  version: string;
  name: string;
  /** standard(MIN TAX OPS 표준) | office_sample(사무소 서식) | mock */
  status: 'standard' | 'mock' | 'office_sample';
  verified: boolean;
  /** default = 코드 기본 서식, office = 사무소가 등록한 서식 */
  source: 'default' | 'office';
  headerHash: string;
  columns: Array<{ header: string; field: string; required: boolean }>;
  note: string;
  /** 화면에 그대로 보여줄 경고 (미검증 서식 등). 없으면 null */
  warning: string | null;
  registeredAt: string | null;
  registeredBy: string | null;
  sourceFileName: string | null;
  verifiedAt: string | null;
}

export interface ComparisonRowDTO {
  key: string;
  label: string;
  source: TotalsDTO;
  export: TotalsDTO;
  match: boolean;
}

/** export_jobs.validation 에 저장되는 Source vs Export 비교 */
export interface ExportComparisonDTO {
  source: TotalsDTO;
  export: TotalsDTO;
  match: boolean;
  byEvidenceType: ComparisonRowDTO[];
  byAccount: ComparisonRowDTO[];
  verifySummary: string;
}

export interface ExportJobDTO {
  id: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  period: string;
  kind: WehagoExportKind | string;
  kindLabel: string;
  version: number | null;
  status: string;
  statusLabel: string;
  fileName: string | null;
  templateKey: string;
  templateVersion: string;
  templateVerified: boolean | null;
  rowCount: number;
  fileRowCount: number | null;
  totals: TotalsDTO;
  blockedReason: string | null;
  reasons: ExportBlockReason[];
  warnings: string[];
  comparison: ExportComparisonDTO | null;
  supersededBy: string | null;
  reconciliationId: string | null;
  createdAt: string;
  createdBy: string | null;
  downloadedAt: string | null;
  uploadConfirmedAt: string | null;
  /** WEHAGO 전표 API 없음 → 항상 FILE_BASED */
  integrationStatus: IntegrationStatus;
}

export interface PrepareExportBlocked {
  status: 'blocked';
  clientId: string;
  clientName: string;
  period: string;
  kind: WehagoExportKind;
  exportJobId: string | null;
  reasons: ExportBlockReason[];
  warnings: string[];
  preReconciliationId: string | null;
  reconciliationId: string | null;
  /** "에이플러스디자인 2026-09 매입매출 전송 차단: 검토 대기 3건이 남아 있습니다 외 1건" */
  summary: string;
}

export interface PrepareExportReady {
  status: 'ready';
  clientId: string;
  clientName: string;
  period: string;
  kind: WehagoExportKind;
  exportJobId: string;
  version: number;
  fileName: string;
  /** 거래 건수 */
  rowCount: number;
  /** 파일 데이터 행 수 (일반전표는 분개 줄 수) */
  fileRowCount: number;
  totals: TotalsDTO;
  comparison: ExportComparisonDTO;
  template: TemplateInfoDTO;
  warnings: string[];
  preReconciliationId: string;
  reconciliationId: string;
  supersededExportIds: string[];
  integrationStatus: IntegrationStatus;
  nextStep: string;
  summary: string;
}

export type PrepareExportResult = PrepareExportBlocked | PrepareExportReady;

export interface ClientExportsResult {
  clientId: string;
  clientName: string;
  period: string;
  status: 'ready' | 'blocked';
  results: PrepareExportResult[];
  summary: string;
}

export interface DownloadExportResult {
  fileName: string;
  mimeType: string;
  data: Buffer;
  sizeBytes: number;
  sha256: string;
  warnings: string[];
  exportJob: ExportJobDTO;
}

export interface ConfirmUploadResult {
  exportJob: ExportJobDTO;
  alreadyConfirmed: boolean;
  transactionsExported: number;
  integrationStatus: IntegrationStatus;
  /** 정직한 안내: API 가 없어 사람이 올린 것을 기록만 한다 */
  note: string;
  nextStep: string;
}

export interface PartnerCodeDTO {
  businessNumber: string | null;
  merchantKey: string | null;
  merchantName: string;
  code: string;
  source: 'manual' | 'wehago_ledger';
  updatedAt: string;
}

export interface UnmappedPartnerDTO {
  merchantName: string;
  businessNumber: string | null;
  transactionCount: number;
  totalAmount: number;
}

export interface TemplatePreviewDTO {
  kind: WehagoExportKind;
  fileName: string;
  sheetName: string;
  headerRowIndex: number;
  columns: Array<{ index: number; header: string; field: string | null; matchedBy: string | null }>;
  unmatchedHeaders: string[];
  missingRequired: string[];
  confidence: number;
  warnings: string[];
  /** 저장 가능 여부 (필수 항목 누락·서식 오류가 없을 때) */
  canRegister: boolean;
  errors: string[];
  headerHash: string;
}

export interface LedgerImportResult {
  reconciliationId: string;
  matched: boolean;
  transactionsReconciled: number;
  exportJobId: string | null;
  ledger: {
    fileId: string;
    fileName: string;
    rows: number;
    failures: Array<{ rowNumber: number; reason: string }>;
    outOfPeriod: number;
    excludedByScope: number;
    learnedPartnerCodes: number;
  };
  /** 받지 않은 전송파일이 있는데 WEHAGO 에 이미 같은 전표가 있을 때 (이중 기장 위험) */
  doubleBookingWarning: string | null;
  summary: string;
}
