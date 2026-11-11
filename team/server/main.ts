import Fastify, { LogController } from 'fastify'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'
import serveStatic from '@fastify/static'
import argon2 from 'argon2'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prefix, uuid } from '../shared/protocol.ts'
import { database, event, migrate, write } from './db.ts'
import {
  cookie,
  createUser,
  digest,
  fail,
  hashPassword,
  name,
  password,
  runnerAuth,
  token,
  userOf,
  username,
} from './auth.ts'
import { cancelRuns, member, rooms } from './rooms.ts'
import { finish, leased, runs } from './runs.ts'
import type { FastifyReply, FastifyRequest } from 'fastify'

export async function build(options: {
  databaseUrl?: string
  origin: string
  storage: string
  runnerSecret?: string
  log?: boolean
  uploadLimit?: number
  personalWorkspace?: string
  personalWorkspaceOwner?: string
}) {
  const origin = new URL(options.origin).origin
  const secure = origin.startsWith('https:')
  const personal = options.personalWorkspace
  if (personal) {
    const url = new URL(personal)
    const loopback = ['127.0.0.1', 'localhost', '[::1]']
    if (!options.personalWorkspaceOwner || secure || url.protocol !== 'http:' || url.origin !== personal || personal === origin
      || !loopback.includes(url.hostname) || !loopback.includes(new URL(origin).hostname))
      throw new Error('Personal workspace requires a named IM account and two distinct loopback HTTP origins')
  }
  if (!secure && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
    throw new Error('Team server origin must use HTTPS')
  const db = database(options.databaseUrl)
  const storage = resolve(options.storage)
  await mkdir(storage, { recursive: true, mode: 0o700 })
  try {
    await migrate(db)
  } catch (error) {
    await db.end()
    throw error
  }
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.log ? { redact: ['req.headers', 'req.body'] } : false,
    bodyLimit: 256_000,
  })
  await app.register(websocket, { options: { maxPayload: 1024 } })
  const maxSize = options.uploadLimit ?? 50 * 1024 * 1024
  await app.register(multipart, { limits: { files: 1, fileSize: maxSize, fields: 0, parts: 1 } })
  app.addHook('onClose', async () => db.end())
  app.addHook('onRequest', async (req, reply) => {
    reply.headers({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    })
    const native = Boolean(personal && req.headers.origin === personal && req.url.startsWith(prefix + '/'))
    if (req.headers.origin && req.headers.origin !== origin && !native) fail(403, 'Origin not allowed')
    if (native) reply.headers({
      'access-control-allow-origin': personal!,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    })
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.url.startsWith(prefix))
      fail(403, 'Cross-site request denied')
  })
  app.options(prefix + '/*', async (req, reply) => {
    if (!personal || req.headers.origin !== personal) fail(403, 'Origin not allowed')
    return reply.headers({
      'access-control-allow-methods': 'GET, POST, PUT, PATCH',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': '600',
    }).code(204).send()
  })
  app.setErrorHandler((error, req, reply) => {
    const err = error as { statusCode?: number; code?: string; message: string }
    const status = error instanceof z.ZodError ? 400 : err.code === '23505' ? 409 : (err.statusCode ?? 500)
    if (status >= 500) req.log.error({ requestId: req.id, code: err.code }, 'IM request failed')
    void reply
      .code(status)
      .send({
        error:
          status >= 500
            ? 'Internal error'
            : error instanceof z.ZodError
              ? 'Invalid request'
              : err.code === '23505'
                ? 'Already exists'
                : err.message,
      })
  })
  const auth = async (req: FastifyRequest) => {
    const user = await userOf(db, req)
    if (!user) fail(401, 'Sign in required')
    return user
  }
  const admin = async (req: FastifyRequest) => {
    const user = await auth(req)
    if (!user.admin) fail(403, 'Administrator required')
    return user
  }
  const lifetime = 7 * 86400
  async function signIn(id: string, reply: FastifyReply) {
    const key = token()
    await db.query(
      "INSERT INTO login_sessions(token,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [digest(key), id]
    )
    reply.header('set-cookie', cookie(key, secure, lifetime))
  }
  const attempts = new Map<string, { count: number; until: number }>()
  const limited = (req: FastifyRequest) => {
    const now = Date.now()
    if (attempts.size > 1000) for (const [key, item] of attempts) if (item.until < now) attempts.delete(key)
    const prior = attempts.get(req.ip)
    if (!prior || prior.until < now) attempts.set(req.ip, { count: 1, until: now + 60_000 })
    else if (++prior.count > 15) fail(429, 'Try again in a minute')
  }
  const dummy = await hashPassword(token())
  app.post(prefix + '/login', async (req, reply) => {
    limited(req)
    const body = z.object({ username, password: z.string().max(128) }).parse(req.body)
    const {
      rows: [user],
    } = await db.query('SELECT id,username,name,admin,password FROM users WHERE username=$1 AND active', [
      body.username,
    ])
    if (!(await argon2.verify(user?.password ?? dummy, body.password)) || !user)
      fail(401, 'Invalid credentials')
    await signIn(user.id, reply)
    return { id: user.id, username: user.username, name: user.name, admin: user.admin }
  })
  app.post(prefix + '/logout', async (req, reply) => {
    const value = req.headers.cookie?.match(/(?:^|;\s*)im_session=([\w-]{43})/)?.[1]
    if (value) await db.query('DELETE FROM login_sessions WHERE token=$1', [digest(value)])
    reply.header('set-cookie', cookie('', secure, 0))
    return { ok: true }
  })
  const hasWorkspace = (user: { username: string }) => Boolean(personal && user.username === options.personalWorkspaceOwner)
  app.get(prefix + '/me', async (req) => {
    const user = await auth(req)
    return { ...user, personalWorkspace: hasWorkspace(user) ? personal : null }
  })
  app.post(prefix + '/personal/agents', async (req) => {
    const user = await auth(req)
    if (!hasWorkspace(user)) fail(403, 'Personal workspace unavailable')
    const bot = z.object({ id: z.string().regex(/^[\w-]{1,160}$/), name }).parse(req.body)
    return write(db, async (tx) => {
      const { rows: [row] } = await tx.query(
        `INSERT INTO agents(id,name,description,instructions,model,personal_owner,local_bot_id)
         VALUES($1,$2,'个人 Agent','','',$3,$4)
         ON CONFLICT(personal_owner,local_bot_id) DO UPDATE SET name=excluded.name RETURNING id`,
        [randomUUID(), bot.name, user.id, bot.id]
      )
      await event(tx, 'directory.updated', null, {}, user.id)
      return row
    })
  })
  app.get(prefix + '/people', async (req) => {
    const user = await auth(req)
    return (
      await db.query(
        "SELECT id,username,name,admin,active,'user' kind FROM users WHERE active OR $1 ORDER BY name,id",
        [user.admin]
      )
    ).rows
  })
  app.post(prefix + '/admin/invitations', async (req) => {
    await admin(req)
    const { resetUser } = z.object({ resetUser: uuid.optional() }).parse(req.body ?? {})
    const key = token()
    await write(db, async (tx) => {
      if (resetUser) {
        if (!(await tx.query('SELECT 1 FROM users WHERE id=$1 AND active', [resetUser])).rowCount)
          fail(404, 'Member unavailable')
        await tx.query('DELETE FROM invitations WHERE reset_user=$1', [resetUser])
      }
      await tx.query(
        "INSERT INTO invitations(token,expires_at,reset_user) VALUES($1,now()+interval '24 hours',$2)",
        [digest(key), resetUser]
      )
    })
    return { url: origin + '/#' + (resetUser ? 'reset=' : 'invite=') + key }
  })
  app.post(prefix + '/accept', async (req, reply) => {
    limited(req)
    const body = z
      .object({
        token: z.string().regex(/^[\w-]{43}$/),
        username: username.optional(),
        name: name.optional(),
        password,
      })
      .parse(req.body)
    const hashed = await hashPassword(body.password)
    const id = await write(db, async (tx) => {
      const {
        rows: [invite],
      } = await tx.query('DELETE FROM invitations WHERE token=$1 AND expires_at>now() RETURNING reset_user', [
        digest(body.token),
      ])
      if (!invite) fail(400, 'Invitation expired or used')
      if (invite.reset_user) {
        if (
          !(
            await tx.query('UPDATE users SET password=$2 WHERE id=$1 AND active', [invite.reset_user, hashed])
          ).rowCount
        )
          fail(404, 'Member unavailable')
        await tx.query('DELETE FROM login_sessions WHERE user_id=$1', [invite.reset_user])
        return invite.reset_user
      }
      if (!body.username || !body.name) fail(400, 'Username and display name required')
      const uid = await createUser(tx, { username: body.username, name: body.name, password: hashed })
      await event(tx, 'directory.updated', null)
      return uid
    })
    await signIn(id, reply)
    return { ok: true }
  })
  app.patch(prefix + '/admin/users/:id', async (req) => {
    const operator = await admin(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { active } = z.object({ active: z.boolean() }).parse(req.body)
    if (id === operator.id && !active) fail(400, 'Cannot disable your own account')
    return write(db, async (tx) => {
      if (
        !active &&
        (await tx.query("SELECT 1 FROM conversations WHERE owner_id=$1 AND kind='group'", [id])).rowCount
      )
        fail(409, 'Transfer group ownership first')
      if (!(await tx.query('UPDATE users SET active=$2 WHERE id=$1', [id, active])).rowCount)
        fail(404, 'Member unavailable')
      if (!active) {
        await tx.query('DELETE FROM login_sessions WHERE user_id=$1', [id])
        await tx.query('DELETE FROM invitations WHERE reset_user=$1', [id])
        const { rows } = await tx.query(
          "SELECT r.* FROM runs r JOIN messages m ON m.id=r.source_id WHERE m.user_id=$1 AND r.status IN ('queued','running','approval')",
          [id]
        )
        for (const run of rows) await finish(tx, run, 'cancelled', 'Account disabled')
      }
      await event(tx, 'directory.updated', null)
      return { ok: true }
    })
  })
  app.get(prefix + '/agents', async (req) => {
    const user = await auth(req)
    return (
      await db.query(
        `SELECT id,name,description,active,'agent' kind,personal_owner IS NOT NULL personal,
        CASE WHEN personal_owner=$2 THEN local_bot_id END local_bot_id ${user.admin ? ',model,tools,instructions' : ''}
      FROM agents WHERE (personal_owner IS NULL AND (active OR $1)) OR (personal_owner=$2 AND active) ORDER BY name,id`,
        [user.admin, user.id]
      )
    ).rows
  })
  const agentInput = z.object({
    name,
    description: z.string().trim().max(500),
    instructions: z.string().max(12000),
    model: z.string().trim().min(1).max(200),
    tools: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  async function saveAgent(req: FastifyRequest, id: string) {
    await admin(req)
    const body = agentInput.parse(req.body)
    return write(db, async (tx) => {
      const result = await tx.query(
        `INSERT INTO agents(id,name,description,instructions,model,tools,active) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET name=$2,description=$3,instructions=$4,model=$5,tools=$6,active=$7 WHERE agents.personal_owner IS NULL`,
        [id, body.name, body.description, body.instructions, body.model, body.tools, body.active]
      )
      if (!result.rowCount) fail(404, 'Server Agent unavailable')
      if (!body.active) {
        const { rows } = await tx.query(
          'UPDATE bindings SET active=false WHERE agent_id=$1 AND active RETURNING id,conversation_id',
          [id]
        )
        for (const b of rows) {
          await cancelRuns(tx, 'binding_id', b.id)
          await event(tx, 'conversation.updated', b.conversation_id)
        }
      }
      await event(tx, 'directory.updated', null)
      return { id }
    })
  }
  app.post(prefix + '/admin/agents', (req) => saveAgent(req, randomUUID()))
  app.put(prefix + '/admin/agents/:id', (req) => saveAgent(req, z.object({ id: uuid }).parse(req.params).id))
  app.get(prefix + '/admin/settings', async (req) => {
    await admin(req)
    return {
      routerModel:
        (await db.query("SELECT value FROM settings WHERE key='routerModel'")).rows[0]?.value ?? '',
    }
  })
  app.put(prefix + '/admin/settings', async (req) => {
    await admin(req)
    const { routerModel } = z.object({ routerModel: z.string().trim().max(200) }).parse(req.body)
    return write(db, async (tx) => {
      await tx.query(
        "INSERT INTO settings(key,value) VALUES('routerModel',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
        [routerModel]
      )
      if (!routerModel) {
        const { rows } = await tx.query(
          'UPDATE conversations SET router_since=NULL WHERE router_since IS NOT NULL RETURNING id'
        )
        for (const row of rows) await event(tx, 'conversation.updated', row.id)
      }
      return { ok: true }
    })
  })
  rooms(app, db, auth)
  runs(app, db, auth, options.runnerSecret, hasWorkspace)
  const raster = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  async function storeFile(req: FastifyRequest, id: string) {
    const upload = await req.file()
    if (!upload) fail(400, 'Choose a file')
    try {
      await pipeline(upload.file, createWriteStream(resolve(storage, id), { flags: 'wx', mode: 0o600 }))
      if (upload.file.truncated) fail(413, 'File too large')
      const file = {
        id,
        name:
          basename(upload.filename.replaceAll('\\', '/'))
            .replace(/[\x00-\x1f\x7f]/g, '')
            .slice(0, 240) || 'file',
        media_type: raster.has(upload.mimetype) ? upload.mimetype : 'application/octet-stream',
        size: (await stat(resolve(storage, id))).size,
      }
      return file
    } catch (error) {
      await unlink(resolve(storage, id)).catch(() => {})
      throw error
    }
  }
  app.post(prefix + '/conversations/:id/files', async (req) => {
    const user = await auth(req),
      { id } = z.object({ id: uuid }).parse(req.params)
    await member(db, id, user.id)
    const file = await storeFile(req, randomUUID())
    try {
      return await write(db, async (tx) => {
        await member(tx, id, user.id)
        await tx.query(
          'INSERT INTO attachments(id,conversation_id,uploader_id,name,media_type,size) VALUES($1,$2,$3,$4,$5,$6)',
          [file.id, id, user.id, file.name, file.media_type, file.size]
        )
        return file
      })
    } catch (error) {
      await unlink(resolve(storage, file.id)).catch(() => {})
      throw error
    }
  })
  app.get(prefix + '/files/:id', async (req, reply) => {
    const user = await auth(req),
      { id } = z.object({ id: uuid }).parse(req.params)
    const {
      rows: [f],
    } = await db.query(
      `SELECT f.* FROM attachments f JOIN members m ON m.conversation_id=f.conversation_id
      WHERE f.id=$1 AND m.user_id=$2 AND (f.message_id IS NOT NULL OR f.uploader_id=$2)`,
      [id, user.id]
    )
    if (!f) fail(404, 'File unavailable')
    return reply
      .type(f.media_type)
      .header(
        'content-disposition',
        `${raster.has(f.media_type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name).replace(/'/g, '%27')}`
      )
      .send(createReadStream(resolve(storage, id)))
  })
  app.get(prefix + '/runner/:id/files/:file', async (req, reply) => {
    runnerAuth(req, options.runnerSecret)
    const { id, file } = z.object({ id: uuid, file: uuid }).parse(req.params)
    const { lease } = z.object({ lease: uuid }).parse(req.query)
    const run = await leased(db, id, lease)
    if (
      run.kind !== 'agent' || run.personal_owner ||
      !(
        await db.query(
          `SELECT 1 FROM attachments f JOIN messages s ON s.id=$2
      WHERE f.id=$1 AND f.conversation_id=s.conversation_id AND f.message_id IN (s.id,s.reply_id)`,
          [file, run.source_id]
        )
      ).rowCount
    )
      fail(404, 'File unavailable')
    return reply.type('application/octet-stream').send(createReadStream(resolve(storage, file)))
  })
  app.post(prefix + '/runner/:id/files', async (req) => {
    runnerAuth(req, options.runnerSecret)
    const { id } = z.object({ id: uuid }).parse(req.params),
      { lease } = z.object({ lease: uuid }).parse(req.query)
    const current = await leased(db, id, lease)
    if (current.kind !== 'agent' || current.personal_owner) fail(403, 'File output unavailable')
    const file = await storeFile(req, randomUUID())
    try {
      return await write(db, async (tx) => {
        const r = await leased(tx, id, lease)
        await tx.query(
          'INSERT INTO attachments(id,conversation_id,message_id,name,media_type,size) VALUES($1,$2,$3,$4,$5,$6)',
          [file.id, r.conversation_id, r.reply_id, file.name, file.media_type, file.size]
        )
        await event(tx, 'message.updated', r.conversation_id, { messageId: r.reply_id })
        return file
      })
    } catch (error) {
      await unlink(resolve(storage, file.id)).catch(() => {})
      throw error
    }
  })
  app.get(prefix + '/events', { websocket: true }, (socket, req) => {
    let cursor = '0',
      busy = false
    const parsed = z
      .object({
        after: z
          .string()
          .regex(/^\d{1,18}$/)
          .optional(),
      })
      .safeParse(req.query)
    if (!parsed.success) {
      socket.close(1008)
      return
    }
    let initial = true
    const poll = async () => {
      if (busy || socket.readyState !== 1) return
      busy = true
      try {
        const user = await userOf(db, req)
        if (!user) {
          socket.close(1008, 'Sign in required')
          return
        }
        if (initial) {
          cursor =
            parsed.data.after ?? (await db.query('SELECT coalesce(max(id),0) id FROM events')).rows[0].id
          socket.send(JSON.stringify({ kind: 'ready', id: cursor, conversation_id: null, data: {} }))
          initial = false
        }
        if (socket.bufferedAmount > 1_000_000) {
          socket.close(1013)
          return
        }
        const { rows } = await db.query(
          `SELECT e.id,e.conversation_id,e.kind,e.data FROM events e WHERE e.id>$1 AND
          ((e.user_id=$2 AND e.kind='conversation.removed') OR ((e.user_id IS NULL OR e.user_id=$2)
            AND (e.conversation_id IS NULL OR EXISTS(SELECT 1 FROM members m WHERE m.conversation_id=e.conversation_id AND m.user_id=$2))))
          ORDER BY e.id LIMIT 100`,
          [cursor, user.id]
        )
        for (const row of rows) {
          if (socket.readyState !== 1) break
          socket.send(JSON.stringify(row))
          cursor = row.id
        }
      } catch {
        socket.close(1011)
      } finally {
        busy = false
      }
    }
    const timer = setInterval(() => void poll(), 350)
    socket.once('close', () => clearInterval(timer))
    socket.on('error', () => socket.terminate())
    void poll()
  })
  app.get('/healthz', async () => ({ ok: true }))
  app.get('/readyz', async () => {
    await db.query('SELECT 1')
    return { ok: true }
  })
  app.get(prefix + '/admin/health', async (req) => {
    await admin(req)
    return (
      await db.query(`SELECT count(*) FILTER(WHERE status='queued')::int queued,
      count(*) FILTER(WHERE status IN ('running','approval') AND lease_until>now())::int running,
      count(*) FILTER(WHERE status='failed')::int failed,
      max(extract(epoch FROM (now()-created_at))) FILTER(WHERE status='queued') oldestQueuedSeconds FROM runs`)
    ).rows[0]
  })
  const dist = fileURLToPath(new URL('../dist/', import.meta.url))
  if (existsSync(dist)) await app.register(serveStatic, { root: dist })
  return app
}

if (import.meta.main) {
  const app = await build({
    origin: process.env.IM_ORIGIN ?? 'http://127.0.0.1:3090',
    storage: process.env.IM_STORAGE ?? 'data/files',
    runnerSecret: process.env.IM_RUNNER_SECRET,
    log: true,
    personalWorkspace: process.env.IM_PERSONAL_WORKSPACE_ORIGIN,
    personalWorkspaceOwner: process.env.IM_PERSONAL_WORKSPACE_OWNER,
    uploadLimit: process.env.IM_UPLOAD_LIMIT
      ? z.coerce.number().int().min(1).max(500_000_000).parse(process.env.IM_UPLOAD_LIMIT)
      : undefined,
  })
  await app.listen({ host: process.env.IM_HOST ?? '127.0.0.1', port: Number(process.env.IM_PORT ?? 3090) })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void app.close())
}
