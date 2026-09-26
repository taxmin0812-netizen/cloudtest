/**
 * 자료 수집(imports) DTO — Next.js 서버 컴포넌트/Route Handler 가 그대로 직렬화한다.
 * 금액은 number(원), 시각은 ISO 문자열.
 */
import type { Direction, EvidenceType, IngestChannel } from '@mintax/core';
import type { CanonicalField } from '@mintax/adapters';
import type { ImportState } from './helpers';

export interface ClientCandidateDTO {
  clientId: string;
  name: string;
  /** 000-00-00000 */
  businessNumber: string;
  /** 0~100 */
  confidence: number;
  reasons: string[];
}

export interface ImportDetectionDTO {
  /** 형식 프로필 id (예: hometax_card_purchase_v1). 판정 불가면 null */
  profileKey: string | null;
  profileName: string | null;
  /** 0~100 */
  confidence: number;
  requiresUserMapping: boolean;
  missingColumns: string[];
  /** 서식이 실제 샘플로 검증되었는가 (현재 모든 프로필 false — 검증필요) */
  profileVerified: boolean;
  clientCandidates: ClientCandidateDTO[];
  /** 확정된 수임처 (지정 또는 자동 판정) */
  clientId: string | null;
  /** 파일 내용으로 자동 확정했는가 */
  clientAutoDetected: boolean;
}

/** 사용자가 지정하는 열 매핑 (알 수 없는 서식 / 필수 열 누락 시) */
export interface ImportMappingInput {
  /** 필드 → 열 번호(0-base) 또는 헤더 제목 */
  columns: Partial<Record<CanonicalField, string | number>>;
  /** 헤더 행 (0-base). 생략하면 자동 판정 위치 */
  headerRowIndex?: number;
  /** 형식이 방향을 정하지 못할 때 (generic) */
  direction?: Direction;
  evidenceType?: EvidenceType;
  /** 형식 프로필 id (생략: 판정된 프로필, 없으면 generic_v1) */
  profileKey?: string;
}

export interface UploadImportInput {
  fileName: string;
  data: Buffer;
  clientId?: string | null;
  channel: IngestChannel;
  /** 'YYYY-MM' — 생략하면 거래일자로 정한다 */
  period?: string | null;
  /** 같은 파일(sha256)을 같은 수임처에 다시 가져오기 (행은 fingerprint 로 중복 처리된다) */
  force?: boolean;
  /** 적재할 시트 번호 (기본: 자동 선택) */
  sheetIndex?: number;
  /** 열 매핑을 미리 지정 */
  mapping?: ImportMappingInput;
  /** 파일 속 수임처와 선택한 수임처가 달라도 진행 (명시적 확인 후에만) */
  allowClientConflict?: boolean;
}

export interface UploadImportResult {
  importJobId: string;
  /** 작업 큐 id (진행률 폴링용). 사람 입력이 필요한 상태면 null */
  jobId: string | null;
  status: Extract<ImportState, 'queued' | 'needs_client' | 'needs_mapping'>;
  /** 화면에 그대로 보여줄 한국어 안내 */
  message: string;
  detected: ImportDetectionDTO;
  warnings: string[];
  href: string;
}

export interface ConfirmImportInput {
  importJobId: string;
  clientId?: string | null;
  mapping?: ImportMappingInput;
  sheetIndex?: number;
  force?: boolean;
  allowClientConflict?: boolean;
}

export interface ImportJobDTO {
  id: string;
  clientId: string | null;
  clientName: string | null;
  clientCode: string | null;
  fileId: string | null;
  fileName: string | null;
  fileSizeBytes: number | null;
  channel: IngestChannel;
  channelLabel: string;
  formatProfile: string | null;
  formatProfileName: string | null;
  source: string;
  period: string | null;
  /** DB 상태 (queued/running/succeeded/partial/failed) */
  status: string;
  /** 화면 상태 (needs_client/needs_mapping 포함) */
  state: ImportState;
  totalRows: number;
  importedRows: number;
  duplicateRows: number;
  failedRows: number;
  sourceSupplyAmount: number;
  sourceVatAmount: number;
  sourceTotalAmount: number;
  /** "1,048건 수집 · 1,046건 처리 · 2건 처리실패" */
  summary: string;
  message: string | null;
  /** message 를 줄 단위로 나눈 안내 목록 (합계행 제외·병합·경고 등) */
  notes: string[];
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** import_file 작업 (진행률) */
  jobId: string | null;
  jobStatus: string | null;
  progress: number | null;
  jobErrorMessage: string | null;
  href: string;
}

export interface ImportJobDetailDTO extends ImportJobDTO {
  /** WEHAGO 이중 기장 가드로 보류된 건수 */
  wehagoDuplicateRows: number;
  /** 거래 상태별 건수 (분류 진행 확인용) */
  transactionStatusCounts: Record<string, number>;
  fileSha256: string | null;
}

export interface ListImportJobsInput {
  clientId?: string | null;
  period?: string | null;
  /** 기본 50, 최대 200 */
  limit?: number;
  /** 커서: 이 시각(ISO) 이전 생성분 */
  before?: string | null;
}

export interface ImportFailureDTO {
  sourceId: string;
  /** 원본 파일 기준 데이터 행 번호 (헤더 아래 1부터) */
  rowNumber: number;
  /** 엑셀 실제 행 번호 (있을 때) */
  excelRow: number | null;
  reason: string;
  field: string | null;
  fieldLabel: string | null;
  supplyAmount: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
  /** 원본 행 (어댑터가 카드번호·주민번호를 마스킹한 값) */
  rawData: Record<string, unknown>;
}

export interface ImportFailuresDTO {
  importJobId: string;
  fileName: string | null;
  total: number;
  truncated: boolean;
  items: ImportFailureDTO[];
}

export interface DownloadFile {
  fileName: string;
  data: Buffer;
  mimeType: string;
}

// ────────────────────────────── Bridge ──────────────────────────────

export interface BridgeTokenDTO {
  id: string;
  name: string;
  /** 토큰 앞부분 (식별용, 비밀 아님): mtb1.<id> */
  prefix: string;
  createdAt: string;
  createdByName: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  active: boolean;
}

export interface CreateBridgeTokenResult extends BridgeTokenDTO {
  /** 평문 토큰 — 이번 한 번만 보여준다. 서버에는 HMAC 해시만 남는다 */
  token: string;
}

export interface BridgeUploadInput {
  fileName: string;
  data: Buffer;
  /** Bridge PC 의 원본 경로 (파일명만 기록한다) */
  sourcePath?: string | null;
  /** downloads | inbox | filing | cloud_sync — downloads 면 download_watch 채널 */
  sourceFolder?: string | null;
  clientId?: string | null;
  period?: string | null;
}

export interface BridgeUploadResult {
  /** accepted: 큐에 들어감 / duplicate: 이미 가져온 파일 (성공으로 취급) / needs_client·needs_mapping: 웹에서 사람이 확인 */
  status: 'accepted' | 'duplicate' | 'needs_client' | 'needs_mapping';
  importJobId: string;
  jobId: string | null;
  message: string;
  href: string;
  detected: ImportDetectionDTO | null;
}

export interface BridgeResultFileDTO {
  exportJobId: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  period: string;
  kind: string;
  templateKey: string;
  templateVersion: string;
  fileId: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  rowCount: number;
  totalAmount: number;
  createdAt: string;
  /** MOCK 서식 — 파일명 앞에 MOCK_ 을 붙여 저장해야 한다 */
  mock: boolean;
  /** 실서식으로 검증되지 않음 — 파일명 뒤에 _검증필요 */
  verified: boolean;
  supersededBy: string | null;
  /** Bridge 가 저장할 권장 파일명 (MOCK_/_검증필요 반영) */
  suggestedFileName: string;
  downloadHref: string;
}

export interface BridgeResultsDTO {
  serverTime: string;
  items: BridgeResultFileDTO[];
}
