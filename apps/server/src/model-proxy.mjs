import Fastify from 'fastify';
import {Readable} from 'node:stream';
import {digest} from './crypto.mjs';
import {readModelCredential} from './model-settings.mjs';

/** Private network listener. Only explicitly allowlisted official endpoints. */
export function createModelProxy(pool,config,{upstreamFetch=fetch}={}) {
  const app=Fastify({bodyLimit:8*1024*1024,logger:false});
  let active=0;
  app.decorateRequest('space',null);
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    const key=request.headers['x-api-key'];
    if(typeof key!=='string' || key.length<32)return reply.code(401).send({error:{type:'authentication_error',message:'Runtime credential required'}});
    const {rows}=await pool.query('SELECT space_id FROM runtime_credentials WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[digest(key)]);
    if(!rows[0])return reply.code(401).send({error:{type:'authentication_error',message:'Runtime credential expired'}});
    request.space=rows[0].space_id;
  });
  app.get('/models',async()=>{
    const value=await readModelCredential(pool,config);
    return {object:'list',data:value.catalog??value.models.map(id=>({id,object:'model',owned_by:'deepseek'}))};
  });
  app.post('/anthropic/v1/messages',async(request,reply)=>{
    const credential=await readModelCredential(pool,config);
    const input=request.body;
    if(!input || typeof input!=='object' || !credential.models.includes(input.model) || !Number.isInteger(input.max_tokens) || input.max_tokens<1 || input.max_tokens>32768)return reply.code(400).send({error:{type:'invalid_request_error',message:'Model or token limit is not allowed'}});
    if(active>=3)return reply.header('Retry-After','2').code(429).send({error:{type:'rate_limit_error',message:'Runtime concurrency limit reached'}});
    active++;
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30*60_000);
    const disconnected=()=>abort.abort();reply.raw.once('close',disconnected);
    let id,settled=false;
    async function finish(status) {
      if(settled)return;settled=true;clearTimeout(timer);active--;reply.raw.removeListener('close',disconnected);
      if(id)await pool.query('UPDATE model_usage SET status=$2,finished_at=now() WHERE id=$1',[id,status]).catch(()=>{});
    }
    try {
      const {rows}=await pool.query('INSERT INTO model_usage(space_id,model) VALUES($1,$2) RETURNING id',[request.space,input.model]);id=rows[0].id;
      const response=await upstreamFetch('https://api.deepseek.com/anthropic/v1/messages',{
        method:'POST',redirect:'error',signal:abort.signal,
        headers:{'Content-Type':'application/json','x-api-key':credential.key,'anthropic-version':'2023-06-01'},body:JSON.stringify(input),
      });
      reply.code(response.status).header('Content-Type',response.headers.get('content-type')??'application/json');
      if(!response.body){await finish(response.status);return reply.send();}
      const stream=Readable.fromWeb(response.body);
      stream.once('end',()=>void finish(response.status));stream.once('error',()=>void finish(502));
      reply.raw.once('close',()=>{stream.destroy();void finish(response.status);});
      return reply.send(stream);
    }catch {await finish(502);return reply.code(502).send({error:{type:'api_error',message:'Model upstream unavailable'}});}
  });
  app.setErrorHandler((error,request,reply)=>reply.code(error.statusCode??500).send({error:{type:'api_error',message:'Model proxy unavailable'}}));
  return app;
}
