import {readFile} from 'node:fs/promises';
import {readConfig} from '../apps/server/src/config.mjs';
import {database} from '../apps/server/src/db.mjs';
import {seal} from '../apps/server/src/crypto.mjs';
const config=readConfig(),pool=database(config.databaseUrl);
try {
  let count=0;
  for(const file of ['p1-provision.json','p1-private.json']){
    let plan;
    try{plan=JSON.parse(await readFile(`${config.hostData}/${file}`,'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(!(await pool.query('SELECT 1 FROM spaces WHERE id=$1 AND root_session_id=$2',[plan.spaceId,plan.sessionId])).rowCount)throw new Error('Legacy runtime identity mismatch');
    const result=await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING',[
      `runtime.plan:${plan.spaceId}`,{encrypted:seal(Buffer.from(JSON.stringify(plan)),config.vaultKey,`runtime-plan:${plan.spaceId}`)},
    ]);count+=result.rowCount;
  }
  console.log(JSON.stringify({importedRuntimePlans:count}));
}finally{await pool.end();}
