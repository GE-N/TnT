import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
import {appendVisitStep,navigationHint,moveAboveNavigation,isCommittableSelector,stepRowLabel} from '../src/inspector-operations.js';
import {refreshChecks,writeChecks} from '../shared/canvas-authoring.js';
import {projectCanvasRoute} from '../server/canvas-route.js';
const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
const tap=(id:string):CanvasTest=>({id,label:id,role:'action',reference,tap:{target:'text',match:'exact',value:id}});
const check:CanvasTest={id:'check',label:'Ready',role:'assertion',reference,check:{target:'text',match:'exact',value:'Ready',visibility:'visible'}};
const graph:CanvasGraph={screens:[{id:'home',title:'Home',x:0,y:0,tests:[tap('first'),tap('second')]},{id:'settings',title:'Settings',x:400,y:0,tests:[]}],edges:[{id:'edge',from:'home',to:'settings',actionTestId:'first',actionTestIds:['first','second'],assertionTestId:'pending:edge',responseCondition:'Open Settings'}],paths:[{id:'route',name:'Main',screenId:'home',scenarioId:'main',edgeIds:['edge'],visits:[{id:'v1',operationIds:['first','second']},{id:'v2',operationIds:[]}]}]};
const source=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},graph);

test('add-check placement (intended change, #40)',()=>{
 const next=appendVisitStep(graph,'route','v1',check);
 assert.deepEqual(next.paths[0].visits![0].operationIds,['first','second','check']);
 const yaml=writeChecks(source,graph,next);
 // The main legacy storage path adds the identical check without changing visit order.
 const main={...graph,screens:graph.screens.map(screen=>screen.id==='home'?{...screen,tests:[...screen.tests,check]}:screen)};
 assert.equal(yaml,writeChecks(source,graph,main),'workspace YAML is byte-identical to main storage semantics');
 const execution=projectCanvasRoute(refreshChecks(next,yaml),yaml,{},'route').yaml;
 assert.ok(execution.lastIndexOf('assertVisible')>execution.lastIndexOf('tapOn'));
 assert.deepEqual(graph.paths[0].visits![0].operationIds,['first','second'],'input is immutable');
});
test('append action remains unconnected and enforces visit and stored node limits',()=>{
 const next=appendVisitStep(graph,'route','v1',tap('new'));
 assert.equal(next.paths[0].visits![0].operationIds!.at(-1),'new');assert.deepEqual(next.edges,graph.edges);
 assert.throws(()=>appendVisitStep({...graph,paths:[{...graph.paths[0],visits:[{id:'v1',operationIds:Array.from({length:30},(_,i)=>String(i))}]}]},'route','v1',check),/30/);
 assert.throws(()=>appendVisitStep({...graph,screens:[{...graph.screens[0],tests:Array.from({length:600},(_,i)=>tap(String(i)))}]},'route','v1',check),/stored step limit/);
 assert.throws(()=>appendVisitStep(graph,'route','missing',check),/Select a visit/);
 assert.throws(()=>appendVisitStep(graph,'route','v1',tap('first')),/unique/);
});
test('navigation hint covers two actions, checks and same-screen actions, but not navigating steps',()=>{
 const next=appendVisitStep(graph,'route','v1',check);
 assert.deepEqual(navigationHint(next,'route','v1','check'),{destination:'Settings',firstActionId:'first'});
 assert.equal(navigationHint(next,'route','v1','second'),undefined);
 const same={...next,edges:next.edges.map(edge=>({...edge,to:'home'}))};assert.equal(navigationHint(same,'route','v1','check'),undefined);
 const action=appendVisitStep(next,'route','v1',tap('local'));assert.equal(navigationHint(action,'route','v1','local')?.destination,'Settings');
 const once={...next,paths:[{...next.paths[0],visits:[{id:'v1',operationIds:['first','check','second']},next.paths[0].visits![1]]}]};assert.ok(navigationHint(once,'route','v1','check'),'one move up does not clear two preceding actions');
});
test('move above navigation crosses both actions atomically and preserves storage YAML',()=>{
 const next=appendVisitStep(graph,'route','v1',check);const moved=moveAboveNavigation(next,'route','v1','check');
 assert.deepEqual(moved.paths[0].visits![0].operationIds,['check','first','second']);assert.equal(navigationHint(moved,'route','v1','check'),undefined);
 assert.equal(writeChecks(source,graph,moved),writeChecks(source,graph,next));assert.equal(moveAboveNavigation(moved,'route','v1','check'),moved);
});

test('selector validation rejects empty whitespace but preserves meaningful surrounding spaces',()=>{
 for(const value of ['', '   ', '\t', '\n', ' \t\n '])assert.equal(isCommittableSelector(value),false,JSON.stringify(value));
 assert.equal(isCommittableSelector(' a '),true);assert.equal(isCommittableSelector('Gear'),true);
});
test('stepRowLabel formats every command with quoted values and optional destination',()=>{
 const cases:[CanvasTest,string][]=[
  [tap('Gear'),'tapOn "Gear"'],
  [{...check,check:{...check.check!,value:'Ready'}},'assertVisible "Ready"'],
  [{...check,check:{...check.check!,visibility:'absent',value:'Error'}},'assertNotVisible "Error"'],
  [{id:'input',label:'Input',role:'action',reference,input:' a "b" '},'inputText " a \\"b\\" "'],
  [{id:'back',label:'Back',role:'action',reference,back:true},'back "Back"'],
  [{id:'back',label:'Back',role:'action',reference,back:true,backSelector:{target:'id',match:'exact',value:'nav.back'}},'back "nav.back"']
 ];
 for(const [item,command] of cases){assert.equal(stepRowLabel(item,4),'4 '+command);assert.equal(stepRowLabel(item,4,'Settings'),'4 '+command+' → Settings');}
 assert.equal(stepRowLabel(tap(''),1),'1 tapOn ""');
});

test('drag reorder composes adjacent swaps on an immutable visit and preserves other visits and YAML',async()=>{
 const {reorderVisitStep}=await import('../src/inspector-operations.js');
 const original=appendVisitStep(appendVisitStep(graph,'route','v1',check),'route','v1',tap('local'));
 const snapshot=structuredClone(original);const originalYaml=writeChecks(source,graph,original);
 const moved=reorderVisitStep(original,'route','v1','first',3);
 assert.deepEqual(moved.paths[0].visits![0].operationIds,['second','check','local','first']);
 assert.deepEqual(moved.paths[0].visits![1],snapshot.paths[0].visits![1]);
 assert.deepEqual(original,snapshot);assert.equal(writeChecks(originalYaml,original,moved),originalYaml);
 assert.deepEqual(reorderVisitStep(moved,'route','v1','first',0).paths[0].visits![0].operationIds,['first','second','check','local']);
 assert.equal(reorderVisitStep(original,'route','v2','first',0),original);
 assert.equal(reorderVisitStep(original,'route','v1','first',0),original);
});
