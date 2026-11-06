import test from 'node:test';
import assert from 'node:assert/strict';
import {generateSecretKey,finalizeEvent,getPublicKey} from 'nostr-tools';
import {deliverOutbox} from '../src/relay.mjs';

for(const acceptedBefore of [false,true])test(`expired group result recovers; prior acceptance=${acceptedBefore}`,async()=>{
  const key=generateSecretKey(),now=Math.floor(Date.now()/1000);
  const event=finalizeEvent({kind:9,created_at:now-3600,content:'成果',tags:[['task','one']]},key);
  const row={event,event_id:event.id,actor_public_key:getPublicKey(key),purpose:'task-result',attempts:0,state:'pending'};
  const stored=new Set(acceptedBefore?[event.id]:[]);let publishes=0,read=false;
  const client={release(){},async query(sql,args){
    if(sql.startsWith('SELECT *'))return {rows:row.state==='pending'?[{...row}]:[]};
    if(sql.startsWith('UPDATE relay_outbox SET event_id')){row.event_id=args[1];row.event=args[2];}
    if(sql.includes("SET state='sent'"))row.state='sent';return {rows:[]};
  }};
  const relay={sign(k,t){return finalizeEvent({...t,created_at:now},k);},async query(_k,filters){read=true;assert.equal(filters[0].consistency,'strong');return stored.has(event.id)?[event]:[];},async publish(_k,value){assert.ok(read);assert.ok(now-value.created_at<900);stored.add(value.id);publishes++;}};
  await deliverOutbox({connect:async()=>client},relay,key);
  assert.equal(row.state,'sent');assert.equal(stored.size,1);assert.equal(publishes,acceptedBefore?0:1);
});

test('renewed proof survives a crash after Relay acceptance and before receipt commit',async()=>{
  const key=generateSecretKey(),now=Math.floor(Date.now()/1000),event=finalizeEvent({kind:9,created_at:now-3600,content:'成果',tags:[['task','one']]},key);
  let durable={event,event_id:event.id,actor_public_key:getPublicKey(key),purpose:'task-result',attempts:0,state:'pending'},tx,commits=0,clock=now;
  const stored=new Set();
  const client={release(){},async query(sql,args){
    if(sql==='BEGIN'){tx=structuredClone(durable);return {rows:[]};}
    if(sql==='ROLLBACK'){tx=undefined;return {rows:[]};}
    if(sql==='COMMIT'){if(++commits===2)throw new Error('connection lost before receipt commit');durable=tx;tx=undefined;return {rows:[]};}
    if(sql.startsWith('SELECT *'))return {rows:[structuredClone(tx)]};
    if(sql.startsWith('UPDATE relay_outbox SET event_id')){tx.event_id=args[1];tx.event=args[2];}
    if(sql.includes("SET state='sent'"))tx.state='sent';return {rows:[]};
  }};
  const relay={sign(k,t){return finalizeEvent({...t,created_at:clock++},k);},async query(){return [];},async publish(_k,value){assert.equal(durable.event_id,value.id,'Proof was committed before publish');stored.add(value.id);}};
  await deliverOutbox({connect:async()=>client},relay,key);assert.equal(durable.state,'pending');const committedId=durable.event_id;
  await deliverOutbox({connect:async()=>client},relay,key);
  assert.equal(durable.state,'sent');assert.equal(durable.event_id,committedId);assert.equal(stored.size,1);
});

test('a committed sending lease prevents a second worker renewing an in-flight proof',async()=>{
  const key=generateSecretKey(),clock=Math.floor(Date.now()/1000),event=finalizeEvent({kind:9,created_at:clock-599,content:'成果',tags:[['task','one']]},key);
  const row={event,event_id:event.id,actor_public_key:getPublicKey(key),purpose:'task-result',attempts:0,state:'pending'};
  let leased=false,releasePublish,started;
  const published=new Set(),began=new Promise(resolve=>{started=resolve;});
  const pool={async connect(){return {release(){},async query(sql){
    if(sql.startsWith('SELECT *'))return {rows:leased||row.state!=='pending'?[]:[structuredClone(row)]};
    if(sql.startsWith('UPDATE relay_outbox SET lease_owner'))leased=true;
    if(sql.includes("SET state='sent'"))row.state='sent';return {rows:[]};
  }};}};
  const relay={async publish(_key,value){started();await new Promise(resolve=>{releasePublish=resolve;});published.add(value.id);},async query(){return [];},sign(){throw new Error('Second worker must not renew a leased proof');}};
  const first=deliverOutbox(pool,relay,key);await began;
  assert.equal(await deliverOutbox(pool,relay,key),false);releasePublish();await first;
  assert.equal(published.size,1);assert.equal(row.state,'sent');
});
