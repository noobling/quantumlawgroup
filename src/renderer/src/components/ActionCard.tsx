import type { Workflow } from '@shared/types'
import { useStore } from '../state/store'
import Icon from './Icon'
import { ArrowRight } from 'lucide-react'

export default function ActionCard({ workflow, accent }: { workflow: Workflow; accent: string }): JSX.Element {
  const openIntake = useStore((s) => s.openIntake)
  return (
    <button
      onClick={() => openIntake(workflow.id)}
      className="group text-left rounded-xl border border-ink-700/70 bg-ink-900/70 hover:bg-ink-800 hover:border-ink-600 transition p-4 flex flex-col gap-3 min-h-[140px]"
    >
      <div
        className="w-10 h-10 rounded-lg grid place-items-center shrink-0"
        style={{ backgroundColor: `${accent}22`, color: accent }}
      >
        <Icon name={workflow.icon} className="w-5 h-5" />
      </div>
      <div className="flex-1">
        <div className="font-medium text-[15px] text-slate-100">{workflow.cta}</div>
        <div className="text-[12.5px] text-ink-600 mt-1 leading-snug line-clamp-3">{workflow.description}</div>
      </div>
      <div
        className="text-[12px] flex items-center gap-1 opacity-0 group-hover:opacity-100 transition"
        style={{ color: accent }}
      >
        Start <ArrowRight className="w-3.5 h-3.5" />
      </div>
    </button>
  )
}
