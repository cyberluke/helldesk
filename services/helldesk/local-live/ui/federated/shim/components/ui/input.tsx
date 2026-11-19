import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, type, ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      type={type ?? 'text'}
      className={cn(
        'h-9 w-full rounded-md border border-white/[0.12] bg-white/[0.04] px-3 text-sm text-white/90 placeholder:text-white/25 focus:border-white/25 focus:outline-none focus:ring-1 focus:ring-white/20',
        className
      )}
      {...rest}
    />
  );
});