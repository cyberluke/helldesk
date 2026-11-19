import { type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Original `@/components/layouts/PageContainer` — typically a max-width wrapper
 * with consistent vertical/horizontal padding that sits under the app shell.
 */
export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-6xl px-5 py-6 md:px-7', className)}>{children}</div>
  );
}