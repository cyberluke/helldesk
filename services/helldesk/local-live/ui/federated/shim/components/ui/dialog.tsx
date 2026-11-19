import { type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Modal, ModalClose } from './_modal';

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} placement="center">
      {children}
    </Modal>
  );
}

export function DialogContent({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('relative max-h-[85vh] overflow-y-auto p-6', className)}>
      {children}
    </div>
  );
}

export function DialogHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-4 border-b border-white/[0.06] pb-3', className)}>
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function DialogTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h2 className={cn('text-lg font-semibold text-white/90', className)}>{children}</h2>;
}

export function DialogDescription({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('mt-1 text-sm text-white/50', className)}>{children}</p>;
}

export function DialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('mt-6 flex items-center justify-end gap-2 border-t border-white/[0.06] pt-4', className)}>
      {children}
    </div>
  );
}