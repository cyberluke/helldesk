import { useEffect, useState } from 'react'
import { engine, short } from '../lib/engine'

// SystemTopology — workstations as roots, each with its hooked soul/qualityAssurance/frontDesk
// agents and the primary tickets they carry.
export default function Topology() {
  const [data, setData] = useState<{ projects: any[]; all_primaries: any[]; shifts: any[] }>({ projects: [], all_primaries: [], shifts: [] })

  useEffect(() => {
    const load = async () => {
      const d = await engine.dashboard()
      setData({ projects: d.projects || [], all_primaries: d.all_primaries || [], shifts: d.shifts || [] })
    }
    load()
    const t = setInterval(load, 6000)
    return () => clearInterval(t)
  }, [])

  // Derive "workstation" nodes from shifts -> their tickets, plus any primary assignments.
  const workstations = new Map<string, any>()
  ;(data.shifts || []).forEach(c => {
    const workstation = workstations.get(c.shift_id) || { workstation_id: c.shift_id, agents: [], tickets: [] }
    workstation.tickets.push(...(c.tickets || []))
    workstations.set(c.shift_id, workstation)
  })
  // If no shifts, fall back to a single node from primaries.
  if (workstations.size === 0 && data.all_primaries.length) {
    workstations.set('default', { workstation_id: 'default', agents: [], tickets: data.all_primaries })
  }

  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 12px' }}>🕸 System topology</div>
      {workstations.size === 0 ? (
        <div className="card muted">No workstations/tickets yet — run a dispatch from Overview.</div>
      ) : (
        <div className="topo">
          {Array.from(workstations.values()).map(workstation => (
            <div className="topo-node" key={workstation.workstation_id}>
              <h4>🗂 {short(workstation.workstation_id, 12)}
                <span className="chip">{workstation.tickets.length} tickets</span>
              </h4>
              <div className="links">
                {(workstation.tickets.slice(0, 6) as any[]).map(b => (
                  <span key={b.ticket_id} className={'mono'}>
                    {b.status === 'closed' ? '✓ ' : ''}{short(b.ticket_id, 6)}
                  </span>
                ))}
              </div>
              <div className="links">
                <span className="mono">state: {(workstation.tickets as any[]).some(b => b.status !== 'closed') ? 'active' : 'idle'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}