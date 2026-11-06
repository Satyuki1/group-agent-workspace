import { createServer, request as httpRequest } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { unseal } from './crypto.mjs';
import { httpError } from './auth.mjs';
import WebSocket from 'ws';

/** Each authenticated identity gets its own upstream host, signer and streams. */
export async function createBrokers(config,pool) {
  const {relayBrokerPlugin}=await import(pathToFileURL(`${config.upstreamRoot}/buzz-app/browser-host/relay-broker.mjs`).href);
  const hosts=new Map(), streams=new Map();

  async function open(account) {
    const key=Uint8Array.from(unseal(account.encrypted_key,config.vaultKey,account.id));
    let handler;
    const server=createServer((req,res)=>handler(req,res,()=>{res.writeHead(404);res.end();}));
    await mkdir(`${config.hostData}/users/${account.id}`,{recursive:true,mode:0o700});
    const plugin=relayBrokerPlugin({
      identity:()=>key,
      relayUrl:config.relayOrigin,
      archiveFile:`${config.hostData}/users/${account.id}/archive.sqlite3`,
      agentLibrary:async()=>({definitions:[],identities:[]}),
      socketFactory:url=>{
        const target=new URL(url);
        if(target.protocol!=='wss:' || `https://${target.host}`!==config.relayOrigin || target.username || target.password)throw httpError(403,'Only the configured team relay is allowed');
        return new WebSocket(url);
      },
      upstreamFetch:async(url,options)=>{
        if(new URL(url).origin!==config.relayOrigin)throw httpError(403,'Only the configured team relay is allowed');
        return fetch(url,options);
      },
    });
    try {
      plugin.configResolved({server:{host:'127.0.0.1'}});
      await plugin.configureServer({httpServer:server,middlewares:{use:fn=>{handler=fn;}}});
      if(!handler)throw new Error('Buzz browser host did not register its handler');
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      return {server,port:server.address().port,lastUse:Date.now(),active:0};
    } catch(error) {key.fill(0);server.close();throw error;}
  }
  async function host(account) {
    if(!hosts.has(account.id)) {
      if(hosts.size>=20)throw httpError(503,'当前在线身份已达到试用容量，请稍后重试');
      const opening=open(account);hosts.set(account.id,opening);
      opening.catch(()=>{if(hosts.get(account.id)===opening)hosts.delete(account.id);});
    }
    const item=await hosts.get(account.id);item.lastUse=Date.now();return item;
  }
  function revoke(session) {for(const stream of streams.get(session)??[])stream.destroy();streams.delete(session);}
  let sweeping=false;
  const sweep=setInterval(async()=>{
    if(sweeping)return;
    sweeping=true;
    try {
      const keys=[...streams.keys()];
      if(keys.length) {
        const {rows}=await pool.query("SELECT s.token_hash FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=ANY($1::text[]) AND s.expires_at>now() AND u.state='active'",[keys]);
        const valid=new Set(rows.map(row=>row.token_hash));
        for(const key of keys)if(!valid.has(key))revoke(key);
      }
    } catch {for(const key of streams.keys())revoke(key);}
    finally {sweeping=false;}
    for(const [id,pending] of hosts)void pending.then(item=>{
      if(!item.active && Date.now()-item.lastUse>15*60_000 && hosts.get(id)===pending){hosts.delete(id);item.server.close();}
    },()=>{});
  },5000);sweep.unref();

  return {
    async proxy(request,reply) {
      const item=await host(request.account);
      item.active++;
      const origin=`http://127.0.0.1:${item.port}`;
      const headers={...request.headers,host:`127.0.0.1:${item.port}`,origin,'sec-fetch-site':'same-origin'};
      delete headers.cookie;delete headers.authorization;delete headers['x-app-csrf'];
      delete headers['x-forwarded-host'];delete headers['x-forwarded-proto'];delete headers['x-forwarded-for'];
      reply.hijack();
      const raw=reply.raw;
      const session=request.authSession.hash;
      if(!streams.has(session))streams.set(session,new Set());
      streams.get(session).add(raw);
      let settled=false;
      const finish=()=>{if(settled)return;settled=true;item.active--;item.lastUse=Date.now();streams.get(session)?.delete(raw);if(streams.get(session)?.size===0)streams.delete(session);};
      const upstream=httpRequest({hostname:'127.0.0.1',port:item.port,path:request.raw.url,method:request.method,headers},response=>{
        const output={...response.headers,'cache-control':'no-store'};delete output['set-cookie'];
        raw.writeHead(response.statusCode??502,output);
        response.on('error',()=>raw.destroy());response.pipe(raw);
      });
      upstream.on('error',()=>{if(!raw.headersSent){raw.writeHead(502,{'content-type':'application/json'});raw.end(JSON.stringify({error:'消息服务连接失败，请重试'}));}else raw.destroy();});
      raw.once('close',()=>{upstream.destroy();finish();});
      request.raw.once('aborted',()=>{upstream.destroy();finish();});
      request.raw.pipe(upstream);
    },
    revoke,
    async close() {
      clearInterval(sweep);for(const session of streams.keys())this.revoke(session);
      await Promise.allSettled([...hosts.values()].map(async pending=>{const item=await pending;item.server.closeAllConnections();await new Promise(resolve=>item.server.close(resolve));}));hosts.clear();
    }
  };
}
