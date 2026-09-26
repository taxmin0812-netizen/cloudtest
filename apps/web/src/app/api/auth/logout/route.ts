import { NextResponse, type NextRequest } from 'next/server';
import { logout } from '@mintax/server';
import { SESSION_COOKIE_NAME } from '@mintax/security';
import { publicApi } from '@/lib/server/api';
import { db } from '@/lib/server/runtime';
import { metaFromHeaders } from '@/lib/server/request';

export const POST = publicApi(async (req: NextRequest) => {
  await logout(db(), req.cookies.get(SESSION_COOKIE_NAME)?.value, metaFromHeaders(req.headers));
  const res = NextResponse.redirect(new URL('/login?reason=logout', req.url), 303);
  res.cookies.delete(SESSION_COOKIE_NAME);
  return res;
});
