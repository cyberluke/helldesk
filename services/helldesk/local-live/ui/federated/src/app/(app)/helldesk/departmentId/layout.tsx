import { TerminalBarProvider } from '@/components/helldesk/TerminalBarContext';
import { DrawerStackProvider } from '@/components/helldesk/DrawerStack';
import { renderDrawerContent } from '@/components/helldesk/DrawerStackContent';
import { FrontDeskTerminalBar } from './FrontDeskTerminalBar';

export default function DepartmentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ departmentId: string }>;
}) {
  return (
    <TerminalBarProvider>
      <DrawerStackProvider renderContent={renderDrawerContent}>
        {/* Fullscreen edge-to-edge layout for helldesk department pages.
            Bottom padding clears the fixed terminal bar. */}
        <div className="flex min-h-screen flex-col pb-[340px]">
          <div className="flex-1">{children}</div>
        </div>
        <FrontDeskTerminalBar params={params} />
      </DrawerStackProvider>
    </TerminalBarProvider>
  );
}
