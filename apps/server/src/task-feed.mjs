import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {httpError} from './auth.mjs';

/** Browser progress is a bounded projection, never the raw native journal. */
export function mountTaskFeed(app,pool,workspaces) {
  const open=new Set();
  app.get('/api/app/conversations/:id/activity',{preHandler:app.requireUser},async(request,reply)=>{
    const id=request.params.id;
    if(!/^[0-9a-f-]{36}$/.test(id))throw httpError(400,'会话标识无效');
    await workspaces.conversationAccess(request.account,id,{fresh:true});
    const stop=new AbortController();open.add(stop);
    reply.hijack();reply.raw.once('close',()=>stop.abort());
    reply.raw.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'});reply.raw.flushHeaders();
    const versions=new Map();let checked=Date.now(),heartbeat=0;
    try {while(!stop.signal.aborted){
      if(Date.now()-checked>=2000){
        const valid=await pool.query("SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.state='active'",[request.authSession.hash]);
        if(!valid.rowCount){reply.raw.write('event: revoked\ndata: {}\n\n');break;}
        await workspaces.conversationAccess(request.account,id,{fresh:true});checked=Date.now();
      }
      const {rows}=await pool.query(`SELECT t.id,t.status,t.created_at,t.source_event_id,COALESCE(t.input->>'rootId',t.source_event_id) AS thread_root_id,
        left(t.input->>'text',240) AS summary,t.cancel_requested,t.updated_at,t.error,t.progress,a.name AS agent,a.public_key AS public_key,a.avatar,
        (SELECT event_id FROM relay_outbox o WHERE o.subject_id=t.id AND o.purpose='task-result' AND o.state='sent' ORDER BY o.created_at DESC LIMIT 1) AS final_event_id
        FROM tasks t JOIN session_bindings b ON b.id=t.session_binding_id JOIN spaces s ON s.id=t.space_id JOIN agents a ON a.id=t.agent_id
        WHERE COALESCE(NULLIF(b.thread_id,''),s.conversation_id)=$1 ORDER BY (t.status='running') DESC,t.created_at DESC LIMIT 30`,[id]);
      const version=row=>new Date(row.updated_at).getTime()+':'+(row.final_event_id??'');
      const changed=rows.filter(row=>versions.get(row.id)!==version(row));
      const removed=[...versions.keys()].filter(id=>!rows.some(row=>row.id===id));
      for(const row of changed)versions.set(row.id,version(row));
      for(const id of versions.keys())if(!rows.some(row=>row.id===id))versions.delete(id);
      const initial=heartbeat===0;
      if(initial || changed.length || removed.length){
        if(!reply.raw.write(`data: ${JSON.stringify({reset:initial,serverTime:Date.now(),tasks:initial?rows:changed,removed})}\n\n`))await once(reply.raw,'drain',{signal:AbortSignal.any([stop.signal,AbortSignal.timeout(5000)])});
      }
      if(Date.now()-heartbeat>10000){reply.raw.write(': alive\n\n');heartbeat=Date.now();}
      await delay(400,undefined,{signal:stop.signal});
    }}catch(error){if(!stop.signal.aborted){if(error.statusCode===403)reply.raw.write('event: revoked\ndata: {}\n\n');else app.log.warn({name:error.name},'Task feed disconnected');}}
    finally{stop.abort();open.delete(stop);reply.raw.end();}
  });
  app.addHook('preClose',async()=>{for(const stop of open)stop.abort();});
}
