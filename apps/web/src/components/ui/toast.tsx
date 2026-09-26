'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

export interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info' | 'warning';
  message: string;
  action?: { label: string; href?: string; onClick?: () => void };
}

const Ctx = React.createContext<{ push: (t: Omit<Toast, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<Toast[]>([]);
  const push = React.useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.tone === 'error' ? 9000 : 4500);
  }, []);
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[380px] flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-lg border bg-surface px-3 py-2.5 text-sm shadow-pop',
              t.tone === 'error' && 'border-danger/40',
              t.tone === 'success' && 'border-success/40',
              t.tone === 'warning' && 'border-warning/40',
            )}
          >
            <span
              className={cn(
                'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                t.tone === 'error' ? 'bg-danger' : t.tone === 'success' ? 'bg-success' : t.tone === 'warning' ? 'bg-warning' : 'bg-primary',
              )}
            />
            <span className="flex-1">{t.message}</span>
            {t.action ? (
              t.action.href ? (
                <a href={t.action.href} className="shrink-0 text-xs font-medium text-primary hover:underline">
                  {t.action.label}
                </a>
              ) : (
                <button onClick={t.action.onClick} className="shrink-0 text-xs font-medium text-primary hover:underline">
                  {t.action.label}
                </button>
              )
            ) : null}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = React.useContext(Ctx);
  if (!c) throw new Error('ToastProvider 가 필요합니다');
  return c;
}

/** ApiError 를 토스트로 (다음 행동 링크 포함) */
export function useErrorToast() {
  const { push } = useToast();
  return React.useCallback(
    (e: unknown) => {
      const err = e as { message?: string; action?: { label: string; href: string } };
      push({ tone: 'error', message: err?.message ?? '요청을 처리하지 못했습니다.', action: err?.action });
    },
    [push],
  );
}
