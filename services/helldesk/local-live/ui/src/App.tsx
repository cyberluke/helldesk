import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Outlet, Route, Routes, Navigate, NavLink, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { TerminalBarProvider } from '@/components/helldesk/TerminalBarContext'
import { DrawerStackProvider } from '@/components/helldesk/DrawerStack'
import { renderDrawerContent } from '@/components/helldesk/DrawerStackContent'
import { SidebarProvider } from '@/components/ui/sidebar'
import { HelldeskDepartmentSidebar } from '@/components/helldesk/HelldeskDepartmentSidebar'
import { TerminalBar } from '@/components/helldesk/TerminalBar'
import { engine } from './lib/engine'
import BreakRoomChat from './views/BreakRoomChat'
import BreakRoomExcellenceGovernor from './views/ExcellenceGovernor'
import EngineConfig from './views/Config'
import TaskStudio from './views/TaskStudio'
import Transcript from './views/Transcript'

// Verbatim HELLDESK client pages (federated from cyberluke/helldesk cloud source).
import { DepartmentListPageClient } from '../federated/src/app/(app)/helldesk/DepartmentListPageClient'
import { DepartmentOverviewPageClient } from '../federated/src/app/(app)/helldesk/departmentId/DepartmentOverviewPageClient'
import { DepartmentSettingsPageClient } from '../federated/src/app/(app)/helldesk/departmentId/settings/DepartmentSettingsPageClient'
import { MergesPageClient } from '../federated/src/app/(app)/helldesk/departmentId/merges/MergesPageClient'
import { TicketsPageClient } from '../federated/src/app/(app)/helldesk/departmentId/tickets/TicketsPageClient'
import { ObservabilityPageClient } from '../federated/src/app/(app)/helldesk/departmentId/observability/ObservabilityPageClient'
import { MemoPageClient } from '../federated/src/app/(app)/helldesk/departmentId/memo/MemoPageClient'
import { AgentsPageClient } from '../federated/src/app/(app)/helldesk/departmentId/agents/AgentsPageClient'
import { WorkstationDetailPageClient } from '../federated/src/app/(app)/helldesk/departmentId/workstations/workstationId/WorkstationDetailPageClient'

// TanStack Query client for the federated HELLDESK UI.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5000, refetchOnWindowFocus: false, retry: 1 },
  },
})

/** Route-bound page: reads :departmentId from the path and hands it to the original component. */
function DepartmentOverviewRoute() {
  const { departmentId = '' } = useParams()
  return <DepartmentOverviewPageClient departmentId={departmentId} />
}
function DepartmentSettingsRoute() {
  const { departmentId = '' } = useParams()
  return <DepartmentSettingsPageClient departmentId={departmentId} />
}
function DepartmentMergesRoute() {
  const { departmentId = '' } = useParams()
  return <MergesPageClient departmentId={departmentId} />
}
function DepartmentTicketsRoute() {
  const { departmentId = '' } = useParams()
  return <TicketsPageClient departmentId={departmentId} />
}
function DepartmentObsRoute() {
  const { departmentId = '' } = useParams()
  return <ObservabilityPageClient departmentId={departmentId} />
}
function DepartmentMemoRoute() {
  const { departmentId = '' } = useParams()
  return <MemoPageClient departmentId={departmentId} />
}
function DepartmentAgentsRoute() {
  const { departmentId = '' } = useParams()
  return <AgentsPageClient departmentId={departmentId} />
}
function DepartmentWorkstationRoute() {
  const { departmentId = '', workstationId = '' } = useParams()
  return <WorkstationDetailPageClient departmentId={departmentId} workstationId={workstationId} />
}

/** Original helldesk landing page (department list) with a top-right engine status. */
function HelldeskLanding() {
  return (
    <div className="min-h-screen bg-[oklch(0.1_0_0)] text-white">
      <DepartmentListPageClient />
      <Toaster position="bottom-right" theme="dark" />
    </div>
  )
}

/**
 * Department shell — replicates the original `departmentId/layout.tsx` (TerminalBarProvider +
 * DrawerStackProvider + FrontDeskTerminalBar) and adds the left HELLDESK sidebar, so the
 * verbatim original pages compose exactly as in the cloud app.
 */
function DepartmentShell() {
  const { departmentId = '' } = useParams()
  const [online, setOnline] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const ping = async () => {
      const h = await engine.health()
      if (alive) setOnline(h)
    }
    ping()
    const t = setInterval(ping, 8000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  return (
    <div className="flex min-h-screen bg-[oklch(0.1_0_0)] text-white">
      <SidebarProvider>
        <div className="hidden md:block">
          <HelldeskDepartmentSidebar departmentId={departmentId} />
        </div>
        <div className="min-w-0 flex-1">
          <header className="mission-topbar">
            <div className="mission-wordmark">NAI <span>HELLDESK</span></div>
            <nav aria-label="Mission navigation">
              <NavLink to={`/helldesk/${departmentId}/studio`}>Task Studio</NavLink>
              <NavLink to={`/helldesk/${departmentId}/tickets`}>Kanban</NavLink>
              <NavLink to={`/helldesk/${departmentId}/chat`}>Operator-console</NavLink>
              <NavLink to={`/helldesk/${departmentId}/transcript`}>Transcript</NavLink>
              <NavLink to={`/helldesk/${departmentId}/config`}>Connections</NavLink>
            </nav>
            <span className="mission-connection" data-state={online===null?'connecting':online?'online':'offline'}><i/>{online===null?'Connecting':online?'Engine reachable':'Engine unavailable'}</span>
          </header>
          <TerminalBarProvider>
            <DrawerStackProvider renderContent={renderDrawerContent}>
              <div className="flex min-h-screen flex-col pb-[340px]">
                <div className="flex-1">
                  <Outlet />
                </div>
              </div>
              <TerminalBar departmentId={departmentId} />
            </DrawerStackProvider>
          </TerminalBarProvider>
        </div>
      </SidebarProvider>
      <Toaster position="bottom-right" theme="dark" />
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/helldesk" replace />} />
          <Route path="/helldesk" element={<HelldeskLanding />} />
          <Route path="/helldesk/:departmentId" element={<DepartmentShell />}>
            <Route index element={<DepartmentOverviewRoute />} />
            <Route path="tickets" element={<DepartmentTicketsRoute />} />
            <Route path="agents" element={<DepartmentAgentsRoute />} />
            <Route path="merges" element={<DepartmentMergesRoute />} />
            <Route path="memo" element={<DepartmentMemoRoute />} />
            <Route path="observability" element={<DepartmentObsRoute />} />
            <Route path="settings" element={<DepartmentSettingsRoute />} />
            <Route path="workstations/:workstationId" element={<DepartmentWorkstationRoute />} />
            <Route path="chat" element={<BreakRoomChat />} />
            <Route path="transcript" element={<Transcript />} />
            <Route path="studio" element={<TaskStudio />} />
            <Route path="excellenceGovernor" element={<BreakRoomExcellenceGovernor />} />
            <Route path="config" element={<EngineConfig />} />
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
