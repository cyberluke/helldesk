import { useMemo, useState } from 'react';
import { Search, Loader2, GitBranch } from '@/lib/icons';
import { cn } from '../../lib/utils';

export type RepositoryOption = {
  id: string;
  fullName: string;
  private: boolean;
  platform: 'github' | 'gitlab';
};

export function RepositoryCombobox({
  repositories,
  value,
  onValueChange,
  isLoading,
  placeholder,
  searchPlaceholder,
  groupByPlatform,
  hideLabel,
}: {
  repositories: RepositoryOption[];
  value: string;
  onValueChange: (v: string) => void;
  isLoading?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  groupByPlatform?: boolean;
  hideLabel?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repositories;
    return repositories.filter(r => r.fullName.toLowerCase().includes(q));
  }, [repositories, query]);

  const groups = useMemo(() => {
    if (!groupByPlatform) return [['all', filtered] as const];
    const g = new Map<'github' | 'gitlab', RepositoryOption[]>();
    for (const r of filtered) {
      const list = g.get(r.platform) ?? [];
      list.push(r);
      g.set(r.platform, list);
    }
    return Array.from(g.entries());
  }, [filtered, groupByPlatform]);

  return (
    <div className="relative">
      {!hideLabel && <label className="mb-1.5 block text-xs font-medium text-white/55">Repository</label>}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-white/[0.12] bg-white/[0.04] px-3 text-sm text-white/85 hover:border-white/[0.2] focus:outline-none focus:ring-1 focus:ring-white/20"
      >
        <span className="flex-1 truncate text-left">
          {value ? value.split('/').pop() : (placeholder ?? 'Select a repository…')}
        </span>
        <span className="text-white/40">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[85]" onClick={() => setOpen(false)} />
          <div className="absolute z-[86] mt-1 w-full overflow-hidden rounded-md border border-white/[0.12] bg-[color:oklch(0.16_0_0)] shadow-xl">
            <div className="flex items-center gap-2 border-b border-white/[0.08] px-2.5 py-1.5">
              <Search className="size-3.5 text-white/40" />
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={searchPlaceholder ?? 'Search…'}
                className="w-full bg-transparent text-sm text-white/85 placeholder:text-white/30 focus:outline-none"
              />
            </div>
            <div className="max-h-52 overflow-y-auto p-1">
              {isLoading && (
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-white/40">
                  <Loader2 className="size-3.5 animate-spin" /> Loading repositories…
                </div>
              )}
              {!isLoading && filtered.length === 0 && (
                <div className="px-2 py-2 text-xs text-white/40">No repositories found</div>
              )}
              {groups.map(([platform, repos]) => (
                <div key={String(platform)}>
                  {groupByPlatform && platform !== 'all' && (
                    <div className="px-2 py-1 text-[10px] font-semibold tracking-wide text-white/30 uppercase">
                      {platform}
                    </div>
                  )}
                  {repos.map(r => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        onValueChange(r.fullName);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.07]',
                        value === r.fullName ? 'bg-white/[0.06] text-white' : 'text-white/75'
                      )}
                    >
                      <GitBranch className="size-3.5 shrink-0 text-white/35" />
                      <span className="flex-1 truncate">{r.fullName}</span>
                      {r.private && (
                        <span className="shrink-0 rounded bg-white/[0.08] px-1.5 py-0.5 text-[9px] uppercase text-white/45">
                          private
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}