import { cn } from '../../lib/utils';

export function Skeleton({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-white/[0.06]', className)} {...rest} />;
}