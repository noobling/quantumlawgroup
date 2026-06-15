import type { ToolDef } from './types'
import { str } from './types'
import { searchLibrary } from '../library/search'

export const searchLibraryTool: ToolDef = {
  name: 'search_library',
  description:
    "Search the user's indexed document Library (collections of emails, contracts, and other documents) for relevant material by keyword. Returns the top matching documents with their file path, key metadata, and a snippet. Use this to find precedents, prior correspondence, or related documents instead of asking the user to attach them.",
  needsPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords or phrase to search for.' },
      collection: { type: 'string', description: 'Optional: limit to a collection by name or id.' },
      limit: { type: 'number', description: 'Max results (default 10).' }
    },
    required: ['query']
  },
  async run(args) {
    const query = str(args, 'query')
    const scope = args.collection ? str(args, 'collection') : undefined
    const limit = typeof args.limit === 'number' ? Math.min(args.limit, 30) : 10
    const hits = await searchLibrary(query, limit, scope)
    if (!hits.length) {
      return { summary: `No library matches for "${query}"`, content: 'No matching documents found in the Library.' }
    }
    const lines = hits.map((h, i) => {
      const d = h.doc
      const meta =
        d.kind === 'email'
          ? `${d.date || ''} | From: ${d.from || '?'} | To: ${d.to || '?'} | Subject: ${d.subject || d.name}`
          : `${d.docType || d.ext} | ${d.title || d.name}`
      return `${i + 1}. [${h.collection}] ${meta}\n   Path: ${d.path}\n   ${d.summary ? d.summary + '\n   ' : ''}…${h.snippet}…`
    })
    return { summary: `Found ${hits.length} match(es) for "${query}"`, content: lines.join('\n\n') }
  }
}
