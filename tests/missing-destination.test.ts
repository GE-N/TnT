import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectCanvas,type CanvasGraph,type CanvasTest} from '../server/canvas.js';
import {projectCanvasRoute} from '../server/canvas-route.js';
import {createRunner} from '../server/runner.js';
import {createScenarios} from '../server/scenarios.js';
import {refreshChecks,writeChecks} from '../shared/canvas-authoring.js';

const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
function tap(id:string,label:string,value:string):CanvasTest{return {id,label,role:'action',reference,tap:{target:'text',match:'exact',value}};}
function legacy(visits?:CanvasGraph['paths'][number]['visits']){
 const canvas:CanvasGraph={
  screens:[{id:'home',title:'Home',x:0,y:0,tests:[tap('gear','tap Gear','Gear'),{id:'home-ready',label:'Home',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Home'}}]},{id:'settings',title:'Settings',x:400,y:0,tests:[]}],
  edges:[],
  paths:[{id:'route',name:'Home checks',screenId:'home',edgeIds:[],...(visits?{visits}:{})}],
 };
 const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);
 return {yaml,canvas:refreshChecks(canvas,yaml)};
}

test('a legacy start-only route step with no destination returns missing-destination',()=>{
 const {yaml,canvas}=legacy();
 const missing=inspectCanvas(canvas,yaml).diagnostics.filter(item=>item.code==='missing-destination');
 assert.equal(missing.length,1);
 assert.equal(missing[0].code,'missing-destination');
 assert.equal(missing[0].actionId,'gear');
 assert.deepEqual(missing,[{code:'missing-destination',actionId:'gear'}]);
 assert.throws(()=>projectCanvasRoute(canvas,yaml,{},'route'),/missing-destination:gear/);
});

test('a step that stays on the screen, a connected step and a scenario route have no missing-destination',()=>{
 const stays=legacy([{id:'visit-1',operationIds:['gear','home-ready']}]);
 assert.equal(inspectCanvas(stays.canvas,stays.yaml).diagnostics.length,0);
 assert.match(projectCanvasRoute(stays.canvas,stays.yaml,{},'route').yaml,/tapOn:\n {4}text: \^Gear\$/);
 const {yaml,canvas}=legacy();
 const connected={...canvas,edges:[{id:'go',from:'home',to:'settings',actionTestId:'gear',assertionTestId:'pending:go',responseCondition:'Home → Settings'}],paths:[{...canvas.paths[0],edgeIds:['go'],visits:undefined}]};
 assert.equal(inspectCanvas(connected,yaml).diagnostics.some(item=>item.code==='missing-destination'),false);
 const scenario={...canvas,paths:[{...canvas.paths[0],scenarioId:'scenario'}]};
 assert.equal(inspectCanvas(scenario,yaml).diagnostics.some(item=>item.code==='missing-destination'),false);
});

test('running a legacy start-only route with a missing destination is rejected before Maestro instead of reporting path-failed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-missing-destination-'));
 try{
  let runs=0;
  const scenarios=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/installed/app',stderr:''})}),maestro:{version:async()=>'2.11.0',run:async({directory})=>{
   runs++;
   await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
   await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{tapOnElement:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{}},metadata:{depth:0,status:'COMPLETED'}}]));
   return {code:0,log:'Fixture run',cleanup:{verified:true,detail:'Exited'}};
  }}});
  const {yaml,canvas}=legacy();
  const saved=await scenarios.save({name:'Legacy start',yaml,canvas});
  const loaded=await scenarios.workspace(saved.id);
  assert.deepEqual(loaded.canvasDiagnostics?.filter(item=>item.code).map(item=>({code:item.code,actionId:item.actionId})),[{code:'missing-destination',actionId:'gear'}]);
  await assert.rejects(scenarios.start({workspaceId:loaded.id,deviceId,pathId:'route'}),/missing-destination:gear/);
  assert.equal(runs,0);
  const stays=await scenarios.save({...loaded,canvas:legacy([{id:'visit-1',operationIds:['gear','home-ready']}]).canvas});
  const result=await scenarios.wait((await scenarios.start({workspaceId:stays.id,deviceId,pathId:'route'})).id);
  assert.equal(runs,1);
  assert.equal(result.status,'passed');
 }finally{await rm(root,{recursive:true,force:true});}
});
