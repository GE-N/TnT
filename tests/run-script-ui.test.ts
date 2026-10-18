import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement,useState} from 'react';
import {inspectCanvas,type CanvasGraph} from '../server/canvas.js';
import {parsePackage} from '../server/workspace-package.js';
import type {ScriptExecutionReference,ScriptStepResult,ScriptTrust} from '../server/run-script-contract.js';
import {approveScriptTrust} from '../src/run-script-client.js';
import {importFilenameClaim} from '../src/workspace-transfer.js';
import {anchorForNewScript,anchorMatches,anchorTargetsDraft,batchReasonLabel,batchSummary,batchWithScriptBlocks,blockDisplayMessage,blocksFor,DRAFT_STEP_TEXT,endAnchorFingerprint,evidenceScrubFailed,importedNeedsTrust,moveScript,newScriptId,orderedScenarioSteps,readScriptRun,reservedPlacements,runHitCap,scenariosForSave,scenarioShowsMockVariables,scriptBlock,scriptFirstLine,scriptFollowsFailure,scriptRowView,scriptSourceLine,sha256,stableScriptOrder,stepNotRun,trustFor,untrustedCount,SCRIPT_EXAMPLE,SCRIPT_TIMEOUT,SCRUB_FAILED_TEXT,TRUST_LOAD_TEXT,type OrderedStep,type ScriptRecord} from '../src/run-script.js';
import type {RunScriptModel} from '../src/run-script-ui.js';

const fingerprint='ab'.repeat(32);
const other='cd'.repeat(32);

function step(globalIndex:number,value=fingerprint,visitIndex=0):OrderedStep{
  return {id:'step-'+globalIndex,visitId:'v'+(visitIndex+1),visitIndex,globalIndex,fingerprint:value};
}

function row(id:string,index:number,value:string,extra:Partial<ScriptRecord>={}):ScriptRecord{
  const source=extra.source??'1+1';
  return {id,scenarioId:extra.scenarioId??'main',origin:extra.origin??'local',label:extra.label??'Run script',source,hash:sha256(source),beforeStep:{index,fingerprint:value}};
}

test('sha256 matches Node and the published vectors',()=>{
  for(const message of ['','abc','สวัสดี','`template ${1}`'])assert.equal(sha256(message),createHash('sha256').update(message).digest('hex'));
  assert.equal(sha256(''),'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('anchors copy the step fingerprint checkpoints already store',()=>{
  const steps=[step(0,fingerprint,1)];
  assert.deepEqual(anchorForNewScript(steps,0),{index:0,fingerprint});
  assert.equal(anchorForNewScript([step(0),step(1,other)],0).fingerprint,endAnchorFingerprint(other));
  assert.deepEqual(anchorForNewScript([],0),{index:0,fingerprint:'end'});
});

test('a last-placed script runs after the final step and goes stale when that step changes',()=>{
  const steps=[step(0,fingerprint),step(1,other)];
  const end=anchorForNewScript(steps,0);
  assert.deepEqual(end,{index:2,fingerprint:other+':end'});
  assert.equal(anchorMatches(end,steps),true);
  const placed=row('tail',end.index,end.fingerprint);
  assert.equal(scriptBlock(placed,steps,[{rowId:'tail',origin:'local',trusted:true,hash:placed.hash}]),undefined);
  assert.equal(stepNotRun(steps[0],[placed],[{kind:'runScript',rowId:'tail',status:'passed'}]),false);
  assert.equal(stepNotRun(steps[1],[placed],[{kind:'runScript',rowId:'tail',status:'script-error'}]),false);
  const added=[...steps,step(2,'ef'.repeat(32))];
  assert.equal(anchorMatches(end,added),false);
  assert.equal(scriptBlock(placed,added,[])?.message,'Step changed · relink before running');
  const changed=[step(0,fingerprint),step(1,'11'.repeat(32))];
  assert.equal(anchorMatches(end,changed),false);
  assert.equal(scriptBlock(row('empty-end',0,'end',{source:''}),[step(0)],[])?.kind,'empty');
  assert.equal(anchorMatches({index:0,fingerprint:'end'},[]),true);
  assert.equal(anchorMatches({index:0,fingerprint:'end'},[step(0)]),false);
});

test('block priority is empty, then stale, then syntax, then trust',()=>{
  const steps=[step(0)];
  const approvals:never[]=[];
  assert.equal(scriptBlock(row('e',0,fingerprint,{source:'  '}),steps,approvals)?.kind,'empty');
  assert.equal(scriptBlock(row('s',0,'stale',{source:'function ('}),steps,approvals)?.kind,'stale-anchor');
  assert.equal(scriptBlock(row('y',0,fingerprint,{source:'function (',origin:'imported'}),steps,approvals)?.kind,'syntax');
  const imported=row('u',0,fingerprint);
  assert.equal(scriptBlock(imported,steps,[{rowId:'u',origin:'imported',trusted:false,hash:imported.hash}])?.message,'Script needs trust');
  assert.equal(scriptBlock(row('pending',0,fingerprint),steps,approvals),undefined);
  const trusted=row('ok',0,fingerprint);
  assert.equal(scriptBlock(trusted,steps,[{rowId:'ok',origin:'local',trusted:true,hash:trusted.hash}]),undefined);
  assert.match(scriptBlock(row('y',0,fingerprint,{source:'function ('}),steps,approvals)?.message??'',/^Script error: /);
});

test('array order is the saved order and moving one script leaves the others anchored',()=>{
  const first=row('first',1,other);
  const early=row('early',0,fingerprint);
  const second=row('second',1,other);
  const rows=[first,early,second];
  assert.deepEqual(stableScriptOrder(rows).map(item=>item.id),['early','first','second']);
  const swapped=moveScript(rows,'first',1,2,index=>index===2?other+':end':index===0?fingerprint:other)!;
  assert.deepEqual(swapped.map(item=>item.id),['second','early','first']);
  assert.deepEqual(swapped.find(item=>item.id==='early')!.beforeStep,early.beforeStep);
  assert.deepEqual(swapped.find(item=>item.id==='second')!.beforeStep,second.beforeStep);
  const retargeted=moveScript(rows,'second',1,2,index=>index===2?other+':end':other)!;
  assert.deepEqual(retargeted.find(item=>item.id==='second')!.beforeStep,{index:2,fingerprint:other+':end'});
  assert.deepEqual(retargeted.find(item=>item.id==='first')!.beforeStep,first.beforeStep);
  assert.deepEqual(stableScriptOrder(rows),stableScriptOrder([...rows]),'sorting does not rewrite the stored array');
});

test('scriptSteps and executionOrder decide status without copying step data',()=>{
  const run={scriptSteps:{a:{kind:'runScript',rowId:'a',status:'script-error',message:'ไทย failed'}},executionOrder:[{kind:'step',index:0},{kind:'runScript',rowId:'a'},{kind:'step',index:1},{kind:'runScript',rowId:'b'}] satisfies ScriptExecutionReference[]};
  const read=readScriptRun(run);
  assert.equal(read.scriptSteps.a.message,'ไทย failed');
  assert.equal(read.executionOrder[2].kind,'step');
  const steps=[step(0),step(1)];
  const rows=[row('a',0,fingerprint),row('b',1,other)];
  const results:ScriptStepResult[]=Object.values(read.scriptSteps);
  assert.equal(stepNotRun(steps[0],rows,results,read.executionOrder),false);
  assert.equal(stepNotRun(steps[1],rows,results,read.executionOrder),true);
  assert.equal(scriptFollowsFailure('b',rows,results,read.executionOrder),true);
  assert.equal(scriptRowView(rows[0],rows,steps,[],results,false,false,read.executionOrder).message,'ไทย failed');
  assert.equal(scriptRowView(rows[1],rows,steps,[],results,false,false,read.executionOrder).tone,'not-run');
  assert.deepEqual(readScriptRun({snapshot:run}).scriptSteps.a.rowId,'a');
});

test('Run All shows Script failed apart from Script needs trust',()=>{
  const lines=batchWithScriptBlocks(['blocked','ran'],[{scenarioId:'ran',name:'Ran',status:'script-error',reason:'Script failed'}],new Map([['blocked',{kind:'untrusted',rowId:'row',message:'Script needs trust'}]]),new Map([['blocked','Blocked'],['ran','Ran']]));
  const summaries=lines.map(batchSummary);
  assert.deepEqual(summaries,[
    {statusText:'failed',reason:'Script needs trust',testId:'batch-script-untrusted',tone:'trust'},
    {statusText:'failed',reason:'Script failed',testId:'batch-script-failed',tone:'failed'},
  ]);
  assert.deepEqual(summaries.map(batchReasonLabel),['⚠ Script needs trust','✕ Script failed']);
});

test('setup and default-action rows are not script anchors',()=>{
  const setupFingerprint='aa'.repeat(32);
  const handlerFingerprint='bb'.repeat(32);
  const mixed:CanvasGraph={
    screens:[{id:'home',title:'Home',x:0,y:0,tests:[
      {id:'boot',label:'Setup',role:'setup',reference:{kind:'setup',file:'setup.yaml',fingerprint:setupFingerprint}},
      {id:'recover',label:'Recover',role:'handler',reference:{kind:'handler',file:'recover.yaml',fingerprint:handlerFingerprint,actionId:'recover',index:0}},
      {id:'ready',label:'Home',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint}},
    ]}],
    edges:[],
    paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:[],visits:[{id:'v1',operationIds:['boot','recover','ready']}]}],
  };
  const steps=orderedScenarioSteps(mixed,'route');
  assert.deepEqual(steps.map(item=>item.id),['ready']);
  assert.equal(steps[0].globalIndex,0);
  const anchor=anchorForNewScript(steps,0);
  assert.equal(anchor.fingerprint,fingerprint+':end');
  assert.notEqual(anchor.fingerprint,setupFingerprint);
  assert.notEqual(anchor.fingerprint,handlerFingerprint);
});

test('a trust approval for a different source hash does not trust the row',()=>{
  const current=row('paid',0,fingerprint,{source:'1+1'});
  assert.equal(trustFor(current,[{rowId:'paid',origin:'local',trusted:true,hash:sha256('other')}]).trusted,false);
  assert.equal(trustFor(current,[{rowId:'paid',origin:'local',trusted:true,hash:current.hash}]).trusted,true);
});

test('a passed run does not mark a script row passed when that row has no result',()=>{
  const current=row('tail',1,fingerprint+':end',{source:'1+1'});
  const view=scriptRowView(current,[current],[step(0)],[{rowId:'tail',origin:'local',trusted:true,hash:current.hash}],[],false,true);
  assert.equal(view.tone,'not-run');
});

test('an unsafe import filename is recorded as null',()=>{
  assert.equal(importFilenameClaim('shop-v3.tnt'),'shop-v3.tnt');
  assert.equal(importFilenameClaim('shop\u202E.tnt'),null);
  assert.equal(importFilenameClaim('shop\n.tnt'),null);
  assert.equal(importFilenameClaim('shop\u200B.tnt'),null);
  assert.equal(importFilenameClaim('a\uFEFFb.tnt'),null);
  assert.equal(importFilenameClaim('shop\u200C.tnt'),null);
  assert.equal(importFilenameClaim('shop\u061C.tnt'),null);
  assert.equal(importFilenameClaim('shop\u2028.tnt'),null);
  assert.equal(importFilenameClaim('shop\u2029.tnt'),null);
  assert.equal(importFilenameClaim('shop\u200D.tnt'),'shop\u200D.tnt');
  assert.equal(importFilenameClaim('../shop.tnt'),null);
  assert.equal(importFilenameClaim(undefined),null);
  const server=readFileSync(new URL('../server/workspace-store.ts',import.meta.url),'utf8').match(/const claimControls=(\/.*\/);/)?.[1];
  const client=readFileSync(new URL('../src/workspace-transfer.tsx',import.meta.url),'utf8').match(/const claimControls=(\/.*\/);/)?.[1];
  assert.equal(client,server);
});

test('import and copy source lines stay plain',()=>{
  assert.equal(scriptSourceLine({kind:'import',name:'Payments',filename:'x.tnt'}),'Imported from file x.tnt (named “Payments”)');
  assert.equal(scriptSourceLine({kind:'import',name:'Payments',filename:null}),'Imported from a file named “Payments”');
  assert.equal(scriptSourceLine({kind:'copy',name:'Payments'}),'Copied from “Payments”');
  assert.equal(scriptSourceLine(undefined),'Imported from an imported workspace.');
  assert.doesNotMatch(scriptSourceLine({kind:'import',name:'Payments',filename:'x.tnt'}),/verified|`|\.$/i);
});

test('a draft step is not an anchor and an existing row uses the usual block line',()=>{
  const drafted=step(0,'draft');
  const current=row('paid',0,fingerprint,{source:'1+1'});
  assert.equal(anchorTargetsDraft(anchorForNewScript([drafted],0),[drafted]),true);
  assert.equal(anchorTargetsDraft({index:1,fingerprint:'draft:end'},[drafted]),true);
  assert.equal(anchorTargetsDraft(anchorForNewScript([step(0)],0),[step(0)]),false);
  const view=scriptRowView(current,[current],[drafted],[{rowId:'paid',origin:'local',trusted:true,hash:current.hash}],[],false,false);
  assert.equal(view.block?.kind,'draft-anchor');
  assert.equal(view.block?.message,DRAFT_STEP_TEXT);
  assert.equal(view.blockText,DRAFT_STEP_TEXT);
  const reason=scriptBlock(current,[drafted],[])!;
  assert.equal(reason.kind,'draft-anchor');
  assert.equal(reason.message,DRAFT_STEP_TEXT);
  assert.equal(blockDisplayMessage(reason),DRAFT_STEP_TEXT);
  const lines=batchWithScriptBlocks(['main'],[],new Map([['main',{kind:reason.kind,message:blockDisplayMessage(reason)}]]),new Map([['main','Main']]));
  assert.equal(lines[0].reason,DRAFT_STEP_TEXT);
  assert.equal(batchReasonLabel(batchSummary(lines[0])),'✕ '+DRAFT_STEP_TEXT);
  assert.notEqual(lines[0].reason,'Step changed · relink before running');
});

test('a blank script is left out of the save payload',()=>{
  const kept={id:'paid',scripts:[{source:'1+1'},{source:'  '},{source:''}]};
  const empty={id:'empty',scripts:[{source:''}]};
  const plainList=[{id:'plain'}];
  const saved=scenariosForSave([kept,empty]);
  assert.deepEqual(saved[0].scripts,[{source:'1+1'}]);
  assert.deepEqual(saved[1].scripts,[]);
  assert.equal(scenariosForSave(plainList),plainList);
  const cleared={id:'paid',scripts:[{id:'script-paid',source:''}]};
  const keptRows=[cleared];
  assert.equal(scenariosForSave(keptRows,new Set(['script-paid'])),keptRows);
});

test('an unsaved local script is pending and only a server import counts as untrusted',()=>{
  const pending=row('new',0,fingerprint,{source:'1+1'});
  const saved=row('old',0,fingerprint,{source:'1+1'});
  const approvals:ScriptTrust[]=[{rowId:'old',origin:'imported',trusted:false,hash:saved.hash}];
  assert.equal(importedNeedsTrust(pending,[]),false);
  assert.equal(importedNeedsTrust(saved,approvals),true);
  assert.equal(untrustedCount([pending,saved],approvals),1);
  assert.equal(scriptBlock(pending,[step(0)],[]),undefined);
  assert.equal(scriptBlock(saved,[step(0)],approvals)?.kind,'untrusted');
});

test('execution order keeps system commands without counting them as steps',()=>{
  const run=readScriptRun({executionOrder:[{kind:'system'},{kind:'step',index:0},{kind:'runScript',rowId:'paid'}],scriptSteps:{}});
  assert.deepEqual(run.executionOrder,[{kind:'system'},{kind:'step',index:0},{kind:'runScript',rowId:'paid'}]);
});

test('mock variables follow a chosen response or a trusted script',()=>{
  const trusted=row('paid',0,fingerprint);
  const approvals:ScriptTrust[]=[{rowId:'paid',origin:'local',trusted:true,hash:trusted.hash}];
  assert.equal(scenarioShowsMockVariables(false,'response',[trusted],approvals),false);
  assert.equal(scenarioShowsMockVariables(true,undefined,[row('open',0,fingerprint)],[]),false);
  assert.equal(scenarioShowsMockVariables(true,'response',[row('open',0,fingerprint)],[]),true);
  assert.equal(scenarioShowsMockVariables(true,undefined,[trusted],approvals),true);
});

test('reserved names, scrub, cap, and the redacted chip styles',()=>{
  const placements=reservedPlacements({yaml:'- tapOn: ${TNT_MOCK_URL}\n',flows:'',scenarios:[{inputs:{TNT_MOCK_TOKEN:'x'}}],runtimeText:'{"TNT_MOCK_URL":"secret"}'});
  assert.equal(placements.find(item=>item.target==='yaml')?.reason.message,'Reserved TnT variable');
  assert.equal(placements.find(item=>item.target==='scenario-input')?.reason.kind,'reserved-input');
  assert.equal(placements.find(item=>item.target==='runtime')?.reason.kind,'reserved-input');
  assert.equal(evidenceScrubFailed({error:'Evidence scrub failed'}),true);
  assert.equal(evidenceScrubFailed({mappingNote:'Evidence scrub failed · closed'}),true);
  assert.equal(evidenceScrubFailed({error:'something else',mappingNote:undefined}),false);
  assert.equal(runHitCap({status:'failed',log:'stopped at the 300s cap'}),true);
  assert.equal(runHitCap({status:'running',error:'300s cap'}),false);
  assert.equal(scriptFirstLine(SCRIPT_EXAMPLE),'// Switch POST /pay to ...');
  const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
  assert.match(css,/\.redacted-chip\{[^}]*color:#5f6368/);
  assert.match(css,/\.redacted-chip\{[^}]*font-size:12px/);
  assert.match(css,/\.batch-script-untrusted\{color:#8a4b00/);
  assert.match(css,/\.batch-script-failed\{color:#b3261e/);
  assert.match(css,/\.script-preview\{[^}]*white-space:nowrap/);
  assert.match(css,/\.script-provided \.script-muted\{font-weight:400/);
  assert.match(css,/\.floating-inspector\{[^}]*z-index:42/);
  assert.match(css,/\.script-editor\{[^}]*z-index:41/);
  assert.match(css,/#b3261e/);
});

const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint};
const narrowInspector=parsePackage(JSON.parse(readFileSync(new URL('./fixtures/narrow-inspector-workspace.json',import.meta.url),'utf8')));
const narrowCanvas=narrowInspector.workspace.canvas!;
const narrowFingerprint=narrowCanvas.screens[0].tests[0].reference.fingerprint;
const graph:CanvasGraph={
  screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'ready',label:'Home',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Home'}}]}],
  edges:[],
  paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:[],visits:[{id:'v1',operationIds:['ready']}]}],
};

async function mount(seed:ScriptRecord[]=[],granted:ScriptTrust[]=[]){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
  const window=dom.window;
  const previous=new Map<string,PropertyDescriptor|undefined>();
  class ResizeObserver{observe(){}disconnect(){}}
  for(const key of ['window','document','HTMLElement','HTMLTextAreaElement','Event','KeyboardEvent','MutationObserver','ResizeObserver','IS_REACT_ACT_ENVIRONMENT']){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(window,key),configurable:true});
  }
  const fetchImpl=globalThis.fetch;
  globalThis.fetch=async()=>new Response('{}',{status:404});
  const {createRoot}=await import('react-dom/client');
  const {CanvasEditor}=await import('../src/canvas.js');
  const {RedactedText}=await import('../src/run-script-ui.js');
  const {YamlEditor}=await import('../src/yaml-editor.js');
  let replaceGraph:(next:CanvasGraph)=>void=()=>{};
  let updateExtra:(patch:Partial<{running:boolean;passedRun:boolean;revealBlocks:boolean;scrubFailed:boolean;failedAtScript:boolean;timedOut:boolean;hasMock:boolean;trustLoadFailed:boolean;results:ScriptStepResult[];executionOrder:ScriptExecutionReference[]}>)=>void=()=>{};
  const initial={running:false,passedRun:false,revealBlocks:false,scrubFailed:false,failedAtScript:false,timedOut:false,hasMock:false,trustLoadFailed:false,results:[] as ScriptStepResult[],executionOrder:[] as ScriptExecutionReference[]};
  let retries=0;
  let latest:ScriptRecord[]=seed;
  function Host(){
    const [current,setGraph]=useState(graph);
    const [rows,setRows]=useState(seed);
    const [trust,setTrust]=useState(granted);
    const [extra,setExtra]=useState(initial);
    replaceGraph=setGraph;updateExtra=patch=>setExtra(value=>({...value,...patch}));latest=rows;
    const runScripts:RunScriptModel={scenarioId:'main',rows,trust,results:extra.results,executionOrder:extra.executionOrder,hasMock:extra.hasMock,revealBlocks:extra.revealBlocks,running:extra.running,passedRun:extra.passedRun,timedOut:extra.timedOut,scrubFailed:extra.scrubFailed,failedAtScript:extra.failedAtScript,trustBlockCount:untrustedCount(rows,trust),trustLoadFailed:extra.trustLoadFailed,sourceWorkspace:{kind:'copy',name:'Imported workspace'},onStop:()=>{},onRetryTrust:()=>{retries+=1;},onAdd:anchor=>{const id=newScriptId();const source='';setRows(value=>[...value,{id,scenarioId:'main',origin:'imported',beforeStep:anchor,label:'Run script',source,hash:sha256(source)}]);return id;},onUpdate:(rowId,patch)=>setRows(value=>value.map(item=>item.id===rowId?{...item,...patch,hash:sha256(patch.source??item.source)}:item)),onMove:(rowId,direction,stepCount,fingerprintAt)=>setRows(value=>moveScript(value,rowId,direction,stepCount,fingerprintAt)??value),onDelete:rowId=>setRows(value=>value.filter(item=>item.id!==rowId)),onReplace:next=>setRows(next.map(item=>({...item,scenarioId:'main',origin:'imported' as const,hash:sha256(item.source)}))),onTrust:async rowId=>{const item=rows.find(entry=>entry.id===rowId);if(!item)return;const saved=await approveScriptTrust({workspace:'workspace',rowId,hash:item.hash,token:'token'});setTrust(value=>[...value.filter(entry=>entry.rowId!==saved.rowId),saved]);}};
    return createElement('div',null,
      createElement(CanvasEditor,{graph:current,onChange:(next:CanvasGraph|undefined)=>{if(next)setGraph(next);},yaml:'appId: app\n---\n- assertVisible: Home\n',onYamlChange:()=>{},catalog:[],diagnostics:[],pathId:'route',onPathChange:()=>{},disabled:false,scenarioMode:true,scenarioId:'main',scenarios:[{id:'main',name:'Main',pathId:'route'}],initialView:{selectedScreenId:'home',selectedVisitId:'v1'},runScripts}),
      createElement(RedactedText,{text:'token [redacted] hidden'}),
      createElement(YamlEditor,{yaml:'- tapOn: ${TNT_MOCK_TOKEN}\n',onChange:()=>{},disabled:false,reservedLines:[1]}),
    );
  }
  const root=createRoot(window.document.getElementById('root')!);
  await act(async()=>root.render(createElement(Host)));
  return {window,document:window.document,replaceGraph,updateExtra,rows:()=>latest,retries:()=>retries,async close(){await act(async()=>root.unmount());globalThis.fetch=fetchImpl;for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];}}};
}

async function click(document:Document,selector:string){
  const node=document.querySelector<HTMLElement>(selector);
  assert.ok(node,selector);
  await act(async()=>node.click());
}

test('the script menu, editor, end anchor, trust panel, and run states render inline',async()=>{
  const page=await mount();
  try{
    await click(page.document,'.add-visit-step');
    const option=page.document.querySelector('[data-testid="add-run-script"]')!;
    assert.equal(option.getAttribute('aria-label'),'Run script');
    assert.match(option.textContent!,/JavaScript between steps/);
    assert.equal(page.document.querySelector('.add-step-new')!.textContent,'New');
    await act(async()=>(option as HTMLElement).click());
    const editor=page.document.querySelector('.script-editor')!;
    assert.equal(editor.getAttribute('role'),null);
    assert.equal(page.document.querySelector('[role="dialog"]'),null);
    assert.doesNotMatch(page.document.body.textContent!,/Trust all/);
    assert.match(editor.textContent!,/after the last step/);
    assert.equal(page.document.querySelector('[data-testid="script-timeout"]')!.textContent,SCRIPT_TIMEOUT);
    assert.match(page.document.querySelector('[data-testid="script-no-mock"]')!.textContent!,/No mock in this scenario · TNT_MOCK_URL and TNT_MOCK_TOKEN aren't set/);
    await act(async()=>page.updateExtra({hasMock:true}));
    assert.equal(page.document.querySelector('[data-testid="script-no-mock"]'),null);
    assert.match(page.document.body.textContent!,/TNT_MOCK_URL/);
    await click(page.document,'.script-code-label .text-button');
    const source=page.document.querySelector<HTMLTextAreaElement>('[aria-label="Script source"]')!;
    assert.match(source.value,/if \(!res\.ok\)/);
    assert.match(page.document.querySelector('.script-preview')!.textContent!,/\/\/ Switch POST \/pay to \.\.\./);
    const stored=page.rows()[0];
    assert.equal(stored.beforeStep.fingerprint,fingerprint+':end');
    assert.equal(page.document.querySelector('[data-testid="script-blocks-run"]'),null);
    assert.equal(page.document.querySelector('[data-testid="run-blocked"]'),null);
    await act(async()=>page.updateExtra({passedRun:true,results:[{kind:'runScript',rowId:stored.id,status:'passed',durationMs:300} as ScriptStepResult],executionOrder:[{kind:'step',index:0},{kind:'runScript',rowId:stored.id}]}));
    assert.match(page.document.body.textContent!,/✓ Passed/);
    assert.match(page.document.body.textContent!,/Ran after the last step · took 0\.3s/);
    assert.equal(page.document.querySelector('[data-testid="script-not-run"]'),null);
    await act(async()=>page.replaceGraph({...graph,screens:[{...graph.screens[0],tests:[...graph.screens[0].tests,{id:'next',label:'Next',role:'assertion',reference:{...reference,fingerprint:other},check:{visibility:'visible',target:'text',match:'exact',value:'Next'}}]}],paths:[{...graph.paths[0],visits:[{id:'v1',operationIds:['ready','next']}]}]}));
    assert.equal(page.rows()[0].beforeStep.fingerprint,fingerprint+':end');
    assert.match(page.document.body.textContent!,/Step changed · relink before running/);
    assert.equal(page.document.querySelector('[data-block-kind="stale-anchor"]')!.getAttribute('data-testid'),'script-blocks-run');
    await act(async()=>page.updateExtra({scrubFailed:true,failedAtScript:false,passedRun:false,results:[]}));
    assert.equal(page.document.querySelector('[data-testid="evidence-scrub-failed"]')!.textContent,SCRUB_FAILED_TEXT);
    assert.equal(page.document.querySelector('[data-testid="redacted-chip"]')!.textContent,'[redacted]');
    assert.match(page.document.querySelector('[data-testid="reserved-variable-error"]')!.textContent!,/Reserved TnT variable · line 1/);
  }finally{await page.close();}
});

test('imported scripts are trusted one at a time and a failure stops later steps',async()=>{
  const first=row('one',0,fingerprint,{label:'First',source:'console.log(1)',origin:'imported'});
  const second=row('two',0,fingerprint,{label:'Second',source:'console.log(2)',origin:'imported'});
  const page=await mount([first,second],[first,second].map(item=>({rowId:item.id,origin:'imported' as const,trusted:false,hash:item.hash})));
  let attempts=0;
  globalThis.fetch=async()=>{
    attempts+=1;
    if(attempts===1)return new Response(JSON.stringify({error:'Unknown script row'}),{status:400});
    return new Response(JSON.stringify({trust:{rowId:'one',origin:'imported',trusted:true,hash:first.hash}}),{status:200});
  };
  try{
    assert.equal(page.document.querySelectorAll('[data-testid="script-not-trusted"]').length,2);
    assert.match(page.document.querySelector('[data-testid="run-blocked"]')!.textContent!,/2 imported scripts need Trust/);
    assert.match(page.document.querySelector('.sequence-trust')!.textContent!,/▶ Run/);
    await click(page.document,'[data-script-id="one"] .script-row-summary');
    const editor=page.document.querySelector('.script-editor')!;
    assert.equal(editor.getAttribute('role'),null);
    assert.equal(page.document.querySelector('[data-testid="script-source"]')!.textContent,'console.log(1)');
    assert.match(editor.textContent!,/Copied from “Imported workspace”/);
    assert.equal(editor.querySelector('bdi')?.textContent,'Imported workspace');
    assert.match(editor.textContent!,/1 of 2 left after this/);
    assert.doesNotMatch(editor.textContent!,/Trust all/);
    await act(async()=>{page.document.querySelector<HTMLButtonElement>('[data-testid="trust-this-script"]')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(page.document.querySelectorAll('[data-testid="script-not-trusted"]').length,2);
    await act(async()=>{page.document.querySelector<HTMLButtonElement>('[data-testid="trust-this-script"]')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(page.document.querySelectorAll('[data-testid="script-not-trusted"]').length,1);
    assert.match(page.document.querySelector('[data-script-id="two"]')!.textContent!,/Not trusted on this Mac/);
    await act(async()=>page.updateExtra({revealBlocks:true,results:[{kind:'runScript',rowId:'one',status:'script-error',message:'switch failed'}],executionOrder:[{kind:'runScript',rowId:'one'},{kind:'step',index:0},{kind:'runScript',rowId:'two'}],failedAtScript:true}));
    assert.match(page.document.querySelector('[data-testid="script-error-reason"]')!.textContent!,/switch failed/);
    assert.equal(page.document.querySelector('[data-testid="script-not-run"]')!.textContent,'○ Not run');
    assert.match(page.document.querySelector('[data-testid="failed-at-script"]')!.textContent!,/Failed at Run script/);
    assert.equal(blocksFor(page.rows(),[step(0)],[{rowId:'one',origin:'imported',trusted:true,hash:first.hash},{rowId:'two',origin:'imported',trusted:false,hash:second.hash}]).some(item=>item.kind==='untrusted'),true);
  }finally{await page.close();}
});

test('Run script is omitted before a draft step and an existing row shows the capture error',async()=>{
  const anchored=row('paid',0,fingerprint,{source:'1+1'});
  const page=await mount([anchored]);
  try{
    const draftReference={...reference,fingerprint:'draft'};
    await act(async()=>page.replaceGraph({...graph,screens:[{...graph.screens[0],tests:[{...graph.screens[0].tests[0],reference:draftReference}]}],paths:[{...graph.paths[0],visits:[{id:'v1',operationIds:['ready']}]}]}));
    await click(page.document,'.add-visit-step');
    assert.equal(page.document.querySelector('[data-testid="add-run-script"]'),null);
    const error=page.document.querySelector('[data-script-id="paid"] .script-inline-error')!;
    assert.equal(page.document.querySelector('[data-script-id="paid"]')!.getAttribute('data-block-kind'),'draft-anchor');
    assert.equal(error.textContent,'✕ '+DRAFT_STEP_TEXT);
    assert.equal(error.className,'script-inline-error');
  }finally{await page.close();}
});

test('Escape removes a blank script and delete leaves an inline undo',async()=>{
  const page=await mount();
  try{
    await click(page.document,'.add-visit-step');
    await click(page.document,'[data-testid="add-run-script"]');
    assert.equal(page.rows().length,1);
    const focused=page.document.activeElement;
    assert.equal(focused?.getAttribute('aria-label'),'Script name');
    await act(async()=>focused!.dispatchEvent(new page.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    assert.equal(page.rows().length,0);
    assert.ok(page.document.querySelector('.floating-inspector'));
    assert.equal(page.document.querySelector('.script-undo'),null);
    await click(page.document,'.add-visit-step');
    await click(page.document,'[data-testid="add-run-script"]');
    await click(page.document,'[aria-label="Delete Run script"]');
    const undo=page.document.querySelector('.script-undo')!;
    assert.match(undo.textContent!,/Run script deleted/);
    assert.equal(page.rows().length,0);
    await click(page.document,'.script-undo button');
    assert.equal(page.rows().length,1);
    assert.equal(page.document.querySelector('.script-undo'),null);
  }finally{await page.close();}
});

test('delete undo replaces the row and move undo sits on the moved row',async()=>{
  const page=await mount([
    row('before',0,fingerprint,{source:'1',label:'Before'}),
    row('after',1,endAnchorFingerprint(fingerprint),{source:'2',label:'After'}),
  ]);
  try{
    await click(page.document,'[aria-label="Delete Before"]');
    const undo=page.document.querySelector('.script-undo')!;
    const step=page.document.querySelector('[data-operation-id="ready"]')!;
    assert.match(undo.textContent!,/Run script deleted/);
    assert.ok(undo.compareDocumentPosition(step)&page.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(undo.compareDocumentPosition(page.document.querySelector('[data-script-id="after"]')!)&page.window.Node.DOCUMENT_POSITION_FOLLOWING);
    await click(page.document,'.script-undo button');
    await click(page.document,'[aria-label="Move Before down"]');
    const moved=page.document.querySelector('[data-script-id="before"]')!;
    assert.equal(moved.nextElementSibling?.className,'script-undo');
    assert.match(moved.nextElementSibling!.textContent!,/Run script moved/);
  }finally{await page.close();}
});

test('a failed trust load keeps rows read-only and offers Retry',async()=>{
  const page=await mount([row('paid',0,fingerprint,{source:'1+1'})]);
  try{
    await act(async()=>page.updateExtra({trustLoadFailed:true}));
    const warning=page.document.querySelector('[data-testid="trust-load-failed"]')!;
    assert.equal(warning.textContent,TRUST_LOAD_TEXT+' · ↻ Retry');
    assert.equal(warning.className,'trust-load-warning');
    const retry=page.document.querySelector<HTMLButtonElement>('[data-testid="trust-load-retry"]')!;
    assert.equal(retry.textContent,'↻ Retry');
    assert.equal(retry.className,'trust-load-retry');
    assert.match(readFileSync(new URL('../src/style.css',import.meta.url),'utf8'),/\.trust-load-warning\{[^}]*background:#fff4e5;color:#8a4b00/);
    assert.match(readFileSync(new URL('../src/style.css',import.meta.url),'utf8'),/\.trust-load-retry\{[^}]*min-height:44px/);
    assert.equal(page.document.querySelector('[data-testid="trust-unknown"]')!.textContent,'⚠ Trust unknown');
    assert.equal(page.document.querySelector('[data-testid="script-not-trusted"]'),null);
    assert.equal(page.document.querySelector('[role="alertdialog"]'),null);
    await click(page.document,'[data-script-id="paid"] .script-row-summary');
    assert.equal(page.document.querySelector('[data-testid="script-source"]')!.textContent,'1+1');
    assert.equal(page.document.querySelector('[aria-label="Script source"]'),null);
    assert.equal(page.document.querySelector('.script-readonly-badge')?.textContent,'Read only · trust unknown');
    assert.equal(page.document.querySelector('[data-testid="trust-this-script"]'),null);
    await click(page.document,'[data-testid="trust-load-retry"]');
    assert.equal(page.retries(),1);
  }finally{await page.close();}
});

/** jsdom does not lay out. Report the fixture node's own left/top, the 250px node width, and the canvas zoom. */
async function showNarrowFixture(page:Awaited<ReturnType<typeof mount>>){
  page.document.getElementById('root')!.classList.add('workbench');
  const proto=page.window.HTMLElement.prototype;
  const original=proto.getBoundingClientRect;
  const box=(left:number,top:number,width:number,height:number)=>({x:left,y:top,left,top,width,height,right:left+width,bottom:top+height,toJSON(){return {};}});
  proto.getBoundingClientRect=function(this:HTMLElement){
    const el=this;
    if(el.classList.contains('screen-node')){
      const zoom=Number(/scale\(([^)]+)\)/.exec(el.closest('.canvas-surface')?.getAttribute('style')??'')?.[1]??1);
      return box(parseFloat(el.style.left)*zoom,parseFloat(el.style.top)*zoom,250*zoom,180*zoom) as DOMRect;
    }
    if(el.classList.contains('floating-inspector')||el.classList.contains('script-editor')){
      const left=parseFloat(el.style.left);const top=parseFloat(el.style.top);
      if(!Number.isFinite(left)||!Number.isFinite(top))return box(0,0,0,0) as DOMRect;
      const width=el.classList.contains('script-editor')?parseFloat(el.style.width||'360'):300;
      const height=el.classList.contains('script-editor')?parseFloat(el.style.maxHeight||'400'):parseFloat(el.style.maxHeight||'400');
      return box(left,top,width,height) as DOMRect;
    }
    if(el.classList.contains('canvas-viewport')||el.classList.contains('canvas-surface'))return box(0,0,page.window.innerWidth,page.window.innerHeight) as DOMRect;
    return original.call(el);
  };
  Object.defineProperty(page.window,'innerWidth',{value:1024,configurable:true});
  Object.defineProperty(page.window,'innerHeight',{value:700,configurable:true});
  await act(async()=>{page.replaceGraph(structuredClone(narrowCanvas));page.window.dispatchEvent(new page.window.Event('resize'));});
  return ()=>{proto.getBoundingClientRect=original;};
}

test('at 1024x700 the editor takes the inspector spot and stays inside the window',async()=>{
  assert.deepEqual(inspectCanvas(narrowCanvas,narrowInspector.workspace.yaml).diagnostics,[]);
  const page=await mount([row('paid',0,narrowFingerprint,{source:'1+1'})]);
  const restore=await showNarrowFixture(page);
  try{
    const node=page.document.querySelector<HTMLElement>('.screen-node')!;
    assert.equal(node.getAttribute('aria-label'),'Screen Checkout');
    assert.equal(node.style.left,'800px');
    assert.equal(page.document.body.textContent?.includes('Before running'),false);
    const opener=page.document.querySelector<HTMLButtonElement>('[data-script-id="paid"] .script-row-summary')!;
    assert.ok(opener);
    opener.focus();
    await click(page.document,'[data-script-id="paid"] .script-row-summary');
    const editor=page.document.querySelector<HTMLElement>('.script-editor')!;
    const inspector=page.document.querySelector<HTMLElement>('.floating-inspector')!;
    assert.ok(editor);
    assert.ok(inspector.isConnected);
    assert.equal(inspector.getAttribute('data-inspector-yielded'),'true');
    assert.equal(inspector.style.visibility,'hidden');
    assert.notEqual(editor.style.visibility,'hidden');
    const editorBox=editor.getBoundingClientRect();
    const inspectorBox=inspector.getBoundingClientRect();
    const hits=editorBox.left<inspectorBox.right&&editorBox.right>inspectorBox.left&&editorBox.top<inspectorBox.bottom&&editorBox.bottom>inspectorBox.top;
    assert.equal(hits,false);
    assert.ok(editorBox.width>0&&editorBox.bottom<=700-88);
    assert.ok(parseFloat(editor.style.top)+parseFloat(editor.style.maxHeight)<=700-88);
    await click(page.document,'[aria-label="Close script editor"]');
    assert.equal(page.document.querySelector('.script-editor'),null);
    assert.equal(page.document.querySelector('.floating-inspector')?.getAttribute('data-inspector-yielded'),null);
    assert.equal(page.document.activeElement,opener);
    await act(async()=>opener.dispatchEvent(new page.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    assert.equal(page.document.querySelector('.floating-inspector'),null);
  }finally{restore();await page.close();}
});

test('a read-only editor takes focus when the inspector steps aside',async()=>{
  const imported=row('paid',0,narrowFingerprint,{source:'1+1',origin:'imported'});
  const page=await mount([imported],[{rowId:imported.id,origin:'imported',trusted:false,hash:imported.hash}]);
  const restore=await showNarrowFixture(page);
  try{
    const opener=page.document.querySelector<HTMLButtonElement>('[data-script-id="paid"] .script-row-summary')!;
    opener.focus();
    await click(page.document,'[data-script-id="paid"] .script-row-summary');
    const editor=page.document.querySelector<HTMLElement>('.script-editor')!;
    const close=editor.querySelector<HTMLButtonElement>('[aria-label="Close script editor"]')!;
    const trust=editor.querySelector<HTMLButtonElement>('[data-testid="trust-this-script"]')!;
    assert.equal(page.document.querySelector('.floating-inspector')?.getAttribute('data-inspector-yielded'),'true');
    assert.equal(page.document.querySelector('[aria-label="Script name"]'),null);
    assert.ok(trust);
    assert.ok(page.document.activeElement===close||page.document.activeElement===trust);
    assert.notEqual(page.document.activeElement,page.document.body);
    assert.ok(editor.contains(page.document.activeElement));
  }finally{restore();await page.close();}
});

test('widening the window while typing in the script leaves focus in the code',async()=>{
  const page=await mount([row('paid',0,narrowFingerprint,{source:'1+1'})]);
  const restore=await showNarrowFixture(page);
  try{
    await click(page.document,'[data-script-id="paid"] .script-row-summary');
    const name=page.document.querySelector<HTMLInputElement>('[aria-label="Script name"]')!;
    const source=page.document.querySelector<HTMLTextAreaElement>('[aria-label="Script source"]')!;
    assert.equal(page.document.activeElement,name);
    source.focus();
    await act(async()=>{
      Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype,'value')!.set!.call(source,'1+1\n2');
      source.dispatchEvent(new page.window.Event('input',{bubbles:true}));
    });
    assert.equal(source.value,'1+1\n2');
    assert.equal(page.document.activeElement,source);
    Object.defineProperty(page.window,'innerWidth',{value:1600,configurable:true});
    await act(async()=>page.window.dispatchEvent(new page.window.Event('resize')));
    assert.equal(page.document.querySelector('.floating-inspector')?.getAttribute('data-inspector-yielded'),null);
    assert.equal(page.document.activeElement,source);
    assert.equal(source.value,'1+1\n2');
  }finally{restore();await page.close();}
});

test('while running, the heading and hint span the status row',async()=>{
  const page=await mount([row('paid',0,fingerprint,{source:'1+1'})]);
  try{
    await click(page.document,'[data-script-id="paid"] .script-row-summary');
    await act(async()=>page.updateExtra({running:true}));
    const running=page.document.querySelector('.script-running')!;
    assert.equal(running.querySelector('.script-running-title')?.textContent,'While running');
    assert.equal(running.querySelector('.script-running-label')?.textContent?.replace(/\s+/g,' ').trim(),'Running');
    assert.equal(running.querySelector('.script-stop')?.textContent,'■ Stop');
    assert.equal(running.querySelector('.script-running-hint')?.textContent,'Result is shown after the run ends. No banners.');
    const title=running.querySelector('.script-running-title')!;
    const hint=running.querySelector('.script-running-hint')!;
    const label=running.querySelector('.script-running-label')!;
    assert.equal(title.compareDocumentPosition(label)&page.window.Node.DOCUMENT_POSITION_FOLLOWING,page.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(label.compareDocumentPosition(running.querySelector('.script-stop')!)&page.window.Node.DOCUMENT_POSITION_FOLLOWING,page.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(running.querySelector('.script-stop')!.compareDocumentPosition(hint)&page.window.Node.DOCUMENT_POSITION_FOLLOWING,page.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.match(readFileSync(new URL('../src/style.css',import.meta.url),'utf8'),/\.script-running-title,\.script-running-hint\{grid-column:1 \/ -1\}/);
  }finally{await page.close();}
});

test('a setup-only visit omits Run script from the add menu',async()=>{
  const page=await mount();
  try{
    const setupFingerprint='aa'.repeat(32);
    await act(async()=>page.replaceGraph({
      screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'boot',label:'Setup',role:'setup',reference:{kind:'setup',file:'setup.yaml',fingerprint:setupFingerprint}}]}],
      edges:[],
      paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:[],visits:[{id:'v1',operationIds:['boot']}]}],
    }));
    await click(page.document,'.add-visit-step');
    assert.equal(page.document.querySelector('[data-testid="add-run-script"]'),null);
  }finally{await page.close();}
});
