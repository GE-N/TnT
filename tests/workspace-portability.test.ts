import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
const yaml='appId: com.example.App\n---\n- launchApp\n';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'tnt-portable-'));
 const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async()=>{throw new Error('Import must not execute');}}),maestro:{version:async()=>'',run:async()=>{throw new Error('Import must not execute');}}});
 return {service,close:()=>rm(root,{recursive:true,force:true})};
}
test('export reviews a saved revision, excludes stored values by default, and imports an independent editable copy',async()=>{
 const {service,close}=await fixture();
 try{
  const steps=(await service.references({yaml})).references.map(({kind,file,index,fingerprint})=>({kind,file,index,fingerprint}));
  const original=await service.save({name:'Checkout workspace',yaml,scenarios:[{id:'checkout',name:'Checkout',steps,inputs:{ACCOUNT:'private-account'},parameters:{ACCOUNT:{type:'text',required:true}},enabledHandlerIds:[]}]});
  const exported=await service.exportWorkspace({id:original.id,expectedRevision:1});
  assert.equal(exported.package.format,'tnt-workspace');assert.equal(exported.package.version,1);
  assert.match(exported.filename,/Checkout-workspace.*\.json$/);
  assert.ok(!JSON.stringify(exported.package).includes('private-account'));
  assert.deepEqual(exported.package.workspace.scenarios![0].inputs,{});
  assert.deepEqual(exported.package.workspace.scenarios![0].parameters,original.scenarios![0].parameters);
  assert.ok(exported.review.missing.some(detail=>detail.includes('ACCOUNT')));
  const imported=await service.importWorkspace({package:exported.package,name:'Imported checkout'});
  assert.notEqual(imported.id,original.id);assert.equal(imported.name,'Imported checkout');
  assert.equal((await service.workspace(original.id)).scenarios![0].inputs.ACCOUNT,'private-account');
  await assert.rejects(service.start({workspaceId:imported.id,deviceId:'unused',scenarioId:'checkout'}),/ACCOUNT/);
  const opted=await service.exportWorkspace({id:original.id,expectedRevision:1,includeValues:true});
  assert.equal(opted.package.workspace.scenarios![0].inputs.ACCOUNT,'private-account');
  await service.renameWorkspace(original.id,'New revision',1);
  await assert.rejects(service.exportWorkspace({id:original.id,expectedRevision:1}),/newer revision/);
 }finally{await close();}
});

test('malformed, unsafe, oversized and newer packages never create partial work; unresolved safe flows remain repairable',async()=>{
 const {service,close}=await fixture();
 try{
  const source=await service.save({name:'Source',yaml});
  const exported=await service.exportWorkspace({id:source.id,expectedRevision:1});
  for(const bad of ['{bad',JSON.stringify(exported.package).replace('"version":1','"version":2'),' '.repeat(1_100_001),'{"__proto__":{"polluted":true}}',{...exported.package,workspace:{...exported.package.workspace,token:'private'}},{...exported.package,workspace:{...exported.package.workspace,yaml:'appId: com.example.App\n---\n- runScript: /Users/private.js\n'}}]){
   await assert.rejects(service.importWorkspace({package:bad,name:'Bad'}));
   assert.equal((await service.listWorkspaces()).items.length,1);
  }
  const unresolved={...exported.package,workspace:{...exported.package.workspace,yaml:'appId: com.example.App\n---\n- runFlow: missing.yaml\n'}};
  const review=await service.reviewWorkspacePackage({package:unresolved});
  assert.ok(review.review.missing.some(detail=>detail.includes('missing.yaml')));
  const copy=await service.importWorkspace({package:unresolved,name:'Needs repair'});
  assert.equal((await service.workspace(copy.id)).yaml,unresolved.workspace.yaml);
  await assert.rejects(service.start({workspaceId:copy.id,deviceId:'unused'}),/declared reusable/);
 }finally{await close();}
});

test('failed atomic import leaves the editor session and library intact and retry creates exactly one complete copy',async()=>{
 const {createWriteFaults}=await import('../server/workspace-store.js');
 const root=await mkdtemp(join(tmpdir(),'tnt-import-failure-'));const faults=createWriteFaults();
 const service=createScenarios({root,faults:faults.faults,runner:createRunner({artifactDirectory:root,execute:async()=>{throw new Error('Must not execute');}}),maestro:{version:async()=>'',run:async()=>{throw new Error('Must not execute');}}});
 try{
  const source=await service.save({name:'Source',yaml});const exported=await service.exportWorkspace({id:source.id,expectedRevision:1});
  faults.failBeforeRename();await assert.rejects(service.importWorkspace({package:exported.package,name:'Imported'}),/Injected/);faults.pass();
  assert.deepEqual(await service.session(),{lastActiveId:source.id});
  const list=await service.listWorkspaces();assert.equal(list.items.length,1);assert.equal(list.unreadable,0);
  const copy=await service.importWorkspace({package:exported.package,name:'Imported'});
  assert.equal((await service.workspace(copy.id)).yaml,yaml);assert.equal((await service.listWorkspaces()).items.length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('unsafe reference images and dormant machine paths cannot enter a portable package',async()=>{
 const {service,close}=await fixture();
 try{
  const source=await service.save({name:'Images',yaml});const exported=await service.exportWorkspace({id:source.id,expectedRevision:1});
  const bad={...exported.package,workspace:{...exported.package.workspace,canvas:{screens:[{id:'home',title:'Home',x:0,y:0,tests:[],referenceScreenshot:'data:image/png;base64,bm90IGFuIGltYWdl'}],edges:[],paths:[]}}};
  await assert.rejects(service.importWorkspace({package:bad,name:'Bad image'}),/PNG|JPEG/);
  assert.equal((await service.listWorkspaces()).items.length,1);
 }finally{await close();}
});

test('export during execution captures a stable acknowledged revision and leaves immutable run snapshots intact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-export-run-'));const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
 let release=()=>{};let entered=()=>{};const running=new Promise<void>(resolve=>{entered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
 const runner=createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})});
 const service=createScenarios({root,runner,maestro:{version:async()=>'2.11.0',run:async()=>{entered();await held;return {code:0,log:'Fixture',cleanup:{verified:true,detail:'Fixture exited'}};}}});
 try{
  const source=await service.save({name:'Executed title',yaml});const run=await service.start({workspaceId:source.id,deviceId});await running;
  const snapshot=structuredClone((await service.result(run.id)).snapshot);
  const exported=await service.exportWorkspace({id:source.id,expectedRevision:1});
  await service.save({...source,name:'Later title',yaml:yaml+'- assertVisible: Later\n'});
  assert.equal(exported.package.workspace.name,'Executed title');assert.equal(exported.package.source.revision,1);assert.equal(exported.package.workspace.yaml,yaml);
  assert.deepEqual((await service.result(run.id)).snapshot,snapshot);assert.equal((await service.result(run.id)).status,'running');
  release();await service.wait(run.id);assert.deepEqual((await service.result(run.id)).snapshot,snapshot);
 }finally{release();await rm(root,{recursive:true,force:true});}
});
