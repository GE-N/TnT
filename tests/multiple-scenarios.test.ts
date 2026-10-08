import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseAllDocuments} from 'yaml';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
const yaml='appId: com.example.App\n---\n- tapOn: Load\n- runFlow: page.yaml\n';
const flows={'setup.yaml':'appId: com.example.App\n---\n- assertVisible: ${START_PAGE}\n','page.yaml':'appId: com.example.App\n---\n- assertVisible: ${EXPECTED_PAGE}\n'};
test('named scenarios share executable flows but run fresh inputs and declared setup in either order, with reset defaulting to no',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-multiple-'));
 try{
 const runner=createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})});
 const service=createScenarios({root,runner,maestro:{version:async()=> '2.11.0',run:async({directory,flow,runtimeInputs})=>{
  const commands=parseAllDocuments(await readFile(flow,'utf8'))[1].toJS();
  assert.equal(commands[1].runFlow.file,'setup.yaml');
  assert.deepEqual(runtimeInputs?.START_PAGE,'Home');
  assert.ok(['Maintenance','Success'].includes(runtimeInputs?.EXPECTED_PAGE??''));
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{runFlowCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{runFlowCommand:{commands:[{tapOnElement:{}}]}},metadata:{depth:0,status:'COMPLETED'}},{command:{tapOnElement:{}},metadata:{depth:1,status:'COMPLETED'}},{command:{runFlowCommand:{commands:[{runFlowCommand:{commands:[{assertConditionCommand:{condition:{visible:{textRegex:runtimeInputs?.EXPECTED_PAGE}}}}]}}]}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{visible:{textRegex:runtimeInputs?.EXPECTED_PAGE}}}},metadata:{depth:2,status:'COMPLETED'}}]));
  return {code:0,log:'Boundary fixture',cleanup:{verified:true,detail:'Fixture cleanup'}};
 }}});
 const references=(await service.references({yaml,flows})).references.filter(ref=>ref.kind==='step');
 const definitions=['Maintenance','Success'].map(name=>({id:name.toLowerCase(),name,steps:references,inputs:{START_PAGE:'Home',EXPECTED_PAGE:name},parameters:{START_PAGE:{type:'text',required:true},EXPECTED_PAGE:{type:'text',required:true}},setup:{file:'setup.yaml',parameters:{}},enabledHandlerIds:[]}));
 const workspace=await service.save({name:'Shared screen',yaml,flows,scenarios:definitions});
 assert.equal((await service.workspace(workspace.id)).scenarios?.length,2);
 await assert.rejects(service.start({workspaceId:workspace.id,deviceId}),/select.*scenario/i);
 for(const id of ['maintenance','success','success','maintenance']){
  const result=await service.wait((await service.start({workspaceId:workspace.id,deviceId,scenarioId:id})).id);
  assert.equal(result.status,'passed');assert.equal(result.snapshot.scenario?.id,id);
  assert.equal(result.snapshot.resetApp,false);
  assert.equal(parseAllDocuments(result.snapshot.executionYaml!)[1].toJS()[0].launchApp.clearState,false);
  assert.equal(result.snapshot.scenario?.inputs.EXPECTED_PAGE,id==='maintenance'?'Maintenance':'Success');
  assert.ok(result.artifacts.includes('commands.json'),'public test values retain mapped evidence');
 }
 const submitted=await service.start({workspaceId:workspace.id,deviceId,scenarioId:'success',runtimeInputs:{TOKEN:'never-save-this-token'}});
 await service.save({...workspace,scenarios:definitions.map(item=>({...item,name:'Later edit'}))});
 const confidential=await service.wait(submitted.id);
 assert.equal(confidential.snapshot.scenario?.name,'Success');assert.doesNotMatch(JSON.stringify(confidential),/never-save-this-token/);assert.ok(!confidential.artifacts.includes('commands.json'));await service.save(workspace);
 const reset=await service.wait((await service.start({workspaceId:workspace.id,deviceId,scenarioId:'success',resetApp:true})).id);
 assert.equal(reset.snapshot.resetApp,true);assert.equal(parseAllDocuments(reset.snapshot.executionYaml!)[1].toJS()[0].launchApp.clearState,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('required reusable-flow inputs and stale selected steps are rejected before simulator execution and can be explicitly repaired',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-inputs-'));
 try{
 const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async()=>{throw new Error('Must not reach simulator');}}),maestro:{version:async()=> '2.11.0',run:async()=>{throw new Error('Must not run');}}});
 const inputYaml=yaml.replace('---','env:\n  DEVICE_ID: ${MAESTRO_DEVICE_UDID}\n---');
 const steps=(await service.references({yaml:inputYaml,flows})).references.filter(ref=>ref.kind==='step');
 const scenario={id:'maintenance',name:'Maintenance',steps,inputs:{START_PAGE:'Home'},parameters:{},setup:{file:'setup.yaml',parameters:{}},enabledHandlerIds:[]};
 const workspace=await service.save({name:'Inputs',yaml:yaml.replace('---','env:\n  DEVICE_ID: ${MAESTRO_DEVICE_UDID}\n---'),flows,scenarios:[scenario]});
 await service.save({...workspace,scenarios:[{...scenario,inputs:{EXPECTED_PAGE:'Maintenance'},setup:{file:'setup.yaml',parameters:{START_PAGE:'${MISSING}'}}}]});
 await assert.rejects(service.start({workspaceId:workspace.id,deviceId,scenarioId:scenario.id}),/Missing.*MISSING/);
 await service.save({...workspace,flows:{...flows,'setup.yaml':flows['setup.yaml'].replace('---','env:\n  DEVICE_ID: ${MAESTRO_DEVICE_UDID}\n---')}});
 await assert.rejects(service.start({workspaceId:workspace.id,deviceId,scenarioId:scenario.id}),/Missing.*EXPECTED_PAGE/);
 await service.save({...workspace,scenarios:[{...scenario,parameters:{EXPECTED_PAGE:{type:'number',required:true}},inputs:{START_PAGE:'Home',EXPECTED_PAGE:'not-number'}}]});
 await assert.rejects(service.start({workspaceId:workspace.id,deviceId,scenarioId:scenario.id}),/Invalid number.*EXPECTED_PAGE/);
 await service.save({...workspace,yaml:yaml.replace('tapOn: Load','tapOn: Other'),scenarios:[{...scenario,inputs:{START_PAGE:'Home',EXPECTED_PAGE:'Maintenance'}}]});
 await assert.rejects(service.start({workspaceId:workspace.id,deviceId,scenarioId:scenario.id}),/stale scenario step/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('scenario-selected step subsets map shared screens and assertions while excluded steps cannot run',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-subset-'));
 try{
 const runner=createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})});
 const service=createScenarios({root,runner,maestro:{version:async()=> '2.11.0',run:async({directory,flow,runtimeInputs})=>{
  const source=await readFile(flow,'utf8');assert.doesNotMatch(source,/UNSELECTED/);
  const assertion={assertConditionCommand:{condition:{visible:{textRegex:runtimeInputs?.EXPECTED_PAGE}}}};
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{runFlowCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{runFlowCommand:{commands:[{tapOnElement:{}}]}},metadata:{depth:0,status:'COMPLETED'}},{command:{runFlowCommand:{commands:[assertion]}},metadata:{depth:0,status:'COMPLETED'}},{command:assertion,metadata:{depth:1,status:'COMPLETED'}}]));
  return {code:0,log:'Fixture',cleanup:{verified:true,detail:'Fixture stopped'}};
 }}});
 const pool=yaml.replace('- tapOn: Load','- tapOn: UNSELECTED\n- tapOn: Load');const catalog=(await service.references({yaml:pool,flows})).references;
 const action=catalog.find(ref=>ref.kind==='step'&&ref.index===1)!;const assertion=catalog.find(ref=>ref.kind==='flow'&&ref.file==='page.yaml')!;
 const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'load',label:'Load',role:'action',reference:action}]},{id:'destination',title:'Expected page',x:400,y:0,tests:[{id:'visible',label:'Shared assertion',role:'assertion',reference:assertion}]}],edges:[{id:'edge',from:'home',to:'destination',actionTestId:'load',assertionTestId:'visible',responseCondition:'Selected response'}],paths:[{id:'path',name:'Expected page',edgeIds:['edge']}]};
 const definition={id:'success',name:'Success',pathId:'path',steps:catalog.filter(ref=>ref.kind==='step'&&ref.index!==0),inputs:{START_PAGE:'Home',EXPECTED_PAGE:'Success'},parameters:{},setup:{file:'setup.yaml',parameters:{}},enabledHandlerIds:[]};
 const workspace=await service.save({name:'Shared',yaml:pool,flows,canvas,scenarios:[definition]});
 const result=await service.wait((await service.start({workspaceId:workspace.id,deviceId,scenarioId:'success'})).id);
 assert.equal(result.status,'passed');assert.equal(result.canvas?.edges[0].status,'passed');assert.equal(result.snapshot.canvas?.screens[0].tests[0].reference.index,0);
 assert.equal((await service.workspace(workspace.id)).canvas?.screens[0].tests[0].reference.index,1);assert.equal(result.snapshot.authoredYaml,pool);
 }finally{await rm(root,{recursive:true,force:true});}
});
