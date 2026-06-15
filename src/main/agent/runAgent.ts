import path from 'path'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import type Anthropic from '@anthropic-ai/sdk'
import type { AgentEvent, StartThreadInput, SendMessageInput } from '@shared/types'
import { workflowById } from '@shared/workflows'
import { getClient } from './anthropic'
import { buildSystemPrompt } from './systemPrompts'
import { buildTools } from '../tools/registry'
import type { ToolContext } from '../tools/types'
import { requestPermission, denyAllPending } from '../permissions'
import {
  appendActivity,
  appendMessage,
  createMatter,
  finishActivity,
  getApiMessages,
  getMatter,
  getSettings,
  matterFilesDir,
  setApiMessages,
  updateMessageText
} from '../storage/store'

type Emit = (e: AgentEvent) => void

const MAX_ITERATIONS = 16

interface ActiveRun {
  stream?: { abort: () => void }
  cancelled: boolean
}
const active = new Map<string, ActiveRun>()

let idCounter = 0
function uid(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now()}_${idCounter}`
}

function summarizeIntake(intakeFields: { key: string; label: string }[], intake: Record<string, unknown>, copied: string[]): string {
  const lines: string[] = []
  for (const f of intakeFields) {
    if (f.key === 'files') continue
    const v = intake[f.key]
    if (v != null && String(v).trim()) lines.push(`- ${f.label}: ${String(v)}`)
  }
  if (copied.length) {
    lines.push(`- Attached documents (in the matter workspace): ${copied.map((p) => path.basename(p)).join(', ')}`)
  }
  return lines.join('\n') || '(no additional details provided)'
}

/** Copy attached files into the matter workspace; returns the new paths. */
async function importFiles(matterId: string, files: string[]): Promise<string[]> {
  const dir = matterFilesDir(matterId)
  await fs.mkdir(dir, { recursive: true })
  const out: string[] = []
  for (const src of files) {
    if (!existsSync(src)) continue
    const dest = path.join(dir, path.basename(src))
    try {
      await fs.copyFile(src, dest)
      out.push(dest)
    } catch {
      out.push(src)
    }
  }
  return out
}

export async function startThread(input: StartThreadInput, emit: Emit): Promise<{ matterId: string }> {
  const workflow = workflowById(input.workflowId)
  if (!workflow) throw new Error(`Unknown workflow: ${input.workflowId}`)

  const matterId = uid('matter')
  const counterparty =
    (input.intake.counterparty as string) ||
    (input.intake.recipient as string) ||
    (input.intake.deponent as string) ||
    ''
  const title = `${workflow.title}${counterparty ? ` — ${counterparty}` : ''}`

  await createMatter({
    id: matterId,
    title,
    workflowId: workflow.id,
    area: workflow.area,
    outputType: workflow.outputType,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const copied = await importFiles(matterId, input.files)
  const intakeSummary = summarizeIntake(workflow.intakeFields, input.intake, copied)
  const userText = `Please complete this task.\n\n${intakeSummary}`

  await appendMessage(matterId, { id: uid('msg'), role: 'user', text: userText, createdAt: Date.now() })
  await setApiMessages(matterId, [{ role: 'user', content: userText }])

  // Run asynchronously; events stream back over IPC.
  void runTurn(matterId, emit)
  return { matterId }
}

export async function sendMessage(input: SendMessageInput, emit: Emit): Promise<void> {
  const api = (await getApiMessages(input.matterId)) as Anthropic.MessageParam[]
  api.push({ role: 'user', content: input.text })
  await setApiMessages(input.matterId, api)
  await appendMessage(input.matterId, { id: uid('msg'), role: 'user', text: input.text, createdAt: Date.now() })
  void runTurn(input.matterId, emit)
}

export function cancel(matterId: string): void {
  const run = active.get(matterId)
  if (run) {
    run.cancelled = true
    run.stream?.abort()
  }
  denyAllPending()
}

async function runTurn(matterId: string, emit: Emit): Promise<void> {
  const run: ActiveRun = { cancelled: false }
  active.set(matterId, run)

  try {
    const client = await getClient()
    if (!client) {
      emit({ type: 'error', matterId, message: 'No Anthropic API key set. Add one in Settings.' })
      emit({ type: 'done', matterId })
      return
    }
    const settings = await getSettings()

    // Determine workflow from the matter meta (re-read by loading any message context).
    const detail = await getMatter(matterId)
    const workflow = detail ? workflowById(detail.workflowId) : undefined
    if (!workflow) {
      emit({ type: 'error', matterId, message: 'Workflow not found for this matter.' })
      emit({ type: 'done', matterId })
      return
    }

    const { anthropicTools, local } = buildTools(workflow.tools)
    const system = buildSystemPrompt(workflow, settings, '(see the conversation)')

    const ctx: ToolContext = {
      matterId,
      filesDir: matterFilesDir(matterId),
      matterRoot: settings.matterRoot,
      requestPermission: (title, detailText) =>
        requestPermission({
          matterId,
          tool: title,
          title,
          detail: detailText,
          emit
        })
    }

    const apiMessages = (await getApiMessages(matterId)) as Anthropic.MessageParam[]
    const messageId = uid('msg')
    emit({ type: 'turn-start', matterId, messageId })
    await appendMessage(matterId, { id: messageId, role: 'assistant', text: '', createdAt: Date.now() })

    let assembled = ''

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (run.cancelled) break

      const stream = client.messages.stream({
        model: settings.model,
        max_tokens: 8000,
        system,
        tools: anthropicTools as unknown as Anthropic.Tool[],
        messages: apiMessages
      })
      run.stream = stream

      stream.on('text', (delta: string) => {
        assembled += delta
        emit({ type: 'text', matterId, messageId, delta })
      })

      let finalMessage: Anthropic.Message
      try {
        finalMessage = await stream.finalMessage()
      } catch (e) {
        if (run.cancelled) break
        emit({ type: 'error', matterId, message: (e as Error).message })
        break
      }

      apiMessages.push({ role: 'assistant', content: finalMessage.content })
      await setApiMessages(matterId, apiMessages)
      await updateMessageText(matterId, messageId, assembled)

      const toolUses = finalMessage.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      )
      if (finalMessage.stop_reason !== 'tool_use' || toolUses.length === 0) {
        break
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const tu of toolUses) {
        if (run.cancelled) break
        const def = local[tu.name]
        const activityId = uid('act')
        emit({ type: 'tool-start', matterId, messageId, toolId: tu.id, name: tu.name, input: tu.input })
        await appendActivity(matterId, {
          id: activityId,
          name: tu.name,
          input: tu.input,
          startedAt: Date.now()
        })

        if (!def) {
          await finishActivity(matterId, activityId, false, 'Unknown tool')
          emit({ type: 'tool-end', matterId, toolId: tu.id, ok: false, summary: 'Unknown tool' })
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Unknown tool', is_error: true })
          continue
        }

        try {
          const result = await def.run(tu.input as Record<string, unknown>, ctx)
          await finishActivity(matterId, activityId, !result.isError, result.summary)
          emit({ type: 'tool-end', matterId, toolId: tu.id, ok: !result.isError, summary: result.summary })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: result.content,
            is_error: result.isError
          })
        } catch (e) {
          const msg = (e as Error).message
          await finishActivity(matterId, activityId, false, msg)
          emit({ type: 'tool-end', matterId, toolId: tu.id, ok: false, summary: msg })
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${msg}`, is_error: true })
        }
      }

      if (run.cancelled) break
      apiMessages.push({ role: 'user', content: toolResults })
      await setApiMessages(matterId, apiMessages)
    }

    await updateMessageText(matterId, messageId, assembled)
    emit({ type: 'turn-end', matterId, messageId })
  } catch (e) {
    emit({ type: 'error', matterId, message: (e as Error).message })
  } finally {
    active.delete(matterId)
    emit({ type: 'done', matterId })
  }
}
