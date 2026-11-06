import {z} from 'zod';
import {seal,unseal} from './crypto.mjs';
import {httpError} from './auth.mjs';

/** Official model discovery doubles as credential verification; keys never return. */
export async function mountModelSettings(app,pool,config) {
  app.get('/api/app/settings/model',{preHandler:app.requireAdmin},async()=>{
    const {rows}=await pool.query("SELECT value FROM settings WHERE key='model.deepseek'");
    const value=rows[0]?.value;
    return {configured:Boolean(process.env.DEEPSEEK_API_KEY||value?.encryptedKey),managedByEnvironment:Boolean(process.env.DEEPSEEK_API_KEY),models:value?.models??[],verifiedAt:value?.verifiedAt??null};
  });
  app.post('/api/app/settings/model',{preHandler:app.requireAdmin},async request=>{
    const input=z.object({apiKey:z.string().trim().min(20).max(300)}).strict().parse(request.body);
    if(process.env.DEEPSEEK_API_KEY)throw httpError(409,'当前 Key 由服务器环境变量管理，请在服务器更新');
    let response;
    try {
      response=await fetch('https://api.deepseek.com/models',{
        headers:{Authorization:`Bearer ${input.apiKey}`},redirect:'error',signal:AbortSignal.timeout(20000),
      });
    } catch {throw httpError(503,'暂时无法连接 DeepSeek，请稍后重试');}
    if(!response.ok)throw httpError(400,response.status===401?'API Key 未通过 DeepSeek 验证':'DeepSeek 暂时拒绝请求，请检查账号状态后重试');
    const catalog=z.object({data:z.array(z.object({id:z.string().min(1)})).min(1)}).parse(await response.json());
    const models=catalog.data.map(model=>model.id),verifiedAt=new Date().toISOString();
    const encryptedKey=seal(Buffer.from(input.apiKey),config.vaultKey,'model.deepseek');
    await pool.query("INSERT INTO settings(key,value) VALUES('model.deepseek',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[{encryptedKey,models,verifiedAt}]);
    return {configured:true,models,verifiedAt};
  });
}

export async function readModelCredential(pool,config) {
  const {rows}=await pool.query("SELECT value FROM settings WHERE key='model.deepseek'");
  let value=rows[0]?.value??{};
  const key=process.env.DEEPSEEK_API_KEY??(value.encryptedKey?unseal(value.encryptedKey,config.vaultKey,'model.deepseek').toString('utf8'):undefined);
  if(!key)throw httpError(503,'管理员尚未配置 DeepSeek API Key');
  if(!Array.isArray(value.models) || !value.models.length) {
    let response;
    try{response=await fetch('https://api.deepseek.com/models',{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw httpError(503,'暂时无法读取 DeepSeek 模型列表');}
    if(!response.ok)throw httpError(503,'DeepSeek 凭证验证失败');
    const catalog=z.object({data:z.array(z.object({id:z.string().min(1)}).passthrough()).min(1)}).parse(await response.json());
    value={...value,models:catalog.data.map(x=>x.id),catalog:catalog.data,verifiedAt:new Date().toISOString()};
    await pool.query("INSERT INTO settings(key,value) VALUES('model.deepseek',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[value]);
  }
  return {...value,key};
}
