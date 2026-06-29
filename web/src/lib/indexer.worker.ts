/// <reference lib="webworker" />
// Indexing worker: walks the picked folder, extracts text from each file, and builds the
// BM25 index — all off the main thread so the UI stays responsive on large sets.
import { walkFiles } from './files'
import { extractText, extOf, INDEXABLE } from './extract'
import { createIndex, addDoc } from './lexical'
import type { IndexRequest, IndexedDoc, WorkerMessage } from './types'

const post = (m: WorkerMessage): void => (self as unknown as Worker).postMessage(m)

interface Item {
  path: string
  file?: File
  handle?: FileSystemFileHandle
}

self.onmessage = async (e: MessageEvent<IndexRequest>) => {
  const { collectionId, dir, files: fileList } = e.data
  try {
    const items: Item[] = []
    if (fileList) {
      for (const f of fileList) items.push({ path: f.webkitRelativePath || f.name, file: f })
    } else if (dir) {
      for await (const f of walkFiles(dir)) items.push({ path: f.path, handle: f.handle })
    }
    const work = items.filter((it) => INDEXABLE.has(extOf(it.path)))
    const total = work.length
    post({ type: 'progress', collectionId, phase: 'Reading documents', done: 0, total })

    const lexical = createIndex()
    const docs: IndexedDoc[] = []
    let done = 0
    for (const it of work) {
      const file = it.file ?? (await it.handle!.getFile())
      let extracted
      try {
        extracted = await extractText(file)
      } catch {
        extracted = { text: '', kind: 'doc' as const }
      }
      const doc: IndexedDoc = {
        id: it.path,
        path: it.path,
        name: file.name,
        ext: extOf(file.name),
        size: file.size,
        modifiedAt: file.lastModified,
        kind: extracted.kind,
        textChars: extracted.text.length,
        ...(extracted.meta || {})
      }
      docs.push(doc)
      // Fold filename + email headers into the searchable text so name/subject hits rank too.
      const searchText = [doc.name, doc.subject, doc.from, doc.to, extracted.text].filter(Boolean).join('\n')
      addDoc(lexical, doc.id, searchText)
      done++
      if (done % 5 === 0 || done === total) {
        post({ type: 'progress', collectionId, phase: 'Reading documents', done, total, currentFile: file.name })
      }
    }
    post({ type: 'done', collectionId, docs, lexical })
  } catch (err) {
    post({ type: 'error', collectionId, message: (err as Error)?.message || String(err) })
  }
}
