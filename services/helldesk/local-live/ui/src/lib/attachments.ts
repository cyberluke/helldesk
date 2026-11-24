/**
 * Task Studio multimodal inputs (minimal working slice).
 *
 * Images are uploaded as-is with an explicit semantics mode:
 *   - inspiration: style/mechanic reference only (no pixel parity implied)
 *   - requirement: pixel-perfect visual target (screenshot comparison required)
 *
 * PDFs are converted IN THE BROWSER (pdfjs-dist) to:
 *   - per-page Markdown (page references preserved)
 *   - per-page PNG renders (embedded images included in the page image)
 * then uploaded through the same attachment abstraction. The local server stores
 * provenance (sha256, size, original name/mime, page count).
 */
import * as pdfjs from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export type AttachmentKind = 'image' | 'pdf'
export type AttachmentMode = 'inspiration' | 'requirement'

export interface AttachmentPage {
  page: number
  url?: string
  path?: string
}

export interface AttachmentManifest {
  attachment_id: string
  kind: AttachmentKind
  mode: AttachmentMode
  filename: string
  mime: string
  size: number
  sha256: string
  page_count?: number | null
  markdown?: string | null
  markdown_url?: string | null
  markdown_path?: string | null
  original_url: string
  original_path: string
  pages?: AttachmentPage[]
  created_at: string
}

/** A local (not yet uploaded) attachment row in the composer. */
export interface DropAttachment {
  localId: string
  file: File
  kind: AttachmentKind
  mode: AttachmentMode
  previewUrl?: string
  pageCount?: number
  status: 'extracting' | 'uploading' | 'ready' | 'error'
  error?: string
  manifest?: AttachmentManifest
}

const MAX_ATTACHMENTS = 8
const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_PDF_PAGES = 20
const PDF_RENDER_SCALE = 1.2

export function isSupportedAttachment(file: File): boolean {
  return file.type.startsWith('image/') || file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

export function attachmentLimitMessage(count: number): string | null {
  if (count > MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} attachments per task.`
  return null
}

export async function uploadAttachment(
  departmentId: string,
  file: File,
  mode: AttachmentMode,
): Promise<AttachmentManifest> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`Attachment is larger than ${MAX_FILE_BYTES / 1024 / 1024}MB.`)
  const kind: AttachmentKind = file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'pdf' : 'image'
  const form = new FormData()
  form.append('file', file, file.name)

  let markdown = ''
  let pageCount: number | undefined
  let pageImages: Array<{ page: number; blob: Blob }> = []
  if (kind === 'pdf') {
    const extracted = await extractPdf(file)
    markdown = extracted.markdown
    pageCount = extracted.pageCount
    pageImages = extracted.pageImages
    form.append('markdown', markdown)
    for (const page of pageImages) {
      form.append(`page-${page.page}`, page.blob, `page-${page.page}.png`)
    }
  }

  form.append(
    'manifest',
    JSON.stringify({
      kind,
      mode,
      filename: file.name,
      mime: file.type || (kind === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
      size: file.size,
      pageCount,
      pages: pageImages.map((page) => ({ page: page.page, field: `page-${page.page}` })),
    }),
  )

  const response = await fetch(`/api/departments/${encodeURIComponent(departmentId)}/attachments`, {
    method: 'POST',
    body: form,
  })
  const text = await response.text().catch(() => '')
  let payload: unknown = null
  try {
    payload = text.trim() ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok || !(payload as { success?: boolean } | null)?.success) {
    const error = (payload as { error?: string } | null)?.error
    throw new Error(error || `Attachment upload failed (${response.status}).`)
  }
  return (payload as { data: AttachmentManifest }).data
}

/**
 * Extract text + page images from a PDF in the browser. Page renders include
 * embedded images; a page with no extractable text is still represented.
 * Capped to keep Task Studio responsive and the mission prompt bounded.
 */
async function extractPdf(file: File): Promise<{
  pageCount: number
  markdown: string
  pageImages: Array<{ page: number; blob: Blob }>
}> {
  const data = new Uint8Array(await file.arrayBuffer())
  const loadingTask = pdfjs.getDocument({ data })
  const doc = await loadingTask.promise
  const pageCount = doc.numPages
  const limit = Math.min(pageCount, MAX_PDF_PAGES)
  const lines: string[] = [`# ${file.name}`, '', `Pages: ${pageCount}`, '']
  const pageImages: Array<{ page: number; blob: Blob }> = []

  for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)
    const textContent = await page.getTextContent()
    const text = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
    lines.push(`## Page ${pageNumber}`, '', text || '_No extractable text on this page (see page image)._', '')

    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(viewport.width))
    canvas.height = Math.max(1, Math.ceil(viewport.height))
    if (!canvas.getContext('2d')) throw new Error('PDF page rendering is unavailable in this browser.')
    await page.render({ canvas, viewport }).promise
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob) pageImages.push({ page: pageNumber, blob })
  }

  if (pageCount > limit) {
    lines.push(`> Only the first ${limit} of ${pageCount} pages were rendered/extracted for this task.`)
  }
  await loadingTask.destroy()
  return { pageCount, markdown: lines.join('\n'), pageImages }
}

/** Markdown block appended to the task spec so the builder and reviewer see the
 *  exact input semantics, page references and provenance. */
export function attachmentSpecBlock(attachments: AttachmentManifest[]): string {
  if (!attachments.length) return ''
  const lines: string[] = ['', '## Input attachments', '']
  for (const attachment of attachments) {
    const mode =
      attachment.mode === 'requirement'
        ? 'REQUIREMENT — pixel-perfect visual target. Acceptance must include a screenshot at each named state compared against this reference; visual differences are findings.'
        : 'INSPIRATION — style/mechanic reference only. Do not require pixel parity.';
    lines.push(`### ${attachment.filename} (${attachment.kind}, ${attachment.mode})`)
    lines.push(`- attachment_id: ${attachment.attachment_id}`)
    lines.push(`- semantics: ${mode}`)
    lines.push(`- provenance: sha256 ${attachment.sha256}, ${attachment.size} bytes`)
    if (attachment.page_count != null) lines.push(`- pages: ${attachment.page_count}`)
    lines.push(`- original: ${attachment.original_path} (${attachment.original_url})`)
    if (attachment.markdown_path) lines.push(`- extracted markdown: ${attachment.markdown_path} (${attachment.markdown_url})`)
    if (attachment.pages?.length) {
      lines.push(`- page images: ${attachment.pages.map((page) => `${page.page}:${page.path ?? page.url ?? ''}`).join(', ')}`)
    }
    lines.push('')
    if (attachment.markdown) {
      lines.push('#### Extracted text (bounded)', '', attachment.markdown.slice(0, 6_000), '')
      if (attachment.markdown.length > 6_000) lines.push('_Extracted text truncated; read the full markdown path above._', '')
    }
  }
  return lines.join('\n')
}
