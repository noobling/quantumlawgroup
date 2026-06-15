import path from 'path'

export interface ToolContext {
  matterId: string
  filesDir: string
  /** Where user-facing exports/deliverables should default to. */
  matterRoot: string
  /** Prompt the user; resolves true if allowed. */
  requestPermission: (title: string, detail: string) => Promise<boolean>
}

export interface ToolRunResult {
  /** Short human-readable line for the activity rail. */
  summary: string
  /** Text returned to the model as the tool_result. */
  content: string
  isError?: boolean
}

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  needsPermission: boolean
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolRunResult>
}

/** Resolve a possibly-relative path against the matter's files dir. */
export function resolvePath(ctx: ToolContext, p: string): string {
  if (!p) return ctx.filesDir
  return path.isAbsolute(p) ? p : path.join(ctx.filesDir, p)
}

export function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key]
  return typeof v === 'string' ? v : fallback
}
