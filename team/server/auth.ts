import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import type { DB, Tx } from './db.ts'

export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{3,64}$/)
export const password = z.string().min(12).max(128)
export const name = z.string().trim().min(1).max(100)
export const digest = (token: string) => createHash('sha256').update(token).digest('hex')
export const token = () => randomBytes(32).toString('base64url')
export const hashPassword = (value: string) =>
  argon2.hash(value, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
export type User = { id: string; username: string; name: string; admin: boolean }

export function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode })
}
export async function userOf(db: DB, req: FastifyRequest): Promise<User | undefined> {
  const value = req.headers.cookie?.match(/(?:^|;\s*)im_session=([\w-]{43})(?:;|$)/)?.[1]
  if (!value) return
  const { rows } = await db.query(
    `SELECT u.id,u.username,u.name,u.admin FROM login_sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>now() AND u.active`,
    [digest(value)]
  )
  return rows[0]
}
export function cookie(value: string, secure: boolean, age: number) {
  return `im_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`
}
export function runnerAuth(req: FastifyRequest, secret: string | undefined) {
  if (
    !secret ||
    !timingSafeEqual(
      Buffer.from(digest(req.headers.authorization ?? '')),
      Buffer.from(digest(`Bearer ${secret}`))
    )
  )
    fail(401, 'Runner authentication required')
}
export async function createUser(
  tx: Tx,
  details: { username: string; password: string; name: string },
  admin = false
) {
  const id = randomUUID()
  await tx.query('INSERT INTO users(id,username,name,password,admin) VALUES($1,$2,$3,$4,$5)', [
    id,
    details.username,
    details.name,
    details.password,
    admin,
  ])
  return id
}
