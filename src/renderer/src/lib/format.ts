/** Format an estimated duration (ms) as a compact "time remaining" string. */
export function formatEta(ms: number | undefined): string | null {
  if (ms == null || !isFinite(ms) || ms <= 0) return null
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${Math.max(1, secs)}s left`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  if (mins < 60) return rem ? `${mins}m ${rem}s left` : `${mins}m left`
  const hrs = Math.floor(mins / 60)
  const remMin = mins % 60
  return remMin ? `${hrs}h ${remMin}m left` : `${hrs}h left`
}
