import { promises as fs } from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { BrowserWindow } from 'electron'
import { renderInto } from './emailToPdf'

// Render a non-email document to a PDF so it can join a Bates-numbered production.
// Word/sheets/text are turned into clean print HTML and run through the same
// hidden Electron window the email renderer uses; PDFs pass through untouched;
// images become a single page. Anything we can't render gets a slip sheet.

const MAX_TEXT = 200_000 // cap raw text dumps so a giant file can't blow up the PDF

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #14171f; }
  .dsl-title { font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: #6b7691;
    border-bottom: 1px solid #e2e6ee; padding-bottom: 6px; margin-bottom: 16px; }
  h1, h2, h3, h4 { line-height: 1.25; }
  p { margin: 0 0 10px; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 8px 0; }
  td, th { border: 1px solid #cbd2e0; padding: 4px 7px; text-align: left; vertical-align: top; }
  th { background: #f1f4f9; }
  .dsl-pre { white-space: pre-wrap; word-wrap: break-word; font: 12px/1.5 "SFMono-Regular", Menlo, Consolas, monospace; }
  .dsl-sheet { margin-bottom: 18px; }
  .dsl-sheet-name { font-weight: 600; font-size: 12px; margin: 4px 0; color: #334155; }
`

function pageHtml(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div class="dsl-title">${esc(title)}</div>${inner}</body></html>`
}

async function docxToHtml(filePath: string): Promise<string> {
  const { value } = await mammoth.convertToHtml({ path: filePath })
  return value || '<p>(empty document)</p>'
}

async function xlsxToHtml(filePath: string): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const parts: string[] = []
  wb.eachSheet((ws) => {
    const rows: string[] = []
    let n = 0
    ws.eachRow((row) => {
      if (n++ > 1000) return // cap rows so a huge sheet stays a sane PDF
      const cells = (row.values as unknown[])
        .slice(1)
        .map((v) => `<td>${esc(v == null ? '' : String(v))}</td>`)
      rows.push('<tr>' + cells.join('') + '</tr>')
    })
    parts.push(
      `<div class="dsl-sheet"><div class="dsl-sheet-name">${esc(ws.name)}</div><table>${rows.join('')}</table></div>`
    )
  })
  return parts.join('') || '<p>(empty workbook)</p>'
}

function textToHtml(text: string): string {
  return `<pre class="dsl-pre">${esc(text.slice(0, MAX_TEXT))}</pre>`
}

async function imageToPdf(filePath: string, isPng: boolean): Promise<Buffer> {
  const bytes = await fs.readFile(filePath)
  const doc = await PDFDocument.create()
  const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
  const page = doc.addPage([595.28, 841.89]) // A4 pt
  const m = 36
  const scale = Math.min((595.28 - m * 2) / img.width, (841.89 - m * 2) / img.height, 1)
  page.drawImage(img, { x: m, y: 841.89 - m - img.height * scale, width: img.width * scale, height: img.height * scale })
  return Buffer.from(await doc.save())
}

/**
 * Render one non-email file to a PDF Buffer. Returns null if the type isn't
 * renderable here (caller falls back to a slip sheet).
 */
export async function renderDocToPdf(win: BrowserWindow, filePath: string): Promise<Buffer | null> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.pdf') return fs.readFile(filePath) // already a PDF — use as produced
  if (ext === '.png') return imageToPdf(filePath, true)
  if (ext === '.jpg' || ext === '.jpeg') return imageToPdf(filePath, false)

  let inner: string
  if (ext === '.docx') inner = await docxToHtml(filePath)
  else if (ext === '.xlsx') inner = await xlsxToHtml(filePath)
  else if (ext === '.txt' || ext === '.md' || ext === '.csv') inner = textToHtml(await fs.readFile(filePath, 'utf8'))
  else return null

  return renderInto(win, pageHtml(path.basename(filePath), inner))
}

/**
 * A one-page placeholder for a file we couldn't render — its Bates number still
 * stands in the production, and the native file is produced alongside it.
 */
export async function slipSheet(fileName: string, note = 'Document produced in native format'): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595.28, 841.89])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const { width, height } = page.getSize()
  const centre = (text: string, y: number, f: typeof font, size: number, color: ReturnType<typeof rgb>): void => {
    const w = f.widthOfTextAtSize(text, size)
    page.drawText(text, { x: Math.max(40, (width - w) / 2), y, size, font: f, color })
  }
  centre(note, height / 2 + 14, font, 11, rgb(0.42, 0.46, 0.53))
  const fn = fileName.length > 72 ? fileName.slice(0, 69) + '…' : fileName
  centre(fn, height / 2 - 12, bold, 14, rgb(0.08, 0.1, 0.14))
  return Buffer.from(await doc.save())
}
