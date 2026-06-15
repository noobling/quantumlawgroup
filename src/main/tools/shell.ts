import { exec } from 'child_process'
import { promisify } from 'util'
import type { ToolDef } from './types'
import { resolvePath, str } from './types'

const execAsync = promisify(exec)

export const runCommand: ToolDef = {
  name: 'run_command',
  description:
    'Run a shell command on the user\'s Windows machine (e.g. open a folder in Explorer, launch an app, run a script). High-impact — always asks the user for approval first.',
  needsPermission: true,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute.' },
      cwd: { type: 'string', description: 'Optional working directory.' }
    },
    required: ['command']
  },
  async run(args, ctx) {
    const command = str(args, 'command')
    const cwd = args.cwd ? resolvePath(ctx, str(args, 'cwd')) : ctx.filesDir
    const ok = await ctx.requestPermission('Run command', `${command}\n\n(in ${cwd})`)
    if (!ok) return { summary: 'Command denied', content: 'User denied the command.', isError: true }
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 4_000_000 })
      const out = `${stdout || ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.slice(0, 60_000)
      return { summary: `Ran: ${command.slice(0, 48)}`, content: out || '(no output)' }
    } catch (e) {
      return { summary: `Command failed`, content: `Error: ${(e as Error).message}`, isError: true }
    }
  }
}
