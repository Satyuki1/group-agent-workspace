import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

const image = process.env.IM_TEST_WORKER_IMAGE
test(
  'DSH worker streams, asks for approval and returns a file',
  { skip: !image, timeout: 60_000 },
  async (t) => {
    const sentTools = new Set<string>()
    const mock = createServer(async (req, res) => {
      const parts = []
      for await (const part of req) parts.push(part)
      const request = JSON.parse(Buffer.concat(parts).toString() || '{}')
      if (!req.url?.endsWith('/messages')) {
        res.writeHead(404).end()
        return
      }
      for (const tool of request.tools ?? []) sentTools.add(tool.name)
      const followup = request.messages?.some(
        (m: { content: unknown }) =>
          Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
      )
      const block = followup
        ? { type: 'text', text: 'Result file generated.' }
        : { type: 'tool_use', id: 'toolu_file', name: 'team_write_file', input: {} }
      const delta = followup
        ? { type: 'text_delta', text: 'Result file generated.' }
        : {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ name: 'result.txt', text: 'fixture report' }),
          }
      const frame = (type: string, value: unknown) =>
        'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...(value as object) }) + '\n\n'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        frame('message_start', {
          message: {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            usage: { input_tokens: 50, output_tokens: 0 },
          },
        }) +
          frame('content_block_start', {
            index: 0,
            content_block: followup ? { type: 'text', text: '' } : block,
          }) +
          frame('content_block_delta', { index: 0, delta }) +
          frame('content_block_stop', { index: 0 }) +
          frame('message_delta', {
            delta: { stop_reason: followup ? 'end_turn' : 'tool_use' },
            usage: { output_tokens: 15 },
          }) +
          frame('message_stop', {})
      )
    })
    mock.listen(0, '127.0.0.1')
    await once(mock, 'listening')
    t.after(() => mock.close())
    const address = mock.address()
    assert(address && typeof address === 'object')
    const name = 'dsbot-team-test-' + randomUUID()
    const alias = process.env.IM_TEST_DOCKER_HOST ?? 'host.docker.internal'
    const network = process.env.IM_TEST_DOCKER_NETWORK
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--name',
        name,
        ...(network ? ['--network', network] : []),
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '-e',
        'DEEPSEEK_API_KEY=mock-key',
        '-e',
        'DEEPSEEK_BASE_URL=http://' + alias + ':' + address.port + '/v1',
        image!,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    t.after(async () => {
      await promisify(execFile)('docker', ['rm', '-f', name]).catch(() => {})
      child.kill()
    })
    child.stderr.resume()
    const exit = once(child, 'close')
    child.stdin.on('error', () => {})
    child.stdin.write(
      JSON.stringify({
        kind: 'start',
        model: 'deepseek-official/deepseek-flash',
        tools: true,
        instructions: 'Create a report with the file tool.',
        prompt: 'Create a report',
      }) + '\n{"kind":"go"}\n'
    )
    const events = []
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!line.startsWith('IM_WORKER ')) continue
      const event = JSON.parse(line.slice(10))
      events.push(event)
      if (event.type === 'approval')
        child.stdin.write(JSON.stringify({ kind: 'decision', id: event.id, decision: 'allow' }) + '\n')
      if (event.type === 'complete' || event.type === 'failed') {
        child.stdin.end()
        break
      }
    }
    assert.equal((await exit)[0], 0)
    assert.equal(events.at(-1)?.type, 'complete', JSON.stringify(events.map((e) => e.type)))
    assert(sentTools.has('team_write_file'))
    assert(!sentTools.has('bash'))
    assert(events.some((e) => e.type === 'approval'))
    assert(events.some((e) => e.type === 'delta' && e.text.includes('Result file')))
    assert.equal(
      Buffer.from(events.find((e) => e.type === 'file').data, 'base64').toString(),
      'fixture report'
    )
  }
)
