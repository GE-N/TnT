import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
import type {CanvasGraph} from '../server/canvas.js';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';
import {writeChecks} from '../shared/canvas-authoring.js';
const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
const definition:ScenarioDefinition={id:'home',name:'Home scenario',authoring:'canvas',steps:[],pathId:'home-sequence',inputs:{},parameters:{},enabledHandlerIds:[]};
const graph:CanvasGraph={screens:[{id:'home-screen',title:'Descriptive name only',x:80,y:100,tests:[{id:'home-check',label:'Home required',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},check:{visibility:'visible',target:'text',match:'exact',value:'Home'}}]}],edges:[],paths:[{id:'home-sequence',name:'Home',screenId:'home-screen',edgeIds:[],visits:[{id:'start-visit'}]}]};
const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},graph);

test('a single-screen draft with no selected checks cannot reach the simulator',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-draft-'));
 try{
  const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async()=>{assert.fail('Draft must not reach simulator');}}),maestro:{version:async()=>{assert.fail('Draft must not reach Maestro');},run:async()=>{assert.fail('Draft must not execute');}}});
  const canvas=structuredClone(graph);canvas.paths[0].visits![0].checkIds=[];
  const workspace=await service.save({name:'Draft',yaml,canvas,scenarios:[definition]});
  await assert.rejects(service.start({workspaceId:workspace.id,deviceId,scenarioId:'home'}),/at least one.*check/i);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('empty named drafts and their layout reopen offline and cannot execute',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-empty-draft-'));
 try{
  const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async()=>{assert.fail('Offline draft cannot execute');}}),maestro:{version:async()=>{assert.fail('No tool version needed');},run:async()=>{assert.fail('No draft run');}}});
  const canvas:CanvasGraph={screens:[],edges:[],paths:[{id:'home-sequence',name:'Draft sequence',edgeIds:[]}]};
  const saved=await service.save({name:'Offline workspace',yaml:'appId: com.example.App\n---\n[]\n',canvas,scenarios:[definition]});
  const reopened=await service.workspace(saved.id);
  assert.equal(reopened.scenarios?.[0].id,'home');assert.deepEqual(reopened.scenarios?.[0].steps,[]);assert.equal(reopened.scenarios?.[0].setup,undefined);
  await assert.rejects(service.start({workspaceId:saved.id,deviceId,scenarioId:'home'}),/nonempty.*path/i);
  const namedOnly=await service.save({...saved,canvas:{...canvas,screens:[{id:'home-screen',title:'Home',x:340,y:230,tests:[]}],paths:[{id:'home-sequence',name:'Home',screenId:'home-screen',edgeIds:[]}]}});
  assert.equal((await service.workspace(saved.id)).canvas?.screens[0].x,340);
  await assert.rejects(service.start({workspaceId:namedOnly.id,deviceId,scenarioId:'home'}),/at least one.*check/i);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('canvas scenarios use ordinary launch, isolate shared checks, and require assertion evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-single-screen-'));
 try{
  let outcome:'passed'|'failed'|'missing'='passed';
  const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/installed/app',stderr:''})}),maestro:{version:async()=> '2.11.0',run:async({directory,flow})=>{
   const execution=await readFile(flow,'utf8');assert.match(execution,/- launchApp/);assert.match(execution,/\^Home\$/);assert.doesNotMatch(execution,/Other required/);
   await writeFile(join(directory,'report.xml'),`<testsuites><testsuite tests="1" failures="${outcome==='failed'?1:0}"/></testsuites>`);
   await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},...(outcome==='missing'?[]:[{command:{assertConditionCommand:{condition:{visible:{textRegex:'^Home$'}}}},metadata:{depth:0,status:outcome==='failed'?'FAILED':'COMPLETED',error:outcome==='failed'?{message:'Home absent'}:undefined}}])]));
   return {code:outcome==='failed'?1:0,log:'External tool fixture',cleanup:{verified:true,detail:'Fixture process exited'}};
  }}});
  const canvas=structuredClone(graph);
  canvas.screens.push({id:'other',title:'Other screen',x:420,y:100,tests:[{...structuredClone(canvas.screens[0].tests[0]),id:'other-check',check:{visibility:'visible',target:'text',match:'exact',value:'Other required'}}]});
  const authored=writeChecks(yaml,graph,canvas).replace('- launchApp\n','');
  const workspace=await service.save({name:'Shared',yaml:authored,canvas,scenarios:[definition]});
  for(const mode of ['passed','failed','missing'] as const){
   outcome=mode;
   const run=await service.wait((await service.start({workspaceId:workspace.id,deviceId,scenarioId:'home',pathId:'wrong-independent-route'})).id);
   assert.equal(run.status,mode==='passed'?'passed':mode==='failed'?'assertion-failed':'path-failed');
   assert.equal(run.snapshot.scenario?.id,'home');assert.equal(run.canvas?.pathId,'home-sequence');
   assert.equal(run.snapshot.canvas?.paths[0].visits?.[0].id,'start-visit');
   assert.equal(run.canvas?.screens.find(screen=>screen.id==='other')?.status,'unavailable');
   assert.equal(run.canvas?.tests.find(test=>test.id==='home-check')?.status,mode==='passed'?'passed':mode==='failed'?'failed':'unavailable');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('scenario memberships select shared checks and actions without running another scenario commands',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-scenario-membership-'));
 try{
  let executed='';
  const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=> '2.11.0',run:async({directory,flow})=>{
   executed=await readFile(flow,'utf8');
   await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
   await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{visible:{textRegex:'^Shared$'}}}},metadata:{depth:0,status:'COMPLETED'}}]));
   return {code:0,log:'Fixture',cleanup:{verified:true,detail:'Fixture exited'}};
  }}});
  const canvas=structuredClone(graph);
  Object.assign(canvas.screens[0].tests[0],{scenarioIds:['first'],check:{visibility:'visible',target:'text',match:'exact',value:'First only'}});
  canvas.screens[0].tests.push({...structuredClone(graph.screens[0].tests[0]),id:'shared',check:{visibility:'visible',target:'text',match:'exact',value:'Shared'},...{scenarioIds:['first','second']}});
  const authored=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);
  canvas.paths=[{id:'first-path',name:'First',screenId:'home-screen',edgeIds:[]},{id:'second-path',name:'Second',screenId:'home-screen',edgeIds:[]}];
  const definitions=[{...definition,id:'first',pathId:'first-path'},{...definition,id:'second',pathId:'second-path'}];
  const workspace=await service.save({name:'Shared memberships',yaml:authored,canvas,scenarios:definitions});
  const result=await service.wait((await service.start({workspaceId:workspace.id,deviceId,scenarioId:'second'})).id);
  assert.doesNotMatch(executed,/First only/);assert.match(executed,/Shared/);assert.equal(result.status,'passed');
  assert.equal(result.canvas?.tests.find(test=>test.id==='home-check')?.status,'unavailable');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a shared connection executes only actions selected for the running scenario',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-action-membership-'));
 try{
  let executed='';
  const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=> '2.11.0',run:async({directory,flow})=>{
   executed=await readFile(flow,'utf8');await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
   await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{tapOnElement:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{visible:{textRegex:'^Done$'}}}},metadata:{depth:0,status:'COMPLETED'}}]));
   return {code:0,log:'Fixture',cleanup:{verified:true,detail:'Fixture exited'}};
  }}});
  const ref={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
  const canvas:CanvasGraph={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'first-action',label:'First',role:'action',reference:ref,scenarioIds:['first'],input:'${FIRST_INPUT}'},{id:'second-action',label:'Second',role:'action',reference:ref,scenarioIds:['second'],tap:{target:'text',match:'exact',value:'Second action'}}]},{id:'done',title:'Done',x:400,y:0,tests:[{id:'done-check',label:'Done',role:'assertion',reference:ref,scenarioIds:['first','second'],check:{visibility:'visible',target:'text',match:'exact',value:'Done'}}]}],edges:[{id:'go',from:'home',to:'done',actionTestId:'first-action',actionTestIds:['first-action','second-action'],assertionTestId:'done-check',responseCondition:'Go'}],paths:['first','second'].map(id=>({id,name:id,screenId:'home',edgeIds:['go']}))};
  const source=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);
  const definitions=['first','second'].map(id=>({...definition,id,pathId:id}));
  const workspace=await service.save({name:'Shared connection',yaml:source,canvas,scenarios:definitions});
  const result=await service.wait((await service.start({workspaceId:workspace.id,deviceId,scenarioId:'second'})).id);
  assert.equal(result.status,'passed');assert.doesNotMatch(executed,/FIRST_INPUT/);assert.match(executed,/Second action/);
  assert.equal(result.canvas?.tests.find(test=>test.id==='first-action')?.status,'unavailable');
  assert.equal(result.canvas?.tests.find(test=>test.id==='second-action')?.status,'passed');
  await assert.rejects(service.start({workspaceId:workspace.id,deviceId,scenarioId:'first'}),/Missing required input: FIRST_INPUT/);
  const excluded=structuredClone(canvas);excluded.screens[1].tests[0].scenarioIds=['first'];await service.save({...workspace,canvas:excluded});
  await assert.rejects(service.start({workspaceId:workspace.id,deviceId,scenarioId:'second'}),/at least one screen check.*destination/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a selected scenario cannot silently omit an action with no destination',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-incomplete-membership-'));
 try{
  const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async()=>{assert.fail('Incomplete action cannot reach simulator');}}),maestro:{version:async()=>{assert.fail('No version for draft');},run:async()=>{assert.fail('Cannot omit selected action');}}});
  const canvas=structuredClone(graph);canvas.screens[0].tests.push({id:'pending-action',label:'Go',role:'action',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},scenarioIds:['home'],tap:{target:'text',match:'exact',value:'Go'}});
  const source=writeChecks(yaml,graph,canvas);const workspace=await service.save({name:'Incomplete action',yaml:source,canvas,scenarios:[definition]});
  await assert.rejects(service.start({workspaceId:workspace.id,deviceId,scenarioId:'home'}),/destination screen/);
  const legacy=structuredClone(canvas);const orphan=legacy.screens[0].tests.pop()!;delete orphan.scenarioIds;legacy.screens.push({id:'unrelated',title:'Unrelated',x:600,y:0,tests:[orphan]});
  const preview=await service.preview({...workspace,canvas:legacy,scenarioId:'home'});
  assert.doesNotMatch(preview.executionYaml,/tapOn/,'An unassigned legacy action does not block or execute in another scenario');
 }finally{await rm(root,{recursive:true,force:true});}
});
