import {randomUUID} from 'node:crypto';
import {httpError} from './auth.mjs';

/** Match deliberate handoff lines, not names in prose, quotations or code. */
export function handoffMentions(text,peers) {
  const counts=new Map();
  for(const peer of peers)counts.set(peer.name,(counts.get(peer.name)??0)+1);
  const choices=peers.flatMap(peer=>[
    {label:`@nostr:${peer.public_key}`,peer},
    ...(counts.get(peer.name)===1?[{label:`@${peer.name}`,peer}]:[]),
  ]).sort((a,b)=>b.label.length-a.label.length);
  const found=[];let offset=0,fence;
  for(const line of text.split('\n')) {
    const marker=line.trimStart().match(/^(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=undefined;}
    else if(!fence && !/^(?: {4}|\t)/.test(line)) {
      const prefix=line.match(/^\s*(?:(?:[-*+] |\d+[.)、]\s+))?/)[0];
      let at=prefix.length;const tokens=[];
      while(line[at]==='@') {
        const choice=choices.find(item=>line.startsWith(item.label,at) && /^(?:\s|[，,:：]|$)/u.test(line.slice(at+item.label.length)));
        if(!choice)break;
        tokens.push({peer:choice.peer,start:offset+at,end:offset+at+choice.label.length});
        at+=choice.label.length;
        at+=line.slice(at).match(/^[\s，,:：]*/u)[0].length;
      }
      if(line.slice(at).trim())found.push(...tokens);
    }
    offset+=line.length+1;
  }
  return found;
}

export function handoffLimit(ancestors,total,agentId) {
  if(!ancestors.length || ancestors.some(t=>t.cancel_requested || t.status!=='completed'))return '本轮协作已停止';
  if(ancestors.length>=5)return '本轮协作已达到 4 次交接上限';
  if(total>=8)return '本轮协作已达到 8 个任务上限';
  if(ancestors.filter(t=>t.agent_id===agentId).length>=2)return '同一智能体在本轮已处理两次，已停止重复唤醒';
}

/** Read the real signed membership using the sending Agent's own identity. */
export async function groupAgentPeers(task,agent,{pool,workspaces}) {
  if(task.space_kind==='personal' || task.input?.agentCollaboration!==1)return [];
  const access=await workspaces.groupAccess(agent,task.conversation_id,{fresh:true});
  if(access.channelType==='dm' || access.roles[agent.public_key]!=='bot')throw httpError(403,'智能体已离开当前群聊');
  const {rows}=await pool.query(`SELECT a.id,a.name,a.public_key,b.id AS binding_id FROM agents a
    JOIN agent_memberships m ON m.agent_id=a.id AND m.space_id=$1 AND m.active
    JOIN session_bindings b ON b.agent_id=a.id AND b.space_id=m.space_id AND b.ready
    JOIN spaces s ON s.id=m.space_id
    WHERE a.enabled AND a.id<>$2 AND COALESCE(NULLIF(b.thread_id,''),s.conversation_id)=$3 ORDER BY a.name,a.id`,[task.space_id,agent.id,task.conversation_id]);
  return rows.filter(peer=>access.roles[peer.public_key]==='bot');
}

export function collaborationPrompt(peers,task) {
  if(!peers.length)return '';
  return `\n群内可协作的其他智能体：\n${peers.map(p=>`${p.name}（@nostr:${p.public_key}）`).join('\n')}\n需要交接任务或请对方汇总时，在最终群回复中单独一行写“@智能体名称 具体任务或交接结果”，也可用列表中的 @nostr:公钥，服务器会发送真实提及并安排对方执行。重名时必须用公钥。只提及确实需要继续处理的对象；普通介绍、致谢、举例、引用不要使用交接行。无需交接时直接回复即可。最多交接 4 次、共 8 个任务，同一智能体最多处理两次。${task.parent_id?`本次是其他智能体交来的群任务，不能冒充原发起人；按需要反馈交接结果。`:''}\n`;
}

/** One transaction owns result publication and admission. Retrying finish cannot
 * create another handoff. Children wait for the signed source event to be sent. */
export async function prepareHandoffs(client,task,text,peers) {
  const tokens=handoffMentions(text,peers);
  if(!tokens.length)return {content:text,tags:[],children:[]};
  const {rows:ancestors}=await client.query(`WITH RECURSIVE chain AS (
    SELECT id,parent_id,agent_id,status,cancel_requested,0 AS depth FROM tasks WHERE id=$1
    UNION ALL SELECT t.id,t.parent_id,t.agent_id,t.status,t.cancel_requested,c.depth+1
    FROM tasks t JOIN chain c ON t.id=c.parent_id WHERE c.depth<16
  ) SELECT * FROM chain ORDER BY depth`,[task.id]);
  const root=ancestors.at(-1);
  if(!root || root.parent_id)throw new Error('Invalid collaboration ancestry');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`agent-chain:${root.id}`]);
  const {rows:[count]}=await client.query("SELECT count(*)::int AS total FROM tasks WHERE id=$1::uuid OR input->>'collaborationRoot'=$1::text",[root.id]);
  let total=count.total;const children=[],denied=[],accepted=new Set();
  for(const peer of new Map(tokens.map(t=>[t.peer.id,t.peer])).values()) {
    const reason=handoffLimit(ancestors,total,peer.id);
    if(reason){denied.push(`${peer.name}：${reason}`);continue;}
    accepted.add(peer.id);total++;
    children.push({id:randomUUID(),agent_id:peer.id,binding_id:peer.binding_id,input:{agentCollaboration:1,collaborationRoot:root.id,author:task.agent.name,rootId:task.input.rootId??task.source_event_id,senderAgentId:task.agent_id}});
  }
  let content=text;
  // Buzz renders exact @ names against signed p tags. Keep its native mention
  // format rather than exposing protocol keys in the conversation body.
  for(const token of [...tokens].reverse())if(accepted.has(token.peer.id))content=content.slice(0,token.start)+`@${token.peer.name}`+content.slice(token.end);
  if(denied.length)content+=`\n\n协作提示：以下提及未继续执行，${denied.join('；')}。需要继续时请由群成员重新发起。`;
  return {content,tags:[...new Map(tokens.filter(t=>accepted.has(t.peer.id)).map(t=>[t.peer.id,['p',t.peer.public_key]])).values(),...(children.length?[['agent-handoff','1']]:[])],children};
}

export async function enqueueHandoffs(client,task,event,children) {
  for(const child of children)await client.query(`INSERT INTO tasks(id,space_id,agent_id,requester_id,source_event_id,parent_id,session_binding_id,input,status,lane)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued','slow') ON CONFLICT(agent_id,space_id,source_event_id) DO NOTHING`,
    [child.id,task.space_id,child.agent_id,task.requester_id,event.id,task.id,child.binding_id,{...child.input,text:event.content}]);
}
