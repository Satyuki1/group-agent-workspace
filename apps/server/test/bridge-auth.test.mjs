import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {signBridgeRequest,bridgeVerifier} from '../../../integrations/dsh-bridge/auth.mjs';
import {replaceGrant} from '../../../integrations/dsh-bridge/grants.mjs';

test('bridge proof binds body, path, identity and method; rejects replay and stale proofs',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),now=Date.now();
  const request={method:'POST',path:'/api/session/page',body:Buffer.from('{"sessionId":"a"}'),claim:'member-a',now};
  const headers=signBridgeRequest(privateKey,request);
  for(const changed of [{method:'GET'},{path:'/_control/invoke'},{body:Buffer.from('{}')},{headers:{...headers,'x-group-claim':'owner'}}])assert.throws(()=>bridgeVerifier(publicKey)({...request,headers,...changed}));
  const verify=bridgeVerifier(publicKey);verify({...request,headers});assert.throws(()=>verify({...request,headers}));
  assert.throws(()=>bridgeVerifier(publicKey,{clock:()=>now+31000})({...request,headers}));
  const other=generateKeyPairSync('ed25519');assert.throws(()=>bridgeVerifier(other.publicKey)({...request,headers}));
});

test('scope removal ends current streams and disposes the old peer, renewal preserves them',async()=>{
  let disposed=0,created=0,ended=0;
  const controller=new AbortController();
  const state={grants:new Map(),peers:new Map(),streams:new Map(),invalidate(){},createPeer(){created++;return {dispose:async()=>{disposed++;}};}};
  const claim={login:'a',user:'a',sessions:['one','two'],expires:Date.now()+1000};
  await replaceGrant({...state,claim});state.streams.set('terminal',{login:'a',controller,queue:{end(){ended++;}}});
  await replaceGrant({...state,claim:{...claim,expires:Date.now()+2000}});
  assert.equal(controller.signal.aborted,false);assert.equal(created,1);
  await replaceGrant({...state,claim:{...claim,sessions:['one']}});
  assert.equal(controller.signal.aborted,true);assert.equal(ended,1);assert.equal(disposed,1);assert.equal(created,2);
});
