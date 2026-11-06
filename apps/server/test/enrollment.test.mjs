import test from 'node:test';
import assert from 'node:assert/strict';
import {generateSecretKey,finalizeEvent,verifyEvent,getPublicKey} from 'nostr-tools';
import {deliverOutbox} from '../src/relay.mjs';

test('enrollment recovers after an outage longer than relay freshness, including a lost receipt',async()=>{
  const key=generateSecretKey(),now=Math.floor(Date.now()/1000);
  let row={purpose:'enroll-user',subject_id:'user',attempts:0,state:'pending',event:finalizeEvent({kind:9030,created_at:now-3600,tags:[['p','a'.repeat(64)],['role','member']],content:''},key)};
  row.event_id=row.event.id;const original=row.event.id;let active=false,lost=true;const members=new Set(),events=[];
  const client={release(){},async query(sql,args){
    if(sql.startsWith('SELECT *'))return {rows:row.state==='pending'?[{...row}]:[]};
    if(sql.startsWith('UPDATE relay_outbox SET event_id')){row.event_id=args[1];row.event=args[2];}
    if(sql.includes("SET state='sent'"))row.state='sent';
    if(sql.startsWith('UPDATE users'))active=true;
    return {rows:[]};
  }};
  const relay={async publish(_key,event){assert.ok(now-event.created_at<900);assert.ok(verifyEvent(event));members.add(event.tags[0][1]);events.push(event.id);if(lost){lost=false;throw new Error('ack lost');}}};
  const pool={connect:async()=>client};
  await deliverOutbox(pool,relay,key);assert.equal(active,false);assert.notEqual(row.event.id,original);
  await deliverOutbox(pool,relay,key);assert.equal(active,true);assert.equal(members.size,1);assert.equal(events[0],events[1]);
});

test('Agent readiness is not committed before profile publication is confirmed',async()=>{
  const owner=generateSecretKey(),agent=generateSecretKey();
  const event=finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000),tags:[],content:'{"name":"helper","is_agent":true}'},agent);
  const row={event,event_id:event.id,actor_public_key:getPublicKey(agent),purpose:'agent-profile',subject_id:'agent',attempts:0,state:'pending'};
  let readinessWrites=0,fail=true;
  const client={release(){},async query(sql){
    if(sql.startsWith('SELECT *'))return {rows:row.state==='pending'?[{...row}]:[]};
    if(sql.includes("SET state='sent'"))row.state='sent';
    if(sql.startsWith('UPDATE agents')){assert.equal(row.state,'sent');readinessWrites++;}
    return {rows:[]};
  }};
  const relay={async publish(){assert.equal(readinessWrites,0);if(fail)throw new Error('Relay unavailable');}};
  const pool={connect:async()=>client};
  await deliverOutbox(pool,relay,owner,async()=>Uint8Array.from(agent));
  assert.equal(readinessWrites,0);assert.equal(row.state,'pending');
  fail=false;await deliverOutbox(pool,relay,owner,async()=>Uint8Array.from(agent));
  assert.equal(readinessWrites,1);assert.equal(row.state,'sent');
});
