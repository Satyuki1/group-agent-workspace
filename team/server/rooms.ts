import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DB, Tx } from './db.ts'
import { event, message, write } from './db.ts'
import { fail, name } from './auth.ts'
import type { User } from './auth.ts'
import { prefix, uuid } from '../shared/protocol.ts'

type Query = Pick<DB, 'query'> | Pick<Tx, 'query'>
export async function member(db: Query, conv: string, user: string, owner = false) {
  const { rows } = await db.query(
    `SELECT c.* FROM conversations c JOIN members m ON c.id=m.conversation_id
    JOIN users u ON u.id=m.user_id AND u.active WHERE c.id=$1 AND m.user_id=$2`,
    [conv, user]
  )
  if (!rows[0]) fail(404, 'Conversation unavailable')
  if (owner && (rows[0].owner_id !== user || rows[0].kind !== 'group')) fail(403, 'Group owner required')
  return rows[0]
}
export async function cancelRuns(tx: Tx, clause: 'binding_id' | 'source_id', id: string) {
  const { rows } = await tx.query(
    `UPDATE runs SET status='cancelled',outcome='cancelled' WHERE ${clause}=$1
    AND status IN ('queued','running','approval') RETURNING id,reply_id,conversation_id`,
    [id]
  )
  for (const row of rows) {
    if (row.reply_id) await tx.query("UPDATE messages SET status='cancelled' WHERE id=$1", [row.reply_id])
    await event(tx, 'run.updated', row.conversation_id, { runId: row.id, messageId: row.reply_id })
  }
}
export async function enqueue(tx: Tx, conv: string, source: string, binding?: string) {
  await tx.query(
    `INSERT INTO runs(id,conversation_id,source_id,binding_id,kind)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [randomUUID(), conv, source, binding, binding ? 'agent' : 'route']
  )
}

const roomId = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id
const ids = z.array(uuid).max(100).default([])
const projection = `SELECT m.id,m.conversation_id,m.seq,m.user_id,m.agent_id,m.text,m.status,m.reply_id,m.created_at,
  coalesce(u.name,a.name) sender, left(q.text,240) quote,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'media_type',f.media_type,'size',f.size))
            FROM attachments f WHERE f.message_id=m.id),'[]'::jsonb) attachments
  FROM messages m LEFT JOIN users u ON m.user_id=u.id LEFT JOIN agents a ON m.agent_id=a.id
  LEFT JOIN messages q ON q.id=m.reply_id`

export function rooms(app: FastifyInstance, db: DB, auth: (req: FastifyRequest) => Promise<User>) {
  const route = prefix + '/conversations'
  app.get(route, async (req) => {
    const user = await auth(req)
    return (
      await db.query(
        `SELECT c.id,c.kind,c.owner_id,c.updated_at,m.read_seq,c.router_since IS NOT NULL AS routing,
      CASE WHEN c.kind='dm' THEN coalesce((SELECT u.name FROM members mm JOIN users u ON u.id=mm.user_id
        WHERE mm.conversation_id=c.id AND mm.user_id<>m.user_id LIMIT 1),c.name) ELSE c.name END name,
      (SELECT text FROM messages WHERE conversation_id=c.id ORDER BY seq DESC LIMIT 1) preview,
      (SELECT count(*)::int FROM messages WHERE conversation_id=c.id AND seq>m.read_seq AND user_id IS DISTINCT FROM m.user_id) unread
      FROM members m JOIN conversations c ON c.id=m.conversation_id WHERE m.user_id=$1 ORDER BY c.updated_at DESC`,
        [user.id]
      )
    ).rows
  })
  app.post(route, async (req) => {
    const user = await auth(req)
    const body = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('group'), name, users: ids, agents: ids }),
        z.object({ kind: z.literal('dm'), target: uuid }),
        z.object({ kind: z.literal('agent'), target: uuid }),
      ])
      .parse(req.body)
    return write(db, async (tx) => {
      const id = randomUUID()
      let title = body.kind === 'group' ? body.name : '私聊'
      let key: string | undefined
      const users = new Set([user.id])
      const agents = new Set<string>()
      if (body.kind === 'group') {
        body.users.forEach((id) => users.add(id))
        body.agents.forEach((id) => agents.add(id))
      } else {
        if (body.target === user.id) fail(400, 'Choose another member')
        if (body.kind === 'dm') users.add(body.target)
        else {
          agents.add(body.target)
          title = (await tx.query('SELECT name FROM agents WHERE id=$1 AND active AND personal_owner IS NULL', [body.target])).rows[0]
            ?.name
          if (!title) fail(404, 'Agent unavailable')
        }
        key = body.kind + ':' + [...users, ...agents].sort().join(':')
      }
      const existing =
        key && (await tx.query('SELECT id FROM conversations WHERE direct_key=$1', [key])).rows[0]
      if (existing) {
        if (body.kind === 'agent') {
          const conversation = await member(tx, existing.id, user.id)
          await tx.query(
            'INSERT INTO bindings(id,conversation_id,agent_id,joined_seq) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [randomUUID(), existing.id, body.target, conversation.next_seq]
          )
        }
        return existing
      }
      if (
        (await tx.query('SELECT id FROM users WHERE active AND id=ANY($1::uuid[])', [[...users]]))
          .rowCount !== users.size
      )
        fail(400, 'Invalid member')
      if (
        (await tx.query('SELECT id FROM agents WHERE active AND id=ANY($1::uuid[]) AND (personal_owner IS NULL OR personal_owner=$2)', [[...agents], user.id]))
          .rowCount !== agents.size
      )
        fail(400, 'Invalid Agent')
      await tx.query('INSERT INTO conversations(id,kind,name,owner_id,direct_key) VALUES($1,$2,$3,$4,$5)', [
        id,
        body.kind,
        title,
        user.id,
        key,
      ])
      for (const uid of users)
        await tx.query('INSERT INTO members(conversation_id,user_id) VALUES($1,$2)', [id, uid])
      for (const aid of agents)
        await tx.query('INSERT INTO bindings(id,conversation_id,agent_id,joined_seq) VALUES($1,$2,$3,0)', [
          randomUUID(),
          id,
          aid,
        ])
      await event(tx, 'conversation.updated', id)
      return { id }
    })
  })
  app.get(route + '/:id/members', async (req) => {
    const user = await auth(req),
      id = roomId(req)
    return write(db, async (tx) => {
      await member(tx, id, user.id)
      return (
        await tx.query(
          `SELECT u.id,u.name,'user' kind,u.active,false personal FROM members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1
        UNION ALL SELECT a.id,a.name,'agent' kind,a.active,a.personal_owner IS NOT NULL personal FROM bindings b JOIN agents a ON a.id=b.agent_id WHERE b.conversation_id=$1 AND b.active`,
          [id]
        )
      ).rows
    })
  })
  app.patch(route + '/:id', async (req) => {
    const user = await auth(req),
      id = roomId(req)
    const body = z
      .object({
        name: name.optional(),
        owner: uuid.optional(),
        routing: z.boolean().optional(),
        addUsers: ids,
        removeUsers: ids,
        addAgents: ids,
        removeAgents: ids,
      })
      .parse(req.body)
    return write(db, async (tx) => {
      const room = await member(tx, id, user.id, true)
      if (
        body.routing &&
        !(await tx.query("SELECT 1 FROM settings WHERE key='routerModel' AND value<>''")).rowCount
      )
        fail(409, 'Configure a router model first')
      for (const uid of new Set(body.addUsers)) {
        if (!(await tx.query('SELECT 1 FROM users WHERE id=$1 AND active', [uid])).rowCount)
          fail(404, 'Member unavailable')
        await tx.query('INSERT INTO members(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
          id,
          uid,
        ])
      }
      if (body.owner) await member(tx, id, body.owner)
      const owner = body.owner ?? user.id
      if (body.removeUsers.includes(owner)) fail(400, 'Transfer ownership before removing the owner')
      for (const uid of new Set(body.removeUsers)) {
        if (
          (await tx.query('DELETE FROM members WHERE conversation_id=$1 AND user_id=$2', [id, uid])).rowCount
        ) {
          const { rows: personal } = await tx.query(
            `UPDATE bindings b SET active=false FROM agents a
            WHERE b.agent_id=a.id AND a.personal_owner=$2 AND b.conversation_id=$1 AND b.active RETURNING b.id`, [id, uid]
          )
          for (const binding of personal) await cancelRuns(tx, 'binding_id', binding.id)
          await event(tx, 'conversation.removed', id, {}, uid)
          const { rows } = await tx.query('SELECT id FROM messages WHERE conversation_id=$1 AND user_id=$2', [
            id,
            uid,
          ])
          for (const m of rows) await cancelRuns(tx, 'source_id', m.id)
        }
      }
      for (const aid of new Set(body.removeAgents)) {
        const { rows } = await tx.query(
          'UPDATE bindings SET active=false WHERE conversation_id=$1 AND agent_id=$2 AND active RETURNING id',
          [id, aid]
        )
        for (const b of rows) await cancelRuns(tx, 'binding_id', b.id)
      }
      for (const aid of new Set(body.addAgents)) {
        if (!(await tx.query('SELECT 1 FROM agents WHERE id=$1 AND active AND (personal_owner IS NULL OR personal_owner=$2)', [aid, user.id])).rowCount)
          fail(404, 'Agent unavailable')
        await tx.query(
          'INSERT INTO bindings(id,conversation_id,agent_id,joined_seq) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [randomUUID(), id, aid, room.next_seq]
        )
      }
      await tx.query('UPDATE conversations SET name=$2,owner_id=$3,router_since=$4 WHERE id=$1', [
        id,
        body.name ?? room.name,
        owner,
        body.routing === undefined
          ? room.router_since
          : body.routing
            ? (room.router_since ?? room.next_seq)
            : null,
      ])
      await event(tx, 'conversation.updated', id)
      return { ok: true }
    })
  })
  app.get(route + '/:id/messages', async (req) => {
    const user = await auth(req),
      id = roomId(req)
    const seq = z.string().regex(/^\d{1,18}$/)
    const q = z.object({ before: seq.optional(), after: seq.optional() }).parse(req.query)
    return write(db, async (tx) => {
      await member(tx, id, user.id)
      const { rows } = await tx.query(
        projection +
          ` WHERE m.conversation_id=$1 AND ($2::bigint IS NULL OR m.seq<$2)
        AND ($3::bigint IS NULL OR m.seq>$3) ORDER BY m.seq ${q.after === undefined ? 'DESC' : 'ASC'} LIMIT 50`,
        [id, q.before, q.after]
      )
      return q.after === undefined ? rows.reverse() : rows
    })
  })
  app.get(route + '/:id/message-updates', async (req) => {
    const user = await auth(req)
    const id = roomId(req)
    const query = z.object({ ids: z.string().max(3700) }).parse(req.query)
    const requested = z.array(uuid).min(1).max(100).parse(query.ids.split(','))
    return write(db, async (tx) => {
      await member(tx, id, user.id)
      return (await tx.query(
        projection + ' WHERE m.conversation_id=$1 AND m.id=ANY($2::uuid[])',
        [id, requested]
      )).rows
    })
  })
  app.post(route + '/:id/messages', async (req) => {
    const user = await auth(req),
      id = roomId(req)
    const body = z
      .object({
        clientMessageId: uuid,
        text: z.string().trim().max(20000),
        replyId: uuid.optional(),
        mentions: ids,
        mentionAll: z.boolean().default(false),
        attachments: z.array(uuid).max(10).default([]),
      })
      .parse(req.body)
    if (!body.text && !body.attachments.length) fail(400, 'Message is empty')
    return write(db, async (tx) => {
      const room = await member(tx, id, user.id)
      const existing = (
        await tx.query('SELECT id,seq,conversation_id FROM messages WHERE user_id=$1 AND client_id=$2', [
          user.id,
          body.clientMessageId,
        ])
      ).rows[0]
      if (existing) {
        if (existing.conversation_id !== id) fail(409, 'Message identifier already used')
        return { id: existing.id, seq: existing.seq }
      }
      const reply =
        body.replyId &&
        (
          await tx.query('SELECT agent_id FROM messages WHERE id=$1 AND conversation_id=$2', [
            body.replyId,
            id,
          ])
        ).rows[0]
      if (body.replyId && !reply) fail(400, 'Invalid reply')
      const { rows: bindings } = await tx.query(
        'SELECT b.id,b.agent_id FROM bindings b JOIN agents a ON a.id=b.agent_id AND a.active WHERE b.conversation_id=$1 AND b.active',
        [id]
      )
      const { rows: people } = await tx.query('SELECT user_id FROM members WHERE conversation_id=$1', [id])
      const allowed = new Set([...bindings.map((b) => b.agent_id), ...people.map((p) => p.user_id)])
      if (body.mentions.some((mid) => !allowed.has(mid))) fail(400, 'Mentioned member unavailable')
      const posted = await message(tx, id, {
        user: user.id,
        client: body.clientMessageId,
        text: body.text,
        reply: body.replyId,
        mentions: body.mentions,
        all: body.mentionAll,
      })
      if (body.attachments.length) {
        const files = await tx.query(
          'UPDATE attachments SET message_id=$1 WHERE conversation_id=$2 AND uploader_id=$3 AND message_id IS NULL AND id=ANY($4::uuid[])',
          [posted.id, id, user.id, body.attachments]
        )
        if (files.rowCount !== new Set(body.attachments).size) fail(400, 'Attachment unavailable')
      }
      const explicit = bindings.filter((b) => body.mentions.includes(b.agent_id))
      const targets =
        room.kind === 'agent'
          ? bindings
          : explicit.length
            ? explicit
            : bindings.filter((b) => b.agent_id === reply?.agent_id)
      for (const b of targets) await enqueue(tx, id, posted.id, b.id)
      if (!targets.length && room.kind === 'group' && room.router_since !== null && bindings.length)
        await enqueue(tx, id, posted.id)
      return posted
    })
  })
  app.post(route + '/:id/read', async (req) => {
    const user = await auth(req),
      id = roomId(req)
    const { seq } = z.object({ seq: z.string().regex(/^\d{1,18}$/) }).parse(req.body)
    return write(db, async (tx) => {
      const room = await member(tx, id, user.id)
      const result = await tx.query(
        'UPDATE members SET read_seq=$3 WHERE conversation_id=$1 AND user_id=$2 AND read_seq<$3',
        [id, user.id, BigInt(seq) > BigInt(room.next_seq) ? room.next_seq : seq]
      )
      if (result.rowCount) await event(tx, 'read.updated', id, {}, user.id)
      return { ok: true }
    })
  })
  app.get(prefix + '/search', async (req) => {
    const user = await auth(req)
    const { q, id } = z.object({ q: z.string().trim().min(1).max(100), id: uuid.optional() }).parse(req.query)
    return write(db, async (tx) => {
      return (
        await tx.query(
          projection +
            ` JOIN members r ON r.conversation_id=m.conversation_id AND r.user_id=$1
        WHERE ($3::uuid IS NULL OR m.conversation_id=$3) AND
        (strpos(lower(m.text),lower($2))>0 OR EXISTS(SELECT 1 FROM attachments f WHERE f.message_id=m.id AND strpos(lower(f.name),lower($2))>0))
        ORDER BY m.created_at DESC LIMIT 50`,
          [user.id, q, id]
        )
      ).rows
    })
  })
}
