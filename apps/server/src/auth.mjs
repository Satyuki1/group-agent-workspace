import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { z } from 'zod';
import { token, digest, seal } from './crypto.mjs';
import { transaction } from './db.mjs';

const credentials = z.object({username:z.string().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/).transform(x=>x.toLowerCase()),password:z.string().min(12).max(128)});
const passwordHash = value => hash(value,{algorithm:Algorithm.Argon2id,memoryCost:19456,timeCost:2,parallelism:1});
const publicUser = row => ({id:row.id,username:row.username,displayName:row.display_name,publicKey:row.public_key,role:row.role,state:row.state});
export const httpError = (status,message) => Object.assign(new Error(message),{statusCode:status});

export async function bootstrapAdmin(pool,config) {
  return transaction(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(71241105)');
  if ((await client.query('SELECT 1 FROM users LIMIT 1')).rowCount) return;
  let password;
  const id=randomUUID(), path=`${config.hostData}/bootstrap-admin.txt`;
  await mkdir(config.hostData,{recursive:true,mode:0o700});
  try {
    const recovery=await readFile(path,'utf8');
    password=/^密码：([A-Za-z0-9_-]{32,})$/m.exec(recovery)?.[1];
    if(!password)throw new Error('Invalid bootstrap recovery file; refusing to replace it');
  } catch(error) {
    if(error.code!=='ENOENT')throw error;
    password=token();
    await writeFile(path,`用户名：admin\n密码：${password}\n入口：${config.publicOrigin}\n`,{mode:0o600,flag:'wx'});
  }
  const encrypted=seal(Buffer.from(config.ownerKey),config.vaultKey,id);
  const hashed=await passwordHash(password);
  await client.query("INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_key,role,state) VALUES($1,'admin','管理员',$2,$3,$4,'admin','active')",[id,hashed,getPublicKey(config.ownerKey),encrypted]);
  await chmod(path,0o600);
  });
}

export async function mountAuth(app,pool,config) {
  app.decorateRequest('account',null);
  app.decorateRequest('authSession',null);
  const failureTimes=new Map();
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    const value=request.cookies.ga_session;
    if (value) {
      const {rows}=await pool.query("SELECT u.*,s.csrf,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.state='active'",[digest(value)]);
      if(rows[0]) {request.account=rows[0];request.authSession={hash:rows[0].token_hash,csrf:rows[0].csrf};}
    }
    if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
      const origin=request.headers.origin;
      if (!origin || !config.allowedOrigins.has(origin) || request.headers['sec-fetch-site']==='cross-site') throw httpError(403,'请求来源不受信任');
      if (request.url.startsWith('/api/app/') && !request.url.startsWith('/api/app/auth/') && request.headers['x-app-csrf']!==request.authSession?.csrf) throw httpError(403,'请求已失效，请刷新后重试');
    }
  });
  app.decorate('requireUser',async(request)=>{if(!request.account)throw httpError(401,'请先登录');});
  app.decorate('requireAdmin',async(request)=>{if(!request.account)throw httpError(401,'请先登录');if(request.account.role!=='admin')throw httpError(403,'需要管理员权限');});

  app.post('/api/app/auth/login',async(request,reply)=>{
    const input=credentials.parse(request.body);
    const bucket=`${request.ip}:${input.username}`, now=Date.now();
    const attempts=(failureTimes.get(bucket)??[]).filter(t=>now-t<15*60_000);
    if(attempts.length>=10)throw httpError(429,'登录失败次数过多，请稍后重试');
    const {rows}=await pool.query('SELECT * FROM users WHERE username=$1',[input.username]);
    const row=rows[0];
    if(!row || !await verify(row.password_hash,input.password)) {
      if(failureTimes.size>2000)failureTimes.clear();
      failureTimes.set(bucket,[...attempts,now]);throw httpError(401,'账号或密码不正确');
    }
    if(row.state!=='active')throw httpError(403,row.state==='pending'?'账号正在加入团队，请稍后重试':'账号已停用');
    failureTimes.delete(bucket);
    const value=token(),csrf=token();
    await pool.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",[digest(value),row.id,csrf]);
    reply.setCookie('ga_session',value,{path:'/',httpOnly:true,sameSite:'strict',secure:request.headers.origin.startsWith('https:'),maxAge:7*86400});
    return {user:publicUser(row),csrf};
  });
  app.get('/api/app/auth/me',{preHandler:app.requireUser},async request=>({user:publicUser(request.account),csrf:request.authSession.csrf,relayOrigin:config.relayOrigin}));
  app.post('/api/app/auth/logout',{preHandler:app.requireUser},async(request,reply)=>{
    await pool.query('DELETE FROM sessions WHERE token_hash=$1',[request.authSession.hash]);
    reply.clearCookie('ga_session',{path:'/'});return {ok:true};
  });
  app.post('/api/app/auth/invitations',{preHandler:app.requireAdmin},async request=>{
    if(request.headers['x-app-csrf']!==request.authSession.csrf)throw httpError(403,'请求已失效');
    const value=token();
    await pool.query("INSERT INTO invitations(token_hash,created_by,expires_at) VALUES($1,$2,now()+interval '7 days')",[digest(value),request.account.id]);
    return {url:`${config.publicOrigin}/?invite=${value}`};
  });
  app.post('/api/app/auth/register',async request=>{
    const input=credentials.extend({displayName:z.string().trim().min(1).max(60),invite:z.string().min(30).max(100)}).parse(request.body);
    // Reject invalid invitations before spending CPU on password hashing. The
    // locked transaction below still makes concurrent redemption atomic.
    const valid=await pool.query('SELECT 1 FROM invitations WHERE token_hash=$1 AND used_by IS NULL AND expires_at>now()',[digest(input.invite)]);
    if(!valid.rowCount)throw httpError(403,'邀请已使用或已过期');
    const id=randomUUID(),key=generateSecretKey(),publicKey=getPublicKey(key),hashed=await passwordHash(input.password);
    const {finalizeEvent}=await import('nostr-tools');
    const event=finalizeEvent({kind:9030,created_at:Math.floor(Date.now()/1000),content:'',tags:[['p',publicKey],['role','member']]},config.ownerKey);
    try {
      await transaction(pool,async client=>{
        const {rows}=await client.query('SELECT * FROM invitations WHERE token_hash=$1 FOR UPDATE',[digest(input.invite)]);
        if(!rows[0] || rows[0].used_by || new Date(rows[0].expires_at)<=new Date())throw httpError(403,'邀请已使用或已过期');
        await client.query("INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_key,role) VALUES($1,$2,$3,$4,$5,$6,'member')",[id,input.username,input.displayName,hashed,publicKey,seal(Buffer.from(key),config.vaultKey,id)]);
        await client.query('UPDATE invitations SET used_by=$2 WHERE token_hash=$1',[digest(input.invite),id]);
        await client.query("INSERT INTO relay_outbox(event_id,actor_public_key,event,purpose,subject_id) VALUES($1,$2,$3,'enroll-user',$4)",[event.id,event.pubkey,event,id]);
      });
    } finally {key.fill(0);}
    return {state:'pending',message:'账号已创建，正在加入团队。请稍后登录。'};
  });
  app.post('/api/app/auth/password',{preHandler:app.requireUser},async request=>{
    if(request.headers['x-app-csrf']!==request.authSession.csrf)throw httpError(403,'请求已失效');
    const input=z.object({current:z.string().max(128),password:z.string().min(12).max(128)}).parse(request.body);
    if(!await verify(request.account.password_hash,input.current))throw httpError(403,'当前密码不正确');
    await transaction(pool,async client=>{
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1',[request.account.id,await passwordHash(input.password)]);
      await client.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[request.account.id,request.authSession.hash]);
    });return {ok:true};
  });
}
