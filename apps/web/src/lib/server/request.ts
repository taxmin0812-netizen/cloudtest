import 'server-only';
import { headers } from 'next/headers';

/** 프록시 뒤에서도 클라이언트 IP 를 얻는다 (첫 번째 X-Forwarded-For). TRUST_PROXY=false 면 무시 */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return metaFromHeaders(h);
}

export function metaFromHeaders(h: Headers): { ip: string | null; userAgent: string | null } {
  const trustProxy = process.env.TRUST_PROXY !== 'false';
  const xff = trustProxy ? h.get('x-forwarded-for')?.split(',')[0]?.trim() : null;
  const ip = xff || h.get('x-real-ip') || null;
  return { ip, userAgent: h.get('user-agent')?.slice(0, 512) ?? null };
}
