import { search as lexicalSearch } from './lexical'
import type { LexicalIndex } from './lexical'
import type { IndexedDoc, SearchHit } from './types'

export function searchDocs(lexical: LexicalIndex, docs: IndexedDoc[], query: string): SearchHit[] {
  const byId = new Map(docs.map((d) => [d.id, d]))
  return lexicalSearch(lexical, query, 100)
    .map((h) => {
      const doc = byId.get(h.docId)
      return doc ? { doc, score: h.score, snippet: h.snippet } : null
    })
    .filter((h): h is SearchHit => h !== null)
}
