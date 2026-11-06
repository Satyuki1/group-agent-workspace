import {readFile} from 'node:fs/promises';
import {readConfig} from '../apps/server/src/config.mjs';
import {database} from '../apps/server/src/db.mjs';
import {runtimeClient} from '../apps/server/src/runtime.mjs';
const config=readConfig(),pool=database(config.databaseUrl),runtime=runtimeClient(pool,config);
try {
  const record=process.env.PROVISION_RECORD??'p1-provision.json';
  if(!['p1-provision.json','p1-private.json'].includes(record))throw new Error('Unknown provisioning record');
  const p=JSON.parse(await readFile('/data/host/'+record,'utf8'));
  await runtime.call(p.spaceId,'/_control/health');
  const catalog=await runtime.invoke(p.spaceId,'session','modelCatalog');
  const model=catalog.groups.find(g=>g.id==='deepseek-official')?.models[0]?.id;
  if(!model)throw new Error('DeepSeek runtime model unavailable');
  // Reconnection preserves an existing nonblank Session rather than creating a replacement.
  const known=await runtime.invoke(p.spaceId,'session','list',{_request:{}});
  if(!known.items.some(item=>item.sessionId===p.sessionId)){
    const created=await runtime.invoke(p.spaceId,'session','create',{request:{sessionId:p.sessionId,cwd:'/work',agentPreset:'group-collaborator'}});
    if(created.sessionId!==p.sessionId)throw new Error('Unexpected session identity');
  }
  await runtime.invoke(p.spaceId,'session','selectModel',{request:{sessionId:p.sessionId,provider:'deepseek-official',model}});
  await pool.query("UPDATE space_runtimes SET state='ready',updated_at=now() WHERE space_id=$1",[p.spaceId]);
  console.log(JSON.stringify({ready:true,spaceId:p.spaceId,sessionId:p.sessionId,model}));
}finally{await pool.end();}
