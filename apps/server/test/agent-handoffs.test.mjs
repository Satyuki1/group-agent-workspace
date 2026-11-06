import test from 'node:test';
import assert from 'node:assert/strict';
import {handoffMentions,handoffLimit,groupAgentPeers,prepareHandoffs} from '../src/agent-handoffs.mjs';
import {profileMentionParts} from '../../../upstream/buzz-app/src/features/messages/profile-mentions.ts';
const peers=[{id:'a',name:'助手',public_key:'a'.repeat(64)},{id:'b',name:'助手二号',public_key:'b'.repeat(64)},{id:'c',name:'审阅员',public_key:'c'.repeat(64)}];

test('handoffs select exact identities on intentional task lines, including multiple recipients',()=>{
  const text='整理完毕。\n@助手二号 @审阅员 请核对文档。\n- @助手：请汇总。';
  const tokens=handoffMentions(text,peers);
  assert.deepEqual(tokens.map(t=>t.peer.id),['b','c','a']);
  assert.deepEqual(tokens.map(t=>text.slice(t.start,t.end)),['@助手二号','@审阅员','@助手']);
  assert.equal(handoffMentions(`@nostr:${peers[2].public_key} 请检查`,peers)[0].peer.id,'c');
});
test('prose, quoted examples, fenced/indented code, bare names and unknown recipients never wake a bot',()=>{
  const text='感谢 @助手 的帮助\n> @助手 请核对\n```txt\n@助手 请执行\n```\n    @助手 请执行\n@助手\n@不在群里 请执行';
  assert.deepEqual(handoffMentions(text,peers),[]);
  const duplicate=[...peers,{id:'d',name:'助手',public_key:'d'.repeat(64)}];
  assert.equal(handoffMentions('@助手 请检查',duplicate).length,0);
  assert.equal(handoffMentions(`@nostr:${peers[0].public_key} 请检查`,duplicate).length,1);
});
test('a return handoff can wake the original Agent once; depth, total, cancellation and repeated cycles are bounded',()=>{
  const chain=['b','a'].map(agent_id=>({agent_id,status:'completed',cancel_requested:false}));
  assert.equal(handoffLimit(chain,2,'a'),undefined);
  assert.match(handoffLimit([...chain,chain[1]],3,'a'),/两次/);
  assert.match(handoffLimit(Array(5).fill(chain[0]),5,'a'),/4 次/);
  assert.match(handoffLimit(chain,8,'a'),/8 个/);
  assert.match(handoffLimit([{...chain[0],cancel_requested:true}],1,'a'),/停止/);
  assert.match(handoffLimit([{...chain[0],status:'failed'}],1,'a'),/停止/);
});
test('private chats and legacy tasks do not enumerate peers; signed group membership and ready bindings constrain recipients',async()=>{
  const denied={groupAccess:async()=>({channelType:'group',roles:{self:'member'}})};
  const task={space_kind:'group',input:{agentCollaboration:1},conversation_id:'group',space_id:'space'};
  const agent={id:'sender',public_key:'self'};
  assert.deepEqual(await groupAgentPeers({...task,space_kind:'personal'},agent,{}),[]);
  assert.deepEqual(await groupAgentPeers({...task,input:{}},agent,{}),[]);
  await assert.rejects(groupAgentPeers(task,agent,{workspaces:denied}),{statusCode:403});
  const workspaces={groupAccess:async(actor,id,options)=>{assert.equal(actor,agent);assert.equal(id,'group');assert.equal(options.fresh,true);return {channelType:'group',roles:{self:'bot',[peers[0].public_key]:'bot'}};}};
  const pool={query:async(sql,params)=>{assert.match(sql,/b.ready/);assert.match(sql,/m.active/);assert.deepEqual(params,['space','sender','group']);return {rows:peers};}};
  assert.deepEqual(await groupAgentPeers(task,agent,{pool,workspaces}),[peers[0]]);
});
test('ordinary results avoid all graph locking and queue work',async()=>{
  assert.deepEqual(await prepareHandoffs({query:()=>{throw Error('unnecessary database work');}},{},'普通结果',peers),{content:'普通结果',tags:[],children:[]});
});
test('published @ names bind to the signed identity using the actual Buzz timeline renderer',()=>{
  const target=peers[1],text=`@${target.name} 请检查文档。`;
  const parts=profileMentionParts({content:text,mentions:[target.public_key]},new Map([[target.public_key,{name:target.name}]]));
  assert.equal(parts[0].text,`@${target.name}`);assert.ok(parts[0].target);
  assert.equal(parts.map(p=>p.text).join(''),text);
});
