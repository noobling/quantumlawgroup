import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { BrowserWindow, session, type Session } from 'electron'
import { simpleParser, type ParsedMail, type Attachment } from 'mailparser'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { EmailToPdfOptions, EmailToPdfResult } from '@shared/types'
import { rowsToXlsx } from './convert'
import { buildEmailHtml } from './emailHtml'

// Batch-convert .eml files in a folder tree to PDFs, mirroring the subfolder
// structure into an output folder. Each email is parsed (mailparser), its HTML
// is rendered in a hidden Electron window and printed to PDF (full formatting),
// inline images are embedded, and file attachments are written to a sibling
// folder. Non-email files are skipped.

export type { EmailToPdfResult }

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
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
      })
    )
  } finally {
    win.destroy()
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
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
