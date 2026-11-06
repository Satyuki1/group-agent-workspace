import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {seal,unseal} from '../src/crypto.mjs';
import {authorization} from '../src/relay.mjs';
import {generateSecretKey,verifyEvent} from 'nostr-tools';

test('credential ciphertext cannot be moved to another identity or modified',()=>{
  const key=randomBytes(32),secret=randomBytes(32),encrypted=seal(secret,key,'alice');
  assert.deepEqual(unseal(encrypted,key,'alice'),secret);
  assert.throws(()=>unseal(encrypted,key,'bob'));
  const parts=encrypted.split('.');const changed=Buffer.from(parts[2],'base64url');changed[0]^=1;parts[2]=changed.toString('base64url');
  assert.throws(()=>unseal(parts.join('.'),key,'alice'));
});

test('NIP-98 request proof signs method, exact URL and payload hash',()=>{
  const proof=authorization(generateSecretKey(),'https://team.example/query','POST','{"filters":[]}');
  const event=JSON.parse(Buffer.from(proof.slice(6),'base64').toString());
  assert.equal(verifyEvent(event),true);
  assert.equal(event.kind,27235);
  assert.deepEqual(event.tags.slice(0,2),[['u','https://team.example/query'],['method','POST']]);
  assert.match(event.tags.find(x=>x[0]==='payload')[1],/^[0-9a-f]{64}$/);
  const next=JSON.parse(Buffer.from(authorization(generateSecretKey(),'https://team.example/query','POST','{"filters":[]}').slice(6),'base64').toString());
  assert.notEqual(event.tags.find(x=>x[0]==='nonce')[1],next.tags.find(x=>x[0]==='nonce')[1]);
});
