import {resolve,dirname} from 'node:path';
import {realpathSync} from 'node:fs';

function contained(path,root) {return path===root || path.startsWith(root+'/');}
function realAncestor(path) {
  try{return realpathSync(path);}catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(path);if(parent===path)throw error;return realAncestor(parent);}
}
export function workspacePathAllowed(path,root,baseFile) {
  if(typeof path!=='string' || path.startsWith('~') || path.includes('\0'))return false;
  if(baseFile!==undefined && !workspacePathAllowed(baseFile,root))return false;
  const absolute=resolve(baseFile===undefined?root:dirname(resolve(root,baseFile)),path);
  if(!contained(absolute,root))return false;
  try{return contained(realAncestor(absolute),realpathSync(root));}catch{return false;}
}

const globalActions = ['session/list','session/control','session/modelCatalog','workspace/follow','commands/list','llm/listProviders','llm/listConfigurableProviders'];
const sessionActions = ['session/list','session/control','session/state','session/page','session/events','session/follow','session/observeState','session/observeEvent','session/observeProjections','session/projections','session/wait','session/attachment','workspace/follow','workspaceFiles/list','workspaceFiles/read','workspaceFiles/readBytes','workspaceFiles/stat','workspaceFiles/watch','workspaceFiles/changes','terminal/list','terminal/environment','terminal/shells','terminal/create','terminal/attach','terminal/retain','terminal/close','terminal/release','toolResults/watch','event:api-session/activity','event:api-session/added','event:api-session/error','event:api-session/removed','event:api-session/status'];

/** Each process belongs to exactly one access domain; no host owner grant. */
export function memberBindings(principal, grants, workspaces, workspaceRoot) {
  const grant=grants.get(principal.login);
  if(!grant || grant.user!==principal.user || grant.expires<=Date.now())return [];
  const sessions=new Set(grant.sessions);
  const role=(resource,actions)=>({name:`group-member-${resource}`,resource,actions});
  const condition=({action,args})=>{
    if(!action.startsWith('workspaceFiles/') || !args)return {kind:'allow'};
    if(args.path!==undefined && !workspacePathAllowed(args.path,workspaceRoot,args.options?.baseFile))return {kind:'deny',reason:'outside-workspace'};
    return {kind:'allow'};
  };
  return [
    {role:role('global',globalActions),resource:{kind:'global'}},
    ...[...sessions].map(id=>({role:role('session',sessionActions),resource:{kind:'session',id},condition})),
    ...workspaces.filter(w=>w.sessionIds.some(id=>sessions.has(id))).map(w=>({role:role('workspace',['workspace/follow']),resource:{kind:'workspace',id:w.id}})),
  ];
}
