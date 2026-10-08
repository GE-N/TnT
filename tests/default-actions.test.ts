import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseAllDocuments} from 'yaml';
import {createRunner} from '../server/runner.js';
import {createScenarios,type Maestro} from '../server/scenarios.js';
const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
const yaml='appId: com.example.HybridApp\n---\n# preserve authored comment\n- tapOn: Coordinator\n- assertVisible: Home\n';
const flows={'setup.yaml':'appId: com.example.HybridApp\n---\n- assertVisible: Home\n','back.yaml':'appId: com.example.HybridApp\n---\n- tapOn: "${BACK}"\n'};
async function fixture(maestro:Maestro){
 const root=await mkdtemp(join(tmpdir(),'tnt-default-'));
 const runner=createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/installed/app',stderr:''})});
 return {root,service:createScenarios({root,runner,maestro})};
}
test('a scenario always relaunches and runs declared setup before checkpoint actions without changing authored YAML',async()=>{
 const {root,service}=await fixture({version:async()=> '2.11.0',run:async({directory,flow})=>{
  const derived=await readFile(flow,'utf8');const commands=parseAllDocuments(derived)[1].toJS();
  assert.deepEqual(commands[0],{launchApp:{stopApp:true,clearState:false}});
  assert.equal(commands[1].runFlow.file,'setup.yaml');
  assert.equal(commands[3].runFlow.label,'TnT checkpoint 2');
  assert.match(derived,/BACK: Home/);
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify(commands.map((command:any)=>({command:{[command.launchApp?'launchAppCommand':'runFlowCommand']:{label:command.runFlow?.label}},metadata:{depth:0,status:'COMPLETED'}}))));
  return {code:0,log:'Passed',cleanup:{verified:true,detail:'Exited'}};
 }});
 try{
  const references=(await service.references({yaml})).references;
  const automation={setup:{file:'setup.yaml',parameters:{}},actions:[{id:'back',name:'Return Home',condition:{text:'Details'},file:'back.yaml',parameters:{BACK:'Home'},enabled:true}],checkpoints:[{beforeStep:1,fingerprint:references[1].fingerprint,timeoutMs:1000}]};
  const workspace=await service.save({name:'Independent',yaml,flows,automation});
  const result=await service.wait((await service.start({workspaceId:workspace.id,deviceId})).id);
  assert.equal(result.status,'passed');assert.equal(result.snapshot.yaml,yaml);
  assert.deepEqual(result.steps.map(step=>step.status),['passed','passed']);
  assert.equal(result.automation?.setup.status,'passed');
  assert.ok((await service.artifact(result.id,'.tnt-execution.yaml')).toString().includes('TnT checkpoint 2'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('stale checkpoints and invalid setup are rejected before any simulator operation',async()=>{
 const {root,service}=await fixture({version:async()=>{throw new Error('Must not execute');},run:async()=>{throw new Error('Must not execute');}});
 try{
  const reference=(await service.references({yaml})).references[1];
  const automation={setup:{file:'setup.yaml',parameters:{}},actions:[],checkpoints:[{beforeStep:1,fingerprint:reference.fingerprint,timeoutMs:1000}]};
  await assert.rejects(service.save({name:'Stale',yaml:yaml.replace('Home','Wrong'),flows,automation}),/stale checkpoint/i);
  await assert.rejects(service.save({name:'Missing setup',yaml,flows,automation:{...automation,setup:{file:'missing.yaml',parameters:{}}}}),/declared reusable/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('execution preview exposes checkpoint instrumentation, omits disabled actions, and preserves original YAML',async()=>{
 const {root,service}=await fixture({version:async()=>{throw new Error('Preview must not call tools');},run:async()=>{throw new Error('Preview must not run');}});
 try{
  const reference=(await service.references({yaml})).references[1];
  const automation={setup:{file:'setup.yaml',parameters:{}},actions:[{id:'disabled',name:'Disabled',condition:{text:'Details'},file:'back.yaml',parameters:{BACK:'Home'},enabled:false}],checkpoints:[{beforeStep:1,fingerprint:reference.fingerprint,timeoutMs:1500}]};
  const preview=await service.preview({yaml,flows,automation});
  assert.equal(preview.authoredYaml,yaml);assert.match(preview.executionYaml,/TnT checkpoint 2/);
  assert.doesNotMatch(preview.executionYaml,/TnT handler disabled/);assert.doesNotMatch(preview.executionYaml,/repeat:/);assert.match(preview.executionYaml,/Date.now\(\)\+1500/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('an action failure stops the dependent authored step and is reported as handler failure',async()=>{
 const {root,service}=await fixture({version:async()=> '2.11.0',run:async({directory,flow})=>{
  const commands=parseAllDocuments(await readFile(flow,'utf8'))[1].toJS();
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="1"/></testsuites>');
  const events=commands.slice(0,4).map((command:any,index:number)=>({command:{[command.launchApp?'launchAppCommand':'runFlowCommand']:{label:command.runFlow?.label}},metadata:{depth:0,status:index===3?'FAILED':'COMPLETED'}}));
  events.push({command:{runFlowCommand:{label:'TnT handler back checkpoint 2'}},metadata:{depth:2,status:'FAILED'}});
  await writeFile(join(directory,'commands.json'),JSON.stringify(events));
  return {code:1,log:'Action failed',cleanup:{verified:true,detail:'Exited'}};
 }});
 try{
  const reference=(await service.references({yaml})).references[1];
  const workspace=await service.save({name:'Handler failure',yaml,flows,automation:{setup:{file:'setup.yaml',parameters:{}},actions:[{id:'back',name:'Back',condition:{text:'Details'},file:'back.yaml',parameters:{BACK:'Missing'},enabled:true}],checkpoints:[{beforeStep:1,fingerprint:reference.fingerprint,timeoutMs:1000}]}});
  const result=await service.wait((await service.start({workspaceId:workspace.id,deviceId})).id);
  assert.equal(result.status,'handler-error');assert.equal(result.automation?.actions[0].status,'failed');
  assert.equal(result.steps[1].status,'unavailable');assert.equal(result.cleanup.verified,true);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a declared execution.yaml cannot replace instrumentation in normal or confidential runs',async()=>{
 const replacement='appId: com.example.HybridApp\n---\n- assertVisible: Wrong\n';
 const {root,service}=await fixture({version:async()=> '2.11.0',run:async({directory,flow})=>{
  assert.equal(flow,join(directory,'.tnt-execution.yaml'));
  assert.equal(await readFile(join(directory,'execution.yaml'),'utf8'),replacement);
  const commands=parseAllDocuments(await readFile(flow,'utf8'))[1].toJS();
  assert.equal(commands[0].launchApp.stopApp,true);assert.equal(commands[1].runFlow.file,'setup.yaml');
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify(commands.map((command:any)=>({command:{[command.launchApp?'launchAppCommand':'runFlowCommand']:{label:command.runFlow?.label}},metadata:{depth:0,status:'COMPLETED'}}))));
  return {code:0,log:'secret-runtime-value',cleanup:{verified:true,detail:'Exited'}};
 }});
 try{
  const workspace=await service.save({name:'Generated filename isolation',yaml,flows:{...flows,'execution.yaml':replacement},automation:{setup:{file:'setup.yaml',parameters:{}},actions:[],checkpoints:[]}});
  for(const runtimeInputs of [undefined,{TOKEN:'secret-runtime-value'}]){
   const result=await service.wait((await service.start({workspaceId:workspace.id,deviceId,runtimeInputs})).id);
   assert.equal(result.status,'passed');assert.equal(result.automation?.setup.status,'passed');
   if(runtimeInputs){assert.doesNotMatch(JSON.stringify(await service.result(result.id)),/secret-runtime-value/);assert.deepEqual(result.artifacts,['flow.yaml','snapshot.json']);}
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a failed declared setup is distinct from a scenario assertion failure and never starts authored steps',async()=>{
 const {root,service}=await fixture({version:async()=> '2.11.0',run:async({directory})=>{
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="1"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify([
   {command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},
   {command:{runFlowCommand:{label:'TnT setup'}},metadata:{depth:0,status:'FAILED'}},
   {command:{assertConditionCommand:{condition:{visible:{textRegex:'Home'}}}},metadata:{depth:1,status:'FAILED',error:{message:'Setup screen absent'}}},
  ]));return {code:1,log:'Setup screen absent',cleanup:{verified:true,detail:'Exited'}};
 }});
 try{
  const workspace=await service.save({name:'Setup failure',yaml,flows,automation:{setup:{file:'setup.yaml',parameters:{}},actions:[],checkpoints:[]}});
  const result=await service.wait((await service.start({workspaceId:workspace.id,deviceId})).id);
  assert.equal(result.status,'setup-error');assert.equal(result.automation?.setup.status,'failed');
  assert.deepEqual(result.steps.map(step=>step.status),['unavailable','unavailable']);
 }finally{await rm(root,{recursive:true,force:true});}
});
