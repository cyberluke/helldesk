import { useEffect, useState } from 'react'
import { engine, local, type Project } from '../lib/engine'

// Provider-agnostic engine matrix: per-stage engine selection, persisted as the
// department DEFAULT every task inherits (a task may override via metadata.engine_matrix).
type Stage = 'mutation' | 'review' | 'adjudicate'
const STAGES: Stage[] = ['mutation', 'review', 'adjudicate']
const ENGINES = ['kilo', 'codex', 'openai'] as const
interface StageSpec { engine?: string; providerID?: string; modelID?: string; baseURL?: string }
function stageDefault(): Record<Stage, StageSpec> {
  // No provider/model/baseURL pins: the effective Kilo model comes from
  // kilo.json(c), so a global model change propagates to every stage.
  return {
    mutation: { engine: 'kilo' },
    review: { engine: 'kilo' },
    adjudicate: { engine: 'kilo' },
  }
}
function cloneMatrix(m: Record<Stage, StageSpec>): Record<Stage, StageSpec> {
  return { mutation: { ...m.mutation }, review: { ...m.review }, adjudicate: { ...m.adjudicate } }
}

// Settings — department/workstation config (via local-live) + engine matrix defaults + projects.
export default function SettingsView() {
  const [config, setConfig] = useState<any>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [repoPath, setRepoPath] = useState('')
  const [matrix, setMatrix] = useState<Record<Stage, StageSpec>>(stageDefault())

  useEffect(() => {
    local.departmentConfig('default').then(c => { setConfig(c); if (c?.engine_matrix) setMatrix(cloneMatrix(c.engine_matrix)) })
    engine.projectList().then(ps => setProjects(ps))
  }, [])

  const saveConfig = async () => {
    const body = { local_repo: { adapter: repoPath ? 'local-git' : 'none', repo_path: repoPath || undefined } }
    const res = await fetch(`${local.base}/departments/default/config`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    local.departmentConfig('default').then(c => setConfig(c))
    alert(res.ok ? 'config saved' : 'save failed')
  }

  const saveMatrix = async () => {
    const res = await fetch(`${local.base}/departments/default/config`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_matrix: matrix }),
    })
    alert(res.ok ? 'engine matrix saved (defaults for all tasks)' : 'save failed')
  }

  const setStage = (stage: Stage, patch: Partial<StageSpec>) =>
    setMatrix(m => ({ ...m, [stage]: { ...m[stage], ...patch } }))

  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 12px' }}>⚙ Settings</div>
      <div className="native-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
        <div className="card">
          <h3>Department / workstation (local-live)</h3>
          <p className="muted">Point the department at a filesystem repo (local-git adapter).</p>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Repo path</label>
            <input value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="C:\dev\myproject or a bare repo" />
          </div>
          <button className="primary" onClick={saveConfig}>Save config</button>
        </div>

        <div className="card">
          <h3>Engine matrix (department default)</h3>
          <p className="muted">Provider-agnostic engines per pipeline stage — every task inherits these unless overridden per task. codex is a first-class reviewer.</p>
          {STAGES.map(stage => {
            const s = matrix[stage] ?? {}
            return (
              <div key={stage} style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
                <div style={{ fontWeight: 600, textTransform: 'capitalize', marginBottom: 6 }}>{stage}</div>
                <div className="field" style={{ marginBottom: 6 }}>
                  <label>Engine</label>
                  <select value={s.engine ?? ''} onChange={e => setStage(stage, { engine: e.target.value })}>
                    {ENGINES.map(en => <option key={en} value={en}>{en}</option>)}
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 6 }}>
                  <label>Provider / model</label>
                  <input value={s.modelID ?? ''} onChange={e => setStage(stage, { modelID: e.target.value, providerID: e.target.value.includes('/') ? e.target.value.split('/')[0] : s.providerID })} placeholder="inherit Kilo model" />
                </div>
                <div className="field">
                  <label>Base URL (optional, overrides provider)</label>
                  <input value={s.baseURL ?? ''} onChange={e => setStage(stage, { baseURL: e.target.value })} placeholder="http://localhost:4000/v1" />
                </div>
              </div>
            )
          })}
          <div style={{ marginTop: 10 }}>
            <button className="primary" onClick={saveMatrix}>Save engine matrix</button>
          </div>
        </div>

        <div className="card">
          <h3>Projects (NAI-Lattice)</h3>
          <p className="muted">Projects managed by the canonical engine.</p>
          {projects.length === 0 ? <div className="muted">no projects yet</div> :
            projects.map(p => (
              <div key={p.project_id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <b>{p.name || p.project_id}</b>
                <div className="muted mono" style={{ fontSize: 11 }}>{p.repo_path || 'no repo'}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}