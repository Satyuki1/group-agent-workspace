import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { database, migrate, write } from '../server/db.ts'
import { createUser, hashPassword } from '../server/auth.ts'
import { build } from '../server/main.ts'
import { verifyClient } from './client.ts'
import type { RunInput, ImEvent } from '../shared/protocol.ts'

const dbUrl = process.env.IM_TEST_DATABASE_URL
test(
  'team members, persistent chat, Agent approvals, routing and revocation',
  { skip: !dbUrl, timeout: 100_000 },
  async (t) => {
    const schema = 'test_' + randomUUID().replaceAll('-', '')
    const root = database(dbUrl)
    await root.query('CREATE SCHEMA ' + schema)
    const url = new URL(dbUrl!)
    url.searchParams.set('options', '-c search_path=' + schema)
    const storage = await mkdtemp(join(tmpdir(), 'dsbot-team-'))
    const db = database(url.href)
    const origin = 'http://127.0.0.1:3091',
      runnerSecret = randomUUID()
    const pass = 'test-password-' + randomUUID()
    const sockets = new Set<WebSocket>()
    let app: Awaited<ReturnType<typeof build>> | undefined
    t.after(async () => {
      for (const ws of sockets) ws.terminate()
      await app?.close()
      await db.end()
      await root.query('DROP SCHEMA ' + schema + ' CASCADE')
      await root.end()
      await rm(storage, { recursive: true, force: true })
    })
    await migrate(db)
    const hashed = await hashPassword(pass)
    const alice = await write(db, (tx) =>
      createUser(tx, { username: 'alice', name: 'Alice', password: hashed }, true)
    )
    app = await build({
      databaseUrl: url.href, origin, storage, runnerSecret,
      personalWorkspace: 'http://127.0.0.1:3081', personalWorkspaceOwner: 'alice',
    })
    const address = await app.listen({ host: '127.0.0.1', port: 3091 })
    const base = '/api/im/v1'
    const headers = (cookie: string) => ({ cookie })
    async function request(path: string, method = 'GET', payload?: unknown, cookie = '', status = 200) {
      const result = await app!.inject({
        method: method as 'GET' | 'POST' | 'PUT' | 'PATCH',
        url: base + path,
        headers: {
          ...headers(cookie),
          ...(cookie === 'runner' ? { authorization: 'Bearer ' + runnerSecret } : {}),
        },
        payload: payload as Record<string, unknown>,
      })
      assert.equal(result.statusCode, status, `${method} ${path}: ${result.body}`)
      return result
    }
    const login = async (username: string) =>
      (await request('/login', 'POST', { username, password: pass })).headers['set-cookie']!.toString().split(
        ';'
      )[0]
    const a = await login('alice')
    const invite = async (username: string) => {
      const link = (await request('/admin/invitations', 'POST', {}, a)).json().url
      const token = new URLSearchParams(new URL(link).hash.slice(1)).get('invite')
      const accepted = await request('/accept', 'POST', { token, username, name: username, password: pass })
      await request(
        '/accept',
        'POST',
        { token, username: username + '2', name: username, password: pass },
        '',
        400
      )
      const cookie = accepted.headers['set-cookie']!.toString().split(';')[0]
      return { cookie, id: (await request('/me', 'GET', undefined, cookie)).json().id }
    }
    const b = await invite('bob'),
      c = await invite('chris')
    await request('/admin/invitations', 'POST', {}, b.cookie, 403)
    const { id } = (
      await request('/conversations', 'POST', { kind: 'group', name: '项目群', users: [b.id] }, a)
    ).json()
    const dm = await request('/conversations', 'POST', { kind: 'dm', target: b.id }, a)
    assert.equal(
      (await request('/conversations', 'POST', { kind: 'dm', target: alice }, b.cookie)).json().id,
      dm.json().id
    )
    const room = '/conversations/' + id
    await request(room + '/messages', 'GET', undefined, c.cookie, 404)
    function watch(cookie: string, after?: string) {
      const events: ImEvent[] = []
      const ws = new WebSocket(
        address.replace('http:', 'ws:') + base + '/events' + (after ? '?after=' + after : ''),
        { headers: headers(cookie), origin }
      )
      sockets.add(ws)
      ws.on('message', (data) => events.push(JSON.parse(data.toString())))
      return { ws, events }
    }
    async function until(fn: () => boolean) {
      for (let i = 0; i < 80; i++) {
        if (fn()) return
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      assert.fail('Timed out waiting for event')
    }
    const watchB = watch(b.cookie),
      watchC = watch(c.cookie)
    await until(() => watchB.events.length > 0 && watchC.events.length > 0)
    const uid = randomUUID()
    const post = async (text: string, options: Record<string, unknown> = {}, cookie = a) =>
      (
        await request(room + '/messages', 'POST', { text, clientMessageId: randomUUID(), ...options }, cookie)
      ).json()
    const old = await post('之前的私密讨论', { clientMessageId: uid })
    assert.deepEqual(await post('之前的私密讨论', { clientMessageId: uid }), old)
    await until(() => watchB.events.some((e) => e.data.messageId === old.id))
    assert(!watchC.events.some((e) => e.conversation_id === id))
    await request(room + '/read', 'POST', { seq: old.seq }, b.cookie)
    assert.equal(
      (await request('/conversations', 'GET', undefined, b.cookie))
        .json()
        .find((x: { id: string }) => x.id === id).unread,
      0
    )
    const form = new FormData()
    form.set('file', new Blob(['内容'], { type: 'text/plain' }), '报告.txt')
    const upload = await fetch(address + base + room + '/files', {
      method: 'POST',
      headers: headers(a),
      body: form,
    })
    assert.equal(upload.status, 200, await upload.clone().text())
    const file = await upload.json()
    await request('/files/' + file.id, 'GET', undefined, b.cookie, 404)
    const withFile = await post('', { attachments: [file.id] })
    await request('/files/' + file.id, 'GET', undefined, b.cookie)
    await request('/files/' + file.id, 'GET', undefined, c.cookie, 404)
    assert.equal(
      (await request('/search?q=' + encodeURIComponent('报告'), 'GET', undefined, b.cookie)).json()[0].id,
      withFile.id
    )
    assert.equal(
      (await request('/search?q=' + encodeURIComponent('讨论'), 'GET', undefined, c.cookie)).json().length,
      0
    )
    await request(room, 'PATCH', { routing: true }, a, 409)
    const agent = (
      await request(
        '/admin/agents',
        'POST',
        { name: '研发助手', description: '研究', instructions: 'Help', model: 'mock', tools: true },
        a
      )
    ).json().id
    await request(room, 'PATCH', { addAgents: [agent] }, b.cookie, 403)
    await request(room, 'PATCH', { addAgents: [agent] }, a)
    const claim = async () => (await request('/runner/claim', 'POST', {}, 'runner')).json() as RunInput | null
    await post('普通闲聊')
    assert.equal(await claim(), null)
    const source = await post('@研发助手 查看', { mentions: [agent], replyId: withFile.id })
    const run = (await claim())!
    assert.equal(run.kind, 'agent')
    assert(!run.prompt.includes('之前的私密讨论'))
    assert.equal(run.files[0].id, file.id)
    const update = (r: RunInput, position: number, update: unknown, status = 200) =>
      request('/runner/' + r.id + '/events', 'POST', { lease: r.lease, position, update }, 'runner', status)
    await update(run, 1, { type: 'delta', text: '正在查看' })
    await update(run, 1, { type: 'delta', text: '正在查看' })
    await update(run, 3, { type: 'delta', text: '顺序错误' }, 409)
    const approvalId = randomUUID()
    await update(run, 2, { type: 'approval', id: approvalId, label: '分享文件' })
    await request('/runs/' + run.id + '/action', 'POST', { action: 'allow', approvalId }, b.cookie, 403)
    await request('/runs/' + run.id + '/action', 'POST', { action: 'allow', approvalId }, a)
    await request('/runs/' + run.id + '/action', 'POST', { action: 'allow', approvalId }, a, 409)
    assert.equal(
      (await request('/runner/' + run.id + '/heartbeat', 'POST', { lease: run.lease }, 'runner')).json()
        .decision,
      'allow'
    )
    await post('Agent 执行期间正常聊天', {}, b.cookie)
    const generated = new FormData()
    generated.set('file', new Blob(['result']), 'result.txt')
    const output = await fetch(address + base + '/runner/' + run.id + '/files?lease=' + run.lease, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + runnerSecret },
      body: generated,
    })
    assert.equal(output.status, 200, await output.clone().text())
    await update(run, 3, { type: 'complete' })
    const transcript = (await request(room + '/messages', 'GET', undefined, b.cookie)).json()
    const answer = transcript.find((m: { reply_id: string }) => m.reply_id === source.id)
    assert.equal(answer.text, '正在查看')
    assert.equal(answer.attachments[0].name, 'result.txt')
    assert.equal(answer.status, 'complete')
    assert.equal(
      (await request(room + '/message-updates?ids=' + answer.id, 'GET', undefined, b.cookie)).json()[0].status,
      'complete'
    )
    await request('/admin/settings', 'PUT', { routerModel: 'fast' }, a)
    await request(room, 'PATCH', { routing: true }, a)
    await post('需要协助的新问题')
    const route = (await claim())!
    assert.equal(route.kind, 'route')
    assert(!route.prompt.includes('之前的私密讨论'))
    await update(route, 1, { type: 'complete', target: agent })
    const routed = (await claim())!
    assert.equal(routed.kind, 'agent')
    await request(room, 'PATCH', { removeAgents: [agent], removeUsers: [b.id] }, a)
    await update(routed, 1, { type: 'delta', text: '应被拒绝' }, 409)
    await until(() => watchB.events.some((e) => e.kind === 'conversation.removed'))
    await request(room + '/messages', 'GET', undefined, b.cookie, 404)
    await request(room + '/message-updates?ids=' + answer.id, 'GET', undefined, b.cookie, 404)
    await request('/files/' + file.id, 'GET', undefined, b.cookie, 404)
    assert.equal(await claim(), null)

    const watchers = Array.from({ length: 100 }, () => watch(a))
    await until(() => watchers.every((w) => w.events[0]?.kind === 'ready'))
    const last = await post('100 个实时连接')
    await until(() => watchers.every((w) => w.events.some((e) => e.data.messageId === last.id)))
    const cursor = watchers[0].events.at(-1)!.id
    watchers.forEach((w) => w.ws.terminate())
    const missed = await post('断线补取')
    const reconnected = watch(a, cursor)
    await until(() => reconnected.events.some((e) => e.data.messageId === missed.id))
    if (process.env.IM_TEST_MODEL_URL && process.env.IM_TEST_WORKER_IMAGE) {
      const helper = (
        await request(
          '/admin/agents',
          'POST',
          {
            name: '实际 DSH 助手',
            description: '对话',
            instructions: 'Answer briefly.',
            model: 'deepseek-official/deepseek-flash',
          },
          a
        )
      ).json().id
      const group = (
        await request(
          '/conversations',
          'POST',
          { kind: 'group', name: 'DSH 完整流程', users: [b.id], agents: [helper] },
          a
        )
      ).json().id
      const binding = (await db.query('SELECT id FROM bindings WHERE conversation_id=$1', [group])).rows[0].id
      const child = spawn(process.execPath, [fileURLToPath(new URL('../runner/main.ts', import.meta.url))], {
        env: {
          ...process.env,
          IM_SERVER_URL: address,
          IM_RUNNER_SECRET: runnerSecret,
          IM_WORKER_IMAGE: process.env.IM_TEST_WORKER_IMAGE,
          DEEPSEEK_API_KEY: 'mock-key',
          DEEPSEEK_BASE_URL: process.env.IM_TEST_MODEL_URL,
        },
        stdio: 'ignore',
      })
      const stopped = once(child, 'close')
      try {
        await request(
          '/conversations/' + group + '/messages',
          'POST',
          { text: '请回答 DSH 团队测试', mentions: [helper], clientMessageId: randomUUID() },
          a
        )
        await request(
          '/conversations/' + group + '/messages',
          'POST',
          { text: '任务执行时也能聊天', clientMessageId: randomUUID() },
          b.cookie
        )
        let answer
        for (let i = 0; i < 150; i++) {
          answer = (await request('/conversations/' + group + '/messages', 'GET', undefined, b.cookie))
            .json()
            .find((m: { agent_id?: string }) => m.agent_id === helper)
          if (answer && ['complete', 'failed'].includes(answer.status)) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(answer?.status, 'complete')
        assert(answer?.text)
      } finally {
        child.kill('SIGTERM')
        await stopped
        await promisify(execFile)('docker', ['volume', 'rm', 'dsbot-team-binding-' + binding]).catch(() => {})
      }
    }
    const localBot = { id: 'native-bot', name: '本机 Agent' }
    await request('/personal/agents', 'POST', localBot, b.cookie, 403)
    const registered = (await request('/personal/agents', 'POST', localBot, a)).json().id
    assert.equal((await request('/me', 'GET', undefined, b.cookie)).json().personalWorkspace, null)
    assert(!(await request('/agents', 'GET', undefined, b.cookie)).json().some((agent: { id: string }) => agent.id === registered))
    await request('/conversations', 'POST', { kind: 'group', name: '不可邀请他人的 Agent', agents: [registered] }, b.cookie, 400)
    const personalRoom = '/conversations/' + (await request('/conversations', 'POST',
      { kind: 'group', name: '本机协作', users: [b.id], agents: [registered] }, a)).json().id
    await request(personalRoom + '/messages', 'POST',
      { text: '群消息交给本机 Agent', mentions: [registered], clientMessageId: randomUUID() }, b.cookie)
    const native = (await request('/personal/runs/claim', 'POST', {}, a)).json()
    assert.equal(native.localBotId, localBot.id)
    assert.equal(native.location, 'personal')
    const action = '/runs/' + native.id + '/action'
    const reply = '/personal/runs/' + native.id + '/events'
    const delta = { lease: native.lease, position: 1, update: { type: 'delta', text: '本机 Agent 群回复' } }
    await request('/runner/' + native.id + '/events', 'POST', delta, 'runner', 403)
    await request(reply, 'POST', delta, a, 409)
    await request(action, 'POST', { action: 'allow', approvalId: native.approvalId }, b.cookie, 403)
    await request(action, 'POST', { action: 'allow', approvalId: native.approvalId }, a)
    await request(reply, 'POST', delta, a)
    await request(reply, 'POST', { ...delta, position: 2, update: { type: 'complete' } }, a)
    assert((await request(personalRoom + '/messages', 'GET', undefined, b.cookie)).json()
      .some((message: { agent_id: string; text: string }) => message.agent_id === registered && message.text === delta.update.text))
    await verifyClient(origin, pass)
    for (const ws of sockets) ws.terminate()
    await app.close()
    app = await build({
      databaseUrl: url.href, origin, storage, runnerSecret,
      personalWorkspace: 'http://127.0.0.1:3081', personalWorkspaceOwner: 'alice',
    })
    assert(
      (await request(room + '/messages', 'GET', undefined, a))
        .json()
        .some((m: { id: string }) => m.id === missed.id)
    )
  }
)
