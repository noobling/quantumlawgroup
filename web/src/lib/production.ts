// Browser Bates production. Renders each document to a Bates-stamped PDF, handles emails as
// families (email body + its attachments, with BEGATTACH/ENDATTACH), applies content-based
// attachment exclusion (exact sha256 dedupe + perceptual dHash logo detection, matching the
// desktop app: small image recurring in ≥3 distinct conversations), and emits Concordance
// .DAT / .CSV / Opticon .OPT load files plus an internal review index. Packaged as a ZIP.
//
// Note: Office files (.docx/.xlsx/.pptx) can't be rendered to an imaged PDF in a pure browser
// (no Chromium/LibreOffice), so they're produced as a Bates-stamped slip-sheet with the native
// file included beside it (NATIVELINK points at the native, like the desktop app).
import type { PDFDocument, PDFFont } from 'pdf-lib'
import type { IndexedDoc } from './types'
import { parseEmail, emailToPdf, type ParsedEmail } from './email'
import { dHash, similar } from './imageHash'

export interface ProductionConfig {
  prefix: string
  start: number
  pad: number
  custodian: string
}
export interface ProducedItem {
  beginBates: string
  endBates: string
  pages: number
  fileName: string
  pdfName: string
  pdfBytes: Uint8Array
  isAttachment: boolean
  docType: string
  from?: string
  to?: string
  cc?: string
  subject?: string
  date?: string
  beginAttach?: string
  endAttach?: string
  attachmentNames?: string
  attachmentCount?: number
  /** Set when the document is produced natively (slip-sheeted PDF + original file). */
  nativeName?: string
  nativeBytes?: Uint8Array
}
export interface ExcludedItem {
  name: string
  reason: string
  parent: string
  size: number
  sha256: string
  dhash: string | null
  bytes: Uint8Array
}
export interface ProductionResult { items: ProducedItem[]; excluded: ExcludedItem[]; config: ProductionConfig }

export type AutoReason = '' | 'duplicate' | 'logo/signature image' | 'tiny attachment'

/** One attachment surfaced for the manual include/exclude review step. */
export interface ScannedAttachment {
  key: string          // stable id: `${parentDocId}::${attachmentIndex}`
  parentDocId: string
  parentName: string
  name: string
  size: number
  mime: string
  isImage: boolean
  sha256: string
  dhash: string | null // perceptual hash (images only) — powers "exclude similar"
  autoReason: AutoReason
  thumb?: string       // data URL for small images
}

const LOGO_MAX_BYTES = 150 * 1024
const TINY_ATTACHMENT_BYTES = 3 * 1024
const DHASH_MAX_BYTES = 4 * 1024 * 1024 // don't decode huge photos just for similarity
const isImageName = (n: string): boolean => /\.(jpe?g|png|gif|bmp|tiff?)$/i.test(n)
const isEmbeddable = (n: string): boolean => /\.(jpe?g|png)$/i.test(n)
const THUMB_MAX = 96 * 1024  // only thumbnail small images, to keep the scan fast/light

const extOfName = (n: string): string => {
  const i = n.lastIndexOf('.')
  return i >= 0 ? n.slice(i).toLowerCase() : ''
}

const DOC_TYPE_BY_EXT: Record<string, string> = {
  '.pdf': 'PDF', '.docx': 'Word', '.doc': 'Word', '.rtf': 'Word',
  '.xlsx': 'Spreadsheet', '.xls': 'Spreadsheet', '.csv': 'Spreadsheet', '.tsv': 'Spreadsheet',
  '.pptx': 'Presentation', '.ppsx': 'Presentation', '.ppt': 'Presentation',
  '.jpg': 'Image', '.jpeg': 'Image', '.png': 'Image', '.gif': 'Image', '.bmp': 'Image', '.tif': 'Image', '.tiff': 'Image',
  '.txt': 'Text', '.md': 'Text', '.log': 'Text', '.eml': 'Email', '.msg': 'Email'
}
const docTypeOf = (name: string): string => DOC_TYPE_BY_EXT[extOfName(name)] || (extOfName(name).slice(1).toUpperCase() || 'Document')

/** Conversation key: subject with re:/fwd: prefixes stripped — same scoping as the desktop app. */
const convKey = (subject: string | undefined, fallback: string): string => {
  const s = (subject || '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim().toLowerCase()
  return s || fallback
}

async function makeThumb(mime: string, bytes: Uint8Array): Promise<string | undefined> {
  try {
    const blob = new Blob([bytes.slice()], { type: mime || 'image/png' })
    const bmp = await createImageBitmap(blob)
    const max = 64
    const s = Math.min(max / bmp.width, max / bmp.height, 1)
    const w = Math.max(1, Math.round(bmp.width * s))
    const h = Math.max(1, Math.round(bmp.height * s))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    return canvas.toDataURL('image/png')
  } catch {
    return undefined
  }
}

interface RawAtt {
  key: string
  parentDocId: string
  parentName: string
  index: number
  name: string
  size: number
  mime: string
  isImage: boolean
  hash: string
  dhash: string | null
  conv: string
  bytes: Uint8Array
}

/** Parse every email's attachments once — shared by the scan step and by auto-exclusion. */
async function collectAttachments(
  docs: IndexedDoc[],
  getFile: (docId: string) => Promise<File> | undefined,
  onProgress?: (done: number, total: number) => void
): Promise<{ raws: RawAtt[]; parsedEmails: Map<string, ParsedEmail> }> {
  const emails = docs.filter((d) => d.kind === 'email')
  const raws: RawAtt[] = []
  const parsedEmails = new Map<string, ParsedEmail>()
  let done = 0
  for (const doc of emails) {
    const f = await getFile(doc.id)
    if (f) {
      const parsed = await parseEmail(f, doc.ext)
      parsedEmails.set(doc.id, parsed)
      const conv = convKey(doc.subject || parsed.subject, doc.id)
      for (let i = 0; i < parsed.attachments.length; i++) {
        const att = parsed.attachments[i]
        const img = isImageName(att.name)
        raws.push({
          key: `${doc.id}::${i}`,
          parentDocId: doc.id,
          parentName: doc.name,
          index: i,
          name: att.name,
          size: att.bytes.length,
          mime: att.mime,
          isImage: img,
          hash: await sha256(att.bytes),
          dhash: img && att.bytes.length <= DHASH_MAX_BYTES ? await dHash(att.bytes, att.mime) : null,
          conv,
          bytes: att.bytes
        })
      }
    }
    done++
    onProgress?.(done, emails.length)
  }
  return { raws, parsedEmails }
}

/**
 * Automatic exclusion flags per attachment key, matching the desktop rules:
 * - logo/signature image: small image (≤150 KB) recurring in ≥3 distinct conversations,
 *   matched exactly (sha256) or perceptually (dHash) so re-encoded copies count too
 * - duplicate: exact byte copy of an earlier attachment
 * - tiny attachment: under 3 KB (dividers, spacer gifs, vcf stubs)
 *
 * `excludeSignatures` mirrors the desktop checkbox: when off, only exact duplicates are flagged.
 */
function autoFlags(raws: RawAtt[], excludeSignatures = true): Map<string, AutoReason> {
  const flags = new Map<string, AutoReason>()
  const logoConvs = (r: RawAtt): number => {
    const convs = new Set<string>()
    for (const o of raws) {
      if (o.hash === r.hash || (r.isImage && o.isImage && similar(r.dhash, o.dhash))) convs.add(o.conv)
    }
    return convs.size
  }
  const seen = new Set<string>()
  for (const r of raws) {
    if (excludeSignatures && r.isImage && r.size <= LOGO_MAX_BYTES && logoConvs(r) >= 3) flags.set(r.key, 'logo/signature image')
    else if (seen.has(r.hash)) flags.set(r.key, 'duplicate')
    else if (excludeSignatures && r.size > 0 && r.size < TINY_ATTACHMENT_BYTES) flags.set(r.key, 'tiny attachment')
    seen.add(r.hash)
  }
  return flags
}

/**
 * Parse every email and list its attachments for the manual review step, pre-flagging the ones
 * automatic exclusion would drop (exact duplicates + repeated logo/signature images + tiny files).
 */
export async function scanAttachments(
  docs: IndexedDoc[],
  getFile: (docId: string) => Promise<File> | undefined,
  onProgress?: (done: number, total: number) => void,
  excludeSignatures = true
): Promise<ScannedAttachment[]> {
  const { raws } = await collectAttachments(docs, getFile, onProgress)
  const flags = autoFlags(raws, excludeSignatures)
  const out: ScannedAttachment[] = []
  for (const r of raws) {
    const thumb = r.isImage && r.size <= THUMB_MAX ? await makeThumb(r.mime, r.bytes) : undefined
    out.push({
      key: r.key, parentDocId: r.parentDocId, parentName: r.parentName, name: r.name,
      size: r.size, mime: r.mime, isImage: r.isImage, sha256: r.hash, dhash: r.dhash,
      autoReason: flags.get(r.key) || '', thumb
    })
  }
  return out
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const batesStr = (cfg: ProductionConfig, n: number): string => cfg.prefix + String(n).padStart(cfg.pad, '0')

type Lib = typeof import('pdf-lib')

/** Stamp each page bottom-right with consecutive Bates numbers; returns [begin, end]. */
function stamp(pdf: PDFDocument, font: PDFFont, lib: Lib, startN: number, cfg: ProductionConfig): [string, string] {
  const pages = pdf.getPages()
  pages.forEach((p, i) => {
    const label = batesStr(cfg, startN + i)
    const w = font.widthOfTextAtSize(label, 9)
    p.drawText(label, { x: p.getSize().width - 36 - w, y: 20, size: 9, font, color: lib.rgb(0.15, 0.15, 0.15) })
  })
  return [batesStr(cfg, startN), batesStr(cfg, startN + pages.length - 1)]
}

async function slipSheet(lib: Lib, fileName: string, note: string): Promise<PDFDocument> {
  const doc = await lib.PDFDocument.create()
  const font = await doc.embedFont(lib.StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  const lines = ['DOCUMENT PRODUCED IN NATIVE FORM', '', fileName, '', note]
  let y = 460
  for (const ln of lines) {
    const fs = ln === lines[0] ? 13 : 11
    const w = font.widthOfTextAtSize(ln, fs)
    page.drawText(ln, { x: (612 - w) / 2, y, size: fs, font, color: lib.rgb(0.2, 0.2, 0.2) })
    y -= 22
  }
  return doc
}

async function imageToPdf(lib: Lib, name: string, bytes: Uint8Array): Promise<PDFDocument | null> {
  try {
    const doc = await lib.PDFDocument.create()
    const img = /\.png$/i.test(name) ? await doc.embedPng(bytes.slice().buffer) : await doc.embedJpg(bytes.slice().buffer)
    const maxW = 540, maxH = 720
    const s = Math.min(maxW / img.width, maxH / img.height, 1)
    const page = doc.addPage([612, 792])
    page.drawImage(img, { x: (612 - img.width * s) / 2, y: (792 - img.height * s) / 2, width: img.width * s, height: img.height * s })
    return doc
  } catch {
    return null
  }
}

/** Render file bytes to a PDF; `native: true` means we slip-sheeted and the original should ship beside it. */
async function pdfFromFileBytes(lib: Lib, name: string, bytes: Uint8Array): Promise<{ pdf: PDFDocument; native: boolean }> {
  const ext = extOfName(name)
  if (ext === '.pdf') {
    try {
      return { pdf: await lib.PDFDocument.load(bytes.slice().buffer, { ignoreEncryption: true }), native: false }
    } catch {
      return { pdf: await slipSheet(lib, name, '(PDF could not be opened — produced as native)'), native: true }
    }
  }
  if (isEmbeddable(name)) {
    const d = await imageToPdf(lib, name, bytes)
    if (d) return { pdf: d, native: false }
  }
  return { pdf: await slipSheet(lib, name, 'Original file is included in the production set.'), native: true }
}

/**
 * Run a production. `docs` are the top-level indexed docs (sorted by caller); `getFile`
 * returns the original File for a doc id. Reports progress 0..1.
 */
export async function produce(
  docs: IndexedDoc[],
  getFile: (docId: string) => Promise<File> | undefined,
  cfg: ProductionConfig,
  onProgress: (done: number, total: number) => void,
  // Manual review result: attachment key (`${docId}::${index}`) → exclusion reason. When provided,
  // attachments are excluded ONLY per this map (auto logo/duplicate detection is bypassed for them,
  // since the user already reviewed those flags). When omitted, automatic exclusion applies.
  manualExclude?: Map<string, string>,
  // Desktop parity: the "skip logos/signatures & tiny attachments" toggle (default on).
  excludeSignatures = true
): Promise<ProductionResult> {
  const lib = await import('pdf-lib')

  // Pre-pass: parse every email once and, unless the user reviewed manually, compute the
  // automatic exclusion flags (perceptual logo detection needs the full corpus).
  const { raws, parsedEmails } = await collectAttachments(docs, getFile)
  const flags = manualExclude ? new Map<string, AutoReason>() : autoFlags(raws, excludeSignatures)
  const rawByKey = new Map(raws.map((r) => [r.key, r]))

  const items: ProducedItem[] = []
  const excluded: ExcludedItem[] = []
  let counter = cfg.start
  let done = 0

  const addItem = async (pdf: PDFDocument, startN: number, fileName: string, isAttachment: boolean, extra: Partial<ProducedItem> = {}): Promise<ProducedItem> => {
    const f2 = await pdf.embedFont(lib.StandardFonts.Helvetica)
    const [begin, end] = stamp(pdf, f2, lib, startN, cfg)
    const pages = pdf.getPages().length
    const bytes = await pdf.save()
    const item: ProducedItem = { beginBates: begin, endBates: end, pages, fileName, pdfName: `${begin}.pdf`, pdfBytes: bytes, isAttachment, docType: docTypeOf(fileName), ...extra }
    items.push(item)
    counter = startN + pages
    return item
  }

  const excludeAtt = (r: RawAtt, reason: string, parentBates: string): void => {
    excluded.push({ name: r.name, reason, parent: parentBates, size: r.size, sha256: r.hash, dhash: r.dhash, bytes: r.bytes })
  }

  const seenDocs = new Set<string>()
  for (const doc of docs) {
    const file = await getFile(doc.id)
    if (!file) { done++; onProgress(done, docs.length); continue }

    if (doc.kind === 'email') {
      const parsed = parsedEmails.get(doc.id) || (await parseEmail(file, doc.ext))
      const emailPdf = await lib.PDFDocument.load((await emailToPdf(parsed)).slice().buffer)
      const familyStart = counter
      const emailItem = await addItem(emailPdf, familyStart, doc.name, false, {
        docType: 'Email', from: parsed.from, to: parsed.to, cc: parsed.cc, subject: parsed.subject, date: parsed.date
      })
      // Attachments (family members)
      let attBegin = ''
      let attEnd = ''
      const keptNames: string[] = []
      for (let ai = 0; ai < parsed.attachments.length; ai++) {
        const att = parsed.attachments[ai]
        const key = `${doc.id}::${ai}`
        const raw = rawByKey.get(key)
        if (manualExclude) {
          if (manualExclude.has(key)) {
            if (raw) excludeAtt(raw, manualExclude.get(key) || 'excluded', emailItem.beginBates)
            continue
          }
        } else {
          const flag = flags.get(key)
          if (flag && raw) { excludeAtt(raw, flag, emailItem.beginBates); continue }
        }
        const { pdf, native } = await pdfFromFileBytes(lib, att.name, att.bytes)
        const it = await addItem(pdf, counter, att.name, true, { subject: att.name })
        if (native) { it.nativeName = `${it.beginBates}${extOfName(att.name)}`; it.nativeBytes = att.bytes }
        keptNames.push(att.name)
        if (!attBegin) attBegin = it.beginBates
        attEnd = it.endBates
      }
      if (attBegin) { emailItem.beginAttach = attBegin; emailItem.endAttach = attEnd }
      emailItem.attachmentNames = keptNames.join('; ')
      emailItem.attachmentCount = keptNames.length
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const h = await sha256(bytes)
      if (seenDocs.has(h)) {
        excluded.push({ name: doc.name, reason: 'duplicate', parent: '', size: bytes.length, sha256: h, dhash: null, bytes })
        done++; onProgress(done, docs.length); continue
      }
      seenDocs.add(h)
      const { pdf, native } = await pdfFromFileBytes(lib, doc.name, bytes)
      const it = await addItem(pdf, counter, doc.name, false, { date: doc.modifiedAt ? new Date(doc.modifiedAt).toISOString().slice(0, 10) : undefined })
      if (native) { it.nativeName = `${it.beginBates}${extOfName(doc.name)}`; it.nativeBytes = bytes }
    }
    done++
    onProgress(done, docs.length)
  }

  return { items, excluded, config: cfg }
}

// ── Load files & indexes ──
// Column set mirrors the desktop app's external load file:
// BEGBATES..ATTACHMENT NAMES, with NATIVELINK pointing at the native file for
// natively-produced (slip-sheeted) documents.

const LOAD_COLS = ['BEGBATES', 'ENDBATES', 'BEGATTACH', 'ENDATTACH', 'CUSTODIAN', 'DATE SENT', 'FROM', 'TO', 'CC', 'SUBJECT', 'DOC TYPE', 'FILE NAME', 'NATIVELINK', 'PAGE COUNT', 'ATTACHMENT NAMES']

const loadRow = (res: ProductionResult, it: ProducedItem): string[] => [
  it.beginBates, it.endBates, it.beginAttach || '', it.endAttach || '', res.config.custodian,
  it.date || '', it.from || '', it.to || '', it.cc || '', it.subject || '', it.docType,
  it.fileName, it.nativeName ? `NATIVES/${it.nativeName}` : '', String(it.pages), it.attachmentNames || ''
]

const csvEsc = (v: string): string => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)

export function buildCsv(res: ProductionResult): string {
  const rows = res.items.map((it) => loadRow(res, it).map(csvEsc).join(','))
  return [LOAD_COLS.join(','), ...rows].join('\r\n')
}

/** Concordance .DAT — þ text-qualifier (0xFE), ¶ field-delimiter (0x14). */
export function buildDat(res: ProductionResult): string {
  const Q = String.fromCharCode(0xFE)
  const D = String.fromCharCode(0x14)
  const line = (vals: string[]): string => vals.map((v) => Q + (v || '').replace(/þ/g, '') + Q).join(D)
  return [line(LOAD_COLS), ...res.items.map((it) => line(loadRow(res, it)))].join('\r\n')
}

/** Opticon .OPT image cross-reference — one line per page, document break on the first. */
export function buildOpt(res: ProductionResult): string {
  const lines: string[] = []
  for (const it of res.items) {
    const startN = parseInt(it.beginBates.slice(res.config.prefix.length), 10)
    for (let p = 0; p < it.pages; p++) {
      const pageId = batesStr(res.config, startN + p)
      lines.push([pageId, '', `NATIVES/${it.pdfName}`, p === 0 ? 'Y' : '', '', '', p === 0 ? String(it.pages) : ''].join(','))
    }
  }
  return lines.join('\r\n')
}

/** Internal review index rows — same columns as the desktop Review Index.xlsx. */
export function reviewIndexRows(res: ProductionResult): Array<Record<string, unknown>> {
  return res.items.map((it) => ({
    'Beginning Bates': it.beginBates,
    'Ending Bates': it.endBates,
    'Pages': it.pages,
    'Date': it.date || '',
    'Type': it.docType,
    'From': it.from || '',
    'To': it.to || '',
    'Subject / Title': it.subject || it.fileName,
    'File': it.fileName,
    '# Attachments': it.isAttachment ? '' : (it.attachmentCount ?? '')
  }))
}

/**
 * Excluded-attachment report rows + similarity grouping (byte-identical copies collapse;
 * perceptually similar images cluster together, largest groups first — like the desktop
 * Excluded/ folder).
 */
export function groupExcluded(excluded: ExcludedItem[]): Array<{ group: number; items: ExcludedItem[] }> {
  const groups: Array<{ group: number; items: ExcludedItem[] }> = []
  const assigned = new Array<boolean>(excluded.length).fill(false)
  const clusters: ExcludedItem[][] = []
  for (let i = 0; i < excluded.length; i++) {
    if (assigned[i]) continue
    const cluster = [excluded[i]]
    assigned[i] = true
    for (let j = i + 1; j < excluded.length; j++) {
      if (assigned[j]) continue
      if (excluded[j].sha256 === excluded[i].sha256 || similar(excluded[j].dhash, excluded[i].dhash)) {
        cluster.push(excluded[j])
        assigned[j] = true
      }
    }
    clusters.push(cluster)
  }
  clusters.sort((a, b) => b.length - a.length)
  clusters.forEach((items, i) => groups.push({ group: i + 1, items }))
  return groups
}
