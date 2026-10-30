import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceDescriptor,deriveFlow} from '../server/knowledge/index.js';
import type {Workspace} from '../server/scenarios.js';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';
import {referenceCatalog} from '../server/canvas.js';
import {writeChecks} from '../shared/canvas-authoring.js';

const yaml='appId: example.App\n---\n- tapOn: Continue\n- assertVisible: Directory\n- tapOn: Unrelated\n';
const refs=referenceCatalog(yaml).references;
const scenario:ScenarioDefinition={id:'directory',name:'Directory',steps:refs.slice(0,2),parameters:{USER:{type:'text',required:true}},inputs:{USER:'saved value'},enabledHandlerIds:[]};
const workspace:Workspace={id:'39c3f75b-7e5c-4999-9d94-ec7a36da36e8',name:'Workspace',yaml,scenarios:[scenario]};
const hash=(value:Workspace)=>sourceDescriptor(value,value.scenarios![0]).sourceHash;

test('source projection format has a stable canonical hash fixture',()=>{
 assert.equal(hash(workspace),'fd62a3be98d9c08ea340eaabadc4d826587c41a7e8d109f9d1063e698e4faf0d');
 const reversed={...workspace,scenarios:[{...scenario,parameters:{USER:{required:true,type:'text' as const}}}]};assert.equal(hash(reversed),hash(workspace));
});
for(const [name,change] of [
 ['selected command',(w:Workspace)=>{w.yaml=w.yaml.replace('Continue','Next');}],
 ['check',(w:Workspace)=>{w.yaml=w.yaml.replace('Directory','Other screen');}],
 ['parameter type',(w:Workspace)=>{w.scenarios![0].parameters.USER.type='number';}],
 ['setup',(w:Workspace)=>{w.scenarios![0].setup={file:'setup.yaml',parameters:{}};w.flows={'setup.yaml':'appId: example.App\n---\n- launchApp\n'};}],
 ['script content',(w:Workspace)=>{w.scenarios![0].scripts=[{id:'script',label:'Business helper',beforeStep:{index:0,fingerprint:refs[0].fingerprint},source:'console.log("opaque")'}];}],
 ['mock configuration',(w:Workspace)=>{w.mock={responseId:'response'} as Workspace['mock'];}],
] as const)test('source hash invalidates '+name,()=>{const changed=structuredClone(workspace);change(changed);assert.notEqual(hash(changed),hash(workspace));});
for(const [name,change] of [
 ['workspace/scenario titles',(w:Workspace)=>{w.name='Renamed';w.scenarios![0].name='Renamed scenario';}],
 ['metadata',(w:Workspace)=>{w.metadata={revision:15,createdAt:'now',updatedAt:'later',openedAt:'latest'};}],
 ['unrelated command',(w:Workspace)=>{w.yaml=w.yaml.replace('Unrelated','Changed unrelated');}],
 ['unrelated scenario',(w:Workspace)=>{w.scenarios!.push({...scenario,id:'unrelated',steps:[refs[2]]});}],
 ['unused reusable flow',(w:Workspace)=>{w.flows={'unused.yaml':'appId: example.App\n---\n- tapOn: Other\n'};}],
 ['saved input value',(w:Workspace)=>{w.scenarios![0].inputs.USER='changed secret';}],
] as const)test('source hash ignores '+name,()=>{const changed=structuredClone(workspace);change(changed);assert.equal(hash(changed),hash(workspace));});

test('referenced reusable flows are transitive while unused dependencies are ignored',()=>{
 const selected='appId: example.App\n---\n- runFlow: child.yaml\n';const w={...workspace,yaml:selected,scenarios:[{...scenario,steps:referenceCatalog(selected).references}],flows:{'child.yaml':'appId: example.App\n---\n- runFlow: nested.yaml\n','nested.yaml':'appId: example.App\n---\n- tapOn: Nested\n','unused.yaml':'appId: example.App\n---\n- tapOn: Unused\n'}};
 const before=hash(w);w.flows['nested.yaml']=w.flows['nested.yaml'].replace('Nested','Changed');assert.notEqual(hash(w),before);const after=hash(w);w.flows['unused.yaml']+='- launchApp\n';assert.equal(hash(w),after);
});

test('numbered node wording and repeated visits match the selected saved canvas; layout and labels do not invalidate intent',()=>{
 const w:Workspace={...workspace,yaml:'appId: example.App\n---\n- launchApp\n',scenarios:[{...scenario,authoring:'canvas',pathId:'route',steps:[]}],canvas:{screens:[{id:'home',title:'Home',x:10,y:20,tests:[{id:'tap',label:'Display label',role:'action',tap:{target:'text',match:'exact',value:'Continue'},reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'}}]}],edges:[{id:'loop',from:'home',to:'home',actionTestId:'tap',actionTestIds:['tap'],assertionTestId:'missing-check',responseCondition:'Home to home'}],paths:[{id:'route',name:'Loop',scenarioId:'directory',screenId:'home',edgeIds:['loop'],visits:[{id:'first',operationIds:['tap']},{id:'second',operationIds:['tap']}]}]}};
 w.yaml=writeChecks(w.yaml,{screens:[],edges:[],paths:[]},w.canvas!);
 const facts=deriveFlow(w,w.scenarios![0]);assert.deepEqual(facts.steps.map(step=>step.text),['1 · Tap text · Continue','2 · Tap text · Continue']);assert.deepEqual(facts.visits.map(visit=>visit.id),['first','second']);assert.equal(facts.diagnostics.length,0);
 const before=hash(w);w.canvas!.screens[0].x=500;w.canvas!.screens[0].title='Renamed node';w.canvas!.screens[0].tests[0].label='Different display label';w.canvas!.paths[0].name='Renamed route';w.canvas!.edges[0].responseCondition='New display title';assert.equal(hash(w),before);
 const changed=structuredClone(w);changed.canvas!.screens[0].tests[0].tap!.value='Next';assert.notEqual(hash(changed),before);
});

test('broken canvas references are described explicitly and scripts remain opaque',()=>{
 const w=structuredClone(workspace);w.scenarios![0].authoring='canvas';w.scenarios![0].pathId='missing';w.scenarios![0].scripts=[{id:'script',label:'Accepted label',source:'SECRET SOURCE',beforeStep:{index:0,fingerprint:refs[0].fingerprint}}];w.canvas={screens:[],edges:[],paths:[]};
 const facts=deriveFlow(w,w.scenarios![0]);assert.match(facts.diagnostics.join(' '),/unavailable/);assert.match(facts.steps[0].text,/Opaque script/);assert.doesNotMatch(JSON.stringify(facts),/SECRET SOURCE/);
});
