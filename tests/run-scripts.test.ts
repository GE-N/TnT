import {scriptHash} from '../server/script-trust-store.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,mkdir,rm,rename,symlink} from 'node:fs/promises';
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
  const plan=buildRunPlan({yaml:f.workspace.yaml,scripts:[f.row],trust:[{rowId:f.row.id,origin:'local',hash:scriptHash(f.row.source),trusted:true}]});
  const first={command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}};
  for(const [message,log,expected] of [['TNT_SCRIPT_FAILED row=script-one ไทย structured','TNT_SCRIPT_FAILED row=script-one log','ไทย structured'],['Error: TNT_SCRIPT_FAILED row=script-one ไทย\nSecond line','','ไทย\nSecond line'],['Unknown error','TNT_SCRIPT_FAILED row=script-one ไทย log','ไทย log']]){
   const commands=[first,{command:{runScriptCommand:{}},metadata:{depth:0,status:'FAILED',error:{message}}}];
   const mapped=mapScriptResults(plan,commands,log,false);assert.equal(mapped.failure,expected);assert.deepEqual(mapped.notRunIndexes,[1,2]);
  }
  const unmarked=mapScriptResults(plan,[first,{command:{runScriptCommand:{}},metadata:{depth:0,status:'FAILED',error:{message:'SyntaxError: Graal rejects this'}}}],'',false);
  assert.equal(unmarked.failure,undefined);assert.equal(unmarked.toolFailure,'SyntaxError: Graal rejects this');assert.equal(unmarked.scriptSteps[f.row.id].status,'not-run');
 }finally{await f.cleanup();}
});
test('multi-line thrown errors stay whole, and a completed script logging a marker still passes',async()=>{
 const f=await scriptFixture({source:'throw new Error("First line\\nSecond line\\nไทย")'});try{
  const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'script-error');assert.equal(result.error,'First line\nSecond line\nไทย');assert.equal(result.scriptSteps![f.row.id].message,result.error);
  const plan=buildRunPlan({yaml:f.workspace.yaml,scripts:[f.row],trust:[{rowId:f.row.id,origin:'local',trusted:true,hash:scriptHash(f.row.source)}]});
  const first={command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}};
  for(const [status,message] of [['COMPLETED','TNT_SCRIPT_FAILED row=script-one merely logged'],['FAILED','prefix TNT_SCRIPT_FAILED row=script-one not at start']]){
   const mapped=mapScriptResults(plan,[first,{command:{runScriptCommand:{}},metadata:{depth:0,status,error:{message}}}],status==='COMPLETED'?message:'',false);
   assert.equal(mapped.failure,undefined);assert.equal(mapped.scriptSteps[f.row.id].status,status==='COMPLETED'?'passed':'not-run');
  }
 }finally{await f.cleanup();}
});
test('artifact allow-list excludes adbkey, HOME, telemetry and downloads even when tools write them into a run',async()=>{
 const f=await scriptFixture({customRun:async({directory})=>{
  for(const folder of ['.maestro-home/.android','raw/deps','raw/time/.tnt-execution'])await mkdir(join(directory,folder),{recursive:true});
  for(const file of ['adbkey','.maestro-home/.android/adbkey','raw/adbkey','raw/deps/download.jar','raw/telemetry.zip'])await writeFile(join(directory,file),'private non-evidence');
  await writeFile(join(directory,'raw','step-001-screenshot.png'),'image');
  const commands=['launchAppCommand','runScriptCommand','tapOnElement','assertConditionCommand'].map(key=>({command:{[key]:{}},metadata:{depth:0,status:'COMPLETED'}}));
  await writeFile(join(directory,'raw','time','.tnt-execution','commands.json'),JSON.stringify(commands));await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
  return {code:0,log:'safe',cleanup:{verified:true,detail:'Stopped'}};
 }});try{
  const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'passed');
  assert.ok(result.artifacts.includes('raw/step-001-screenshot.png'));assert.ok(result.artifacts.includes('raw/time/.tnt-execution/commands.json'));
  assert.ok(result.artifacts.every(file=>!/adbkey|maestro-home|telemetry|deps/.test(file)));
  await assert.rejects(f.service.artifact(result.id,'raw/adbkey'),/Unknown run artifact/);
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
  const rows=[{...f.row,id:'last',beforeStep:{index:3,fingerprint:f.scenario.steps[2].fingerprint+':end'},source:'output.sequence += ",last"'},{...f.row,id:'second',source:'output.sequence = "second"'},{...f.row,id:'first',source:'output.sequence += ",first"'}];
  await f.service.save({...f.workspace,scenarios:[{...f.scenario,scripts:rows}]});
  assert.deepEqual((await createScenarios(f.options).workspace(f.workspace.id)).scenarios![0].scripts!.map(row=>row.id),['last','second','first']);
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
  const plan=buildRunPlan({yaml:workspace.yaml,scripts:workspace.scenarios![0].scripts,trust:[{rowId:f.row.id,origin:'local',hash:scriptHash(source),trusted:true}]});assert.deepEqual(plan.blocked,[]);
  await f.service.preview({...workspace,scenarioId:'one'});const pkg=await f.service.exportWorkspace({id:workspace.id,expectedRevision:2,includeValues:true});await f.service.reviewWorkspacePackage({package:pkg.package});const imported=await f.service.importWorkspace({package:pkg.package,name:'Marker'});
  const batch=await f.service.waitBatch((await f.service.startBatch({workspaceId:imported.id,deviceId})).id);assert.equal(batch.entries[0].reason,'Script needs trust');assert.equal(f.calls.length,0);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  const current=await f.service.workspace(workspace.id);await f.service.save({...current,scenarios:[{...f.scenario,scripts:[{...f.row,source:'} catch(e){}; '+source+'; try {'}]}]});await assert.rejects(f.service.start({workspaceId:workspace.id,deviceId,scenarioId:'one'}),ScriptBlocked);await assert.rejects(readFile(marker),{code:'ENOENT'});assert.equal(f.stats().acquisitions,0);
 }finally{await f.cleanup();}
});
test('unknown or extra script command metadata never claims a verified script pass',async()=>{
 const f=await scriptFixture();try{
  const plan=buildRunPlan({yaml:f.workspace.yaml,scripts:[f.row],trust:[{rowId:f.row.id,origin:'local',hash:scriptHash(f.row.source),trusted:true}]});
  const launch={command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}};
  const unknown={command:{unknownCommand:{}},metadata:{depth:0,status:'COMPLETED'}};
  const mapped=mapScriptResults(plan,[launch,unknown],'',false);assert.equal(mapped.ambiguous,true);assert.equal(mapped.scriptSteps[f.row.id].status,'not-run');
 }finally{await f.cleanup();}
});

test('replaced run root cannot redirect cleanup or final record writes and retains ownership',async()=>{
 let unrelated:string;
 const f=await scriptFixture({customRun:async({directory})=>{
  unrelated=join(directory,'..','unrelated');await mkdir(unrelated);await writeFile(join(unrelated,'keep'),'untouched');
  await rename(directory,directory+'-moved');await symlink(unrelated,directory);
  return {code:0,log:'fixture',cleanup:{verified:true,detail:'Stopped'}};
 }});try{
  const run=await f.start();await assert.rejects(f.service.wait(run.id),/Evidence root changed/);assert.equal(await readFile(join(unrelated!,'keep'),'utf8'),'untouched');await assert.rejects(readFile(join(unrelated!,'result.json')),{code:'ENOENT'});await assert.rejects(f.runner.acquireDevice(deviceId),/in progress/);
 }finally{await f.cleanup();}
});

test('changed end anchors block before acquisition when the selected scenario grows or its last step changes',async()=>{
 for(const edit of ['append','change-last','legacy-end'] as const){
  const f=await scriptFixture({mock:true});try{
   const end={...f.row,beforeStep:{index:3,fingerprint:edit==='legacy-end'?'end':f.scenario.steps[2].fingerprint+':end'}};
   const yaml=edit==='append'?f.workspace.yaml+'- tapOn: Another\n':edit==='change-last'?f.workspace.yaml.replace('Home','Changed'):f.workspace.yaml;
   const steps=(await f.service.references({yaml})).references.filter(ref=>ref.kind==='step');
   await f.service.save({...f.workspace,yaml,scenarios:[{...f.scenario,steps,scripts:[end]}]});
   await assert.rejects(f.start(),(error:unknown)=>error instanceof ScriptBlocked&&error.blocked.some(item=>item.kind==='stale-anchor'&&item.rowId===end.id&&item.message==='Step changed · relink before running'));
   assert.deepEqual(f.stats(),{toolCalls:0,acquisitions:0,mockCount:0,cleanupCount:0});
  }finally{await f.cleanup();}
 }
});
test('empty scenario runs end rows in saved array order and remains portable without executing on preview/export/import',async()=>{
 const f=await scriptFixture();try{
  const yaml='appId: com.example.HybridApp\n---\n[]\n';
  const scripts=[{...f.row,id:'end-second',beforeStep:{index:0,fingerprint:'end'},source:'output.order = "second"'},{...f.row,id:'end-first',beforeStep:{index:0,fingerprint:'end'},source:'output.order += ",first"'}];
  const workspace=await f.service.save({...f.workspace,yaml,scenarios:[{...f.scenario,steps:[],scripts}]});
  await f.service.preview({...workspace,scenarioId:'one'});assert.equal(f.calls.length,0);
  const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'passed');assert.deepEqual(result.steps,[]);assert.equal(f.outputs[0].order,'second,first');assert.deepEqual(Object.keys(result.scriptSteps!),['end-second','end-first']);assert.deepEqual(result.executionOrder,[{kind:'runScript',rowId:'end-second'},{kind:'runScript',rowId:'end-first'}]);assert.equal(f.calls[0].scriptEnv,undefined);
  const pkg=await f.service.exportWorkspace({id:workspace.id,expectedRevision:2,includeValues:true});const imported=await f.service.importWorkspace({package:pkg.package,name:'Empty copy'});assert.deepEqual(imported.scenarios![0].scripts,scripts);assert.equal(f.calls.length,1);
  await assert.rejects(f.service.start({workspaceId:imported.id,deviceId,scenarioId:'one'}),/Script needs trust/);assert.equal(f.calls.length,1);
 }finally{await f.cleanup();}
});
for(const scope of ['chosen-response','trusted-script','neither'] as const)test('Mockoon startup scope: '+scope,async()=>{
 const f=await scriptFixture({mock:true});try{
  await f.service.save({...f.workspace,scenarios:[{...f.scenario,scripts:scope==='trusted-script'?[f.row]:[],mockResponseId:scope==='chosen-response'?f.workspace.mock!.responseId:undefined}]});
  const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'passed');
  assert.equal(f.stats().mockCount,scope==='neither'?0:1);assert.equal(f.stats().cleanupCount,scope==='neither'?0:1);
  if(scope==='neither'){assert.equal(Object.hasOwn(result,'mock'),false);assert.equal(result.snapshot.mock,undefined);assert.equal(result.snapshot.toolVersions.mockoon,undefined);}
  else {assert.equal(result.mock?.intent.status,'acknowledged');assert.deepEqual(f.mockOptions,[{overrideResponse:scope==='chosen-response'}]);assert.equal(result.mock?.intent.responseId,scope==='chosen-response'?f.workspace.mock!.responseId:f.workspace.mock!.environment.routes[0].responses.find(response=>response.default)!.uuid);}
  if(scope==='trusted-script')assert.equal(f.calls[0].scriptEnv?.TNT_MOCK_TOKEN,f.tokens[0]);else assert.equal(f.calls[0].scriptEnv,undefined);
 }finally{await f.cleanup();}
});
test('an untrusted script alone never starts Mockoon; its own approval enables mock access',async()=>{
 const f=await scriptFixture({mock:true});try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});const imported=await f.service.importWorkspace({package:pkg.package,name:'Imported'});
  await assert.rejects(f.service.start({workspaceId:imported.id,deviceId,scenarioId:'one'}),/Script needs trust/);assert.equal(f.stats().mockCount,0);assert.equal(f.stats().acquisitions,0);assert.equal(f.calls.length,0);
  const [trust]=(await f.service.scriptTrust(imported.id)).scripts;await f.service.trustScript({workspace:imported.id,rowId:trust.rowId,hash:trust.hash});
  const result=await f.service.wait((await f.service.start({workspaceId:imported.id,deviceId,scenarioId:'one'})).id);assert.equal(result.status,'passed');assert.equal(f.stats().mockCount,1);assert.equal(f.calls[0].scriptEnv?.TNT_MOCK_TOKEN,f.tokens[0]);
 }finally{await f.cleanup();}
});
test('ordinary scenarios do not depend on another scenario\'s script trust state or mock scope',async()=>{
 const f=await scriptFixture({mock:true});try{
  await f.service.save({...f.workspace,scenarios:[f.scenario,{...f.scenario,id:'plain',scripts:[]}]});
  await writeFile(join(f.options.trustDirectory,'state.json'),'{unreadable');
  const result=await f.service.wait((await f.service.start({workspaceId:f.workspace.id,deviceId,scenarioId:'plain'})).id);assert.equal(result.status,'passed');assert.equal(result.mock,undefined);assert.equal(f.stats().mockCount,0);assert.equal(f.calls[0].scriptEnv,undefined);
  await assert.rejects(f.start(),/trust state is unreadable/);assert.equal(f.stats().acquisitions,1);
 }finally{await f.cleanup();}
});
