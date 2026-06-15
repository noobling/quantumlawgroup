import { app, BrowserWindow, shell, dialog } from 'electron'
import path from 'path'
import { appendFileSync } from 'fs'

let mainWindow: BrowserWindow | null = null

function diag(msg: string): void {
  try {
    appendFileSync(path.join(app.getPath('userData'), 'diag.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}

process.on('uncaughtException', (e) => diag(`uncaughtException: ${e.stack || e}`))
process.on('unhandledRejection', (e) => diag(`unhandledRejection: ${e}`))

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'DeepSolve Legal',
    backgroundColor: '#0b0f1a',
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  const wc = mainWindow.webContents
  wc.on('did-fail-load', (_e, code, desc, url) => diag(`did-fail-load ${code} ${desc} ${url}`))
  wc.on('preload-error', (_e, p, err) => diag(`preload-error ${p}: ${err.stack || err}`))
  wc.on('render-process-gone', (_e, d) => diag(`render-process-gone: ${JSON.stringify(d)}`))
  wc.on('console-message', (_e, level, message, line, source) =>
    diag(`console[${level}] ${message} (${source}:${line})`)
  )

  // Open external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  try {
    const { registerIpc } = await import('./ipc')
    registerIpc(() => mainWindow)
  } catch (e) {
    const err = e as Error
    diag(`startup import failed: ${err.stack || err}`)
    dialog.showErrorBox('DeepSolve Legal — startup error', String(err.stack || err))
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
