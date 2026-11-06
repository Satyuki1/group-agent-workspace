import {threadReference} from "../../../upstream/buzz-app/src/features/relay/thread-reference.ts";
/** Only explicit human mentions enter the initial execution path. */
export function addressedTo(event,agent) {
  const mentions=event.tags.filter(tag=>tag[0]==='p');
  // Native mention chips carry signed identity tags. Once present they are
  // authoritative: quoted @ names in instructions are not extra recipients.
  if(mentions.length)return mentions.some(tag=>tag[1]===agent.public_key);
  return event.content.includes(`nostr:${agent.public_key}`)
    || new RegExp(`(^|\\s)@${agent.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=\\s|[，。,:：!！?？]|$)`,'u').test(event.content);
}

/** Last completed assistant text, excluding reasoning, tool arguments and old turns. */
export function resultText(records,afterSeq) {
  const messages=records.filter(r=>r.type==='event' && r.event.type==='assistant/message' && r.event.seq>afterSeq)
    .sort((a,b)=>b.event.seq-a.event.seq);
  for(const {event}of messages.slice(0,1)) {
    const content=event.data?.message?.content;
    if(!Array.isArray(content))continue;
    if(content.some(p=>p.type==='tool-call'))return '';
    const value=content.filter(p=>p.type==='text' && typeof p.text==='string').map(p=>p.text).join('\n').trim();
    if(value)return value.slice(0,12000);
  }
  return '';
}

export function taskOutcome(events,requestId,afterSeq,foldConsumedWork) {
  const suffix=events.filter(e=>e.seq>afterSeq).sort((a,b)=>a.seq-b.seq);
  if(!suffix.some(e=>e.type==='user/message' && e.data.source?.rpcId===requestId))return 'unknown';
  const outcome=foldConsumedWork(suffix);
  return outcome.droppedUnrun?'aborted':outcome.end?.data.reason?.kind??'unknown';
}

export const sourceRoot = event => threadReference(event)?.rootId ?? event.id;
/** Keep the original ancestry; only final messages also appear in the group. */
export function taskReplyTags(task,purpose) {
  const root=task.input?.rootId??task.source_event_id;
  // NIP-CW includes broadcast depth-1 replies. Publish a final result under
  // the original root; its task tag still points to the exact source message.
  const parent=purpose==='task-result'?root:task.source_event_id;
  return [['h',task.conversation_id],['e',root,'','root'],['e',parent,'','reply'],['task',task.id],...(purpose==='task-result'?[['broadcast','1']]:[])];
}
