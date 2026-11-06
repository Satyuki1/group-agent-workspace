(()=>{
  const base=new URL(`/workspace/${encodeURIComponent(globalThis.__GROUP_SPACE__)}/`,location.origin);
  const send=(path,init={})=>fetch(new URL(String(path).replace(/^\//,''),base),{...init,credentials:'same-origin'});
  async function post(path,value,signal) {
    const response=await send(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value),signal});
    if(!response.ok)throw new Error(`Workspace transport ${response.status}`);
    return response;
  }
  globalThis.__DSH_TRANSPORT__={
    fetch:send,
    resolveAsset:reference=>new URL(reference.replace(/^\//,''),base).href,
    async *openStream(endpoint,payload,signal,uplink) {
      const id=crypto.randomUUID(),lifetime=new AbortController();
      const abort=()=>lifetime.abort();signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      let uplinkFailure;
      try {
        const response=await post('_bridge/stream',{id,endpoint,payload},lifetime.signal);
        const upload=uplink?(async()=>{try{for await(const value of uplink)await post('_bridge/uplink',{id,value},lifetime.signal);await post('_bridge/uplink',{id,end:true},lifetime.signal);}catch(error){uplinkFailure=error;lifetime.abort();}})():Promise.resolve();
        const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let pending='';
        try {
          while(true) {
            const {value,done}=await reader.read();if(done)break;pending+=value;
            if(pending.length>8*1024*1024)throw new Error('Workspace stream frame too large');
            let end;
            while((end=pending.indexOf('\n'))>=0) {const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;const frame=JSON.parse(line);if(frame.error)throw Object.assign(new Error(frame.error.message),frame.error);yield frame.value;}
          }
          if(pending)throw new Error('Incomplete workspace stream');
        }finally{await reader.cancel().catch(()=>{});void upload;}
        if(uplinkFailure)throw uplinkFailure;
      }finally{lifetime.abort();signal.removeEventListener('abort',abort);}
    },
  };
  const timer=setInterval(()=>{void send('_bridge/heartbeat').then(r=>{if(!r.ok)throw new Error('access-revoked');}).catch(()=>{clearInterval(timer);location.reload();});},20_000);
  addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
