import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import { X } from '@/lib/icons';

/**
 * Shared lightweight modal used by the Dialog + Sheet shims. Renders a portal
 * overlay with Escape / backdrop close.
 */
export function Modal({
  open,
  onOpenChange,
  placement = 'center',
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  placement?: 'center' | 'right' | 'bottom';
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  const placements = {
    center: 'left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
    right: 'right-0 top-0 h-full w-full max-w-md',
    bottom: 'bottom-0 left-0 right-0',
  };

  return createPortal(
    <div className="fixed inset-0 z-[80]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => onOpenChange(false)} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'absolute flex flex-col rounded-xl border border-white/[0.1] bg-[color:oklch(0.15_0_0)] text-white shadow-2xl',
          placements[placement],
          className
        )}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export function ModalClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className="absolute right-3 top-3 rounded p-1 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80"
      aria-label="Close"
    >
      <X className="size-4" />
    </button>
  );
}