'use client';

import type { ReactNode } from 'react';
import type { ResourceRef } from './DrawerStack';
import { TicketPanel } from './drawer-panels/TicketPanel';
import { AgentPanel } from './drawer-panels/AgentPanel';
import { EventPanel } from './drawer-panels/EventPanel';

/**
 * Dispatch function that maps a ResourceRef to the right panel component.
 * Passed as `renderContent` to DrawerStackProvider.
 */
export function renderDrawerContent(
  resource: ResourceRef,
  helpers: { push: (ref: ResourceRef) => void; close: () => void }
): ReactNode {
  switch (resource.type) {
    case 'ticket':
      return (
    <TicketPanel
      ticketId={resource.ticketId}
      workstationId={resource.workstationId}
      departmentId={resource.departmentId}
      push={helpers.push}
    />
  );
    case 'agent':
      return (
        <AgentPanel
          agentId={resource.agentId}
          workstationId={resource.workstationId}
          departmentId={resource.departmentId}
          push={helpers.push}
          close={helpers.close}
        />
      );
    case 'event':
      return <EventPanel event={resource.event} push={helpers.push} />;
  }
}
