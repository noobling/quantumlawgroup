import type { ToolDef } from './types'
import { listDir, readFile, searchFiles, writeFile } from './filesystem'
import { readPdf, readDocx, readXlsx, writeDocx, writeXlsx } from './office'
import { fetchUrl } from './web'
import { runCommand } from './shell'
import { searchLibraryTool } from './library'

// All locally-executed tools, by name.
export const LOCAL_TOOLS: Record<string, ToolDef> = {
  list_dir: listDir,
  read_file: readFile,
  search_files: searchFiles,
  write_file: writeFile,
  read_pdf: readPdf,
  read_docx: readDocx,
  read_xlsx: readXlsx,
  write_docx: writeDocx,
  write_xlsx: writeXlsx,
  fetch_url: fetchUrl,
  run_command: runCommand,
  search_library: searchLibraryTool
}

// 'web_search' is a server-side Anthropic tool (executed by the API, not locally).
const SERVER_TOOLS = new Set(['web_search'])

export interface BuiltTools {
  anthropicTools: Record<string, unknown>[]
  local: Record<string, ToolDef>
}

/**
 * Given a workflow's allowed tool names, produce the tool definitions to send
 * to the Anthropic API plus the local dispatch map. We always include the core
 * read tools (so the agent can navigate the workspace) and search_library (so it
 * can pull relevant documents from the user's indexed Library in any workflow).
 */
export function buildTools(allowed: string[]): BuiltTools {
  const names = new Set<string>([...allowed, 'list_dir', 'read_file', 'search_files', 'search_library'])
  const anthropicTools: Record<string, unknown>[] = []
  const local: Record<string, ToolDef> = {}

  for (const name of names) {
    if (SERVER_TOOLS.has(name)) {
      if (name === 'web_search') {
        anthropicTools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 6 })
      }
      continue
    }
    const def = LOCAL_TOOLS[name]
    if (!def) continue
    local[name] = def
    anthropicTools.push({
      name: def.name,
      description: def.description,
      input_schema: def.inputSchema
    })
  }

  return { anthropicTools, local }
}
