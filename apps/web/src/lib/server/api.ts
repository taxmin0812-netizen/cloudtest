import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import type { Permission } from '@mintax/core';
import { checkSession, createContext, recordSystemError, type ServiceContext, type ValidatedSession } from '@mintax/server';
import { SESSION_COOKIE_NAME, toUserError } from '@mintax/security';
import { db, log } from './runtime';
import { metaFromHeaders } from './request';

export interface ApiContext {
  ctx: ServiceContext;
  session: ValidatedSession;
  req: NextRequest;
}

type Handler<P> = (a: ApiContext, params: P) => Promise<Response | unknown>;

/**
 * Route handler 래퍼 — 모든 API 는 이것을 거친다.
 * - 세션 검증 (쿠키) → 401 + 로그인 안내
 * - 상태 변경 요청은 Origin 검사 (CSRF 방어; 쿠키는 SameSite=strict)
 * - 권한 검사 (최소권한)
 * - 오류는 사용자 친화 메시지로 변환 (500 문구·스택 노출 금지) + system_errors 기록
 */
export function api<P = Record<string, string>>(handler: Handler<P>, opts: { permission?: Permission } = {}) {
  return async (req: NextRequest, route: { params: Promise<P> }): Promise<Response> => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
        return json({ error: { code: 'CSRF', message: '보안 검사에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.' } }, 403);
      }
      const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
      const check = await checkSession(db(), token, metaFromHeaders(req.headers));
      if (!check.ok) {
        return json(
          { error: { code: 'UNAUTHENTICATED', message: sessionMessage(check.reason), action: { label: '다시 로그인', href: '/login' } } },
          401,
        );
      }
      const { ok: _ok, ...session } = check;
      if (opts.permission && !session.actor.permissions.has(opts.permission)) {
        return json({ error: { code: 'FORBIDDEN', message: '이 작업을 수행할 권한이 없습니다. 사무소 관리자에게 권한을 요청하세요.' } }, 403);
      }
      const ctx = createContext(db(), session.actor);
      const params = (await route.params) ?? ({} as P);
      const result = await handler({ ctx, session, req }, params);
      if (result instanceof Response) return result;
      return json(result ?? { ok: true }, 200);
    } catch (e) {
      return errorResponse(e, req);
    }
  };
}

/** 로그인 전 API (로그인·MFA) 용 — 세션 검사 없음, Origin 검사·오류 변환만 */
export function publicApi(handler: (req: NextRequest) => Promise<Response | unknown>) {
  return async (req: NextRequest): Promise<Response> => {
    try {
      if (req.method !== 'GET' && !sameOrigin(req)) {
        return json({ error: { code: 'CSRF', message: '보안 검사에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.' } }, 403);
      }
      const r = await handler(req);
      return r instanceof Response ? r : json(r ?? { ok: true }, 200);
    } catch (e) {
      return errorResponse(e, req);
    }
  };
}

export async function errorResponse(e: unknown, req: NextRequest): Promise<Response> {
  const ue = toUserError(e);
  if (ue.httpStatus >= 500) {
    log.error('api error', { path: req.nextUrl.pathname, errorId: ue.errorId, error: e });
    await recordSystemError(db(), { area: 'web', error: e, userMessage: ue.message, context: { path: req.nextUrl.pathname, errorId: ue.errorId } }).catch(() => undefined);
  }
  const headers: Record<string, string> = {};
  if (ue.retryAfterSeconds) headers['Retry-After'] = String(ue.retryAfterSeconds);
  return json({ error: { code: ue.code, message: ue.message, errorId: ue.errorId, action: ue.action, fieldErrors: ue.fieldErrors } }, ue.httpStatus, headers);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** 파일 다운로드 응답 (한글 파일명 RFC 5987) */
export function fileResponse(data: Buffer, fileName: string, mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'): Response {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_');
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function readJson<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    const { ValidationError } = await import('@mintax/security');
    throw new ValidationError('요청 형식이 올바르지 않습니다.');
  }
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) {
    // 같은 사이트 fetch 는 Origin 을 보낸다. Origin 이 없으면 Sec-Fetch-Site 로 판단
    const site = req.headers.get('sec-fetch-site');
    return site === null || site === 'same-origin' || site === 'none';
  }
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sessionMessage(reason: string): string {
  switch (reason) {
    case 'idle':
      return '일정 시간 사용하지 않아 자동 로그아웃되었습니다. 다시 로그인해 주세요.';
    case 'absolute':
      return '로그인 유지 시간이 지나 자동 로그아웃되었습니다. 다시 로그인해 주세요.';
    case 'ip_blocked':
      return '허용되지 않은 위치(IP)에서 접속했습니다. 사무실 네트워크에서 접속해 주세요.';
    case 'mfa_pending':
      return 'OTP 인증이 필요합니다. 다시 로그인해 주세요.';
    case 'inactive':
      return '비활성화된 계정입니다. 관리자에게 문의해 주세요.';
    default:
      return '로그인이 필요합니다.';
  }
}
