import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools';
import { digest } from './crypto.mjs';
import {randomBytes,randomUUID} from 'node:crypto';

/** A signed request binds its method, URL and exact serialized body. */
export function authorization(key, url, method, body) {
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now()/1000), content: '',
    tags: [['u',url],['method',method],['nonce',randomBytes(16).toString('hex')], ...(body === undefined ? [] : [['payload', digest(body)]])],
  }, key);
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');
}

export function relayClient(config) {
  async function request(key, path, value) {
    const url = config.relayOrigin + path;
    const method = value === undefined ? 'GET' : 'POST';
    const body = value === undefined ? undefined : JSON.stringify(value);
    const response = await fetch(url, {method, body, redirect:'error', signal: AbortSignal.timeout(20000),
      headers: {Authorization:authorization(key,url,method,body), ...(body ? {'Content-Type':'application/json'} : {})}});
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`Relay request failed (${response.status})`);
      error.status = response.status;
      error.detail = text.slice(0,1000);
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }
  return {
    request,
    sign(key, template) {return finalizeEvent({...template,created_at:template.created_at ?? Math.floor(Date.now()/1000)},key);},
    async publish(key,event) {
      if (!verifyEvent(event) || event.pubkey !== getPublicKey(key)) throw new Error('Invalid signed event');
      const result = await request(key,'/events',event);
      if (result?.accepted !== true || result?.event_id !== event.id) {
        const error = new Error('Relay refused event'); error.detail = JSON.stringify(result); throw error;
      }
      return result;
    },
    async query(key,filters) {
      const result = await request(key,'/query',filters);
      const events = Array.isArray(result) ? result : result?.events;
      if (!Array.isArray(events) || events.some(event => !verifyEvent(event))) throw new Error('Invalid relay query response');
      return events;
    }
  };
}

export function refreshEnrollment(event,ownerKey,now=Math.floor(Date.now()/1000)) {
  if(event.kind!==9030 || Math.abs(now-event.created_at)<90)return event;
  // Relay enrollment is idempotent by member. Expired proofs must be renewed;
  // unlike message publication, the operation identity is the target member.
  return finalizeEvent({kind:9030,tags:event.tags,content:event.content,created_at:now},ownerKey);
}

/** Reuse publication proofs while fresh; renew only idempotent enrollment. */
export async function deliverOutbox(pool, relay, ownerKey,resolveActor) {
  const client=await pool.connect();
  let row,key,open=false,claimed=false;
  const claim=randomUUID();
  try {
    await client.query('BEGIN');open=true;
    const {rows}=await client.query("SELECT * FROM relay_outbox WHERE state='pending' AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
    if(!rows.length){await client.query('COMMIT');open=false;return false;}
    row=rows[0];
    key=row.actor_public_key && row.actor_public_key!==getPublicKey(ownerKey)
      ? await resolveActor?.(row.actor_public_key) : ownerKey;
    if(!key)throw new Error('Outbox actor unavailable');
    let alreadyPublished=false,renewed;
    if(row.purpose==='enroll-user' || row.purpose==='enroll-agent')renewed=refreshEnrollment(row.event,ownerKey);
    else if((row.event.kind===9 || row.purpose==='agent-profile') && Math.abs(Math.floor(Date.now()/1000)-row.event.created_at)>=600) {
      // A lost receipt is different from an absent event. Read the persisted
      // proof ID strongly before considering a new timestamp-bound proof.
      alreadyPublished=(await relay.query(key,[{ids:[row.event.id],limit:1,consistency:'strong'}])).some(e=>e.id===row.event.id);
      if(!alreadyPublished)renewed=relay.sign(key,{kind:row.event.kind,tags:row.event.tags,content:row.event.content});
    }
    if(renewed && renewed.id!==row.event_id) {
      await client.query('UPDATE relay_outbox SET event_id=$2,event=$3 WHERE event_id=$1',[row.event_id,renewed.id,renewed]);
      row={...row,event_id:renewed.id,event:renewed};
    }
    // Commit the exact proof BEFORE the external side effect. A crash after
    // acceptance must retry this ID, even when the acknowledgement is lost.
    await client.query("UPDATE relay_outbox SET lease_owner=$2,lease_until=now()+interval '120 seconds' WHERE event_id=$1",[row.event_id,claim]);
    await client.query('COMMIT');open=false;claimed=true;
    if(!alreadyPublished)await relay.publish(key,row.event);
    await client.query('BEGIN');open=true;
    if(['enroll-agent','agent-profile'].includes(row.purpose))await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE',[row.subject_id]);
    await client.query("UPDATE relay_outbox SET state='sent',attempts=attempts+1,last_error=NULL,lease_owner=NULL,lease_until=NULL WHERE event_id=$1 AND lease_owner=$2",[row.event_id,claim]);
    if(row.purpose==='enroll-user')await client.query("UPDATE users SET state='active' WHERE id=$1 AND state='pending'",[row.subject_id]);
    if(['enroll-agent','agent-profile'].includes(row.purpose))await client.query(`UPDATE agents SET enabled=true WHERE id=$1
      AND EXISTS(SELECT 1 FROM relay_outbox WHERE subject_id=$1 AND purpose='enroll-agent' AND state='sent')
      AND EXISTS(SELECT 1 FROM relay_outbox WHERE subject_id=$1 AND purpose='agent-profile' AND state='sent')`,[row.subject_id]);
    await client.query('COMMIT');open=false;
    return true;
  } catch(error) {
    if(open)await client.query('ROLLBACK').catch(()=>{});
    if(!row)throw error;
    await client.query(`UPDATE relay_outbox SET attempts=attempts+1,last_error=$2,next_attempt_at=now()+make_interval(secs=>$3),lease_owner=NULL,lease_until=NULL
      WHERE event_id=$1 AND state='pending' AND ${claimed?'lease_owner=$4':'(lease_until IS NULL OR lease_until<now())'}`,
      [row.event_id,String(error.detail??error.message).slice(0,1000),Math.min(300,2**Math.min(row.attempts+1,8)),...(claimed?[claim]:[])]);
    return true;
  } finally {if(key && key!==ownerKey)key.fill(0);client.release();}
}
