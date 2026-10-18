import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {scriptFixture,deviceId,assertTokenFree} from './run-script-helpers.js';
import {mapScriptResults} from '../server/run-script-results.js';
import {buildRunPlan} from '../server/run-script-plan.js';
import {createScenarios} from '../server/scenarios.js';
import {ScriptBlocked} from '../server/script-validation.js';

test('trusted local scripts execute only at Run, stay non-confidential, map by row and clean up',async()=>{
 const f=await scriptFixture({mock:true});try{
  await f.service.preview({...f.workspace,scenarioId:'one'});assert.equal(f.calls.length,0);
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});await f.service.reviewWorkspacePackage({package:pkg.package});assert.equal(f.calls.length,0);
  const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'passed');assert.equal(f.outputs[0].X,'ไทย quote');
  assert.deepEqual(result.scriptSteps,{'script-one':{kind:'runScript',rowId:'script-one',status:'passed'}});
  assert.deepEqual(result.steps.map(step=>step.status),['passed','passed','passed']);assert.deepEqual(result.executionOrder,[{kind:'step',index:0},{kind:'runScript',rowId:'script-one'},{kind:'step',index:1},{kind:'step',index:2}]);
  assert.equal(Object.hasOwn(f.calls[0].runtimeInputs??{},'TNT_MOCK_TOKEN'),false);assert.equal(f.calls[0].scriptEnv?.TNT_MOCK_TOKEN,f.tokens[0]);assert.doesNotMatch(result.log,/withheld/);assert.match(result.log,/\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(result.snapshot),new RegExp(f.tokens[0]));assert.equal((await readdir(join(f.root,'runs',result.id))).some(name=>name.endsWith('.js')),false);
  await assertTokenFree(f,result.id);assert.equal(f.stats().cleanupCount,1);
 }finally{await f.cleanup();}
});
for(const status of [400,500])test(`http ${status} with response.ok guard stops later authored steps and scripts`,async()=>{
 const f=await scriptFixture({mock:true,httpStatus:status,source:'const response = http.get(TNT_MOCK_URL); if (!response.ok) throw new Error("ผิด HTTP " + response.status + " " + TNT_MOCK_TOKEN);'});try{
  const workspace=await f.service.save({...f.workspace,scenarios:[{...f.scenario,scripts:[f.row,{...f.row,id:'script-two'}]}]});
  const result=await f.service.wait((await f.service.start({workspaceId:workspace.id,deviceId,scenarioId:'one'})).id);
  assert.equal(result.status,'script-error');assert.equal(result.scriptSteps?.['script-one'].status,'script-error');assert.match(result.scriptSteps!['script-one'].message!,new RegExp('ผิด HTTP '+status+' \\[redacted\\]'));
  assert.equal(result.scriptSteps?.['script-two'].status,'not-run');assert.deepEqual(result.steps.map(step=>step.status),['passed','not-run','not-run']);assert.doesNotMatch(result.error!,/Unknown error/);await assertTokenFree(f,result.id);
 }finally{await f.cleanup();}
});
for(const terminal of ['timeout','cancel','crash'] as const)test('all-terminal evidence protection: '+terminal,async()=>{
 const f=await scriptFixture({mock:true,terminal});try{
  const run=await f.start();const result=terminal==='cancel'?await f.service.cancel(run.id):await f.service.wait(run.id);
  assert.equal(result.status,terminal==='cancel'?'cancelled':'tool-error');if(terminal==='timeout')assert.equal(result.error,'Run stopped at 300s cap');
  await assertTokenFree(f,result.id);assert.equal(f.stats().cleanupCount,1);assert.equal((await readdir(join(f.root,'runs',result.id))).some(name=>name.endsWith('.js')),false);
  if(terminal==='crash')await assert.rejects(f.runner.acquireDevice(deviceId),/in progress/);
 }finally{await f.cleanup();}
});
for(const scrubber of [async()=>{throw new Error('forced failure');},async()=>{}])test('parameter-only scrub failure and leftover token fail closed',async()=>{
 const f=await scriptFixture({mock:true,scrubber});try{const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'error');assert.equal(result.error,'Evidence scrub failed');assert.deepEqual(result.artifacts,[]);assert.deepEqual((await readdir(join(f.root,'runs',result.id))).sort(),['result.json']);await assertTokenFree(f,result.id);}finally{await f.cleanup();}
});
for(const mockFailure of ['prepare','evidence','cleanup'] as const)test('mock '+mockFailure+' exception cannot bypass cleanup/scrub',async()=>{
 const f=await scriptFixture({mock:true,mockFailure});try{const result=await f.service.wait((await f.start()).id);assert.equal(result.status,mockFailure==='prepare'?'setup-error':'tool-error');assert.equal(f.stats().cleanupCount,1);await assertTokenFree(f,result.id);if(mockFailure==='cleanup')assert.equal(result.cleanup.verified,false);}finally{await f.cleanup();}
});
test('no mock JS/output works with omitted env; zero scripts set no credentials',async()=>{
 const f=await scriptFixture();try{const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'passed');assert.equal(f.calls[0].scriptEnv,undefined);assert.equal(f.outputs[0].X,'ไทย quote');}finally{await f.cleanup();}
 const g=await scriptFixture({mock:true});try{await g.service.save({...g.workspace,scenarios:[{...g.scenario,scripts:[]}]});await g.service.wait((await g.start()).id);assert.equal(g.calls[0].scriptEnv,undefined);}finally{await g.cleanup();}
});
test('script error precedence uses structured marker, then log; Graal syntax failures remain readable',async()=>{
 const f=await scriptFixture();try{
  const plan=buildRunPlan({yaml:f.workspace.yaml,scripts:[f.row],trust:[{rowId:f.row.id,origin:'local',hash:'',trusted:true}]});
  const first={command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}};
  for(const [message,log,expected] of [['TNT_SCRIPT_FAILED row=script-one ไทย structured','TNT_SCRIPT_FAILED row=script-one log','ไทย structured'],['Unknown error','TNT_SCRIPT_FAILED row=script-one ไทย log','ไทย log'],['SyntaxError: Graal rejects this','','SyntaxError: Graal rejects this']]){
   const commands=[first,{command:{runScriptCommand:{}},metadata:{depth:0,status:'FAILED',error:{message}}}];
   const mapped=mapScriptResults(plan,commands,log,false);assert.equal(mapped.failure,expected);assert.deepEqual(mapped.notRunIndexes,[1,2]);
  }
 }finally{await f.cleanup();}
});
test('empty, stale, syntax and breakout blocks precede every acquisition, app, mock and Maestro call',async()=>{
 for(const patch of [{source:''},{beforeStep:{index:99,fingerprint:'a'.repeat(64)}},{source:'} catch(e){}; writeMarker(); try {'},{source:'/*'}]){
  const f=await scriptFixture({mock:true});try{await f.service.save({...f.workspace,scenarios:[{...f.scenario,scripts:[{...f.row,...patch}]}]});await assert.rejects(f.start(),ScriptBlocked);assert.deepEqual(f.stats(),{toolCalls:0,acquisitions:0,mockCount:0,cleanupCount:0});}finally{await f.cleanup();}
 }
});
test('confidential policy still withholds raw output and scripts are removed',async()=>{
 const f=await scriptFixture({mock:true});try{const result=await f.service.wait((await f.service.start({workspaceId:f.workspace.id,deviceId,scenarioId:'one',runtimeInputs:{PASSWORD:'private'}})).id);assert.equal(result.status,'passed');assert.match(result.log,/withheld/);assert.equal(result.artifacts.some(name=>name.endsWith('commands.json')),false);await assertTokenFree(f,result.id);}finally{await f.cleanup();}
});
test('20 fake sessions additionally verify lifecycle and changing tokens (not real stability proof)',async()=>{
 const f=await scriptFixture({mock:true});try{for(let i=0;i<20;i++){const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'passed');assert.equal(result.cleanup.verified,true);await assertTokenFree(f,result.id);}assert.equal(new Set(f.tokens).size,20);assert.equal(f.stats().cleanupCount,20);}finally{await f.cleanup();}
});
test('untrusted batch entry fails and continues; script-error is failed with distinct reason',async()=>{
 const f=await scriptFixture({source:'throw new Error("ไทย failure")'});try{
  const workspace=await f.service.save({...f.workspace,scenarios:[f.scenario,{...f.scenario,id:'two',name:'Two',scripts:[]}]});
  const local=await f.service.waitBatch((await f.service.startBatch({workspaceId:workspace.id,deviceId})).id);assert.equal(local.status,'completed');assert.deepEqual(local.entries.map(entry=>entry.status),['failed','passed']);assert.equal(local.entries[0].reason,'Script failed');
  const pkg=await f.service.exportWorkspace({id:workspace.id,expectedRevision:2,includeValues:true});const imported=await f.service.importWorkspace({package:pkg.package,name:'Imported'});
  const batch=await f.service.waitBatch((await f.service.startBatch({workspaceId:imported.id,deviceId})).id);assert.equal(batch.status,'completed');assert.deepEqual(batch.entries.map(entry=>entry.status),['failed','passed']);assert.equal(batch.entries[0].reason,'Script needs trust');assert.equal(batch.entries[0].runId,undefined);
 }finally{await f.cleanup();}
});
test('array order survives reload; end scripts execute after the last authored command',async()=>{
 const f=await scriptFixture();try{
  const rows=[{...f.row,id:'second',source:'output.sequence = "second"'},{...f.row,id:'first',source:'output.sequence += ",first"'},{...f.row,id:'last',beforeStep:{index:3,fingerprint:'end'},source:'output.sequence += ",last"'}];
  await f.service.save({...f.workspace,scenarios:[{...f.scenario,scripts:rows}]});
  assert.deepEqual((await createScenarios(f.options).workspace(f.workspace.id)).scenarios![0].scripts!.map(row=>row.id),['second','first','last']);
  const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'passed');assert.equal(f.outputs[0].sequence,'second,first,last');assert.equal(result.executionOrder!.at(-1)!.kind,'runScript');assert.deepEqual(Object.keys(result.scriptSteps!),['second','first','last']);
 }finally{await f.cleanup();}
});
test('authored runScript stays rejected in root, nested and reusable flows',async()=>{
 const f=await scriptFixture();try{
  for(const badYaml of ['appId: com.example.HybridApp\n---\n- runScript: private.js\n','appId: com.example.HybridApp\n---\n- runFlow:\n    commands:\n      - runScript: private.js\n']){
   const saved=await f.service.save({...await f.service.workspace(f.workspace.id),yaml:badYaml,scenarios:[]});await assert.rejects(f.service.start({workspaceId:saved.id,deviceId}),/External file references/);await assert.rejects(f.service.preview({yaml:badYaml}),/External file references/);
  }
  await assert.rejects(f.service.save({...await f.service.workspace(f.workspace.id),flows:{'nested.yaml':'appId: com.example.HybridApp\n---\n- runScript: private.js'}}),/External file references/);
  assert.equal(f.calls.length,0);
 }finally{await f.cleanup();}
});

test('generated script removal failure deletes unsafe evidence and retains a safe final record',async()=>{
 const f=await scriptFixture({customRun:async({directory})=>{
  const script=join(directory,'.tnt-script-0001.js');await rm(script);await mkdir(script);await writeFile(join(script,'partial'),'not a script file');
  return {code:0,log:'cleanup must fail closed',cleanup:{verified:true,detail:'Stopped'}};
 }});try{const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'error');assert.equal(result.error,'Evidence scrub failed');assert.deepEqual(await readdir(join(f.root,'runs',result.id)),['result.json']);}finally{await f.cleanup();}
});
test('marker source never executes during compile, preview, review, export, import or batch preflight',async()=>{
 const f=await scriptFixture();try{
  const marker=join(f.root,'must-not-execute');const source='globalThis.process.getBuiltinModule("node:fs").writeFileSync('+JSON.stringify(marker)+', "executed")';
  const workspace=await f.service.save({...f.workspace,scenarios:[{...f.scenario,scripts:[{...f.row,source}]}]});
  const plan=buildRunPlan({yaml:workspace.yaml,scripts:workspace.scenarios![0].scripts,trust:[{rowId:f.row.id,origin:'local',hash:'',trusted:true}]});assert.deepEqual(plan.blocked,[]);
  await f.service.preview({...workspace,scenarioId:'one'});const pkg=await f.service.exportWorkspace({id:workspace.id,expectedRevision:2,includeValues:true});await f.service.reviewWorkspacePackage({package:pkg.package});const imported=await f.service.importWorkspace({package:pkg.package,name:'Marker'});
  const batch=await f.service.waitBatch((await f.service.startBatch({workspaceId:imported.id,deviceId})).id);assert.equal(batch.entries[0].reason,'Script needs trust');assert.equal(f.calls.length,0);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  const current=await f.service.workspace(workspace.id);await f.service.save({...current,scenarios:[{...f.scenario,scripts:[{...f.row,source:'} catch(e){}; '+source+'; try {'}]}]});await assert.rejects(f.service.start({workspaceId:workspace.id,deviceId,scenarioId:'one'}),ScriptBlocked);await assert.rejects(readFile(marker),{code:'ENOENT'});assert.equal(f.stats().acquisitions,0);
 }finally{await f.cleanup();}
});
test('unknown or extra script command metadata never claims a verified script pass',async()=>{
 const f=await scriptFixture();try{
  const plan=buildRunPlan({yaml:f.workspace.yaml,scripts:[f.row],trust:[{rowId:f.row.id,origin:'local',hash:'',trusted:true}]});
  const launch={command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}};
  const unknown={command:{unknownCommand:{}},metadata:{depth:0,status:'COMPLETED'}};
  const mapped=mapScriptResults(plan,[launch,unknown],'',false);assert.equal(mapped.ambiguous,true);assert.equal(mapped.scriptSteps[f.row.id].status,'not-run');
 }finally{await f.cleanup();}
});
