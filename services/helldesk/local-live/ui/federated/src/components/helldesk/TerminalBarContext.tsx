'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

type TerminalTab = {
  id: string;
  label: string;
  kind: 'frontDesk' | 'agent';
  agentId: string;
};

type TerminalBarContextValue = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  collapsed: boolean;
  openAgentTab: (agentId: string, agentName: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (id: string) => void;
  setCollapsed: (collapsed: boolean) => void;
};

const TerminalBarContext = createContext<TerminalBarContextValue | null>(null);

export function useTerminalBar() {
  const ctx = useContext(TerminalBarContext);
  if (!ctx) throw new Error('useTerminalBar must be used within TerminalBarProvider');
  return ctx;
}

export function TerminalBarProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // FrontDesk dock starts folded so the page content is not obscured on load.
  // One click on the chevron (or on a tab) expands it.
  const [collapsed, setCollapsed] = useState(true);

  const openAgentTab = useCallback((agentId: string, agentName: string) => {
    const tabId = `agent:${agentId}`;
    setTabs(prev => {
      if (prev.some(t => t.id === tabId)) return prev;
      return [...prev, { id: tabId, label: agentName, kind: 'agent', agentId }];
    });
    setActiveTabId(tabId);
    setCollapsed(false);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      return next;
    });
    setActiveTabId(prev => {
      if (prev !== tabId) return prev;
      // Fall back to frontDesk tab
      return 'frontDesk';
    });
  }, []);

  return (
    <TerminalBarContext.Provider
      value={{ tabs, activeTabId, collapsed, openAgentTab, closeTab, setActiveTabId, setCollapsed }}
    >
      {children}
    </TerminalBarContext.Provider>
  );
}
