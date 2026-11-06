import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {generateSecretKey,getPublicKey} from 'nostr-tools';
import {z} from 'zod';
import {transaction} from './db.mjs';
import {seal,digest,unseal} from './crypto.mjs';
import {httpError} from './auth.mjs';

export const canUseAgent=(account,agent)=>agent.owner_id===account.id || agent.role==='coordinator';
export const privateParticipants=(access,userKey,agentKey)=>Object.keys(access.roles).length===2 && Boolean(access.roles[userKey] && access.roles[userKey]!=='unknown' && access.roles[agentKey] && access.roles[agentKey]!=='unknown');

/** One identity per Agent. Registration goes through the existing durable outbox. */
export async function mountTeamIM(app,pool,config,relay,workspaces) {
  const publicAgent=a=>({id:a.id,name:a.name,publicKey:a.public_key,kind:'agent',ready:a.enabled,avatar:a.avatar});
  async function agentFor(account,id) {
    const {rows:[agent]}=await pool.query('SELECT * FROM agents WHERE id=$1',[id]);
    if(!agent || !canUseAgent(account,agent))throw httpError(404,'找不到这个 Agent');
    return agent;
  }
  app.get('/api/app/directory',{preHandler:app.requireUser},async request=>{
    const people=(await pool.query("SELECT id,display_name AS name,public_key AS \"publicKey\" FROM users WHERE state='active' AND id<>$1 ORDER BY display_name",[request.account.id])).rows;
    const agents=(await pool.query("SELECT * FROM agents WHERE owner_id=$1 OR role='coordinator' ORDER BY created_at",[request.account.id])).rows;
    return {people:people.map(person=>({...person,kind:'person',ready:true})),agents:agents.map(publicAgent)};
  });
  app.get('/api/app/agents/:id',{preHandler:app.requireUser},async request=>{
    z.object({id:z.uuid()}).parse(request.params);
    return publicAgent(await agentFor(request.account,request.params.id));
  });
  app.post('/api/app/agents',{preHandler:app.requireUser},async request=>{
    const input=z.object({id:z.uuid(),name:z.string().trim().min(1).max(40),instructions:z.string().trim().min(1).max(4000),avatar:z.string().regex(/^(spark|orbit|pebble|bloom)-(rose|blue|mint|violet|amber|prism)$/).optional()}).strict().parse(request.body);
    await transaction(pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[input.id]);
      const {rows:[existing]}=await client.query('SELECT * FROM agents WHERE id=$1',[input.id]);
      if(existing){if(existing.owner_id!==request.account.id || existing.name!==input.name || existing.instructions!==input.instructions || (input.avatar!==undefined && existing.avatar!==input.avatar))throw httpError(409,'创建请求已变化，请重新打开表单');return;}
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`agent-owner:${request.account.id}`]);
      if((await client.query('SELECT 1 FROM agents WHERE owner_id=$1',[request.account.id])).rowCount>=20)throw httpError(409,'试用版每人最多创建 20 个 Agent');
      const key=generateSecretKey();
      try {
        const pubkey=getPublicKey(key);
        await client.query("INSERT INTO agents(id,owner_id,public_key,encrypted_key,name,instructions,avatar,role,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,'personal',false)",[input.id,request.account.id,pubkey,seal(key,config.vaultKey,input.id),input.name,input.instructions,input.avatar??'spark-rose']);
        const enroll=relay.sign(config.ownerKey,{kind:9030,tags:[['p',pubkey],['role','member']],content:''});
        const profile=relay.sign(key,{kind:0,tags:[],content:JSON.stringify({name:input.name,display_name:input.name,is_agent:true,picture:`${config.publicOrigin}/avatars/${input.avatar??'spark-rose'}.svg`})});
        for(const [event,purpose]of [[enroll,'enroll-agent'],[profile,'agent-profile']])await client.query('INSERT INTO relay_outbox(event_id,actor_public_key,event,purpose,subject_id) VALUES($1,$2,$3,$4,$5)',[event.id,event.pubkey,event,purpose,input.id]);
      } finally {key.fill(0);}
    });
    // Return readiness from registration evidence, not an optimistic UI flag.
    for(let i=0;i<24;i++){
      const agent=await agentFor(request.account,input.id);
      if(agent.enabled)return publicAgent(agent);
      await delay(250);
    }
    return publicAgent(await agentFor(request.account,input.id));
  });

  async function connectAgent(account,agentId,conversationId,{existingMemberOnly=false}={}) {
    const agent=await agentFor(account,agentId);
    if(!agent.enabled)throw httpError(409,'Agent 正在创建，请稍后重试');
    let access=await workspaces.groupAccess(account,conversationId,{fresh:true});
    const personal=access.channelType==='dm';
    if(personal){
      if(!privateParticipants(access,account.public_key,agent.public_key))throw httpError(403,'Agent 私聊只能包含你和这个 Agent');
    } else {
      if(!access.canManage)throw httpError(403,'只有群管理员可以邀请 Agent');
      if(existingMemberOnly && access.roles[agent.public_key]!=='bot')throw httpError(403,'尚未确认 Agent 的群成员授权');
      if(!access.roles[agent.public_key]){
        if(existingMemberOnly)throw httpError(403,'Agent 尚未加入这个群');
        const key=unseal(account.encrypted_key,config.vaultKey,account.id);
        try {await relay.publish(key,relay.sign(key,{kind:9000,tags:[['h',conversationId],['p',agent.public_key],['role','bot']],content:''}));}
        finally{key.fill(0);}
        access=await workspaces.groupAccess(account,conversationId,{fresh:true});
        if(!access.roles[agent.public_key])throw httpError(503,'尚未确认 Agent 入群，请重试');
      }
    }
    const result=await transaction(pool,async client=>{
      const scope=personal?`person:${account.id}`:`group:${conversationId}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[scope]);
      let {rows:[space]}=await client.query(personal?"SELECT * FROM spaces WHERE kind='personal' AND owner_id=$1":"SELECT * FROM spaces WHERE conversation_id=$1",[personal?account.id:conversationId]);
      if(!space){
        await client.query('SELECT pg_advisory_xact_lock(71241109)');
        if((await client.query('SELECT id FROM spaces')).rowCount>=6)throw httpError(409,'当前试用服务器最多开放 6 个工作空间，请联系管理员');
        const id=randomUUID(),session=randomUUID(),token=randomBytes(32).toString('base64url');
        const pair=generateKeyPairSync('ed25519');
        const privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'});
        const plan={spaceId:id,sessionId:session,publicKey:pair.publicKey.export({format:'pem',type:'spki'}),token};
        space=(await client.query('INSERT INTO spaces(id,kind,owner_id,conversation_id,root_session_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,personal?'personal':'group',personal?account.id:null,personal?null:conversationId,session])).rows[0];
        await client.query("INSERT INTO space_runtimes(space_id,endpoint,encrypted_bridge_key,state) VALUES($1,$2,$3,'starting')",[id,`http://ga-space-${id}:3200`,seal(Buffer.from(privateKey),config.vaultKey,`bridge:${id}`)]);
        await client.query("INSERT INTO runtime_credentials(token_hash,space_id,expires_at) VALUES($1,$2,now()+interval '24 hours')",[digest(token),id]);
        await client.query('INSERT INTO settings(key,value) VALUES($1,$2)',[`runtime.plan:${id}`,{encrypted:seal(Buffer.from(JSON.stringify(plan)),config.vaultKey,`runtime-plan:${id}`)}]);
      }
      const existing=(await client.query('SELECT * FROM session_bindings WHERE space_id=$1 AND agent_id=$2 AND thread_id=$3',[space.id,agent.id,personal?conversationId:''])).rows[0];
      if(!existing){
        const first=!(await client.query('SELECT 1 FROM session_bindings WHERE space_id=$1',[space.id])).rowCount;
        await client.query('INSERT INTO session_bindings(id,space_id,agent_id,thread_id,dsh_session_id,ready) VALUES($1,$2,$3,$4,$5,false)',[randomUUID(),space.id,agent.id,personal?conversationId:'',first?space.root_session_id:randomUUID()]);
      }
      await client.query('UPDATE session_bindings SET initialization_error=NULL WHERE space_id=$1 AND agent_id=$2 AND NOT ready',[space.id,agent.id]);
      await client.query('INSERT INTO agent_memberships(agent_id,space_id) VALUES($1,$2) ON CONFLICT(agent_id,space_id) DO UPDATE SET active=true',[agent.id,space.id]);
      await client.query("UPDATE space_runtimes SET state='starting',updated_at=now() WHERE space_id=$1 AND state='failed'",[space.id]);
      return {spaceId:space.id,conversationId,state:existing?.ready?'ready':'preparing'};
    });
    return result;
  }
  app.post('/api/app/agents/:id/conversations',{preHandler:app.requireUser},async request=>{
    z.object({id:z.uuid()}).parse(request.params);
    const {conversationId}=z.object({conversationId:z.uuid()}).strict().parse(request.body);
    return connectAgent(request.account,request.params.id,conversationId);
  });
  return {connectAgent};
}
