import { useState } from 'react'
import { Send } from '@/lib/icons'
import { engine } from '../lib/engine'

// FrontDeskChat — real FrontDesk agent turn: send a mission and let the canonical engine
// decompose it into a shift + primary tickets via front_desk_request.
export default function FrontDeskChat() {
  const [msg, setMsg] = useState('')
  const [lines, setLines] = useState<string[]>(['frontDesk › GM — ask me to decompose a mission into a shift and primary tickets.'])
  const [busy, setBusy] = useState(false)

  const send = async () => {
    const text = msg.trim()
    if (!text || busy) return
    setBusy(true)
    setLines(l => [`you › ${text}`, ...l])
    setMsg('')
    const r = await engine.frontDeskRequest(text)
    const body = r?.error ? String(r.error) : JSON.stringify(r?.frontDesk ?? r).slice(0, 320)
    setLines(l => [`frontDesk › ${body.replace(/^frontDesk › /, '')}`, ...l])
    setBusy(false)
  }

  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 12px' }}>💬 FrontDesk chat</div>
      <div className="card" style={{ maxWidth: 860 }}>
        <div className="chat-log">
          {lines.map((line, i) => {
            const frontDesk = line.startsWith('frontDesk ›')
            return (
              <div key={i}>
                <span className={frontDesk ? 'frontDesk' : 'you'}>{(frontDesk ? 'frontDesk ›' : 'you ›')} </span>
                {line.replace(/^(frontDesk ›|you ›) /, '')}
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
          <input
            style={{ flex: 1 }}
            value={msg}
            onChange={e => setMsg(e.target.value)}
            placeholder="decompose: add a /status endpoint, then a cache toggle, then verify"
            onKeyDown={e => e.key === 'Enter' && send()}
            disabled={busy}
          />
          <button className="primary" onClick={send} disabled={busy}><Send size={14} style={{ verticalAlign: '-2px', marginRight: 5 }} />Send</button>
        </div>
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          Runs the real FrontDesk agent over the canonical NAI-Lattice engine — it decomposes into a shift + primary tickets.
        </div>
      </div>
    </div>
  )
}