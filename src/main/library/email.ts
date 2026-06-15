import { promises as fs } from 'fs'

// Lightweight RFC-822 / MIME .eml parser — pure JS, no dependencies.
// Good enough to pull headers (From/To/Date/Subject) and a readable body for
// indexing; it is not a full MIME implementation.

export interface ParsedEmail {
  from: string
  to: string
  date: string
  subject: string
  body: string
}

function unfoldHeaders(headerBlock: string): Record<string, string> {
  // Join continuation lines (folded headers start with whitespace).
  const lines = headerBlock.split(/\r?\n/)
  const joined: string[] = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && joined.length) {
      joined[joined.length - 1] += ' ' + line.trim()
    } else {
      joined.push(line)
    }
  }
  const out: Record<string, string> = {}
  for (const line of joined) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim().toLowerCase()
      const val = line.slice(idx + 1).trim()
      if (!(key in out)) out[key] = val
    }
  }
  return out
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractBody(headers: Record<string, string>, body: string): string {
  const ctype = headers['content-type'] || ''
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase()

  const boundaryMatch = ctype.match(/boundary="?([^";]+)"?/i)
  if (boundaryMatch) {
    // Multipart: prefer the text/plain part, fall back to text/html.
    const boundary = '--' + boundaryMatch[1]
    const parts = body.split(boundary)
    let plain = ''
    let htmlPart = ''
    for (const part of parts) {
      const sep = part.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n'
      const splitAt = part.indexOf(sep)
      if (splitAt < 0) continue
      const ph = unfoldHeaders(part.slice(0, splitAt))
      let pbody = part.slice(splitAt + sep.length)
      const penc = (ph['content-transfer-encoding'] || '').toLowerCase()
      if (penc === 'quoted-printable') pbody = decodeQuotedPrintable(pbody)
      else if (penc === 'base64') pbody = Buffer.from(pbody.replace(/\s+/g, ''), 'base64').toString('utf8')
      const pct = ph['content-type'] || ''
      if (/text\/plain/i.test(pct) && !plain) plain = pbody
      else if (/text\/html/i.test(pct) && !htmlPart) htmlPart = pbody
    }
    if (plain.trim()) return plain.trim()
    if (htmlPart.trim()) return htmlToText(htmlPart)
    return ''
  }

  let text = body
  if (enc === 'quoted-printable') text = decodeQuotedPrintable(text)
  else if (enc === 'base64') text = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (/text\/html/i.test(ctype)) text = htmlToText(text)
  return text.trim()
}

export async function parseEmlFile(filePath: string): Promise<ParsedEmail> {
  const raw = await fs.readFile(filePath, 'latin1') // tolerate any byte content
  const sep = raw.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n'
  const splitAt = raw.indexOf(sep)
  const headerBlock = splitAt >= 0 ? raw.slice(0, splitAt) : raw
  const body = splitAt >= 0 ? raw.slice(splitAt + sep.length) : ''
  const h = unfoldHeaders(headerBlock)
  return {
    from: h['from'] || '',
    to: h['to'] || '',
    date: h['date'] || '',
    subject: h['subject'] || '',
    body: extractBody(h, body)
  }
}
