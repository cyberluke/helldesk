import { useCallback, useEffect, useState } from 'react'
import { Play, Plus, RefreshCw, Trash2, Save, ToggleLeft, ToggleRight } from '@/lib/icons'
import {
  runtimeConfig,
  type ContextBudgetView,
  type EngineConfigResponse,
  type EngineContextConfig,
  type EngineWorkspace,
} from '../lib/engine'
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
  // Per-role reviewer models (blank provider+model = inherit the base model).
  const [reviewerModelA, setReviewerModelA] = useState<RoleModel>({ provider: '', model: '' })
  const [reviewerModelB, setReviewerModelB] = useState<RoleModel>({ provider: '', model: '' })
  const [adjudicatorModel, setAdjudicatorModel] = useState<RoleModel>({ provider: '', model: '' })
  const [governorModel, setGovernorModel] = useState<RoleModel>({ provider: '', model: '' })
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([])

  // Context tier (32K..1M). `auto` lets the daemon detect the model window from
  // kilo.jsonc; an explicit tier/window overrides it. All fields are live.
  const [contextTier, setContextTier] = useState('auto')
  const [contextWindow, setContextWindow] = useState('')
  const [charsPerToken, setCharsPerToken] = useState('4')
  const [promptUtilization, setPromptUtilization] = useState('0.9')
  const [reservedOutput, setReservedOutput] = useState('')
  const [ctxResolution, setCtxResolution] = useState<ContextBudgetView | null>(null)

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
    setReviewerModelA(readRoleModel(policy.reviewerModelA))
    setReviewerModelB(readRoleModel(policy.reviewerModelB))
    setAdjudicatorModel(readRoleModel(policy.adjudicatorModel))
    setGovernorModel(readRoleModel(policy.governorModel))
    setPricingRules(pricingToRules(policy.pricing))
    const ctx = cfg.context ?? {}
    setContextTier(typeof ctx.tier === 'string' ? ctx.tier : 'auto')
    setContextWindow(typeof ctx.contextWindow === 'number' ? String(ctx.contextWindow) : '')
    setCharsPerToken(typeof ctx.charsPerToken === 'number' ? String(ctx.charsPerToken) : '4')
    setPromptUtilization(typeof ctx.promptUtilization === 'number' ? String(ctx.promptUtilization) : '0.9')
    setReservedOutput(typeof ctx.reservedOutputTokens === 'number' ? String(ctx.reservedOutputTokens) : '')
    setCtxResolution(r.context_resolution ?? null)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    setSaving(true)
    setSavedMsg('')
    setSaveErr('')
    const context: EngineContextConfig = { tier: contextTier }
    // Empty/invalid optional inputs mean "clear the override" (null is an
    // explicit removal in the config API; undefined would leave a stale window
    // pinned and keep overriding a newly selected lower tier).
    const windowValue = Number(contextWindow)
    context.contextWindow = contextWindow.trim() && Number.isFinite(windowValue) && windowValue > 0 ? windowValue : null
    const outputValue = Number(reservedOutput)
    context.reservedOutputTokens = reservedOutput.trim() && Number.isFinite(outputValue) && outputValue > 0 ? outputValue : null
    if (charsPerToken.trim()) context.charsPerToken = Number(charsPerToken)
    if (promptUtilization.trim()) context.promptUtilization = Number(promptUtilization)
    const patch = {
      daemon: { maxConcurrentJobs, maxReviewersPerJob },
      autonomy: { enabled: autonomyEnabled, mutationRunner },
      policy: {
        runner,
        reviewerModelA: roleModelPatch(reviewerModelA),
        reviewerModelB: roleModelPatch(reviewerModelB),
        adjudicatorModel: roleModelPatch(adjudicatorModel),
        governorModel: roleModelPatch(governorModel),
        pricing: rulesToPricing(pricingRules),
      },
      context,
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

  const apply = (field: string): boolean =>
    resp.meta?.daemon?.[field] === 'live' ||
    resp.meta?.autonomy?.[field] === 'live' ||
    resp.meta?.context?.[field] === 'live' ||
    resp.meta?.policy?.[field] === 'live'

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
            <div className="native-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', marginTop: 10 }}>
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

          {/* Per-role reviewer models */}
          <div className="card">
            <h3>🎛 Per-role reviewer models</h3>
            <p className="muted">
              Each independent stage can use its own provider/model. Blank provider + model means
              <b> inherit</b> the base reviewer model. The ExcellenceGovernor defaults to the adjudicator model when blank.
            </p>
            <div className="native-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', marginTop: 10 }}>
              <RoleModelFields label="Reviewer A" hint="Correctness & scope" value={reviewerModelA} onChange={setReviewerModelA} live={apply('reviewerModelA')} />
              <RoleModelFields label="Reviewer B" hint="Adversarial failure hunter" value={reviewerModelB} onChange={setReviewerModelB} live={apply('reviewerModelB')} />
              <RoleModelFields label="Adjudicator" hint="A/B reconciliation" value={adjudicatorModel} onChange={setAdjudicatorModel} live={apply('adjudicatorModel')} />
              <RoleModelFields label="ExcellenceGovernor" hint="Single independent review (EG-only policy)" value={governorModel} onChange={setGovernorModel} live={apply('governorModel')} />
            </div>
          </div>

          {/* Token pricing (USD per 1M tokens) */}
          <div className="card">
            <h3>💵 Token pricing (USD / 1M tokens)</h3>
            <p className="muted">
              Turns recorded input/output tokens into a USD cost. Resolution order:
              <b> model → provider → runner → default</b>. A missing price is reported as
              <b> unknown</b>; setting both rates to <b>0</b> is a real <b>$0.0000</b> price for a
              local/free model. Use the <b>$0</b> button on a row for that.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
              <div
                className="muted"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px minmax(220px,1fr) 110px 110px 40px 32px',
                  gap: 6,
                  fontSize: 10,
                }}
              >
                <span>Scope</span>
                <span>Key</span>
                <span>Input $/1M</span>
                <span>Output $/1M</span>
                <span />
                <span />
              </div>
              {pricingRules.length === 0 ? (
                <div className="muted" style={{ fontSize: 11 }}>
                  No prices configured — mission and review costs show as “not priced”.
                </div>
              ) : null}
              {pricingRules.map((rule, index) => (
                <PricingRuleRow
                  key={index}
                  rule={rule}
                  onChange={(next) => setPricingRules((rules) => rules.map((item, i) => (i === index ? next : item)))}
                  onRemove={() => setPricingRules((rules) => rules.filter((_, i) => i !== index))}
                />
              ))}
            </div>
            <button
              className="ghost"
              style={{ marginTop: 8 }}
              onClick={() =>
                setPricingRules((rules) => [...rules, { scope: 'provider', key: '', input: '', output: '' }])
              }
            >
              <Plus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />Add price rule
            </button>
            <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
              Examples: provider <span className="mono">your-provider</span>, model{' '}
              <span className="mono">your-model</span>, runner{' '}
              <span className="mono">kilo</span>.
            </div>
          </div>

          {/* Context tiers — the local AI-first ladder (32K..1M) */}
          <div className="card">
            <h3>🧠 Context tiers <span className="chip">32K → 1M</span></h3>
            <p className="muted">
              Applies to independent reviewers, detached workers and the writable mutation agent.
              <b> auto</b> detects <code className="mono">provider.&lt;id&gt;.models.&lt;model&gt;.limit.context</code> from kilo.jsonc;
              an explicit tier or window overrides it. The KILO_CONFIG_CONTENT transport cap ({ctxResolution?.kiloConfigTransportLimitChars ?? 28000} chars)
              is a Windows limit, not the model context.
            </p>
            <div className="native-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', marginTop: 10 }}>
              <div className="field">
                <label>Context tier {apply('tier') ? <span className="chip ok">LIVE</span> : <span className="chip warn">RESTART</span>}</label>
                <select value={contextTier} onChange={(e) => setContextTier(e.target.value)}>
                  <option value="auto">auto — detect from kilo.jsonc</option>
                  <option value="32k">32K — 32,768 tokens</option>
                  <option value="64k">64K — 65,536 tokens</option>
                  <option value="96k">96K — 98,304 tokens</option>
                  <option value="128k">128K — 131,072 tokens</option>
                  <option value="256k">256K — 262,144 tokens</option>
                  <option value="384k">384K — 393,216 tokens</option>
                  <option value="512k">512K — 524,288 tokens</option>
                  <option value="1m">1M — 1,048,576 tokens</option>
                </select>
              </div>
              <div className="field">
                <label>Explicit window (tokens, optional)</label>
                <input type="number" min={16384} step={1024} value={contextWindow}
                  onChange={(e) => setContextWindow(e.target.value)}
                  placeholder="auto — leave empty to use the tier/detection" />
              </div>
              <div className="field">
                <label>Chars per token</label>
                <input type="number" min={2} max={8} step={0.5} value={charsPerToken}
                  onChange={(e) => setCharsPerToken(e.target.value)} />
              </div>
              <div className="field">
                <label>Prompt utilization (0.25–1)</label>
                <input type="number" min={0.25} max={1} step={0.05} value={promptUtilization}
                  onChange={(e) => setPromptUtilization(e.target.value)} />
              </div>
              <div className="field">
                <label>Reserved output tokens (optional)</label>
                <input type="number" min={1024} step={1024} value={reservedOutput}
                  onChange={(e) => setReservedOutput(e.target.value)}
                  placeholder="default: detected output or 1/8 window" />
              </div>
            </div>
            {ctxResolution && (
              <div className="mono" style={{ marginTop: 12, fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
                effective: <b>{ctxResolution.tier}</b> · {ctxResolution.contextWindow.toLocaleString()} tokens · source <b>{ctxResolution.source}</b>
                {' · '}prompt ≤ {ctxResolution.userPromptCharBudget.toLocaleString()} chars · diff ≤ {ctxResolution.reviewDiffCharBudget.toLocaleString()} chars
                {' · '}output {ctxResolution.outputBudgetTokens.toLocaleString()} tokens
                {ctxResolution.detected?.context ? ` · detected ${ctxResolution.detected.context.toLocaleString()}` : ' · no kilo.jsonc limit detected'}
                {contextWindow.trim() ? ' · explicit window overrides the tier' : ''}
              </div>
            )}
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

type RoleModel = { provider: string; model: string }

type PricingScope = 'model' | 'provider' | 'runner' | 'default'
type PricingRule = { scope: PricingScope; key: string; input: string; output: string }

function pricingToRules(raw: unknown): PricingRule[] {
  const pricing = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const rules: PricingRule[] = []
  const addMap = (scope: 'model' | 'provider' | 'runner', map: unknown) => {
    if (!map || typeof map !== 'object') return
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      const price = value && typeof value === 'object' ? (value as { inputPer1M?: unknown; outputPer1M?: unknown }) : {}
      rules.push({
        scope,
        key,
        input: typeof price.inputPer1M === 'number' ? String(price.inputPer1M) : '',
        output: typeof price.outputPer1M === 'number' ? String(price.outputPer1M) : '',
      })
    }
  }
  addMap('model', pricing.models)
  addMap('provider', pricing.providers)
  addMap('runner', pricing.runners)
  const fallback = pricing.default
  if (fallback && typeof fallback === 'object') {
    const price = fallback as { inputPer1M?: unknown; outputPer1M?: unknown }
    rules.push({
      scope: 'default',
      key: '',
      input: typeof price.inputPer1M === 'number' ? String(price.inputPer1M) : '',
      output: typeof price.outputPer1M === 'number' ? String(price.outputPer1M) : '',
    })
  }
  return rules
}

function rulesToPricing(rules: PricingRule[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const rule of rules) {
    const key = rule.key.trim()
    if (rule.scope !== 'default' && !key) continue
    const input = Number(rule.input)
    const output = Number(rule.output)
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) continue
    const price = { inputPer1M: input, outputPer1M: output }
    if (rule.scope === 'default') {
      out.default = price
    } else {
      const bucket = (out[`${rule.scope}s`] as Record<string, unknown> | undefined) ?? {}
      bucket[key] = price
      out[`${rule.scope}s`] = bucket
    }
  }
  return out
}

function PricingRuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: PricingRule
  onChange: (next: PricingRule) => void
  onRemove: () => void
}) {
  const placeholder =
    rule.scope === 'model'
      ? 'provider/modelID'
      : rule.scope === 'provider'
        ? 'providerID'
        : rule.scope === 'runner'
          ? 'kilo'
          : 'fallback for everything'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(220px,1fr) 110px 110px 40px 32px', gap: 6 }}>
      <select
        value={rule.scope}
        onChange={(event) => {
          const scope = event.target.value as PricingScope
          onChange({ ...rule, scope, key: scope === 'default' ? '' : rule.key })
        }}
      >
        <option value="model">Model</option>
        <option value="provider">Provider</option>
        <option value="runner">Runner</option>
        <option value="default">Default</option>
      </select>
      <input
        value={rule.key}
        disabled={rule.scope === 'default'}
        placeholder={placeholder}
        onChange={(event) => onChange({ ...rule, key: event.target.value })}
      />
      <input
        type="number"
        min="0"
        step="0.0001"
        value={rule.input}
        placeholder="0.00"
        onChange={(event) => onChange({ ...rule, input: event.target.value })}
      />
      <input
        type="number"
        min="0"
        step="0.0001"
        value={rule.output}
        placeholder="0.00"
        onChange={(event) => onChange({ ...rule, output: event.target.value })}
      />
      <button
        className="ghost"
        onClick={() => onChange({ ...rule, input: '0', output: '0' })}
        title="Local / free: set both rates to $0 (a real $0.0000, not 'not priced')"
      >
        $0
      </button>
      <button className="ghost" onClick={onRemove} title="Remove this price rule">
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function readRoleModel(raw: unknown): RoleModel {
  if (!raw || typeof raw !== 'object') return { provider: '', model: '' }
  const value = raw as { providerID?: unknown; modelID?: unknown }
  return {
    provider: typeof value.providerID === 'string' ? value.providerID : '',
    model: typeof value.modelID === 'string' ? value.modelID : '',
  }
}

/** Blank both fields = null (explicitly clear the override). */
function roleModelPatch(value: RoleModel): { providerID: string; modelID: string } | null {
  const providerID = value.provider.trim()
  const modelID = value.model.trim()
  return providerID && modelID ? { providerID, modelID } : null
}

function RoleModelFields({
  label,
  hint,
  value,
  onChange,
  live,
}: {
  label: string
  hint: string
  value: RoleModel
  onChange: (next: RoleModel) => void
  live: boolean
}) {
  return (
    <div className="field">
      <label>
        {label} {live ? <span className="chip ok">LIVE</span> : <span className="chip warn">RESTART</span>}
      </label>
      <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>{hint}</div>
      <input
        value={value.provider}
        onChange={(event) => onChange({ ...value, provider: event.target.value })}
        placeholder="providerID (blank = inherit)"
      />
      <input
        style={{ marginTop: 6 }}
        value={value.model}
        onChange={(event) => onChange({ ...value, model: event.target.value })}
        placeholder="modelID (blank = inherit)"
      />
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
