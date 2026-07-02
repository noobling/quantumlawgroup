// Client-side downloads — CSV (hand-built) and XLSX (SheetJS). No server.

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function exportCsv(rows: Array<Record<string, unknown>>, filename: string): void {
  if (!rows.length) return
  const cols = Object.keys(rows[0])
  const esc = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
  downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), filename)
}

/** XLSX file bytes (for zipping) without triggering a download. */
export async function xlsxBytes(rows: Array<Record<string, unknown>>, sheet = 'Sheet1'): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheet)
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

export async function exportXlsx(rows: Array<Record<string, unknown>>, filename: string, sheet = 'Sheet1'): Promise<void> {
  const buf = await xlsxBytes(rows, sheet)
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename
  )
}
