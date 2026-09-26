import { createContext, getCurrentPeriod, getNavBadges, getNotificationCounts } from '@mintax/server';
import { AppShell } from '@/components/shell/app-shell';
import { CommandPalette } from '@/components/search/command-palette';
import { ToastProvider } from '@/components/ui/toast';
import { db } from '@/lib/server/runtime';
import { requireSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSession();
  const ctx = createContext(db(), s.actor);
  const period = await getCurrentPeriod(ctx);
  const [badges, counts] = await Promise.all([
    getNavBadges(ctx, period).catch(() => ({})),
    getNotificationCounts(ctx, { skipPermission: true }).catch(() => null),
  ]);
  return (
    <ToastProvider>
      <AppShell
        user={{ id: s.user.id, name: s.user.name, role: s.user.role, permissions: s.user.permissions }}
        period={period}
        badges={badges as unknown as Record<string, number>}
        problemCount={(counts as { unresolved?: number } | null)?.unresolved ?? 0}
        commandPalette={<CommandPalette />}
        topRight={
          s.mustEnrollMfa ? (
            <a href="/account/mfa?required=1" className="rounded bg-warning-soft px-2 py-1 text-xs font-medium text-warning">
              관리자 MFA 등록 필요
            </a>
          ) : null
        }
      >
        {children}
      </AppShell>
    </ToastProvider>
  );
}
