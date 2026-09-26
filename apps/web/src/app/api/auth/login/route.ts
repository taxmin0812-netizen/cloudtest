import { NextResponse, type NextRequest } from 'next/server';
import { login } from '@mintax/server';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@mintax/security';
import { publicApi } from '@/lib/server/api';
import { db } from '@/lib/server/runtime';
import { metaFromHeaders } from '@/lib/server/request';

export const POST = publicApi(async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  const r = await login(db(), { email: String(body.email ?? ''), password: String(body.password ?? ''), ...metaFromHeaders(req.headers) });
  if (r.status === 'mfa_required') return { status: 'mfa_required', challengeToken: r.challengeToken };
  const res = NextResponse.json({ status: 'ok', next: r.mustChangePassword ? '/account/password?required=1' : r.mustEnrollMfa ? '/account/mfa?required=1' : '/' });
  res.cookies.set(SESSION_COOKIE_NAME, r.sessionToken, sessionCookieOptions());
  return res;
});
