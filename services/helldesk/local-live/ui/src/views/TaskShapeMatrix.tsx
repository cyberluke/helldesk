import { useState, type ReactNode } from 'react'
import {
  Bot, ChevronDown, ChevronUp, FileText, FolderGit2, GitPullRequest, Hexagon, Layers,
  LoaderCircle, RefreshCw, Scale, Search, Settings, ShieldCheck, Sparkles, Wrench, Zap,
} from '@/lib/icons'
import type { Delivery, Enforcer, EnhanceMode, TaskType, WriteTarget } from '../lib/engine'

// TaskShapeMatrix — the operator's single place to shape a task before the spec
// is written. Five rows mirror the five levers the colony understands:
//   AI (actions) → enhancer, Task type → work kind, Write target → where the
//   delta lands, Delivery → how finished it must be, Review → who challenges it.
// Buttons use short labels so they never ellipsize at the card's real width;
// the collapsed Legend carries the full name and the plain-language meaning.

type IconComponent = typeof Sparkles

interface ShapeOption<T extends string> {
  key: T
  label: string
  /** Short button label; the legend always shows the full `label`. */
  shortLabel?: string
  description: string
  icon: IconComponent
}

interface LegendItem {
  label: string
  description: string
  icon: IconComponent
}

interface LegendGroup {
  key: string
  title: string
  items: LegendItem[]
}

export const TASK_TYPE_OPTIONS: Array<ShapeOption<TaskType>> = [
  {
    key: 'engine', label: 'Engine', shortLabel: 'Engine', icon: Hexagon,
    description: 'Build or extend an engine/framework: reusable components, manifest, agent API. A demo is not the product.',
  },
  {
    key: 'feature', label: 'Feature', shortLabel: 'Feature', icon: Sparkles,
    description: 'Add or enhance one capability in the routed repo without changing the product boundary.',
  },
  {
    key: 'bugfix', label: 'Bugfix', shortLabel: 'Bugfix', icon: Wrench,
    description: 'Reproduce and fix a defect; one regression test proves the fix.',
  },
  {
    key: 'refactor', label: 'Refactor', shortLabel: 'Refactor', icon: RefreshCw,
    description: 'Change internals while preserving behavior and public contracts.',
  },
  {
    key: 'extraction', label: 'Extraction', shortLabel: 'Extract', icon: Layers,
    description: 'Federate a capability from a read-only source repo into the output repo.',
  },
]

export const WRITE_TARGET_OPTIONS: Array<ShapeOption<WriteTarget>> = [
  {
    key: 'workspace', label: 'Workspace', shortLabel: 'Workspace', icon: FolderGit2,
    description: 'Edit in place. There is no output repo; the routed workspace is the delivery target.',
  },
  {
    key: 'output_repo', label: 'Output repo', shortLabel: 'Output', icon: GitPullRequest,
    description: 'Cross-repo delta. The output repo is the delivery target; the source workspace is read-only.',
  },
]

export const DELIVERY_OPTIONS: Array<ShapeOption<Delivery>> = [
  {
    key: 'startup', label: 'Startup', shortLabel: 'Startup', icon: Zap,
    description: 'Implementation-first: the smallest runnable slice with the minimum proof of the claim.',
  },
  {
    key: 'production', label: 'Production', shortLabel: 'Production', icon: ShieldCheck,
    description: 'Full boundaries and proportional evidence; still no exhaustive test matrix for its own sake.',
  },
]

export const REVIEW_OPTIONS: Array<ShapeOption<Enforcer>> = [
  {
    key: 'auto', label: 'Auto', shortLabel: 'Auto', icon: Settings,
    description: 'Use the department/workstation default colony behavior. Pick this to keep it simple.',
  },
  {
    key: 'excellenceGovernor', label: 'Build+EG', shortLabel: 'Build+EG', icon: ShieldCheck,
    description: 'Build gate plus the Excellence Governor only.',
  },
  {
    key: 'soul', label: 'Souls', shortLabel: 'Souls', icon: Bot,
    description: 'Autonomous agent review without the independent reviewer layer.',
  },
  {
    key: 'reviewer', label: 'Reviewer A/B', shortLabel: 'A/B', icon: Scale,
    description: 'Two independent reviewers challenge the work.',
  },
  {
    key: 'reviewerAndGovernor', label: 'A/B+EG', shortLabel: 'A/B+EG', icon: ShieldCheck,
    description: 'Two independent reviewers plus the Excellence Governor.',
  },
]

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  engine: 'Engine', feature: 'Feature', bugfix: 'Bugfix', refactor: 'Refactor', extraction: 'Extraction',
}

export const WRITE_TARGET_LABELS: Record<WriteTarget, string> = {
  workspace: 'Workspace', output_repo: 'Output repo',
}

export const DELIVERY_LABELS: Record<Delivery, string> = {
  startup: 'Startup', production: 'Production',
}

export const REVIEW_LABELS: Record<Enforcer, string> = {
  auto: 'Auto',
  excellenceGovernor: 'Build+EG',
  soul: 'Souls',
  reviewer: 'Reviewer A/B',
  reviewerAndGovernor: 'A/B+EG',
}

export const ENHANCE_MODE_LABELS: Record<EnhanceMode, string> = {
  text: 'Improve text', repos: 'Analyze repos + spec',
}

const AI_ACTIONS: Array<{ mode: EnhanceMode; label: string; shortLabel: string; description: string; icon: IconComponent }> = [
  {
    mode: 'text', label: 'Improve text', shortLabel: 'Improve', icon: Sparkles,
    description: 'Rewrite the brief into a structured spec. No repo read; fastest.',
  },
  {
    mode: 'repos', label: 'Analyze repos + spec', shortLabel: 'Analyze', icon: Search,
    description: 'Read the routed input/output repos read-only, then write a grounded spec. Slower.',
  },
]

const LEGEND_GROUPS: LegendGroup[] = [
  {
    key: 'ai',
    title: 'AI actions',
    items: AI_ACTIONS.map((action) => ({
      label: action.label,
      description: action.description,
      icon: action.icon,
    })),
  },
  { key: 'task', title: 'Task type', items: TASK_TYPE_OPTIONS },
  { key: 'write', title: 'Write target', items: WRITE_TARGET_OPTIONS },
  { key: 'delivery', title: 'Delivery', items: DELIVERY_OPTIONS },
  { key: 'review', title: 'Review', items: REVIEW_OPTIONS },
]

export interface TaskShapeMatrixProps {
  taskType: TaskType
  writeTarget: WriteTarget
  delivery: Delivery
  enforcer: Enforcer
  /** False disables the Output repo cell (no output repo routed yet). */
  outputRepoAvailable: boolean
  /** The enhancement currently running, if any. Both AI cells disable while busy. */
  enhanceBusy: EnhanceMode | null
  onEnhance: (mode: EnhanceMode) => void
  onTaskType: (taskType: TaskType) => void
  onWriteTarget: (writeTarget: WriteTarget) => void
  onDelivery: (delivery: Delivery) => void
  onEnforcer: (enforcer: Enforcer) => void
}

function ShapeButton<T extends string>({
  option, selected, disabled, title, onSelect,
}: {
  option: ShapeOption<T>
  selected: boolean
  disabled?: boolean
  title?: string
  onSelect: (key: T) => void
}) {
  const Icon = option.icon
  return (
    <button
      type="button"
      className={'ts-shape' + (selected ? ' on' : '')}
      aria-pressed={selected}
      disabled={disabled}
      title={title ?? `${option.label} — ${option.description}`}
      onClick={() => onSelect(option.key)}
    >
      <Icon size={13} />
      <span className="ts-shape-label">{option.shortLabel ?? option.label}</span>
    </button>
  )
}

function ShapeRow({ label, icon: Icon, children }: {
  label: string
  icon: IconComponent
  children: ReactNode
}) {
  return (
    <div className="ts-matrix-row" role="group" aria-label={label}>
      <div className="ts-matrix-chip"><Icon size={12} /><span>{label}</span></div>
      <div className="ts-matrix-options">{children}</div>
    </div>
  )
}

export default function TaskShapeMatrix({
  taskType, writeTarget, delivery, enforcer, outputRepoAvailable, enhanceBusy,
  onEnhance, onTaskType, onWriteTarget, onDelivery, onEnforcer,
}: TaskShapeMatrixProps) {
  const [legendOpen, setLegendOpen] = useState(false)

  return (
    <div className="ts-shape-wrap">
      <div className="ts-matrix" role="group" aria-label="Task shape">
        <ShapeRow label="AI" icon={Sparkles}>
          {AI_ACTIONS.map((action) => {
            const Icon = action.icon
            const busy = enhanceBusy === action.mode
            const anyBusy = enhanceBusy !== null
            return (
              <button
                key={action.mode}
                type="button"
                className={'ts-shape ts-shape-action' + (busy ? ' on' : '')}
                disabled={anyBusy}
                aria-busy={busy}
                title={`${action.label} — ${action.description}`}
                onClick={() => onEnhance(action.mode)}
              >
                {busy ? <LoaderCircle size={13} className="spin" /> : <Icon size={13} />}
                <span className="ts-shape-label">{action.shortLabel}</span>
              </button>
            )
          })}
        </ShapeRow>

        <ShapeRow label="Task type" icon={Hexagon}>
          {TASK_TYPE_OPTIONS.map((option) => (
            <ShapeButton key={option.key} option={option} selected={taskType === option.key} onSelect={onTaskType} />
          ))}
        </ShapeRow>

        <ShapeRow label="Write target" icon={GitPullRequest}>
          {WRITE_TARGET_OPTIONS.map((option) => {
            const disabled = option.key === 'output_repo' && !outputRepoAvailable
            if (disabled) {
              return (
                <span key={option.key} className="ts-shape-slot" title="Add an output repo above to target it">
                  <ShapeButton option={option} selected={false} disabled onSelect={onWriteTarget} />
                </span>
              )
            }
            return (
              <ShapeButton
                key={option.key}
                option={option}
                selected={writeTarget === option.key}
                onSelect={onWriteTarget}
              />
            )
          })}
        </ShapeRow>

        <ShapeRow label="Delivery" icon={Zap}>
          {DELIVERY_OPTIONS.map((option) => (
            <ShapeButton key={option.key} option={option} selected={delivery === option.key} onSelect={onDelivery} />
          ))}
        </ShapeRow>

        <ShapeRow label="Review" icon={Scale}>
          {REVIEW_OPTIONS.map((option) => (
            <ShapeButton key={option.key} option={option} selected={enforcer === option.key} onSelect={onEnforcer} />
          ))}
        </ShapeRow>
      </div>

      <div className="ts-legend-bar">
        <button
          type="button"
          className="ts-chip-btn ts-legend-toggle"
          aria-expanded={legendOpen}
          aria-controls="task-shape-legend"
          onClick={() => setLegendOpen((open) => !open)}
        >
          <FileText size={12} />
          Legend
          {legendOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <span className="ts-legend-hint">What each option means</span>
      </div>

      {legendOpen && (
        <div id="task-shape-legend" className="ts-legend">
          {LEGEND_GROUPS.map((group) => (
            <section key={group.key} className="ts-legend-group">
              <h5>{group.title}</h5>
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <div key={item.label} className="ts-legend-item">
                    <Icon size={13} />
                    <div>
                      <strong>{item.label}</strong>
                      <span>{item.description}</span>
                    </div>
                  </div>
                )
              })}
            </section>
          ))}
          <p className="ts-legend-note">
            AI results are proposals only. <strong>Use spec</strong> is the approval; adversarial QA findings require an explicit override.
          </p>
        </div>
      )}
    </div>
  )
}
