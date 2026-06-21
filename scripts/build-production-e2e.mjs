import esbuild from 'esbuild'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await esbuild.build({
  entryPoints: [path.join(root, 'scripts/production-e2e.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  outfile: path.join(root, 'scripts/.production-e2e.bundle.mjs'),
  alias: { '@shared': path.join(root, 'src/shared') },
  logLevel: 'info'
})
console.log('bundled -> scripts/.production-e2e.bundle.mjs')
