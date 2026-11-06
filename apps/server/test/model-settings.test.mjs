import test from 'node:test';
import assert from 'node:assert/strict';
import {readModelCredential} from '../src/model-settings.mjs';

test('environment-only deployment discovers and persists its catalog before proxy use',async t=>{
  const old=process.env.DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY='test-only-not-a-real-key';
  t.after(()=>{if(old===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=old;});
  let stored,requests=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    requests++;assert.equal(url,'https://api.deepseek.com/models');assert.equal(options.redirect,'error');
    return Response.json({data:[{id:'catalog-test-model'}]});
  });
  const pool={async query(sql,values){if(sql.startsWith('SELECT'))return {rows:stored?[{value:stored}]:[]};stored=values[0];return {};}};
  const credential=await readModelCredential(pool,{});
  assert.deepEqual(credential.models,['catalog-test-model']);assert.equal(stored.key,undefined);assert.equal(stored.encryptedKey,undefined);
  await readModelCredential(pool,{});assert.equal(requests,1);
});
