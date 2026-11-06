import {setTimeout as delay} from 'node:timers/promises';
const origin=process.env.PUBLIC_ORIGIN ?? 'https://127.0.0.1:18443';
const deadline=Date.now()+60000;
while(true){
  try{const response=await fetch(origin+'/health',{signal:AbortSignal.timeout(3000)});if(response.ok && (await response.json()).status==='ok'){console.log('Application is ready');break;}}catch{}
  if(Date.now()>=deadline)throw new Error('Application did not become ready');
  await delay(500);
}
