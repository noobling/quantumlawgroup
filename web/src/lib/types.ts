import type { LexicalIndex } from './lexical'

export type DocKind = 'email' | 'doc'

export interface IndexedDoc {
  /** Stable id = relative path within the picked folder. */
  id: string
  path: string
  name: string
  ext: string
  size: number
  modifiedAt: number
  kind: DocKind
  textChars: number
  // Parsed email fields (optional).
  subject?: string
  from?: string
  to?: string
  date?: string
}

export type CollectionStatus = 'indexing' | 'ready' | 'error'

export interface Collection {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  fileCount: number
  status: CollectionStatus
  error?: string
}

export interface SearchHit {
  doc: IndexedDoc
  score: number
  snippet: string
}

/** Persisted per-collection index payload. */
export interface IndexPayload {
  docs: IndexedDoc[]
  lexical: LexicalIndex
}

// ── Worker protocol ──
// Two input modes: a directory handle (File System Access API, secure contexts) or a plain
// File[] (from an <input webkitdirectory>, works anywhere incl. plain HTTP). Files carry
// webkitRelativePath for the in-folder path.
export interface IndexRequest {
  type: 'index'
  collectionId: string
  dir?: FileSystemDirectoryHandle
  files?: File[]
}

export type WorkerMessage =
  | { type: 'progress'; collectionId: string; phase: string; done: number; total: number; currentFile?: string }
  | { type: 'done'; collectionId: string; docs: IndexedDoc[]; lexical: LexicalIndex }
  | { type: 'error'; collectionId: string; message: string }
