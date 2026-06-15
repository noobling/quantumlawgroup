import type { PermissionDecision } from '@shared/types'

// Brokers permission requests between the agent loop (main) and the UI (renderer).
// A gated tool call awaits a decision; the renderer resolves it via IPC.

interface Pending {
  resolve: (decision: PermissionDecision) => void
}

const pending = new Map<string, Pending>()
const alwaysAllowed = new Set<string>()

let counter = 0
function nextId(): string {
  counter += 1
  return `perm_${Date.now()}_${counter}`
}

export interface PermissionAsk {
  matterId: string
  tool: string
  title: string
  detail: string
  emit: (event: {
    type: 'permission-request'
    matterId: string
    requestId: string
    tool: string
    title: string
    detail: string
  }) => void
}

/**
 * Returns true if the tool call may proceed. Auto-approves tools the user
 * granted "always" this session; otherwise prompts and awaits the decision.
 */
export async function requestPermission(ask: PermissionAsk): Promise<boolean> {
  if (alwaysAllowed.has(ask.tool)) return true

  const requestId = nextId()
  const decision = await new Promise<PermissionDecision>((resolve) => {
    pending.set(requestId, { resolve })
    ask.emit({
      type: 'permission-request',
      matterId: ask.matterId,
      requestId,
      tool: ask.tool,
      title: ask.title,
      detail: ask.detail
    })
  })

  if (decision === 'allow-always') {
    alwaysAllowed.add(ask.tool)
    return true
  }
  return decision === 'allow'
}

export function resolvePermission(requestId: string, decision: PermissionDecision): void {
  const p = pending.get(requestId)
  if (p) {
    pending.delete(requestId)
    p.resolve(decision)
  }
}

/** Deny everything still waiting (used on cancel). */
export function denyAllPending(): void {
  for (const [, p] of pending) p.resolve('deny')
  pending.clear()
}
