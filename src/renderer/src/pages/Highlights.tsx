import { useMemo } from 'react'
import { useStore } from '../state/store'
import type { IndexedDoc, DocHighlight } from '@shared/types'
import { ArrowLeft, Highlighter, ExternalLink, Loader2, FileSpreadsheet, Download } from 'lucide-react'

// CSS colours for the common Word highlight names; "#RRGGBB" fills pass through.
const SWATCH: Record<string, string> = {
  yellow: '#facc15',
  green: '#4ade80',
  cyan: '#22d3ee',
  magenta: '#e879f9',
  blue: '#60a5fa',
  red: '#f87171',
  darkGreen: '#16a34a',
  orange: '#fb923c',
  gray: '#9ca3af'
}
function swatch(color: string): string {
  return color.startsWith('#') ? color : SWATCH[color] ?? '#facc15'
}

interface Row {
  doc: IndexedDoc
  h: DocHighlight
}

/**
 * A dedicated table of every reviewer highlight in the collection — document,
 * page, colour, highlighted text, and surrounding context — separate from the
 * index. Exportable to CSV or Excel.
 */
export default function Highlights(): JSX.Element {
  const { collectionDetail: c, setRoute, exportHighlights } = useStore()

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const d of c?.docs ?? []) for (const h of d.highlights ?? []) out.push({ doc: d, h })
    return out
  }, [c])

  const docCount = useMemo(() => new Set(rows.map((r) => r.doc.id)).size, [rows])

  if (!c) {
    return (
      <div className="flex-1 grid place-items-center text-ink-600">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <header className="h-14 shrink-0 border-b border-ink-700/60 bg-ink-900/60 flex items-center gap-3 px-5">
        <button onClick={() => setRoute('collection')} className="text-ink-600 hover:text-slate-200" title="Back to index">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <Highlighter className="w-4 h-4 text-accent" />
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-slate-100 truncate">Highlights — {c.name}</div>
          <div className="text-[11px] text-ink-600">
            {rows.length} highlight{rows.length === 1 ? '' : 's'} across {docCount} document{docCount === 1 ? '' : 's'}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void exportHighlights('csv')}
            disabled={rows.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12.5px] border border-ink-700 text-slate-300 hover:bg-ink-800 disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> CSV
          </button>
          <button
            onClick={() => void exportHighlights('xlsx')}
            disabled={rows.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12.5px] border border-ink-700 text-slate-300 hover:bg-ink-800 disabled:opacity-40"
          >
            <FileSpreadsheet className="w-4 h-4" /> Excel
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {rows.length === 0 ? (
          <div className="h-full grid place-items-center text-ink-600">
            <div className="flex flex-col items-center gap-2">
              <Highlighter className="w-7 h-7 opacity-40" />
              <span className="text-sm">No highlighted text in this collection.</span>
            </div>
          </div>
        ) : (
          <table className="w-full text-[12.5px] border-collapse">
            <thead className="sticky top-0 bg-ink-900 z-10">
              <tr className="text-left text-ink-600 border-b border-ink-700">
                <th className="px-3 py-2 font-medium">Document</th>
                <th className="px-3 py-2 font-medium w-16">Page</th>
                <th className="px-3 py-2 font-medium w-28">Colour</th>
                <th className="px-3 py-2 font-medium">Highlight</th>
                <th className="px-3 py-2 font-medium">Context</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ doc, h }, i) => {
                const firstOfDoc = i === 0 || rows[i - 1].doc.id !== doc.id
                return (
                  <tr key={i} className="border-b border-ink-800/60 hover:bg-ink-800/40 align-top">
                    <td className="px-3 py-2 text-slate-300">
                      {firstOfDoc ? <span className="line-clamp-2 max-w-[16rem]">{doc.name}</span> : <span className="text-ink-700">↳</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-400 tabular-nums">{h.page ?? ''}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-slate-400">
                        <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: swatch(h.color) }} />
                        {h.color}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-200">
                      <div className="max-w-[20rem]">{h.text}</div>
                    </td>
                    <td className="px-3 py-2 text-ink-600">
                      <div className="line-clamp-2 max-w-[22rem] italic">{h.context}</div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => void window.api.files.reveal(doc.path)}
                        title="Reveal in Finder"
                        className="text-ink-600 hover:text-accent"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
