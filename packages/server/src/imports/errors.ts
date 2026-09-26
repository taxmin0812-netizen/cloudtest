/**
 * 자료 수집 오류 — 모두 AppError 하위 (한국어 userMessage + 다음 행동).
 */
import { AppError, type UserAction } from '@mintax/security';
import { isAdapterError, type AdapterError } from '@mintax/adapters';

export function importHref(importJobId: string): string {
  return `/imports/${importJobId}`;
}

/** 같은 파일(sha256)을 같은 수임처에 이미 가져왔다 (멱등성) */
export class DuplicateImportFileError extends AppError {
  readonly previousImportJobId: string;
  constructor(previousImportJobId: string, when: string, summary: string) {
    super({
      code: 'IMPORT_DUPLICATE_FILE',
      httpStatus: 409,
      userMessage: `${when}에 이미 가져온 파일입니다 (${summary}). 같은 파일을 다시 올려도 거래는 늘지 않습니다 — 이전 가져오기 결과를 확인하세요.`,
      action: { label: '이전 가져오기 보기', href: importHref(previousImportJobId) },
      details: { previousImportJobId },
    });
    this.previousImportJobId = previousImportJobId;
  }
}

/** 파일을 읽을 수 없음 / 서식·수임처 문제 등 사용자가 고쳐야 하는 오류 (재시도 무의미) */
export class ImportRejectedError extends AppError {
  constructor(code: string, userMessage: string, opts: { action?: UserAction; httpStatus?: number; details?: Record<string, unknown>; message?: string } = {}) {
    super({
      code,
      httpStatus: opts.httpStatus ?? 422,
      userMessage,
      action: opts.action,
      details: opts.details,
      message: opts.message,
      retryable: false,
    });
  }
}

/** 어댑터 오류(이미 한국어 사용자 문장) → AppError */
export function fromAdapterError(e: AdapterError, action?: UserAction): ImportRejectedError {
  return new ImportRejectedError(`IMPORT_${e.code}`, e.message, {
    action,
    httpStatus: e.code === 'TOO_MANY_ROWS' ? 413 : 422,
    details: { adapterCode: e.code },
  });
}

export function toImportError(e: unknown, action?: UserAction): unknown {
  return isAdapterError(e) ? fromAdapterError(e, action) : e;
}

/** Bridge 토큰 인증 실패 (401) */
export class BridgeAuthError extends AppError {
  constructor(code: 'bridge_token_invalid' | 'device_revoked' | 'bridge_owner_inactive', userMessage: string) {
    super({
      code,
      httpStatus: 401,
      userMessage,
      action: { label: 'Bridge 연결 설정', href: '/settings/integrations' },
    });
  }
}
