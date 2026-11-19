import { forwardRef, type LabelHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(function Label(
  { className, children, ...rest },
  ref
) {
  return (
    <label ref={ref} className={cn('text-sm font-medium text-white/80', className)} {...rest}>
      {children}
    </label>
  );
});