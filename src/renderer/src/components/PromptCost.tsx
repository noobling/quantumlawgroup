import { useMemo } from 'react'
import { useStore } from '../state/store'
import { estimateTokens, estimateTokensOf } from '@shared/pricing'
import CostLine, { SYSTEM_OVERHEAD } from './CostLine'

/**
 * Live token/cost estimate for the next chat turn: system overhead + the
 * conversation so far + the text the user is typing.
 */
export default function PromptCost({ text }: { text: string }): JSX.Element | null {
  const messages = useStore((s) => s.messages)
  const tokens = useMemo(
    () => SYSTEM_OVERHEAD + estimateTokensOf(messages.map((m) => m.text)) + estimateTokens(text),
    [messages, text]
  )
  return <CostLine tokens={tokens} />
}
