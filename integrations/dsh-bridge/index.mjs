import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {once} from 'node:events';
import {memberBindings} from './policy.mjs';
import {bridgeVerifier} from './auth.mjs';
import {replaceGrant,dropGrant} from './grants.mjs';

export const name='group-agent-bridge';
export const inject=['connection','typertGateway','remoteAccess','webServer','clientModules','workspaceRegistry','sessionController'];

const fail=(status,message)=>Object.assign(new Error(message),{status});
async function body(req) {
  const chunks=[];let size=0;
  for await(const chunk of req) {size+=chunk.length;if(size>4*1024*1024)throw fail(413,'request-too-large');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
function json(res,status,value) {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
function queue(signal) {
  let items=[],wake,ended=false;
  signal.addEventListener('abort',()=>{ended=true;wake?.();},{once:true});
  return {
    push(value) {if(ended)throw fail(410,'stream-closed');if(items.length>=128)throw fail(429,'uplink-full');items.push(value);wake?.();},
    end(){ended=true;wake?.();},
    async *[Symbol.asyncIterator]() {while(!ended || items.length){if(items.length)yield items.shift();else await new Promise(resolve=>{wake=resolve;});}},
  };
}

/** Loaded by the normal `dsh --profile web --patch` composition. */
export async function apply(ctx,config={}) {
  const verifyProof=bridgeVerifier(await readFile(process.env.GROUP_AGENT_BRIDGE_PUBLIC_KEY_FILE??'/run/space/bridge.pub','utf8'));
  const spaceId=process.env.GROUP_AGENT_SPACE_ID;
  if(!spaceId)throw new Error('Missing space identity');
  const grants=new Map(),peers=new Map(),streams=new Map();
  const control=ctx.connection.createPeer({principal:{kind:'owner'},interactions:'none'});
  const fetcher=ctx.connection.createSharedFetchHandler('/api');
  const transport=await readFile(new URL('./transport.js',import.meta.url),'utf8');
  const root=process.env.GROUP_AGENT_WORKSPACE??'/work';
  const release=ctx.remoteAccess.registerPolicy('group-member',{
    bindings:principal=>memberBindings(principal,grants,ctx.workspaceRegistry.list(),root),
  });
  // Native clients answer interaction events. Every forwarded event still passes
  // remoteAccess; this enables the transport, not owner privileges.
  const grantState={grants,peers,streams,invalidate:()=>ctx.remoteAccess.invalidate(),createPeer:claim=>ctx.connection.createPeer({principal:{kind:'group-member',user:claim.user,login:claim.login},interactions:'answer'})};
  const drop=login=>dropGrant(login,grantState);
  async function member(req) {
    let claim;
    try {claim=JSON.parse(Buffer.from(req.headers['x-group-claim']??'','base64url').toString());}catch{throw fail(403,'invalid-claim');}
    if(claim.space!==spaceId || !/^[a-f0-9]{64}$/.test(claim.login??'') || typeof claim.user!=='string' || !Array.isArray(claim.sessions) || claim.sessions.length>1000 || claim.sessions.some(x=>typeof x!=='string') || !Number.isFinite(claim.expires) || claim.expires<=Date.now() || claim.expires>Date.now()+65_000)throw fail(403,'invalid-claim');
    return {claim,peer:await replaceGrant({...grantState,claim})};
  }
  const server=createServer(async(req,res)=>{
    const lifetime=new AbortController();
    res.once('close',()=>lifetime.abort());
    try {
      const bytes=await body(req);
      verifyProof({method:req.method,path:req.url,body:bytes,headers:req.headers});
      const url=new URL(req.url,'http://bridge');
      if(url.pathname==='/_control/health')return json(res,200,{ready:true,spaceId});
      if(url.pathname==='/_control/follow' && req.method==='POST') {
        const {sessionId}=JSON.parse(bytes);
        if(typeof sessionId!=='string' || sessionId.length>160)throw fail(400,'invalid-session');
        const frames=ctx.sessionController.follow({address:{kind:'session',sessionId},maxMessages:200,assistantStream:true},lifetime.signal);
        res.writeHead(200,{'content-type':'application/x-ndjson','cache-control':'no-store','x-accel-buffering':'no'});res.flushHeaders();
        for await(const frame of frames)if(!res.write(JSON.stringify(frame)+'\n'))await once(res,'drain',{signal:lifetime.signal});
        res.end();return;
      }
      if(url.pathname==='/_control/revoke' && req.method==='POST') {await drop(JSON.parse(bytes).login);return json(res,200,{ok:true});}
      if(url.pathname==='/_control/invoke' && req.method==='POST') {
        const value=JSON.parse(bytes);
        const allowed=new Set(['session/create','session/selectModel','session/prompt','session/cancel','session/updateQueue','session/list','session/state','session/page','session/wait','session/modelCatalog']);
        if(!allowed.has(`${value.namespace}/${value.method}`))throw fail(403,'control-method-denied');
        const result=await ctx.typertGateway.invoke({...value,peer:control,signal:lifetime.signal});
        return json(res,200,{value:result});
      }
      const {claim,peer}=await member(req);
      if(url.pathname==='/_bridge/heartbeat')return json(res,200,{ok:true});
      if(url.pathname==='/_bridge/uplink' && req.method==='POST') {
        const value=JSON.parse(bytes),stream=streams.get(value.id);
        if(!stream || stream.login!==claim.login)throw fail(404,'stream-not-found');
        if(value.end)stream.queue.end();else stream.queue.push(value.value);
        return json(res,200,{ok:true});
      }
      if(url.pathname==='/_bridge/stream' && req.method==='POST') {
        const value=JSON.parse(bytes);
        if(typeof value.id!=='string' || value.id.length>80 || streams.has(value.id))throw fail(400,'invalid-stream-id');
        if(streams.size>=128)throw fail(429,'too-many-streams');
        const input=queue(lifetime.signal);
        const iterable=await ctx.typertGateway.wireStream.open(value.endpoint,value.payload,input,peer,lifetime.signal);
        streams.set(value.id,{login:claim.login,queue:input,controller:lifetime});
        res.writeHead(200,{'content-type':'application/x-ndjson','cache-control':'no-store','x-accel-buffering':'no'});
        res.flushHeaders();
        try {
          for await(const frame of iterable)if(!res.write(JSON.stringify({value:frame})+'\n'))await once(res,'drain',{signal:lifetime.signal});
        } catch(error) {if(!lifetime.signal.aborted)res.write(JSON.stringify({error:ctx.typertGateway.wireStream.failure(error)})+'\n');}
        finally {input.end();streams.delete(value.id);res.end();}
        return;
      }
      if(url.pathname.startsWith('/api/') && req.method==='POST') {
        const response=await fetcher.fetch(new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:bytes,signal:lifetime.signal}),peer);
        res.writeHead(response.status,Object.fromEntries(response.headers));
        if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
        return;
      }
      if(req.method!=='GET')throw fail(405,'method-not-allowed');
      let response=url.pathname.startsWith('/plugins/')?await ctx.clientModules.fetchBundle(new Request(url)):await ctx.webServer.readResource(new Request(url),peer);
      if(response.headers.get('content-type')?.includes('text/html')) {
        // Parent and subapplication share an authenticated origin. No owner cookie
        // or credential is serialized into the page or postMessage protocol.
        const base=`/workspace/${encodeURIComponent(spaceId)}/`;
        const source=(await response.text()).replace(/(src|href)="\/(?!\/)/g,`$1="${base}`);
        const bootstrap=`<base href="${base}"><script>globalThis.__GROUP_SPACE__=${JSON.stringify(spaceId)};globalThis.__DSH_LOCALE__={read:async()=>({languages:['zh-CN'],preference:'zh'}),onChange:()=>{}};${transport}</script>`;
        response=new Response(source.replace('<head>','<head>'+bootstrap),{status:response.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
      }
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
    } catch(error) {if(!error.status)console.error('group bridge:',req.method,new URL(req.url,'http://bridge').pathname,error.message);if(!res.headersSent)json(res,error.status??500,{error:error.status?error.message:'bridge-failed'});else res.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port??3200,'0.0.0.0',resolve);});
  const timer=setInterval(()=>{for(const [login,grant]of grants)if(grant.expires<=Date.now())void drop(login);},5000);timer.unref();
  ctx.effect(()=>()=>{clearInterval(timer);release();for(const login of peers.keys())void drop(login);void control.dispose();server.closeAllConnections();server.close();},'group-agent bridge lifetime');
}
