import { NextResponse, type NextRequest } from 'next/server';
import { verifyMfa } from '@mintax/server';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@mintax/security';
import { publicApi } from '@/lib/server/api';
import { db } from '@/lib/server/runtime';
import { metaFromHeaders } from '@/lib/server/request';

export const POST = publicApi(async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as { challengeToken?: string; code?: string };
  const r = await verifyMfa(db(), { challengeToken: String(body.challengeToken ?? ''), code: String(body.code ?? ''), ...metaFromHeaders(req.headers) });
  const res = NextResponse.json({ status: 'ok', next: r.mustChangePassword ? '/account/password?required=1' : '/' });
  res.cookies.set(SESSION_COOKIE_NAME, r.sessionToken, sessionCookieOptions());
  return res;
});
