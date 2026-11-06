import { readFileSync } from 'node:fs';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

export function readConfig() {
  const secretRoot = process.env.SECRETS_DIR ?? '/run/group-agent/secrets';
  const vaultKey = Buffer.from(readFileSync(`${secretRoot}/vault.key`, 'utf8').trim(), 'hex');
  if (vaultKey.length !== 32) throw new Error('Invalid vault key');
  const publicOrigin = required('PUBLIC_ORIGIN');
  return {
    databaseUrl: required('DATABASE_URL'),
    vaultKey,
    ownerKey: Uint8Array.from(Buffer.from(readFileSync(`${secretRoot}/owner.key`, 'utf8').trim(), 'hex')),
    secretRoot,
    hostData: process.env.HOST_DATA_DIR ?? '/data/host',
    upstreamRoot: process.env.UPSTREAM_ROOT ?? '/workspace/upstream',
    publicOrigin,
    relayOrigin: required('RELAY_ORIGIN'),
    relayInternal: process.env.RELAY_INTERNAL ?? 'http://relay:3000',
    port: Number(process.env.PORT ?? 3001),
    allowedOrigins: new Set([publicOrigin, 'http://127.0.0.1:1470']),
    webDist: process.env.WEB_DIST ?? '/workspace/upstream/buzz-app/dist',
  };
}
