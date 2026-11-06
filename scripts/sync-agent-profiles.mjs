import {readConfig} from '../apps/server/src/config.mjs';
import {database} from '../apps/server/src/db.mjs';
import {unseal} from '../apps/server/src/crypto.mjs';
import {relayClient} from '../apps/server/src/relay.mjs';
// One-time metadata repair: Buzz reads is_agent, not the legacy bot field.
const config=readConfig(),pool=database(config.databaseUrl),relay=relayClient(config);
try {
  const {rows}=await pool.query('SELECT id,name,public_key,encrypted_key,avatar FROM agents WHERE enabled');
  for(const agent of rows){
    const key=unseal(agent.encrypted_key,config.vaultKey,agent.id);
    try{
      const [profile]=await relay.query(key,[{kinds:[0],authors:[agent.public_key],limit:1}]);
      const content={...JSON.parse(profile?.content??'{}'),name:agent.name,display_name:agent.name,is_agent:true,picture:`${config.publicOrigin}/avatars/${agent.avatar}.svg`};
      await relay.publish(key,relay.sign(key,{kind:0,tags:[],content:JSON.stringify(content)}));
    }finally{key.fill(0);}
  }
  console.log(`Updated ${rows.length} Agent profiles using the native Buzz field`);
}finally{await pool.end();}
