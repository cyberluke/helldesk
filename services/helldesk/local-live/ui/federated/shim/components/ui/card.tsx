import { type ReactNode, type HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn('rounded-xl border border-white/[0.08] bg-white/[0.03] text-white', className)} {...rest}>
      {children}
    </div>
  );
}
export function CardContent({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn('p-4', className)} {...rest}>
      {children}
    </div>
  );
}
export function CardHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn('border-b border-white/[0.06] p-4', className)} {...rest}>
      {children}
    </div>
  );
}
export function CardTitle({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn('text-base font-semibold text-white/90', className)} {...rest}>
      {children}
    </div>
  );
}
export function CardDescription({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn('mt-1 text-xs text-white/50', className)} {...rest}>
      {children}
    </div>
  );
}