// Pure-JS inverted index with BM25 ranking. Serializes to plain JSON (no deps).
// Ported verbatim from the desktop app — runs unchanged in the browser/worker.

export interface LexicalIndex {
  /** term -> list of [docId, termFrequency] */
  postings: Record<string, Array<[string, number]>>
  /** docId -> token count */
  docLen: Record<string, number>
  /** docId -> capped source text, for building match snippets */
  snippets: Record<string, string>
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were',
  'be', 'this', 'that', 'it', 'as', 'at', 'by', 'with', 'from', 'we', 'you', 'i', 'he', 'she'
])

const SNIPPET_CAP = 2000

export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2 && raw.length <= 40 && !STOPWORDS.has(raw)) out.push(raw)
  }
  return out
}

export function createIndex(): LexicalIndex {
  return { postings: {}, docLen: {}, snippets: {} }
}

export function addDoc(idx: LexicalIndex, docId: string, text: string): void {
  const tokens = tokenize(text)
  idx.docLen[docId] = tokens.length
  idx.snippets[docId] = text.slice(0, SNIPPET_CAP)
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  for (const [term, count] of tf) {
    if (!idx.postings[term]) idx.postings[term] = []
    idx.postings[term].push([docId, count])
  }
}

function makeSnippet(text: string, queryTerms: string[]): string {
  if (!text) return ''
  const lower = text.toLowerCase()
  let pos = -1
  for (const t of queryTerms) {
    const p = lower.indexOf(t)
    if (p >= 0 && (pos < 0 || p < pos)) pos = p
  }
  const start = pos < 0 ? 0 : Math.max(0, pos - 60)
  const snip = text.slice(start, start + 220).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + snip + (text.length > start + 220 ? '…' : '')
}

export interface LexicalHit {
  docId: string
  score: number
  snippet: string
}

export function search(idx: LexicalIndex, query: string, k = 50): LexicalHit[] {
  const terms = tokenize(query)
  if (!terms.length) return []
  const docIds = Object.keys(idx.docLen)
  const N = docIds.length
  if (!N) return []
  const avgdl = docIds.reduce((s, id) => s + idx.docLen[id], 0) / N
  const k1 = 1.5
  const b = 0.75

  const scores = new Map<string, number>()
  for (const term of new Set(terms)) {
    const posting = idx.postings[term]
    if (!posting) continue
    const df = posting.length
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (const [docId, tf] of posting) {
      const dl = idx.docLen[docId] || 1
      const denom = tf + k1 * (1 - b + b * (dl / avgdl))
      const add = idf * ((tf * (k1 + 1)) / denom)
      scores.set(docId, (scores.get(docId) ?? 0) + add)
    }
  }

  return [...scores.entries()]
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, k)
    .map(([docId, score]) => ({ docId, score, snippet: makeSnippet(idx.snippets[docId] || '', terms) }))
}
