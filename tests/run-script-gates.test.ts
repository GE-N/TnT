import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scriptFixture,deviceId} from './run-script-helpers.js';
import {ScriptBlocked} from '../server/script-validation.js';
import {buildRunPlan} from '../server/run-script-plan.js';
import {scriptHash,ScriptTrustConflict} from '../server/script-trust-store.js';

test('mutation guard: single-Run gate refuses untrusted imported source before all tools',async()=>{
 const f=await scriptFixture({mock:true});try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const imported=await f.service.importWorkspace({package:pkg.package,name:'Untrusted'});
  await assert.rejects(async()=>{const unexpected=await f.service.start({workspaceId:imported.id,deviceId,scenarioId:'one'});await f.service.wait(unexpected.id);},(error:unknown)=>error instanceof ScriptBlocked&&error.blocked.some(item=>item.kind==='untrusted'));
  assert.deepEqual(f.stats(),{toolCalls:0,acquisitions:0,mockCount:0,cleanupCount:0});assert.equal(f.calls.length,0);
 }finally{await f.cleanup();}
});
test('mutation guard: Run All gate fails untrusted entry without a run and continues to the safe entry',async()=>{
 const f=await scriptFixture({mock:true});try{
  const saved=await f.service.save({...f.workspace,scenarios:[f.scenario,{...f.scenario,id:'safe',scripts:[]}]});
  const pkg=await f.service.exportWorkspace({id:saved.id,expectedRevision:2,includeValues:true});const imported=await f.service.importWorkspace({package:pkg.package,name:'Batch'});
  const batch=await f.service.waitBatch((await f.service.startBatch({workspaceId:imported.id,deviceId})).id);
  assert.equal(batch.status,'completed');assert.deepEqual(batch.entries.map(entry=>[entry.status,entry.reason]),[['failed','Script needs trust'],['passed',undefined]]);
  assert.equal(batch.entries[0].runId,undefined);assert.ok(batch.entries[1].runId);assert.equal(f.stats().acquisitions,1);assert.equal(f.stats().mockCount,0);assert.equal(f.calls.length,1);
 }finally{await f.cleanup();}
});
test('mutation guard: trust hash must match even when a supplied decision says trusted/local',async()=>{
 const f=await scriptFixture();try{
  for(const origin of ['local','imported'] as const){
   const row={...f.row,source:'output.changed = true'};
   const plan=buildRunPlan({yaml:f.workspace.yaml,scripts:[row],trust:[{rowId:row.id,origin,trusted:true,hash:scriptHash(f.row.source)}]});
   assert.deepEqual(plan.blocked,[{kind:'untrusted',rowId:row.id,message:'Script needs trust'}]);assert.deepEqual(plan.scriptFiles,[]);
  }
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});const imported=await f.service.importWorkspace({package:pkg.package,name:'Hash approval'});
  const [approval]=(await f.service.scriptTrust(imported.id)).scripts;await f.service.trustScript({workspace:imported.id,rowId:approval.rowId,hash:approval.hash});
  imported.scenarios![0].scripts![0].source='output.editedAfterApproval = true';await f.service.save(imported);
  assert.equal((await f.service.scriptTrust(imported.id)).scripts[0].trusted,false);
  await assert.rejects(f.service.trustScript({workspace:imported.id,rowId:approval.rowId,hash:approval.hash}),ScriptTrustConflict);
  assert.equal(f.calls.length,0);
 }finally{await f.cleanup();}
});
