import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseAllDocuments} from 'yaml';
import {referenceCatalog,type CanvasGraph} from '../server/canvas.js';
import {ScriptBlocked} from '../server/script-validation.js';
import {authoredChecks,writeChecks} from '../shared/canvas-authoring.js';
import {anchorForNewScript,anchorMatches,orderedScenarioSteps} from './fixtures/pr84-script-anchors.js';
import {scriptFixture} from './run-script-helpers.js';
import {projectCanvasRoute} from '../server/canvas-route.js';
import {canvasScriptAnchors} from '../server/run-script-plan.js';
import type {GoldenFixture} from './golden-canvas-runner.js';

test('PR #84 anchor indexes exclude setup and handler rows just like the server',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixtures/golden/default-actions.json',import.meta.url),'utf8')) as GoldenFixture;
 const references=referenceCatalog(fixture.yaml,fixture.flows,fixture.automation).references;
 // Capture current references for this test; the golden source includes draft/stale links.
 for(const test of fixture.canvas.screens.flatMap(screen=>screen.tests))test.reference=references.find(reference=>reference.kind===test.reference.kind&&reference.file===test.reference.file&&reference.index===test.reference.index&&reference.actionId===test.reference.actionId)!;
 const projected=projectCanvasRoute(fixture.canvas,fixture.yaml,fixture.flows??{},fixture.pathId,fixture.automation);
 const steps=orderedScenarioSteps(projected.canvas,fixture.pathId);
 assert.deepEqual(steps.map(step=>step.id),['middle-ready','tap-done','done-ready']);
 assert.deepEqual(steps.map(step=>step.globalIndex),[0,1,2]);
 assert.deepEqual(steps.map(step=>step.fingerprint),canvasScriptAnchors(projected.canvas.execution)!.map(anchor=>anchor.fingerprint));
 assert.equal(anchorMatches(anchorForNewScript(steps,steps.at(-1)!.visitIndex),steps),true);
});

for(const mode of ['inserted-launch','existing-launch','empty','repeated-visit'] as const)test('PR #84 canvas anchors survive server projection: '+mode,async()=>{
 const f=await scriptFixture();try{
  const canvas:CanvasGraph={screens:[{id:'home',title:'Home',x:0,y:0,tests:mode==='empty'?[]:['first','last'].map(id=>({id,label:id,role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},check:{visibility:'visible',target:'text',match:'exact',value:id}}))}],edges:[],paths:[{id:'path',name:'One',scenarioId:'one',screenId:'home',edgeIds:[],visits:[{id:'visit',operationIds:mode==='empty'?[]:['first','last']}]}]};
  if(mode==='repeated-visit'){
   canvas.screens[0].tests.push({id:'again',label:'Again',role:'action',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},tap:{target:'text',match:'exact',value:'Again'}});
   canvas.edges=[{id:'loop',from:'home',to:'home',actionTestId:'again',actionTestIds:['again'],assertionTestId:'first',responseCondition:'Again'}];
   canvas.paths[0].edgeIds=['loop'];canvas.paths[0].visits=[{id:'visit',operationIds:['first','again']},{id:'return',operationIds:['first','last']}];
  }
  let yaml=writeChecks('appId: com.example.HybridApp\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);
  if(mode!=='existing-launch')yaml=yaml.replace('- launchApp\n','');
  if(mode==='empty')yaml+='[]\n';
  const refs=(await f.service.references({yaml})).references;
  for(const check of authoredChecks(yaml))canvas.screens[0].tests.find(test=>test.id===check.id)!.reference=refs.find(ref=>ref.kind==='step'&&ref.index===check.index)!;
  // Use the pinned PR B helpers, rather than deriving anchors from server-projected YAML.
  const steps=orderedScenarioSteps(canvas,'path');
  const end=anchorForNewScript(steps,mode==='repeated-visit'?1:0);
  const scripts=[...(steps.length?[{...f.row,id:'before-first',beforeStep:anchorForNewScript(steps,-1)}]:[]),...(mode==='repeated-visit'?[{...f.row,id:'before-return',beforeStep:anchorForNewScript(steps,0)}]:[]),{...f.row,id:'after-last-a',beforeStep:end},{...f.row,id:'after-last-b',beforeStep:end}].map(row=>({...row,source:'output.order = (output.order || "") + '+JSON.stringify(row.id+',')}));
  for(const row of scripts)assert.equal(anchorMatches(row.beforeStep,steps),true);
  const workspace=await f.service.save({...f.workspace,yaml,canvas,scenarios:[{...f.scenario,authoring:'canvas',pathId:'path',steps:[],scripts}]});
  const result=await f.service.wait((await f.start()).id);
  assert.equal(result.status,'passed');assert.deepEqual(Object.keys(result.scriptSteps!),scripts.map(row=>row.id));
  assert.deepEqual(result.executionOrder?.filter(item=>item.kind==='step'),steps.map((_,index)=>({kind:'step',index})));
  assert.deepEqual(result.executionOrder?.[0],{kind:'system'});assert.equal(result.steps.length,steps.length);assert.equal(result.snapshot.steps.length,steps.length);
  assert.ok(Object.values(result.scriptSteps!).every(row=>row.status==='passed'));
  assert.equal(f.outputs[0].order,scripts.map(row=>row.id+',').join(''));
  const commands=parseAllDocuments(await readFile(f.calls[0].flow,'utf8'))[1].toJS();
  assert.equal(commands[0],'launchApp');
  assert.deepEqual(commands.map((command:any)=>typeof command==='string'?command:Object.keys(command)[0]),mode==='empty'?['launchApp','runScript','runScript']:mode==='repeated-visit'?['launchApp','runScript','assertVisible','tapOn','runScript','assertVisible','assertVisible','runScript','runScript']:['launchApp','runScript','assertVisible','assertVisible','runScript','runScript']);
  assert.deepEqual((await f.service.workspace(workspace.id)).scenarios![0].scripts,scripts,'Projection must not rewrite saved UI anchors');
  for(const edit of mode==='empty'?['append']:['append','change-last']){
   const changed=structuredClone(canvas);
   if(edit==='append'){
    changed.screens[0].tests.push({id:'added',label:'Added',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},check:{visibility:'visible',target:'text',match:'exact',value:'Added'}});
    changed.paths[0].visits!.at(-1)!.operationIds!.push('added');
   }else changed.screens[0].tests.find(test=>test.id==='last')!.check!.value='Changed';
   let changedYaml=writeChecks('appId: com.example.HybridApp\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},changed);
   if(mode!=='existing-launch')changedYaml=changedYaml.replace('- launchApp\n','');
   const changedRefs=(await f.service.references({yaml:changedYaml})).references;
   for(const check of authoredChecks(changedYaml))changed.screens[0].tests.find(test=>test.id===check.id)!.reference=changedRefs.find(ref=>ref.kind==='step'&&ref.index===check.index)!;
   assert.equal(anchorMatches(end,orderedScenarioSteps(changed,'path')),false);
   await f.service.save({...await f.service.workspace(workspace.id),yaml:changedYaml,canvas:changed});
   const acquisitions=f.stats().acquisitions;
   await assert.rejects(f.start(),(error:unknown)=>error instanceof ScriptBlocked&&error.blocked.some(row=>row.kind==='stale-anchor'&&row.rowId==='after-last-a'));
   assert.equal(f.stats().acquisitions,acquisitions,'Real authored changes must still block before device acquisition');assert.equal(f.calls.length,1);
  }
 }finally{await f.cleanup();}
});

test('canvas script throwing before authored step 2 leaves step 2+ Not run, including server duplicates',async()=>{
 const f=await scriptFixture();try{
  const canvas:CanvasGraph={screens:[{id:'home',title:'Home',x:0,y:0,tests:['first','second','third'].map(id=>({id,label:id,role:'assertion',scenarioIds:['one'],reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},check:{visibility:'visible',target:'text',match:'exact',value:id}}))}],edges:[],paths:[{id:'path',name:'One',scenarioId:'one',screenId:'home',edgeIds:[],visits:[{id:'visit',operationIds:['first','second','third']}]}]};
  const yaml=writeChecks('appId: com.example.HybridApp\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas).replace('- launchApp\n','');
  const refs=(await f.service.references({yaml})).references;
  for(const check of authoredChecks(yaml))canvas.screens[0].tests.find(test=>test.id===check.id)!.reference=refs.find(ref=>ref.kind==='step'&&ref.index===check.index)!;
  const steps=orderedScenarioSteps(canvas,'path');
  const row={...f.row,source:'throw new Error("Before second")',beforeStep:{index:1,fingerprint:steps[1].fingerprint}};
  const later={...row,id:'later',source:'output.mustNotRun = true',beforeStep:anchorForNewScript(steps,0)};
  await f.service.save({...f.workspace,yaml,canvas,scenarios:[{...f.scenario,authoring:'canvas',pathId:'path',steps:[],scripts:[row,later]}]});
  const result=await f.service.wait((await f.start()).id);assert.equal(result.status,'script-error');
  assert.deepEqual(result.executionOrder,[{kind:'system'},{kind:'step',index:0},{kind:'runScript',rowId:row.id},{kind:'step',index:1},{kind:'step',index:2},{kind:'runScript',rowId:later.id}]);
  assert.deepEqual(result.steps.map(step=>[step.id,step.status]),[['step-1','passed'],['step-2','not-run'],['step-3','not-run']]);
  assert.deepEqual(result.snapshot.steps.map(step=>step.id),['step-1','step-2','step-3']);
  assert.equal(result.scriptSteps![row.id].status,'script-error');assert.equal(result.scriptSteps![later.id].status,'not-run');assert.equal(f.outputs[0].mustNotRun,undefined);
  assert.equal(result.canvas?.occurrences?.[0].stepId,'step-1');
  const saved=await f.service.workspace(f.workspace.id);
  const duplicated=await f.service.duplicateScenario({workspaceId:saved.id,scenarioId:'one',expectedRevision:saved.metadata!.revision});
  const copy=duplicated.scenarios!.at(-1)!;const path=duplicated.canvas!.paths.find(path=>path.id===copy.pathId)!;
  assert.notEqual(copy.pathId,'path');assert.equal(path.scenarioId,copy.id);assert.notEqual(path.visits![0].id,'visit');assert.deepEqual(path.visits![0].operationIds,['first','second','third']);
  assert.ok(duplicated.canvas!.screens[0].tests.every(test=>test.scenarioIds?.includes('one')&&test.scenarioIds.includes(copy.id)));
  assert.ok(copy.scripts!.every(copied=>copied.id!==row.id&&copied.id!==later.id));
  assert.deepEqual(copy.scripts!.map(({id,...row})=>row),[row,later].map(({id,...row})=>row));
  const copiedRun=await f.service.wait((await f.service.start({workspaceId:saved.id,scenarioId:copy.id,deviceId:f.calls[0].deviceId})).id);
  assert.equal(copiedRun.status,'script-error');assert.deepEqual(copiedRun.steps.map(step=>step.status),['passed','not-run','not-run']);
  assert.deepEqual(Object.keys(copiedRun.scriptSteps!),copy.scripts!.map(row=>row.id));
  assert.deepEqual(duplicated.scenarios![0].scripts,[row,later],'Duplicating must preserve the original script identities');
 }finally{await f.cleanup();}
});

for(const edit of ['edit-step','reorder-step'] as const)test('PR #84 mid-scenario canvas anchor goes stale: '+edit,async()=>{
 const f=await scriptFixture();try{
  const canvas:CanvasGraph={screens:[{id:'home',title:'Home',x:0,y:0,tests:['first','middle','last'].map(id=>({id,label:id,role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},check:{visibility:'visible',target:'text',match:'exact',value:id}}))}],edges:[],paths:[{id:'path',name:'One',scenarioId:'one',screenId:'home',edgeIds:[],visits:[{id:'visit',operationIds:['first','middle','last']}]}]};
  async function author(graph:CanvasGraph){
   const yaml=writeChecks('appId: com.example.HybridApp\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},graph).replace('- launchApp\n','');
   const refs=(await f.service.references({yaml})).references;
   for(const check of authoredChecks(yaml))graph.screens[0].tests.find(test=>test.id===check.id)!.reference=refs.find(ref=>ref.kind==='step'&&ref.index===check.index)!;
   return yaml;
  }
  const yaml=await author(canvas);const steps=orderedScenarioSteps(canvas,'path');const target=steps[1];
  const row={...f.row,id:'before-middle',beforeStep:{index:target.globalIndex,fingerprint:target.fingerprint}};
  assert.equal(anchorMatches(row.beforeStep,steps),true);
  const workspace=await f.service.save({...f.workspace,yaml,canvas,scenarios:[{...f.scenario,authoring:'canvas',pathId:'path',steps:[],scripts:[row]}]});
  const baseline=await f.service.wait((await f.start()).id);assert.equal(baseline.status,'passed');assert.equal(baseline.scriptSteps![row.id].status,'passed');
  const commands=parseAllDocuments(await readFile(f.calls[0].flow,'utf8'))[1].toJS();
  assert.deepEqual(commands.map((command:any)=>typeof command==='string'?command:Object.keys(command)[0]),['launchApp','assertVisible','runScript','assertVisible','assertVisible']);
  const changed=structuredClone(canvas);
  if(edit==='edit-step')changed.screens[0].tests.find(test=>test.id==='middle')!.check!.value='Edited middle';
  else changed.paths[0].visits![0].operationIds=['middle','first','last'];
  const changedYaml=await author(changed);const changedSteps=orderedScenarioSteps(changed,'path');
  assert.equal(anchorMatches(row.beforeStep,changedSteps),false);
  assert.deepEqual(anchorForNewScript(changedSteps,0),anchorForNewScript(steps,0),'The end anchor stays valid; only the mid-scenario anchor is under test');
  await f.service.save({...await f.service.workspace(workspace.id),yaml:changedYaml,canvas:changed});
  const before=f.stats();
  await assert.rejects(f.start(),(error:unknown)=>{
   assert.ok(error instanceof ScriptBlocked);
   assert.deepEqual(error.blocked,[{kind:'stale-anchor',rowId:row.id,message:'Step changed · relink before running'}]);return true;
  });
  assert.deepEqual(f.stats(),before,'Stale rows must block before acquiring a device or calling app, mock or Maestro tools');assert.equal(f.calls.length,1);
  assert.deepEqual((await f.service.workspace(workspace.id)).scenarios![0].scripts,[row],'Editing/reordering a step must not silently relink the saved script');
 }finally{await f.cleanup();}
});
