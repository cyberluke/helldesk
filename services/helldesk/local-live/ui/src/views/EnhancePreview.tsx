import { useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { LoaderCircle, RefreshCw, Check, X } from '@/lib/icons'
import type {
  Delivery, EnhanceAnalysis, EnhanceMode, EnhanceResult, EnhancedSpec, Enforcer, QaReview, TaskType, WriteTarget,
} from '../lib/engine'
import {
  DELIVERY_LABELS, ENHANCE_MODE_LABELS, REVIEW_LABELS, TASK_TYPE_LABELS, WRITE_TARGET_LABELS,
} from './TaskShapeMatrix'

// EnhancePreview — the operator gate between the enhancer and the task spec.
// It shows what the enhancer proposes; nothing is written to the task until the
// operator clicks "Use spec", and nothing here can create a task.

export interface EnhancePreviewShape {
  taskType: TaskType
  writeTarget: WriteTarget
  delivery: Delivery
  enforcer: Enforcer
}

export interface EnhancePreviewProps {
  open: boolean
  loading: boolean
  error: string | null
  result: EnhanceResult | null
  mode: EnhanceMode
  shape: EnhancePreviewShape
  onUse: (enhanced: EnhancedSpec) => void
  onRegenerate: (qaFindings?: string[]) => void
  onCancel: () => void
}

const QA_LABELS: Record<QaReview['verdict'], string> = {
  PASS: 'QA agrees',
  REVISE: 'QA suggests changes',
  REJECT: 'QA found a product concern',
  UNAVAILABLE: 'QA could not run',
}

const QA_SEVERITY_LABELS: Record<'blocker' | 'major' | 'minor', string> = {
  blocker: 'must fix',
  major: 'should fix',
  minor: 'minor',
}

function qaFindingsForRegenerate(qa: QaReview | undefined): string[] {
  return (qa?.findings ?? []).map((finding) =>
    [finding.issue, finding.requiredChange].filter((part): part is string => !!part && part.trim().length > 0).join(' → ')
  ).filter(Boolean)
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return (
    <section className="ep-section">
      <h4>{title}</h4>
      <ul>
        {items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </section>
  )
}

export default function EnhancePreview({
  open, loading, error, result, mode, shape, onUse, onRegenerate, onCancel,
}: EnhancePreviewProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const enhanced = result?.enhanced ?? null
  const qa = result?.qa
  const qaClean = qa?.verdict === 'PASS' && qa.findings.length === 0
  const qaBlocked = !!enhanced && !qaClean
  const effective: EnhancePreviewShape = {
    taskType: enhanced?.taskType ?? shape.taskType,
    writeTarget: enhanced?.writeTarget ?? shape.writeTarget,
    delivery: enhanced?.delivery ?? shape.delivery,
    enforcer: shape.enforcer,
  }
  const meta = result?.meta
  const metaLine = [meta?.providerID, meta?.modelID, typeof meta?.tookMs === 'number' ? `${Math.round(meta.tookMs / 100) / 10}s` : null]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' · ')
  const analyzed: Array<EnhanceAnalysis['workspace']> = result?.analysis
    ? [result.analysis.workspace, ...(result.analysis.output ? [result.analysis.output] : [])]
    : []

  return (
    <div
      className="ep-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Prompt enhancement preview"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) onCancel() }}
    >
      <div className="ep-panel">
        <header className="ep-head">
          <div>
            <div className="ep-eyebrow">TASK STUDIO / ENHANCER</div>
            <div className="ep-title">
              {mode === 'repos' ? 'Repository + spec analysis' : 'Improved task spec'}
            </div>
          </div>
          <button type="button" className="ep-x" onClick={onCancel} aria-label="Close enhancement preview">
            <X size={16} />
          </button>
        </header>

        <div className="ep-shape">
          <span className="ep-chip">{ENHANCE_MODE_LABELS[mode]}</span>
          <span className="ep-chip">{TASK_TYPE_LABELS[effective.taskType]}</span>
          <span className="ep-chip">{WRITE_TARGET_LABELS[effective.writeTarget]}</span>
          <span className="ep-chip">{DELIVERY_LABELS[effective.delivery]}</span>
          <span className="ep-chip">{REVIEW_LABELS[effective.enforcer]}</span>
        </div>

        <div className="ep-body">
          {loading && (
            <div className="ep-loading" role="status">
              <LoaderCircle size={18} className="spin" />
              <div>
                <div className="ep-loading-title">
                  {mode === 'repos' ? 'Reading the routed repos and the spec…' : 'Rewriting the spec…'}
                </div>
                <div className="ep-loading-note">
                  The enhancer and its independent QA can take a few minutes. You can cancel safely at any time.
                </div>
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="ep-error" role="alert">
              <div className="ep-error-title">The enhancer did not return a result.</div>
              <div className="ep-error-text">{error}</div>
            </div>
          )}

          {!loading && !error && !enhanced && (
            <div className="ep-error" role="alert">
              <div className="ep-error-title">No enhanced spec to preview.</div>
              <div className="ep-error-text">Run the enhancer again from the Task shape matrix.</div>
            </div>
          )}

          {!loading && enhanced && (
            <>
              {analyzed.length > 0 && (
                <div className="ep-analysis">
                  {analyzed.map((repo) => (
                    <span key={repo.path} className="ep-chip" title={repo.path}>
                      {repo.path}{repo.frameworks?.length ? ` · ${repo.frameworks.join(', ')}` : ''}
                    </span>
                  ))}
                </div>
              )}

              {qa ? (
                <section className={`ep-qa ${qa.verdict.toLowerCase()}`}>
                  <div className="ep-qa-head">
                    <span className={`ep-qa-verdict ${qa.verdict.toLowerCase()}`}>{QA_LABELS[qa.verdict]}</span>
                    <span className="ep-qa-summary">{qa.summary}</span>
                  </div>
                  {qa.findings.length > 0 && (
                    <ul className="ep-qa-findings">
                      {qa.findings.map((finding, index) => (
                        <li key={`qa-${index}`}>
                          <span className={`ep-sev ${finding.severity}`}>{QA_SEVERITY_LABELS[finding.severity]}</span>
                          <div>
                            <div>{finding.issue}</div>
                            {finding.evidence && <div className="ep-qa-evidence">{finding.evidence}</div>}
                            {finding.requiredChange && <div className="ep-qa-change">Suggested fix: {finding.requiredChange}</div>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : (
                <section className="ep-qa unavailable">
                  <div className="ep-qa-head">
                    <span className="ep-qa-verdict unavailable">{QA_LABELS.UNAVAILABLE}</span>
                    <span className="ep-qa-summary">
                      Independent QA did not return a verdict. Review the spec manually, then apply or regenerate.
                    </span>
                  </div>
                </section>
              )}

              <section className="ep-section ep-spec">
                <h4>Enhanced spec</h4>
                <div className="ep-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{enhanced.spec}</ReactMarkdown>
                </div>
              </section>

              <div className="ep-grid">
                <ListSection title="Assumptions" items={enhanced.assumptions} />
                <ListSection title="Open questions" items={enhanced.questions} />
                {enhanced.minimumProof.length > 0 && (
                  <section className="ep-section">
                    <h4>Minimum proof</h4>
                    <ul>
                      {enhanced.minimumProof.map((item, index) => (
                        <li key={`proof-${index}`}>
                          <strong>{item.claim}</strong>
                          <div className="ep-proof"><span>Test</span> {item.test}</div>
                          <div className="ep-proof"><span>Evidence</span> {item.evidence}</div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <ListSection title="Not done if" items={enhanced.notDoneIf} />
                <ListSection title="Risks" items={enhanced.risks} />
              </div>
            </>
          )}
        </div>

        <footer className="ep-foot">
          <div className="ep-foot-main">
            <div className="ep-foot-actions">
              <button
                type="button"
                className={'ep-btn' + (qaClean ? ' ep-btn-accent' : '')}
                disabled={loading || !enhanced}
                onClick={() => { if (enhanced) onUse(enhanced) }}
              >
                <Check size={14} /> Apply spec
              </button>
              <button
                type="button"
                className={'ep-btn' + (!qaClean ? ' ep-btn-accent' : '')}
                disabled={loading}
                onClick={() => onRegenerate(qaFindingsForRegenerate(qa))}
              >
                {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
                Regenerate{qa?.findings.length ? ' with QA fixes' : ''}
              </button>
              <button type="button" className="ep-btn ep-btn-ghost" onClick={onCancel}>
                Cancel
              </button>
            </div>
            {qaBlocked && (
              <div className="ep-qa-note">
                {qa?.findings.length
                  ? `Independent QA found ${qa.findings.length} issue${qa.findings.length === 1 ? '' : 's'}. Apply the spec as-is, or regenerate with the fixes.`
                  : 'Independent QA did not run. Review the spec manually, then apply or regenerate.'}
              </div>
            )}
          </div>
          <div className="ep-foot-note">
            {metaLine || 'Apply spec writes the text into the task form — it never creates a task.'}
          </div>
        </footer>
      </div>

      <style>{EP_CSS}</style>
    </div>
  )
}

const EP_CSS = `
.ep-backdrop {
  position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: rgba(4, 7, 12, 0.68); backdrop-filter: blur(8px);
}
.ep-panel {
  width: min(880px, 100%); max-height: 88vh; display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--r);
  box-shadow: var(--shadow); backdrop-filter: blur(14px); overflow: hidden;
}
.ep-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 20px 12px; }
.ep-eyebrow { font-size: 10px; letter-spacing: 0.14em; color: var(--muted); font-weight: 700; margin-bottom: 4px; }
.ep-title { font-size: 16px; font-weight: 700; }
.ep-x { background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px; border-radius: 8px; }
.ep-x:hover { color: var(--fg); background: var(--bg2); }
.ep-shape { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 20px 12px; }
.ep-chip {
  font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--bg2); color: var(--muted);
}
.ep-body { overflow-y: auto; padding: 4px 20px 18px; display: grid; gap: 16px; }
.ep-loading { display: flex; gap: 12px; align-items: flex-start; border: 1px solid var(--line); border-radius: 11px; padding: 16px; background: var(--bg2); }
.ep-loading-title { font-size: 13px; font-weight: 600; }
.ep-loading-note { font-size: 12px; color: var(--muted); margin-top: 4px; }
.ep-error { border: 1px solid rgba(248, 113, 113, 0.28); background: rgba(248, 113, 113, 0.1); color: var(--bad); border-radius: 11px; padding: 14px 16px; }
.ep-error-title { font-size: 13px; font-weight: 700; }
.ep-error-text { font-size: 12px; margin-top: 4px; white-space: pre-wrap; }
.ep-section h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.ep-analysis { display: flex; flex-wrap: wrap; gap: 6px; }
.ep-spec { border: 1px solid var(--line); border-radius: 11px; padding: 14px 16px; background: var(--bg2); }
.ep-md { font-size: 13px; line-height: 1.6; color: var(--fg); overflow-wrap: anywhere; }
.ep-md > :first-child { margin-top: 0; }
.ep-md > :last-child { margin-bottom: 0; }
.ep-md h1, .ep-md h2, .ep-md h3 { font-size: 14px; margin: 14px 0 6px; }
.ep-md p { margin: 0 0 10px; }
.ep-md ul, .ep-md ol { margin: 0 0 10px; padding-left: 20px; }
.ep-md code { font-family: var(--mono); font-size: 12px; background: rgba(140, 155, 190, 0.12); border-radius: 5px; padding: 1px 5px; }
.ep-md pre { background: var(--bg2); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; overflow-x: auto; }
.ep-md pre code { background: none; padding: 0; }
.ep-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
.ep-section { border: 1px solid var(--line); border-radius: 11px; padding: 12px 14px; background: var(--bg2); }
.ep-section ul { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.55; color: var(--fg); }
.ep-section li + li { margin-top: 4px; }
.ep-proof { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.ep-proof span { display: inline-block; min-width: 54px; font-weight: 600; color: var(--fg); }
.ep-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 20px; border-top: 1px solid var(--line); background: rgba(10, 13, 20, 0.5); }
.ep-foot-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ep-btn {
  display: inline-flex; align-items: center; gap: 6px; border-radius: 9px; padding: 9px 13px;
  font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid var(--line);
  background: var(--bg2); color: var(--fg); transition: 0.14s;
}
.ep-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ep-btn:hover:not(:disabled) { border-color: var(--accent); }
.ep-btn-accent { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #04241d; border: none; }
.ep-btn-accent:hover:not(:disabled) { filter: brightness(1.05); }
.ep-btn-ghost { background: transparent; color: var(--muted); }
.ep-foot-main { display: flex; flex-direction: column; gap: 9px; }
.ep-foot-note { font-size: 11px; color: var(--muted); text-align: right; }
.ep-qa { border: 1px solid var(--line); border-radius: 11px; padding: 12px 14px; background: var(--bg2); }
.ep-qa.pass { border-color: rgba(74, 222, 128, 0.32); }
.ep-qa.revise { border-color: rgba(251, 191, 36, 0.38); }
.ep-qa.reject, .ep-qa.unavailable { border-color: rgba(248, 113, 113, 0.38); }
.ep-qa-head { display: flex; align-items: flex-start; gap: 10px; }
.ep-qa-verdict {
  flex: none; font-size: 10px; font-weight: 800; letter-spacing: 0.07em; text-transform: uppercase;
  padding: 3px 8px; border-radius: 999px; border: 1px solid transparent; white-space: nowrap;
}
.ep-qa-verdict.pass { background: rgba(74, 222, 128, 0.14); color: #4ade80; }
.ep-qa-verdict.revise { background: rgba(251, 191, 36, 0.14); color: #fbbf24; }
.ep-qa-verdict.reject, .ep-qa-verdict.unavailable { background: rgba(248, 113, 113, 0.14); color: #f87171; }
.ep-qa-summary { font-size: 12.5px; line-height: 1.5; color: var(--fg); }
.ep-qa-findings { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; }
.ep-qa-findings li { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; line-height: 1.45; }
.ep-sev {
  flex: none; font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
  padding: 2px 6px; border-radius: 5px; border: 1px solid var(--line); margin-top: 1px;
}
.ep-sev.blocker { color: #f87171; border-color: rgba(248, 113, 113, 0.35); }
.ep-sev.major { color: #fbbf24; border-color: rgba(251, 191, 36, 0.35); }
.ep-sev.minor { color: var(--muted); }
.ep-qa-evidence { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.ep-qa-change { font-size: 11.5px; margin-top: 2px; color: var(--fg); }
.ep-qa-note { max-width: 680px; font-size: 11.5px; line-height: 1.45; color: #aebbd2; }
@media (max-width: 640px) {
  .ep-backdrop { padding: 10px; }
  .ep-foot { flex-direction: column; align-items: flex-start; }
  .ep-foot-note { text-align: left; }
}
`
