'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/cn';
import { NAV_SECTIONS } from './nav';

export interface ShellUser {
  id: string;
  name: string;
  role: string;
  permissions: string[];
}

export interface ShellProps {
  user: ShellUser;
  period: string; // YYYY-MM
  badges: Record<string, number>;
  /** 문제 알림만 (정상처리 알림 없음) */
  problemCount: number;
  children: React.ReactNode;
  /** Ctrl+K 팔레트 (클라이언트 컴포넌트 주입) */
  commandPalette?: React.ReactNode;
  topRight?: React.ReactNode;
}

function Icon({ name, className }: { name: string; className?: string }) {
  const C = (Icons as unknown as Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>>)[name] ?? Icons.Circle;
  return <C className={className} strokeWidth={1.75} />;
}

export function AppShell({ user, period, badges, problemCount, children, commandPalette, topRight }: ShellProps) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-[216px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-12 items-center gap-2 border-b border-border px-4">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-navy text-[11px] font-bold text-white">M</div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-tight">MIN TAX OPS</div>
            <div className="text-2xs text-muted">세무회계 민</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="주 메뉴">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title} className="mb-3">
              <div className="px-2 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-muted/80">{section.title}</div>
              {section.items
                .filter((i) => !i.permission || user.permissions.includes(i.permission))
                .map((item) => {
                  const n = item.badgeKey ? badges[item.badgeKey] ?? 0 : 0;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'group flex h-8 items-center gap-2 rounded px-2 text-[13px] transition-colors',
                        isActive(item.href) ? 'bg-primary-soft font-medium text-primary' : 'text-fg/80 hover:bg-subtle hover:text-fg',
                      )}
                    >
                      <Icon name={item.icon} className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {n > 0 ? (
                        <span className="num rounded bg-subtle px-1.5 font-mono text-2xs text-muted group-hover:bg-surface">{n.toLocaleString('ko-KR')}</span>
                      ) : null}
                    </Link>
                  );
                })}
            </div>
          ))}
        </nav>
        <div className="border-t border-border px-3 py-2 text-xs">
          <div className="font-medium">{user.name}</div>
          <div className="flex items-center justify-between text-2xs text-muted">
            <span>{roleLabel(user.role)}</span>
            <form action="/api/auth/logout" method="post">
              <button className="hover:text-fg" type="submit">로그아웃</button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
          <button
            type="button"
            data-command-trigger
            onClick={() => window.dispatchEvent(new CustomEvent('mintax:open-command'))}
            className="flex h-8 w-[360px] items-center gap-2 rounded border border-border bg-subtle px-2.5 text-sm text-muted hover:border-primary/40"
          >
            <Icons.Search className="h-4 w-4" />
            <span className="flex-1 text-left">상호·사업자번호·거래처·금액·직원 검색</span>
            <span className="kbd">Ctrl K</span>
          </button>
          <div className="ml-auto flex items-center gap-3">
            <span className="rounded border border-border px-2 py-1 font-mono text-xs text-muted" title="업무 기준월">
              {period}
            </span>
            {topRight}
            <Link
              href="/notifications"
              className="relative flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-subtle hover:text-fg"
              aria-label={problemCount > 0 ? `문제 알림 ${problemCount}건` : '문제 알림 없음'}
            >
              <Icons.Bell className="h-4 w-4" />
              {problemCount > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
                  {problemCount > 99 ? '99+' : problemCount}
                </span>
              ) : null}
            </Link>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      {commandPalette}
    </div>
  );
}

function roleLabel(role: string): string {
  return ({ admin: '관리자', manager: '매니저', staff: '담당자', viewer: '조회전용' } as Record<string, string>)[role] ?? role;
}
