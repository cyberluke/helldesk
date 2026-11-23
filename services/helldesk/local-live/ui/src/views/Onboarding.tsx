import { useState } from 'react'
import { Check, ChevronRight } from '@/lib/icons'
import { engine } from '../lib/engine'

// Onboarding — original HELLDESK wizard: Step Model → Name → Repo → Task,
// driving the canonical engine to create a project + primary ticket.
const STEPS = ['Model', 'Name', 'Repo', 'Task', 'Done'] as const

export default function Onboarding() {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [repo, setRepo] = useState('')
  const [task, setTask] = useState('')
  const [creating, setCreating] = useState(false)
  const [ok, setOk] = useState(false)

  const next = async () => {
    if (step === 3) {
      // create project + primary on the canonical engine
      setCreating(true)
      const p = await engine.projectCreate(name.trim() || 'onboarding-project', repo.trim() || undefined)
      if (p?.project_id && task.trim()) {
        await engine.projectAddPrimary(p.project_id, task.trim())
      }
      setCreating(false)
      setOk(true)
    }
    if (step < 4) setStep(s => s + 1)
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="section-title" style={{ margin: '0 0 12px' }}>🚀 Onboarding wizard</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {STEPS.map((s, i) => (
          <div key={s} className="chip" style={{ opacity: i <= step ? 1 : 0.4, display: 'flex', alignItems: 'center', gap: 4 }}>
            {i < step && <Check size={11} />}{s}
          </div>
        ))}
      </div>

      <div className="card">
        {step === 0 && (
          <div>
            <h3>Pick the model profile</h3>
            <p className="muted">Real model via the canonical NAI-Lattice engine (gateway or Codex).</p>
            <div className="chip ok" style={{ padding: '8px 14px' }}>Kilo default model (kilo.jsonc)</div>
          </div>
        )}
        {step === 1 && (
          <div>
            <h3>Name your department / project</h3>
            <div className="field">
              <label>Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. kaizen-workstation" />
            </div>
          </div>
        )}
        {step === 2 && (
          <div>
            <h3>Attach a repo (optional)</h3>
            <div className="field">
              <label>Repo path / git URL</label>
              <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="C:\dev\myproject  or  git@host:org/repo" />
            </div>
          </div>
        )}
        {step === 3 && (
          <div>
            <h3>First task</h3>
            <div className="field">
              <label>What should the department build / verify?</label>
              <input value={task} onChange={e => setTask(e.target.value)} placeholder="e.g. refactor the http client and add a real test" />
            </div>
          </div>
        )}
        {step === 4 && (
          <div>
            <h3 style={{ color: ok ? 'var(--ok)' : 'var(--muted)' }}>{ok ? 'Department created ✓' : 'Finish to create the department'}</h3>
            <p className="muted">The project and its first primary ticket were queued on the canonical engine — open Overview / Ticket Board to watch it run.</p>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 20, alignItems: 'center' }}>
          <button className="ghost" onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0}>← Back</button>
          <div style={{ flex: 1 }} />
          {step < 4 && (
            <button className="primary" onClick={next} disabled={creating}>
              {step === 3 ? (creating ? 'Creating…' : 'Create department') : 'Next'}<ChevronRight size={15} style={{ verticalAlign: '-3px' }} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}