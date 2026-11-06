/** Scope changes must revoke existing gateway streams, not just future calls. */
export function sameScopes(a,b) {
  return a.length===b.length && [...new Set(a)].sort().join('\0')===[...new Set(b)].sort().join('\0');
}
export async function replaceGrant({claim,grants,peers,streams,createPeer,invalidate}) {
  const previous=grants.get(claim.login);
  if(previous && previous.user!==claim.user)throw Object.assign(new Error('identity-changed'),{status:403});
  if(previous && !sameScopes(previous.sessions,claim.sessions))await dropGrant(claim.login,{grants,peers,streams,invalidate});
  grants.set(claim.login,claim);
  if(!peers.has(claim.login))peers.set(claim.login,createPeer(claim));
  invalidate();return peers.get(claim.login);
}
export async function dropGrant(login,{grants,peers,streams,invalidate}) {
  grants.delete(login);const peer=peers.get(login);peers.delete(login);
  for(const [id,stream]of streams)if(stream.login===login){stream.controller.abort();stream.queue.end();streams.delete(id);}
  invalidate();await peer?.dispose();
}
