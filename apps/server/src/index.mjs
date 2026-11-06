import {mountTeamIM} from './team-im.mjs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from './config.mjs';
import { database, migrate } from './db.mjs';
import { bootstrapAdmin, mountAuth, httpError } from './auth.mjs';
import { createBrokers } from './broker.mjs';
import { relayClient, deliverOutbox } from './relay.mjs';
import { mountModelSettings } from './model-settings.mjs';
import { createModelProxy } from './model-proxy.mjs';
import { createWorkspaces } from './workspaces.mjs';
import {createAgentHost} from './agent-host.mjs';
import {unseal} from './crypto.mjs';

const config=readConfig();
const pool=database(config.databaseUrl);
await migrate(pool);
await bootstrapAdmin(pool,config);
const app=Fastify({bodyLimit:1024*1024,logger:{level:'info',redact:['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]']},disableRequestLogging:true});
await app.register(cookie);
await mountAuth(app,pool,config);
await mountModelSettings(app,pool,config);
const brokers=await createBrokers(config,pool);
const relay=relayClient(config);
const workspaces=await createWorkspaces(app,pool,config,relay);
const teamIM=await mountTeamIM(app,pool,config,relay,workspaces);
const stop=new AbortController();
const modelProxy=createModelProxy(pool,config);
const agentHost=await createAgentHost(app,pool,config,relay,workspaces,teamIM);

app.addHook('onRequest',async(request,reply)=>{
  if(request.url.startsWith('/api/relay/')) {
    await app.requireUser(request);
    await brokers.proxy(request,reply);
  }
});
app.addHook('onResponse',async request=>{
  if(request.url==='/api/app/auth/logout' && request.authSession){brokers.revoke(request.authSession.hash);workspaces.revoke(request.authSession.hash);}
});

app.get('/health',async()=>{await pool.query('SELECT 1');return {status:'ok',service:'group-agent-webhost'};});
app.get('/api/app/status',{preHandler:app.requireUser},async()=>{
  let relayReady=false;
  try {relayReady=(await fetch(`${config.relayInternal}/`,{headers:{Accept:'application/nostr+json'},signal:AbortSignal.timeout(3000)})).ok;}catch{/* Return the measured dependency state. */}
  const {rowCount}=await pool.query("SELECT 1 FROM settings WHERE key='model.deepseek'");
  const {rowCount:runtimes}=await pool.query("SELECT 1 FROM space_runtimes WHERE state='ready'");
  return {relay:relayReady,modelConfigured:Boolean(process.env.DEEPSEEK_API_KEY)||rowCount===1,harness:runtimes?'configured':'not-connected'};
});

const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};
app.setNotFoundHandler(async(request,reply)=>{
  if(request.url.startsWith('/api/') || request.url.startsWith('/workspace/'))throw httpError(404,'接口不存在');
  if(request.method!=='GET' && request.method!=='HEAD')throw httpError(405,'不支持此操作');
  const pathname=decodeURIComponent(new URL(request.url,'http://local').pathname);
  let target=resolve(config.webDist,'.'+pathname);
  if(!target.startsWith(resolve(config.webDist)+'/') && target!==resolve(config.webDist))throw httpError(403,'路径无效');
  try {if(!(await stat(target)).isFile())target=resolve(config.webDist,'index.html');}catch(error){if(error.code==='ENOENT')target=resolve(config.webDist,'index.html');else throw error;}
  try {const content=await readFile(target);return reply.type(types[extname(target)]??'application/octet-stream').send(content);}
  catch(error){if(error.code==='ENOENT')return reply.code(503).type('text/plain').send('前端正在构建，请稍后刷新。');throw error;}
});
app.setErrorHandler((error,request,reply)=>{
  if(error.name==='ZodError')return reply.code(400).send({error:'输入格式不正确',fields:error.issues.map(x=>({path:x.path,message:x.message}))});
  if(error.code==='23505')return reply.code(409).send({error:'该记录已存在，请刷新后重试'});
  const status=error.statusCode??500;
  if(status>=500)app.log.error({code:error.code,name:error.name,message:error.message},'Request failed');
  return reply.code(status).send({error:status>=500?'服务暂时不可用，请重试':error.message});
});

const delivery=(async()=>{
  while(!stop.signal.aborted) {
    try {const delivered=await deliverOutbox(pool,relay,config.ownerKey,async publicKey=>{
      const {rows:[actor]}=await pool.query('SELECT id,encrypted_key FROM agents WHERE public_key=$1 UNION ALL SELECT id,encrypted_key FROM users WHERE public_key=$1',[publicKey]);
      if(!actor)throw new Error('Unknown outbox actor');return unseal(actor.encrypted_key,config.vaultKey,actor.id);
    });await delay(delivered?200:1000,undefined,{signal:stop.signal});}
    catch(error){if(stop.signal.aborted)break;app.log.error({code:error.code,name:error.name},'Outbox processing failed');await delay(5000,undefined,{signal:stop.signal}).catch(()=>{});}
  }
})();

app.addHook('onClose',async()=>{stop.abort();await delivery;await agentHost.close();workspaces.close();await brokers.close();await modelProxy.close();await pool.end();config.ownerKey.fill(0);config.vaultKey.fill(0);});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void app.close();});
await app.listen({host:'0.0.0.0',port:config.port});
await modelProxy.listen({host:'0.0.0.0',port:3301});
