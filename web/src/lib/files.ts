// File System Access API helpers. Chromium-only (Chrome/Edge); we feature-detect.

export function supportsDirectoryPicker(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

/** Show the OS folder picker. Returns null if unsupported or the user cancelled. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const fn = (window as unknown as {
    showDirectoryPicker?: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle>
  }).showDirectoryPicker
  if (!fn) return null
  try {
    return await fn({ mode: 'read' })
  } catch {
    return null // user dismissed the picker
  }
}

export interface WalkedFile {
  handle: FileSystemFileHandle
  path: string
}

/** Recursively yield every file under a directory handle, with its relative path. */
export async function* walkFiles(dir: FileSystemDirectoryHandle, base = ''): AsyncGenerator<WalkedFile> {
  // `values()` exists on directory handles but isn't in older lib typings.
  const entries = (dir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()
  for await (const entry of entries) {
    const path = base ? `${base}/${entry.name}` : entry.name
    if (entry.kind === 'file') yield { handle: entry as FileSystemFileHandle, path }
    else if (entry.kind === 'directory') yield* walkFiles(entry as FileSystemDirectoryHandle, path)
  }
}
