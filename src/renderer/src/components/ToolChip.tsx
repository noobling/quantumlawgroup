import { useState } from 'react'
import type { ToolActivity } from '@shared/types'
import {
  FileSearch,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  Check,
  X,
  Terminal,
  Save,
  ChevronDown
} from 'lucide-react'

const TOOL_META: Record<string, { label: string; icon: React.ReactNode }> = {
  list_dir: { label: 'Browsed folder', icon: <FolderOpen className="w-3.5 h-3.5" /> },
  read_file: { label: 'Read file', icon: <FileText className="w-3.5 h-3.5" /> },
  search_files: { label: 'Searched files', icon: <FileSearch className="w-3.5 h-3.5" /> },
  read_pdf: { label: 'Read PDF', icon: <FileText className="w-3.5 h-3.5" /> },
  read_docx: { label: 'Read Word doc', icon: <FileText className="w-3.5 h-3.5" /> },
  read_xlsx: { label: 'Read Excel', icon: <FileText className="w-3.5 h-3.5" /> },
  write_file: { label: 'Wrote file', icon: <Save className="w-3.5 h-3.5" /> },
  write_docx: { label: 'Created Word doc', icon: <Save className="w-3.5 h-3.5" /> },
  write_xlsx: { label: 'Created Excel', icon: <Save className="w-3.5 h-3.5" /> },
  fetch_url: { label: 'Fetched page', icon: <Globe className="w-3.5 h-3.5" /> },
  run_command: { label: 'Ran command', icon: <Terminal className="w-3.5 h-3.5" /> }
}

export default function ToolChip({ activity }: { activity: ToolActivity }): JSX.Element {
  const [open, setOpen] = useState(false)
  const meta = TOOL_META[activity.name] ?? { label: activity.name, icon: <Terminal className="w-3.5 h-3.5" /> }
  const running = activity.endedAt == null
  const inputStr = JSON.stringify(activity.input, null, 2)

  return (
    <div className="rounded-lg border border-ink-700/60 bg-ink-900/60 text-[12.5px]">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-2.5 py-2 text-left">
        <span className="text-accent/80">{meta.icon}</span>
        <span className="text-slate-300 flex-1 truncate">
          {meta.label}
          {activity.summary && <span className="text-ink-600"> · {activity.summary}</span>}
        </span>
        {running ? (
          <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
        ) : activity.ok ? (
          <Check className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <X className="w-3.5 h-3.5 text-red-400" />
        )}
        <ChevronDown className={`w-3.5 h-3.5 text-ink-600 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <pre className="px-3 pb-2.5 text-[11px] text-ink-600 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
          {inputStr}
        </pre>
      )}
    </div>
  )
}
