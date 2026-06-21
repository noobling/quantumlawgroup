import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import os from 'os'
import path from 'path'
import { simpleParser, type ParsedMail } from 'mailparser'
import type { Collection, IndexedDoc, IndexEvent, ProcessFeatures, ProductionResult } from '@shared/types'
import { buildEmailHtml, attFingerprint } from './emailHtml'
import { combineFamily, makeRenderWindow, pageCount, renderInto, safeName, stampBates, toCsv, toDat, withTimeout } from './emailToPdf'

// Merging attachments into a family PDF (pdf-lib) can grind for minutes on a big drawing
// set, run 6-wide across the worker pool. Bound it: if it overruns, keep the un-combined
// email PDF — the attachments are still produced as native files beside it.
const COMBINE_TIMEOUT_MS = 60_000
import { renderDocToPdf, slipSheet } from './docToPdf'
import { rowsToXlsx } from './convert'
import { getProductionManifest, saveProductionManifest } from '../library/store'
import {
  HIGHLIGHT_HEADER,
  REVIEW_HEADER,
  LOADFILE_HEADER,
  highlightRows,
  reviewIndexRows,
  loadFileRows,
  productionTargets,
  excludedSummary,
  symmetricDiff,
  docExcludeAffected,
  type ProdRecord
} from './productionRows'

// Turn an indexed document set into a single Bates-numbered production under the
// output folder, then write the deliverables the enabled features ask for:
//   - review index (xlsx)                       → features.reviewIndex
//   - production load file (.DAT/.CSV)          → features.loadFile
//   - highlights table (xlsx)                  → features.highlights
// A full production (internal/external index) includes EVERY document so it can
// carry a Bates number. With "Convert to PDF" on, each document is rendered to a
// Bates-stamped PDF; with it off, the original native is copied over and given a
// single document-level Bates number (the index/load-file references the native).
// "Convert to PDF" alone (no index) produces just the emails.

type Emit = (e: IndexEvent) => void

const PAD = 6

// An image attachment whose fingerprint (name+size) appears in at least this many
// emails is treated as a recurring signature logo, not a one-off picture.
const MIN_RECURRENCE = 3

const addr = (v: ParsedMail['to']): string => (Array.isArray(v) ? v.map((t) => t.text).join('; ') : v?.text) || ''

/** Cheap, stable string hash (djb2) for fingerprinting the recurring-logo set. */
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** Filename + size of an excluded attachment (no content). */
interface ExcludedMeta {
  name: string
  size: number
}

/** A produced document remembered across runs: its row data + input file state. */
interface ProdItem extends ProdRecord {
  id: string
  path: string
  mtime: number
  size: number
  /** Excluded attachments this doc contributed — so counts stay correct on re-runs. */
  excluded?: ExcludedMeta[]
  /** Fingerprints (name|size) of this doc's non-embedded attachments — so an exclude/
   *  restore change can re-render only the docs it actually touches. */
  attKeys?: string[]
}

/** An attachment filtered out of the production by filename, kept for review. */
interface ExcludedAtt extends ExcludedMeta {
  content: Buffer
  /** The email it came from (relative path), for the listing. */
  source: string
}

/** Render-time options (no Bates — numbering is decided later, in order). */
type RenderOpts = {
  convert: boolean
  combine: boolean
  excludeSignatures: boolean
  excludeAttachments: string[]
  excludeFingerprints: Set<string>
  recurringImageFps: Set<string>
  keepAttachments: Set<string>
  keepNames: Set<string>
}

/**
 * The product of rendering one document, BEFORE Bates stamping or disk writing.
 * Rendering (the expensive, parallelisable step) produces this; a later sequential
 * pass assigns the Bates number and writes it — that split is what lets renders run
 * concurrently while numbering stays strictly in order.
 */
type Rendered = {
  doc: IndexedDoc
  rel: string
  /** Native passthrough ("Convert to PDF" off): copy `doc.path` verbatim, one Bates number. */
  native: boolean
  /** Unstamped rendered PDF (converted docs only). */
  pdf?: Buffer
  /** Page count of `pdf` (the Bates span before stamping); 0 for native. */
  pages: number
  from: string
  to: string
  cc: string
  subject: string
  date: string
  docType: string
  attCount: number
  attNames: string
  attKeys: string[]
  attachments: { name: string; content: Buffer }[]
  excludedMeta: ExcludedMeta[]
  /** Absolute target folder for the produced PDF + its attachments. */
  folder: string
  /** Base name (no extension) for the produced PDF. */
  base: string
}

/**
 * Render one document to an UNSTAMPED PDF (+ all the metadata the index needs), with
 * no Bates numbering and no disk write. Safe to run concurrently with other renders —
 * it touches only its own window and the shared excluded sink (an append-only list).
 */
async function renderOne(
  win: ReturnType<typeof makeRenderWindow>,
  doc: IndexedDoc,
  outRoot: string,
  rel: string,
  opts: RenderOpts,
  result: ProductionResult,
  excludedSink: ExcludedAtt[]
): Promise<Rendered> {
  const ext = doc.ext
  const base = path.basename(doc.name, ext)
  const relDir = path.dirname(rel) === '.' ? '' : path.dirname(rel)
  // Produced files live under Documents/ so they never mix with the metadata
  // (review index, load file, highlights), which go in their own folders.
  const docsRoot = path.join(outRoot, 'Documents')
  const docType = doc.docType || (doc.kind === 'email' ? 'Email' : 'Document')
  const excludedMeta: ExcludedMeta[] = []
  const base0 = { doc, rel, from: '', to: '', cc: '', subject: '', date: '', docType, attCount: 0, attNames: '', attKeys: [] as string[], excludedMeta }

  // Native production: copy the original verbatim later; only gather metadata here.
  // Render-time filtering (signatures, excluded attachments) doesn't apply — the
  // original is kept intact.
  if (!opts.convert) {
    if (ext === '.eml') {
      const mail = await simpleParser(await fs.readFile(doc.path))
      const atts = (mail.attachments || []).filter((a) => a.contentDisposition === 'attachment')
      return {
        ...base0,
        native: true,
        pages: 0,
        from: mail.from?.text || '',
        to: addr(mail.to),
        cc: addr(mail.cc),
        subject: mail.subject || '',
        date: mail.date ? mail.date.toISOString().slice(0, 10) : '',
        attCount: atts.length,
        attNames: atts.map((a) => a.filename || 'attachment').join('; '),
        attachments: [],
        folder: path.join(docsRoot, relDir),
        base
      }
    }
    return { ...base0, native: true, pages: 0, subject: doc.title || base, date: doc.date || '', attachments: [], folder: path.join(docsRoot, relDir), base }
  }

  // Assigned on every path below (rendered PDF, slip-sheet, or native doc render); the
  // try/catch around the email render defeats TS's definite-assignment analysis.
  let pdf!: Buffer
  let from = ''
  let to = ''
  let cc = ''
  let subject = ''
  let date = ''
  let attCount = 0
  let attNames = ''
  // Fingerprints (name|size) of this doc's non-embedded attachments — lets a re-run
  // tell whether an exclude/restore change actually touches this doc.
  let attKeys: string[] = []
  let folder: string
  const attachments: { name: string; content: Buffer }[] = []

  if (ext === '.eml') {
    const mail = await simpleParser(await fs.readFile(doc.path))
    const built = buildEmailHtml(mail, { excludeSignatures: opts.excludeSignatures, excludeAttachments: opts.excludeAttachments, excludeFingerprints: opts.excludeFingerprints, recurringImageFps: opts.recurringImageFps, keepAttachments: opts.keepAttachments, keepNames: opts.keepNames })
    // A render that fails or times out must not drop the email from the production (and
    // shift every Bates number after it): fall back to a slip-sheet placeholder + the
    // native .eml, exactly like an unrenderable document, so the sequence stays intact.
    let emailPdf: Buffer | null = null
    try {
      emailPdf = await renderInto(win, built.html)
    } catch (e) {
      result.errors.push({ file: doc.path, error: `render failed, slip-sheeted: ${(e as Error).message}` })
      pdf = await slipSheet(doc.name)
      result.slipSheets++
      attachments.push({ name: doc.name, content: await fs.readFile(doc.path) })
    }
    if (emailPdf) {
      pdf = emailPdf
      // Merge the attachments onto the email PDF, but never let it grind forever. If the
      // merge overruns, keep the un-combined email PDF — its attachments are still added
      // as native files below, so the family stays complete.
      if (opts.combine && built.fileAttachments.length) {
        try {
          pdf = await withTimeout(combineFamily(emailPdf, built.fileAttachments), COMBINE_TIMEOUT_MS, 'combineFamily')
        } catch (e) {
          result.errors.push({ file: doc.path, error: `attachment merge skipped (too slow): ${(e as Error).message}` })
          pdf = emailPdf
        }
      }
    }
    // Excluded-by-filename attachments are routed to Excluded/, not the family folder.
    for (const a of built.excludedAttachments) {
      const meta: ExcludedMeta = { name: a.filename || 'attachment', size: a.content.length }
      excludedMeta.push(meta)
      excludedSink.push({ ...meta, content: a.content, source: rel })
    }
    from = mail.from?.text || ''
    to = addr(mail.to)
    cc = addr(mail.cc)
    subject = mail.subject || ''
    date = mail.date ? mail.date.toISOString().slice(0, 10) : ''
    attCount = built.fileAttachments.length
    attNames = built.fileAttachments.map((a) => a.filename || 'attachment').join('; ')
    attKeys = [...built.fileAttachments, ...built.excludedAttachments].map((a) => attFingerprint(a.filename, a.content?.length || 0))
    for (const a of built.fileAttachments) attachments.push({ name: a.filename || 'attachment', content: a.content })
    // An email with attachments gets its own folder (PDF + native files together).
    folder = attCount > 0 ? path.join(docsRoot, relDir, base) : path.join(docsRoot, relDir)
  } else {
    subject = doc.title || base
    date = doc.date || ''
    folder = path.join(docsRoot, relDir)
    let rendered = await renderDocToPdf(win, doc.path)
    if (!rendered) {
      rendered = await slipSheet(doc.name)
      result.slipSheets++
      // The PDF is only a placeholder — produce the native file alongside it.
      attachments.push({ name: doc.name, content: await fs.readFile(doc.path) })
    } else if (ext === '.xlsx') {
      // Spreadsheets lose fidelity flattened to PDF — keep the native too.
      attachments.push({ name: doc.name, content: await fs.readFile(doc.path) })
    }
    pdf = rendered
  }

  const pages = await pageCount(pdf).catch(() => 1)
  return { doc, rel, native: false, pdf, pages, from, to, cc, subject, date, docType, attCount, attNames, attKeys, attachments, excludedMeta, folder, base }
}

/**
 * Sweep stale files out of the produced Documents/ tree after a run, so the output
 * matches the current document set exactly. Earlier runs can leave two kinds of cruft
 * that a fresh render never cleans on its own:
 *   1. A now-excluded attachment that an earlier run wrote as a separate file beside its
 *      email PDF (excluding it routes it to Excluded/, but the old copy lingers).
 *   2. A whole orphaned folder: when an email's last kept attachment is excluded, its
 *      PDF moves from its own `…/<email>/` folder up to the shared parent, abandoning
 *      the old folder (old PDF + excluded attachment) entirely.
 *
 * The current `items` are the source of truth. A directory that no item produces into
 * is orphaned — every file in it goes. Inside a directory an item DOES produce into, we
 * only remove files that positively match one of that folder's excluded attachments by
 * BOTH name and byte size, so a kept document (even one sharing a name) is never hit.
 */
export async function sweepStaleOutputs(outRoot: string, items: ProdItem[]): Promise<void> {
  const docsRoot = path.join(outRoot, 'Documents')
  const folderOf = (it: ProdItem): string => path.dirname(path.join(outRoot, it.fileRel))
  // Every directory that legitimately holds produced output this run.
  const itemFolders = new Set(items.map((it) => folderOf(it).toLowerCase()))
  // The excluded attachments belonging to each such folder (name|size), so a lingering
  // copy can be matched against the safeName'd on-disk file.
  const exclByFolder = new Map<string, { base: string; size: number }[]>()
  for (const it of items) {
    if (!it.excluded?.length) continue
    const key = folderOf(it).toLowerCase()
    const want = exclByFolder.get(key) ?? []
    for (const e of it.excluded) want.push({ base: safeName(e.name), size: e.size })
    exclByFolder.set(key, want)
  }

  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const inItemFolder = itemFolders.has(dir.toLowerCase())
    const want = exclByFolder.get(dir.toLowerCase()) ?? []
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
        await fs.rmdir(p).catch(() => {}) // drop it if the recursion emptied it
        continue
      }
      if (!inItemFolder) {
        // No item produces here — the whole directory is orphaned (case 2).
        await fs.rm(p, { force: true }).catch(() => {})
        continue
      }
      if (!want.length) continue
      let st: Awaited<ReturnType<typeof fs.stat>>
      try {
        st = await fs.stat(p)
      } catch {
        continue
      }
      const stripped = e.name.replace(/^_+/, '')
      if (want.some((w) => (e.name === w.base || stripped === w.base) && st.size === w.size)) {
        await fs.rm(p, { force: true }).catch(() => {}) // lingering excluded attachment (case 1)
      }
    }
  }
  await walk(docsRoot)
}

/**
 * Name the rendered PDF, appending `.pdf` only when the base doesn't already end in it.
 * A source whose name embeds the extension before its real one — e.g. a drawing emailed
 * as `ATSYD1-…(D)(1).pdf.eml`, whose base (minus `.eml`) is `…(1).pdf` — would otherwise
 * produce `…(1).pdf.pdf`. Case-insensitive so a `.PDF` base isn't doubled either.
 */
export function pdfFileName(base: string): string {
  return /\.pdf$/i.test(base) ? base : base + '.pdf'
}

/** Collapse a doubled `.pdf.pdf` (case-insensitive on the trailing pair) to a single
 *  `.pdf`. Pure — used both to fix names going forward and to migrate stored paths. */
export function dedupePdfExt(name: string): string {
  return name.replace(/(\.pdf)\.pdf$/i, '$1')
}

/**
 * Migrate a previously-produced document whose PDF an earlier run named `…pdf.pdf`:
 * rename the file on disk to the single-extension form and return the item with its
 * `fileRel` corrected, so the reused document's path is right in the load file / index
 * without a re-render. A no-op when the name is already correct; leaves things untouched
 * if the source is missing or the target name is already taken.
 */
async function fixDoubledPdfName(outRoot: string, item: ProdItem): Promise<ProdItem> {
  const fixed = dedupePdfExt(item.fileRel)
  if (fixed === item.fileRel) return item
  const from = path.join(outRoot, item.fileRel)
  const to = path.join(outRoot, fixed)
  try {
    if (await fs.stat(to).then(() => true).catch(() => false)) return item // don't clobber
    await fs.rename(from, to)
  } catch {
    return item // source gone or rename failed — keep the original path
  }
  return { ...item, fileRel: fixed }
}

/**
 * Bates-stamp a rendered document at `batesStart` and write it (and its attachments)
 * to disk. Sequential — `batesStart` depends on every document before it. Returns the
 * index row plus the data a re-run needs to decide reuse.
 */
async function writeRendered(
  r: Rendered,
  outRoot: string,
  batesStart: number,
  prefix: string,
  assignBates: boolean,
  used: Set<string>,
  result: ProductionResult
): Promise<{ rec: ProdRecord; excludedMeta: ExcludedMeta[]; attKeys: string[] }> {
  const batesLabel = (n: number): string => prefix + String(n).padStart(PAD, '0')
  await fs.mkdir(r.folder, { recursive: true })

  if (r.native) {
    let name = safeName(r.doc.name)
    while (used.has(path.join(r.folder, name).toLowerCase())) name = '_' + name
    used.add(path.join(r.folder, name).toLowerCase())
    const outPath = path.join(r.folder, name)
    await fs.copyFile(r.doc.path, outPath)
    const beg = assignBates ? batesLabel(batesStart) : ''
    const rec: ProdRecord = { begBates: beg, endBates: beg, pages: 0, batesSpan: 1, date: r.date, from: r.from, to: r.to, cc: r.cc, subject: r.subject, docType: r.docType, kind: r.doc.kind, fileRel: path.relative(outRoot, outPath), attCount: r.attCount, attNames: r.attNames }
    return { rec, excludedMeta: r.excludedMeta, attKeys: r.attKeys }
  }

  let pdf = r.pdf as Buffer
  const attachments = [...r.attachments]
  // Bates-stamp; a passthrough PDF that can't be loaded (encrypted/corrupt) falls
  // back to a slip sheet so the sequence stays intact.
  let pages = 0
  let begBates = ''
  let endBates = ''
  if (assignBates) {
    try {
      const s = await stampBates(pdf, batesStart, prefix, PAD)
      pdf = s.bytes
      begBates = s.begin
      endBates = s.end
      pages = s.pages
    } catch {
      const slip = await slipSheet(r.doc.name)
      result.slipSheets++
      if (!attachments.some((a) => a.name === r.doc.name)) attachments.push({ name: r.doc.name, content: await fs.readFile(r.doc.path) })
      const s = await stampBates(slip, batesStart, prefix, PAD)
      pdf = s.bytes
      begBates = s.begin
      endBates = s.end
      pages = s.pages
    }
  }

  let pdfName = pdfFileName(r.base)
  while (used.has(path.join(r.folder, pdfName).toLowerCase())) pdfName = '_' + pdfName
  used.add(path.join(r.folder, pdfName).toLowerCase())
  const outPath = path.join(r.folder, pdfName)
  await fs.writeFile(outPath, pdf)

  for (const a of attachments) {
    let n = safeName(a.name)
    while (used.has(path.join(r.folder, n).toLowerCase())) n = '_' + n
    used.add(path.join(r.folder, n).toLowerCase())
    await fs.writeFile(path.join(r.folder, n), a.content)
  }

  const rec: ProdRecord = { begBates, endBates, pages, batesSpan: pages, date: r.date, from: r.from, to: r.to, cc: r.cc, subject: r.subject, docType: r.docType, kind: r.doc.kind, fileRel: path.relative(outRoot, outPath), attCount: r.attCount, attNames: r.attNames }
  return { rec, excludedMeta: r.excludedMeta, attKeys: r.attKeys }
}

/**
 * Render a list of documents concurrently across a small pool of hidden windows,
 * storing each result in `rendered` keyed by doc id. Render failures are recorded on
 * `result.errors` and skipped (no entry stored). `onDone` fires after each render for
 * progress, with the doc just finished.
 */
async function renderInParallel(
  jobs: { doc: IndexedDoc; rel: string }[],
  outRoot: string,
  opts: RenderOpts,
  result: ProductionResult,
  excludedSink: ExcludedAtt[],
  rendered: Map<string, Rendered>,
  isCancelled: () => boolean,
  onDone: (doc: IndexedDoc) => void
): Promise<void> {
  if (!jobs.length) return
  // Cap the pool to the work and to (cores − 2); each window is a full renderer, so a
  // handful saturates the machine without exhausting memory.
  const poolSize = Math.max(1, Math.min(jobs.length, (os.cpus().length || 4) - 2, 6))
  const wins = Array.from({ length: poolSize }, () => makeRenderWindow())
  let next = 0
  const worker = async (win: ReturnType<typeof makeRenderWindow>): Promise<void> => {
    for (;;) {
      if (isCancelled()) return
      const idx = next++
      if (idx >= jobs.length) return
      const job = jobs[idx]
      try {
        rendered.set(job.doc.id, await renderOne(win, job.doc, outRoot, job.rel, opts, result, excludedSink))
      } catch (e) {
        result.errors.push({ file: job.doc.path, error: (e as Error).message })
      }
      onDone(job.doc)
    }
  }
  try {
    await Promise.all(wins.map((w) => worker(w)))
  } finally {
    for (const w of wins) w.destroy()
  }
}

/**
 * Parse an email and return just its excluded attachments (content + source), with no
 * PDF render. Lets an incremental run keep the Excluded/ folder + map complete for docs
 * whose PDF was reused (only the affected docs are re-rendered).
 */
async function collectExcluded(
  doc: IndexedDoc,
  rel: string,
  opts: { excludeSignatures: boolean; excludeAttachments: string[]; excludeFingerprints: Set<string>; recurringImageFps: Set<string>; keepAttachments: Set<string>; keepNames: Set<string> }
): Promise<ExcludedAtt[]> {
  if (doc.ext !== '.eml') return []
  try {
    const mail = await simpleParser(await fs.readFile(doc.path))
    const built = buildEmailHtml(mail, opts)
    return built.excludedAttachments.map((a) => ({ name: a.filename || 'attachment', size: a.content.length, content: a.content, source: rel }))
  } catch {
    return []
  }
}

/**
 * Where a restored attachment will land: its source email's own family folder under
 * Documents/ (an email with ≥1 kept attachment gets a subfolder named after it). Derived
 * from the excluded record's `source` (the email's relative path) and returned as a
 * forward-slash path so the UI can point the user at where to look for the restored copy.
 */
export function intendedDirOf(source: string): string {
  const norm = source.replace(/\\/g, '/')
  const ext = path.posix.extname(norm)
  const dir = path.posix.dirname(norm)
  const base = path.posix.basename(norm, ext)
  return path.posix.join('Documents', dir === '.' ? '' : dir, base)
}

/**
 * Write excluded attachments to <output>/Excluded/ for review. Copies of a filename
 * that are byte-for-byte identical (verified by content hash) collapse to one file —
 * that's the only sure test that they're the same. If a filename has more than one
 * distinct version, we DON'T assume they match: every version is written into a folder
 * named after the file (each tagged with its byte size) so the reviewer can compare
 * them. Called only on a full render, when every excluded attachment's content is in hand.
 */
export async function writeExcludedFolder(outRoot: string, excluded: ExcludedAtt[]): Promise<void> {
  const dir = path.join(outRoot, 'Excluded')
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {}) // fresh slate
  if (!excluded.length) return
  await fs.mkdir(dir, { recursive: true })

  const groups = new Map<string, ExcludedAtt[]>()
  for (const e of excluded) {
    const key = e.name.trim().toLowerCase()
    const arr = groups.get(key)
    if (arr) arr.push(e)
    else groups.set(key, [e])
  }

  // Never let two distinct files share an output path (odd characters in a filename, or
  // two copies with the same byte size) — disambiguate with a "_".
  const used = new Set<string>()
  const uniqueIn = (base: string, name: string): string => {
    let n = safeName(name)
    while (used.has(path.join(base, n).toLowerCase())) n = '_' + n
    used.add(path.join(base, n).toLowerCase())
    return path.join(base, n)
  }
  const hashOf = (b: Buffer): string => createHash('sha1').update(b).digest('hex')
  const dirsOf = (sources: Set<string>): string[] => [...new Set([...sources].map(intendedDirOf))].sort()

  // Collapse ONLY byte-identical copies of a filename — a content hash is the one sure
  // test that two files are the same. If a name still has more than one distinct version,
  // we can't assume they're the same file, so every version is written into a folder
  // named after the file for the reviewer to compare (rather than silently dropping any).
  // Each written file records the produced folder(s) a restore would put it back into.
  const restoreMap: Record<string, string[]> = {}
  for (const items of groups.values()) {
    const byHash = new Map<string, { rep: ExcludedAtt; sources: Set<string> }>()
    for (const it of items) {
      const g = byHash.get(hashOf(it.content))
      if (g) g.sources.add(it.source)
      else byHash.set(hashOf(it.content), { rep: it, sources: new Set([it.source]) })
    }
    const distinct = [...byHash.values()].sort((a, b) => a.rep.size - b.rep.size)
    if (distinct.length === 1) {
      // Every copy is byte-for-byte identical — one file, definitely the same.
      const d = distinct[0]
      const outPath = uniqueIn(dir, d.rep.name)
      await fs.writeFile(outPath, d.rep.content)
      restoreMap[path.basename(outPath)] = dirsOf(d.sources)
    } else {
      // Same name, different bytes — group every version in a folder to be checked.
      const folder = uniqueIn(dir, path.basename(items[0].name))
      await fs.mkdir(folder, { recursive: true })
      for (const d of distinct) {
        const ext = path.extname(d.rep.name)
        const outPath = uniqueIn(folder, `${path.basename(d.rep.name, ext)} (${d.rep.size} bytes)${ext}`)
        await fs.writeFile(outPath, d.rep.content)
        restoreMap[path.basename(outPath)] = dirsOf(d.sources)
      }
    }
  }

  // The listing names every excluded image individually — one row per instance, each
  // with the exact file it was removed from — so the same logo appearing across many
  // emails stays fully traceable instead of collapsing into one joined "From emails" cell.
  const listing: string[][] = [['Filename', 'Size (bytes)', 'Removed from']]
  for (const e of [...excluded].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.size - b.size)) {
    listing.push([e.name, String(e.size), e.source])
  }

  await fs.writeFile(path.join(dir, 'Excluded Attachments.xlsx'), await rowsToXlsx(listing, 'Excluded'))
  // Hidden sidecar (filtered from the explorer) the renderer reads to show, per excluded
  // file, the produced folder(s) a restore would land in.
  await fs.writeFile(path.join(dir, '.restore-map.json'), JSON.stringify(restoreMap))
}

export async function buildProduction(
  collection: Collection,
  docs: IndexedDoc[],
  emit: Emit,
  isCancelled: () => boolean
): Promise<ProductionResult> {
  const features = collection.features as ProcessFeatures
  const outRoot = path.resolve(collection.output as string)
  const result: ProductionResult = { pdfCount: 0, processed: 0, skipped: 0, removed: 0, slipSheets: 0, excludedAttachments: 0, errors: [] }
  const excludeAttachments = collection.excludeAttachments ?? []
  // Per-file exclusions (name|size) — "exclude just this file", vs the by-name list above.
  const excludeFingerprints = new Set(collection.excludeFingerprints ?? [])
  // Fingerprints (name|size) of attachments the user restored — never excluded again.
  const keepAttachments = new Set(collection.keepAttachments ?? [])
  // "Keep all of this name" — a name-scoped restore that overrides every exclusion rule.
  const keepNames = new Set((collection.keepNames ?? []).map((s) => s.trim().toLowerCase()))
  await fs.mkdir(outRoot, { recursive: true })

  // A review index or production includes every doc; "convert to PDF" alone produces
  // just emails. With convert off, documents are copied as natives instead of rendered.
  const fullProduction = features.reviewIndex || features.loadFile
  const convert = features.emailToPdf
  // Bates order: documents already produced keep their prior position (so their
  // Bates number never shifts and they're reused as-is); newly added documents are
  // appended after, path-sorted. This makes "add sources" incremental — only the
  // new documents are processed, matching how Bates numbers are assigned in practice
  // (existing production stays numbered; new docs get the next numbers).
  type AttFpEntry = { mtime: number; size: number; imgs: string[] }
  const saved = (await getProductionManifest(collection.id)) as {
    config?: string
    items?: ProdItem[]
    attFp?: Record<string, AttFpEntry>
    excludeAttachments?: string[]
    excludeFingerprints?: string[]
    keepAttachments?: string[]
    keepNames?: string[]
  } | null
  const priorOrder = new Map((saved?.items ?? []).map((it, i) => [it.id, i] as const))
  const targets = productionTargets(docs, features).sort((a, b) => {
    const ia = priorOrder.has(a.id) ? (priorOrder.get(a.id) as number) : Number.MAX_SAFE_INTEGER
    const ib = priorOrder.has(b.id) ? (priorOrder.get(b.id) as number) : Number.MAX_SAFE_INTEGER
    return ia !== ib ? ia - ib : a.path.localeCompare(b.path)
  })

  // A review index / production needs Bates; default a prefix if the user didn't set one.
  const bates = collection.bates ?? (fullProduction ? { prefix: 'DOC-', start: 1 } : null)
  const assignBates = !!bates
  const prefix = bates?.prefix ?? ''
  let batesNext = bates?.start ?? 1
  const label = (n: number): string => prefix + String(n).padStart(PAD, '0')

  // Mirror the input layout in the output: a file under source folder "<root>"
  // lands at Documents/<root-name>/<path-within-root>, so the produced bundle keeps
  // the source folders and their structure (and same-named subfolders from different
  // sources don't merge). A file added as a source on its own just uses its filename.
  const inRoots = collection.folders.map((f) => path.resolve(f))
  const relFor = (p: string): string => {
    const root = inRoots.find((r) => p === r || p.startsWith(r + path.sep))
    if (!root || p === root) return path.basename(p)
    return path.join(path.basename(root), path.relative(root, p))
  }

  // Set-wide prescan: fingerprint each email's image attachments and flag the ones
  // that recur across many emails as signature logos — a real picture is attached
  // once, a logo is re-attached to every message. Fingerprints are cached per-doc in
  // the manifest, so an incremental run only re-parses changed emails. Only needed
  // when excluding signatures (the feature that acts on the flagged logos).
  const savedAttFp = saved?.attFp ?? {}
  const attFp: Record<string, AttFpEntry> = {}
  const recurringImageFps = new Set<string>()
  if (collection.excludeSignatures) {
    const emails = targets.filter((d) => d.kind === 'email')
    emit({ type: 'index-progress', collectionId: collection.id, phase: 'Scanning for repeated logos', done: 0, total: emails.length })
    // Parse cache-miss emails concurrently: each parse is dominated by reading the .eml
    // and base64-decoding its attachments, so overlapping them finishes the scan far
    // quicker than one-at-a-time on a fresh set. Unchanged emails reuse the cached scan.
    const scanImgs = async (doc: IndexedDoc): Promise<string[]> => {
      try {
        const mail = await simpleParser(await fs.readFile(doc.path))
        return [
          ...new Set(
            (mail.attachments || [])
              .filter((a) => (a.contentType || '').startsWith('image/'))
              .map((a) => attFingerprint(a.filename, a.content?.length || 0))
          )
        ]
      } catch {
        return []
      }
    }
    let next = 0
    let done = 0
    const pool = Math.max(2, Math.min(emails.length, (os.cpus().length || 4)))
    const worker = async (): Promise<void> => {
      for (;;) {
        if (isCancelled()) return
        const idx = next++
        if (idx >= emails.length) return
        const doc = emails[idx]
        const cached = savedAttFp[doc.id]
        attFp[doc.id] =
          cached && cached.mtime === doc.modifiedAt && cached.size === doc.size
            ? cached
            : { mtime: doc.modifiedAt, size: doc.size, imgs: await scanImgs(doc) }
        done++
        if (done % 16 === 0 || done === emails.length)
          emit({ type: 'index-progress', collectionId: collection.id, phase: 'Scanning for repeated logos', done, total: emails.length, currentFile: doc.name })
      }
    }
    await Promise.all(Array.from({ length: pool }, () => worker()))
    const freq = new Map<string, number>()
    for (const doc of emails) for (const fp of attFp[doc.id]?.imgs ?? []) freq.set(fp, (freq.get(fp) || 0) + 1) // imgs deduped per doc
    for (const [fp, n] of freq) if (n >= MIN_RECURRENCE) recurringImageFps.add(fp)
  }
  const recurringHash = hashStr([...recurringImageFps].sort().join('\n'))

  // Scan input-vs-output: reuse documents that are unchanged AND would land on the
  // same Bates number; only (re)render new/changed docs (or ones whose numbering
  // shifted because something earlier in the sequence changed).
  emit({ type: 'index-progress', collectionId: collection.id, phase: 'Checking for changes', done: 0, total: targets.length })
  // Set-wide render options. If any differ from the last run, every cached PDF is stale,
  // so ignore the manifest and re-render everything. excludeAttachments/keepAttachments
  // are deliberately NOT here — those touch only specific emails, so they invalidate
  // per-doc (below) instead of nuking the whole manifest. The recurring-logo set IS
  // here: if it shifts, every email must re-render.
  const configKey = JSON.stringify({
    combine: !!collection.combineAttachments,
    excludeSignatures: !!collection.excludeSignatures,
    recurringHash,
    bates: collection.bates ?? null,
    emailToPdf: features.emailToPdf,
    // Only what affects RENDERING belongs here. Review index / load file individually
    // don't change the PDFs — they only widen the render SCOPE to every doc (vs emails
    // only), captured by this one flag. So enabling the load file when a review index is
    // already on regenerates the load file from existing records WITHOUT re-rendering.
    fullProduction: features.reviewIndex || features.loadFile
  })
  const prevManifest = saved && saved.config === configKey ? saved.items ?? [] : []
  const prevById = new Map(prevManifest.map((p) => [p.id, p]))

  // Per-doc invalidation for exclude/restore: a doc is re-rendered only if one of its
  // own attachments had its exclude/keep state flipped since the last run. Everything
  // else is reused — so toggling one attachment no longer re-renders the whole set.
  const norm = (s: string): string => s.trim().toLowerCase()
  // Which attachment rules changed since the last run, split into name-scoped and
  // fingerprint-scoped sets (exclude + keep on both axes). A doc re-renders only if one
  // of its own attachments is hit by a changed rule (docExcludeAffected, below).
  const changedExclNames = symmetricDiff((saved?.excludeAttachments ?? []).map(norm), excludeAttachments.map(norm))
  const changedKeepNames = symmetricDiff((saved?.keepNames ?? []).map(norm), [...keepNames])
  const changedExclFps = symmetricDiff(saved?.excludeFingerprints ?? [], [...excludeFingerprints])
  const changedKeepFps = symmetricDiff(saved?.keepAttachments ?? [], [...keepAttachments])
  const changedNames = new Set([...changedExclNames, ...changedKeepNames])
  const changedFps = new Set([...changedExclFps, ...changedKeepFps])
  const excludeChanged = changedNames.size > 0 || changedFps.size > 0
  const docAffected = (prev: ProdItem): boolean => docExcludeAffected(prev.attKeys, changedNames, changedFps)
  const exclOpts = { excludeSignatures: !!collection.excludeSignatures, excludeAttachments, excludeFingerprints, recurringImageFps, keepAttachments, keepNames }
  const currentIds = new Set(targets.map((d) => d.id))
  result.removed = prevManifest.filter((p) => !currentIds.has(p.id)).length
  const outputExists = async (rel: string): Promise<boolean> => {
    try {
      await fs.stat(path.join(outRoot, rel))
      return true
    } catch {
      return false
    }
  }

  const used = new Set<string>()
  const items: ProdItem[] = []
  const excludedSink: ExcludedAtt[] = []
  // Reused emails that carry attachments — we re-collect their excluded attachments
  // (parse only, no render) when the Excluded/ folder needs rebuilding.
  const reusedWithAtts: { doc: IndexedDoc; rel: string }[] = []
  const renderOpts: RenderOpts = {
    convert,
    combine: !!collection.combineAttachments,
    excludeSignatures: !!collection.excludeSignatures,
    excludeAttachments,
    excludeFingerprints,
    recurringImageFps,
    keepAttachments,
    keepNames
  }

  // Numbering (Bates) is strictly sequential — each document's number depends on the
  // page count of every document before it — but RENDERING (the slow part) is not.
  // So: render in parallel, then number + write in order.
  //
  // Phase 1 — classify. A document is reusable when its file and the attachment rules
  // are unchanged since the last run; this is render-free, so it's cheap.
  type Plan = { doc: IndexedDoc; rel: string; prev?: ProdItem; contentReuse: boolean }
  const plans: Plan[] = []
  for (const doc of targets) {
    const prev = prevById.get(doc.id)
    const contentReuse =
      !!prev && prev.mtime === doc.modifiedAt && prev.size === doc.size && !docAffected(prev) && (await outputExists(prev.fileRel))
    plans.push({ doc, rel: relFor(doc.path), prev, contentReuse })
  }

  // Phase 2 — render every changed document concurrently across a window pool.
  const rendered = new Map<string, Rendered>()
  let renderDone = 0
  const changed = plans.filter((p) => !p.contentReuse)
  // The honest denominator for "Rendering documents" is how many docs actually get
  // rendered — the changed ones now, plus the Bates-shifted ones found in phase 3 (added
  // to renderTotal before phase 4). Phases 2 and 4 share emitRender, so renderDone spans
  // both; keeping renderTotal in step means the count reads e.g. 3/12, not a meaningless
  // 12/12. (Was Math.max(changed.length, renderDone), which made total track done.)
  let renderTotal = changed.length
  const emitRender = (doc: IndexedDoc): void => {
    renderDone++
    emit({ type: 'index-progress', collectionId: collection.id, phase: 'Rendering documents', done: renderDone, total: renderTotal, currentFile: doc.name })
  }
  if (!isCancelled()) await renderInParallel(changed, outRoot, renderOpts, result, excludedSink, rendered, isCancelled, emitRender)

  // Phase 3 — a content-unchanged document still needs a fresh stamp if an earlier
  // document changed page count and pushed its Bates number along. Walk in order with
  // predicted page spans to find those shifted documents.
  const spanOf = (p: Plan): number =>
    p.contentReuse ? p.prev?.batesSpan ?? p.prev?.pages ?? 0 : rendered.get(p.doc.id)?.pages ?? 0
  const shifted: Plan[] = []
  let planBates = batesNext
  for (const p of plans) {
    if (assignBates && p.contentReuse && p.prev && p.prev.begBates !== label(planBates)) shifted.push(p)
    planBates += spanOf(p)
  }

  // Phase 4 — render the shifted documents in parallel too (re-stamping a PDF means
  // re-rendering it: the on-disk copy already carries its old number). Now that we know
  // how many shifted, fold them into the rendering denominator.
  renderTotal += shifted.length
  if (!isCancelled() && shifted.length) await renderInParallel(shifted, outRoot, renderOpts, result, excludedSink, rendered, isCancelled, emitRender)

  // Phase 5 — number + write in strict order. Reuse only when the file is unchanged AND
  // the Bates number still matches; otherwise stamp from the render (or, in the rare
  // case a number drifted unexpectedly, render inline now as a fallback).
  const inlineWin = makeRenderWindow()
  try {
    for (let i = 0; i < plans.length; i++) {
      if (isCancelled()) break
      const p = plans[i]
      emit({ type: 'index-progress', collectionId: collection.id, phase: 'Numbering documents', done: i, total: plans.length, currentFile: p.doc.name })
      if (p.contentReuse && p.prev && (!assignBates || p.prev.begBates === label(batesNext))) {
        // One-time migration: an earlier run named a PDF `…pdf.pdf` (base already ended
        // in .pdf). Rename it to the single-extension form and fix the stored path so the
        // load file / review index pick it up — without forcing a re-render.
        const prev = await fixDoubledPdfName(outRoot, p.prev)
        items.push(prev) // reuse the already-produced document + its Bates
        used.add(path.join(outRoot, prev.fileRel).toLowerCase())
        batesNext += prev.batesSpan ?? prev.pages
        result.skipped++
        result.pdfCount++
        if (prev.attKeys && prev.attKeys.length) reusedWithAtts.push({ doc: p.doc, rel: p.rel })
        continue
      }
      let r = rendered.get(p.doc.id)
      if (!r) {
        try {
          r = await renderOne(inlineWin, p.doc, outRoot, p.rel, renderOpts, result, excludedSink)
        } catch (e) {
          result.errors.push({ file: p.doc.path, error: (e as Error).message })
          continue
        }
      }
      try {
        const { rec, excludedMeta, attKeys } = await writeRendered(r, outRoot, batesNext, prefix, assignBates, used, result)
        items.push({ id: p.doc.id, path: p.doc.path, mtime: p.doc.modifiedAt, size: p.doc.size, excluded: excludedMeta, attKeys, ...rec })
        batesNext += rec.batesSpan
        result.processed++
        result.pdfCount++
      } catch (e) {
        result.errors.push({ file: p.doc.path, error: (e as Error).message })
      }
    }
  } finally {
    inlineWin.destroy()
  }
  emit({ type: 'index-progress', collectionId: collection.id, phase: 'Numbering documents', done: targets.length, total: targets.length })

  // Rebuild the Excluded/ folder + map + listing whenever the excluded set could have
  // changed (an exclude/restore toggle, or any doc re-rendered). Re-rendered docs
  // already filled excludedSink; top it up with the reused docs' excluded attachments
  // (parse only) so the folder stays complete without re-rendering them.
  const summary = excludedSummary(items.flatMap((i) => i.excluded ?? []))
  result.excludedAttachments = summary.total
  const rebuildExcluded = excludeChanged || result.processed > 0
  if (!isCancelled() && rebuildExcluded) {
    for (const { doc, rel } of reusedWithAtts) {
      if (isCancelled()) break
      excludedSink.push(...(await collectExcluded(doc, rel, exclOpts)))
    }
    if (!isCancelled()) await writeExcludedFolder(outRoot, excludedSink)
  }

  // A full run produced every current document, so `items` is the complete picture of
  // what Documents/ should contain. Sweep anything an earlier run left behind that no
  // longer belongs — a now-excluded attachment still sitting beside its email, an
  // abandoned family folder, or the output of a document removed from the set. Skipped
  // on a cancelled run, where `items` is only partial.
  if (!isCancelled()) await sweepStaleOutputs(outRoot, items)

  // Persist the manifest (full or partial) so a paused run resumes from here.
  // attFp caches the attachment fingerprints so the next run's prescan can skip
  // re-parsing unchanged emails.
  await saveProductionManifest(collection.id, {
    config: configKey,
    items,
    attFp: collection.excludeSignatures ? attFp : savedAttFp,
    excludeAttachments: [...excludeAttachments],
    excludeFingerprints: [...excludeFingerprints],
    keepAttachments: [...keepAttachments],
    keepNames: [...keepNames]
  })
  // Paused/cancelled mid-render: leave the index/load-file regeneration for the
  // resume run (when the full set is produced).
  if (isCancelled()) return result

  const records: ProdRecord[] = items
  if (assignBates && records.length) {
    const first = records.find((r) => r.begBates)
    const last = [...records].reverse().find((r) => r.endBates)
    if (first && last) result.batesRange = { begin: first.begBates, end: last.endBates }
  }

  // Metadata is kept out of the Documents/ tree: review reports → Reports/, the
  // production load file → Load Files/. Its FILE NAME paths stay relative to the
  // output root (Documents/…) — the volume-root convention review platforms use.
  const reportsDir = path.join(outRoot, 'Reports')
  const loadFilesDir = path.join(outRoot, 'Load Files')

  // Review index — human-readable, for your own review team (internal).
  if (features.reviewIndex && records.length) {
    await fs.mkdir(reportsDir, { recursive: true })
    const p = path.join(reportsDir, 'Review Index.xlsx')
    await fs.writeFile(p, await rowsToXlsx([REVIEW_HEADER, ...reviewIndexRows(records)], 'Review Index'))
    result.indexPath = p
  }

  // Production load file — Concordance .DAT + universal .CSV, with family ranges (external).
  if (features.loadFile && records.length) {
    await fs.mkdir(loadFilesDir, { recursive: true })
    const table = [LOADFILE_HEADER, ...loadFileRows(records)]
    const datPath = path.join(loadFilesDir, 'Production Load File.dat')
    await fs.writeFile(datPath, toDat(table))
    await fs.writeFile(path.join(loadFilesDir, 'Production Load File.csv'), toCsv(table))
    result.loadFilePath = datPath
  }

  // Highlights table — flatten every reviewer mark across the set.
  if (features.highlights) {
    const hrows = highlightRows(docs)
    if (hrows.length) {
      await fs.mkdir(reportsDir, { recursive: true })
      const p = path.join(reportsDir, 'Highlights.xlsx')
      await fs.writeFile(p, await rowsToXlsx([HIGHLIGHT_HEADER, ...hrows], 'Highlights'))
      result.highlightsPath = p
    }
  }

  return result
}
