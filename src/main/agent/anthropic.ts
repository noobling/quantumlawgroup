import Anthropic from '@anthropic-ai/sdk'
import { getApiKey } from '../secureKey'
import type { TestConnectionResult } from '@shared/types'
import { getSettings } from '../storage/store'

export async function getClient(): Promise<Anthropic | null> {
  const key = await getApiKey()
  if (!key) return null
  return new Anthropic({ apiKey: key })
}

export async function testConnection(): Promise<TestConnectionResult> {
  const client = await getClient()
  if (!client) return { ok: false, error: 'No API key set.' }
  const { model } = await getSettings()
  try {
    await client.messages.create({
      model,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }]
    })
    return { ok: true, model }
  } catch (e) {
    const err = e as { status?: number; message?: string }
    return { ok: false, error: err.message || 'Request failed', model }
  }
}
