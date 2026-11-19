import { useEffect, useState } from 'react'
import { local, listColonyMissions, short } from '../lib/engine'

// Transcript — full-QA observability: the durable per-mission agent journal.
// Shows every mutation tool call, file diff, review finding, and mission event
// the engine appended, so an operator can inspect exactly what agents did and
// steer with evidence instead of guessing.
export default function Transcript() {
  const [missions, setMissions] = useState<any[]>([])
  const [selected, setSelected] = useState<string>('')
  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refreshMissions = async () => {
    const m = await listColonyMissions()
    setMissions(Array.isArray(m) ? m : [])
    if (!selected && m?.[0]) setSelected(m[0].mission_id)
  }
  useEffect(() => { void refreshMissions() }, [])

  useEffect(() => {
    if (!selected) return
    let alive = true
    const load = async () => {
      setLoading(true); setErr(null)
      const e = await local.journal({ missionId: selected, limit: 500 })
      if (alive) { setEntries(Array.isArray(e) ? e.reverse() : []) ; setLoading(false) }
    }
    void load()
    const t = setInterval(load, 6000)
    return () => { alive = false; clearInterval(t) }
  }, [selected])

  const kindColor: Record<string, string> = {
    message: 'var(--ok)', tool_call: 'var(--accent)', diff: 'var(--warn)',
    finding: 'var(--bad)', event: 'var(--muted)', error: 'var(--bad)',
  }

  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 12px' }}>
        🧾 Agent Transcript — QA Observability
        <span style={{ float: 'right', fontSize: 12, fontWeight: 400 }}>{entries.length} entries · {loading ? 'refreshing…' : 'live'}</span>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Mission</label>
        <select value={selected} onChange={(e) => setSelected(e.target.value)} style={{ width: '100%', marginTop: 4, padding: 8, background: 'var(--panel)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 8 }}>
          {(missions ?? []).map((m: any) => (
            <option key={m.mission_id} value={m.mission_id}>
              {short(m.objective ?? m.mission_id, 60)} — {m.state}
            </option>
          ))}
        </select>
      </div>

      {err ? <div className="card" style={{ color: 'var(--bad)' }}>{err}</div> : null}

      {entries.length === 0 && !loading ? (
        <div className="card"><div className="section-title">Waiting for entries…</div>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Open or let a mission run; each mutation tool call, file diff, and review verdict will appear here.</p>
        </div>
      ) : null}

      <div className="card">
        <div className="log" style={{ maxHeight: '70vh', overflow: 'auto' }}>
          {entries.map((e, i) => (
            <div key={e.transcript_id ?? i} style={{ marginBottom: 10, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="t">{short(e.created_at ?? '', 19)}</span>
                <span style={{ color: kindColor[e.kind] ?? 'var(--fg)', fontWeight: 600, textTransform: 'uppercase', fontSize: 11 }}>{e.kind}</span>
                {e.role ? <span style={{ color: 'var(--muted)', fontSize: 12 }}>{e.role}</span> : null}
                {e.title ? <span style={{ color: 'var(--fg)', fontSize: 12, marginLeft: 4 }}>{short(e.title, 70)}</span> : null}
              </div>
              <div style={{ fontSize: 13, marginTop: 4, color: 'var(--fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: e.kind === 'diff' ? 'monospace' : 'inherit' }}>
                {e.content || e.title || ''}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}