import type { LibrarySearchHit } from '@shared/types'
import { search } from './lexical'
import { getDocs, getLexical, listCollections } from './store'

/** BM25 search within one collection. */
export async function searchCollection(id: string, query: string, k = 50): Promise<LibrarySearchHit[]> {
  const [docs, lex] = await Promise.all([getDocs(id), getLexical(id)])
  const byId = new Map(docs.map((d) => [d.id, d]))
  const hits: LibrarySearchHit[] = []
  for (const h of search(lex, query, k)) {
    const doc = byId.get(h.docId)
    if (doc) hits.push({ doc, score: h.score, snippet: h.snippet })
  }
  return hits
}

/** Search across the whole library (optionally scoped to one collection by name or id). */
export async function searchLibrary(
  query: string,
  k = 20,
  scope?: string
): Promise<Array<LibrarySearchHit & { collection: string }>> {
  const collections = await listCollections()
  const targets = scope
    ? collections.filter((c) => c.id === scope || c.name.toLowerCase() === scope.toLowerCase())
    : collections
  const all: Array<LibrarySearchHit & { collection: string }> = []
  for (const c of targets) {
    const hits = await searchCollection(c.id, query, k)
    for (const h of hits) all.push({ ...h, collection: c.name })
  }
  return all.sort((a, b) => b.score - a.score).slice(0, k)
}
