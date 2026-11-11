import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

export function database(connectionString = process.env.IM_DATABASE_URL) {
  if (!connectionString) throw new Error('IM_DATABASE_URL is required')
  return new pg.Pool({ connectionString })
}

export type DB = ReturnType<typeof database>
export type Tx = PoolClient
export async function write<T>(db: DB, action: (tx: Tx) => Promise<T>) {
  const tx = await db.connect()
  try {
    await tx.query('BEGIN')
    // Event IDs must become visible in commit order for cursor-based delivery.
    await tx.query('SELECT pg_advisory_xact_lock(81390721)')
    const result = await action(tx)
    await tx.query('COMMIT')
    return result
  } catch (error) {
    await tx.query('ROLLBACK')
    throw error
  } finally {
    tx.release()
  }
}
export async function migrate(db: DB) {
  await write(db, async (tx) => {
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)')
    const path = new URL('../migrations/', import.meta.url)
    for (const name of (await readdir(path)).filter((name) => name.endsWith('.sql')).sort()) {
      if ((await tx.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue
      await tx.query(await readFile(new URL(name, path), 'utf8'))
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)', [name])
    }
  })
}

export async function event(
  tx: Tx,
  kind: string,
  conversation: string | null,
  data: unknown = {},
  user: string | null = null
) {
  await tx.query('INSERT INTO events(kind, conversation_id, data, user_id) VALUES ($1,$2,$3,$4)', [
    kind,
    conversation,
    JSON.stringify(data),
    user,
  ])
}

export async function message(
  tx: Tx,
  conv: string,
  args: {
    user?: string
    agent?: string
    client?: string
    text: string
    reply?: string | null
    mentions?: string[]
    all?: boolean
    status?: string
  }
) {
  const {
    rows: [{ next_seq }],
  } = await tx.query(
    'UPDATE conversations SET next_seq=next_seq+1,updated_at=now() WHERE id=$1 RETURNING next_seq',
    [conv]
  )
  const id = randomUUID()
  await tx.query(
    `INSERT INTO messages(id,conversation_id,seq,user_id,agent_id,client_id,text,reply_id,mentions,mention_all,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      conv,
      next_seq,
      args.user,
      args.agent,
      args.client,
      args.text,
      args.reply,
      args.mentions ?? [],
      args.all ?? false,
      args.status ?? 'complete',
    ]
  )
  await event(tx, 'message.added', conv, { messageId: id, seq: next_seq, authorId: args.user ?? args.agent })
  return { id, seq: next_seq as string }
}
