import test from 'node:test';
import assert from 'node:assert/strict';
import {memberBindings} from '../../../integrations/dsh-bridge/policy.mjs';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('workspace peer has only current grants and no owner or administrative methods',t=>{
  const temp=mkdtempSync(join(tmpdir(),'group-policy-')),root=join(temp,'work');mkdirSync(root);mkdirSync(join(temp,'private'));
  writeFileSync(join(temp,'private','secret'),'sentinel');symlinkSync(join(temp,'private'),join(root,'escape'));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const principal={user:'alice',login:'login-a'};
  const grants=new Map([['login-a',{user:'alice',expires:Date.now()+1000,sessions:['s-group']}]]);
  const bindings=memberBindings(principal,grants,[{id:'w-group',sessionIds:['s-group']},{id:'w-private',sessionIds:['s-private']}],root);
  assert.deepEqual(bindings.map(x=>x.resource),[{kind:'global'},{kind:'session',id:'s-group'},{kind:'workspace',id:'w-group'}]);
  assert.ok(bindings.every(x=>!x.role.actions.includes('session/create')&&!x.role.actions.includes('credentials/get')));
  const condition=bindings[1].condition;
  assert.equal(condition({action:'workspaceFiles/read',args:{path:'report.md'}}).kind,'allow');
  for(const path of ['../../run/space/bridge.key','/etc/passwd','/work-other/private','~/.dsh/config.yaml','escape/secret','escape/missing'])for(const action of ['workspaceFiles/read','workspaceFiles/readBytes','workspaceFiles/stat'])assert.equal(condition({action,args:{path}}).kind,'deny');
  assert.equal(condition({action:'workspaceFiles/readBytes',args:{path:'secret',options:{baseFile:'escape/secret'}}}).kind,'deny');
  assert.equal(condition({action:'workspaceFiles/readBytes',args:{path:'report.md',options:{baseFile:'/private/x'}}}).kind,'deny');
  grants.delete('login-a');assert.deepEqual(memberBindings(principal,grants,[],'/work'),[]);
});

test('expired or mismatched identity loses every grant',()=>{
  const grants=new Map([['login-a',{user:'alice',expires:Date.now()-1,sessions:['s-group']}]]);
  assert.deepEqual(memberBindings({user:'alice',login:'login-a'},grants,[],'/work'),[]);
  grants.get('login-a').expires=Date.now()+1000;
  assert.deepEqual(memberBindings({user:'bob',login:'login-a'},grants,[],'/work'),[]);
});
