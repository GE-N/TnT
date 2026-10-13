import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
import {createWriteFaults} from '../server/workspace-store.js';
const yaml='appId: com.example.App\n---\n- launchApp\n';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'tnt-trash-'));const faults=createWriteFaults();
 const restart=()=>createScenarios({root,faults:faults.faults,runner:createRunner({artifactDirectory:root,execute:async()=>{throw new Error('No execution');}}),maestro:{version:async()=>'',run:async()=>{throw new Error('No execution');}}});
 return {root,faults,service:restart(),restart,close:()=>rm(root,{recursive:true,force:true})};
}
test('Trash survives restart, preserves authored references and drafts, and Restore never changes the active session',async()=>{
 const f=await fixture();try{
  const a=await f.service.save({name:'Deleted',yaml,canvas:{screens:[{id:'home',title:'Home',x:0,y:0,tests:[]}],edges:[],paths:[]}});
  await f.service.saveDraft(a.id,{baseRevision:1,expectedDraftRevision:0,name:a.name,content:{yaml:'broken: ['},fields:{'yaml-command':'unfinished'}});
  await f.service.saveView(a.id,{scenarioId:'chosen'});
  await f.service.trashWorkspace(a.id);
  assert.equal((await f.service.listWorkspaces()).items.length,0);
  assert.equal((await f.restart().listTrash()).items[0].name,'Deleted');
  assert.equal((await f.service.session()).lastActiveId,null);
  const b=await f.service.save({name:'Current',yaml});
  await f.restart().restoreWorkspace(a.id);
  const restored=await f.service.workspaceDetail(a.id);
  assert.deepEqual(restored.canvas,a.canvas);assert.equal(restored.draft?.fields['yaml-command'],'unfinished');assert.equal(restored.view?.scenarioId,'chosen');
  assert.equal((await f.service.session()).lastActiveId,b.id);
  await assert.rejects(f.service.save({...a,name:'Delayed save'}),/newer revision/);
  await assert.rejects(f.service.saveDraft(a.id,{baseRevision:1,expectedDraftRevision:1,name:a.name,content:{yaml},fields:{}}),/another tab/);
 }finally{await f.close();}
});

test('held content and draft writes serialize with deletion; writes arriving after it cannot resurrect the identity',async()=>{
 const f=await fixture();try{
  const a=await f.service.save({name:'Pending',yaml});
  f.faults.queue();const content=f.service.save({...a,name:'Acknowledged edit'});await f.faults.untilQueued();
  const deletion=f.service.trashWorkspace(a.id);f.faults.release();await content;await deletion;
  await assert.rejects(f.service.save({...a,name:'Late'}));
  await assert.rejects(f.service.saveDraft(a.id,{baseRevision:1,expectedDraftRevision:0,name:a.name,content:{yaml},fields:{}}));
  assert.equal((await f.service.listWorkspaces()).items.length,0);assert.equal((await f.service.listTrash()).items[0].name,'Acknowledged edit');
  const restored=await f.service.restoreWorkspace(a.id);
  f.faults.queue();const draft=f.service.saveDraft(a.id,{baseRevision:restored.metadata!.revision,expectedDraftRevision:0,name:a.name,content:{yaml:'broken: ['},fields:{'yaml-command':'queued'}});await f.faults.untilQueued();
  const remove=f.service.trashWorkspace(a.id);f.faults.release();await draft;await remove;
  await f.service.restoreWorkspace(a.id);assert.equal((await f.service.workspaceDetail(a.id)).draft?.fields['yaml-command'],'queued');
 }finally{f.faults.release();await f.close();}
});

test('failed deletion and restoration keep data recoverable; identity collisions and malformed Trash never overwrite work',async()=>{
 const f=await fixture();try{
  const a=await f.service.save({name:'Retained',yaml});
  const bytes=await readFile(join(f.root,'workspaces',a.id,'workspace.json'),'utf8');
  f.faults.failBeforeRename();await assert.rejects(f.service.trashWorkspace(a.id),/Injected/);
  assert.equal(await readFile(join(f.root,'workspaces',a.id,'workspace.json'),'utf8'),bytes);assert.equal((await f.service.listTrash()).items.length,0);assert.equal((await f.service.session()).lastActiveId,a.id);
  f.faults.pass();await f.service.trashWorkspace(a.id);
  const trashPath=join(f.root,'trash',a.id,'workspace.json');const trashBytes=await readFile(trashPath,'utf8');
  f.faults.reject();await assert.rejects(f.service.restoreWorkspace(a.id),/Injected/);assert.equal(await readFile(trashPath,'utf8'),trashBytes);
  f.faults.pass();await mkdir(join(f.root,'workspaces',a.id));await writeFile(join(f.root,'workspaces',a.id,'workspace.json'),bytes);
  await assert.rejects(f.service.restoreWorkspace(a.id),/identity already exists/);assert.equal(await readFile(trashPath,'utf8'),trashBytes);assert.equal(await readFile(join(f.root,'workspaces',a.id,'workspace.json'),'utf8'),bytes);
  await writeFile(trashPath,'{broken');const list=await f.service.listTrash();assert.equal(list.unreadable,1);await assert.rejects(f.service.restoreWorkspace(a.id));assert.equal(await readFile(join(f.root,'workspaces',a.id,'workspace.json'),'utf8'),bytes);
 }finally{f.faults.pass();await f.close();}
});

test('execution and cleanup block deletion without cancellation, and deletion leaves immutable run evidence intact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-trash-run-'));const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
 let finish=()=>{};const gate=new Promise<void>(resolve=>{finish=resolve;});let cancelled=false;
 const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/installed/app',stderr:''})}),maestro:{version:async()=>'2.11.0',run:async({directory,signal})=>{signal.addEventListener('abort',()=>{cancelled=true;});await gate;await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{status:'COMPLETED',depth:0}}]));return {code:0,log:'Retained evidence',cleanup:{verified:true,detail:'Exited'}};}}});
 try{
  const a=await service.save({name:'Executing',yaml});const other=await service.save({name:'Other',yaml});
  const starting=service.start({workspaceId:a.id,deviceId});
  await assert.rejects(service.trashWorkspace(a.id),/Active execution/);
  const run=await starting;await assert.rejects(service.start({workspaceId:a.id,deviceId}),/in progress/);await assert.rejects(service.trashWorkspace(a.id),/Active execution/);assert.equal(cancelled,false);
  await service.trashWorkspace(other.id);
  finish();const result=await service.wait(run.id);assert.equal(result.status,'passed');
  const evidencePath=join(root,'runs',run.id,'result.json');const before=await readFile(evidencePath,'utf8');
  await service.trashWorkspace(a.id);assert.equal(await readFile(evidencePath,'utf8'),before);assert.equal((await service.result(run.id)).snapshot.id,result.snapshot.id);
  await service.restoreWorkspace(a.id);assert.equal(await readFile(evidencePath,'utf8'),before);
 }finally{finish();await rm(root,{recursive:true,force:true});}
});

test('Restore cannot revive last-active identity when session cleanup failed after deletion committed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-trash-session-'));let writes=0;let failAt=0;
 const service=createScenarios({root,faults:{rejectWrite:()=>++writes===failAt?new Error('Session cleanup failure'):undefined},runner:createRunner({artifactDirectory:root,execute:async()=>{throw new Error('No execution');}}),maestro:{version:async()=>'',run:async()=>{throw new Error('No execution');}}});
 try{
  const saved=await service.save({name:'Session target',yaml});failAt=writes+2;
  await service.trashWorkspace(saved.id);assert.equal((await service.listTrash()).items[0].id,saved.id);
  await service.restoreWorkspace(saved.id);assert.equal((await service.session()).lastActiveId,null);
 }finally{await rm(root,{recursive:true,force:true});}
});
