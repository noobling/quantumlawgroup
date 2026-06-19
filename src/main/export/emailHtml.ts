import type { ParsedMail, Attachment } from 'mailparser'

// Build a clean, Mac-Mail-like HTML document for an email: a styled header
// (subject + From/Date/To/Cc), the email's own HTML body (inline images
// embedded), and an attachments footer. Pure (no Electron) so it's testable and
// reusable; emailToPdf.ts renders the result with printToPDF.

const TRANSPARENT_PX =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function esc(s = ''): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    font: 13.5px/1.55 -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #1d1d1f; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .dsl-subject { font-size: 21px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.25; margin: 0 0 12px; color: #1d1d1f; }
  .dsl-meta { border-collapse: collapse; margin: 0 0 14px; font-size: 12.5px; }
  .dsl-meta td { padding: 1.5px 0; vertical-align: top; }
  .dsl-meta .k { color: #86868b; font-weight: 500; padding-right: 12px; white-space: nowrap; width: 1%; }
  .dsl-meta .v { color: #1d1d1f; }
  .dsl-sep { border: 0; border-top: 1px solid #e3e3e6; margin: 0 0 20px; }
  .dsl-body { font-size: 13.5px; line-height: 1.55; color: #1d1d1f; word-wrap: break-word; overflow-wrap: break-word; }
  .dsl-body img { max-width: 100%; height: auto; }
  .dsl-body table { max-width: 100%; }
  .dsl-body a { color: #0066cc; }
  .dsl-body blockquote { margin: 10px 0; padding-left: 14px; border-left: 3px solid #d2d2d7; color: #515154; }
  .dsl-body pre, .dsl-body code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
  .dsl-body pre { white-space: pre-wrap; word-wrap: break-word; }
  .dsl-atts { margin-top: 24px; padding: 12px 14px; border: 1px solid #e3e3e6; border-radius: 10px;
    background: #f5f5f7; font-size: 12.5px; color: #1d1d1f; }
  .dsl-atts .t { font-weight: 600; margin-bottom: 5px; }
  .dsl-atts .f { color: #515154; }
`

export function buildEmailHtml(mail: ParsedMail): { html: string; fileAttachments: Attachment[] } {
  const atts = (mail.attachments || []) as Attachment[]
  let body = typeof mail.html === 'string' && mail.html ? mail.html : mail.textAsHtml || '<p>(no message body)</p>'

  // Apple Mail interleaves several full <html>…</html> documents (one per inline
  // part). Flatten the document wrappers so nested <body> margins/<meta> don't
  // add large empty gaps; the inner content + styling is preserved.
  body = body.replace(/<\/?(?:html|head|body)[^>]*>/gi, '').replace(/<meta\b[^>]*>/gi, '')
  // Collapse the empty spacer blocks Apple Mail leaves where inline parts sat
  // (stacks of empty <div>s and <br>s that otherwise render as big gaps).
  for (let i = 0; i < 3; i++) {
    body = body.replace(/<div[^>]*>(?:\s|&nbsp;| |<br\b[^>]*\/?>)*<\/div>/gi, '')
  }
  body = body.replace(/(?:\s*<br\b[^>]*\/?>\s*){3,}/gi, '<br><br>')

  // Resolve cid: references → attachments. Prefer Content-ID; fall back to the
  // order cids appear vs. the order attachments arrive (handles emails whose
  // Content-ID headers were stripped on export).
  const cidRefs = [...new Set((body.match(/cid:[^"'\s)>]+/gi) || []).map((s) => s.slice(4)))]
  const idOf = (a: Attachment): string => (a.contentId || '').replace(/^<|>$/g, '')
  const byId = new Map<string, Attachment>()
  for (const a of atts) if (idOf(a)) byId.set(idOf(a), a)
  const unresolvedCids = cidRefs.filter((c) => !byId.has(c))
  const unusedAtts = atts.filter((a) => !idOf(a) || !cidRefs.includes(idOf(a)))
  const orderMap = new Map<string, Attachment>()
  unresolvedCids.forEach((c, i) => unusedAtts[i] && orderMap.set(c, unusedAtts[i]))

  const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const badge = (name: string): string =>
    `<span style="display:inline-block;padding:3px 9px;margin:3px 2px;border:1px solid #d2d2d7;border-radius:6px;background:#f5f5f7;color:#515154;font-size:12.5px;">📎 ${esc(name)}</span>`

  const embedded = new Set<Attachment>()
  for (const cid of cidRefs) {
    const a = byId.get(cid) || orderMap.get(cid)
    if (a && a.contentType?.startsWith('image/')) {
      // Inline image (e.g. signature logo): embed as a data URI.
      embedded.add(a)
      body = body.split('cid:' + cid).join(`data:${a.contentType};base64,${a.content.toString('base64')}`)
    } else {
      // Non-image (e.g. an inline PDF preview) or unmatched cid: the original
      // <img> would render as a big blank box, so swap the whole tag for a small
      // attachment badge; the file itself is extracted + listed below.
      body = body.replace(new RegExp('<img[^>]*cid:' + escRe(cid) + '[^>]*>', 'gi'), badge(a?.filename || 'attachment'))
      body = body.split('cid:' + cid).join(TRANSPARENT_PX) // any remaining bare refs
    }
  }

  const fileAttachments = atts.filter((a) => !embedded.has(a))

  const addrText = (v: ParsedMail['to']): string =>
    (Array.isArray(v) ? v.map((t) => t.text).join(', ') : v?.text) || ''
  const dateText = (d?: Date): string =>
    d
      ? `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      : ''

  const rows: string[] = []
  const row = (label: string, val: string): void => {
    if (val) rows.push(`<tr><td class="k">${label}</td><td class="v">${esc(val)}</td></tr>`)
  }
  row('From', mail.from?.text || '')
  row('Date', dateText(mail.date))
  row('To', addrText(mail.to))
  row('Cc', addrText(mail.cc))

  const attBox = fileAttachments.length
    ? `<div class="dsl-atts"><div class="t">📎 ${fileAttachments.length} attachment${fileAttachments.length === 1 ? '' : 's'} <span class="f">(saved alongside)</span></div>${fileAttachments
        .map((a) => `<div class="f">${esc(a.filename || 'attachment')} · ${Math.max(1, Math.round((a.content?.length || 0) / 1024))} KB</div>`)
        .join('')}</div>`
    : ''

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    <div class="dsl-subject">${esc(mail.subject || '(no subject)')}</div>
    <table class="dsl-meta">${rows.join('')}</table>
    <hr class="dsl-sep">
    <div class="dsl-body">${body}</div>
    ${attBox}
  </body></html>`

  return { html, fileAttachments }
}
