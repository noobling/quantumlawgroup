// Headless test of the excluded-attachment restore map (real Electron main process,
// but no PDF render): drives the REAL writeExcludedFolder with synthetic excluded
// records and asserts that Excluded/.restore-map.json points each excluded file at the
// produced folder(s) a restore would land in. Also unit-checks intendedDirOf.
import { app } from 'electron'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { writeExcludedFolder, intendedDirOf, sweepStaleOutputs, pdfFileName, dedupePdfExt } from '../src/main/export/production'
import { buildEmailHtml } from '../src/main/export/emailHtml'

const log = (...a: unknown[]): void => process.stdout.write(a.join(' ') + '\n')

type Excluded = { name: string; size: number; content: Buffer; source: string }

async function main(): Promise<void> {
  const tmp = path.join(os.tmpdir(), 'dsl-prod-e2e-' + process.pid)
  app.setPath('userData', path.join(tmp, 'userData'))
  await app.whenReady()

  const outDir = path.join(tmp, 'Output')
  await fs.mkdir(outDir, { recursive: true })

  const checks: Array<[string, boolean]> = []
  const check = (name: string, cond: boolean): void => {
    checks.push([name, cond])
    log((cond ? '  ✓ ' : '  ✗ ') + name)
  }

  // intendedDirOf — the produced family folder for an email's restored attachment.
  log('intendedDirOf:')
  check('nested email -> Documents/<dir>/<email>', intendedDirOf('Mailbox/2026/message.eml') === 'Documents/Mailbox/2026/message')
  check('root-level email -> Documents/<email>', intendedDirOf('message.eml') === 'Documents/message')
  check('windows separators normalised', intendedDirOf('Mailbox\\Inbox\\msg.eml') === 'Documents/Mailbox/Inbox/msg')

  // The same logo excluded from two different emails: one Excluded/ file, two destinations.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
  // Same filename, GENUINELY DIFFERENT bytes — must NOT collapse; both kept for review.
  const bannerA = Buffer.alloc(100, 1)
  const bannerB = Buffer.alloc(200, 2)
  const excluded: Excluded[] = [
    { name: 'logo.png', size: png.length, content: png, source: 'Mailbox/message.eml' },
    { name: 'logo.png', size: png.length, content: png, source: 'Mailbox/2026/quarterly.eml' },
    { name: 'contract.pdf', size: 2048, content: Buffer.alloc(2048), source: 'Mailbox/deal.eml' },
    { name: 'banner.png', size: bannerA.length, content: bannerA, source: 'Mailbox/a.eml' },
    { name: 'banner.png', size: bannerB.length, content: bannerB, source: 'Mailbox/b.eml' }
  ]

  log('running writeExcludedFolder…')
  await writeExcludedFolder(outDir, excluded as Parameters<typeof writeExcludedFolder>[1])

  const excludedDir = path.join(outDir, 'Excluded')
  const files = await fs.readdir(excludedDir).catch(() => [] as string[])
  log('Excluded/ contains:', JSON.stringify(files))
  check('logo.png written', files.includes('logo.png'))
  check('contract.pdf written', files.includes('contract.pdf'))
  check('listing spreadsheet written', files.includes('Excluded Attachments.xlsx'))

  let map: Record<string, string[]> = {}
  try {
    map = JSON.parse(await fs.readFile(path.join(excludedDir, '.restore-map.json'), 'utf8'))
  } catch (e) {
    log('FAILED to read .restore-map.json:', (e as Error).message)
  }
  log('.restore-map.json =', JSON.stringify(map))
  check('map has logo.png entry', Array.isArray(map['logo.png']))
  check(
    'logo.png -> both source emails’ produced folders',
    JSON.stringify(map['logo.png']) === JSON.stringify(['Documents/Mailbox/2026/quarterly', 'Documents/Mailbox/message'])
  )
  check('contract.pdf -> its email folder', JSON.stringify(map['contract.pdf']) === JSON.stringify(['Documents/Mailbox/deal']))

  // banner.png had two distinct versions → a folder, both versions inside, tagged by size.
  const bannerDir = path.join(excludedDir, 'banner.png')
  const bannerStat = await fs.stat(bannerDir).catch(() => null)
  check('banner.png is a folder (distinct versions grouped)', !!bannerStat && bannerStat.isDirectory())
  const bannerInner = await fs.readdir(bannerDir).catch(() => [] as string[])
  log('banner.png/ contains:', JSON.stringify(bannerInner))
  check('both distinct versions kept', bannerInner.length === 2)
  check(
    'each version tagged with its byte size',
    bannerInner.some((f) => f.includes('(100 bytes)')) && bannerInner.some((f) => f.includes('(200 bytes)'))
  )
  check('a-version maps to its email folder', JSON.stringify(map['banner (100 bytes).png']) === JSON.stringify(['Documents/Mailbox/a']))
  check('b-version maps to its email folder', JSON.stringify(map['banner (200 bytes).png']) === JSON.stringify(['Documents/Mailbox/b']))

  // sweepStaleOutputs — clears both kinds of cruft an earlier run can leave behind,
  // without touching legitimate output. Layout (all under <out>/Documents):
  //   Mailbox/kept/            ← an email WITH a kept attachment (its own folder)
  //     kept.pdf               (email PDF — keep)
  //     report.pdf  4096       (kept attachment — keep, shares a name with an excluded one)
  //     TPL4AL.pdf  169773     (now-excluded attachment a prior run left here — REMOVE)
  //     _report.pdf 8192       (excluded, collision-prefixed copy — REMOVE)
  //   Mailbox/                 ← shared folder: the email's PDF moved up here after its
  //     gone.pdf               last attachment was excluded (current output — keep)
  //     gone/                  ← the abandoned old folder (orphaned — REMOVE entirely)
  //       gone.pdf  500
  //       TPL4AL.pdf 169773
  const sweepOut = path.join(tmp, 'sweep')
  const keptDir = path.join(sweepOut, 'Documents', 'Mailbox', 'kept')
  const sharedDir = path.join(sweepOut, 'Documents', 'Mailbox')
  const goneDir = path.join(sharedDir, 'gone')
  await fs.mkdir(keptDir, { recursive: true })
  await fs.mkdir(goneDir, { recursive: true })
  await fs.writeFile(path.join(keptDir, 'kept.pdf'), Buffer.alloc(500))
  await fs.writeFile(path.join(keptDir, 'report.pdf'), Buffer.alloc(4096))
  await fs.writeFile(path.join(keptDir, 'TPL4AL.pdf'), Buffer.alloc(169773))
  await fs.writeFile(path.join(keptDir, '_report.pdf'), Buffer.alloc(8192))
  await fs.writeFile(path.join(sharedDir, 'gone.pdf'), Buffer.alloc(300))
  await fs.writeFile(path.join(goneDir, 'gone.pdf'), Buffer.alloc(500))
  await fs.writeFile(path.join(goneDir, 'TPL4AL.pdf'), Buffer.alloc(169773))
  // The current items: the kept email (own folder, TPL4AL + the 8192 report excluded) and
  // the relocated email (now in the shared folder, all attachments excluded).
  const items = [
    { fileRel: 'Documents/Mailbox/kept/kept.pdf', excluded: [{ name: 'TPL4AL.pdf', size: 169773 }, { name: 'report.pdf', size: 8192 }] },
    { fileRel: 'Documents/Mailbox/gone.pdf', excluded: [{ name: 'TPL4AL.pdf', size: 169773 }] }
  ]
  log('running sweepStaleOutputs…')
  await sweepStaleOutputs(sweepOut, items as Parameters<typeof sweepStaleOutputs>[1])
  const keptAfter = (await fs.readdir(keptDir).catch(() => [])).sort()
  const sharedAfter = (await fs.readdir(sharedDir).catch(() => [])).sort()
  log('kept folder after sweep:', JSON.stringify(keptAfter))
  log('shared folder after sweep:', JSON.stringify(sharedAfter))
  check('email PDF kept', keptAfter.includes('kept.pdf'))
  check('kept attachment (same name, different size) survives', keptAfter.includes('report.pdf'))
  check('lingering excluded attachment removed', !keptAfter.includes('TPL4AL.pdf'))
  check('collision-prefixed excluded copy removed', !keptAfter.includes('_report.pdf'))
  check('relocated email PDF in shared folder kept', sharedAfter.includes('gone.pdf'))
  check('abandoned family folder removed entirely', !sharedAfter.includes('gone'))

  // pdfFileName / dedupePdfExt — a source whose name already ends in .pdf must not
  // yield a doubled extension.
  log('pdf naming:')
  check('email named "drawing.pdf" → drawing.pdf (no double)', pdfFileName('drawing.pdf') === 'drawing.pdf')
  check('uppercase .PDF not doubled', pdfFileName('drawing.PDF') === 'drawing.PDF')
  check('normal base gets .pdf', pdfFileName('report') === 'report.pdf')
  check('base ending in other ext keeps it', pdfFileName('data.xls') === 'data.xls.pdf')
  check('dedupe collapses .pdf.pdf', dedupePdfExt('Documents/x/drawing.pdf.pdf') === 'Documents/x/drawing.pdf')
  check('dedupe leaves single .pdf', dedupePdfExt('Documents/x/report.pdf') === 'Documents/x/report.pdf')

  // Inline (cid-referenced) image the user excluded by name must be stripped from the
  // email body — not embedded as a data URI — and set aside in Excluded/. A non-excluded
  // inline image is still embedded normally.
  log('inline excluded image:')
  const exclImg = Buffer.from('EXCLUDED-INLINE-IMAGE-UNIQUE-MARKER-0123456789')
  const keepImg = Buffer.from('KEPT-INLINE-IMAGE-UNIQUE-MARKER-9876543210')
  const inlineMail = {
    html: '<p>before <img src="cid:excl1"> middle <img src="cid:keep1"> after</p>',
    attachments: [
      { filename: 'Screen Shot 2018-05-07 at 9.38.28 AM.png', contentType: 'image/png', content: exclImg, contentId: '<excl1>', contentDisposition: 'inline' },
      { filename: 'photo.png', contentType: 'image/png', content: keepImg, contentId: '<keep1>', contentDisposition: 'inline' }
    ],
    subject: 'demo',
    from: { text: 'a@b.com' },
    to: { text: 'c@d.com' }
  }
  const built = buildEmailHtml(inlineMail as Parameters<typeof buildEmailHtml>[0], {
    excludeAttachments: ['Screen Shot 2018-05-07 at 9.38.28 AM.png']
  })
  const exclB64 = exclImg.toString('base64')
  const keepB64 = keepImg.toString('base64')
  check('excluded inline image NOT embedded in email body', !built.html.includes(exclB64))
  check('non-excluded inline image still embedded', built.html.includes(keepB64))
  check('excluded inline image set aside for review', built.excludedAttachments.some((a) => /screen shot/i.test(a.filename || '')))
  check('kept inline image not set aside', !built.excludedAttachments.some((a) => a.filename === 'photo.png'))

  // Apple Mail variant: the image is inlined DIRECTLY as a data: URI in the HTML (no cid
  // reference at all). The cid strip can't see it; the data-URI strip must remove it so
  // the excluded image doesn't survive into the combined PDF.
  const dataUriMail = {
    html: `<p>before <img src="data:image/png;base64,${exclB64}"> middle <img src="data:image/png;base64,${keepB64}"> after</p>`,
    attachments: [
      { filename: 'Screen Shot 2018-05-07 at 9.38.28 AM.png', contentType: 'image/png', content: exclImg, contentDisposition: 'inline' },
      { filename: 'photo.png', contentType: 'image/png', content: keepImg, contentDisposition: 'inline' }
    ],
    subject: 'demo2',
    from: { text: 'a@b.com' },
    to: { text: 'c@d.com' }
  }
  const built2 = buildEmailHtml(dataUriMail as Parameters<typeof buildEmailHtml>[0], {
    excludeAttachments: ['Screen Shot 2018-05-07 at 9.38.28 AM.png']
  })
  check('data-URI-embedded excluded image stripped from body', !built2.html.includes(exclB64))
  check('data-URI-embedded kept image preserved', built2.html.includes(keepB64))

  const ok = checks.every(([, c]) => c)
  log('\n==== RESULT: ' + (ok ? 'PASS' : 'FAIL') + ' ====')
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  app.exit(ok ? 0 : 1)
}

process.on('unhandledRejection', (r) => {
  log('UNHANDLED REJECTION:', String((r as Error)?.stack || r))
  app.exit(1)
})
main().catch((e) => {
  log('main THREW:', (e as Error).stack || String(e))
  app.exit(1)
})
