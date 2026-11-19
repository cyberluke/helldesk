import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Lightweight shadcn-style Select (radix-like API) backing the original HELLDESK
 * components. Controlled via `value`/`onValueChange`.
 *
 * `SelectTrigger` toggles the popover and renders `SelectValue` (which resolves
 * the label of the current value from registered items). `SelectContent` renders
 * `SelectItem`s; picking one calls the root `onValueChange`.
 */
type SelectCtx = {
  value: string;
  select: (v: string) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  register: (value: string, label: string) => void;
  labelFor: (v: string) => string | undefined;
};

const Ctx = createContext<SelectCtx | null>(null);
function useSelectCtx(): SelectCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('Select item must be inside a Select');
  return c;
}

export function Select({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState<Record<string, string>>({});

  const ctx = useMemo<SelectCtx>(
    () => ({
      value,
      select: (v) => {
        onValueChange(v);
        setOpen(false);
      },
      open,
      setOpen,
      register: (v, label) =>
        setLabels((prev) => (prev[v] === label ? prev : { ...prev, [v]: label })),
      labelFor: (v) => labels[v],
    }),
    [value, onValueChange, open, labels]
  );

  return (
    <Ctx.Provider value={ctx}>
      <div className={cn('relative', className)}>{children}</div>
    </Ctx.Provider>
  );
}

export function SelectTrigger({ children, className }: { children?: ReactNode; className?: string }) {
  const { setOpen, open } = useSelectCtx();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
      aria-haspopup="listbox"
      aria-expanded={open}
      className={cn(
        'flex h-9 w-full items-center justify-between rounded-md border border-white/[0.12] bg-white/[0.04] px-3 text-sm text-white/90 focus:border-white/25 focus:outline-none',
        className
      )}
    >
      <span className="flex-1 truncate text-left">{children}</span>
      <span className="ml-2 text-white/40">▾</span>
    </button>
  );
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  const { value, labelFor } = useSelectCtx();
  const label = labelFor(value);
  return <>{label ?? placeholder ?? 'Select…'}</>;
}

export function SelectContent({ children, className }: { children: ReactNode; className?: string }) {
  const { open, setOpen } = useSelectCtx();
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} />
      <div
        role="listbox"
        className={cn(
          'absolute z-[91] mt-1 max-h-60 w-full overflow-auto rounded-md border border-white/[0.12] bg-[color:oklch(0.16_0_0)] p-1 shadow-xl',
          className
        )}
      >
        {children}
      </div>
    </>
  );
}

export function SelectItem({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const { select, register, value: current } = useSelectCtx();
  const label = typeof children === 'string' ? children : String(value);
  register(value, label);
  return (
    <div
      role="option"
      aria-selected={current === value}
      onClick={(e) => {
        e.stopPropagation();
        select(value);
      }}
      className={cn(
        'cursor-pointer rounded px-2.5 py-1.5 text-sm text-white/80 hover:bg-white/[0.08]',
        current === value && 'bg-white/[0.06] text-white',
        className
      )}
    >
      {children}
    </div>
  );
}