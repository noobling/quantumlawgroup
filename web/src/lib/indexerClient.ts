import type { IndexPayload, WorkerMessage } from './types'

export type IndexSource = { dir: FileSystemDirectoryHandle } | { files: File[] }

/** Run indexing in a Web Worker. Reports progress, resolves with the built index. */
export function indexFolder(
  collectionId: string,
  source: IndexSource,
  onProgress: (m: Extract<WorkerMessage, { type: 'progress' }>) => void
): Promise<IndexPayload> {
  const worker = new Worker(new URL('./indexer.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<IndexPayload>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data
      if (m.type === 'progress') onProgress(m)
      else if (m.type === 'done') {
        resolve({ docs: m.docs, lexical: m.lexical, highlights: m.highlights })
        worker.terminate()
      } else if (m.type === 'error') {
        reject(new Error(m.message))
        worker.terminate()
      }
    }
    worker.onerror = (e) => {
      reject(new Error(e.message || 'Indexing worker crashed'))
      worker.terminate()
    }
    worker.postMessage({ type: 'index', collectionId, ...source })
  })
}
