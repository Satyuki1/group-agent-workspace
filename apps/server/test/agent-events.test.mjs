import test from 'node:test';
import assert from 'node:assert/strict';
import {addressedTo,resultText,taskOutcome,sourceRoot,taskReplyTags} from '../src/agent-events.mjs';
import {foldConsumedWork} from '../../../upstream/deepseek-harness/packages/core/agent/src/consumed-work.ts';

test('explicit mentions match the addressed identity, not incidental names',()=>{
  const agent={public_key:'abc',name:'群助手'};
  assert.equal(addressedTo({tags:[['p','abc']],content:'整理文件'},agent),true);
  assert.equal(addressedTo({tags:[],content:'@群助手 请整理文件'},agent),true);
  assert.equal(addressedTo({tags:[],content:'今天讨论了群助手'},agent),false);
  assert.equal(addressedTo({tags:[],content:'@群助手二号 请整理'},agent),false);
  assert.equal(addressedTo({tags:[['p','another']],content:'请让 @群助手 随后接手'},agent),false);
  assert.equal(addressedTo({tags:[['p','abc']],content:'正式提及优先于正文里的其他名称'},agent),true);
});
test('native failure, interruption and mismatched request never become successful work',()=>{
  const events=[{seq:1,type:'turn/start',data:{turn:0}},{seq:2,type:'user/message',data:{source:{kind:'user',rpcId:'task'}}},{seq:3,type:'step/start',data:{turn:0}},{seq:4,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}}];
  assert.equal(taskOutcome(events,'task',0,foldConsumedWork),'completed');
  assert.equal(taskOutcome(events,'another-task',0,foldConsumedWork),'unknown');
  for(const kind of ['error','aborted','interrupted','max-tokens']){
    events[3].data.reason.kind=kind;assert.equal(taskOutcome(events,'task',0,foldConsumedWork),kind);
  }
  assert.equal(resultText([{type:'event',event:{seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:'准备执行'},{type:'tool-call',name:'write_file'}]}}}}],0),'');
});
test('result selection excludes previous tasks, reasoning and tool arguments',()=>{
  const record=(seq,type,content)=>({type:'event',event:{seq,type,data:{message:{content}}}});
  const records=[record(8,'assistant/message',[{type:'text',text:'旧任务'}]),record(12,'assistant/message',[{type:'thinking',text:'私有推理'},{type:'text',text:'新成果'}]),record(14,'tool/result',[{type:'text',text:'工具细节'}])];
  assert.equal(resultText(records,9),'新成果');assert.equal(resultText(records,20),'');
});

test('nested task results retain ancestry and broadcast only the final publication',()=>{
  const root='a'.repeat(64),source='b'.repeat(64);
  const event={id:source,tags:[['e',root,'','root'],['e',root,'','reply']]};
  assert.equal(sourceRoot(event),root);
  assert.equal(sourceRoot({id:source,tags:[]}),source);
  const task={id:'task',conversation_id:'group',source_event_id:source,input:{rootId:sourceRoot(event)}};
  for(const purpose of ['task-accepted','task-result']){
    const tags=taskReplyTags(task,purpose);
    assert.ok(tags.some(t=>t[0]==='e' && t[1]===root && t[3]==='root'));
    assert.ok(tags.some(t=>t[0]==='e' && t[1]===(purpose==='task-result'?root:source) && t[3]==='reply'));
    assert.equal(tags.some(t=>t[0]==='broadcast'),purpose==='task-result');
  }
});
