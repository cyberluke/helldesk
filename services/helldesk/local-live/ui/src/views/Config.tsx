import { useCallback, useEffect, useState } from 'react'
import { Play, Plus, RefreshCw, Trash2, Save, ToggleLeft, ToggleRight } from '@/lib/icons'
import { runtimeConfig, type EngineConfigResponse, type EngineWorkspace } from '../lib/engine'
import KiloConnections from './KiloConnections'

/**
 * Review-engine runtime config — discrete CRUD on the control-plane /v1/config
 * store (via the entry.ts `/api/v1/*` proxy). Surfaces the knobs the original
 * HTML dashboard exposes as a JSON blob as first-class create/update/delete:
 *
 *   - Workspaces (multi-repo): add/remove/enable a review subject.
 *   - Concurrency: maxConcurrentJobs + maxReviewersPerJob (no more serializing).
 *   - Autonomy: the master enabled switch + mutation runner transport.
 *   - Policy/runner: the reviewer transport + per-role models (A / B / adjudicator).
 *
 * Every control submits the *effective* config back through PATCH so a change
 * is validated, applied live where safe, and persisted for restart — the exact
 * contract the /v1/config API + config-runtime store guarantee.
 */
export default function ConfigView() {
  const [resp, setResp] = useState<EngineConfigResponse>({})
  const [path, setPath] = useState('…')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [saveErr, setSaveErr] = useState('')

  // Editable form state (seeded from GET, submitted via PATCH).
  const [workspaces, setWorkspaces] = useState<EngineWorkspace[]>([])
  const [newWsPath, setNewWsPath] = useState('')
  const [maxConcurrentJobs, setMaxConcurrentJobs] = useState(2)
  const [maxReviewersPerJob, setMaxReviewersPerJob] = useState(2)
  const [autonomyEnabled, setAutonomyEnabled] = useState(false)
  const [mutationRunner, setMutationRunner] = useState('kilo')
  const [runner, setRunner] = useState('kilo')

  const load = useCallback(async () => {
    setLoading(true)
    const r = await runtimeConfig.get()
    setResp(r)
    setPath(r.path ?? '…')
    const cfg = r.config ?? {}
    const daemon = cfg.daemon ?? {}
    const autonomy = cfg.autonomy ?? {}
    const policy = cfg.policy ?? {}
    setWorkspaces(cfg.workspaces ?? [])
    setMaxConcurrentJobs(typeof daemon.maxConcurrentJobs === 'number' ? daemon.maxConcurrentJobs : 2)
    setMaxReviewersPerJob(typeof daemon.maxReviewersPerJob === 'number' ? daemon.maxReviewersPerJob : 2)
    setAutonomyEnabled(!!autonomy.enabled)
    setMutationRunner(typeof autonomy.mutationRunner === 'string' ? autonomy.mutationRunner : 'kilo')
    setRunner(typeof policy.runner === 'string' ? policy.runner : 'kilo')
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    setSaving(true)
    setSavedMsg('')
    setSaveErr('')
    const patch = {
      daemon: { maxConcurrentJobs, maxReviewersPerJob },
      autonomy: { enabled: autonomyEnabled, mutationRunner },
      policy: { runner },
      workspaces,
    }
    const r = await runtimeConfig.patch(patch)
    setSaving(false)
    if (r.ok) {
      setSavedMsg(`saved · live: ${r.applied_live.length} · restart: ${r.applies_on_restart.length}`)
      load()
    } else {
      const why = r.rejected?.map((x) => `${x.field}: ${x.issues.join('; ')}`).join(' | ') || 'config rejected'
      setSaveErr(why)
    }
  }

  const addWorkspace = () => {
    const p = newWsPath.trim()
    if (!p) return
    setWorkspaces((ws) => {
      // Upsert by exact path — never duplicate a repo, just enable it.
      const existing = ws.some((w) => normalizedPath(w.path) === normalizedPath(p))
      if (existing) return ws.map((w) => (normalizedPath(w.path) === normalizedPath(p) ? { ...w, enabled: true } : w))
      return [...ws, { path: p, enabled: true, include: [], exclude: defaultExcludes() }]
    })
    setNewWsPath('')
  }

  const updateWorkspace = (i: number, patch: Partial<EngineWorkspace>) =>
    setWorkspaces((ws) => ws.map((w, idx) => (idx === i ? { ...w, ...patch } : w)))

  const removeWorkspace = (i: number) => setWorkspaces((ws) => ws.filter((_, idx) => idx !== i))

  const apply = (field: string): boolean => (resp.meta?.daemon?.[field] === 'live' || resp.meta?.autonomy?.[field] === 'live')

  return (
    <div>
      <KiloConnections />
      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px' }}>
        ⚙ Engine config
        <button className="ghost" onClick={load} style={{ padding: '5px 10px' }} title="Reload from control plane"><RefreshCw size={13} /></button>
        <span className="muted mono" style={{ fontSize: 11, marginLeft: 'auto', color: 'var(--muted)' }}>{path}</span>
      </div>

      {loading && <div className="muted">loading config…</div>}

      {!loading && !resp.config && (
        <div className="card" style={{ maxWidth: 640 }}>
          <span className="muted">Control plane unreachable via /api/v1/config — is the local daemon running?</span>
        </div>
      )}

      {!loading && resp.config && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Concurrency */}
          <div className="card">
            <h3>⚡ Concurrency</h3>
            <p className="muted">Max parallel review jobs. Default is now 2 so a fresh daemon does not serialize.</p>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', marginTop: 10 }}>
              <div className="field">
                <label>Max concurrent jobs {apply('maxConcurrentJobs') ? <span className="chip ok">LIVE</span> : <span className="chip warn">RESTART</span>}</label>
                <input type="number" min={1} value={maxConcurrentJobs} onChange={(e) => setMaxConcurrentJobs(Number(e.target.value) || 1)} />
              </div>
              <div className="field">
                <label>Max reviewers / job {apply('maxReviewersPerJob') ? <span className="chip ok">LIVE</span> : <span className="chip warn">RESTART</span>}</label>
                <input type="number" min={1} max={4} value={maxReviewersPerJob} onChange={(e) => setMaxReviewersPerJob(Number(e.target.value) || 2)} />
              </div>
            </div>
          </div>

          {/* Autonomy */}
          <div className="card">
            <h3>🤖 Autonomy (Ender loop)</h3>
            <p className="muted">Master switch for the scientific-method repair loop. Off by default; a mutation never self-verifies.</p>
            <div style={{ display: 'flex', gap: 24, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <button
                className="ghost"
                onClick={() => setAutonomyEnabled((v) => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                {autonomyEnabled ? <ToggleRight size={16} color="var(--ok)" /> : <ToggleLeft size={16} />}
                <span>{autonomyEnabled ? 'Enabled' : 'Disabled'}</span>
                {apply('enabled') ? <span className="chip ok">LIVE</span> : <span className="chip warn">RESTART</span>}
              </button>
              <div className="field" style={{ minWidth: 200 }}>
                <label>Mutation runner {apply('mutationRunner') ? <span className="chip ok">LIVE</span> : null}</label>
                <select value={mutationRunner} onChange={(e) => setMutationRunner(e.target.value)}>
                  <option value="kilo">kilo (headless SDK)</option>
                  <option value="openai">openai (compliant tools)</option>
                  <option value="codex">codex (ChatGPT CLI)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Reviewer transport */}
          <div className="card">
            <h3>🧪 Reviewer transport</h3>
            <p className="muted">The runner for independent A/B reviewers + adjudicator (read-only; never the mutator).</p>
            <div className="field" style={{ maxWidth: 320, marginTop: 10 }}>
              <label>Runner {apply('runner') ? <span className="chip ok">LIVE</span> : <span className="chip warn">RESTART</span>}</label>
              <select value={runner} onChange={(e) => setRunner(e.target.value)}>
                <option value="kilo">kilo (detached workers)</option>
                <option value="openai">openai (compliant stdio)</option>
                <option value="codex">codex (ChatGPT CLI)</option>
              </select>
            </div>
          </div>

          {/* Workspaces — discrete multi-repo CRUD */}
          <div className="card">
            <h3>🗂 Workspaces <span className="chip">{workspaces.length} repo{workspaces.length === 1 ? '' : 's'}</span></h3>
            <p className="muted">Review subjects. Add a repo path, toggle it on/off, or remove it — no JSON hand-editing.</p>

            <div style={{ display: 'flex', gap: 10, margin: '12px 0', alignItems: 'end', flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: 1, minWidth: 280 }}>
                <label>Repo path</label>
                <input
                  value={newWsPath}
                  onChange={(e) => setNewWsPath(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addWorkspace() }}
                  placeholder="C:\dev\myrepo  or  /home/me/repo"
                />
              </div>
              <button className="primary" onClick={addWorkspace}><Plus size={14} style={{ verticalAlign: '-2px', marginRight: 5 }} />Add workspace</button>
            </div>

            {workspaces.length === 0 ? (
              <div className="muted">no workspaces — add a repo path above to start reviewing changes.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Enabled</th><th>Path</th><th style={{ width: 90 }}></th></tr>
                </thead>
                <tbody>
                  {workspaces.map((w, i) => (
                    <tr key={normalizedPath(w.path) || i}>
                      <td>
                        <input
                          type="checkbox"
                          checked={w.enabled !== false}
                          onChange={(e) => updateWorkspace(i, { enabled: e.target.checked })}
                          title={w.enabled === false ? 'disabled — not reviewed' : 'enabled'}
                        />
                      </td>
                      <td>
                        <code className="mono" style={{ fontSize: 12 }}>{w.path}</code>
                        {w.enabled === false && <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>paused</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="ghost" onClick={() => removeWorkspace(i)} title="Remove this workspace"><Trash2 size={13} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Save bar */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="primary" onClick={save} disabled={saving}><Save size={14} style={{ verticalAlign: '-2px', marginRight: 5 }} />{saving ? 'Saving…' : 'Save config'}</button>
            <button className="ghost" onClick={load}><Play size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />Reload</button>
            {savedMsg && <span className="mono" style={{ fontSize: 12, color: 'var(--ok)' }}>{savedMsg}</span>}
            {saveErr && <span className="mono" style={{ fontSize: 12, color: 'var(--bad)' }}>{saveErr}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function normalizedPath(p: string): string {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function defaultExcludes(): string[] {
  return [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/.kilo/**',
    '**/*.sqlite*',
  ]
}
