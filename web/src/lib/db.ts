// Minimal IndexedDB persistence — collections + their index payloads survive refreshes.
// Everything stays on-device; there is no server.
import type { Collection, IndexPayload } from './types'

const DB_NAME = 'qlg-index'
const DB_VERSION = 1
const COLLECTIONS = 'collections'
const INDEXES = 'indexes'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(COLLECTIONS)) db.createObjectStore(COLLECTIONS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(INDEXES)) db.createObjectStore(INDEXES) // keyed by collectionId
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const req = fn(tx.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        tx.oncomplete = () => db.close()
      })
  )
}

export const listCollections = (): Promise<Collection[]> =>
  run<Collection[]>(COLLECTIONS, 'readonly', (s) => s.getAll() as IDBRequest<Collection[]>).then((cs) =>
    cs.sort((a, b) => b.updatedAt - a.updatedAt)
  )

export const putCollection = (c: Collection): Promise<unknown> =>
  run(COLLECTIONS, 'readwrite', (s) => s.put(c))

export async function deleteCollection(id: string): Promise<void> {
  await run(COLLECTIONS, 'readwrite', (s) => s.delete(id))
  await run(INDEXES, 'readwrite', (s) => s.delete(id))
}

export const putIndex = (id: string, payload: IndexPayload): Promise<unknown> =>
  run(INDEXES, 'readwrite', (s) => s.put(payload, id))

export const getIndex = (id: string): Promise<IndexPayload | undefined> =>
  run<IndexPayload | undefined>(INDEXES, 'readonly', (s) => s.get(id) as IDBRequest<IndexPayload | undefined>)
