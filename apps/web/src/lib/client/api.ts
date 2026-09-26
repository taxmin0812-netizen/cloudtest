'use client';

/** 클라이언트 → Route handler 호출. 오류는 사용자 메시지와 다음 행동(action)을 담은 ApiError 로 던진다. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly action?: { label: string; href: string },
    readonly errorId?: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 401 && typeof window !== 'undefined' && !url.startsWith('/api/auth/')) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    window.location.href = `/login?reason=expired&next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new ApiError(body?.error?.message ?? '로그인이 필요합니다.', 401);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string; action?: { label: string; href: string }; errorId?: string } } | null;
    const e = body?.error;
    throw new ApiError(
      e?.message ?? (res.status >= 500 ? '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' : '요청을 처리할 수 없습니다.'),
      res.status,
      e?.code,
      e?.action,
      e?.errorId,
    );
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.blob()) as T;
}

/** 파일 다운로드 (서버가 Content-Disposition 으로 파일명 제공) */
export async function downloadFile(url: string, fallbackName = 'download.xlsx'): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string; action?: { label: string; href: string } } } | null;
    throw new ApiError(body?.error?.message ?? '파일을 내려받지 못했습니다.', res.status, undefined, body?.error?.action);
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const name = m ? decodeURIComponent(m[1]!) : fallbackName;
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
