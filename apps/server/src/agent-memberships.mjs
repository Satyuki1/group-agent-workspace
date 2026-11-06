import {unseal} from './crypto.mjs';
import {canUseAgent} from './team-im.mjs';

/** Reconcile only an actual signed invitation, never infer consent from @ text. */
export function invitationAllowed(account,agent,access) {
  return !!account && canUseAgent(account,agent) && access.channelType!=='dm' && access.canManage && access.roles[agent.public_key]==='bot';
}
export function agentMembershipReconciler({pool,relay,config,workspaces,teamIM,log}) {
  let next=0;
  return async signal=>{
    if(Date.now()<next)return;next=Date.now()+4000;
    const {rows:agents}=await pool.query('SELECT * FROM agents WHERE enabled');
    const {rows:bindings}=await pool.query("SELECT b.agent_id,COALESCE(NULLIF(b.thread_id,''),s.conversation_id) AS conversation FROM session_bindings b JOIN spaces s ON s.id=b.space_id");
    const known=new Set(bindings.map(b=>b.agent_id+':'+b.conversation));
    for(const agent of agents){
      if(signal.aborted)return;
      let key;
      try{
        key=unseal(agent.encrypted_key,config.vaultKey,agent.id);
        const groups=await relay.query(key,[{kinds:[39002],'#p':[agent.public_key],limit:100,consistency:'strong'}]);
        for(const group of groups){
          if(signal.aborted)return;
          const id=group.tags.find(t=>t[0]==='d')?.[1];
          if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id??'') || known.has(agent.id+':'+id))continue;
          try {
          const joins=await relay.query(key,[{kinds:[9000],'#h':[id],'#p':[agent.public_key],limit:1,consistency:'strong'}]);
          const join=joins[0];if(!join || !join.tags.some(t=>t[0]==='role' && t[1]==='bot'))continue;
          const {rows:[account]}=await pool.query("SELECT * FROM users WHERE public_key=$1 AND state='active'",[join.pubkey]);
          if(!account || !canUseAgent(account,agent))continue;
          const access=await workspaces.groupAccess(account,id,{fresh:true});
          if(!invitationAllowed(account,agent,access))continue;
          await teamIM.connectAgent(account,agent.id,id,{existingMemberOnly:true});
          known.add(agent.id+':'+id);log.info({agentId:agent.id,conversationId:id},'Joined Agent execution binding prepared');
          }catch(error){log.warn({agentId:agent.id,conversationId:id,name:error.name,status:error.statusCode??error.status},'Agent group binding will resume');}
        }
      }catch(error){log.warn({agentId:agent.id,name:error.name,status:error.statusCode??error.status},'Agent membership reconciliation will resume');}
      finally{key?.fill(0);}
    }
  };
}

/** Context is read with this Agent's actual group membership, never its private session. */
export async function recentGroupContext(task,agent,{pool,relay,config}) {
  if(task.space_kind==='personal')return '';
  const key=unseal(agent.encrypted_key,config.vaultKey,agent.id);
  try{
    const [source]=await relay.query(key,[{ids:[task.source_event_id],kinds:[9],'#h':[task.conversation_id],limit:1,consistency:'strong'}]);
    if(!source || source.id!==task.source_event_id || !source.tags.some(t=>t[0]==='h' && t[1]===task.conversation_id))return '';
    const events=await relay.query(key,[{kinds:[9],'#h':[task.conversation_id],until:source.created_at,limit:20,consistency:'strong'}]);
    const {rows}=await pool.query('SELECT public_key,display_name AS name FROM users UNION ALL SELECT public_key,name FROM agents');
    const names=new Map(rows.map(row=>[row.public_key,row.name]));
    const ordered=events.filter(e=>e.id!==source.id && e.tags.some(t=>t[0]==='h' && t[1]===task.conversation_id)).sort((a,b)=>b.created_at-a.created_at || b.id.localeCompare(a.id));
    const lines=[];let remaining=12000;
    for(const event of ordered){
      const label=`[${new Date(event.created_at*1000).toISOString()} · ${names.get(event.pubkey)??'群成员'}] `;
      const limit=Math.min(4000,remaining-label.length-80);if(limit<=0)break;
      const excerpt=event.content.slice(0,limit)+(event.content.length>limit?'\n[引用摘录已截断；不能据此判断原消息发送是否完整]':'');
      const line=label+excerpt;lines.push(line);remaining-=line.length+1;
    }
    return lines.reverse().join('\n');
  }finally{key.fill(0);}
}
