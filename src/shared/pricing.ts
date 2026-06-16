import type { ModelId } from './types'

/**
 * Token + cost estimation for the prompt the user is about to send.
 *
 * Estimates are intentionally rough and labelled with "≈" in the UI: tokens use
 * the ~4-chars-per-token heuristic for English prose rather than the real
 * tokenizer, and prices are list rates that should be confirmed against the
 * provider's current pricing. Local (Ollama) runs are free.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  inPerM: number
  /** USD per million output tokens. */
  outPerM: number
}

/** List prices (USD / million tokens). Update if Anthropic pricing changes. */
export const PRICING: Record<ModelId, ModelPrice> = {
  'claude-opus-4-8': { inPerM: 15, outPerM: 75 },
  'claude-sonnet-4-6': { inPerM: 3, outPerM: 15 },
  'claude-haiku-4-5-20251001': { inPerM: 1, outPerM: 5 }
}

/** Short display name for a model id (e.g. "Opus 4.8"). */
export function modelShortName(model: ModelId): string {
  if (model.includes('opus')) return 'Opus 4.8'
  if (model.includes('sonnet')) return 'Sonnet 4.6'
  if (model.includes('haiku')) return 'Haiku 4.5'
  return model
}

/** Rough token estimate (~4 chars/token for English). */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

/** Sum estimated tokens across many strings (e.g. the conversation so far). */
export function estimateTokensOf(texts: string[]): number {
  return texts.reduce((n, t) => n + estimateTokens(t), 0)
}

export function inputCost(tokens: number, model: ModelId): number {
  const p = PRICING[model]
  return p ? (tokens / 1_000_000) * p.inPerM : 0
}

export function outputCost(tokens: number, model: ModelId): number {
  const p = PRICING[model]
  return p ? (tokens / 1_000_000) * p.outPerM : 0
}

/** Format a USD amount with extra precision for sub-cent estimates. */
export function formatUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}
