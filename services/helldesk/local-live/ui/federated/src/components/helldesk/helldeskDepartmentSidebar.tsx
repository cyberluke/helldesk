'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
} from '@/components/ui/sidebar';
import {
  ArrowLeft,
  LayoutDashboard,
  Hexagon,
  Bot,
  GitMerge,
  Memo,
  Activity,
  Settings,
  SlidersHorizontal,
  Crown,
  Sparkles,
} from '@/lib/icons';
import { motion, AnimatePresence } from 'motion/react';

type HelldeskDepartmentSidebarProps = {
  departmentId: string;
} & React.ComponentProps<typeof Sidebar>;

export function HelldeskDepartmentSidebar({ departmentId, ...sidebarProps }: HelldeskDepartmentSidebarProps) {
  const pathname = usePathname();
  const trpc = useTRPC();

  const departmentQuery = useQuery(trpc.helldesk.getDepartment.queryOptions({ departmentId }));
  const workstationsQuery = useQuery(trpc.helldesk.listWorkstations.queryOptions({ departmentId }));

  const departmentName = departmentQuery.data?.name ?? 'Department';
  const workstations = workstationsQuery.data ?? [];

  const basePath = `/helldesk/${departmentId}`;

  const isActive = (path: string) => {
    if (path === basePath) return pathname === basePath;
    return pathname.startsWith(path);
  };

  const navItems = [
    { title: 'Overview', icon: LayoutDashboard, url: basePath },
    { title: 'Operator-console', icon: GitMerge, url: `${basePath}/chat` },
    { title: 'Task Studio', icon: Sparkles, url: `${basePath}/studio` },
    { title: 'ExcellenceGovernor', icon: Activity, url: `${basePath}/excellenceGovernor` },
    { title: 'Kanban', icon: Hexagon, url: `${basePath}/tickets` },
    { title: 'Agents', icon: Bot, url: `${basePath}/agents` },
    { title: 'Merge Queue', icon: GitMerge, url: `${basePath}/merges` },
    { title: 'Memo', icon: Memo, url: `${basePath}/memo` },
    { title: 'Observability', icon: Activity, url: `${basePath}/observability` },
    { title: 'Config', icon: SlidersHorizontal, url: `${basePath}/config` },
  ];

  return (
    <Sidebar {...sidebarProps}>
      <SidebarHeader className="p-3">
        <div className="flex flex-col gap-3">
          {/* Back link */}
          <Link
            href="/helldesk"
            prefetch={false}
            className="group/back inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-white/45 transition-colors hover:bg-white/5 hover:text-white/75"
          >
            <ArrowLeft className="size-3 transition-transform group-hover/back:-translate-x-0.5" />
            All departments
          </Link>

          {/* Department identity */}
          <div className="flex items-center gap-2.5 px-1">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[color:oklch(95%_0.15_108_/_0.15)] ring-1 ring-[color:oklch(95%_0.15_108_/_0.25)]">
              <Crown className="size-4 text-[color:oklch(95%_0.15_108)]" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white/90">{departmentName}</div>
              <div className="flex items-center gap-1.5 text-[10px] text-white/40">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                Live
              </div>
            </div>
          </div>
        </div>
      </SidebarHeader>

      <div className="mx-3 border-b border-white/[0.08]" />

      <SidebarContent>
        {/* Primary navigation */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Navigation
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item, i) => (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.2 }}
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={isActive(item.url)}>
                      <Link href={item.url} prefetch={false}>
                        <item.icon className="size-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </motion.div>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Workstations section */}
        {workstations.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
              Workstations
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <AnimatePresence initial={false}>
                  {workstations.map((workstation, i) => {
                    const workstationPath = `${basePath}/workstations/${workstation.id}`;
                    return (
                      <motion.div
                        key={workstation.id}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ delay: i * 0.03, duration: 0.2 }}
                      >
                        <SidebarMenuItem>
                          <SidebarMenuButton asChild isActive={isActive(workstationPath)}>
                            <Link href={workstationPath} prefetch={false}>
                              <div className="flex size-4 items-center justify-center rounded bg-white/[0.06] text-[9px] font-bold text-white/50">
                                {workstation.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="truncate">{workstation.name}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isActive(`${basePath}/settings`)}>
              <Link href={`${basePath}/settings`} prefetch={false}>
                <Settings className="size-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
