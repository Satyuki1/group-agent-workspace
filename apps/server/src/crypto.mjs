import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');

/** Bind ciphertext to its owner so swapped database records do not decrypt. */
export function seal(value, key, owner) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(owner));
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(x => x.toString('base64url')).join('.');
}

export function unseal(value, key, owner) {
  const parts = value.split('.').map(x => Buffer.from(x, 'base64url'));
  if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv('aes-256-gcm', key, parts[0]);
  decipher.setAAD(Buffer.from(owner));
  decipher.setAuthTag(parts[1]);
  return Buffer.concat([decipher.update(parts[2]), decipher.final()]);
}
