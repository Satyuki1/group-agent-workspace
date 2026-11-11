import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { z } from 'zod'
import { prefix, runUpdate, uuid } from '../shared/protocol.ts'
import type { RunInput, RunUpdate } from '../shared/protocol.ts'
import { classify } from './classify.ts'

const origin = process.env.IM_SERVER_URL ?? 'http://127.0.0.1:3090'
const secret = process.env.IM_RUNNER_SECRET
if (!secret) throw new Error('IM_RUNNER_SECRET is required')
const base = origin + prefix + '/runner'
const headers = { authorization: 'Bearer ' + secret }
const slots = z.coerce
  .number()
  .int()
  .min(1)
  .max(20)
  .parse(process.env.IM_RUNNER_SLOTS ?? 4)
const running = new Set<Promise<void>>()
const shutdown = new AbortController()
const docker = promisify(execFile)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort())

async function api(path: string, payload: unknown, signal?: AbortSignal) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
  })
  if (!response.ok) throw Object.assign(new Error('Runner request failed'), { status: response.status })
  return response.json()
}

async function worker(run: RunInput, send: (update: RunUpdate) => Promise<void>, signal: AbortSignal) {
  if (run.files.reduce((total, f) => total + f.size, 0) > 64 * 1024 * 1024)
    throw new Error('Agent input exceeds 64 MB')
  const files = []
  for (const file of run.files) {
    const response = await fetch(base + '/' + run.id + '/files/' + file.id + '?lease=' + run.lease, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) throw new Error('File input unavailable')
    files.push({ ...file, data: Buffer.from(await response.arrayBuffer()).toString('base64') })
  }
  const name = 'dsbot-team-job-' + run.id
  const volume = 'dsbot-team-binding-' + uuid.parse(run.bindingId)
  const image = process.env.IM_WORKER_IMAGE ?? 'dsbot-team-worker:local'
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_TELEMETRY_DISABLED: '1' }
  const args = [
    'run',
    '--rm',
    '-i',
    '--name',
    name,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--memory=768m',
    '--cpus=1',
    '--pids-limit=100',
    '--mount',
    'type=volume,source=' + volume + ',target=/state',
    '-e',
    'DEEPSEEK_API_KEY',
    ...(env.DEEPSEEK_BASE_URL ? ['-e', 'DEEPSEEK_BASE_URL'] : []),
    '-e',
    'DSH_TELEMETRY_DISABLED',
    image,
  ]
  const child = spawn('docker', args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
  child.stdin.on('error', () => {})
  let ended = false
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  void exit.catch(() => {})
  async function remove() {
    if (!ended) await docker('docker', ['rm', '-f', name], { timeout: 8000 }).catch(() => {})
    child.kill('SIGTERM')
  }
  const stop = () => void remove()
  signal.addEventListener('abort', stop, { once: true })
  try {
    signal.throwIfAborted()
    child.stdin.write(
      JSON.stringify({
        kind: 'start',
        model: run.model,
        instructions: run.instructions,
        tools: run.tools,
        prompt: run.prompt,
      }) + '\n'
    )
    for (const file of files) {
      if (!child.stdin.write(JSON.stringify({ kind: 'input', file }) + '\n'))
        await new Promise<void>((resolve, reject) => {
          child.stdin.once('drain', resolve)
          child.stdin.once('error', reject)
          child.once('exit', () => reject(new Error('Worker exited')))
        })
    }
    child.stdin.write('{"kind":"go"}\n')
    let finished = false
    let terminal: RunUpdate | undefined
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      signal.throwIfAborted()
      if (!line.startsWith('IM_WORKER ')) continue
      const payload = JSON.parse(line.slice(10))
      if (payload.type === 'file') {
        const file = z.object({ name: z.string().max(120), data: z.string().max(700000) }).parse(payload)
        const form = new FormData()
        form.set('file', new Blob([Buffer.from(file.data, 'base64')]), file.name)
        const res = await fetch(base + '/' + run.id + '/files?lease=' + run.lease, {
          method: 'POST',
          headers,
          body: form,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        })
        if (!res.ok) throw new Error('Could not publish Agent file')
        continue
      }
      const update = runUpdate.parse(payload)
      if (update.type === 'complete' || update.type === 'failed') {
        terminal = update
        finished = true
        break
      }
      await send(update)
      if (update.type === 'approval') {
        let decision: string | null = null
        const approvalDeadline = Date.now() + 120_000
        while (!decision && Date.now() < approvalDeadline) {
          await wait(500, undefined, { signal })
          decision = (await api('/' + run.id + '/heartbeat', { lease: run.lease }, signal)).decision
        }
        child.stdin.write(
          JSON.stringify({ kind: 'decision', id: update.id, decision: decision ?? 'deny' }) + '\n'
        )
      }
    }
    child.stdin.end()
    const code = await exit
    ended = true
    if (code !== 0 || !finished || !terminal) throw new Error('Agent worker exited before completion')
    await send(terminal)
  } finally {
    signal.removeEventListener('abort', stop)
    if (!ended) await remove()
  }
}

async function perform(run: RunInput) {
  const cancelled = new AbortController()
  const signal = AbortSignal.any([shutdown.signal, cancelled.signal, AbortSignal.timeout(15 * 60_000)])
  let position = 0,
    ticking = false
  const heartbeat = setInterval(async () => {
    if (ticking || signal.aborted) return
    ticking = true
    try {
      await api('/' + run.id + '/heartbeat', { lease: run.lease }, signal)
    } catch (error) {
      if ((error as { status?: number }).status === 409) cancelled.abort()
    } finally {
      ticking = false
    }
  }, 3500)
  const send = async (update: RunUpdate) => {
    const payload = { lease: run.lease, position: position + 1, update }
    for (let attempt = 0; ; attempt++) {
      try {
        await api('/' + run.id + '/events', payload, signal)
        position++
        return
      } catch (error) {
        if ((error as { status?: number }).status === 409) {
          cancelled.abort()
          throw error
        }
        if (attempt >= 1 || signal.aborted) throw error
      }
    }
  }
  try {
    if (run.kind === 'route') {
      let target: string | null = null
      let failed = false
      try {
        target = await classify(run, signal, process.env.IM_ROUTER_API_KEY, process.env.IM_ROUTER_BASE_URL)
      } catch {
        failed = true
      }
      await send(
        failed ? { type: 'failed', reason: 'Classification unavailable' } : { type: 'complete', target }
      )
    } else await worker(run, send, signal)
  } catch {
    if (!signal.aborted) await send({ type: 'failed', reason: 'Agent execution failed' }).catch(() => {})
  } finally {
    clearInterval(heartbeat)
  }
}

console.log('Team Agent Runner started')
let routing: Promise<void> | undefined
while (!shutdown.signal.aborted) {
  try {
    if (!routing) {
      const route: RunInput | null = await api('/claim', { kind: 'route' }, shutdown.signal)
      if (route)
        routing = perform(route).finally(() => {
          routing = undefined
        })
    }
    if (running.size < slots) {
      const run: RunInput | null = await api('/claim', { kind: 'agent' }, shutdown.signal)
      if (run) {
        const task = perform(run).finally(() => running.delete(task))
        running.add(task)
        continue
      }
    }
  } catch {
    if (!shutdown.signal.aborted) console.warn('Runner cannot reach the IM service')
  }
  await wait(500, undefined, { signal: shutdown.signal }).catch(() => {})
}
await Promise.allSettled([...running, routing])
