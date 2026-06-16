import { useStore } from '../state/store'
import { inputCost, formatUsd, modelShortName } from '@shared/pricing'
import { Coins } from 'lucide-react'

/** Fixed overhead for the system prompt + tool definitions sent every turn. */
export const SYSTEM_OVERHEAD = 900

/**
 * Presentational token/cost readout for a given input-token estimate. Cloud
 * shows a dollar figure; local (Ollama) is free. Callers compute the token
 * count for their context (chat history, attached docs, etc.).
 */
export default function CostLine({ tokens }: { tokens: number }): JSX.Element | null {
  const settings = useStore((s) => s.settings)
  if (!settings) return null
  const pretty = tokens.toLocaleString()

  return (
    <div
      className="flex items-center gap-1.5 px-1 pt-1.5 text-[11px] text-ink-600"
      title="Approximate — ~4 chars/token; verify against current provider pricing."
    >
      <Coins className="w-3 h-3 opacity-70" />
      {settings.provider === 'ollama' ? (
        <span>
          ≈ {pretty} tokens · <span className="text-emerald-400/90">local · free</span>
        </span>
      ) : (
        <span>
          ≈ {pretty} input tokens · ≈ <span className="text-slate-300">{formatUsd(inputCost(tokens, settings.model))}</span>{' '}
          <span className="text-ink-600">{modelShortName(settings.model)} · output billed separately</span>
        </span>
      )}
    </div>
  )
}
