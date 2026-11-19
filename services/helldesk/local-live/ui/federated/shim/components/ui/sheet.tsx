import { type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Modal } from './_modal';

export function Sheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} placement="right">
      {children}
    </Modal>
  );
}

export function SheetContent({
  side = 'right',
  className,
  children,
}: {
  side?: 'right' | 'left' | 'top' | 'bottom';
  className?: string;
  children: ReactNode;
}) {
  const sideCls = {
    right: 'ml-8',
    left: 'mr-8',
    top: 'mt-8',
    bottom: 'mb-8',
  }[side];
  return <div className={cn('flex h-full flex-col overflow-y-auto p-5', sideCls, className)}>{children}</div>;
}

export function SheetHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('mb-4 border-b border-white/[0.06] pb-3', className)}>{children}</div>
  );
}

export function SheetTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h2 className={cn('text-lg font-semibold text-white/90', className)}>{children}</h2>;
}

export function SheetDescription({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('mt-1 text-sm text-white/50', className)}>{children}</p>;
}

export function SheetClose({ children }: { children: ReactNode }) {
  return <>{children}</>;
}