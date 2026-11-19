import { useEffect, useMemo, useState } from 'react'
import {
  Copy, FolderGit2, ShieldCheck, Bot, Scale, Sparkles,
  ArrowRight, LoaderCircle, Check, Layers, FileText,
} from '@/lib/icons'
import { useParams } from 'react-router-dom'
import { local, readOperatorRoom, setDepartmentLocalRepo, createTask as createTaskLocal, type Enforcer, type SourceRepoInput, type RoomState } from '../lib/engine'

// TaskStudio — the modern HITL launchpad for the local tier.
// One coherent surface to:
//   1. configure the two-repo transform (destination repo + read-only SOURCE repo),
//   2. write the task spec, and
//   3. pick WHICH enforcer enforces it (ExcellenceGovernor / Polecats / Reviewer).
// The enforcer picker writes metadata.break_room_controls, and the task + spec +
// enforcer land in ONE create call. Style matches the HELLDESK glass theme.

interface RepoRow { id: string; path: string; label?: string; branch?: string }

const ENFORCERS: Array<{
  key: Enforcer
  name: string
  desc: string
  icon: typeof ShieldCheck
  accent: string
  chip: string
}> = [
  {
    key: 'auto', name: 'Department policy', icon: Sparkles, accent: 'var(--muted)',
    desc: 'No override — the task runs under the department/workstation default colony behavior. Pick this to keep it simple.',
    chip: 'default',
  },
  {
    key: 'excellenceGovernor', name: 'Build + ExcellenceGovernor', icon: ShieldCheck, accent: 'var(--accent)',
    desc: 'Implementers keep building. ExcellenceGovernor challenges the work and sends findings back for correction. You steer asynchronously and retain final acceptance.',
    chip: 'build · challenge · refine',
  },
  {
    key: 'soul', name: 'HELLDESK Polecats', icon: Bot, accent: 'var(--accent3)',
    desc: 'The colony dispatches soul/qualityAssurance agents to implement the ticket against the local repo.',
    chip: 'implement + land',
  },
  {
    key: 'reviewer', name: 'HELLDESK Reviewer', icon: Scale, accent: 'var(--accent2)',
    desc: 'The reviewer process verifies the produced work with grounded, provenanced evidence.',
    chip: 'review + verify',
  },
]

export default function TaskStudio() {
  const { departmentId = '' } = useParams()
  const workstations = useWorkstations()

  // ── repos panel ──
  // Decoupled model: project WORKSPACE (primary input) + optional OUTPUT repo
  // (cross-repo delta target, new or existing) + optional extra input repos.
  const [workspace, setWorkspace] = useState('')
  const [outputRepo, setOutputRepo] = useState('')
  const [outputReady, setOutputReady] = useState(true) // init_if_missing default
  const [sources, setSources] = useState<SourceRepoInput[]>([])
  const [repoBusy, setRepoBusy] = useState(false)
  const [repoMsg, setRepoMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [savedCfg, setSavedCfg] = useState<{
    ws?: string; output?: string; outputReady?: boolean; sources: RepoRow[]
  }>({ sources: [] })

  // ── task panel ──
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  const [enforcer, setEnforcer] = useState<Enforcer>('auto')
  const [workstationId, setWorkstationId] = useState('')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [tasks, setTasks] = useState<RoomState['tickets']>([])
  const [dependencyError, setDependencyError] = useState('')
  const [reviewMode, setReviewMode] = useState<'inherit' | 'ReviewThenLand' | 'ReviewAndMerge'>('inherit')
  const [engineOvers, setEngineOvers] = useState<{ engine: string; providerID?: string; modelID?: string; baseURL?: string }>({ engine: '' })
  const [taskBusy, setTaskBusy] = useState(false)
  const [taskMsg, setTaskMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    if (!workstationId && workstations.length) setWorkstationId(workstations[0])
  }, [workstations, workstationId])
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const room = await readOperatorRoom(departmentId)
        if (active) { setTasks(room.tickets); setDependencyError('') }
      } catch (error) { if (active) setDependencyError(error instanceof Error ? error.message : 'Task list unavailable.') }
    }
    void load()
    const timer = setInterval(load, 10000)
    return () => { active = false; clearInterval(timer) }
  }, [departmentId])

  // Load existing department repo config once.
  useEffect(() => {
    let alive = true
    const load = async () => {
      const cfg = await local.departmentConfig(departmentId)
      if (!alive) return
      const lr = cfg?.data?.local_repo ?? cfg?.local_repo
      if (lr) {
        setWorkspace(lr.repo_path ?? '')
        setOutputRepo(lr.output_repo?.repo_path ?? '')
        setOutputReady(lr.output_repo?.init_if_missing ?? true)
        setSources(lr.source_repos ?? [])
        setSavedCfg({
          ws: lr.repo_path,
          output: lr.output_repo?.repo_path,
          outputReady: lr.output_repo?.init_if_missing ?? true,
          sources: lr.source_repos ?? [],
        })
      }
    }
    load()
    return () => { alive = false }
  }, [departmentId])

  const saveRepos = async () => {
    if (!workspace.trim()) return
    setRepoBusy(true); setRepoMsg(null)
    const srcs = sources.map((s) => ({ ...s, path: s.path.trim() })).filter((s) => s.path && s.id)
    const res = await setDepartmentLocalRepo(departmentId, {
      repoPath: workspace.trim(),
      sourceRepos: srcs,
      ...(outputRepo.trim() ? {
        outputRepo: { repo_path: outputRepo.trim(), init_if_missing: outputReady },
      } : {}),
    })
    setRepoBusy(false)
    const ok = res?.success === true
    setRepoMsg({ ok, text: ok ? 'Repository routing saved for the next dispatch.' : res?.error || 'Could not save repo wiring.' })
    if (ok) setSavedCfg({ ws: workspace.trim(), output: outputRepo.trim() || undefined, outputReady, sources: srcs })
  }

  const createTask = async () => {
    if (!workstationId || !workspace.trim() || !title.trim() || !spec.trim()) return
    setTaskBusy(true); setTaskMsg(null)
    // Launch uses the routing visible in this form, never a stale saved target.
    if (workspace.trim()) {
      const routing = await setDepartmentLocalRepo(departmentId, {
        repoPath: workspace.trim(),
        sourceRepos: sources.filter(source => source.id && source.path.trim()),
        ...(outputRepo.trim() ? { outputRepo: { repo_path: outputRepo.trim(), init_if_missing: outputReady } } : {}),
      })
      if (routing?.success !== true) {
        setTaskBusy(false)
        setTaskMsg({ ok: false, text: routing?.error || 'Repository routing could not be saved. No task was created.' })
        return
      }
    }
    const res = await createTaskLocal(departmentId, workstationId, {
      title: title.trim() || 'Untitled task',
      spec: spec.trim(),
      enforcer,
      review_mode: reviewMode === 'inherit' ? undefined : reviewMode,
      depends_on: dependsOn,
      engineMatrix: engineOvers.engine ? { mutation: engineOvers } : undefined,
    })
    setTaskBusy(false)
    setTaskMsg({
      ok: res?.success === true,
      text: res?.success !== true
        ? `Could not create task: ${res?.error ?? 'unknown'}`
        : `Task created${dependsOn.length ? ` after ${dependsOn.length} prerequisite${dependsOn.length > 1 ? 's' : ''}` : ''}. ${enforcerLabel(enforcer)} is assigned; steer from the Operator-console.`,
    })
  }

  const srcStats = useMemo(() => {
    const s = savedCfg.sources
    return { count: s.length, sum: s.map((x) => x.id).join(', ') }
  }, [savedCfg])

  const selected = ENFORCERS.find((e) => e.key === enforcer)!

  return (
    <div className="operator-page">
      <div className="operator-eyebrow">MISSION CONTROL / NEW WORK</div>
      <div className="section-title operator-title" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 6px' }}>
        <Sparkles size={18} style={{ color: 'var(--accent)' }} />
        <span>Task Studio</span>
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
        Define the outcome. Route the repositories. Let the crew build and challenge each other while you steer.
      </div>
      <div className="ts-divider" style={{ marginBottom: 18 }} />

      <div className="ts-grid">
        {/* ── left: repos ── */}
        <section className="ts-card" style={{ gridArea: 'repos' }}>
          <div className="ts-card-h">
            <FolderGit2 size={16} style={{ color: 'var(--accent)' }} />
            <span>Repository routing</span>
          </div>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 14px' }}>
            Choose the project workspace so the crew has a real source to work from. An optional output repo receives the extracted capability or cross-repo delta.
          </div>
          <div className="ts-divider" />

          <label className="ts-label">Project workspace <span className="ts-opt-note">(primary input repo)</span></label>
          <div className="ts-field">
            <input
              className="ts-input mono"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="C:\path\to\workspace-repo"
            />
            <button className="ts-btn ts-btn-accent" onClick={saveRepos} disabled={repoBusy || !workspace.trim()}>
              {repoBusy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
              Save repos
            </button>
          </div>
          {repoMsg && (
            <div className={'ts-toast ' + (repoMsg.ok ? 'ts-ok' : 'ts-bad')} style={{ marginTop: 10 }}>
              {repoMsg.text}
            </div>
          )}

          <div className="ts-divider" />
          <label className="ts-label">Output repo <span className="ts-opt-note">(cross-repo deltas — new or existing, optional)</span></label>
          <div className="ts-field">
            <input
              className="ts-input mono"
              value={outputRepo}
              onChange={(e) => setOutputRepo(e.target.value)}
              placeholder={workspace ? `${workspace}\\..\\output-repo` : 'C:\\path\\to\\output-repo'}
            />
            <label className="ts-check" title="When checked, a missing output path is initialised as a new repo">
              <input type="checkbox" checked={outputReady}
                onChange={(e) => setOutputReady(e.target.checked)} />
              <span className="ts-btn-grow">init if missing</span>
            </label>
          </div>

          <div className="ts-divider" />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '2px 0 8px' }}>
            <label className="ts-label" style={{ margin: 0 }}>Extra input repos <span className="ts-opt-note">(read-only)</span></label>
            <button
              className="ts-chip-btn"
              onClick={() => setSources((s) => [...s, { id: `src-${Date.now().toString(36)}`, path: '', label: '' }])}
            >
              + Add input
            </button>
          </div>

          {sources.length === 0 && (
            <div className="ts-empty">
              <Layers size={20} style={{ color: 'var(--muted)', opacity: 0.6 }} />
              <div>No extra input repos. Add a repo to read from alongside the workspace (e.g. a dependency to refactor).</div>
            </div>
          )}
          <div style={{ display: 'grid', gap: 8 }}>
            {sources.map((s, i) => (
              <div key={s.id} className="ts-source" style={{ display: 'grid', gridTemplateColumns: '1fr 3fr auto', gap: 8 }}>
                <input className="ts-input mono" placeholder="id (e.g. input)" value={s.id}
                  onChange={(e) => setSources(sources.map((x, j) => j === i ? { ...x, id: e.target.value } : x))} />
                <input className="ts-input mono" placeholder="C:\path\to\input-repo" value={s.path}
                  onChange={(e) => setSources(sources.map((x, j) => j === i ? { ...x, path: e.target.value } : x))} />
                <button className="ts-icon-btn" title="remove" onClick={() => setSources(sources.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>

          {savedCfg.ws && (
            <div className="ts-wired" style={{ marginTop: 16 }}>
              <div className="ts-wired-h"><Copy size={13} /> wired</div>
              <div className="mono" style={{ fontSize: 12 }}>workspace → {savedCfg.ws}</div>
              {savedCfg.output && <div className="mono" style={{ fontSize: 12 }}>output → {savedCfg.output}{savedCfg.outputReady ? ' (init if missing)' : ''}</div>}
              <div className="mono muted" style={{ fontSize: 12 }}>
                extra input ← {srcStats.count === 0 ? 'none' : srcStats.sum}
              </div>
            </div>
          )}
        </section>

        {/* ── right: new task ── */}
        <section className="ts-card" style={{ gridArea: 'task' }}>
          <div className="ts-card-h">
            <FileText size={16} style={{ color: 'var(--accent)' }} />
            <span>New task</span>
          </div>

          <label className="ts-label">Title</label>
          <input className="ts-input" style={{ width: '100%' }} value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Refactor the input repo into a reusable output library" />

          <label className="ts-label" style={{ marginTop: 14 }} htmlFor="task-workstation">Execution workstation</label>
          <select id="task-workstation" className="ts-input" value={workstationId} onChange={e => setWorkstationId(e.target.value)}>
            {!workstations.length && <option value="">Create a workstation before launching work</option>}
            {workstations.map(id => <option key={id} value={id}>{id}</option>)}
          </select>

          <label className="ts-label" style={{ marginTop: 14 }}>Spec</label>
          <textarea className="ts-input ts-area" value={spec}
            onChange={(e) => setSpec(e.target.value)}
            placeholder={'Describe the input → output work: what to read from the input repo(s), what to build in the output repo, the contracts to preserve, and how to prove it (tests / evidence).'} />

          <fieldset className="task-dependencies">
            <legend>Starts after</legend>
            <p>Choose prerequisite tasks. The crew can work elsewhere while these finish.</p>
            {dependencyError && <div className="ts-toast ts-bad" role="status">{dependencyError}</div>}
            {!tasks.length && !dependencyError && <div className="muted">No earlier tasks in this department. This task can start independently.</div>}
            <div className="task-dependency-list">
              {tasks.map(task => <label key={task.ticket_id} className={'task-dependency' + (dependsOn.includes(task.ticket_id) ? ' selected' : '')}>
                <input type="checkbox" checked={dependsOn.includes(task.ticket_id)} onChange={e => setDependsOn(current => e.target.checked ? [...current, task.ticket_id] : current.filter(id => id !== task.ticket_id))} />
                <span>{task.title}<small>{task.status} · {task.ticket_id.slice(0, 8)}</small></span>
                <span className="operator-chip">{task.status === 'closed' ? 'ready' : 'prerequisite'}</span>
              </label>)}
            </div>
          </fieldset>

          <div className="ts-divider" style={{ margin: '16px 0 14px' }} />
          <label className="ts-label">Enforcer <span className="ts-opt-note">(optional)</span></label>
          <div className="ts-picker">
            {ENFORCERS.map((e) => {
              const Icon = e.icon
              const on = enforcer === e.key
              return (
                <button key={e.key} className={'ts-enforcer' + (on ? ' on' : '')}
                  style={on ? { borderColor: e.accent, boxShadow: `0 0 0 1px ${e.accent}, 0 8px 26px -10px ${e.accent}55` } : undefined}
                  onClick={() => setEnforcer(e.key)}>
                  <Icon size={16} style={{ color: on ? e.accent : 'var(--muted)' }} />
                  <div className="ts-enforcer-name">{e.name}</div>
                  <div className="ts-enforcer-chip" style={{ color: on ? e.accent : 'var(--muted)' }}>{e.chip}</div>
                </button>
              )
            })}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>— {selected.desc}</div>

          {enforcer !== 'soul' && (
            <div className="ts-divider" style={{ margin: '14px 0 12px' }} />
          )}
          {enforcer !== 'soul' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label className="ts-label" style={{ margin: 0 }}>Review mode</label>
              <button className={'ts-mode' + (reviewMode === 'inherit' ? ' on' : '')}
                onClick={() => setReviewMode('inherit')}>Department default</button>
              <button className={'ts-mode' + (reviewMode === 'ReviewThenLand' ? ' on' : '')}
                onClick={() => setReviewMode('ReviewThenLand')}>Review then land</button>
              <button className={'ts-mode' + (reviewMode === 'ReviewAndMerge' ? ' on' : '')}
                onClick={() => setReviewMode('ReviewAndMerge')}>Review & auto-merge</button>
            </div>
          )}

          <div className="ts-divider" style={{ margin: '14px 0 12px' }} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="ts-label" style={{ margin: 0 }}>Mutation engine <span className="ts-opt-note">(per-task override)</span></label>
            <select className="ts-mode" value={engineOvers.engine} onChange={e => setEngineOvers(o => ({ ...o, engine: e.target.value }))} style={{ background: 'transparent', color: 'var(--text2)', padding: '4px 8px', borderRadius: 8, border: '1px solid var(--line)' }}>
              <option value="">inherit department default</option>
              <option value="kilo">kilo</option>
              <option value="codex">codex</option>
              <option value="openai">openai</option>
            </select>
            {engineOvers.engine && (
              <input className="ts-mode" value={engineOvers.modelID ?? ''} onChange={e => setEngineOvers(o => ({ ...o, modelID: e.target.value }))} placeholder="model (e.g. differential_sseproxy / gpt-6-luna)" style={{ minWidth: 220, background: 'transparent', color: 'var(--text2)', padding: '4px 8px', borderRadius: 8, border: '1px solid var(--line)' }} />
            )}
          </div>

          <div className="ts-divider" style={{ margin: '16px 0 14px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="ts-create" onClick={createTask} disabled={taskBusy || !workstationId || !workspace.trim() || !title.trim() || !spec.trim()}>
              {taskBusy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}
              Create task{enforcer === 'auto' ? '' : ` · ${enforcerLabel(enforcer)}`}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>agents are autonomous; you steer live from BreakRoom Chat</span>
          </div>
          {taskMsg && (
            <div className={'ts-toast ' + (taskMsg.ok ? 'ts-ok' : 'ts-bad')} style={{ marginTop: 12 }}>
              <span role="status">{taskMsg.text}</span>
            </div>
          )}
        </section>
      </div>

      <style>{TS_CSS}</style>
    </div>
  )
}

/* fetch workstations to pick a target workstation for the task */
function useWorkstations(): string[] {
  const { departmentId = '' } = useParams()
  const [workstations, setWorkstations] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try { const room = await readOperatorRoom(departmentId); if (alive) setWorkstations(room.workstations.map(workstation => workstation.id || workstation.workstation_id || '').filter(Boolean)) } catch { /* room error is displayed by dependency loading */ }
    }
    load()
    const timer = setInterval(load, 10000)
    return () => { alive = false; clearInterval(timer) }
  }, [departmentId])
  return workstations
}

function enforcerLabel(e: Enforcer): string {
  return ENFORCERS.find((x) => x.key === e)?.name ?? e
}

const TS_CSS = `
.ts-grid { display: grid; grid-template-areas: 'repos task'; grid-template-columns: 1fr 1.15fr; gap: 18px; align-items: start; }
@media (max-width: 980px) { .ts-grid { grid-template-areas: 'repos' 'task'; grid-template-columns: 1fr; } }
.ts-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r);
  padding: 18px 20px 20px; backdrop-filter: blur(12px); box-shadow: var(--shadow);
}
.ts-card-h { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
.ts-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 6px; font-weight: 600; }
.ts-input {
  background: var(--bg2); border: 1px solid var(--line); color: var(--fg); border-radius: 9px;
  padding: 9px 11px; font-size: 13px; outline: none; transition: 0.14s;
}
.ts-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(110,231,183,0.14); }
.ts-area { min-height: 96px; resize: vertical; line-height: 1.5; }
.ts-field { display: flex; gap: 8px; }
.ts-field .ts-input { flex: 1; }
.ts-btn { display: inline-flex; align-items: center; gap: 6px; border-radius: 9px; padding: 9px 12px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); transition: 0.14s; white-space: nowrap; }
.ts-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ts-btn-accent { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #04241d; border: none; }
.ts-btn-accent:hover:not(:disabled) { filter: brightness(1.05); }
.ts-chip-btn { background: none; border: 1px dashed var(--line); color: var(--muted); border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; transition: 0.14s; }
.ts-chip-btn:hover { color: var(--fg); border-color: var(--accent); }
.ts-icon-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; }
.ts-icon-btn:hover { color: var(--bad); }
.ts-source { align-items: center; }
.ts-empty { border: 1px dashed var(--line); border-radius: 10px; padding: 16px; text-align: center; color: var(--muted); display: grid; gap: 6px; justify-items: center; font-size: 12px; }
.ts-toast { border-radius: 9px; padding: 9px 12px; font-size: 13px; }
.ts-ok { background: rgba(52,211,153,0.12); border: 1px solid rgba(52,211,153,0.28); color: var(--ok); }
.ts-bad { background: rgba(248,113,113,0.12); border: 1px solid rgba(248,113,113,0.28); color: var(--bad); }
.ts-wired { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--bg2); display: grid; gap: 3px; }
.ts-wired-h { display: flex; align-items: center; gap: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); font-weight: 700; }
.ts-picker { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
@media (max-width: 860px) { .ts-picker { grid-template-columns: repeat(2, 1fr); } }
.ts-enforcer {
  display: grid; gap: 7px; justify-items: start; text-align: left; padding: 13px 14px; cursor: pointer;
  background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; color: var(--fg); transition: 0.16s;
}
.ts-enforcer:hover { border-color: var(--fg); }
.ts-enforcer.on { background: rgba(110,231,183,0.05); }
.ts-enforcer-name { font-weight: 600; font-size: 13px; }
.ts-enforcer-chip { font-size: 11px; }
.ts-divider { height: 1px; background: linear-gradient(90deg, transparent, var(--line), transparent); }
.ts-optional {
  font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--accent); border: 1px solid rgba(110,231,183,0.3); border-radius: 999px; padding: 1px 8px;
  margin-left: 6px; vertical-align: 1px;
}
.ts-opt-note { font-size: 10px; text-transform: none; letter-spacing: 0; color: var(--muted); font-weight: 500; }
.ts-mode { background: var(--bg2); border: 1px solid var(--line); color: var(--muted); border-radius: 999px; padding: 6px 13px; font-size: 12px; cursor: pointer; transition: 0.14s; }
.ts-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); cursor: pointer; white-space: nowrap; padding: 0 4px; }
.ts-check input[type='checkbox'] { accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer; }
.ts-mode.on { color: var(--accent); border-color: var(--accent); background: rgba(110,231,183,0.1); }
.ts-create {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer; border-radius: 10px;
  background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #04241d; border: none;
  padding: 11px 18px; font-size: 14px; font-weight: 700; transition: 0.16s;
}
.ts-create:hover:not(:disabled) { filter: brightness(1.06); box-shadow: 0 8px 24px -8px rgba(110,231,183,0.5); }
.ts-create:disabled { opacity: 0.55; cursor: not-allowed; }
.spin { animation: tspin 0.8s linear infinite; }
@keyframes tspin { to { transform: rotate(360deg); } }
`
