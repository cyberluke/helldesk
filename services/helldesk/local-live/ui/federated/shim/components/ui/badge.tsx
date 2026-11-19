import { type ReactNode } from 'react';
import { cn } from '../../lib/utils';

type BadgeVariant = 'outline' | 'secondary' | 'beta' | 'default';

export function Badge({
  variant = 'outline',
  className,
  children,
}: {
  variant?: BadgeVariant;
  className?: string;
  children?: ReactNode;
}) {
  const styles: Record<BadgeVariant, string> = {
    default: 'bg-white/[0.08] text-white/80 border border-white/10',
    outline: 'border border-white/[0.15] text-white/60',
    secondary: 'bg-white/[0.05] text-white/70',
    beta: 'border border-amber-400/30 bg-amber-400/10 text-amber-300',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium', styles[variant], className)}>
      {children}
    </span>
  );
}