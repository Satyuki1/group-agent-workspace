import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { event, message, write } from './db.ts'
import type { DB, Tx } from './db.ts'
import { fail, runnerAuth } from './auth.ts'
import type { User } from './auth.ts'
import { enqueue, member } from './rooms.ts'
import { prefix, runUpdate, uuid } from '../shared/protocol.ts'
import type { RunInput } from '../shared/protocol.ts'

export async function finish(
  tx: Tx,
  run: { id: string; reply_id: string | null; conversation_id: string },
  status: string,
  outcome: string | null = null
) {
  await tx.query('UPDATE runs SET status=$2,outcome=$3,approval=NULL,finished_at=now() WHERE id=$1', [
    run.id,
    status,
    outcome,
  ])
  if (run.reply_id) await tx.query('UPDATE messages SET status=$2 WHERE id=$1', [run.reply_id, status])
  await event(tx, 'run.updated', run.conversation_id, { runId: run.id, messageId: run.reply_id })
}

export async function leased(db: DB | Tx, id: string, lease: string) {
  const { rows } = await db.query(
    `SELECT r.*,b.agent_id,b.joined_seq,b.active binding_active,a.active agent_active,a.personal_owner
    FROM runs r LEFT JOIN bindings b ON b.id=r.binding_id LEFT JOIN agents a ON a.id=b.agent_id
    WHERE r.id=$1 AND r.lease=$2 AND r.status IN ('running','approval') AND r.lease_until>now()
      AND (r.kind='route' OR (b.active AND a.active AND
        (a.personal_owner IS NULL OR EXISTS (
          SELECT 1 FROM members m JOIN users u ON u.id=m.user_id AND u.active
          WHERE m.conversation_id=r.conversation_id AND m.user_id=a.personal_owner
        ))))`,
    [id, lease]
  )
  if (!rows[0]) fail(409, 'Task no longer available')
  return rows[0]
}

export async function claim(db: DB, kind?: 'agent' | 'route', owner?: string): Promise<RunInput | null> {
  return write(db, async (tx) => {
    const {
      rows: [run],
    } = await tx.query(
      `SELECT r.*,s.seq source_seq,s.user_id author,s.reply_id quoted_id,
      c.router_since,c.name conversation_name,b.joined_seq,b.agent_id,a.model,a.instructions,a.tools,a.local_bot_id
      FROM runs r JOIN messages s ON s.id=r.source_id JOIN conversations c ON c.id=r.conversation_id
      JOIN users u ON u.id=s.user_id AND u.active
      JOIN members m ON m.user_id=s.user_id AND m.conversation_id=c.id
      LEFT JOIN bindings b ON b.id=r.binding_id LEFT JOIN agents a ON a.id=b.agent_id
      WHERE r.status='queued' AND ($1::text IS NULL OR r.kind=$1)
        AND a.personal_owner IS NOT DISTINCT FROM $2::uuid
        AND ($2::uuid IS NULL OR EXISTS(
          SELECT 1 FROM members own WHERE own.conversation_id=c.id AND own.user_id=$2
        )) AND (
        r.kind='route' OR (b.active AND a.active AND NOT EXISTS(
          SELECT 1 FROM runs rr WHERE rr.binding_id=r.binding_id AND rr.status IN ('running','approval')
        )))
      ORDER BY (r.kind='agent') DESC,r.created_at,r.id LIMIT 1`,
      [kind, owner ?? null]
    )
    if (!run) return null
    const routing = run.kind === 'route'
    const model = routing
      ? (await tx.query("SELECT value FROM settings WHERE key='routerModel'")).rows[0]?.value
      : run.model
    const candidates = routing
      ? (
          await tx.query(
            `SELECT a.id,a.name,a.description FROM agents a JOIN bindings b ON b.agent_id=a.id
      WHERE b.active AND a.active AND a.personal_owner IS NULL AND b.conversation_id=$1 AND b.joined_seq<$2 ORDER BY a.name,a.id`,
            [run.conversation_id, run.source_seq]
          )
        ).rows
      : []
    if (
      (!owner && !model) ||
      (routing &&
        (run.router_since === null ||
          BigInt(run.router_since) >= BigInt(run.source_seq) ||
          !candidates.length))
    ) {
      await finish(tx, run, 'complete', 'ignore')
      return null
    }
    const floor = routing ? run.router_since : run.joined_seq
    const { rows: history } = await tx.query(
      `SELECT m.id,m.seq,left(m.text,2000) text,coalesce(u.name,a.name) sender
      FROM messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agents a ON a.id=m.agent_id
      WHERE m.conversation_id=$1 AND m.seq>$2 AND m.seq<=$3 AND m.status='complete'
      ORDER BY m.seq DESC LIMIT 20`,
      [run.conversation_id, floor, run.source_seq]
    )
    const {
      rows: [current],
    } = await tx.query('SELECT text FROM messages WHERE id=$1', [run.source_id])
    const quote =
      !routing && run.quoted_id
        ? (
            await tx.query('SELECT left(text,4000) text FROM messages WHERE id=$1 AND conversation_id=$2', [
              run.quoted_id,
              run.conversation_id,
            ])
          ).rows[0]?.text
        : undefined
    const files = routing
      ? []
      : (
          await tx.query(
            `SELECT f.id,f.name,f.media_type,f.size FROM attachments f
      JOIN messages m ON m.id=f.message_id WHERE f.conversation_id=$1 AND (m.id=$2 OR m.id=$3)
      ORDER BY f.id LIMIT 20`,
            [run.conversation_id, run.source_id, run.quoted_id]
          )
        ).rows
    const context = {
      recent: history
        .reverse()
        .filter((m) => m.id !== run.source_id)
        .map((m) => ({ sender: m.sender, text: m.text })),
      current: routing ? current.text.slice(0, 2000) : current.text,
      quote,
      files: files.map((f) => ({ name: f.name, path: f.id })),
    }
    const reply = routing
      ? null
      : await message(tx, run.conversation_id, {
          agent: run.agent_id,
          text: '',
          reply: run.source_id,
          status: 'running',
        })
    const lease = randomUUID()
    const approvalId = owner ? randomUUID() : undefined
    const approval = approvalId ? { id: approvalId, label: '允许这条群消息交给你的个人 Agent 在本机执行？' } : null
    await tx.query(
      "UPDATE runs SET status=$4,started_at=now(),reply_id=$2,lease=$3,lease_until=now()+interval '30 seconds',approval=$5 WHERE id=$1",
      [run.id, reply?.id, lease, approval ? 'approval' : 'running', approval]
    )
    if (!routing) await event(tx, 'run.updated', run.conversation_id, { runId: run.id, messageId: reply?.id })
    return {
      id: run.id,
      lease,
      kind: run.kind,
      location: owner ? 'personal' : 'server',
      ...(owner ? { localBotId: run.local_bot_id, conversationId: run.conversation_id,
        conversationName: run.conversation_name, approvalId } : {}),
      bindingId: run.binding_id,
      model,
      instructions: run.instructions ?? '',
      tools: run.tools ?? false,
      prompt: JSON.stringify(context),
      candidates,
      files,
    }
  })
}

export function runs(
  app: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Promise<User>,
  secret: string | undefined,
  hasWorkspace: (user: User) => boolean
) {
  const path = prefix + '/runner'
  const route = prefix + '/runs'
  const idOf = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id
  let lastSeen: number | null = null
  let sweeping = false
  const reaper = setInterval(async () => {
    if (sweeping) return
    sweeping = true
    try {
      await write(db, async (tx) => {
        const { rows } = await tx.query(`SELECT * FROM runs WHERE
          (status IN ('running','approval') AND lease_until<=now()) OR
          (kind='route' AND status='queued' AND created_at<now()-interval '10 seconds')`)
        for (const run of rows)
          await finish(
            tx,
            run,
            'failed',
            run.kind === 'route' ? 'Classification expired' : 'Runner disconnected'
          )
      })
    } catch {
      app.log.warn('Could not check expired Agent tasks')
    } finally {
      sweeping = false
    }
  }, 3000)
  reaper.unref()
  app.addHook('onClose', async () => {
    clearInterval(reaper)
  })
  app.get(prefix + '/runner-status', async (req) => {
    await auth(req)
    return { online: lastSeen !== null && Date.now() - lastSeen < 10_000 }
  })
  app.post(path + '/claim', async (req) => {
    runnerAuth(req, secret)
    const { kind } = z.object({ kind: z.enum(['agent', 'route']).optional() }).parse(req.body ?? {})
    lastSeen = Date.now()
    return claim(db, kind)
  })
  const personalPath = prefix + '/personal/runs'
  async function workspaceUser(req: FastifyRequest) {
    const user = await auth(req)
    if (!hasWorkspace(user)) fail(403, 'Personal workspace unavailable')
    return user
  }
  app.post(personalPath + '/claim', async (req) => claim(db, 'agent', (await workspaceUser(req)).id))
  const checkRunner = async (req: FastifyRequest, personal: boolean) => {
    if (personal) return (await workspaceUser(req)).id
    runnerAuth(req, secret)
    return null
  }
  for (const personal of [false, true]) {
    const base = personal ? personalPath : path
    app.post(base + '/:id/heartbeat', async (req) => {
      const owner = await checkRunner(req, personal)
      const id = idOf(req),
        { lease } = z.object({ lease: uuid }).parse(req.body)
      return write(db, async (tx) => {
        const r = await leased(tx, id, lease)
        if (r.personal_owner !== owner) fail(403, 'Task permission required')
        await tx.query("UPDATE runs SET lease_until=now()+interval '30 seconds' WHERE id=$1", [id])
        return { decision: r.decision }
      })
    })
    app.post(base + '/:id/events', async (req) => {
      const owner = await checkRunner(req, personal)
      const id = idOf(req),
        body = z
          .object({ lease: uuid, position: z.number().int().positive(), update: runUpdate })
          .parse(req.body)
      return write(db, async (tx) => {
        const r = await leased(tx, id, body.lease)
        if (r.personal_owner !== owner) fail(403, 'Task permission required')
        if (owner && r.decision !== 'allow' && body.update.type !== 'failed')
          fail(409, 'Personal Agent approval required')
        if (body.position <= r.position) return { ok: true }
        if (body.position !== r.position + 1) fail(409, 'Out of order task event')
        await tx.query('UPDATE runs SET position=$2 WHERE id=$1', [id, body.position])
        const update = body.update
        if (r.kind === 'route') {
          if (update.type !== 'complete' && update.type !== 'failed') fail(400, 'Invalid classification event')
          let target: string | undefined
          if (update.type === 'complete' && update.target) {
            target = (
              await tx.query(
                `SELECT b.id FROM bindings b JOIN agents a ON a.id=b.agent_id AND a.active
              JOIN conversations c ON c.id=b.conversation_id JOIN messages s ON s.id=$3
              WHERE b.conversation_id=$1 AND b.agent_id=$2 AND b.active AND a.personal_owner IS NULL AND c.router_since<s.seq AND b.joined_seq<s.seq`,
                [r.conversation_id, update.target, r.source_id]
              )
            ).rows[0]?.id
          }
          if (target) await enqueue(tx, r.conversation_id, r.source_id, target)
          await finish(
            tx,
            r,
            'complete',
            target ? 'dispatch' : update.type === 'failed' ? update.reason : 'ignore'
          )
          return { ok: true }
        }
        if (update.type === 'delta') {
          await tx.query('UPDATE messages SET text=left(text||$2,200000) WHERE id=$1', [
            r.reply_id,
            update.text,
          ])
          await event(tx, 'message.delta', r.conversation_id, {
            messageId: r.reply_id,
            position: body.position,
            text: update.text,
          })
        } else if (update.type === 'progress') {
          await tx.query('UPDATE runs SET progress=$2 WHERE id=$1', [id, update.text])
        } else if (update.type === 'approval') {
          if (r.status === 'approval') fail(409, 'Approval pending')
          await tx.query("UPDATE runs SET status='approval',approval=$2,decision=NULL WHERE id=$1", [
            id,
            JSON.stringify(update),
          ])
        } else {
          await finish(
            tx,
            r,
            update.type === 'complete' ? 'complete' : 'failed',
            update.type === 'failed' ? update.reason : null
          )
          return { ok: true }
        }
        if (update.type !== 'delta') await event(tx, 'run.updated', r.conversation_id, { runId: id })
        return { ok: true }
      })
    })
  }
  app.get(prefix + '/conversations/:id/runs', async (req) => {
    const user = await auth(req),
      id = idOf(req)
    return write(db, async (tx) => {
      const room = await member(tx, id, user.id)
      return (
        await tx.query(
          `SELECT r.id,r.reply_id,s.user_id author,r.status,r.progress,r.approval,r.decision,r.outcome,
        (s.user_id=$2 OR $3::uuid=$2 OR a.personal_owner=$2) AS actionable,
        (a.personal_owner IS NULL AND (s.user_id=$2 OR $3::uuid=$2) OR a.personal_owner=$2) AS can_approve
        FROM runs r JOIN messages s ON s.id=r.source_id
        LEFT JOIN bindings b ON b.id=r.binding_id LEFT JOIN agents a ON a.id=b.agent_id WHERE r.conversation_id=$1 AND r.kind='agent'
        ORDER BY r.created_at DESC LIMIT 50`,
          [id, user.id, room.owner_id]
        )
      ).rows
    })
  })
  app.post(route + '/:id/action', async (req) => {
    const user = await auth(req),
      id = idOf(req)
    const body = z
      .object({ action: z.enum(['cancel', 'allow', 'deny']), approvalId: uuid.optional() })
      .parse(req.body)
    return write(db, async (tx) => {
      const {
        rows: [r],
      } = await tx.query(
        `SELECT r.*,s.user_id author,a.personal_owner FROM runs r JOIN messages s ON s.id=r.source_id
        LEFT JOIN bindings b ON b.id=r.binding_id LEFT JOIN agents a ON a.id=b.agent_id WHERE r.id=$1`,
        [id]
      )
      if (!r || r.kind !== 'agent') fail(404, 'Task unavailable')
      const room = await member(tx, r.conversation_id, user.id)
      if (user.id !== r.author && user.id !== room.owner_id && user.id !== r.personal_owner) fail(403, 'Task permission required')
      if (!['queued', 'running', 'approval'].includes(r.status)) fail(409, 'Task finished')
      if (body.action === 'cancel') await finish(tx, r, 'cancelled', 'cancelled')
      else {
        if (r.personal_owner && r.personal_owner !== user.id) fail(403, 'Personal Agent owner must approve')
        if (r.status !== 'approval' || !body.approvalId || r.approval?.id !== body.approvalId)
          fail(409, 'Approval closed')
        if (r.personal_owner && body.action === 'deny') await finish(tx, r, 'cancelled', 'Personal Agent owner declined')
        else {
          await tx.query("UPDATE runs SET status='running',decision=$2,approval=NULL WHERE id=$1", [id, body.action])
          await event(tx, 'run.updated', r.conversation_id, { runId: id })
        }
      }
      return { ok: true }
    })
  })
  app.get(prefix + '/admin/routing-log', async (req) => {
    if (!(await auth(req)).admin) fail(403, 'Administrator required')
    return (
      await db.query(`SELECT r.id,r.conversation_id,r.source_id,r.status,r.outcome,r.created_at,
      extract(epoch FROM (r.finished_at-r.started_at))*1000 duration_ms,
      (SELECT a.name FROM runs target JOIN bindings b ON b.id=target.binding_id JOIN agents a ON a.id=b.agent_id
       WHERE target.source_id=r.source_id AND target.kind='agent' LIMIT 1) agent
      FROM runs r WHERE r.kind='route' ORDER BY r.created_at DESC LIMIT 100`)
    ).rows
  })
}
