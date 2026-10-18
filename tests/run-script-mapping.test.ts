import {scriptHash} from '../server/script-trust-store.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseAllDocuments} from 'yaml';
import {scriptFixture,deviceId,yaml} from './run-script-helpers.js';
import {referenceCatalog} from '../server/canvas.js';
import {selectScenario} from '../server/scenario-definitions.js';
import {buildRunPlan} from '../server/run-script-plan.js';
import {projectCanvasRoute} from '../server/canvas-route.js';
import type {GoldenFixture} from './golden-canvas-runner.js';

test('subset anchors refer to projected selected steps and stale indexes do not move to similar steps',async()=>{
 const f=await scriptFixture();try{
  const scenario={...f.scenario,steps:f.scenario.steps.slice(1)};
  const projection=selectScenario({...f.workspace,scenarios:[scenario]},'one',{})!;
  const ref=referenceCatalog(projection.yaml).references[1];const row={...f.row,beforeStep:{index:1,fingerprint:ref.fingerprint}};
  await f.service.save({...f.workspace,scenarios:[{...scenario,scripts:[row]}]});const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'passed');assert.deepEqual(result.steps.map(step=>step.command),['tapOn','assertVisible']);assert.deepEqual(result.executionOrder,[{kind:'step',index:0},{kind:'runScript',rowId:row.id},{kind:'step',index:1}]);
  const plan=buildRunPlan({yaml:projection.yaml,scripts:[f.row],trust:[{rowId:f.row.id,origin:'local',trusted:true,hash:scriptHash(f.row.source)}]});assert.equal(plan.blocked[0].kind,'stale-anchor');
 }finally{await f.cleanup();}
});
test('checkpoint injection and authored-only mapping remain aligned with multiple same-anchor scripts',async()=>{
 let seen:string[]=[];
 const f=await scriptFixture({customRun:async({directory,flow})=>{
  const commands=parseAllDocuments(await readFile(flow,'utf8'))[1].toJS();seen=commands.map((cmd:any)=>cmd.runScript?'script':cmd.runFlow?.label??'launch');
  const metadata=commands.map((cmd:any)=>({command:{[cmd.runScript?'runScriptCommand':cmd.launchApp?'launchAppCommand':'runFlowCommand']:{label:cmd.runFlow?.label}},metadata:{depth:0,status:'COMPLETED'}}));
  await writeFile(join(directory,'commands.json'),JSON.stringify(metadata));await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');return {code:0,log:'fixture',cleanup:{verified:true,detail:'Stopped'}};
 }});try{
  const flows={'setup.yaml':'appId: com.example.HybridApp\n---\n- assertVisible: Home\n'};
  const automation={setup:{file:'setup.yaml',parameters:{}},actions:[],checkpoints:[{beforeStep:1,fingerprint:f.row.beforeStep.fingerprint,timeoutMs:1000}]};
  const workspace=await f.service.save({...f.workspace,flows,automation,scenarios:[{...f.scenario,scripts:[f.row,{...f.row,id:'next'}]}]});
  const result=await f.service.wait((await f.service.start({workspaceId:workspace.id,deviceId,scenarioId:'one'})).id);
  assert.equal(result.status,'passed');assert.deepEqual(seen,['launch','TnT setup','TnT step 1','TnT checkpoint 2','script','script','TnT step 2','TnT step 3']);assert.deepEqual(result.steps.map(step=>step.status),['passed','passed','passed']);assert.equal(result.automation?.setup.status,'passed');
  assert.deepEqual(result.executionOrder?.filter(item=>item.kind==='step'),[{kind:'step',index:0},{kind:'step',index:1},{kind:'step',index:2}]);assert.equal(result.executionOrder?.filter(item=>item.kind==='system').length,3);
 }finally{await f.cleanup();}
});
test('repeated visits use the existing checkpoint fingerprints and indexes distinguish identical commands',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixtures/golden/repeated-visit.json',import.meta.url),'utf8')) as GoldenFixture;
 const projection=projectCanvasRoute(fixture.canvas,fixture.yaml,fixture.flows??{},fixture.pathId,fixture.automation);
 const refs=referenceCatalog(projection.yaml,fixture.flows).references.filter(ref=>ref.kind==='step');
 const pair=refs.flatMap((ref,index)=>refs.slice(index+1).filter(other=>other.fingerprint===ref.fingerprint).map(other=>[ref,other])).at(0)!;assert.ok(pair);
 const rows=pair.map((ref,index)=>({id:'visit-'+index,label:'Visit',source:'output.X=1',beforeStep:{index:ref.index!,fingerprint:ref.fingerprint}}));
 const plan=buildRunPlan({yaml:projection.yaml,flows:fixture.flows,scripts:rows,trust:rows.map(row=>({rowId:row.id,origin:'local',trusted:true,hash:scriptHash(row.source)}))});
 assert.deepEqual(plan.blocked,[]);assert.deepEqual(plan.executionItems.filter(item=>item.kind==='runScript').map(item=>item.beforeStep),pair.map(ref=>ref.index));
 assert.notEqual(rows[0].beforeStep.index,rows[1].beforeStep.index);assert.equal(rows[0].beforeStep.fingerprint,rows[1].beforeStep.fingerprint);
});
