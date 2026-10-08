import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRunner} from '../server/runner.js';
import {createScenarios} from '../server/scenarios.js';
const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
const yaml='appId: com.example.HybridApp\n---\n- launchApp\n- tapOn: Settings\n- assertVisible: Settings\n';
function device(root:string){return createRunner({artifactDirectory:root,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/installed/app',stderr:''})});}
test('an explicitly selected canvas route maps actual outcomes to its immutable screen and transition references',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-'));
 try {
 const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
 await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
 await writeFile(join(directory,'commands.json'),JSON.stringify([
 {command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},
 {command:{tapOnElement:{}},metadata:{depth:0,status:'COMPLETED'}},
 {command:{assertConditionCommand:{}},metadata:{depth:0,status:'COMPLETED'}}]));
 return {code:0,log:'Fixture run',cleanup:{verified:true,detail:'Fixture owned process exited.'}};
 }}});
 const catalog=await (scenarios as any).references({yaml});
 const graph={screens:[{id:'home',title:'Home',x:60,y:100,tests:[{id:'trigger',label:'Open Settings',role:'action',reference:catalog.references[1]}]},{id:'settings',title:'Settings',x:430,y:100,tests:[{id:'destination',label:'Settings visible',role:'assertion',reference:catalog.references[2]}]}],edges:[{id:'open-settings',from:'home',to:'settings',actionTestId:'trigger',assertionTestId:'destination',responseCondition:'No API condition'}],paths:[{id:'settings-path',name:'Settings route',edgeIds:['open-settings']} ]};
 const workspace=await scenarios.save({name:'Canvas route',yaml,canvas:graph} as any);
 const run=await scenarios.start({workspaceId:workspace.id,deviceId,pathId:'settings-path'} as any);
 await scenarios.save({id:workspace.id,name:'Later edit',yaml,canvas:{...graph,screens:graph.screens.map(s=>({...s,title:'Edited'}))}} as any);
 const result=await scenarios.wait(run.id);
 assert.equal(result.status,'passed');
 assert.equal((result as any).canvas.pathId,'settings-path');
 assert.deepEqual((result as any).canvas.edges.map((edge:any)=>[edge.id,edge.status]),[['open-settings','passed']]);
 assert.equal((result.snapshot as any).canvas.screens[0].title,'Home');
 assert.equal((result as any).canvas.screens.find((s:any)=>s.id==='settings').status,'passed');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('changing a called assertion flow makes its canvas reference stale instead of changing the meaning silently',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-stale-'));
 try{
 const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async()=>{throw new Error('Must not execute');}}});
 const flowYaml='appId: com.example.HybridApp\n---\n- tapOn: Settings\n- runFlow: page.yaml\n';
 const flows={'page.yaml':'appId: com.example.HybridApp\n---\n- assertVisible: Settings\n'};
 const catalog=await scenarios.references({yaml:flowYaml,flows});
 const graph={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'action',label:'Settings tap',role:'action',reference:catalog.references[0]}]},{id:'settings',title:'Settings',x:400,y:0,tests:[{id:'assert',label:'Settings assertion',role:'assertion',reference:catalog.references[1]}]}],edges:[{id:'edge',from:'home',to:'settings',actionTestId:'action',assertionTestId:'assert',responseCondition:'No API'}],paths:[{id:'route',name:'Settings',edgeIds:['edge']}]};
 const workspace=await scenarios.save({name:'Stale flow',yaml:flowYaml,flows,canvas:graph});
 await scenarios.save({...workspace,flows:{'page.yaml':flows['page.yaml'].replace('Settings','Maintenance')}});
 await assert.rejects(scenarios.start({workspaceId:workspace.id,deviceId,pathId:'route'}),/stale/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a passed tool report cannot pass a selected route whose destination assertion was skipped',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-skipped-'));
 try{
 const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
 await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
 await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{tapOnElement:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{}},metadata:{depth:0,status:'SKIPPED'}}]));
 return{code:0,log:'Optional assertion skipped',cleanup:{verified:true,detail:'Fixture stopped.'}};
 }}});
 const catalog=await scenarios.references({yaml});
 const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'tap',label:'Open Settings',role:'action',reference:catalog.references[1]}]},{id:'settings',title:'Settings',x:400,y:0,tests:[{id:'assert',label:'Settings required',role:'assertion',reference:catalog.references[2]}]}],edges:[{id:'edge',from:'home',to:'settings',actionTestId:'tap',assertionTestId:'assert',responseCondition:'Settings route'}],paths:[{id:'path',name:'Settings',edgeIds:['edge']}]};
 const workspace=await scenarios.save({name:'Skipped destination',yaml,canvas});
 const result=await scenarios.wait((await scenarios.start({workspaceId:workspace.id,deviceId,pathId:'path'})).id);
 assert.equal(result.status,'path-failed');assert.match(result.error??'',/selected.*not verified/i);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a wrong destination fails its chosen transition without switching to another branch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-wrong-'));
 try{
 const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
 await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="1"/></testsuites>');
 await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{tapOnElement:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{visible:{textRegex:'Settings'}}}},metadata:{depth:0,status:'FAILED',error:{message:'Wrong destination'}}}]));
 return{code:1,log:'Wrong destination',cleanup:{verified:true,detail:'Fixture stopped.'}};
 }}});
 const flows={'maintenance.yaml':'appId: com.example.HybridApp\n---\n- assertVisible: Maintenance\n'};
 const catalog=await scenarios.references({yaml,flows});
 const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'tap',label:'Open Settings',role:'action',reference:catalog.references[1]}]},{id:'settings',title:'Settings',x:400,y:0,tests:[{id:'assert',label:'Settings required',role:'assertion',reference:catalog.references[2]}]},{id:'maintenance',title:'Maintenance',x:400,y:400,tests:[{id:'maintenance-assert',label:'Shared maintenance assertion',role:'assertion',reference:catalog.references[3]}]}],edges:[{id:'settings-edge',from:'home',to:'settings',actionTestId:'tap',assertionTestId:'assert',responseCondition:'Normal'},{id:'maintenance-edge',from:'home',to:'maintenance',actionTestId:'tap',assertionTestId:'maintenance-assert',responseCondition:'HTTP 500'}],paths:[{id:'settings-path',name:'Settings',edgeIds:['settings-edge']},{id:'maintenance-path',name:'Maintenance',edgeIds:['maintenance-edge']}]};
 const workspace=await scenarios.save({name:'Two destinations',yaml,flows,canvas});
 const result=await scenarios.wait((await scenarios.start({workspaceId:workspace.id,deviceId,pathId:'settings-path'})).id);
 assert.equal(result.status,'assertion-failed');assert.equal(result.canvas?.pathId,'settings-path');
 assert.deepEqual(result.canvas?.edges.map(edge=>[edge.id,edge.status]),[['settings-edge','failed'],['maintenance-edge','unavailable']]);
 await assert.rejects(scenarios.start({workspaceId:workspace.id,deviceId,pathId:'maintenance-path'}),/uncalled/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('duplicated moved commands produce repairable ambiguous references and prevent tool execution',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-ambiguous-'));
 try{
 const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async()=>{assert.fail('Must not run a stale path');}}});
 const catalog=await scenarios.references({yaml});
 const graph={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'tap',label:'Original tap',role:'action',reference:catalog.references[1]}]},{id:'settings',title:'Settings',x:400,y:0,tests:[{id:'assert',label:'Destination',role:'assertion',reference:catalog.references[2]}]}],edges:[{id:'edge',from:'home',to:'settings',actionTestId:'tap',assertionTestId:'assert',responseCondition:'Normal'}],paths:[{id:'path',name:'Normal',edgeIds:['edge']}]};
 const changed='appId: com.example.HybridApp\n---\n- launchApp\n- assertVisible: Home\n- tapOn: Settings\n- tapOn: Settings\n- assertVisible: Settings\n';
 const workspace=await scenarios.save({name:'Ambiguous edit',yaml:changed,canvas:graph});
 assert.match(workspace.canvasDiagnostics?.find(item=>item.ownerId==='tap')?.detail??'',/Ambiguous/);
 await assert.rejects(scenarios.start({workspaceId:workspace.id,deviceId,pathId:'path'}),/Ambiguous/);
 const updated=await scenarios.references({yaml:changed});
 graph.screens[0].tests[0].reference=updated.references[2];graph.screens[1].tests[0].reference=updated.references[4];
 const repaired=await scenarios.save({id:workspace.id,name:'Explicit repair',yaml:changed,canvas:graph});
 assert.deepEqual(repaired.canvasDiagnostics,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('reusable flow header variables are part of the executable reference identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-header-'));
 try{
 const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async()=>{assert.fail('Stale header must not execute');}}});
 const source='appId: com.example.HybridApp\n---\n- tapOn: Settings\n- runFlow: page.yaml\n';
 const flows={'page.yaml':'appId: com.example.HybridApp\nenv:\n  EXPECTED_PAGE: Settings\n---\n- assertVisible: ${EXPECTED_PAGE}\n'};
 const catalog=await scenarios.references({yaml:source,flows});
 const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'tap',label:'Settings tap',role:'action',reference:catalog.references[0]}]},{id:'settings',title:'Settings',x:400,y:0,tests:[{id:'assert',label:'Expected page flow',role:'assertion',reference:catalog.references[2]}]}],edges:[{id:'edge',from:'home',to:'settings',actionTestId:'tap',assertionTestId:'assert',responseCondition:'Normal'}],paths:[{id:'path',name:'Settings',edgeIds:['edge']}]};
 const workspace=await scenarios.save({name:'Header changed',yaml:source,flows:{'page.yaml':flows['page.yaml'].replace('EXPECTED_PAGE: Settings','EXPECTED_PAGE: Maintenance')},canvas});
 assert.match(workspace.canvasDiagnostics?.find(item=>item.ownerId==='assert')?.detail??'',/stale/);
 await assert.rejects(scenarios.start({workspaceId:workspace.id,deviceId,pathId:'path'}),/stale/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('root header variable changes also require explicit destination relinking',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-root-header-'));
 try{
 const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async()=>{assert.fail('Stale root header must not execute');}}});
 const source='appId: com.example.HybridApp\nenv:\n  PAGE: Settings\n---\n- tapOn: Settings\n- assertVisible: ${PAGE}\n';
 const catalog=await scenarios.references({yaml:source});
 const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'tap',label:'Tap',role:'action',reference:catalog.references[0]}]},{id:'settings',title:'Settings',x:400,y:0,tests:[{id:'assert',label:'Expected page',role:'assertion',reference:catalog.references[1]}]}],edges:[{id:'edge',from:'home',to:'settings',actionTestId:'tap',assertionTestId:'assert',responseCondition:'Normal'}],paths:[{id:'path',name:'Settings',edgeIds:['edge']}]};
 const workspace=await scenarios.save({name:'Root header changed',yaml:source.replace('PAGE: Settings','PAGE: Maintenance'),canvas});
 await assert.rejects(scenarios.start({workspaceId:workspace.id,deviceId,pathId:'path'}),/stale/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a reusable-flow association becomes stale when its root invocation parameters change',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-invocation-'));
 try{
 const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async()=>{assert.fail('Changed invocation must not execute');}}});
 const source='appId: com.example.HybridApp\n---\n- tapOn: Settings\n- runFlow:\n    file: page.yaml\n    env:\n      PAGE: Settings\n';
 const flows={'page.yaml':'appId: com.example.HybridApp\n---\n- assertVisible: ${PAGE}\n'};
 const catalog=await scenarios.references({yaml:source,flows});
 const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'tap',label:'Tap',role:'action',reference:catalog.references[0]}]},{id:'settings',title:'Settings',x:400,y:0,tests:[{id:'assert',label:'Expected page',role:'assertion',reference:catalog.references[2]}]}],edges:[{id:'edge',from:'home',to:'settings',actionTestId:'tap',assertionTestId:'assert',responseCondition:'Normal'}],paths:[{id:'path',name:'Settings',edgeIds:['edge']}]};
 const workspace=await scenarios.save({name:'Invocation changed',yaml:source.replace('PAGE: Settings','PAGE: Maintenance'),flows,canvas});
 await assert.rejects(scenarios.start({workspaceId:workspace.id,deviceId,pathId:'path'}),/stale/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a selected route maps its checkpoint handler and setup from the executed snapshot, not another invocation of the same flow',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-handler-'));
 try{
  const source='appId: com.example.HybridApp\n---\n- assertVisible: Details\n';
  const flows={'setup.yaml':'appId: com.example.HybridApp\n---\n- assertVisible: Home\n','action.yaml':'appId: com.example.HybridApp\n---\n- tapOn: ${TARGET}\n'};
  const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
   await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
   await writeFile(join(directory,'commands.json'),JSON.stringify([
    {command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},
    {command:{runFlowCommand:{label:'TnT setup'}},metadata:{depth:0,status:'COMPLETED'}},
    {command:{runFlowCommand:{label:'TnT checkpoint 1'}},metadata:{depth:0,status:'COMPLETED'}},
    {command:{runFlowCommand:{label:'TnT handler open checkpoint 1'}},metadata:{depth:2,status:'COMPLETED'}},
    {command:{runFlowCommand:{label:'TnT handler other checkpoint 1'}},metadata:{depth:2,status:'SKIPPED'}},
    {command:{runFlowCommand:{label:'TnT step 1',commands:[{assertConditionCommand:{condition:{visible:{textRegex:'Details'}}}}]}},metadata:{depth:0,status:'COMPLETED'}},
    {command:{assertConditionCommand:{condition:{visible:{textRegex:'Details'}}}},metadata:{depth:1,status:'COMPLETED'}},
   ]));return{code:0,log:'Fixture',cleanup:{verified:true,detail:'Exited'}};
  }}});
  const plain=await scenarios.references({yaml:source,flows});
  const automation={setup:{file:'setup.yaml',parameters:{}},actions:[{id:'open',name:'Open details',condition:{text:'Home'},file:'action.yaml',parameters:{TARGET:'Coordinator'},enabled:true},{id:'other',name:'Other action',condition:{text:'Home'},file:'action.yaml',parameters:{TARGET:'Wrong'},enabled:true}],checkpoints:[{beforeStep:0,fingerprint:plain.references[0].fingerprint,timeoutMs:0}]};
  const catalog=await scenarios.references({yaml:source,flows,automation});
  const handler=catalog.references.find(reference=>reference.kind==='handler'&&reference.actionId==='open');assert.ok(handler);
  const setup=catalog.references.find(reference=>reference.kind==='setup');assert.ok(setup);
  const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'setup',label:'Independent setup',role:'setup',reference:setup},{id:'trigger',label:'Open details',role:'handler',reference:handler}]},{id:'details',title:'Details',x:400,y:0,tests:[{id:'assert',label:'Expected Details',role:'assertion',reference:catalog.references[0]}]}],edges:[{id:'edge',from:'home',to:'details',actionTestId:'trigger',assertionTestId:'assert',responseCondition:'Default action opens Details'}],paths:[{id:'path',name:'Details',edgeIds:['edge']}]};
  const workspace=await scenarios.save({name:'Handler route',yaml:source,flows,automation,canvas});
  const result=await scenarios.wait((await scenarios.start({workspaceId:workspace.id,deviceId,pathId:'path'})).id);
  assert.equal(result.status,'passed');assert.equal(result.canvas?.tests.find(test=>test.id==='setup')?.status,'passed');
  assert.equal(result.canvas?.tests.find(test=>test.id==='trigger')?.status,'passed');assert.equal(result.canvas?.edges[0].status,'passed');
  await scenarios.save({...workspace,automation:{...automation,actions:automation.actions.map(action=>({...action,parameters:{TARGET:'Edited after run'}}))}});
  assert.equal((await scenarios.result(result.id)).canvas?.tests.find(test=>test.id==='trigger')?.status,'passed');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('an unrelated authored subflow label cannot make a skipped checkpoint handler pass its selected route',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-handler-scope-'));
 try{
  const source='appId: com.example.HybridApp\n---\n- assertVisible: Details\n';
  const flows={'setup.yaml':'appId: com.example.HybridApp\n---\n- assertVisible: Home\n','action.yaml':'appId: com.example.HybridApp\n---\n- tapOn: Coordinator\n'};
  const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
   await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
   await writeFile(join(directory,'commands.json'),JSON.stringify([
    {command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},
    {command:{runFlowCommand:{label:'TnT setup'}},metadata:{depth:0,status:'COMPLETED'}},
    {command:{runFlowCommand:{label:'TnT checkpoint 1'}},metadata:{depth:0,status:'COMPLETED'}},
    {command:{runFlowCommand:{label:'TnT handler open checkpoint 1'}},metadata:{depth:2,status:'SKIPPED'}},
    {command:{runFlowCommand:{label:'TnT step 1',commands:[{assertConditionCommand:{condition:{visible:{textRegex:'Details'}}}}]}},metadata:{depth:0,status:'COMPLETED'}},
    {command:{assertConditionCommand:{condition:{visible:{textRegex:'Details'}}}},metadata:{depth:1,status:'COMPLETED'}},
    {command:{runFlowCommand:{label:'TnT handler open checkpoint 1'}},metadata:{depth:2,status:'COMPLETED'}},
   ]));return{code:0,log:'Fixture',cleanup:{verified:true,detail:'Exited'}};
  }}});
  const plain=await scenarios.references({yaml:source,flows});
  const automation={setup:{file:'setup.yaml',parameters:{}},actions:[{id:'open',name:'Open',condition:{text:'Absent'},file:'action.yaml',parameters:{},enabled:true}],checkpoints:[{beforeStep:0,fingerprint:plain.references[0].fingerprint,timeoutMs:0}]};
  const catalog=await scenarios.references({yaml:source,flows,automation});const handler=catalog.references.find(reference=>reference.kind==='handler')!;
  const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'trigger',label:'Open',role:'handler',reference:handler}]},{id:'details',title:'Details',x:400,y:0,tests:[{id:'assert',label:'Details',role:'assertion',reference:catalog.references[0]}]}],edges:[{id:'edge',from:'home',to:'details',actionTestId:'trigger',assertionTestId:'assert',responseCondition:'Only explicit handler'}],paths:[{id:'path',name:'Details',edgeIds:['edge']}]};
  const workspace=await scenarios.save({name:'Scoped outcome',yaml:source,flows,automation,canvas});
  const result=await scenarios.wait((await scenarios.start({workspaceId:workspace.id,deviceId,pathId:'path'})).id);
  assert.equal(result.status,'path-failed');assert.equal(result.canvas?.tests.find(test=>test.id==='trigger')?.status,'skipped');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a stale auxiliary handler association stays unavailable even when its newly configured action passes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-auxiliary-'));
 try{
  const source='appId: com.example.HybridApp\n---\n- tapOn: Coordinator\n- assertVisible: Details\n';
  const flows={'setup.yaml':'appId: com.example.HybridApp\n---\n- assertVisible: Home\n','action.yaml':'appId: com.example.HybridApp\n---\n- tapOn: ${TARGET}\n'};
  const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
   await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
   const labels=['TnT setup','TnT checkpoint 1','TnT handler optional checkpoint 1','TnT step 1','TnT step 2'];
   await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},...labels.flatMap<unknown>(label=>label==='TnT step 2'?[{command:{runFlowCommand:{label,commands:[{assertConditionCommand:{condition:{visible:{textRegex:'Details'}}}}]}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{visible:{textRegex:'Details'}}}},metadata:{depth:1,status:'COMPLETED'}}]:[{command:{runFlowCommand:{label}},metadata:{depth:label.includes('handler')?2:0,status:'COMPLETED'}}])]));
   return{code:0,log:'Fixture',cleanup:{verified:true,detail:'Exited'}};
  }}});
  const plain=await scenarios.references({yaml:source,flows});
  const automation={setup:{file:'setup.yaml',parameters:{}},actions:[{id:'optional',name:'Optional',condition:{text:'Home'},file:'action.yaml',parameters:{TARGET:'Old'},enabled:true}],checkpoints:[{beforeStep:0,fingerprint:plain.references[0].fingerprint,timeoutMs:0}]};
  const catalog=await scenarios.references({yaml:source,flows,automation});
  const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'trigger',label:'Tap',role:'action',reference:plain.references[0]},{id:'old-handler',label:'Old handler',role:'handler',reference:catalog.references.find(reference=>reference.kind==='handler')!}]},{id:'details',title:'Details',x:400,y:0,tests:[{id:'assert',label:'Details',role:'assertion',reference:plain.references[1]}]}],edges:[{id:'edge',from:'home',to:'details',actionTestId:'trigger',assertionTestId:'assert',responseCondition:'Authored route'}],paths:[{id:'path',name:'Details',edgeIds:['edge']}]};
  const workspace=await scenarios.save({name:'Stale auxiliary',yaml:source,flows,canvas,automation:{...automation,actions:automation.actions.map(action=>({...action,parameters:{TARGET:'New'}}))}});
  assert.ok(workspace.canvasDiagnostics?.some(diagnostic=>diagnostic.ownerId==='old-handler'));
  const result=await scenarios.wait((await scenarios.start({workspaceId:workspace.id,deviceId,pathId:'path'})).id);
  assert.equal(result.status,'passed');assert.equal(result.automation?.actions[0].status,'passed');
  assert.equal(result.canvas?.tests.find(test=>test.id==='old-handler')?.status,'unavailable');
  assert.match(result.canvas?.tests.find(test=>test.id==='old-handler')?.detail??'',/stale/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a completed reusable-flow wrapper cannot pass a destination whose nested assertion was skipped',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-canvas-nested-skipped-'));
 try{
  const source='appId: com.example.HybridApp\n---\n- tapOn: Open\n- runFlow: maintenance.yaml\n';
  const flows={'maintenance.yaml':'appId: com.example.HybridApp\n---\n- assertVisible:\n    text: Maintenance\n    optional: true\n'};
  const assertion={assertConditionCommand:{condition:{visible:{textRegex:'Maintenance',optional:true}}}};
  const scenarios=createScenarios({root,runner:device(root),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
   await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
   await writeFile(join(directory,'commands.json'),JSON.stringify([
    {command:{tapOnElement:{}},metadata:{depth:0,status:'COMPLETED'}},
    {command:{runFlowCommand:{commands:[assertion]}},metadata:{depth:0,status:'COMPLETED'}},
    {command:assertion,metadata:{depth:1,status:'SKIPPED'}},
   ]));return{code:0,log:'Optional assertion skipped',cleanup:{verified:true,detail:'Exited'}};
  }}});
  const catalog=await scenarios.references({yaml:source,flows});
  const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'trigger',label:'Open',role:'action',reference:catalog.references[0]}]},{id:'maintenance',title:'Maintenance',x:400,y:0,tests:[{id:'assert',label:'Maintenance',role:'assertion',reference:catalog.references[2]}]}],edges:[{id:'edge',from:'home',to:'maintenance',actionTestId:'trigger',assertionTestId:'assert',responseCondition:'Maintenance required'}],paths:[{id:'path',name:'Maintenance',edgeIds:['edge']}]};
  const workspace=await scenarios.save({name:'Nested assertion skipped',yaml:source,flows,canvas});
  const result=await scenarios.wait((await scenarios.start({workspaceId:workspace.id,deviceId,pathId:'path'})).id);
  assert.equal(result.status,'path-failed');assert.equal(result.canvas?.tests.find(test=>test.id==='assert')?.status,'skipped');
 }finally{await rm(root,{recursive:true,force:true});}
});
