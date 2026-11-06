import {readConfig} from '../apps/server/src/config.mjs';
import {database} from '../apps/server/src/db.mjs';
import {runtimeClient} from '../apps/server/src/runtime.mjs';
import {progressProjector,taskOpening} from '../apps/server/src/task-progress.mjs';
const config=readConfig(),pool=database(config.databaseUrl),runtime=runtimeClient(pool,config);
let restored=0,unavailable=0;
try{
  const {rows}=await pool.query(`SELECT t.*,b.dsh_session_id FROM tasks t JOIN session_bindings b ON b.id=t.session_binding_id JOIN space_runtimes r ON r.space_id=t.space_id AND r.state='ready'
    WHERE t.status='completed' AND t.baseline_cursor IS NOT NULL AND (t.progress='{}'::jsonb OR (t.progress->>'phase'='preparing' AND COALESCE(t.progress->>'text','')='')) ORDER BY t.created_at DESC LIMIT 30`);
  for(const task of rows){
    try{
      const cut=Number(task.result?.cursor),address={kind:'session',sessionId:task.dsh_session_id};
      const page=await runtime.invoke(task.space_id,'session','page',{request:{address,maxMessages:200,...(Number.isFinite(cut)?{throughSeq:cut}:{})}});
      const opening=await taskOpening({type:'snapshot',...page},task,bounds=>runtime.invoke(task.space_id,'session','page',{request:{address,...bounds}}));
      const p=progressProjector(task);p.accept(opening);const value=p.snapshot();
      if(value.phase!=='done'){unavailable++;continue;}
      await pool.query("UPDATE tasks SET progress=$2,updated_at=now() WHERE id=$1 AND status='completed'",[task.id,value]);restored++;
    }catch{unavailable++;}
  }
  console.log(JSON.stringify({restored,unavailable,modelCalls:0}));
}finally{await pool.end();}
