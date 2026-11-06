import test from 'node:test';
import assert from 'node:assert/strict';
import {canUseAgent,privateParticipants} from '../src/team-im.mjs';
import {refreshEnrollment} from '../src/relay.mjs';
import {finalizeEvent,generateSecretKey} from 'nostr-tools';

test('personal Agents are owned; the team coordinator is available to members',()=>{
  const alice={id:'alice'},bob={id:'bob'};
  assert.equal(canUseAgent(alice,{owner_id:'alice',role:'personal'}),true);
  assert.equal(canUseAgent(bob,{owner_id:'alice',role:'personal'}),false);
  assert.equal(canUseAgent(bob,{owner_id:'alice',role:'coordinator'}),true);
});
test('private execution requires exactly the requester and selected Agent',()=>{
  assert.equal(privateParticipants({roles:{human:'member',agent:'member'}},'human','agent'),true);
  assert.equal(privateParticipants({roles:{human:'member',agent:'member',other:'member'}},'human','agent'),false);
  assert.equal(privateParticipants({roles:{human:'member',other:'member'}},'human','agent'),false);
});
test('enrollment renews before the Relay 120-second validity window expires',()=>{
  const key=generateSecretKey(),now=1800000000;
  const event=age=>finalizeEvent({kind:9030,created_at:now-age,tags:[['p','a'.repeat(64)],['role','member']],content:''},key);
  const fresh=event(10),old=event(121);
  assert.equal(refreshEnrollment(fresh,key,now),fresh);
  const renewed=refreshEnrollment(old,key,now);assert.equal(renewed.created_at,now);assert.notEqual(renewed.id,old.id);assert.deepEqual(renewed.tags,old.tags);
});
