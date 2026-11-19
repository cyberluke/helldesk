'use client';

import { useMemo, useRef, useEffect, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

import { motion } from 'motion/react';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Workstation = RouterOutputs['helldesk']['listWorkstations'][number];
type Agent = RouterOutputs['helldesk']['listAgents'][number];
type DepartmentEvent = RouterOutputs['helldesk']['getDepartmentEvents'][number];

type SystemTopologyProps = {
  departmentName: string;
  workstations: Workstation[];
  /** Map of workstationId -> agents for that workstation */
  agentsByWorkstation: Record<string, Agent[]>;
  /** Recent events to show animated memo flow arrows */
  recentEvents?: DepartmentEvent[];
  onSelectWorkstation?: (workstationId: string) => void;
  onSelectAgent?: (agentId: string) => void;
};

const STATUS_COLORS: Record<string, string> = {
  idle: 'stroke-white/20',
  working: 'stroke-emerald-400',
  active: 'stroke-emerald-400',
  stalled: 'stroke-amber-400',
  dead: 'stroke-red-400',
  starting: 'stroke-sky-400',
};

const STATUS_FILL: Record<string, string> = {
  idle: 'fill-white/10',
  working: 'fill-emerald-400/20',
  active: 'fill-emerald-400/20',
  stalled: 'fill-amber-400/20',
  dead: 'fill-red-400/20',
  starting: 'fill-sky-400/20',
};

/**
 * SVG-based system topology view showing the department structure.
 * FrontDesk at center, workstations radiating outward, agents within each workstation.
 */
export function SystemTopology({
  departmentName,
  workstations,
  agentsByWorkstation,
  recentEvents = [],
  onSelectWorkstation,
  onSelectAgent,
}: SystemTopologyProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 800, height: 500 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setDims({
          width: entry.contentRect.width,
          height: Math.max(entry.contentRect.height, 400),
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { width, height } = dims;
  const cx = width / 2;
  const cy = height / 2;
  const workstationRadius = Math.min(width, height) * 0.32;

  // Compute workstation positions in a circle around center
  const workstationPositions = useMemo(() => {
    return workstations.map((workstation, i) => {
      const angle = (2 * Math.PI * i) / Math.max(workstations.length, 1) - Math.PI / 2;
      return {
        workstation,
        x: cx + workstationRadius * Math.cos(angle),
        y: cy + workstationRadius * Math.sin(angle),
        angle,
      };
    });
  }, [workstations, cx, cy, workstationRadius]);

  // Compute agent positions around each workstation
  const agentPositions = useMemo(() => {
    const positions: Array<{
      agent: Agent;
      x: number;
      y: number;
      workstationX: number;
      workstationY: number;
    }> = [];

    for (const rp of workstationPositions) {
      const agents = agentsByWorkstation[rp.workstation.id] ?? [];
      const agentOrbitRadius = 45;

      agents.forEach((agent, j) => {
        const agentAngle = rp.angle + (j - (agents.length - 1) / 2) * 0.5;
        positions.push({
          agent,
          x: rp.x + agentOrbitRadius * Math.cos(agentAngle),
          y: rp.y + agentOrbitRadius * Math.sin(agentAngle),
          workstationX: rp.x,
          workstationY: rp.y,
        });
      });
    }
    return positions;
  }, [workstationPositions, agentsByWorkstation]);

  // Recent memo events for animated arrows
  const memoFlows = useMemo(() => {
    return recentEvents.filter(e => e.event_type === 'memo_sent').slice(-8);
  }, [recentEvents]);

  return (
    <div ref={containerRef} className="h-full w-full">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible"
      >
        {/* Background grid */}
        <defs>
          <pattern id="topoGrid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke="oklch(1 0 0 / 0.03)"
              strokeWidth="0.5"
            />
          </pattern>
          {/* Glow filter */}
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="centerGlow">
            <stop offset="0%" stopColor="oklch(95% 0.15 108)" stopOpacity="0.15" />
            <stop offset="100%" stopColor="oklch(95% 0.15 108)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect width={width} height={height} fill="url(#topoGrid)" />

        {/* Center glow */}
        <circle cx={cx} cy={cy} r={workstationRadius * 0.6} fill="url(#centerGlow)" />

        {/* Connections from center to workstations */}
        {workstationPositions.map(rp => (
          <line
            key={rp.workstation.id}
            x1={cx}
            y1={cy}
            x2={rp.x}
            y2={rp.y}
            stroke="oklch(1 0 0 / 0.06)"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
        ))}

        {/* Connections from workstations to agents */}
        {agentPositions.map(ap => (
          <line
            key={ap.agent.id}
            x1={ap.workstationX}
            y1={ap.workstationY}
            x2={ap.x}
            y2={ap.y}
            stroke="oklch(1 0 0 / 0.04)"
            strokeWidth="0.5"
          />
        ))}

        {/* Animated memo flow arrows */}
        {memoFlows.map((event, i) => {
          // Animate from center outward for now (could be agent-to-agent with proper data)
          const targetWorkstation = workstationPositions.find(rp => rp.workstation.name === event.workstation_name);
          if (!targetWorkstation) return null;

          return (
            <motion.circle
              key={`memo-${event.ticket_event_id}`}
              cx={cx}
              cy={cy}
              r={2.5}
              fill="oklch(0.7 0.15 200)"
              filter="url(#glow)"
              animate={{
                cx: [cx, targetWorkstation.x],
                cy: [cy, targetWorkstation.y],
                opacity: [1, 0],
              }}
              transition={{
                duration: 1.5,
                delay: i * 0.2,
                repeat: Infinity,
                repeatDelay: 3,
              }}
            />
          );
        })}

        {/* Agent nodes */}
        {agentPositions.map(ap => {
          return (
            <g
              key={ap.agent.id}
              className="cursor-pointer"
              onClick={() => onSelectAgent?.(ap.agent.id)}
            >
              <circle
                cx={ap.x}
                cy={ap.y}
                r={10}
                className={`${STATUS_FILL[ap.agent.status] ?? 'fill-white/5'} ${STATUS_COLORS[ap.agent.status] ?? 'stroke-white/10'}`}
                strokeWidth="1"
              />
              <text x={ap.x} y={ap.y + 20} textAnchor="middle" className="fill-white/25 text-[8px]">
                {ap.agent.name}
              </text>
            </g>
          );
        })}

        {/* Workstation nodes */}
        {workstationPositions.map(rp => (
          <g key={rp.workstation.id} className="cursor-pointer" onClick={() => onSelectWorkstation?.(rp.workstation.id)}>
            <circle
              cx={rp.x}
              cy={rp.y}
              r={22}
              fill="oklch(0.15 0 0)"
              stroke="oklch(1 0 0 / 0.12)"
              strokeWidth="1.5"
            />
            <text
              x={rp.x}
              y={rp.y + 3}
              textAnchor="middle"
              className="fill-white/60 text-[9px] font-medium"
            >
              {rp.workstation.name.slice(0, 5)}
            </text>
            <text x={rp.x} y={rp.y + 38} textAnchor="middle" className="fill-white/30 text-[8px]">
              {rp.workstation.name}
            </text>
          </g>
        ))}

        {/* Center (FrontDesk) node */}
        <circle
          cx={cx}
          cy={cy}
          r={28}
          fill="oklch(0.12 0 0)"
          stroke="oklch(95% 0.15 108 / 0.4)"
          strokeWidth="2"
          filter="url(#glow)"
        />
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          className="fill-[color:oklch(95%_0.15_108)] text-[10px] font-bold"
        >
          frontdesk
        </text>
        <text x={cx} y={cy + 8} textAnchor="middle" className="fill-white/40 text-[7px]">
          {departmentName}
        </text>
      </svg>
    </div>
  );
}
