import * as React from 'react';
import { cn } from '@/lib/cn';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'outline';

const tones: Record<Tone, string> = {
  neutral: 'bg-subtle text-muted',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  outline: 'border border-border text-muted',
};

export function Badge({ tone = 'neutral', className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded px-1.5 text-2xs font-medium', tones[tone], className)}
      {...props}
    />
  );
}

/** 통합 상태 배지 — 환각 방지: 실제 상태를 그대로 표시 */
export function IntegrationBadge({ status }: { status: 'LIVE' | 'FILE_BASED' | 'RPA' | 'MOCK' | 'NOT_AVAILABLE' }) {
  const map = {
    LIVE: { tone: 'success', label: 'LIVE' },
    FILE_BASED: { tone: 'primary', label: 'FILE BASED' },
    RPA: { tone: 'warning', label: 'RPA' },
    MOCK: { tone: 'warning', label: 'MOCK' },
    NOT_AVAILABLE: { tone: 'neutral', label: 'NOT AVAILABLE' },
  } as const;
  const m = map[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

/** 신뢰도 표시 — 95+ 초록, 80+ 주황, 그 외 빨강 (정책값을 받아서 판단) */
export function ConfidencePill({ value, auto = 95, quick = 80 }: { value: number | null | undefined; auto?: number; quick?: number }) {
  if (value === null || value === undefined) return <span className="text-2xs text-muted">-</span>;
  const tone = value >= auto ? 'text-success' : value >= quick ? 'text-warning' : 'text-danger';
  return <span className={cn('num font-mono text-xs font-semibold', tone)}>{value}%</span>;
}
