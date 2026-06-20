import { app } from 'electron'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import type { Collection, CollectionDetail, IndexedDoc } from '@shared/types'
import { createIndex, type LexicalIndex } from './lexical'

const libraryDir = (): string => path.join(app.getPath('userData'), 'library')
const collPath = (id: string): string => path.join(libraryDir(), id)

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  await fs.writeFile(file, JSON.stringify(data), 'utf8')
}

export async function listCollections(): Promise<Collection[]> {
  const dir = libraryDir()
  if (!existsSync(dir)) return []
  const ids = await fs.readdir(dir)
  const out: Collection[] = []
  for (const id of ids) {
    const f = path.join(dir, id, 'collection.json')
    if (existsSync(f)) {
      try {
        out.push(JSON.parse(await fs.readFile(f, 'utf8')) as Collection)
      } catch {
        /* skip corrupt */
      }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getCollection(id: string): Promise<Collection | null> {
  const f = path.join(collPath(id), 'collection.json')
  if (!existsSync(f)) return null
  return JSON.parse(await fs.readFile(f, 'utf8')) as Collection
}

export async function saveCollection(c: Collection): Promise<void> {
  c.updatedAt = Date.now()
  await writeJson(path.join(collPath(c.id), 'collection.json'), c)
}

export async function deleteCollection(id: string): Promise<void> {
  const dir = collPath(id)
  if (existsSync(dir)) await fs.rm(dir, { recursive: true, force: true })
}

export async function getDocs(id: string): Promise<IndexedDoc[]> {
  return readJson<IndexedDoc[]>(path.join(collPath(id), 'docs.json'), [])
}

export async function saveDocs(id: string, docs: IndexedDoc[]): Promise<void> {
  await writeJson(path.join(collPath(id), 'docs.json'), docs)
}

export async function getLexical(id: string): Promise<LexicalIndex> {
  return readJson<LexicalIndex>(path.join(collPath(id), 'lexical.json'), createIndex())
}

/**
 * The production manifest: one record per produced document (input stat + Bates +
 * output path). Lets a re-run scan input-vs-output and skip unchanged documents
 * instead of re-rendering everything. Stored separately so it doesn't bloat
 * collection.json (which library:list reads for every collection).
 */
export async function getProductionManifest(id: string): Promise<unknown> {
  return readJson<unknown>(path.join(collPath(id), 'production.json'), null)
}

export async function saveProductionManifest(id: string, data: unknown): Promise<void> {
  await writeJson(path.join(collPath(id), 'production.json'), data)
}

export async function saveLexical(id: string, idx: LexicalIndex): Promise<void> {
  await writeJson(path.join(collPath(id), 'lexical.json'), idx)
}

export async function getCollectionDetail(id: string): Promise<CollectionDetail | null> {
  const c = await getCollection(id)
  if (!c) return null
  return { ...c, docs: await getDocs(id) }
}
