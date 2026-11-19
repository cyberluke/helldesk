import {
  createContext,
  useContext,
  useState,
  type ReactNode,
  type ElementType,
  type ComponentProps,
} from 'react';
import { cn } from '../../lib/utils';

/**
 * Lightweight shadcn/ui sidebar shim (Backing the verbatim original HELLDESK UI).
 * Provides the `SidebarProvider` + `useSidebar` context and the structural
 * sub-components (Sidebar, SidebarHeader, SidebarContent, SidebarFooter,
 * SidebarGroup, SidebarGroupLabel, SidebarGroupContent, SidebarMenu,
 * SidebarMenuItem, SidebarMenuButton).
 */
type SidebarContextValue = {
  state: 'expanded' | 'collapsed';
  isMobile: boolean;
  open: boolean;
  setOpen: (o: boolean) => void;
};
const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const c = useContext(SidebarContext);
  if (!c) throw new Error('useSidebar must be used within <SidebarProvider>');
  return c;
}

export function SidebarProvider({
  children,
  defaultOpen = true,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const value: SidebarContextValue = {
    state: open ? 'expanded' : 'collapsed',
    isMobile: false,
    open,
    setOpen,
  };
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

type SidebarProps = {
  side?: 'left' | 'right';
  collapsible?: 'icon' | 'offcanvas' | 'none';
  className?: string;
  children?: ReactNode;
} & ComponentProps<'aside'>;

export function Sidebar({ side = 'left', collapsible = 'none', className, children, ...rest }: SidebarProps) {
  return (
    <aside
      data-slot="sidebar"
      data-side={side}
      className={cn(
        'flex h-full w-64 shrink-0 flex-col border-r border-white/[0.08] bg-black/30',
        className
      )}
      {...rest}
    >
      {children}
    </aside>
  );
}

export function SidebarHeader({ className, children, ...rest }: ComponentProps<'div'> & { children?: ReactNode }) {
  return (
    <div className={cn('p-2', className)} {...rest}>
      {children}
    </div>
  );
}

export function SidebarContent({ className, children, ...rest }: ComponentProps<'div'> & { children?: ReactNode }) {
  return (
    <div className={cn('flex-1 overflow-y-auto px-3 py-2', className)} {...rest}>
      {children}
    </div>
  );
}

export function SidebarFooter({ className, children, ...rest }: ComponentProps<'div'> & { children?: ReactNode }) {
  return (
    <div className={cn('border-t border-white/[0.08] p-2', className)} {...rest}>
      {children}
    </div>
  );
}

export function SidebarGroup({ className, children, ...rest }: ComponentProps<'div'> & { children?: ReactNode }) {
  return (
    <div className={cn('mb-3', className)} {...rest}>
      {children}
    </div>
  );
}

export function SidebarGroupLabel({ className, children, ...rest }: ComponentProps<'div'> & { children?: ReactNode }) {
  return (
    <div className={cn('mb-1 px-2 text-[11px] font-medium text-white/40', className)} {...rest}>
      {children}
    </div>
  );
}

export function SidebarGroupContent({ className, children, ...rest }: ComponentProps<'div'> & { children?: ReactNode }) {
  return (
    <div className={cn('space-y-0.5', className)} {...rest}>
      {children}
    </div>
  );
}

export function SidebarMenu({ className, children, ...rest }: ComponentProps<'nav'> & { children?: ReactNode }) {
  return (
    <nav className={cn('space-y-1', className)} {...rest}>
      {children}
    </nav>
  );
}

export function SidebarMenuItem({ className, children, ...rest }: ComponentProps<'li'> & { children?: ReactNode }) {
  return (
    <li className={cn('list-none', className)} {...rest}>
      {children}
    </li>
  );
}

/**
 * SidebarMenuButton — an anchor/button. When `asChild` is true it renders the
 * single child (a Link) and forwards the active styling onto it.
 */
export function SidebarMenuButton({
  asChild = false,
  isActive,
  className,
  children,
  ...rest
}: ComponentProps<'button'> & {
  asChild?: boolean;
  isActive?: boolean;
  children: ReactNode;
}) {
  const base = cn(
    'group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
    isActive
      ? 'bg-white/[0.08] text-white font-medium'
      : 'text-white/60 hover:bg-white/[0.05] hover:text-white/85',
    className
  );

  if (asChild) {
    const child = children as React.ReactElement<{ className?: string }>;
    return (
      <ButtonAsSlotChild
        child={child}
        className={cn(base, child.props?.className)}
        isActive={isActive}
        {...rest}
      />
    );
  }
  return (
    <button type="button" className={base} {...rest}>
      {children}
    </button>
  );
}

function ButtonAsSlotChild({
  child,
  className,
  isActive,
  onClick,
  ...rest
}: {
  child: React.ReactElement<{ className?: string }>;
  className: string;
  isActive?: boolean;
  onClick?: React.MouseEventHandler;
}) {
  const merged = cn(className, child.props?.className);
  const props = {
    ...child.props,
    className: merged,
    'aria-current': isActive ? 'page' : undefined,
    onClick,
  };
  return (() => {
    const Type = child.type as ElementType;
    return <Type {...props} {...rest} />;
  })();
}