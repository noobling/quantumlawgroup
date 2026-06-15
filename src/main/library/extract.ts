import { promises as fs } from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import type { DocKind } from '@shared/types'

// Shared text-extraction used by both the office tools and the library indexer.

export async function extractPdfText(filePath: string): Promise<string> {
  // Use the legacy build so pdfjs runs under Node (fake worker, no DOM).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await fs.readFile(filePath))
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((it: unknown) => (it && typeof it === 'object' && 'str' in it ? (it as { str: string }).str : ''))
      .join(' ')
    pages.push(`--- Page ${i} ---\n${text}`)
  }
  return pages.join('\n\n')
}

export async function extractDocxText(filePath: string): Promise<string> {
  const { value } = await mammoth.extractRawText({ path: filePath })
  return value
}

export async function extractXlsxText(filePath: string): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const out: string[] = []
  wb.eachSheet((ws) => {
    out.push(`# Sheet: ${ws.name}`)
    ws.eachRow((row) => {
      const vals = (row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)))
      out.push(vals.join('\t'))
    })
    out.push('')
  })
  return out.join('\n')
}

export const INDEXABLE_EXTENSIONS = ['.eml', '.pdf', '.docx', '.xlsx', '.txt', '.md', '.csv']

export interface Extracted {
  text: string
  kind: DocKind
}

/** Extract plain text from a supported file. Throws on unreadable files. */
export async function extractText(filePath: string): Promise<Extracted> {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.pdf':
      return { text: await extractPdfText(filePath), kind: 'doc' }
    case '.docx':
      return { text: await extractDocxText(filePath), kind: 'doc' }
    case '.xlsx':
      return { text: await extractXlsxText(filePath), kind: 'doc' }
    default:
      return { text: await fs.readFile(filePath, 'utf8'), kind: 'doc' }
  }
}
