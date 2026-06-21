import { promises as fs } from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

const CFB = (XLSX as unknown as { CFB: { read: (b: Buffer, o: { type: string }) => unknown; find: (c: unknown, n: string) => { content?: Uint8Array } | null } }).CFB

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Legacy .xls (BIFF) → CSV-ish plain text per sheet (for indexing/search). */
export async function xlsText(p: string): Promise<string> {
  const wb = XLSX.read(await fs.readFile(p), { type: 'buffer' })
  return wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n')
}

/** Legacy .xls → one HTML table per sheet (SheetJS reads the old BIFF format). */
async function xlsToHtml(p: string): Promise<string> {
  const wb = XLSX.read(await fs.readFile(p), { type: 'buffer' })
  let out = ''
  for (const name of wb.SheetNames) {
    const full = XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false })
    const table = (full.match(/<table[\s\S]*?<\/table>/i) || [full])[0]
    out += `<h3>${esc(name)}</h3>${table}`
  }
  return `<div class="sheet">${out || '<p class="muted">(no sheets)</p>'}</div>`
}

/** Pull the "PowerPoint Document" stream out of a legacy .ppt (an OLE/CFB compound
 *  file); fall back to the whole file if it can't be parsed. */
async function pptDocStream(p: string): Promise<Buffer> {
  const buf = await fs.readFile(p)
  try {
    const cfb = CFB.read(buf, { type: 'buffer' })
    const s = CFB.find(cfb, 'PowerPoint Document') || CFB.find(cfb, '/PowerPoint Document')
    if (s?.content) return Buffer.from(s.content)
  } catch {
    /* not a CFB / unreadable — scan the raw bytes */
  }
  return buf
}

/** Walk the PowerPoint binary records and pull text from TextChars (UTF-16) and
 *  TextBytes (ANSI) atoms — legacy .ppt has no zip/XML, so we parse the records. */
function pptAtomsToText(data: Buffer): string {
  const parts: string[] = []
  const walk = (start: number, end: number): void => {
    let i = start
    while (i + 8 <= end) {
      const verInst = data.readUInt16LE(i)
      const recType = data.readUInt16LE(i + 2)
      const recLen = data.readUInt32LE(i + 4)
      const cStart = i + 8
      const cEnd = Math.min(end, cStart + recLen)
      if (cEnd <= cStart && recLen > 0) break // corrupt length — stop this branch
      if (recType === 0x0fa0) parts.push(data.toString('utf16le', cStart, cEnd)) // TextCharsAtom
      else if (recType === 0x0fa8) parts.push(data.toString('latin1', cStart, cEnd)) // TextBytesAtom
      else if ((verInst & 0x000f) === 0x000f) walk(cStart, cEnd) // container — recurse
      i = cEnd
    }
  }
  walk(0, data.length)
  return parts
    .join('\n')
    .replace(/[\v\r]/g, '\n') // PPT uses 0x0B/0x0D for line/paragraph breaks
    .replace(/[\x00-\x08\x0e-\x1f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Legacy .ppt → extracted text (for indexing/search). */
export async function pptText(p: string): Promise<string> {
  return pptAtomsToText(await pptDocStream(p))
}

/** Legacy .ppt → a readable text view (no zip/XML and no LibreOffice, so this is a
 *  best-effort text extraction, not a pixel render). */
async function pptToHtml(p: string): Promise<string> {
  const text = pptAtomsToText(await pptDocStream(p))
  if (!text) return '<div class="slides"><p class="muted">(no extractable text)</p></div>'
  const blocks = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  return `<div class="slides"><section>${blocks.map((b) => `<p>${esc(b)}</p>`).join('')}</section></div>`
}

/** Word → HTML (mammoth produces clean, script-free markup). */
async function docxToHtml(p: string): Promise<string> {
  const { value } = await mammoth.convertToHtml({ path: p })
  return `<div class="doc">${value}</div>`
}

/** Excel → one HTML table per sheet (cell.text flattens formulas/dates to display text). */
/** Derive a cell's display text from its raw value, handling every ExcelJS value shape
 *  without throwing. Used as a fallback because ExcelJS's `cell.text` getter throws
 *  "Cannot read properties of null (reading 'toString')" on some real-world cells
 *  (e.g. a formula / shared-formula cell whose cached result is null). */
function valueText(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toLocaleDateString()
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return o.richText.map((r) => (r as { text?: string }).text ?? '').join('')
    if (o.text != null) return String(o.text) // hyperlink { text, hyperlink }
    if ('result' in o) return valueText(o.result) // formula { formula, result } — result may be null
    if (o.error != null) return String(o.error) // error value { error }
    return ''
  }
  return String(v)
}

function cellText(cell: ExcelJS.Cell): string {
  // Prefer ExcelJS's own formatting, but never let one malformed cell break the preview.
  try {
    const t = cell.text
    if (t != null) return String(t)
  } catch {
    /* .text getter threw (null toString) — fall back to the raw value below */
  }
  return valueText(cell.value)
}

async function xlsxToHtml(p: string): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(p)
  let out = ''
  wb.eachSheet((ws) => {
    out += `<h3>${esc(ws.name)}</h3>`
    let last = 0
    ws.eachRow({ includeEmpty: false }, (row) => {
      last = Math.max(last, row.cellCount)
    })
    if (!last) {
      out += '<p class="muted">(empty sheet)</p>'
      return
    }
    out += '<table>'
    ws.eachRow({ includeEmpty: false }, (row) => {
      out += '<tr>'
      for (let c = 1; c <= last; c++) out += `<td>${esc(cellText(row.getCell(c)))}</td>`
      out += '</tr>'
    })
    out += '</table>'
  })
  return `<div class="sheet">${out || '<p class="muted">(no sheets)</p>'}</div>`
}

/** The text runs of each slide in a .pptx/.ppsx (both are the same Open XML zip). */
async function pptxSlides(p: string): Promise<string[][]> {
  const zip = await JSZip.loadAsync(await fs.readFile(p))
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0))
  const slides: string[][] = []
  for (const n of names) {
    const xml = await zip.files[n].async('string')
    slides.push(
      [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim())
        .filter(Boolean)
    )
  }
  return slides
}

/** PowerPoint (.pptx/.ppsx) → joined slide text (for indexing/search). */
export async function pptxText(p: string): Promise<string> {
  return (await pptxSlides(p)).map((runs) => runs.join('\n')).join('\n\n')
}

/** PowerPoint → a text outline per slide (no LibreOffice, so this isn't a pixel
 *  render — it surfaces every slide's text so the content is reviewable). */
async function pptxToHtml(p: string): Promise<string> {
  const slides = await pptxSlides(p)
  if (!slides.length) return '<div class="slides"><p class="muted">(no slides found)</p></div>'
  const out = slides
    .map(
      (runs, i) =>
        `<section><div class="slide-no">Slide ${i + 1}</div>${
          runs.length ? runs.map((t) => `<p>${esc(t)}</p>`).join('') : '<p class="muted">(no text)</p>'
        }</section>`
    )
    .join('')
  return `<div class="slides">${out}</div>`
}

/**
 * Render a Microsoft Office document to a self-contained HTML fragment for inline
 * preview. Returns script-free markup the renderer styles + injects. Office formats
 * have no native preview in Electron, so we convert with pure-JS libraries.
 */
export async function renderOfficeHtml(p: string): Promise<{ ok: boolean; html?: string; error?: string }> {
  const ext = path.extname(p).toLowerCase()
  try {
    if (ext === '.docx') return { ok: true, html: await docxToHtml(p) }
    if (ext === '.xlsx' || ext === '.xlsm') return { ok: true, html: await xlsxToHtml(p) }
    if (ext === '.xls') return { ok: true, html: await xlsToHtml(p) }
    if (ext === '.pptx' || ext === '.ppsx') return { ok: true, html: await pptxToHtml(p) }
    if (ext === '.ppt') return { ok: true, html: await pptToHtml(p) }
    return { ok: false, error: `No office renderer for ${ext}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
