#!/usr/bin/env node
// A stand-in for the Amp CLI. Threads ending 0001 are local, 0002 Orb, 0003 local without workspace
// metadata, 0004 without executor metadata (opening needs an explicit executor hint).
// AMP_FAKE_ARGS_LOG: append each invocation's argv. AMP_FAKE_INPUT_LOG: append each prompt sent on stdin.
// AMP_FAKE_THREADS: a JSON file { [T-ID]: { v, updatedAt, messages, fail? } } that `threads export`
// serves and each execution appends its user prompt and reply to, as Amp does. A thread with `fail`
// makes export exit 1 with that text. Without the file, threads have no messages and no version.
// `threads label <id> <labels...>` checks labels as Amp does and adds them to the stored thread's
// `labels`; AMP_FAKE_LABEL_FAIL makes it exit 1 with that text. `threads usage <id>` prints
// `Cost: $<cost>` (the stored thread's `cost`, default 0); a thread with `usageFail` exits 1 with
// that text, one with `usageText` prints that instead. `--title` on a new thread's execution is
// stored as its `title`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (process.env.AMP_FAKE_ARGS_LOG) appendFileSync(process.env.AMP_FAKE_ARGS_LOG, `${JSON.stringify(args)}\n`)
const storePath = process.env.AMP_FAKE_THREADS
const load = () => storePath && existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {}
if (args[0] === 'threads' && args[1] === 'markdown') {
  if (!/^T-[0-9a-f-]{36}$/i.test(args[2] ?? '')) process.exit(2)
  process.stdout.write('# fake Amp thread\n')
  process.exit(0)
}
if (args[0] === 'threads' && args[1] === 'label') {
  const [id, ...labels] = args.slice(2)
  if (!/^T-[0-9a-f-]{36}$/i.test(id ?? '') || !labels.length) process.exit(2)
  if (process.env.AMP_FAKE_LABEL_FAIL) { process.stderr.write(process.env.AMP_FAKE_LABEL_FAIL); process.exit(1) }
  for (const label of labels) {
    if (label.length > 32) { process.stderr.write(`Error: Label "${label}" is too long: maximum 32 characters`); process.exit(1) }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) { process.stderr.write(`Error: Label "${label}" has invalid format: must be alphanumeric with hyphens, start with alphanumeric`); process.exit(1) }
  }
  if (storePath) {
    const store = load()
    const thread = store[id] ??= { v: 0, messages: [] }
    thread.labels = [...new Set([...(thread.labels ?? []), ...labels])]
    writeFileSync(storePath, JSON.stringify(store))
  }
  process.exit(0)
}
if (args[0] === 'threads' && args[1] === 'usage') {
  const id = args[2] ?? ''
  if (!/^T-[0-9a-f-]{36}$/i.test(id)) process.exit(2)
  const stored = load()[id]
  if (stored?.usageFail) { process.stderr.write(stored.usageFail); process.exit(1) }
  process.stdout.write(stored?.usageText ?? `${stored?.title ?? 'fake thread'}\nCost: $${(stored?.cost ?? 0).toFixed(2)}\nDetails: https://ampcode.com/threads/${id}/usage\n\n## Orb System Metrics\n\nSamples: 1\n`)
  process.exit(0)
}
if (args[0] === 'threads' && args[1] === 'export') {
  const id = args[2] ?? ''
  if (!/^T-[0-9a-f-]{36}$/i.test(id)) process.exit(2)
  const orb = id.endsWith('0002')
  const missingCwd = id.endsWith('0003')
  const noExecutor = id.endsWith('0004')
  const stored = load()[id]
  if (stored?.fail) { process.stderr.write(stored.fail); process.exit(1) }
  process.stdout.write(JSON.stringify({
    ...(stored ? { v: stored.v, updatedAt: stored.updatedAt } : {}),
    id,
    title: stored?.title ?? 'fake thread',
    creatorUserID: 'fake-account',
    meta: { ...(noExecutor ? {} : { executorType: orb ? 'sandbox' : 'local-client' }), agentMode: orb ? 'high' : 'medium' },
    env: { initial: missingCwd ? { trees: [] } : { workingDirectory: process.cwd(), trees: [] } },
    messages: stored?.messages ?? []
  }), () => process.exit(0)) // Exit once a large export has drained into the pipe.
} else {
  const orb = args.includes('--orb-execute')
  const continuation = args[0] === 'threads' && args[1] === 'continue' ? args[2] : undefined
  const threadId = continuation ?? (orb ? 'T-00000000-0000-0000-0000-000000000002' : 'T-00000000-0000-0000-0000-000000000001')
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => {
    if (process.env.AMP_FAKE_INPUT_LOG) appendFileSync(process.env.AMP_FAKE_INPUT_LOG, `${JSON.stringify({ threadId, input })}\n`)
    const reply = orb ? 'AMP_ORB_OK' : 'AMP_LOCAL_OK'
    if (storePath) {
      const store = load()
      const thread = store[threadId] ??= { v: 0, messages: [] }
      const title = args.indexOf('--title')
      if (title >= 0 && !continuation) thread.title = args[title + 1]
      let next = thread.messages.reduce((max, m) => Math.max(max, Number(m.messageId) || 0), 0)
      const now = Date.now()
      thread.messages.push(
        { messageId: ++next, role: 'user', content: [{ type: 'text', text: input }], createdAt: now, meta: { sentAt: now } },
        { messageId: ++next, role: 'assistant', content: [{ type: 'text', text: reply }], createdAt: now }
      )
      thread.v += 1
      thread.updatedAt = new Date(now).toISOString()
      writeFileSync(storePath, JSON.stringify(store))
    }
    process.stdout.write(JSON.stringify({ type: 'assistant', session_id: threadId, message: { content: reply } }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'result', session_id: threadId, is_error: input.includes('FAIL'), error: input.includes('FAIL') ? 'fake amp failure' : undefined }) + '\n')
  })
}
