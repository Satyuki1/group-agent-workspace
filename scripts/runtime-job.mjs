import {readConfig} from '../apps/server/src/config.mjs';
import {database} from '../apps/server/src/db.mjs';
import {unseal} from '../apps/server/src/crypto.mjs';
import {runtimeClient} from '../apps/server/src/runtime.mjs';
import {readModelCredential} from '../apps/server/src/model-settings.mjs';

// Called only by the operator's host service, never exposed as an HTTP route.
const config=readConfig(),pool=database(config.databaseUrl),runtime=runtimeClient(pool,config);
const [action,id]=process.argv.slice(2);
try {
  if(action==='next'){
    if((await pool.query("SELECT 1 FROM settings WHERE key='ops.backup' AND value='true'::jsonb")).rowCount){console.log('null');}
    else {
      const {rows:[space]}=await pool.query(`SELECT s.*,r.state FROM spaces s JOIN space_runtimes r ON r.space_id=s.id
        WHERE (r.state='starting' AND EXISTS(SELECT 1 FROM settings v WHERE v.key='runtime.plan:'||s.id::text)) OR (r.state='ready' AND EXISTS(SELECT 1 FROM session_bindings b WHERE b.space_id=s.id AND NOT b.ready AND b.initialization_error IS NULL)) ORDER BY s.created_at LIMIT 1`);
      if(!space)console.log('null');
      else {
        let plan={spaceId:space.id,sessionId:space.root_session_id};
        if(space.state==='starting'){
          const {rows:[record]}=await pool.query('SELECT value FROM settings WHERE key=$1',[`runtime.plan:${space.id}`]);
          if(!record)throw new Error('Runtime plan missing');
          plan=JSON.parse(unseal(record.value.encrypted,config.vaultKey,`runtime-plan:${space.id}`).toString());
          plan.models=(await readModelCredential(pool,config)).models;
        }
        console.log(JSON.stringify({...plan,state:space.state}));
      }
    }
  } else {
    if(!/^[0-9a-f-]{36}$/.test(id??''))throw new Error('Invalid space');
    if(action==='fail'){
      await pool.query("UPDATE session_bindings SET initialization_error='工作空间准备失败，请重试' WHERE space_id=$1 AND NOT ready",[id]);
      await pool.query("UPDATE space_runtimes SET state='failed',updated_at=now() WHERE space_id=$1 AND state='starting'",[id]);
    }
    else if(action==='initialize'){
      await runtime.call(id,'/_control/health');
      const catalog=await runtime.invoke(id,'session','modelCatalog');
      const model=catalog.groups.find(g=>g.id==='deepseek-official')?.models[0]?.id;
      if(!model)throw new Error('Model unavailable');
      const known=await runtime.invoke(id,'session','list',{_request:{}});
      const bindings=(await pool.query('SELECT * FROM session_bindings WHERE space_id=$1 AND NOT ready AND initialization_error IS NULL ORDER BY id',[id])).rows;
      for(const binding of bindings){
        if(!known.items.some(item=>item.sessionId===binding.dsh_session_id))await runtime.invoke(id,'session','create',{request:{sessionId:binding.dsh_session_id,cwd:'/work',agentPreset:'group-collaborator'}});
        await runtime.invoke(id,'session','selectModel',{request:{sessionId:binding.dsh_session_id,provider:'deepseek-official',model}});
        await pool.query('UPDATE session_bindings SET ready=true WHERE id=$1',[binding.id]);
      }
      await pool.query("UPDATE space_runtimes SET state='ready',updated_at=now() WHERE space_id=$1",[id]);
      console.log(JSON.stringify({ready:true,spaceId:id,bindings:bindings.length}));
    }else throw new Error('Unknown action');
  }
} finally {await pool.end();}
