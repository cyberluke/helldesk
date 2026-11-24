import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Copy, FolderGit2, Sparkles,
  ArrowRight, LoaderCircle, Check, Layers, FileText, X,
} from '@/lib/icons'
import { Link, useParams } from 'react-router-dom'
import {
  readOperatorRoom, setDepartmentLocalRepo, createTask as createTaskLocal, enhanceTaskSpec,
  type Delivery, type EnhancedSpec, type EnhanceMode, type EnhanceResult, type Enforcer,
  type SourceRepoInput, type RoomState, type TaskType, type WriteTarget,
} from '../lib/engine'
import TaskShapeMatrix from './TaskShapeMatrix'
import EnhancePreview from './EnhancePreview'
import {
  attachmentLimitMessage,
  attachmentSpecBlock,
  isSupportedAttachment,
  uploadAttachment,
  type AttachmentMode,
  type DropAttachment,
} from '../lib/attachments'

// TaskStudio — the modern HITL launchpad for the local tier.
// One coherent surface to:
//   1. configure the two-repo transform (destination repo + read-only SOURCE repo),
//   2. write the task spec, and
//   3. pick WHICH enforcer enforces it (ExcellenceGovernor / Souls / Reviewer).
// The enforcer picker writes metadata.break_room_controls, and the task + spec +
// enforcer land in ONE create call. Style matches the HELLDESK glass theme.

interface RepoRow { id: string; path: string; label?: string; branch?: string }

const ENFORCER_INFO: Array<{ key: Enforcer; name: string; desc: string }> = [
  {
    key: 'auto', name: 'Department policy',
    desc: 'No override — the task runs under the department/workstation default colony behavior. Pick this to keep it simple.',
  },
  {
    key: 'excellenceGovernor', name: 'Build + ExcellenceGovernor',
    desc: 'Implementers keep building. The ExcellenceGovernor independently reviews each revision and sends findings back for correction. Reviewer A/B stay OFF unless you enable them per task in Kanban.',
  },
  {
    key: 'soul', name: 'HELLDESK Souls',
    desc: 'The colony dispatches soul/qualityAssurance agents to implement the ticket against the local repo.',
  },
  {
    key: 'reviewer', name: 'HELLDESK Reviewer',
    desc: 'Independent Reviewer A + Reviewer B verify the produced work with grounded, provenanced evidence. Governor adjudication stays off unless enabled per task.',
  },
  {
    key: 'reviewerAndGovernor', name: 'Reviewer A/B + Governor',
    desc: 'Reviewer A + Reviewer B verify the work and the ExcellenceGovernor adjudicates each revision before it lands — the full independent review stack.',
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
  const [enforcer, setEnforcer] = useState<Enforcer>('excellenceGovernor')
  const [workstationId, setWorkstationId] = useState('')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [tasks, setTasks] = useState<RoomState['tickets']>([])
  const [dependencyError, setDependencyError] = useState('')
  const [reviewMode, setReviewMode] = useState<'inherit' | 'ReviewThenLand' | 'ReviewAndMerge'>('inherit')
  const [engineOvers, setEngineOvers] = useState<{ engine: string; providerID?: string; modelID?: string; baseURL?: string }>({ engine: '' })
  const [taskBusy, setTaskBusy] = useState(false)
  const [taskMsg, setTaskMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [createdTicketId, setCreatedTicketId] = useState('')
  const [attachments, setAttachments] = useState<DropAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  // Synchronous guard: `taskBusy` only disables the button after a re-render, so
  // two clicks in the same tick could submit twice without this latch.
  const createLock = useRef(false)

  const readyAttachments = useMemo(
    () => attachments.flatMap((row) => (row.manifest ? [{ ...row.manifest, mode: row.mode }] : [])),
    [attachments],
  )
  const attachmentsBusy = attachments.some(
    (row) => row.status === 'extracting' || row.status === 'uploading',
  )
  const attachmentErrors = attachments.some((row) => row.status === 'error')

  const processAttachment = async (localId: string, file: File, mode: AttachmentMode) => {
    try {
      const manifest = await uploadAttachment(departmentId, file, mode)
      setAttachments((current) =>
        current.map((row) =>
          row.localId === localId ? { ...row, status: 'ready', manifest } : row,
        ),
      )
    } catch (error) {
      setAttachments((current) =>
        current.map((row) =>
          row.localId === localId
            ? {
                ...row,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
              }
            : row,
        ),
      )
    }
  }

  const addAttachmentFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files).filter(isSupportedAttachment)
    setAttachmentError('')
    if (!incoming.length) {
      setAttachmentError('Only images and PDFs are supported.')
      return
    }
    const available = Math.max(0, 8 - attachments.length)
    if (incoming.length > available) {
      setAttachmentError(
        attachmentLimitMessage(attachments.length + incoming.length) ?? 'Too many attachments.',
      )
    }
    const rows = incoming.slice(0, available).map<DropAttachment>((file) => {
      const kind = file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'pdf' : 'image'
      return {
        localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        kind,
        mode: 'inspiration',
        previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
        status: kind === 'pdf' ? 'extracting' : 'uploading',
      }
    })
    setAttachments((current) => [...current, ...rows])
    for (const row of rows) void processAttachment(row.localId, row.file, row.mode)
  }

  const setAttachmentMode = (localId: string, mode: AttachmentMode) => {
    setAttachments((current) =>
      current.map((row) => (row.localId === localId ? { ...row, mode } : row)),
    )
  }

  const removeAttachment = (localId: string) => {
    setAttachments((current) => {
      const row = current.find((item) => item.localId === localId)
      if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl)
      return current.filter((item) => item.localId !== localId)
    })
  }
  // ── task shape (matrix) + prompt enhancer ──
  const [taskType, setTaskType] = useState<TaskType>('engine')
  const [writeTarget, setWriteTarget] = useState<WriteTarget>('workspace')
  const [delivery, setDelivery] = useState<Delivery>('startup')
  const [taskTypeTouched, setTaskTypeTouched] = useState(false)
  const [writeTargetTouched, setWriteTargetTouched] = useState(false)
  const [enhanceMode, setEnhanceMode] = useState<EnhanceMode>('text')
  const [enhanceBusy, setEnhanceBusy] = useState<EnhanceMode | null>(null)
  const [enhanceResult, setEnhanceResult] = useState<EnhanceResult | null>(null)
  const [enhanceError, setEnhanceError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  useEffect(() => {
    if (!workstationId && workstations.length) setWorkstationId(workstations[0].id)
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

  // Do NOT prefill repository routing from the department config: the operator's
  // filesystem paths must not appear on load (or leak in screenshots). The form
  // starts empty; typing a path and Save repos is an explicit action, and the
  // "wired" confirmation only appears for routing saved in this session.

  const outputRepoAvailable = outputRepo.trim().length > 0

  // Derive task-shape defaults until the operator takes over a row.
  // Output routed → extraction into the output repo; bug language → bugfix;
  // otherwise the studio defaults to an engine task. Delivery starts at startup.
  // A touched row is never overwritten by inference again; clearing the output
  // repo always returns the write target to the workspace because the other
  // cell is disabled.
  useEffect(() => {
    const hasOutput = outputRepo.trim().length > 0
    const inferred: TaskType = hasOutput
      ? 'extraction'
      : /fix|bug|crash|error/i.test(`${title}\n${spec}`) ? 'bugfix' : 'engine'
    const resolvedType = taskTypeTouched ? taskType : inferred
    if (!taskTypeTouched) setTaskType(inferred)
    if (!hasOutput) { setWriteTarget('workspace'); return }
    if (!writeTargetTouched) setWriteTarget(resolvedType === 'extraction' ? 'output_repo' : 'workspace')
  }, [outputRepo, title, spec, taskType, taskTypeTouched, writeTargetTouched])

  const runEnhance = async (mode: EnhanceMode, qaFindings?: string[]) => {
    const routedSources = sources
      .map((source) => ({ ...source, id: source.id.trim(), path: source.path.trim() }))
      .filter((source) => source.id && source.path)
    setEnhanceMode(mode)
    setEnhanceBusy(mode)
    setEnhanceError(null)
    setEnhanceResult(null)
    setPreviewOpen(true)
    if (!workspace.trim()) {
      setEnhanceBusy(null)
      setEnhanceError('Project workspace is required before analysis.')
      return
    }
    if (attachmentsBusy) {
      setEnhanceBusy(null)
      setEnhanceError('Wait for the attachments to finish extracting/uploading before analysis.')
      return
    }
    if (attachmentErrors) {
      setEnhanceBusy(null)
      setEnhanceError('Remove the failed attachment(s) before analysis.')
      return
    }
    // Analyze profiles the routed repos, so persist the visible routing first.
    // Saving creates/initialises a new workspace (input = output when no output
    // repo is set); this prevents the enhancer CLI from running on an
    // uninitialised directory and hanging.
    const routing = await setDepartmentLocalRepo(departmentId, {
      repoPath: workspace.trim(),
      sourceRepos: routedSources,
      ...(outputRepo.trim() ? {
        outputRepo: { repo_path: outputRepo.trim(), init_if_missing: outputReady },
      } : {}),
    })
    if (routing?.success !== true) {
      setEnhanceBusy(null)
      setEnhanceError(routing?.error || 'Repository routing could not be saved. Analyze was not started.')
      return
    }
    setSavedCfg({ ws: workspace.trim(), output: outputRepo.trim() || undefined, outputReady, sources: routedSources })
    const result = await enhanceTaskSpec({
      mode,
      title: title.trim(),
      spec: spec.trim(),
      workspace: workspace.trim(),
      outputRepo: outputRepo.trim() || undefined,
      writeTarget: outputRepo.trim() ? writeTarget : 'workspace',
        taskType,
        delivery,
        sources: routedSources,
        attachments: readyAttachments,
        qaFindings,
      })
    setEnhanceBusy(null)
    setEnhanceResult(result)
    if (!result.ok || !result.enhanced) {
      setEnhanceError(result.error ?? `Enhancer failed (HTTP ${result.status}).`)
    }
  }

  // Apply only on explicit operator action; never auto-applies and never creates.
  const applyEnhancement = (enhanced: EnhancedSpec) => {
    setSpec(enhanced.spec)
    if (!title.trim() && enhanced.title) setTitle(enhanced.title)
    if (enhanced.taskType) { setTaskType(enhanced.taskType); setTaskTypeTouched(true) }
    if (enhanced.writeTarget === 'workspace') {
      setWriteTarget('workspace'); setWriteTargetTouched(true)
    } else if (enhanced.writeTarget === 'output_repo' && outputRepo.trim()) {
      setWriteTarget('output_repo'); setWriteTargetTouched(true)
    }
    if (enhanced.delivery) setDelivery(enhanced.delivery)
    setPreviewOpen(false)
  }

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
    if (createLock.current) return
    if (!workstationId || !workspace.trim() || !title.trim() || !spec.trim()) return
    if (attachmentsBusy) {
      setTaskMsg({ ok: false, text: 'Wait for the attachments to finish extracting/uploading.' })
      return
    }
    if (attachmentErrors) {
      setTaskMsg({ ok: false, text: 'Remove the failed attachment(s) before creating the task.' })
      return
    }
    createLock.current = true
    setTaskBusy(true); setTaskMsg(null); setCreatedTicketId('')
    try {
      // Launch uses the routing visible in this form, never a stale saved target.
      if (workspace.trim()) {
        const routing = await setDepartmentLocalRepo(departmentId, {
          repoPath: workspace.trim(),
          sourceRepos: sources.filter(source => source.id && source.path.trim()),
          ...(outputRepo.trim() ? { outputRepo: { repo_path: outputRepo.trim(), init_if_missing: outputReady } } : {}),
        })
        if (routing?.success !== true) {
          setTaskMsg({ ok: false, text: routing?.error || 'Repository routing could not be saved. No task was created.' })
          return
        }
      }
      const submittedEnforcer = enforcer
      const prerequisiteCount = dependsOn.length
      const specWithAttachments = [spec.trim(), attachmentSpecBlock(readyAttachments)]
        .filter(Boolean)
        .join('\n')
      const res = await createTaskLocal(departmentId, workstationId, {
        title: title.trim() || 'Untitled task',
        spec: specWithAttachments,
        enforcer,
        review_mode: reviewMode === 'inherit' ? undefined : reviewMode,
        depends_on: dependsOn,
        attachments: readyAttachments,
        engineMatrix: engineOvers.engine ? { mutation: engineOvers } : undefined,
      })
      if (res?.success !== true) {
        setTaskMsg({ ok: false, text: `Could not create task: ${res?.error ?? 'unknown'}` })
        return
      }
      const created = (res.data ?? {}) as { ticket_id?: string; ticketId?: string }
      const createdId = created.ticket_id ?? created.ticketId ?? ''
      setCreatedTicketId(createdId)
      // Reset the NEW-TASK form immediately: the button becomes disabled again
      // (empty title/spec), so a second click cannot duplicate the task. The
      // repository routing stays visible for the next task in the same workspace.
      setTitle('')
      setSpec('')
      setDependsOn([])
      setTaskType('engine'); setTaskTypeTouched(false)
      setWriteTarget('workspace'); setWriteTargetTouched(false)
      setDelivery('startup')
      setEnforcer('excellenceGovernor')
      setReviewMode('inherit')
      setEngineOvers({ engine: '' })
      setEnhanceMode('text')
      setEnhanceResult(null)
      setEnhanceError(null)
      setPreviewOpen(false)
      for (const row of attachments) {
        if (row.previewUrl) URL.revokeObjectURL(row.previewUrl)
      }
      setAttachments([])
      setTaskMsg({
        ok: true,
        text: `Task created${createdId ? ` (${createdId.slice(0, 8)})` : ''}${prerequisiteCount ? ` after ${prerequisiteCount} prerequisite${prerequisiteCount > 1 ? 's' : ''}` : ''}. ${enforcerLabel(submittedEnforcer)} is assigned; steer from the Operator-console.`,
      })
    } finally {
      setTaskBusy(false)
      createLock.current = false
    }
  }

  const srcStats = useMemo(() => {
    const s = savedCfg.sources
    return { count: s.length, sum: s.map((x) => x.id).join(', ') }
  }, [savedCfg])

  const selected = ENFORCER_INFO.find((e) => e.key === enforcer)!

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
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            A plain directory is auto-initialised as a git repo. Leave Output repo empty to work in it
            directly — input = output.
          </div>
          {repoMsg && (
            <div className={'ts-toast ' + (repoMsg.ok ? 'ts-ok' : 'ts-bad')} style={{ marginTop: 10 }}>
              {repoMsg.text}
            </div>
          )}

          <div className="ts-divider" />
          <label className="ts-label">Output repo <span className="ts-opt-note">(optional — leave empty for input = output)</span></label>
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
            {workstations.map(workstation => <option key={workstation.id} value={workstation.id}>{workstation.name}</option>)}
          </select>

          <div className="ts-divider" style={{ margin: '16px 0 14px' }} />
          <label className="ts-label">Task shape</label>
          <div className="ts-hint" style={{ fontSize: 12, margin: '0 0 10px' }}>
            Shape the work before you write the spec. The AI row rewrites or analyzes the spec from this shape and the routed repos — nothing is applied until you accept it.
          </div>
          <TaskShapeMatrix
            taskType={taskType}
            writeTarget={outputRepoAvailable ? writeTarget : 'workspace'}
            delivery={delivery}
            enforcer={enforcer}
            outputRepoAvailable={outputRepoAvailable}
            enhanceBusy={enhanceBusy}
            onEnhance={(mode) => { void runEnhance(mode) }}
            onTaskType={(type) => { setTaskType(type); setTaskTypeTouched(true) }}
            onWriteTarget={(target) => { setWriteTarget(target); setWriteTargetTouched(true) }}
            onDelivery={setDelivery}
            onEnforcer={setEnforcer}
          />
          <div className="ts-hint" style={{ fontSize: 12, marginTop: 8 }}>— {selected.desc}</div>

          {enforcer !== 'soul' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
              <label className="ts-label" style={{ margin: 0 }}>Review mode</label>
              <button className={'ts-mode' + (reviewMode === 'inherit' ? ' on' : '')}
                onClick={() => setReviewMode('inherit')}>Department default</button>
              <button className={'ts-mode' + (reviewMode === 'ReviewThenLand' ? ' on' : '')}
                onClick={() => setReviewMode('ReviewThenLand')}>Review then land</button>
              <button className={'ts-mode' + (reviewMode === 'ReviewAndMerge' ? ' on' : '')}
                onClick={() => setReviewMode('ReviewAndMerge')}>Review & auto-merge</button>
            </div>
          )}

          <label className="ts-label" style={{ marginTop: 14 }}>Spec</label>
          <textarea className="ts-input ts-area" value={spec}
            onChange={(e) => setSpec(e.target.value)}
            placeholder={'Describe the input → output work: what to read from the input repo(s), what to build in the output repo, the contracts to preserve, and how to prove it (tests / evidence).'} />

          <label className="ts-label" style={{ marginTop: 14 }}>
            Input attachments <span className="ts-opt-note">(images / PDF, optional)</span>
          </label>
          <div
            className="ts-attachments"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              addAttachmentFiles(event.dataTransfer.files)
            }}
          >
            <input
              id="task-attachment-input"
              type="file"
              multiple
              accept="image/*,application/pdf"
              style={{ display: 'none' }}
              onChange={(event) => {
                if (event.target.files) addAttachmentFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <label htmlFor="task-attachment-input" className="ts-attachment-add">
              + Attach image or PDF
            </label>
            <p className="ts-attachment-hint">
              Image mode: <strong>inspiration</strong> (style/mechanic reference) or{' '}
              <strong>pixel-perfect</strong> (screenshot comparison required). PDFs become
              page-referenced markdown + page images.
            </p>
            {attachments.length > 0 && (
              <div className="ts-attachment-list">
                {attachments.map((row) => (
                  <div
                    key={row.localId}
                    className={'ts-attachment' + (row.status === 'error' ? ' error' : '')}
                  >
                    {row.kind === 'image' ? (
                      row.previewUrl ? (
                        <img src={row.previewUrl} alt={row.file.name} className="ts-attachment-thumb" />
                      ) : (
                        <span className="ts-attachment-ph"><FileText size={18} /></span>
                      )
                    ) : row.manifest?.pages?.[0]?.url ? (
                      <img src={row.manifest.pages[0].url} alt="PDF page 1" className="ts-attachment-thumb" />
                    ) : (
                      <span className="ts-attachment-ph"><FileText size={18} /></span>
                    )}
                    <div className="ts-attachment-body">
                      <strong>{row.file.name}</strong>
                      <small>
                        {row.kind.toUpperCase()}
                        {row.manifest?.page_count ? ` · ${row.manifest.page_count} page${row.manifest.page_count === 1 ? '' : 's'}` : ''} ·{' '}
                        {row.status === 'extracting'
                          ? 'extracting PDF…'
                          : row.status === 'uploading'
                            ? 'uploading…'
                            : row.status === 'ready'
                              ? 'ready'
                              : 'failed'}
                      </small>
                      {row.error && <span className="ts-attachment-error">{row.error}</span>}
                      <div className="ts-attachment-modes" role="group" aria-label="Attachment semantics">
                        {(['inspiration', 'requirement'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            className={'ts-attachment-mode' + (row.mode === mode ? ' selected' : '')}
                            onClick={() => setAttachmentMode(row.localId, mode)}
                          >
                            {mode === 'inspiration' ? 'Inspiration' : 'Pixel-perfect'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ts-attachment-remove"
                      aria-label={`Remove ${row.file.name}`}
                      onClick={() => removeAttachment(row.localId)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachmentError && (
              <div className="ts-toast ts-bad" role="status" style={{ marginTop: 8 }}>
                {attachmentError}
              </div>
            )}
          </div>

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
              <input className="ts-mode" value={engineOvers.modelID ?? ''} onChange={e => setEngineOvers(o => ({ ...o, modelID: e.target.value }))} placeholder="model (empty = inherit Kilo model)" style={{ minWidth: 220, background: 'transparent', color: 'var(--text2)', padding: '4px 8px', borderRadius: 8, border: '1px solid var(--line)' }} />
            )}
          </div>

          <div className="ts-divider" style={{ margin: '16px 0 14px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="ts-create" onClick={createTask} disabled={taskBusy || attachmentsBusy || !workstationId || !workspace.trim() || !title.trim() || !spec.trim()}>
              {taskBusy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}
              Create task{enforcer === 'auto' ? '' : ` · ${enforcerLabel(enforcer)}`}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>agents are autonomous; you steer live from BreakRoom Chat</span>
          </div>
          {taskMsg && (
            <div className={'ts-toast ' + (taskMsg.ok ? 'ts-ok' : 'ts-bad')} style={{ marginTop: 12 }}>
              <span role="status">{taskMsg.text}</span>
              {taskMsg.ok && createdTicketId && (
                <Link
                  to={`/helldesk/${departmentId}/tickets`}
                  style={{ marginLeft: 10, color: 'inherit', textDecoration: 'underline', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  Open Kanban <ArrowRight size={13} />
                </Link>
              )}
            </div>
          )}
        </section>
      </div>

      <EnhancePreview
        open={previewOpen}
        loading={enhanceBusy !== null}
        error={enhanceError}
        result={enhanceResult}
        mode={enhanceMode}
        shape={{ taskType, writeTarget: outputRepoAvailable ? writeTarget : 'workspace', delivery, enforcer }}
        onUse={applyEnhancement}
        onRegenerate={(qaFindings) => { void runEnhance(enhanceMode, qaFindings) }}
        onCancel={() => setPreviewOpen(false)}
      />

      <style>{TS_CSS}</style>
    </div>
  )
}

/* fetch workstations to pick a target workstation for the task */
function useWorkstations(): Array<{ id: string; name: string }> {
  const { departmentId = '' } = useParams()
  const [workstations, setWorkstations] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const room = await readOperatorRoom(departmentId)
        if (alive) {
          // Display the operator-facing NAME; the id stays the option value.
          setWorkstations(
            room.workstations
              .map(workstation => {
                const id = workstation.id || workstation.workstation_id || ''
                return { id, name: workstation.name || id }
              })
              .filter(workstation => workstation.id),
          )
        }
      } catch { /* room error is displayed by dependency loading */ }
    }
    load()
    const timer = setInterval(load, 10000)
    return () => { alive = false; clearInterval(timer) }
  }, [departmentId])
  return workstations
}

function enforcerLabel(e: Enforcer): string {
  return ENFORCER_INFO.find((x) => x.key === e)?.name ?? e
}

const TS_CSS = `
.ts-grid { display: grid; grid-template-areas: 'repos task'; grid-template-columns: 1fr 1.15fr; gap: 18px; align-items: start; }
@media (max-width: 980px) { .ts-grid { grid-template-areas: 'repos' 'task'; grid-template-columns: 1fr; } }
.ts-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r);
  padding: 18px 20px 20px; backdrop-filter: blur(12px); box-shadow: var(--shadow);
}
.ts-card-h { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
.ts-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #b9c6dd; margin: 0 0 6px; font-weight: 600; }
.ts-hint { color: #aebbd2; }
.ts-input {
  background: var(--bg2); border: 1px solid var(--line); color: var(--fg); border-radius: 9px;
  padding: 9px 11px; font-size: 13px; outline: none; transition: 0.14s;
}
.ts-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(110,231,183,0.14); }
.ts-area { min-height: 96px; resize: vertical; line-height: 1.5; }
.ts-attachments { border: 1px dashed var(--line); border-radius: 10px; padding: 10px; background: rgba(255,255,255,.015); }
.ts-attachment-add { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--accent); cursor: pointer; border: 1px solid rgba(134,239,172,.25); border-radius: 8px; padding: 6px 10px; background: rgba(134,239,172,.06); }
.ts-attachment-hint { margin: 7px 0 0; font-size: 10px; line-height: 1.5; color: var(--muted); }
.ts-attachment-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.ts-attachment { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--line); border-radius: 10px; background: rgba(0,0,0,.16); padding: 8px; }
.ts-attachment.error { border-color: rgba(248,113,113,.35); }
.ts-attachment-thumb { width: 72px; height: 54px; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); background: #000; flex: none; }
.ts-attachment-ph { width: 72px; height: 54px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); flex: none; }
.ts-attachment-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ts-attachment-body strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-attachment-body small { font-size: 10px; color: var(--muted); }
.ts-attachment-error { font-size: 10px; color: var(--bad); }
.ts-attachment-modes { display: flex; gap: 4px; margin-top: 3px; }
.ts-attachment-mode { font-size: 9px; padding: 2px 6px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--muted); cursor: pointer; }
.ts-attachment-mode.selected { border-color: rgba(134,239,172,.35); background: rgba(134,239,172,.1); color: var(--accent); }
.ts-attachment-remove { border: none; background: transparent; color: var(--muted); cursor: pointer; padding: 2px; }
.ts-attachment-remove:hover { color: var(--bad); }
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
.ts-shape-wrap { display: grid; gap: 8px; }
.ts-matrix { display: grid; gap: 8px; }
.ts-matrix-row { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 8px; align-items: start; }
.ts-matrix-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 8px; min-width: 0; }
.ts-matrix-chip {
  align-self: start; display: inline-flex; align-items: center; gap: 6px; min-width: 0;
  padding: 7px 9px; background: var(--bg2); border: 1px solid var(--line); border-radius: 9px;
  color: #c7d2e5; font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
}
.ts-matrix-chip svg { flex: none; }
.ts-shape {
  display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; min-height: 34px; padding: 7px 9px;
  background: var(--bg2); border: 1px solid var(--line); border-radius: 9px; color: #c7d2e5;
  font-size: 11.5px; font-weight: 600; text-align: left; cursor: pointer; transition: 0.14s;
}
.ts-shape svg { flex: none; }
.ts-shape:hover:not(:disabled) { border-color: var(--fg); color: var(--fg); }
.ts-shape.on { color: var(--accent); border-color: var(--accent); background: rgba(110, 231, 183, 0.1); }
.ts-shape:disabled { opacity: 0.42; cursor: not-allowed; }
.ts-shape:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ts-shape-action { border-style: dashed; }
.ts-shape-slot { display: flex; min-width: 0; }
.ts-shape-slot .ts-shape { width: 100%; pointer-events: none; }
.ts-shape-label { min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; line-height: 1.25; }
.ts-legend-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ts-legend-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; color: #c7d2e5; }
.ts-legend-toggle svg { flex: none; }
.ts-legend-hint { font-size: 11px; color: #aebbd2; }
.ts-legend {
  border: 1px solid var(--line); border-radius: 11px; background: var(--bg2);
  padding: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px;
}
.ts-legend-group { display: grid; gap: 7px; align-content: start; }
.ts-legend-group h5 { margin: 0 0 2px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #c7d2e5; }
.ts-legend-item { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.4; }
.ts-legend-item > svg { flex: none; color: var(--muted); margin-top: 2px; }
.ts-legend-item strong { display: block; font-weight: 600; color: var(--fg); }
.ts-legend-item span { color: #aebbd2; }
.ts-legend-note { grid-column: 1 / -1; margin: 0; padding-top: 10px; border-top: 1px solid var(--line); font-size: 11.5px; color: #aebbd2; line-height: 1.45; }
.ts-legend-note strong { color: var(--fg); }
@media (max-width: 760px) {
  .ts-matrix-row { grid-template-columns: 1fr; }
  .ts-matrix-chip { justify-self: start; }
  .ts-legend { grid-template-columns: 1fr; }
}
.ts-divider { height: 1px; background: linear-gradient(90deg, transparent, var(--line), transparent); }
.ts-optional {
  font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--accent); border: 1px solid rgba(110,231,183,0.3); border-radius: 999px; padding: 1px 8px;
  margin-left: 6px; vertical-align: 1px;
}
.ts-opt-note { font-size: 10px; text-transform: none; letter-spacing: 0; color: var(--muted); font-weight: 500; }
.ts-mode { background: var(--bg2); border: 1px solid var(--line); color: #c7d2e5; border-radius: 999px; padding: 6px 13px; font-size: 12px; cursor: pointer; transition: 0.14s; }
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

