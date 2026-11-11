import { readFileSync } from 'node:fs'
import { database, migrate, write } from './db.ts'
import { createUser, hashPassword, name, password, username } from './auth.ts'
const login = username.parse(process.argv[2])
const display = name.parse(process.argv[3] ?? login)
const secret = await hashPassword(password.parse(readFileSync(0, 'utf8').replace(/\r?\n$/, '')))
const db = database()
try {
  await migrate(db)
  await write(db, async (tx) => {
    if ((await tx.query('SELECT 1 FROM users WHERE admin AND active')).rowCount)
      throw new Error('An active administrator already exists')
    await createUser(tx, { username: login, name: display, password: secret }, true)
  })
  console.log('Administrator created.')
} finally {
  await db.end()
}
