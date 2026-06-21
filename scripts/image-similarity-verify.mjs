// Verification pass for the perceptual (Tier 2) matcher: the danger is that
// Hamming<=8 on a 9x8 dHash merges DISTINCT images (small icons especially) and
// would sweep real evidence into a "recurring logo" cluster. This:
//   1. exports a representative image from each top recurring cluster (eyeball),
//   2. flags risky clusters: large dimensions (would be "content" today) or wild
//      size/aspect variance among members (a likely bad merge),
//   3. exports up to 6 members of the riskiest clusters side by side.
//
// Usage: node scripts/image-similarity-verify.mjs "/path/to/eml/folder" [hamming]

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { simpleParser } from 'mailparser'
import { Jimp } from 'jimp'

const ROOT = process.argv[2] || '/Users/davidyu/Downloads/sample-emails'
const HAMMING = Number(process.argv[3] || 8)
const MIN_RECURRENCE = 3
const OUT = '/tmp/img-spike-out'

async function walk(dir) {
  const out = []
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.eml')) out.push(p)
  }
  return out
}

async function decode(buf) {
  try {
    const img = await Jimp.read(buf)
    return img
  } catch {
    return null
  }
}
function dHashOf(img) {
  const c = img.clone().resize({ w: 9, h: 8 }).greyscale()
  const { data, width } = c.bitmap
  let bits = 0n
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const l = data[(y * width + x) * 4]
      const r = data[(y * width + x + 1) * 4]
      bits = (bits << 1n) | (l < r ? 1n : 0n)
    }
  return bits
}
const hamming = (a, b) => {
  let x = a ^ b,
    n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

await fs.rm(OUT, { recursive: true, force: true })
await fs.mkdir(OUT, { recursive: true })

const files = await walk(ROOT)
console.log(`Parsing ${files.length} emails (Hamming<=${HAMMING})…`)

const imgs = [] // { emailIdx, name, w, h, size, dhash, buf }
let next = 0
const worker = async () => {
  for (;;) {
    const idx = next++
    if (idx >= files.length) return
    try {
      const mail = await simpleParser(await fs.readFile(files[idx]))
      for (const a of (mail.attachments || []).filter((x) => (x.contentType || '').startsWith('image/'))) {
        const buf = a.content
        if (!buf?.length) continue
        const img = await decode(buf)
        if (!img) continue
        imgs.push({
          emailIdx: idx,
          name: (a.filename || '').trim().toLowerCase(),
          w: img.bitmap.width,
          h: img.bitmap.height,
          size: buf.length,
          dhash: dHashOf(img),
          buf
        })
      }
    } catch {
      /* skip */
    }
  }
}
await Promise.all(Array.from({ length: Math.max(2, (os.cpus().length || 4)) }, () => worker()))

// greedy cluster
const reps = []
for (const im of imgs) {
  let id = null
  for (const r of reps)
    if (hamming(im.dhash, r.dhash) <= HAMMING) {
      id = r.id
      break
    }
  if (id == null) {
    id = reps.length
    reps.push({ dhash: im.dhash, id })
  }
  im.cluster = id
}
const byCluster = new Map()
for (const im of imgs) {
  if (!byCluster.has(im.cluster)) byCluster.set(im.cluster, [])
  byCluster.get(im.cluster).push(im)
}
const emailsOf = (members) => new Set(members.map((m) => m.emailIdx)).size
const recurring = [...byCluster.values()].filter((m) => emailsOf(m) >= MIN_RECURRENCE)
recurring.sort((a, b) => emailsOf(b) - emailsOf(a))

const uniq = (a) => [...new Set(a)]
const stat = (nums) => ({ min: Math.min(...nums), max: Math.max(...nums) })

console.log(`\nRecurring clusters: ${recurring.length}\n`)

// risk score: large max dimension (would be "content" today, maxDim>=800 is kept
// by isSignatureGraphic) OR high within-cluster size/aspect variance.
const scored = recurring.map((m) => {
  const sizes = m.map((x) => x.size)
  const dims = m.map((x) => Math.max(x.w, x.h))
  const aspects = m.map((x) => (x.h ? x.w / x.h : 0))
  const s = stat(sizes),
    d = stat(dims),
    asp = stat(aspects)
  const sizeSpread = s.min ? s.max / s.min : Infinity
  const aspSpread = asp.min ? asp.max / asp.min : Infinity
  return { m, emails: emailsOf(m), names: uniq(m.map((x) => x.name)), maxDim: d.max, sizeSpread, aspSpread }
})

console.log('TOP recurring clusters (most emails):')
for (const c of scored.slice(0, 10)) {
  console.log(
    `  emails=${String(c.emails).padStart(3)} names=${String(c.names.length).padStart(2)} maxDim=${String(c.maxDim).padStart(4)} sizeSpread=${c.sizeSpread.toFixed(1)}x aspSpread=${c.aspSpread.toFixed(2)}x  e.g. ${c.names.slice(0, 2).join(', ')}`
  )
}

// RISKY: maxDim>=800 (today protected as content) OR aspect spread big (merging
// different shapes) OR size spread huge.
const risky = scored
  .filter((c) => c.maxDim >= 800 || c.aspSpread >= 1.8 || c.sizeSpread >= 12)
  .sort((a, b) => b.aspSpread - a.aspSpread)
console.log(`\nRISKY clusters (possible bad merges / content swept in): ${risky.length}`)
for (const c of risky.slice(0, 10)) {
  console.log(
    `  emails=${String(c.emails).padStart(3)} maxDim=${String(c.maxDim).padStart(4)} sizeSpread=${c.sizeSpread.toFixed(1)}x aspSpread=${c.aspSpread.toFixed(2)}x names=${c.names.length}  e.g. ${c.names.slice(0, 3).join(', ')}`
  )
}

// export montages: 1 representative for top-12 clusters, and up to 6 members for
// the top-6 risky clusters, so they can be eyeballed.
async function montage(members, file, max = 6) {
  const picks = members.slice(0, max)
  const tiles = []
  for (const p of picks) {
    const im = await decode(p.buf)
    if (!im) continue
    im.scaleToFit({ w: 200, h: 200 })
    tiles.push(im)
  }
  if (!tiles.length) return
  const W = tiles.reduce((s, t) => s + t.bitmap.width + 6, 6)
  const H = Math.max(...tiles.map((t) => t.bitmap.height)) + 12
  const canvas = new Jimp({ width: W, height: H, color: 0xffffffff })
  let x = 6
  for (const t of tiles) {
    canvas.composite(t, x, 6)
    x += t.bitmap.width + 6
  }
  await canvas.write(file)
}

await fs.mkdir(path.join(OUT, 'top'), { recursive: true })
await fs.mkdir(path.join(OUT, 'risky'), { recursive: true })
for (let i = 0; i < Math.min(12, scored.length); i++)
  await montage(scored[i].m, path.join(OUT, 'top', `cluster${i}_e${scored[i].emails}.png`), 6)
for (let i = 0; i < Math.min(6, risky.length); i++)
  await montage(risky[i].m, path.join(OUT, 'risky', `risky${i}_asp${risky[i].aspSpread.toFixed(1)}.png`), 6)

console.log(`\nExported montages to ${OUT}/top and ${OUT}/risky`)
