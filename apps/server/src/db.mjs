import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';

export function database(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  pool.on('error', error => console.error('Database connection lost:', error.code ?? error.name));
  return pool;
}

export async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(71241104)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(x => x.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [name])).rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(new URL(name, directory), 'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [name]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally { await client.query('SELECT pg_advisory_unlock(71241104)'); client.release(); }
}
