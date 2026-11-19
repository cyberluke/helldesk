import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'min-h-[80px] w-full rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:border-white/25 focus:outline-none focus:ring-1 focus:ring-white/20',
          className
        )}
        {...rest}
      />
    );
  }
);