#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (process.env.AMP_FAKE_ARGS_LOG) appendFileSync(process.env.AMP_FAKE_ARGS_LOG, `${JSON.stringify(args)}\n`)
if (args[0] === 'threads' && args[1] === 'markdown') {
  if (!/^T-[0-9a-f-]{36}$/i.test(args[2] ?? '')) process.exit(2)
  process.stdout.write('# fake Amp thread\n')
  process.exit(0)
}
if (args[0] === 'threads' && args[1] === 'export') {
  const id = args[2] ?? ''
  if (!/^T-[0-9a-f-]{36}$/i.test(id)) process.exit(2)
  const orb = id.endsWith('0002')
  const missingCwd = id.endsWith('0003')
  process.stdout.write(JSON.stringify({
    id,
    creatorUserID: 'fake-account',
    meta: { executorType: orb ? 'sandbox' : 'local-client', agentMode: orb ? 'high' : 'medium' },
    env: { initial: missingCwd ? { trees: [] } : { workingDirectory: process.cwd(), trees: [] } },
    messages: []
  }))
  process.exit(0)
}
const orb = args.includes('--orb-execute')
const continuation = args[0] === 'threads' && args[1] === 'continue' ? args[2] : undefined
const threadId = continuation ?? (orb ? 'T-00000000-0000-0000-0000-000000000002' : 'T-00000000-0000-0000-0000-000000000001')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'assistant', session_id: threadId, message: { content: orb ? 'AMP_ORB_OK' : 'AMP_LOCAL_OK' } }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'result', session_id: threadId, is_error: input.includes('FAIL'), error: input.includes('FAIL') ? 'fake amp failure' : undefined }) + '\n')
})
