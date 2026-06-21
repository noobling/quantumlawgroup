// Spike: compare three ways of identifying recurring "signature logo" image
// attachments across a real email set, to decide whether content-based matching
// beats the current filename|size fingerprint.
//
//   Tier 0 (current): identity = filename.toLowerCase() + '|' + byteSize
//   Tier 1 (exact):   identity = sha256(content)              [no deps]
//   Tier 2 (fuzzy):   identity = perceptual dHash, grouped by Hamming distance
//
// A "recurring logo" = an identity that appears in >= MIN_RECURRENCE distinct
// emails (matches production.ts MIN_RECURRENCE = 3). We report what each tier
// flags and, crucially, what T1/T2 catch that T0 misses.
//
// Usage: node scripts/image-similarity-spike.mjs "/path/to/eml/folder"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { simpleParser } from 'mailparser'
import { Jimp } from 'jimp'

const ROOT = process.argv[2] || '/Users/davidyu/Downloads/sample-emails'
const MIN_RECURRENCE = 3
const HAMMING_THRESHOLD = 8 // <= this many differing bits => "same image" (of 64)

// --- helpers ---------------------------------------------------------------

async function walk(dir) {
  const out = []
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.eml')) out.push(p)
  }
  return out
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// 64-bit dHash: decode -> 9x8 greyscale -> compare horizontally adjacent pixels.
// Returns a BigInt (64 bits) or null if the image can't be decoded.
async function dHash(buf) {
  let img
  try {
    img = await Jimp.read(buf)
  } catch {
    return null
  }
  img.resize({ w: 9, h: 8 }).greyscale()
  const { data, width } = img.bitmap // RGBA; greyscale => R==G==B
  let bits = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[(y * width + x) * 4]
      const right = data[(y * width + x + 1) * 4]
      bits = (bits << 1n) | (left < right ? 1n : 0n)
    }
  }
  return bits
}

const hamming = (a, b) => {
  let x = a ^ b
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

// dedup an array of identities to the set seen in ONE email (matches the real
// per-doc dedup so a logo embedded twice in one mail counts once)
const uniq = (arr) => [...new Set(arr)]

// --- main ------------------------------------------------------------------

const files = await walk(ROOT)
console.log(`Scanning ${files.length} .eml files under:\n  ${ROOT}\n`)

// per-image record: { emailIdx, name, size, sha, dhash }
const images = []
let emailsWithImages = 0
let next = 0
let done = 0

const worker = async () => {
  for (;;) {
    const idx = next++
    if (idx >= files.length) return
    try {
      const mail = await simpleParser(await fs.readFile(files[idx]))
      const atts = (mail.attachments || []).filter((a) => (a.contentType || '').startsWith('image/'))
      if (atts.length) emailsWithImages++
      for (const a of atts) {
        const buf = a.content
        if (!buf || !buf.length) continue
        images.push({
          emailIdx: idx,
          name: (a.filename || '').trim().toLowerCase(),
          size: buf.length,
          sha: sha256(buf),
          dhash: await dHash(buf)
        })
      }
    } catch {
      /* skip unparseable */
    }
    done++
    if (done % 50 === 0 || done === files.length) process.stdout.write(`\r  parsed ${done}/${files.length}`)
  }
}
const pool = Math.max(2, Math.min(files.length, (os.cpus().length || 4)))
await Promise.all(Array.from({ length: pool }, () => worker()))
process.stdout.write('\n\n')

const decodable = images.filter((i) => i.dhash != null).length
console.log(`Image attachments: ${images.length}  (in ${emailsWithImages} emails)`)
console.log(`Decodable by jimp (for dHash): ${decodable}/${images.length}\n`)

// --- recurrence by tier ----------------------------------------------------
// For each tier build: identity -> Set(emailIdx). Then a "logo group" is any
// identity seen in >= MIN_RECURRENCE distinct emails.

function recurrenceByKey(keyFn) {
  const map = new Map() // key -> Set(emailIdx)
  // dedup per email first
  const perEmail = new Map() // emailIdx -> Set(key)
  for (const img of images) {
    const k = keyFn(img)
    if (k == null) continue
    if (!perEmail.has(img.emailIdx)) perEmail.set(img.emailIdx, new Set())
    perEmail.get(img.emailIdx).add(k)
  }
  for (const [emailIdx, keys] of perEmail) {
    for (const k of keys) {
      if (!map.has(k)) map.set(k, new Set())
      map.get(k).add(emailIdx)
    }
  }
  return map
}

function summarize(label, map) {
  const groups = [...map.entries()].filter(([, emails]) => emails.size >= MIN_RECURRENCE)
  groups.sort((a, b) => b[1].size - a[1].size)
  const flaggedImages = images.filter((img) => {
    // re-derive: is this image's identity a recurring one?
    return false
  })
  const distinctIdentities = map.size
  const totalFlaggedInstances = groups.reduce((n, [k]) => {
    return n + images.filter((img) => keyForLabel(label, img) === k).length
  }, 0)
  console.log(`== ${label} ==`)
  console.log(`  distinct identities:      ${distinctIdentities}`)
  console.log(`  recurring groups (>=${MIN_RECURRENCE}):   ${groups.length}`)
  console.log(`  image instances flagged:  ${totalFlaggedInstances}`)
  console.log(`  top groups (emails x identity):`)
  for (const [k, emails] of groups.slice(0, 8)) {
    const ex = images.find((img) => keyForLabel(label, img) === k)
    const nm = ex ? ex.name || '(no name)' : '?'
    const kshort = typeof k === 'string' && k.length > 24 ? k.slice(0, 16) + '…' : String(k)
    console.log(`    ${String(emails.size).padStart(4)}  ${nm.padEnd(34)} [${kshort}]`)
  }
  console.log()
  return groups
}

// keyForLabel: recompute a tier's key for an image (used by summarize)
function keyForLabel(label, img) {
  if (label.startsWith('Tier 0')) return img.name + '|' + img.size
  if (label.startsWith('Tier 1')) return img.sha
  return null // Tier 2 handled separately (clustering)
}

const t0 = recurrenceByKey((img) => img.name + '|' + img.size)
const t1 = recurrenceByKey((img) => img.sha)
summarize('Tier 0 (filename|size, current)', t0)
summarize('Tier 1 (sha256 exact)', t1)

// --- Tier 2: perceptual clustering -----------------------------------------
// Greedy cluster decodable images by Hamming distance on dHash. Cluster id is
// assigned per image; then recurrence = distinct emails per cluster.
const decoded = images.filter((i) => i.dhash != null)
const reps = [] // { dhash, id }
for (const img of decoded) {
  let found = null
  for (const r of reps) {
    if (hamming(img.dhash, r.dhash) <= HAMMING_THRESHOLD) {
      found = r.id
      break
    }
  }
  if (found == null) {
    found = reps.length
    reps.push({ dhash: img.dhash, id: found })
  }
  img.cluster = found
}
const t2 = new Map() // clusterId -> Set(emailIdx)
{
  const perEmail = new Map()
  for (const img of decoded) {
    if (!perEmail.has(img.emailIdx)) perEmail.set(img.emailIdx, new Set())
    perEmail.get(img.emailIdx).add(img.cluster)
  }
  for (const [emailIdx, clusters] of perEmail) {
    for (const c of clusters) {
      if (!t2.has(c)) t2.set(c, new Set())
      t2.get(c).add(emailIdx)
    }
  }
}
{
  const groups = [...t2.entries()].filter(([, emails]) => emails.size >= MIN_RECURRENCE)
  groups.sort((a, b) => b[1].size - a[1].size)
  const flagged = decoded.filter((img) => (t2.get(img.cluster)?.size || 0) >= MIN_RECURRENCE)
  console.log(`== Tier 2 (perceptual dHash, Hamming <= ${HAMMING_THRESHOLD}) ==`)
  console.log(`  distinct clusters:        ${reps.length}`)
  console.log(`  recurring groups (>=${MIN_RECURRENCE}):   ${groups.length}`)
  console.log(`  image instances flagged:  ${flagged.length}`)
  console.log(`  top clusters (emails x cluster):`)
  for (const [cid, emails] of groups.slice(0, 8)) {
    const members = decoded.filter((img) => img.cluster === cid)
    const names = uniq(members.map((m) => m.name || '(no name)'))
    const sizes = uniq(members.map((m) => m.size))
    console.log(
      `    ${String(emails.size).padStart(4)}  names=${names.length} sizes=${sizes.length}  e.g. ${names.slice(0, 3).join(', ')}`
    )
  }
  console.log()

  // --- the money question: what does each tier catch that T0 misses? --------
  const t0Flagged = new Set()
  for (const img of images) {
    const k = img.name + '|' + img.size
    if ((t0.get(k)?.size || 0) >= MIN_RECURRENCE) t0Flagged.add(img)
  }
  const t1Flagged = new Set()
  for (const img of images) {
    if ((t1.get(img.sha)?.size || 0) >= MIN_RECURRENCE) t1Flagged.add(img)
  }
  const t2Flagged = new Set(flagged)

  const onlyT1 = [...t1Flagged].filter((i) => !t0Flagged.has(i))
  const onlyT2 = [...t2Flagged].filter((i) => !t0Flagged.has(i))
  const t2NotT1 = [...t2Flagged].filter((i) => !t1Flagged.has(i))

  console.log('== Cross-tier delta ==')
  console.log(`  flagged by T0 (current):        ${t0Flagged.size}`)
  console.log(`  flagged by T1 (exact hash):     ${t1Flagged.size}   (+${onlyT1.length} that T0 missed)`)
  console.log(`  flagged by T2 (perceptual):     ${t2Flagged.size}   (+${onlyT2.length} vs T0, +${t2NotT1.length} vs T1)`)
  console.log()
  console.log('  Sample of logos T1 catches but current T0 misses (diff name OR drifted size):')
  for (const img of onlyT1.slice(0, 12)) {
    console.log(`    ${(img.name || '(no name)').padEnd(34)} ${String(img.size).padStart(7)}B  sha=${img.sha.slice(0, 10)}`)
  }
}
