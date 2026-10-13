import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScenarios,type Maestro} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
async function fixture(work:(service:ReturnType<typeof createScenarios>,root:string)=>Promise<void>,run:Maestro['run']){
 const root=await mkdtemp(join(tmpdir(),'tnt-batch-'));
 try{await work(createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=> '2.11.0',run}}),root);}finally{await rm(root,{recursive:true,force:true});}
}
async function saved(service:ReturnType<typeof createScenarios>){
 const yaml='appId: com.example.App\n---\n- launchApp\n- assertVisible: Home\n';
 const steps=(await service.references({yaml})).references.filter(ref=>ref.kind==='step');
 return service.save({name:'Batch workspace',yaml,scenarios:['first','second','third'].map(id=>({id,name:id,steps,inputs:{},parameters:{},enabledHandlerIds:[]}))});
}
async function evidence(directory:string,failed=false){
 await writeFile(join(directory,'report.xml'),`<testsuites><testsuite tests="1" failures="${failed?1:0}"/></testsuites>`);
 await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{visible:{textRegex:'Home'}}}},metadata:{depth:0,status:failed?'FAILED':'COMPLETED',error:failed?{message:'Home missing'}:undefined}}]));
 return {code:failed?1:0,log:'Boundary fixture',cleanup:{verified:true,detail:'Fixture process stopped'}};
}
test('batch freezes saved order and definitions, skips an invalid request, and continues after assertion cleanup',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);let calls=0;
 await fixture(async service=>{
  const workspace=await saved(service);const invalid={...workspace.scenarios![1],steps:[]};await service.save({...workspace,metadata:(await service.workspace(workspace.id)).metadata,scenarios:[workspace.scenarios![0],invalid,workspace.scenarios![2]]});
  const batch=await service.startBatch({workspaceId:workspace.id,deviceId});await started;
  assert.deepEqual((await service.batch(batch.id)).entries.map(item=>item.status),['running','not-run','queued']);
  await assert.rejects(service.start({workspaceId:workspace.id,deviceId,scenarioId:'third'}),/batch/i);
  await assert.rejects(service.trashWorkspace(workspace.id),/Active execution/);
  await service.save({...workspace,metadata:(await service.workspace(workspace.id)).metadata,scenarios:[{...workspace.scenarios![2],name:'Later edit'}]});release();
  const result=await service.waitBatch(batch.id);assert.equal(result.status,'completed');assert.deepEqual(result.entries.map(item=>item.status),['assertion-failed','not-run','passed']);assert.match(result.entries[1].reason!,/Draft/);
  const runs=await Promise.all(result.entries.filter(item=>item.runId).map(item=>service.result(item.runId!)));assert.deepEqual(runs.map(item=>item.snapshot.name),['first','third']);assert.notEqual(runs[0].id,runs[1].id);assert.equal(calls,2);assert.ok(runs.every(item=>item.cleanup.verified));
 },async({directory})=>{calls++;if(calls===1){entered();await gate;}return evidence(directory,calls===1);});
});

test('missing inputs are not-run while confidential runtime values stay out of the batch and run artifacts',async()=>fixture(async(service,root)=>{
 const workspace=await saved(service);workspace.scenarios![0].parameters={SECRET:{type:'text',required:true}};await service.save(workspace);
 const missing=await service.waitBatch((await service.startBatch({workspaceId:workspace.id,deviceId})).id);assert.equal(missing.entries[0].status,'not-run');assert.match(missing.entries[0].reason!,/Missing required input: SECRET/);assert.equal(missing.entries[1].status,'passed');
 const secret='private-value-26';const batch=await service.waitBatch((await service.startBatch({workspaceId:workspace.id,deviceId,runtimeInputs:{SECRET:secret}})).id);
 assert.doesNotMatch(await readFile(join(root,'batches',batch.id,'result.json'),'utf8'),new RegExp(secret));
 for(const entry of batch.entries){const run=await service.result(entry.runId!);assert.equal(run.status,'passed');assert.deepEqual(run.artifacts,['flow.yaml','snapshot.json']);assert.match(run.log,/withheld/);}
},async({directory})=>evidence(directory)));

test('cancellation waits for owned cleanup and never dispatches a second scenario',async()=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);let finish!:()=>void;const cleanup=new Promise<void>(resolve=>finish=resolve);let calls=0;
 await fixture(async service=>{
  const workspace=await saved(service);const batch=await service.startBatch({workspaceId:workspace.id,deviceId});await started;
  let returned=false;const cancelling=service.cancelBatch(batch.id).then(result=>{returned=true;return result;});await new Promise(resolve=>setImmediate(resolve));assert.equal(returned,false);
  await assert.rejects(service.startBatch({workspaceId:workspace.id,deviceId}),/in progress/);finish();const result=await cancelling;
  assert.equal(result.status,'cancelled');assert.deepEqual(result.entries.map(item=>item.status),['cancelled','not-run','not-run']);assert.equal(calls,1);assert.ok((await service.result(result.entries[0].runId!)).cleanup.verified);
 },async({directory,signal})=>{calls++;entered();await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});await cleanup;return evidence(directory);});
});

for(const failure of ['cleanup','tool','ownership'] as const)test(failure+' failure blocks further batch dispatch through ordinary device ownership',async()=>{
 let calls=0;
 await fixture(async(service,root)=>{
  const workspace=await saved(service);
  const other=createRunner({artifactDirectory:join(root,'other'),ownershipDirectory:root,execute:async()=>({stdout:'',stderr:''})});
  const release=failure==='ownership'?await other.acquireDevice(deviceId):undefined;
  const batch=await service.waitBatch((await service.startBatch({workspaceId:workspace.id,deviceId})).id);
  assert.equal(batch.status,'blocked');assert.equal(batch.entries[1].status,'not-run');assert.match(batch.entries[1].reason!,failure==='cleanup'?/cleanup.*unverified/:failure==='ownership'?/ownership|operation/:/tool-error/);assert.equal(calls,failure==='ownership'?0:1);
  if(failure==='cleanup')await assert.rejects(other.acquireDevice(deviceId),/operation/);
  await release?.();
 },async({directory})=>{calls++;const result=await evidence(directory);return {...result,code:failure==='tool'?9:0,cleanup:{verified:failure!=='cleanup',detail:'Fixture cleanup result'}};});
});

test('cancelling during run preparation prevents even the first tool process from starting',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-batch-prepare-'));let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);let finish!:()=>void;const gate=new Promise<void>(resolve=>finish=resolve);
 try{
  const runner=createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})});
  const service=createScenarios({root,runner,maestro:{version:async()=>{entered();await gate;return '2.11.0';},run:async()=>{assert.fail('Cancelled preparation must never start a process');}}});
  const workspace=await saved(service);const batch=await service.startBatch({workspaceId:workspace.id,deviceId});await started;
  const cancelling=service.cancelBatch(batch.id);finish();const result=await cancelling;assert.equal(result.status,'cancelled');assert.ok(result.entries.every(entry=>entry.status==='not-run'));assert.match(result.entries[0].reason!,/cancelled/);
  const release=await runner.acquireDevice(deviceId);await release();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a failed batch summary write cancels the dispatched process and waits for its cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-batch-write-'));let batchPath='';let aborted!:()=>void;const stopped=new Promise<void>(resolve=>aborted=resolve);let finish!:()=>void;const cleanup=new Promise<void>(resolve=>finish=resolve);
 try{
  const runner=createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})});
  const service=createScenarios({root,runner,maestro:{version:async()=>{
   const {readdir,rename,mkdir}=await import('node:fs/promises');batchPath=join(root,'batches',(await readdir(join(root,'batches')))[0],'result.json');await rename(batchPath,batchPath+'.saved');await mkdir(batchPath);return '2.11.0';
  },run:async({directory,signal})=>{await new Promise<void>(resolve=>{if(signal.aborted){aborted();resolve();}else signal.addEventListener('abort',()=>{aborted();resolve();},{once:true});});await cleanup;return evidence(directory);}}});
  const workspace=await saved(service);const batch=await service.startBatch({workspaceId:workspace.id,deviceId});const terminal=service.waitBatch(batch.id);await stopped;
  await assert.rejects(service.startBatch({workspaceId:workspace.id,deviceId}),/in progress/);
  const {rename}=await import('node:fs/promises');await rm(batchPath,{recursive:true});await rename(batchPath+'.saved',batchPath);finish();
  const result=await terminal;assert.equal(result.status,'blocked');assert.equal(result.entries[0].status,'cancelled');assert.equal(result.entries[1].status,'not-run');assert.equal((await service.result(result.entries[0].runId!)).cleanup.verified,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('workspace skip preferences survive reopening while legacy scenarios remain included',async()=>fixture(async service=>{
 const workspace=await saved(service);
 const updated=await service.save({...workspace,metadata:(await service.workspace(workspace.id)).metadata,scenarios:workspace.scenarios!.map((item,index)=>({...item,...(index===1?{skipInRunAll:true}:{})}))});
 const reopened=await service.workspace(updated.id);
 assert.equal(reopened.scenarios![1].skipInRunAll,true);
 assert.equal(reopened.scenarios![0].skipInRunAll,undefined);
 await assert.rejects(service.save({...workspace,scenarios:[{...workspace.scenarios![0],skipInRunAll:'yes'}]}),/skip.*boolean/i);
},async({directory})=>evidence(directory)));

test('Run All omits intentional skips in saved order, validates included drafts, and allows individual skipped runs',async()=>fixture(async service=>{
 const workspace=await saved(service);
 const scenarios=Array.from({length:12},(_,index)=>({...workspace.scenarios![0],id:'case-'+(index+1),name:'Case '+(index+1),skipInRunAll:[2,9].includes(index)}));
 await service.save({...workspace,metadata:(await service.workspace(workspace.id)).metadata,scenarios});
 const batch=await service.waitBatch((await service.startBatch({workspaceId:workspace.id,deviceId})).id);
 assert.deepEqual(batch.entries.map(entry=>entry.name),['Case 1','Case 2','Case 4','Case 5','Case 6','Case 7','Case 8','Case 9','Case 11','Case 12']);
 assert.ok(batch.entries.every(entry=>entry.status==='passed'));
 const individual=await service.wait((await service.start({workspaceId:workspace.id,deviceId,scenarioId:'case-3'})).id);
 assert.equal(individual.status,'passed');assert.equal(individual.snapshot.scenario?.skipInRunAll,true);
 await service.save({...workspace,metadata:(await service.workspace(workspace.id)).metadata,scenarios:scenarios.map((item,index)=>({...item,steps:index===0||index===2?[]:item.steps}))});
 const drafts=await service.waitBatch((await service.startBatch({workspaceId:workspace.id,deviceId})).id);
 assert.equal(drafts.entries[0].status,'not-run');assert.match(drafts.entries[0].reason!,/Draft/);
 assert.equal(drafts.entries.length,10);
 await service.save({...workspace,metadata:(await service.workspace(workspace.id)).metadata,scenarios:scenarios.map(item=>({...item,skipInRunAll:true}))});
 await assert.rejects(service.startBatch({workspaceId:workspace.id,deviceId}),/No scenarios.*included/i);
 await assert.rejects(service.startBatch({workspaceId:workspace.id,deviceId,scenarioIds:[]}),/distinct scenario IDs/);
 // An explicit subset is still an intentional request, independent of the Run All preference.
 const explicit=await service.waitBatch((await service.startBatch({workspaceId:workspace.id,deviceId,scenarioIds:['case-10','case-3']})).id);
 assert.deepEqual(explicit.entries.map(entry=>entry.scenarioId),['case-10','case-3']);assert.ok(explicit.entries.every(entry=>entry.status==='passed'));
},async({directory})=>evidence(directory)));
