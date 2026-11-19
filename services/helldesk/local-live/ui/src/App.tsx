import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Outlet, Route, Routes, Navigate, useParams } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TerminalBarProvider } from '@/components/helldesk/TerminalBarContext'
import { DrawerStackProvider } from '@/components/helldesk/DrawerStack'
import { renderDrawerContent } from '@/components/helldesk/DrawerStackContent'
import { SidebarProvider } from '@/components/ui/sidebar'
import { HelldeskDepartmentSidebar } from '@/components/helldesk/HelldeskDepartmentSidebar'
import { TerminalBar } from '@/components/helldesk/TerminalBar'
import BreakRoomChat from './views/BreakRoomChat'
import BreakRoomExcellenceGovernor from './views/ExcellenceGovernor'
import EngineConfig from './views/Config'
import TaskStudio from './views/TaskStudio'
import Transcript from './views/Transcript'
import Observability from './views/Observability'

// Verbatim HELLDESK client pages (federated from cyberluke/helldesk cloud source).
import { DepartmentListPageClient } from '../federated/src/app/(app)/helldesk/DepartmentListPageClient'
import { DepartmentOverviewPageClient } from '../federated/src/app/(app)/helldesk/departmentId/DepartmentOverviewPageClient'
import { DepartmentSettingsPageClient } from '../federated/src/app/(app)/helldesk/departmentId/settings/DepartmentSettingsPageClient'
import { MergesPageClient } from '../federated/src/app/(app)/helldesk/departmentId/merges/MergesPageClient'
import { TicketsPageClient } from '../federated/src/app/(app)/helldesk/departmentId/tickets/TicketsPageClient'
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

  return (
    <div className="flex h-dvh overflow-hidden bg-[oklch(0.1_0_0)] text-white">
      <SidebarProvider>
        <div className="hidden h-dvh md:block">
          <HelldeskDepartmentSidebar departmentId={departmentId} />
        </div>
        <div className="flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
          <TerminalBarProvider>
            <DrawerStackProvider renderContent={renderDrawerContent}>
              <main className="min-h-0 flex-1 overflow-auto pb-[38px] [scrollbar-color:rgba(167,139,250,.28)_transparent] [scrollbar-width:thin]">
                <Outlet />
              </main>
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
            <Route path="observability" element={<Observability />} />
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
