import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { classify } from '../runner/classify.ts'
import type { RunInput } from '../shared/protocol.ts'

test('classifier only selects a group candidate, rejects invalid output and times out', async (t) => {
  const candidate = randomUUID()
  let output: unknown
  let hang = false
  let requestBody: Record<string, unknown> = {}
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requestBody = JSON.parse(Buffer.concat(chunks).toString())
    if (hang) return
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const run: RunInput = {
    id: randomUUID(),
    lease: randomUUID(),
    kind: 'route',
    location: 'server',
    bindingId: null,
    model: 'fixture-fast',
    instructions: '',
    tools: false,
    files: [],
    prompt: '{"current":"Please help"}',
    candidates: [{ id: candidate, name: 'Helper', description: 'Answer questions' }],
  }
  const route = () =>
    classify(run, new AbortController().signal, 'mock-key', 'http://127.0.0.1:' + address.port)
  output = { action: 'dispatch', agentId: candidate }
  assert.equal(await route(), candidate)
  assert.equal(requestBody.model, 'fixture-fast')
  assert.equal(requestBody.tools, undefined)
  output = { action: 'dispatch', agentId: randomUUID() }
  assert.equal(await route(), null)
  output = { action: 'ignore' }
  assert.equal(await route(), null)
  output = { action: 'ignore', answer: 'Unexpected output' }
  await assert.rejects(route)
  hang = true
  await assert.rejects(route, { name: 'TimeoutError' })
})
