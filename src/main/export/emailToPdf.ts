import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { BrowserWindow, session, type Session } from 'electron'
import { simpleParser, type ParsedMail, type Attachment } from 'mailparser'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { EmailToPdfOptions, EmailToPdfResult } from '@shared/types'
import { rowsToXlsx } from './convert'

// Batch-convert .eml files in a folder tree to PDFs, mirroring the subfolder
// structure into an output folder. Each email is parsed (mailparser), its HTML
// is rendered in a hidden Electron window and printed to PDF (full formatting),
// inline images are embedded, and file attachments are written to a sibling
// folder. Non-email files are skipped.

export type { EmailToPdfResult }

const TRANSPARENT_PX =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// One locked-down session reused for all renders: block every network request so
// emails can't phone home (tracking pixels, remote images). Only embedded data:
// URIs and the local temp HTML file load.
let renderSession: Session | null = null
function getRenderSession(): Session {
  if (renderSession) return renderSession
  const ses = session.fromPartition('email-render', { cache: false })
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url
    const ok = u.startsWith('data:') || u.startsWith('file://') || u.startsWith('about:')
    cb({ cancel: !ok })
  })
  renderSession = ses
  return ses
}

async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `dsl-email-${process.pid}-${Date.now()}-${Math.round(performance.now())}.html`)
  await fs.writeFile(tmp, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, session: getRenderSession() }
  })
  try {
    await win.loadFile(tmp)
    await new Promise((r) => setTimeout(r, 150)) // let layout/images settle
    return Buffer.from(
      await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
      })
    )
  } finally {
    win.destroy()
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

function esc(s = ''): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #14181f; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  .dsl-hdr { width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 12px; }
  .dsl-hdr td { padding: 2px 6px; vertical-align: top; }
  .dsl-hdr .lbl { color: #5b6675; font-weight: 600; white-space: nowrap; width: 1%; }
  .dsl-subject { font-size: 17px; font-weight: 700; margin: 0 0 8px; }
  .dsl-rule { border: 0; border-top: 1px solid #d7dbe2; margin: 10px 0 16px; }
  .dsl-atts { margin-top: 18px; padding: 10px 12px; border: 1px solid #d7dbe2; border-radius: 8px;
    background: #f6f7f9; font-size: 12px; color: #2a3340; }
  .dsl-atts b { color: #14181f; }
  .dsl-body { word-wrap: break-word; overflow-wrap: break-word; }
`

/** Build a standalone HTML document for the email; embed inline images, list file attachments. */
function buildEmailHtml(mail: ParsedMail): { html: string; fileAttachments: Attachment[] } {
  const atts = (mail.attachments || []) as Attachment[]
  let body = typeof mail.html === 'string' && mail.html ? mail.html : mail.textAsHtml || '<p>(no message body)</p>'

  // Resolve cid: references → attachments. Prefer Content-ID; fall back to the
  // order cids appear vs. the order attachments arrive (handles emails whose
  // Content-ID headers were stripped on export).
  const cidRefs = [...new Set((body.match(/cid:[^"'\s)>]+/gi) || []).map((s) => s.slice(4)))]
  const idOf = (a: Attachment): string => (a.contentId || '').replace(/^<|>$/g, '')
  const byId = new Map<string, Attachment>()
  for (const a of atts) if (idOf(a)) byId.set(idOf(a), a)
  const unresolvedCids = cidRefs.filter((c) => !byId.has(c))
  const unusedAtts = atts.filter((a) => !idOf(a) || !cidRefs.includes(idOf(a)))
  const orderMap = new Map<string, Attachment>()
  unresolvedCids.forEach((c, i) => unusedAtts[i] && orderMap.set(c, unusedAtts[i]))

  const embedded = new Set<Attachment>()
  for (const cid of cidRefs) {
    const a = byId.get(cid) || orderMap.get(cid)
    let replacement = TRANSPARENT_PX // unmatched / non-image cid → invisible (no broken icon)
    if (a && a.contentType?.startsWith('image/')) {
      replacement = `data:${a.contentType};base64,${a.content.toString('base64')}`
      embedded.add(a)
    }
    body = body.split('cid:' + cid).join(replacement)
  }

  const fileAttachments = atts.filter((a) => !embedded.has(a))

  const rows: string[] = []
  const row = (label: string, val?: string): void => {
    if (val) rows.push(`<tr><td class="lbl">${label}</td><td>${esc(val)}</td></tr>`)
  }
  row('From', mail.from?.text)
  row('To', Array.isArray(mail.to) ? mail.to.map((t) => t.text).join(', ') : mail.to?.text)
  row('Cc', Array.isArray(mail.cc) ? mail.cc.map((t) => t.text).join(', ') : mail.cc?.text)
  row('Date', mail.date ? mail.date.toLocaleString() : undefined)

  const attBox = fileAttachments.length
    ? `<div class="dsl-atts"><b>📎 ${fileAttachments.length} attachment${fileAttachments.length === 1 ? '' : 's'}</b> (saved to the attachments folder):<br>${fileAttachments
        .map((a) => `${esc(a.filename || 'attachment')} — ${Math.max(1, Math.round((a.content?.length || 0) / 1024))} KB`)
        .join('<br>')}</div>`
    : ''

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    <div class="dsl-subject">${esc(mail.subject || '(no subject)')}</div>
    <table class="dsl-hdr">${rows.join('')}</table>
    <hr class="dsl-rule">
    <div class="dsl-body">${body}</div>
    ${attBox}
  </body></html>`

  return { html, fileAttachments }
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200) || 'attachment'
}

/** Append each attachment (PDFs page-for-page, images as a page) onto the email
 *  PDF, with a labeled divider page before each, into one family document. */
async function combineFamily(emailPdf: Buffer, attachments: Attachment[]): Promise<Buffer> {
  const doc = await PDFDocument.load(emailPdf)
  const font = await doc.embedFont(StandardFonts.HelveticaBold)

  const divider = (title: string): void => {
    const page = doc.addPage()
    const { width, height } = page.getSize()
    const size = 16
    const w = font.widthOfTextAtSize(title, size)
    page.drawText('Attachment', { x: (width - font.widthOfTextAtSize('Attachment', 11)) / 2, y: height / 2 + 12, size: 11, font, color: rgb(0.4, 0.45, 0.52) })
    page.drawText(title, { x: Math.max(40, (width - w) / 2), y: height / 2 - 12, size, font, color: rgb(0.08, 0.1, 0.14) })
  }

  for (const a of attachments) {
    const name = a.filename || 'attachment'
    const isPdf = a.contentType === 'application/pdf' || /\.pdf$/i.test(name)
    const isPng = a.contentType === 'image/png' || /\.png$/i.test(name)
    const isJpg = a.contentType === 'image/jpeg' || /\.jpe?g$/i.test(name)
    try {
      if (isPdf) {
        divider(name)
        const src = await PDFDocument.load(a.content, { ignoreEncryption: true })
        const pages = await doc.copyPages(src, src.getPageIndices())
        for (const p of pages) doc.addPage(p)
      } else if (isPng || isJpg) {
        divider(name)
        const img = isPng ? await doc.embedPng(a.content) : await doc.embedJpg(a.content)
        const page = doc.addPage([595.28, 841.89]) // A4 pt
        const m = 36
        const scale = Math.min((595.28 - m * 2) / img.width, (841.89 - m * 2) / img.height, 1)
        page.drawImage(img, { x: m, y: 841.89 - m - img.height * scale, width: img.width * scale, height: img.height * scale })
      }
      // other types: left as native files only (can't reliably render here)
    } catch {
      // unreadable/encrypted attachment — keep the native file, skip merging it
    }
  }
  return Buffer.from(await doc.save())
}

/** Stamp every page with a Bates number at the bottom-right. */
async function stampBates(
  pdf: Buffer,
  startNum: number,
  prefix: string,
  pad: number
): Promise<{ bytes: Buffer; begin: string; end: string; pages: number }> {
  const doc = await PDFDocument.load(pdf)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = doc.getPages()
  const label = (n: number): string => prefix + String(n).padStart(pad, '0')
  pages.forEach((page, i) => {
    const text = label(startNum + i)
    const size = 9
    const { width } = page.getSize()
    const tw = font.widthOfTextAtSize(text, size)
    page.drawText(text, { x: width - tw - 22, y: 16, size, font, color: rgb(0.25, 0.28, 0.34) })
  })
  return { bytes: Buffer.from(await doc.save()), begin: label(startNum), end: label(startNum + pages.length - 1), pages: pages.length }
}

async function collectEml(dir: string, skipDir: string, found: string[], counts: { skipped: number }): Promise<void> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (path.resolve(full) === skipDir) continue
      await collectEml(full, skipDir, found, counts)
    } else if (path.extname(e.name).toLowerCase() === '.eml') {
      found.push(full)
    } else {
      counts.skipped++
    }
  }
}

export async function convertEmailsToPdf(
  inputDir: string,
  outputDir: string,
  options: EmailToPdfOptions = {}
): Promise<EmailToPdfResult> {
  const inRoot = path.resolve(inputDir)
  const outRoot = path.resolve(outputDir)
  const result: EmailToPdfResult = { converted: 0, skipped: 0, attachments: 0, errors: [], outputs: [] }

  const emls: string[] = []
  const counts = { skipped: 0 }
  await collectEml(inRoot, outRoot, emls, counts)
  result.skipped = counts.skipped
  emls.sort((a, b) => a.localeCompare(b)) // stable order → deterministic Bates sequence

  const batesPrefix = options.bates?.prefix ?? ''
  let batesNext = options.bates?.start ?? 1
  const PAD = 6
  const indexRows: string[][] = []

  for (const eml of emls) {
    try {
      const mail = await simpleParser(await fs.readFile(eml))
      const { html, fileAttachments } = buildEmailHtml(mail)
      let pdf = await renderHtmlToPdf(html)

      // Combine the family into one document (email + attachments) if requested.
      if (options.combineAttachments && fileAttachments.length) {
        pdf = await combineFamily(pdf, fileAttachments)
      }

      // Bates-stamp every page, in the sorted order, contiguously across the set.
      let bBegin = ''
      let bEnd = ''
      let pageCount = 0
      if (options.bates) {
        const s = await stampBates(pdf, batesNext, batesPrefix, PAD)
        pdf = s.bytes
        bBegin = s.begin
        bEnd = s.end
        pageCount = s.pages
        batesNext += s.pages
      }

      const rel = path.relative(inRoot, eml).replace(/\.eml$/i, '.pdf')
      const outPath = path.join(outRoot, rel)
      await fs.mkdir(path.dirname(outPath), { recursive: true })
      await fs.writeFile(outPath, pdf)
      result.outputs.push(outPath)
      result.converted++

      // Always keep the native attachments alongside (authenticity / native production).
      if (fileAttachments.length) {
        const attDir = outPath.replace(/\.pdf$/i, '') + ' - attachments'
        await fs.mkdir(attDir, { recursive: true })
        const used = new Set<string>()
        for (const a of fileAttachments) {
          let name = safeName(a.filename || 'attachment')
          while (used.has(name.toLowerCase())) name = '_' + name
          used.add(name.toLowerCase())
          await fs.writeFile(path.join(attDir, name), a.content)
          result.attachments++
        }
      }

      const toText = (v: ParsedMail['to']): string =>
        Array.isArray(v) ? v.map((t) => t.text).join('; ') : v?.text || ''
      indexRows.push([
        bBegin,
        bEnd,
        pageCount ? String(pageCount) : '',
        mail.date ? mail.date.toISOString().slice(0, 10) : '',
        mail.from?.text || '',
        toText(mail.to),
        mail.subject || '',
        String(fileAttachments.length),
        fileAttachments.map((a) => a.filename || 'attachment').join('; ')
      ])
    } catch (e) {
      result.errors.push({ file: eml, error: (e as Error).message })
    }
  }

  if (options.bates && indexRows.length) {
    const first = indexRows.find((r) => r[0])
    const last = [...indexRows].reverse().find((r) => r[1])
    if (first && last) result.batesRange = { begin: first[0], end: last[1] }
  }

  if (options.index && indexRows.length) {
    const header = ['Bates Begin', 'Bates End', 'Pages', 'Date', 'From', 'To', 'Subject', '# Attachments', 'Attachments']
    const buf = await rowsToXlsx([header, ...indexRows], 'Production Index')
    const indexPath = path.join(outRoot, 'Production Index.xlsx')
    await fs.writeFile(indexPath, buf)
    result.indexPath = indexPath
  }

  return result
}
