import {pathToFileURL} from 'node:url';
import {request as httpRequest} from 'node:http';
import {unseal} from './crypto.mjs';
import {httpError} from './auth.mjs';
import {signBridgeRequest} from '../../../integrations/dsh-bridge/auth.mjs';
import {sameScopes} from '../../../integrations/dsh-bridge/grants.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function createWorkspaces(app,pool,config,relay) {
  const {memberAuthority}=await import(pathToFileURL(`${config.upstreamRoot}/buzz-app/src/features/channel-members/administration-protocol.ts`).href);
  let author;
  const memberships=new Map(),membershipReads=new Map();
  async function authority() {
    if(author)return author;
    const response=await fetch(config.relayOrigin,{headers:{Accept:'application/nostr+json'},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw httpError(503,'暂时无法确认群权限');
    const value=await response.json(),key=value.self??value.pubkey;
    if(!/^[a-f0-9]{64}$/.test(key??''))throw new Error('Relay authority missing');
    author=key;return key;
  }
  async function readGroupAccess(account,conversation) {
    const relayAuthor=await authority();
    const key=Uint8Array.from(unseal(account.encrypted_key,config.vaultKey,account.id));
    try {
      const events=await relay.query(key,[{kinds:[39000,39001,39002],authors:[relayAuthor],'#d':[conversation],limit:3,consistency:'strong'}]);
      if(!events.length)throw httpError(403,'无权访问这个群');
      const access=memberAuthority(events,conversation,account.public_key,relayAuthor);
      if(!access.roles[account.public_key] || access.roles[account.public_key]==='unknown')throw httpError(403,'你不是这个群的成员');
      return {...access,channelType:events.find(event=>event.kind===39000)?.tags.find(tag=>tag[0]==='t')?.[1]};
    }finally{key.fill(0);}
  }
  async function groupAccess(account,conversation,{fresh=false}={}) {
    const id=account.id+':'+conversation,cached=memberships.get(id);
    if(!fresh && cached?.expires>Date.now())return cached.access;
    if(membershipReads.has(id))return membershipReads.get(id);
    const pending=readGroupAccess(account,conversation).then(access=>{
      if(memberships.size>1000)memberships.clear();
      memberships.set(id,{access,expires:Date.now()+2000});return access;
    },error=>{memberships.delete(id);throw error;}).finally(()=>membershipReads.delete(id));
    membershipReads.set(id,pending);return pending;
  }
  async function admit(account,space,options) {
    if(space.kind==='personal') {if(space.owner_id!==account.id)throw httpError(403,'无权访问这个空间');return;}
    return groupAccess(account,space.conversation_id,options);
  }
  async function binding(account,id) {
    const {rows}=await pool.query('SELECT s.*,r.endpoint,r.encrypted_bridge_key,r.state AS runtime_state FROM spaces s LEFT JOIN space_runtimes r ON r.space_id=s.id WHERE s.id=$1',[id]);
    const space=rows[0];if(!space)throw httpError(404,'空间不存在');
    await admit(account,space);
    if(space.runtime_state!=='ready' || !space.root_session_id)throw httpError(503,'工作空间尚未启动');
    if(space.endpoint!==`http://ga-space-${space.id}:3200`)throw new Error('Unexpected runtime endpoint');
    return space;
  }
  app.get('/api/app/conversations/:id/workspace',{preHandler:app.requireUser},async request=>{
    const id=request.params.id;if(!uuid.test(id))throw httpError(400,'会话标识无效');
    const {rows}=await pool.query(`SELECT s.*,r.state AS runtime_state,b.dsh_session_id AS conversation_session,b.ready AS conversation_ready,b.initialization_error AS conversation_error FROM spaces s LEFT JOIN space_runtimes r ON r.space_id=s.id LEFT JOIN session_bindings b ON b.space_id=s.id AND b.thread_id=$1
      WHERE s.conversation_id=$1 OR EXISTS(SELECT 1 FROM session_bindings b WHERE b.space_id=s.id AND b.thread_id=$1)`,[id]);
    const space=rows[0];
    if(!space){await groupAccess(request.account,id);return {state:'not-configured'};}
    const access=await admit(request.account,space);
    const pending=(await pool.query('SELECT count(*)::int AS pending,count(*) FILTER(WHERE initialization_error IS NOT NULL)::int AS failed FROM session_bindings WHERE space_id=$1 AND NOT ready',[space.id])).rows[0];
    const canRetry=space.kind==='personal' || !!access?.canManage;
    if(space.runtime_state==='failed' || space.conversation_error)return {state:'failed',message:'工作空间启动失败，请重试',canRetry};
    if(space.runtime_state!=='ready' || (space.kind==='personal' && !space.conversation_ready))return {state:'preparing'};
    return {state:'ready',spaceId:space.id,sessionId:space.kind==='personal'?space.conversation_session:space.root_session_id,url:`/workspace/${space.id}/?workspace-only=1`,warning:pending.failed?'有 Agent 未能启动，请重试':pending.pending?'正在准备 Agent…':undefined,canRetry:!!pending.failed && canRetry,pendingBindings:pending.pending,failedBindings:pending.failed};
  });
  app.post('/api/app/conversations/:id/workspace/retry',{preHandler:app.requireUser},async request=>{
    const id=request.params.id;if(!uuid.test(id))throw httpError(400,'会话标识无效');
    const {rows:[space]}=await pool.query(`SELECT s.* FROM spaces s WHERE s.conversation_id=$1 OR EXISTS(SELECT 1 FROM session_bindings b WHERE b.space_id=s.id AND b.thread_id=$1)`,[id]);
    if(!space)throw httpError(404,'工作空间不存在');
    const access=await admit(request.account,space,{fresh:true});
    if(space.kind!=='personal' && !access?.canManage)throw httpError(403,'请由群管理员重试');
    await pool.query('UPDATE session_bindings SET initialization_error=NULL WHERE space_id=$1 AND NOT ready',[space.id]);
    await pool.query("UPDATE space_runtimes SET state='starting',updated_at=now() WHERE space_id=$1 AND state='failed'",[space.id]);
    return {ok:true};
  });
  async function conversationAccess(account,conversation,options) {
    const {rows:[space]}=await pool.query(`SELECT s.* FROM spaces s WHERE s.conversation_id=$1 OR EXISTS(SELECT 1 FROM session_bindings b WHERE b.space_id=s.id AND b.thread_id=$1)`,[conversation]);
    if(space)await admit(account,space,options);
    return groupAccess(account,conversation,options);
  }
  const open=new Set();let sweeping=false;
  async function scopes(space) {
    const {rows}=await pool.query('SELECT dsh_session_id FROM session_bindings WHERE space_id=$1',[space.id]);
    const {rows:current}=await pool.query('SELECT root_session_id FROM spaces WHERE id=$1',[space.id]);
    return [...new Set([current[0]?.root_session_id,...rows.map(x=>x.dsh_session_id)].filter(Boolean))];
  }
  const timer=setInterval(async()=>{
    if(sweeping)return;sweeping=true;
    try {
      const checks=new Map();
      for(const stream of [...open]) {
        try {
          const id=stream.login+':'+stream.space.id;
          if(!checks.has(id))checks.set(id,(async()=>{
            const valid=await pool.query("SELECT 1 FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.state='active'",[stream.login]);
            if(!valid.rowCount)throw new Error('Session revoked');
            await admit(stream.account,stream.space,{fresh:true});
            return scopes(stream.space);
          })());
          if(!sameScopes(stream.sessions,await checks.get(id)))throw new Error('Workspace scope changed');
        }catch {stream.raw.destroy();}
      }
    }finally{sweeping=false;}
  },5000);timer.unref();
  app.addHook('onRequest',async(request,reply)=>{
    if(!request.url.startsWith('/workspace/'))return;
    await app.requireUser(request);
    const parsed=new URL(request.url,'http://app'),parts=parsed.pathname.split('/'),id=parts[2];
    if(!uuid.test(id??''))throw httpError(400,'空间标识无效');
    const suffix='/'+parts.slice(3).join('/');
    if(decodeURIComponent(suffix).startsWith('/_control') || suffix.startsWith('//') || decodeURIComponent(suffix).includes('..'))throw httpError(403,'接口不可用');
    if(!['GET','POST'].includes(request.method))throw httpError(405,'不支持此操作');
    const space=await binding(request.account,id);
    const claim={space:id,user:request.account.id,login:request.authSession.hash,expires:Date.now()+60_000,sessions:await scopes(space)};
    const secret=unseal(space.encrypted_bridge_key,config.vaultKey,`bridge:${id}`).toString();
    const target=new URL(space.endpoint);target.pathname=suffix;target.search=parsed.search;
    const chunks=[];let size=0;
    for await(const chunk of request.raw){size+=chunk.length;if(size>4*1024*1024)throw httpError(413,'请求过大');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);
    const headers=signBridgeRequest(secret,{method:request.method,path:target.pathname+target.search,body:bytes,claim:Buffer.from(JSON.stringify(claim)).toString('base64url')});
    headers['content-length']=String(bytes.length);
    for(const name of ['content-type','accept'])if(request.headers[name])headers[name]=request.headers[name];
    reply.hijack();
    const entry={raw:reply.raw,login:claim.login,account:request.account,space,sessions:claim.sessions};open.add(entry);
    const upstream=httpRequest(target,{method:request.method,headers},response=>{
      const output={...response.headers,'cache-control':'no-store'};delete output['set-cookie'];
      reply.raw.writeHead(response.statusCode??502,output);response.on('error',()=>reply.raw.destroy());response.pipe(reply.raw);
    });
    upstream.on('error',()=>{if(!reply.raw.headersSent){reply.raw.writeHead(502,{'content-type':'application/json'});reply.raw.end('{"error":"工作空间连接失败，请重试"}');}else reply.raw.destroy();});
    reply.raw.once('close',()=>{open.delete(entry);upstream.destroy();});
    request.raw.once('aborted',()=>upstream.destroy());upstream.end(bytes);
  });
  return {
    admit,groupAccess,binding,conversationAccess,
    revoke(login){for(const entry of open)if(entry.login===login)entry.raw.destroy();},
    close(){clearInterval(timer);for(const entry of open)entry.raw.destroy();},
  };
}
