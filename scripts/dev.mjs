import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const child=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1470','--strictPort'],{
  cwd:resolve(root,'upstream/buzz-app'),stdio:'inherit',
  env:{...process.env,BUZZ_TEAM_WEB:'1',BUZZ_RELAY_URL:process.env.BUZZ_RELAY_URL??'https://127.0.0.1:18444',BUZZ_TEAM_CA:process.env.BUZZ_TEAM_CA??resolve(root,'.runtime/ca.crt')},
});
child.once('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
