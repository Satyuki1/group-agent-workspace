import test from 'node:test';
import assert from 'node:assert/strict';
import {invitationAllowed,recentGroupContext} from '../src/agent-memberships.mjs';
import {seal} from '../src/crypto.mjs';
import {randomBytes} from 'node:crypto';

test('native membership reconciliation retains owner and group-admin authorization',()=>{
 const owner={id:'owner'},other={id:'other'},agent={owner_id:'owner',role:'personal',public_key:'agent'};
 const access={channelType:'stream',canManage:true,roles:{agent:'bot'}};
 assert.equal(invitationAllowed(owner,agent,access),true);
 assert.equal(invitationAllowed(other,agent,access),false);
 assert.equal(invitationAllowed(owner,agent,{...access,canManage:false}),false);
 assert.equal(invitationAllowed(owner,agent,{...access,roles:{}}),false);
 assert.equal(invitationAllowed(owner,agent,{...access,roles:{agent:'unknown'}}),false);
 assert.equal(invitationAllowed(owner,agent,{...access,roles:{agent:'guest'}}),false);
 assert.equal(invitationAllowed(owner,agent,{...access,channelType:'dm'}),false);
 assert.equal(invitationAllowed(other,{...agent,role:'coordinator'},access),true);
});
test('group context is bounded to the actual group, while personal execution never reads it',async()=>{
 const vaultKey=randomBytes(32),agent={id:'agent',encrypted_key:seal(randomBytes(32),vaultKey,'agent')};
 const task={source_event_id:'source',conversation_id:'group',space_kind:'group'};
 const source={id:'source',pubkey:'user',created_at:100,tags:[['h','group']],content:'总结本群'};
 const calls=[];
 const relay={query:async(_key,filters)=>{calls.push(filters[0]);return calls.length===1?[source]:[
  {...source,id:'old',created_at:90,content:'群内决定先完善 IM'},
  {...source,id:'private',created_at:90,tags:[['h','private']],content:'不应进入群的私人内容'},
  {...source,id:'long',created_at:91,content:'长消息'+ 'x'.repeat(7000)},
  source,
 ];}};
 const pool={query:async()=>({rows:[{public_key:'user',name:'同事'}]})};
 const value=await recentGroupContext(task,agent,{pool,relay,config:{vaultKey}});
 assert.match(value,/同事.*群内决定先完善 IM/);assert.ok(!value.includes('私人内容'));assert.ok(!value.includes('总结本群'));
 assert.match(value,/引用摘录已截断/);assert.ok(value.length<=12000);
 assert.deepEqual(calls[1]['#h'],['group']);assert.equal(calls[1].until,100);assert.equal(calls[1].limit,20);
 assert.equal(await recentGroupContext({...task,space_kind:'personal'},agent,{pool,relay,config:{vaultKey}}),'');assert.equal(calls.length,2);
});
