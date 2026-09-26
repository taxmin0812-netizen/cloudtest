/**
 * 어댑터 공통 오류.
 * message 는 그대로 사용자에게 보여줄 수 있는 한국어 문장이다 (다음 행동 포함).
 */
export type AdapterErrorCode =
  | 'EMPTY_FILE'
  | 'LEGACY_XLS'
  | 'ENCRYPTED_FILE'
  | 'UNSUPPORTED_FORMAT'
  | 'PDF_NOT_TABULAR'
  | 'CORRUPT_FILE'
  | 'TOO_MANY_ROWS'
  | 'HEADER_NOT_FOUND'
  | 'COLUMN_MAPPING_REQUIRED'
  | 'INVALID_CONTEXT'
  | 'EXPORT_VALIDATION_FAILED'
  | 'TEMPLATE_INVALID';

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: AdapterErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }
}

export function isAdapterError(e: unknown): e is AdapterError {
  return e instanceof AdapterError;
}

/** 구형 xls 안내 문구 (정확한 문구는 화면/테스트에서 공유) */
export const LEGACY_XLS_MESSAGE = '구형 .xls 형식입니다. Excel에서 .xlsx로 저장 후 올려주세요.';
