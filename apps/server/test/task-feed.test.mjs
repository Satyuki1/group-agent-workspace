import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mountTaskFeed} from '../src/task-feed.mjs';

test('a previously running task leaving the bounded window is explicitly removed',async()=>{
  const app=Fastify();
  const newer=Array.from({length:30},(_,i)=>({id:'new-'+i,status:'completed',created_at:new Date(1000+i).toISOString(),updated_at:new Date(1000+i).toISOString()}));
  let rows=[{id:'older-running',status:'running',created_at:new Date(0).toISOString(),updated_at:new Date(0).toISOString()},...newer.slice(1)];
  app.decorate('requireUser',async request=>{request.account={id:'user'};request.authSession={hash:'session'};});
  const pool={query:async sql=>({rows:sql.includes('FROM tasks')?rows:[],rowCount:1})};
  mountTaskFeed(app,pool,{conversationAccess:async()=>{}});
  const address=await app.listen({host:'127.0.0.1',port:0}),stop=new AbortController();let reader;
  try{
    const response=await fetch(address+'/api/app/conversations/00000000-0000-4000-8000-000000000000/activity',{signal:stop.signal});
    reader=response.body.getReader();let pending='';
    async function frame(){while(true){const marker=pending.indexOf('\n\n');if(marker>=0){const text=pending.slice(0,marker);pending=pending.slice(marker+2);if(text.startsWith('data: '))return JSON.parse(text.slice(6));continue;}const chunk=await reader.read();assert.equal(chunk.done,false);pending+=new TextDecoder().decode(chunk.value);}}
    const first=await frame();assert.equal(first.tasks[0].id,'older-running');assert.equal(first.tasks.length,30);
    rows=newer;const next=await frame();assert.deepEqual(next.removed,['older-running']);assert.equal(next.reset,false);assert.ok(next.tasks.every(task=>task.id!=='older-running'));
  }finally{stop.abort();await reader?.cancel().catch(()=>{});await app.close();}
});
