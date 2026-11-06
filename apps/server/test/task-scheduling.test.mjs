import test from 'node:test';
import assert from 'node:assert/strict';
import {selectDispatchTasks} from '../src/task-scheduling.mjs';

test('a paused task can stop while every model lane is occupied; control work stays bounded',()=>{
  const busy=new Map([['a',{lane:'slow'}],['b',{lane:'slow'}],['c',{lane:'fast'}]]);
  const row=(id,cancel,lane='slow')=>({id,session_binding_id:id,cancel_requested:cancel,lane});
  const pending=[row('next',false),row('stop',true),row('another-stop',true)];
  assert.deepEqual(selectDispatchTasks(pending,busy).map(t=>t.id),['stop']);
  busy.set('stop',{lane:'slow',stopOnly:true});
  assert.deepEqual(selectDispatchTasks(pending,busy),[]);
});
test('slow work preserves the coordinator slot and only one task writes a binding',()=>{
  const rows=[{id:'1',session_binding_id:'same',lane:'slow'},{id:'2',session_binding_id:'same',lane:'fast'},
    {id:'3',session_binding_id:'other',lane:'slow'},{id:'4',session_binding_id:'third',lane:'slow'},{id:'5',session_binding_id:'fast',lane:'fast'}];
  assert.deepEqual(selectDispatchTasks(rows,new Map()).map(t=>t.id),['1','3','5']);
});
