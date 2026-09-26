import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Permission } from '@mintax/core';
import { checkSession, createContext, type ServiceContext, type ValidatedSession } from '@mintax/server';
import { SESSION_COOKIE_NAME } from '@mintax/security';
import { db } from './runtime';
import { requestMeta } from './request';

/** 서버 컴포넌트용 세션 조회 (요청당 1회 캐시) */
export const getSession = cache(async (): Promise<(ValidatedSession & { token: string }) | { reason: string }> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return { reason: 'no_session' };
  const r = await checkSession(db(), token, await requestMeta());
  if (!r.ok) return { reason: r.reason };
  const { ok: _ok, ...rest } = r;
  return { ...rest, token };
});

/** 로그인 필수 페이지: 세션이 없거나 만료면 로그인으로 (사유 표시) */
export async function requireSession(): Promise<ValidatedSession> {
  const s = await getSession();
  if ('reason' in s) redirect(`/login?reason=${encodeURIComponent(s.reason)}`);
  if (s.mustChangePassword) redirect('/account/password?required=1');
  return s;
}

/** 서버 컴포넌트에서 서비스 호출용 컨텍스트 */
export async function serviceContext(permission?: Permission): Promise<ServiceContext> {
  const s = await requireSession();
  if (permission && !s.actor.permissions.has(permission)) redirect('/forbidden');
  return createContext(db(), s.actor);
}
