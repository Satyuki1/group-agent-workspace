import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Remote-only check. Keep credentials and cookies out of the report; revoke
// only this check's session so the user's browser stays signed in.
const origin=process.env.PUBLIC_ORIGIN ?? 'https://127.0.0.1:18443';
const text=await readFile('/data/host/bootstrap-admin.txt','utf8');
const password=/^密码：(.+)$/m.exec(text)?.[1];
assert.ok(password,'Administrator credential missing');
let cookie='',csrf='';
async function call(path,body) {
  const response=await fetch(origin+path,{
    method:body===undefined?'GET':'POST',
    headers:{Origin:origin,Cookie:cookie,'X-App-CSRF':csrf,...(body===undefined?{}:{'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(15000),
  });
  assert.equal(response.ok,true,`${path}: HTTP ${response.status}`);
  const setCookie=response.headers.get('set-cookie');
  if(setCookie)cookie=setCookie.split(';')[0];
  const value=await response.json();
  if(value.csrf)csrf=value.csrf;
  return value;
}
try {
  const login=await call('/api/app/auth/login',{username:'admin',password});
  assert.equal(login.user.role,'admin');
  const me=await call('/api/app/auth/me');
  assert.equal(me.user.username,'admin');
  const status=await call('/api/app/status');
  assert.equal(status.relay,true);
  assert.equal(status.modelConfigured,true);
  assert.equal(status.harness,'configured');
  const models=await call('/api/app/settings/model');
  assert.equal(models.configured,true);
  console.log(JSON.stringify({passed:true,origin,administratorLogin:true,relay:status.relay,modelConfigured:status.modelConfigured,harness:status.harness}));
} finally {
  if(cookie)await call('/api/app/auth/logout',{});
}
