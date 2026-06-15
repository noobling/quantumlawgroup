import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { existsSync, readFileSync } from 'fs'
import path from 'path'

// The user's own Anthropic API key is encrypted at rest with the OS keystore
// (Windows DPAPI via Electron safeStorage) and never exposed to the renderer.
//
// A *bundled* key may also ship with the app (see getBundledKey) so the app works
// out of the box. A user-set key always takes precedence over the bundled one.

const keyFile = () => path.join(app.getPath('userData'), 'anthropic.key')

/**
 * A fallback key shipped inside the package, so the distributed app works without
 * the user pasting their own key. NOTE: a bundled key is recoverable from the
 * package by anyone who has it — protect it with a spend limit / rotation.
 */
function getBundledKey(): string | null {
  const candidates: string[] = []
  // Packaged app: resources/bundled.key sits next to app.asar.
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bundled.key'))
  // Dev / asar-included: project root (app path).
  try {
    candidates.push(path.join(app.getAppPath(), 'bundled.key'))
  } catch {
    /* app path may be unavailable very early */
  }
  for (const f of candidates) {
    try {
      if (existsSync(f)) {
        const v = readFileSync(f, 'utf8').trim()
        if (v) return v
      }
    } catch {
      /* ignore */
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim()
  return null
}

export async function setApiKey(plain: string): Promise<void> {
  const trimmed = plain.trim()
  if (!trimmed) {
    await clearApiKey()
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(trimmed)
    await fs.writeFile(keyFile(), enc)
  } else {
    // Fallback: store plaintext (still local-only). Rare on Windows.
    await fs.writeFile(keyFile(), Buffer.from(trimmed, 'utf8'))
  }
}

async function getUserKey(): Promise<string | null> {
  const file = keyFile()
  if (!existsSync(file)) return null
  try {
    const buf = await fs.readFile(file)
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(buf)
      } catch {
        // Was written as plaintext fallback.
        return buf.toString('utf8')
      }
    }
    return buf.toString('utf8')
  } catch {
    return null
  }
}

export async function getApiKey(): Promise<string | null> {
  // A user-set key always wins; otherwise fall back to the bundled key.
  return (await getUserKey()) ?? getBundledKey()
}

export async function clearApiKey(): Promise<void> {
  const file = keyFile()
  if (existsSync(file)) await fs.unlink(file)
}

export async function hasApiKey(): Promise<boolean> {
  return (await getApiKey()) !== null
}
