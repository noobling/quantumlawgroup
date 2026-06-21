// Performance benchmark: isolate the ADDED cost of each tier over what the app
// already pays today (parsing each .eml with mailparser in the logo prescan).
//
//   baseline  = read + simpleParser every email          (already paid today)
//   +Tier 1   = sha256(content) per image attachment      (added cost of T1)
//   +Tier 2   = jimp decode + dHash per image             (added cost of T2)
//   +cluster  = greedy Hamming clustering over all dHashes
//
// Single-threaded timings so the per-item cost is honest; the real prescan runs
// a worker pool (~CPU count), so wall-clock is divided by that. Caching means
// these costs are paid ONCE per new/changed email, not every run.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { simpleParser } from 'mailparser'
import { Jimp } from 'jimp'

const ROOT = process.argv[2] || '/Users/davidyu/Downloads/sample-emails'

async function walk(dir) {
  const out = []
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.eml')) out.push(p)
  }
  return out
}
const ms = (n) => `${n.toFixed(0)} ms`
const hamming = (a, b) => {
  let x = a ^ b,
    n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

const files = await walk(ROOT)
console.log(`Benchmark over ${files.length} emails (single-threaded)\n`)

// --- baseline: read + parse (what the app already does) --------------------
let tRead = 0,
  tParse = 0
const parsed = [] // { buffers: Buffer[] }  (image attachment buffers per email)
for (const f of files) {
  let t = performance.now()
  const raw = await fs.readFile(f)
  tRead += performance.now() - t
  t = performance.now()
  let mail
  try {
    mail = await simpleParser(raw)
  } catch {
    continue
  }
  tParse += performance.now() - t
  const bufs = (mail.attachments || [])
    .filter((a) => (a.contentType || '').startsWith('image/'))
    .map((a) => a.content)
    .filter((b) => b && b.length)
  parsed.push({ bufs })
}
const totalImgs = parsed.reduce((n, p) => n + p.bufs.length, 0)
const totalBytes = parsed.reduce((n, p) => n + p.bufs.reduce((s, b) => s + b.length, 0), 0)

// --- Tier 1: sha256 --------------------------------------------------------
let tSha = 0
for (const p of parsed)
  for (const b of p.bufs) {
    const t = performance.now()
    crypto.createHash('sha256').update(b).digest('hex')
    tSha += performance.now() - t
  }

// --- Tier 2: decode + dHash ------------------------------------------------
let tDecode = 0,
  decoded = 0,
  failed = 0
const hashes = []
for (const p of parsed)
  for (const b of p.bufs) {
    const t = performance.now()
    try {
      const img = await Jimp.read(b)
      img.resize({ w: 9, h: 8 }).greyscale()
      const { data, width } = img.bitmap
      let bits = 0n
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const l = data[(y * width + x) * 4]
          const r = data[(y * width + x + 1) * 4]
          bits = (bits << 1n) | (l < r ? 1n : 0n)
        }
      hashes.push(bits)
      decoded++
    } catch {
      failed++
    }
    tDecode += performance.now() - t
  }

// --- clustering: greedy O(n*clusters) --------------------------------------
let tCluster = performance.now()
const reps = []
for (const h of hashes) {
  let hit = false
  for (const r of reps)
    if (hamming(h, r) <= 8) {
      hit = true
      break
    }
  if (!hit) reps.push(h)
}
tCluster = performance.now() - tCluster

// --- report ----------------------------------------------------------------
const mb = (totalBytes / 1024 / 1024).toFixed(1)
console.log(`Images: ${totalImgs}  (${mb} MB)   decoded ${decoded}, failed ${failed}\n`)
console.log('Cost breakdown (single-threaded, whole set):')
console.log(`  baseline read .eml:        ${ms(tRead).padStart(9)}`)
console.log(`  baseline simpleParser:     ${ms(tParse).padStart(9)}   <- already paid today`)
console.log(`  ${'-'.repeat(40)}`)
console.log(`  + Tier 1 sha256:           ${ms(tSha).padStart(9)}   (${(tSha / totalImgs).toFixed(3)} ms/img)`)
console.log(`  + Tier 2 decode+dHash:     ${ms(tDecode).padStart(9)}   (${(tDecode / totalImgs).toFixed(2)} ms/img)`)
console.log(`  + Tier 2 clustering:       ${ms(tCluster).padStart(9)}   (${reps.length} clusters)`)
console.log()
const baseline = tRead + tParse
console.log('Relative to baseline (read+parse):')
console.log(`  baseline:                  ${ms(baseline)}`)
console.log(`  Tier 1 adds:               +${((tSha / baseline) * 100).toFixed(1)}%`)
console.log(`  Tier 2 adds:               +${(((tDecode + tCluster) / baseline) * 100).toFixed(1)}%`)
