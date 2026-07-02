// Perceptual image hashing (dHash) in the browser — canvas-based port of the desktop app's
// Jimp implementation: greyscale 9×8 downscale, compare horizontal pixel pairs → 64-bit hash.
// Similar images (re-encoded/recompressed logos) land within a few bits of each other.

/** Max Hamming distance (of 64 bits) at which two images count as "the same picture". */
export const SIMILAR_BITS = 8

/**
 * 64-bit difference hash as 16 hex chars, or null when the image can't be decoded or the
 * hash is degenerate (near-blank/divider images match everything, so they're rejected —
 * same guard as the desktop app).
 */
export async function dHash(bytes: Uint8Array, mime: string): Promise<string | null> {
  try {
    const blob = new Blob([bytes.slice()], { type: mime || 'image/png' })
    const bmp = await createImageBitmap(blob)
    const w = 9, h = 8
    let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (typeof OffscreenCanvas !== 'undefined') {
      ctx = new OffscreenCanvas(w, h).getContext('2d')
    } else {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      ctx = c.getContext('2d')
    }
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const { data } = ctx.getImageData(0, 0, w, h)
    const grey = (i: number): number => data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    let bits = ''
    let set = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = (y * w + x) * 4
        const bit = grey(i) > grey(i + 4) ? 1 : 0
        set += bit
        bits += bit
      }
    }
    if (set < 10 || set > 54) return null
    let hex = ''
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
    return hex
  } catch {
    return null
  }
}

export function hamming(a: string, b: string): number {
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

export const similar = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && hamming(a, b) <= SIMILAR_BITS
