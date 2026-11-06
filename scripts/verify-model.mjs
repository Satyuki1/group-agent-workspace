import {readConfig} from '../apps/server/src/config.mjs';
import {database} from '../apps/server/src/db.mjs';
const key=process.env.DEEPSEEK_API_KEY;
if(!key)throw new Error('DEEPSEEK_API_KEY is not configured');
const response=await fetch('https://api.deepseek.com/models',{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(20000)});
if(!response.ok){console.log(JSON.stringify({verified:false,status:response.status}));process.exit(1);}
const catalog=await response.json();
if(!Array.isArray(catalog.data)||!catalog.data.length)throw new Error('DeepSeek returned no models');
const config=readConfig(),pool=database(config.databaseUrl);
try {
  const models=catalog.data.map(x=>x.id),verifiedAt=new Date().toISOString();
  await pool.query("INSERT INTO settings(key,value) VALUES('model.deepseek',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[{models,catalog:catalog.data,verifiedAt,managedByEnvironment:true}]);
  console.log(JSON.stringify({verified:true,models,verifiedAt}));
}finally{await pool.end();}
