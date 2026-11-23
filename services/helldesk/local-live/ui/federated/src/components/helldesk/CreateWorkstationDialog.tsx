'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/Button';
import { toast } from 'sonner';

type CreateWorkstationDialogProps = {
  departmentId: string;
  isOpen: boolean;
  onClose: () => void;
};

export function CreateWorkstationDialog({ departmentId, isOpen, onClose }: CreateWorkstationDialogProps) {
  const [name, setName] = useState('');
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const createWorkstation = useMutation(
    trpc.helldesk.createWorkstation.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.helldesk.listWorkstations.queryKey() });
        toast.success('Workstation created');
        setName('');
        onClose();
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    createWorkstation.mutate({ departmentId, name: trimmed });
  };

  const canSubmit = !!name.trim() && !createWorkstation.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle>Create Workstation</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-white/70">Workstation Name</label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="my-project"
                autoFocus
                maxLength={64}
                className="border-white/10 bg-black/25"
              />
            </div>
            <p className="text-xs text-white/40">
              A workstation is the crew&apos;s execution seat. Task Studio routes each task to its
              workspace path, so no repository is needed here.
            </p>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              type="submit"
              disabled={!canSubmit}
              className="bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              {createWorkstation.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
