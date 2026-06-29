// Browser text extraction for the indexer. Every parser is dynamically imported so a
// single problematic format never blocks the others, and unused parsers stay out of the
// initial bundle. Runs inside the indexing Web Worker.
import type { DocKind } from './types'

export interface Extracted {
  text: string
  kind: DocKind
  meta?: { subject?: string; from?: string; to?: string; date?: string }
}

// Formats we pull full text from, plus plain-text formats. Anything else is indexed by
// filename only (still searchable by name).
export const INDEXABLE = new Set([
  '.eml', '.msg', '.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.ppsx', '.ppt',
  '.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.htm', '.yml', '.yaml', '.rtf'
])
const PLAIN = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.htm', '.yml', '.yaml', '.rtf'])

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

const decodeXmlEntities = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

function stripHtml(html: string): string {
  return decodeXmlEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim()
}

async function extractPdf(buf: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((it) => (it && typeof it === 'object' && 'str' in it ? (it as { str: string }).str : ''))
      .join(' ')
    pages.push(`--- Page ${i} ---\n${text}`)
  }
  return pages.join('\n\n')
}

async function extractDocx(buf: ArrayBuffer): Promise<string> {
  const m = await import('mammoth/mammoth.browser')
  const lib = m.default ?? m
  const { value } = await lib.extractRawText({ arrayBuffer: buf })
  return value
}

async function extractSpreadsheet(buf: ArrayBuffer): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
  return wb.SheetNames.map((n) => `# Sheet: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n')
}

async function extractPptx(buf: ArrayBuffer): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buf)
  const slides = Object.keys(zip.files)
    .filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const out: string[] = []
  for (const n of slides) {
    const xml = await zip.files[n].async('string')
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]))
    if (runs.length) out.push(runs.join('\n'))
  }
  return out.join('\n\n')
}

/** Legacy .ppt (OLE/CFB binary) — pull text from the PowerPoint Document stream's atoms. */
async function extractPpt(buf: ArrayBuffer): Promise<string> {
  let bytes = new Uint8Array(buf)
  try {
    const XLSX = await import('xlsx')
    const CFB = (XLSX as unknown as {
      CFB: { read: (b: Uint8Array, o: { type: string }) => unknown; find: (c: unknown, n: string) => { content?: Uint8Array } | null }
    }).CFB
    const cfb = CFB.read(bytes, { type: 'array' })
    const s = CFB.find(cfb, 'PowerPoint Document') || CFB.find(cfb, '/PowerPoint Document')
    if (s?.content) bytes = new Uint8Array(s.content)
  } catch {
    /* not a CFB — scan raw bytes */
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const utf16 = new TextDecoder('utf-16le')
  const latin1 = new TextDecoder('latin1')
  const parts: string[] = []
  const walk = (start: number, end: number): void => {
    let i = start
    while (i + 8 <= end) {
      const verInst = dv.getUint16(i, true)
      const recType = dv.getUint16(i + 2, true)
      const recLen = dv.getUint32(i + 4, true)
      const cStart = i + 8
      const cEnd = Math.min(end, cStart + recLen)
      if (cEnd <= cStart && recLen > 0) break
      if (recType === 0x0fa0) parts.push(utf16.decode(bytes.subarray(cStart, cEnd)))
      else if (recType === 0x0fa8) parts.push(latin1.decode(bytes.subarray(cStart, cEnd)))
      else if ((verInst & 0x000f) === 0x000f) walk(cStart, cEnd)
      i = cEnd
    }
  }
  walk(0, bytes.byteLength)
  return parts.join('\n').replace(/[\v\r]/g, '\n').replace(/[\x00-\x08\x0e-\x1f]/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

interface MailAddr { address?: string; name?: string }
async function extractEml(buf: ArrayBuffer): Promise<Extracted> {
  const { default: PostalMime } = await import('postal-mime')
  const email = await new PostalMime().parse(buf)
  const body = email.text || (email.html ? stripHtml(email.html) : '')
  const to = (email.to || []).map((a: MailAddr) => a.address || a.name).filter(Boolean).join(', ')
  const meta = { subject: email.subject, from: email.from?.address || email.from?.name, to, date: email.date }
  const head = [meta.subject, `From: ${meta.from || ''}`, `To: ${to}`].filter(Boolean).join('\n')
  return { text: `${head}\n\n${body}`, kind: 'email', meta }
}

async function extractMsg(buf: ArrayBuffer): Promise<Extracted> {
  const { default: MsgReader } = await import('@kenjiuno/msgreader')
  const data = new MsgReader(buf).getFileData() as {
    subject?: string; body?: string; senderEmail?: string; senderName?: string
    messageDeliveryTime?: string; recipients?: Array<{ email?: string; name?: string }>
  }
  const to = (data.recipients || []).map((r) => r.email || r.name).filter(Boolean).join(', ')
  const meta = { subject: data.subject, from: data.senderEmail || data.senderName, to, date: data.messageDeliveryTime }
  const head = [meta.subject, `From: ${meta.from || ''}`, `To: ${to}`].filter(Boolean).join('\n')
  return { text: `${head}\n\n${data.body || ''}`, kind: 'email', meta }
}

/** Extract searchable text from a file. Never throws — unreadable files become filename-only. */
export async function extractText(file: File): Promise<Extracted> {
  const ext = extOf(file.name)
  try {
    if (ext === '.pdf') return { text: await extractPdf(await file.arrayBuffer()), kind: 'doc' }
    if (ext === '.docx') return { text: await extractDocx(await file.arrayBuffer()), kind: 'doc' }
    if (ext === '.xlsx' || ext === '.xls') return { text: await extractSpreadsheet(await file.arrayBuffer()), kind: 'doc' }
    if (ext === '.pptx' || ext === '.ppsx') return { text: await extractPptx(await file.arrayBuffer()), kind: 'doc' }
    if (ext === '.ppt') return { text: await extractPpt(await file.arrayBuffer()), kind: 'doc' }
    if (ext === '.eml') return await extractEml(await file.arrayBuffer())
    if (ext === '.msg') return await extractMsg(await file.arrayBuffer())
    if (PLAIN.has(ext)) {
      const t = await file.text()
      return { text: ext === '.html' || ext === '.htm' ? stripHtml(t) : t, kind: 'doc' }
    }
  } catch {
    /* fall through to filename-only */
  }
  return { text: '', kind: 'doc' }
}
