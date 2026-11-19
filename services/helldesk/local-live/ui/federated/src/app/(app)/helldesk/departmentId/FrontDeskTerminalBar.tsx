'use client';

import { use } from 'react';
import { TerminalBar } from '@/components/helldesk/TerminalBar';

export function FrontDeskTerminalBar({ params }: { params: Promise<{ departmentId: string }> }) {
  const { departmentId } = use(params);
  return <TerminalBar departmentId={departmentId} />;
}
