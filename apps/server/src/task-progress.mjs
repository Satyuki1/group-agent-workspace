import {browserResource} from '../../../integrations/dsh-bridge/browser-resource.mjs';
import {expandAssistantStream} from '../../../upstream/deepseek-harness/packages/llm/llm/src/assistant-stream.ts';
import {setTimeout as delay} from 'node:timers/promises';

// Project presentation data only. Raw reasoning, request headers, images and
// tool-private metadata never enter the product progress record.
const textOf=content=>(content??[]).filter(p=>p.type==='text').map(p=>p.text??'').join('\n');
export const publicText=value=>String(value??'').replace(/sk-[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9._~-]+/g,'[凭证已隐藏]').slice(0,16000);
function argumentsOf(value) {
  try{return publicText(JSON.stringify(JSON.parse(value),(key,item)=>/password|secret|token|api.?key|authorization|cookie/i.test(key)?'[已隐藏]':item,2)).slice(0,1000);}
  catch{return '参数正在生成';}
}
function replayEvent(e) {
  const d=e.data??{},event={seq:e.seq,time:e.time,type:e.type,data:{}};
  if(e.type==='user/message')event.data={source:{kind:d.source?.kind,rpcId:d.source?.rpcId}};
  else if(e.type==='assistant/message')event.data={message:{content:[{type:'text',text:publicText(textOf(d.message?.content)).slice(0,4000)}]}};
  else if(e.type==='tool/call')event.data={callId:d.callId,name:d.name,displayInput:argumentsOf(d.arguments),...(d.name==='open_browser'?{resource:browserResource(d.arguments)}:{})};
  else if(e.type==='tool/result')event.data={message:{toolCallId:d.message?.toolCallId,isError:d.message?.isError,content:[{type:'text',text:publicText(textOf(d.message?.content)).slice(0,1000)}]}};
  else if(e.type==='turn/end')event.data={reason:d.reason};
  else if(e.type!=='step/start')return;
  return event;
}
/** Pin one observed cut while recovering the exact task boundary before replay. */
export async function taskOpening(frame,task,page) {
  if(frame.type!=='snapshot')return frame;
  const base=Number(task.baseline_cursor),marker=r=>r.event.seq>base && r.event.type==='user/message' && r.event.data?.source?.rpcId===task.id;
  let current=frame,records=[],pages=0;
  while(true){
    records=[...current.records.map(r=>replayEvent(r.event)).filter(Boolean).map(event=>({type:'event',event})),...records];
    const low=Math.min(...current.records.map(r=>r.event.seq));
    if(records.some(marker) || !current.hasMore || low<=base || !Number.isFinite(low))break;
    if(++pages>64)throw new Error('Task progress history exceeds replay budget');
    const next=await page({throughSeq:frame.cursor,beforeSeq:low,maxMessages:200});
    if(!next.records.length || Math.min(...next.records.map(r=>r.event.seq))>=low)throw new Error('Progress history did not advance');
    current=next;
  }
  return {...frame,records};
}
export function progressProjector(task) {
  const base=Number(task.baseline_cursor??-1);
  let seen=false,ended=false,seq=base,attempt,revision=0,nextIndex=0,blocks=new Map();
  let value={phase:'preparing',text:'',tools:[],messages:[],...task.progress};
  const publish=patch=>{value={...value,...patch,updatedAt:new Date().toISOString(),revision:++revision};};
  function chunk(c) {
    if(!seen || ended)return;
    if(c.type==='reasoning-delta' || c.type==='block-start' && c.blockType==='reasoning')publish({phase:'thinking'});
    if(c.type==='text-delta'){blocks.set(c.index,((blocks.get(c.index)??'')+c.text).slice(0,16000));publish({phase:'answering',text:publicText([...blocks.values()].join('\n'))});}
    if(c.type==='tool-call-delta')publish({phase:'tool-input'});
    if(c.type==='block-end' && c.block?.type==='text'){blocks.set(c.index,c.block.text);publish({text:publicText([...blocks.values()].join('\n'))});}
  }
  function event(e) {
    if(e.seq<=base)return;
    if(e.type==='user/message'){
      if(e.data?.source?.rpcId===task.id)seen=true;
      else if(seen && (e.data?.source?.kind==='user' || e.data?.source?.rpcId))ended=true;
    }
    if(!seen || ended || e.seq<=seq)return;seq=e.seq;
    const d=e.data??{};
    if(e.type==='step/start'){blocks.clear();publish({phase:'thinking',text:''});}
    if(e.type==='assistant/message') {
      const text=publicText(textOf(d.message?.content));
      publish({text,messages:[...value.messages.filter(m=>m.seq!==e.seq),...(text?[{seq:e.seq,text:text.slice(0,4000)}]:[])].slice(-8)});
    }
    if(e.type==='tool/call')publish({phase:'tool-running',tools:[...value.tools.filter(t=>t.id!==d.callId),{id:d.callId,name:publicText(d.name).slice(0,100),...(d.name==='open_browser'?{resource:browserResource(d.resource??d.arguments)}:{}),input:typeof d.displayInput==='string'?publicText(d.displayInput).slice(0,1000):argumentsOf(d.arguments),state:'running'}].slice(-12)});
    if(e.type==='tool/result') {
      const message=d.message??{},id=message.toolCallId;
      publish({phase:'thinking',tools:value.tools.map(t=>t.id===id?{...t,...(Number.isFinite(e.time)?{completedAt:e.time}:{}),state:message.isError?'failed':'completed',output:publicText(textOf(message.content)).slice(0,1000)}:t)});
    }
    if(e.type==='turn/end')publish({phase:d.reason?.kind==='completed'?'done':'stopped'});
  }
  function accept(frame) {
    if(frame.type==='snapshot') {
      seen=false;ended=false;seq=base;
      if(!frame.records.some(r=>r.event.seq>base && r.event.type==='user/message' && r.event.data?.source?.rpcId===task.id)){
        publish({phase:'reconnecting'});return value;
      }
      value={phase:'preparing',text:'',tools:[],messages:[]};
      for(const r of [...frame.records].sort((a,b)=>a.event.seq-b.event.seq))event(r.event);
      const live=frame.assistantStream?.activeAttempt;
      if(seen && !ended && live && live.startedAfterSeq>=base) {
        attempt=live.attemptId;nextIndex=live.nextIndex;blocks.clear();publish({text:''});
        for(const item of expandAssistantStream(live.stream))chunk(item.chunk);
      }
    } else if(frame.type==='event')event(frame.event);
    else if(frame.type==='assistant-stream' && seen && !ended) {
      const f=frame.frame;
      if(f.type==='start' && f.startedAfterSeq>=base){attempt=f.attemptId;nextIndex=0;blocks.clear();publish({phase:'thinking',text:''});}
      if(f.type==='chunk' && f.attemptId===attempt && f.index===nextIndex){nextIndex++;chunk(f.chunk);}
    }
    return value;
  }
  return {accept,event,snapshot:()=>value,disconnected:()=>publish({phase:'reconnecting'})};
}

/** One native subscription per executing task, independent of browser lifetime. */
export function recordTaskProgress({task,pool,runtime,signal,log}) {
  const stop=new AbortController(),lifetime=AbortSignal.any([signal,stop.signal]);
  const projection=progressProjector(task);let saved='',saving;
  async function flush() {
    if(saving){await saving;return flush();}
    const value=projection.snapshot(),encoded=JSON.stringify(value);if(encoded===saved)return;
    saving=pool.query("UPDATE tasks SET progress=$2,updated_at=now() WHERE id=$1 AND lease_owner=$3 AND status='running'",[task.id,value,task.leaseOwner]);
    try{await saving;saved=encoded;}finally{saving=undefined;}
  }
  const timer=setInterval(()=>{if(!saving)void flush().catch(()=>{});},200);timer.unref();
  const pump=(async()=>{while(!lifetime.aborted){
    try{for await(const frame of runtime.follow(task.space_id,task.dsh_session_id,lifetime))projection.accept(await taskOpening(frame,task,bounds=>runtime.invoke(task.space_id,'session','page',{request:{address:{kind:'session',sessionId:task.dsh_session_id},...bounds}})));if(!lifetime.aborted)throw new Error('Progress stream closed');}
    catch(error){if(lifetime.aborted)break;projection.disconnected();log.warn({taskId:task.id,name:error.name},'Progress stream reconnecting');await delay(2000,undefined,{signal:lifetime}).catch(()=>{});}
  }})();
  return {
    async settle(){
      const page=await runtime.invoke(task.space_id,'session','page',{request:{address:{kind:'session',sessionId:task.dsh_session_id},maxMessages:200}});
      projection.accept(await taskOpening({type:'snapshot',...page},task,bounds=>runtime.invoke(task.space_id,'session','page',{request:{address:{kind:'session',sessionId:task.dsh_session_id},...bounds}})));
      await flush();
    },
    async close(){stop.abort();clearInterval(timer);await pump;await saving?.catch(()=>{});},
  };
}
