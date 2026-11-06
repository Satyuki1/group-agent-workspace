import {createHash,randomBytes,sign,verify} from 'node:crypto';

const denied=()=>Object.assign(new Error('invalid-bridge-proof'),{status:401});
const hash=body=>createHash('sha256').update(body).digest('hex');
function payload(method,path,body,claim,time,nonce) {
  if(!path.startsWith('/') || path.startsWith('//') || new URL(path,'http://bridge').pathname+new URL(path,'http://bridge').search!==path)throw denied();
  return Buffer.from(JSON.stringify(['group-agent-bridge-v1',method,path,hash(body),claim,time,nonce]));
}

/** Only the Web Host holds this private key. A runtime needs the public key. */
export function signBridgeRequest(privateKey,{method,path,body=Buffer.alloc(0),claim='',now=Date.now()}) {
  const time=String(now),nonce=randomBytes(24).toString('base64url');
  return {'x-group-claim':claim,'x-group-time':time,'x-group-nonce':nonce,
    'x-group-proof':sign(null,payload(method,path,body,claim,time,nonce),privateKey).toString('base64url')};
}

export function bridgeVerifier(publicKey,{clock=Date.now}={}) {
  const seen=new Map();
  return ({method,path,body=Buffer.alloc(0),headers})=>{
    const now=clock(),time=headers['x-group-time'],nonce=headers['x-group-nonce'],proof=headers['x-group-proof'],claim=headers['x-group-claim']??'';
    if(typeof time!=='string' || !/^\d{13}$/.test(time) || Math.abs(now-Number(time))>30_000 || typeof nonce!=='string' || !/^[A-Za-z0-9_-]{32}$/.test(nonce) || typeof proof!=='string' || !/^[A-Za-z0-9_-]{86}$/.test(proof) || typeof claim!=='string')throw denied();
    for(const [key,expiry]of seen)if(expiry<now)seen.delete(key);
    if(seen.has(nonce) || !verify(null,payload(method,path,body,claim,time,nonce),publicKey,Buffer.from(proof,'base64url')))throw denied();
    if(seen.size>=10000)throw Object.assign(new Error('bridge-proof-capacity'),{status:429});
    seen.set(nonce,Number(time)+30_000);
  };
}
