import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from './acp/agent.js'
import { getPiCommand, shouldUseShellForPiCommand } from './pi-rpc/command.js'

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv.includes('--pi-strings-worker')) {
  const tools = optionValue('--pi-tools-json')
  if (!tools) throw new Error('--pi-tools-json is required for a pi-strings worker')
  process.env.PI_STRINGS_WORKER = '1'
  process.env.PI_STRINGS_PI_TOOLS = tools
  const thinking = optionValue('--pi-thinking')
  if (thinking) process.env.PI_STRINGS_PI_THINKING = thinking
}

if (process.argv.includes('--pi-strings-opened')) {
  delete process.env.PI_STRINGS_WORKER
  delete process.env.PI_STRINGS_PI_TOOLS
  delete process.env.PI_STRINGS_PI_THINKING
  process.env.PI_STRINGS_OPENED = '1'
}

// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes('--terminal-login')) {
  const { spawnSync } = await import('node:child_process')
  const cmd = getPiCommand(process.env.PI_ACP_PI_COMMAND)
  const res = spawnSync(cmd, [], {
    stdio: 'inherit',
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd)
  })

  if ((res as any).error && (res as any).error.code === 'ENOENT') {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.\n`
    )
    process.exit(1)
  }

  process.exit(typeof res.status === 'number' ? res.status : 1)
}

const input = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>(resolve => {
      if ((process.stdout as any).destroyed || !process.stdout.writable) return resolve()

      try {
        process.stdout.write(chunk, err => {
          void err
          resolve()
        })
      } catch {
        // Common: ERR_STREAM_DESTROYED ("Cannot call write after a stream was destroyed").
        resolve()
      }
    })
  }
})

const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    process.stdin.on('end', () => controller.close())
    process.stdin.on('error', err => controller.error(err))
  }
})

const stream = ndJsonStream(input, output)

let piAgent: PiAcpAgent | undefined
new AgentSideConnection(conn => {
  piAgent = new PiAcpAgent(conn)
  return piAgent
}, stream)

let shuttingDown: Promise<void> | undefined
function shutdown(): Promise<void> {
  return (shuttingDown ??= (async () => {
    try {
      await piAgent?.dispose()
    } catch {
      // ignore disposal failures; the adapter is exiting
    }
    process.exit(0)
  })())
}

process.stdin.on('end', () => { void shutdown() })
process.stdin.on('close', () => { void shutdown() })
process.stdin.resume()
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
process.stdout.on('error', () => { void shutdown() })
