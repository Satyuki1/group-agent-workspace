import test from 'node:test';
import assert from 'node:assert/strict';
import {browserResource} from '../../../integrations/dsh-bridge/browser-resource.mjs';
import {progressProjector,taskOpening} from '../src/task-progress.mjs';
test('browser resource only admits bounded HTTP(S) URLs without embedded credentials',()=>{
 assert.deepEqual(browserResource({url:'https://example.org'}),{kind:'browser',url:'https://example.org/'});
 for(const url of ['javascript:alert(1)','data:text/html,a','file:///etc/passwd','https://user:password@example.org','https://example.org/'+'a'.repeat(4096),'https://example.org/'+'你'.repeat(3000)])assert.equal(browserResource({url}),undefined);
 assert.equal(browserResource('not-json'),undefined);
});
test('browser request follows its exact real tool call/result and survives native replay',async()=>{
 const task={id:'browser-task',baseline_cursor:1,progress:{}};
 const events=[{seq:2,type:'user/message',data:{source:{rpcId:task.id}}},{seq:3,type:'tool/call',data:{callId:'open',name:'open_browser',arguments:'{"url":"https://example.org/"}'}},{seq:4,time:200,type:'tool/result',data:{message:{toolCallId:'open',isError:false,content:[{type:'text',text:'网页入口已发布'}]}}}];
 const live=progressProjector(task);for(const event of events)live.event(event);
 assert.equal(live.snapshot().tools[0].state,'completed');assert.deepEqual(live.snapshot().tools[0].resource,{kind:'browser',url:'https://example.org/'});
 const replay=progressProjector(task);replay.accept(await taskOpening({type:'snapshot',cursor:4,hasMore:false,records:events.map(event=>({event}))},task,()=>{throw Error('unexpected read')}));
 assert.deepEqual(replay.snapshot().tools[0],live.snapshot().tools[0]);
});

test('wire consumer opens only newly completed browser resources, never a late historical window entry',async()=>{
 const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');
 let listener,plugin;const opened=[];let active='guide';const noop=()=>{};
 const parent={postMessage:noop};
 const window={parent,__ModuleLoader__:{load:({factory})=>{plugin=factory(name=>name==='react'?{createElement:noop}:{Button:noop});}},addEventListener:(_type,fn)=>{listener=fn;},removeEventListener:noop};
 runInNewContext(await readFile(new URL('../../../integrations/dsh-bridge/client.js',import.meta.url),'utf8'),{window,parent,location:{origin:'https://im.example'},__GROUP_SPACE__:'space',document:{createElement:()=>({remove:noop}),head:{append:noop}},localStorage:{getItem:()=>null,setItem:noop},requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame:noop,URL,console});
 const ctx={effect:fn=>fn(),locale:{register:noop,bind:()=>key=>key},sidebarRightTabs:{register:noop},slots:{inject:(_name,fn)=>fn(),register:noop},sessions:{list:{getSnapshot:()=>({byId:{session:{}}}),subscribe:()=>noop}},uiWorkspace:{openSession:noop},sidebarRight:{isExpanded:()=>true,active:()=>({kind:active}),openTab:(kind,args)=>opened.push({kind,url:args?.params?.url})}};
 plugin.apply(ctx);
 const send=value=>listener({source:parent,origin:'https://im.example',data:{spaceId:'space',requestId:'test',...value}});
 send({type:'workspace.bind',sessionId:'session',conversationId:'group'});
 const task=(id,completedAt)=>({id,progress:{tools:[{id:'open-'+id,name:'open_browser',state:'completed',completedAt,resource:{kind:'browser',url:'https://example.org/'+id}}]}});
 const update=tasks=>send({type:'workspace.activity',conversationId:'group',ready:true,after:100,tasks});
 update([task('initial',80)]);update([task('window-backfill',90)]);assert.equal(opened.length,0);
 update([task('fresh',120)]);update([task('fresh',120)]);assert.equal(opened.length,1);assert.equal(opened[0].url,'https://example.org/fresh');
 active='files';update([task('other',130)]);assert.equal(opened.length,1);
});
