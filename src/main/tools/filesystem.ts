import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import type { ToolDef } from './types'
import { resolvePath, str } from './types'

const MAX_READ = 400_000 // chars

export const listDir: ToolDef = {
  name: 'list_dir',
  description:
    'List files and folders in a directory. Relative paths resolve inside the matter workspace; absolute paths access the full computer.',
  needsPermission: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path (relative or absolute).' } },
    required: ['path']
  },
  async run(args, ctx) {
    const dir = resolvePath(ctx, str(args, 'path', '.'))
    if (!existsSync(dir)) return { summary: `No such dir: ${dir}`, content: 'Directory does not exist.', isError: true }
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const lines = entries.map((e) => `${e.isDirectory() ? '[dir] ' : '      '}${e.name}`)
    return { summary: `Listed ${entries.length} items in ${path.basename(dir)}`, content: lines.join('\n') || '(empty)' }
  }
}

export const readFile: ToolDef = {
  name: 'read_file',
  description: 'Read a UTF-8 text file (e.g. .txt, .md, .csv, source code). For PDF/Word/Excel use the dedicated tools.',
  needsPermission: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path']
  },
  async run(args, ctx) {
    const file = resolvePath(ctx, str(args, 'path'))
    if (!existsSync(file)) return { summary: `Not found: ${file}`, content: 'File does not exist.', isError: true }
    let text = await fs.readFile(file, 'utf8')
    let note = ''
    if (text.length > MAX_READ) {
      text = text.slice(0, MAX_READ)
      note = `\n\n[...truncated at ${MAX_READ} chars]`
    }
    return { summary: `Read ${path.basename(file)}`, content: text + note }
  }
}

export const searchFiles: ToolDef = {
  name: 'search_files',
  description: 'Search file names and text contents under a directory for a query string. Useful for finding a document in the workspace.',
  needsPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Directory to search (defaults to the matter workspace).' },
      query: { type: 'string' }
    },
    required: ['query']
  },
  async run(args, ctx) {
    const root = resolvePath(ctx, str(args, 'dir', '.'))
    const query = str(args, 'query').toLowerCase()
    const hits: string[] = []
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 4 || hits.length > 50) return
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue
          await walk(full, depth + 1)
        } else {
          if (e.name.toLowerCase().includes(query)) hits.push(`${full} (filename match)`)
          else if (/\.(txt|md|csv|json|log)$/i.test(e.name)) {
            try {
              const content = await fs.readFile(full, 'utf8')
              if (content.toLowerCase().includes(query)) hits.push(`${full} (content match)`)
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
    await walk(root, 0)
    return {
      summary: `Found ${hits.length} match(es) for "${query}"`,
      content: hits.length ? hits.join('\n') : 'No matches found.'
    }
  }
}

export const writeFile: ToolDef = {
  name: 'write_file',
  description: 'Write a UTF-8 text file. Relative paths save into the matter workspace. Prompts the user before writing.',
  needsPermission: true,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content']
  },
  async run(args, ctx) {
    const file = resolvePath(ctx, str(args, 'path'))
    const content = str(args, 'content')
    const ok = await ctx.requestPermission('Write file', `Save ${content.length} chars to:\n${file}`)
    if (!ok) return { summary: 'Write denied', content: 'User denied the write.', isError: true }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content, 'utf8')
    return { summary: `Wrote ${path.basename(file)}`, content: `Saved to ${file}` }
  }
}
