import * as React from 'react';
import { cn } from '@/lib/cn';

/** 페이지 헤더: 제목 + 한 줄 설명 + 우측 액션. 여백 최소화. */
export function PageHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-end justify-between gap-4 border-b border-border bg-surface px-6 py-3', className)}>
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold text-fg">{title}</h1>
        {description ? <p className="mt-0.5 truncate text-xs text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({ title, actions, children, className }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface', className)}>
      {title || actions ? (
        <div className="flex h-10 items-center justify-between border-b border-border px-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** 핵심 지표 — 숫자 크게, 라벨 작게. 클릭 가능하면 href. */
export function Metric({ label, value, sub, tone, href }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger'; href?: string }) {
  const toneCls = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-fg';
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className={cn('mt-1 font-mono text-[22px] font-semibold leading-7 tracking-tight', toneCls)}>{value}</div>
      {sub ? <div className="mt-0.5 text-2xs text-muted">{sub}</div> : null}
    </>
  );
  return href ? (
    <a href={href} className="block px-4 py-3 transition-colors hover:bg-subtle">{body}</a>
  ) : (
    <div className="px-4 py-3">{body}</div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      {description ? <div className="max-w-md text-xs text-muted">{description}</div> : null}
      {action}
    </div>
  );
}

/** 사용자 친화 오류 — 다음 행동까지 제시 (500 문구 금지) */
export function ErrorCallout({ message, action }: { message: string; action?: { label: string; href: string } }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
      <span>{message}</span>
      {action ? (
        <a href={action.href} className="shrink-0 rounded bg-danger px-2 py-1 text-xs font-medium text-white hover:bg-danger/90">
          {action.label}
        </a>
      ) : null}
    </div>
  );
}
