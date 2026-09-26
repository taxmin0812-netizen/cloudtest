'use client';

import * as React from 'react';
import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { apiFetch } from '@/lib/client/api';

/** /api/search 응답 계약 */
export interface SearchGroup {
  key: string;
  label: string;
  items: Array<{ id: string; title: string; subtitle?: string; meta?: string; href: string }>;
}

/**
 * Ctrl+K 전역 검색 — 상호·사업자번호·대표자·거래처·금액·적요·직원·계정과목.
 * 예: "스타벅스" → 어느 거래처에서 몇 건, 어떤 계정으로, 얼마를 처리했는지.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [groups, setGroups] = React.useState<SearchGroup[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mintax:open-command', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mintax:open-command', onOpen);
    };
  }, []);

  React.useEffect(() => {
    if (!open || q.trim().length < 1) {
      setGroups([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await apiFetch<{ groups: SearchGroup[] }>(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        setGroups(r.groups);
      } catch {
        if (!ctrl.signal.aborted) setGroups([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-fg/20 pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <Command
        label="전역 검색"
        shouldFilter={false}
        className="w-[640px] overflow-hidden rounded-lg border border-border bg-surface shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 text-muted" />
          <Command.Input
            autoFocus
            value={q}
            onValueChange={setQ}
            placeholder="상호, 사업자번호, 거래처, 금액(예: 72300), 적요, 직원, 계정과목"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/70"
          />
          {loading ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-transparent" /> : null}
          <span className="kbd">Esc</span>
        </div>
        <Command.List className="max-h-[420px] overflow-y-auto p-1">
          {q.trim() && !loading && groups.every((g) => g.items.length === 0) ? (
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted">검색 결과가 없습니다.</Command.Empty>
          ) : null}
          {groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <Command.Group key={g.key} heading={g.label} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted">
                {g.items.map((it) => (
                  <Command.Item
                    key={`${g.key}:${it.id}`}
                    value={`${g.key}:${it.id}`}
                    onSelect={() => {
                      setOpen(false);
                      router.push(it.href);
                    }}
                    className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm aria-selected:bg-primary-soft aria-selected:text-primary"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{it.title}</div>
                      {it.subtitle ? <div className="truncate text-2xs text-muted">{it.subtitle}</div> : null}
                    </div>
                    {it.meta ? <div className="num shrink-0 font-mono text-xs text-muted">{it.meta}</div> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
        </Command.List>
      </Command>
    </div>
  );
}
