import { type ReactNode, type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../lib/utils';

type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type ButtonSize = 'md' | 'sm' | 'icon' | 'lg' | 'xs';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
  children?: ReactNode;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]',
  secondary: 'bg-white/[0.08] text-white/85 hover:bg-white/[0.14] border border-white/10',
  outline: 'border border-white/[0.15] text-white/70 hover:bg-white/[0.05] hover:text-white/90',
  ghost: 'text-white/60 hover:bg-white/[0.05] hover:text-white/85',
  destructive: 'bg-red-500/15 text-red-300 hover:bg-red-500/25 border border-red-500/20',
};

const sizes: Record<ButtonSize, string> = {
  md: 'h-9 px-4 text-sm',
  sm: 'h-8 px-3 text-xs',
  xs: 'h-6 px-2 text-[11px]',
  icon: 'size-9',
  lg: 'h-10 px-5 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', asChild, className, children, type, ...rest },
  ref
) {
  const cls = cn(
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    className
  );
  return (
    <button ref={ref} type={type ?? 'button'} className={cls} {...rest}>
      {children}
    </button>
  );
});