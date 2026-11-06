import {unseal} from './crypto.mjs';
import {signBridgeRequest} from '../../../integrations/dsh-bridge/auth.mjs';

/** Server-only control client. No private signing material enters a runtime. */
export function runtimeClient(pool,config) {
  async function call(spaceId,path,value,{signal=AbortSignal.timeout(30000)}={}) {
    const {rows}=await pool.query('SELECT endpoint,encrypted_bridge_key FROM space_runtimes WHERE space_id=$1',[spaceId]);
    const runtime=rows[0];if(!runtime || runtime.endpoint!==`http://ga-space-${spaceId}:3200`)throw new Error('Runtime not configured');
    const key=unseal(runtime.encrypted_bridge_key,config.vaultKey,`bridge:${spaceId}`).toString();
    const body=value===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(value)),method=value===undefined?'GET':'POST';
    const headers=signBridgeRequest(key,{method,path,body});
    const response=await fetch(runtime.endpoint+path,{method,body:method==='GET'?undefined:body,headers:{...headers,'Content-Type':'application/json'},redirect:'error',signal});
    const result=await response.json();
    if(!response.ok)throw new Error(`Harness ${response.status}: ${result.error??'request failed'}`);
    return result;
  }
  async function* follow(spaceId,sessionId,signal) {
    const {rows:[runtime]}=await pool.query('SELECT endpoint,encrypted_bridge_key FROM space_runtimes WHERE space_id=$1',[spaceId]);
    if(runtime?.endpoint!==`http://ga-space-${spaceId}:3200`)throw new Error('Runtime not configured');
    const path='/_control/follow',body=Buffer.from(JSON.stringify({sessionId}));
    const key=unseal(runtime.encrypted_bridge_key,config.vaultKey,`bridge:${spaceId}`).toString();
    const response=await fetch(runtime.endpoint+path,{method:'POST',body,headers:{...signBridgeRequest(key,{method:'POST',path,body}),'Content-Type':'application/json'},redirect:'error',signal});
    if(!response.ok)throw new Error(`Harness progress ${response.status}`);
    const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let pending='';
    try {while(true){const {value,done}=await reader.read();if(done)break;pending+=value;
      if(pending.length>8*1024*1024)throw new Error('Progress frame too large');
      let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line)yield JSON.parse(line);}
    }}finally{await reader.cancel().catch(()=>{});}
  }
  return {call,follow,async invoke(spaceId,namespace,method,args={}){return (await call(spaceId,'/_control/invoke',{namespace,method,args})).value;}};
}
