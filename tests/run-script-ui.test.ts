import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement,useState,useSyncExternalStore} from 'react';
import type {CanvasGraph} from '../server/canvas.js';
import type {ScriptExecutionReference,ScriptStepResult} from '../server/run-script-contract.js';
import {addStoredScript,approveScriptTrust,getRunScriptSnapshot,moveStoredScript,resetRunScripts,scriptsFor,seedImportedScript,subscribeRunScripts,updateStoredScript} from '../src/run-script-client.js';
import {anchorForNewScript,anchorMatches,batchSummary,batchWithScriptBlocks,blocksFor,endAnchorFingerprint,evidenceScrubFailed,moveScript,readScriptRun,reservedPlacements,runHitCap,scriptBlock,scriptFirstLine,scriptFollowsFailure,scriptRowView,sha256,stableScriptOrder,stepNotRun,SCRIPT_EXAMPLE,SCRIPT_TIMEOUT,SCRUB_FAILED_TEXT,type OrderedStep,type ScriptRecord} from '../src/run-script.js';
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
  assert.equal(scriptBlock(placed,steps,[]),undefined);
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
  assert.equal(scriptBlock(row('u',0,fingerprint,{origin:'imported'}),steps,approvals)?.message,'Script needs trust');
  assert.equal(scriptBlock(row('ok',0,fingerprint),steps,approvals),undefined);
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
  assert.deepEqual(lines.map(batchSummary),[
    {statusText:'failed',reason:'Script needs trust',testId:'batch-script-untrusted',tone:'trust'},
    {statusText:'failed',reason:'Script failed',testId:'batch-script-failed',tone:'failed'},
  ]);
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
  assert.match(css,/#b3261e/);
});

const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint};
const graph:CanvasGraph={
  screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'ready',label:'Home',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Home'}}]}],
  edges:[],
  paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:[],visits:[{id:'v1',operationIds:['ready']}]}],
};

async function mount(reset=true){
  if(reset)resetRunScripts('workspace');
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
  let updateExtra:(patch:Partial<{running:boolean;passedRun:boolean;revealBlocks:boolean;scrubFailed:boolean;failedAtScript:boolean;timedOut:boolean;hasMock:boolean;results:ScriptStepResult[];executionOrder:ScriptExecutionReference[]}>)=>void=()=>{};
  const initial={running:false,passedRun:false,revealBlocks:false,scrubFailed:false,failedAtScript:false,timedOut:false,hasMock:false,results:[] as ScriptStepResult[],executionOrder:[] as ScriptExecutionReference[]};
  function Host(){
    const snapshot=useSyncExternalStore(subscribeRunScripts,getRunScriptSnapshot,getRunScriptSnapshot);
    const [current,setGraph]=useState(graph);
    const [extra,setExtra]=useState(initial);
    replaceGraph=setGraph;updateExtra=patch=>setExtra(value=>({...value,...patch}));
    const rows=scriptsFor('main');
    const runScripts:RunScriptModel={scenarioId:'main',rows,trust:snapshot.trust,results:extra.results,executionOrder:extra.executionOrder,hasMock:extra.hasMock,revealBlocks:extra.revealBlocks,running:extra.running,passedRun:extra.passedRun,timedOut:extra.timedOut,scrubFailed:extra.scrubFailed,failedAtScript:extra.failedAtScript,trustBlockCount:rows.filter(item=>item.origin==='imported'&&!snapshot.trust.some(trust=>trust.rowId===item.id&&trust.trusted&&trust.hash===item.hash)).length,workspaceName:'Imported workspace',onAdd:anchor=>addStoredScript('main',anchor),onUpdate:updateStoredScript,onMove:moveStoredScript,onDelete:()=>{},onTrust:async rowId=>{const item=scriptsFor('main').find(entry=>entry.id===rowId);if(item)await approveScriptTrust({workspace:'workspace',rowId,hash:item.hash,token:'token'});}};
    return createElement('div',null,
      createElement(CanvasEditor,{graph:current,onChange:(next:CanvasGraph|undefined)=>{if(next)setGraph(next);},yaml:'appId: app\n---\n- assertVisible: Home\n',onYamlChange:()=>{},catalog:[],diagnostics:[],pathId:'route',onPathChange:()=>{},disabled:false,scenarioMode:true,scenarioId:'main',scenarios:[{id:'main',name:'Main',pathId:'route'}],initialView:{selectedScreenId:'home',selectedVisitId:'v1'},runScripts}),
      createElement(RedactedText,{text:'token [redacted] hidden'}),
      createElement(YamlEditor,{yaml:'- tapOn: ${TNT_MOCK_TOKEN}\n',onChange:()=>{},disabled:false,reservedLines:[1]}),
    );
  }
  const root=createRoot(window.document.getElementById('root')!);
  await act(async()=>root.render(createElement(Host)));
  return {window,document:window.document,replaceGraph,updateExtra,async close(){await act(async()=>root.unmount());globalThis.fetch=fetchImpl;for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];}resetRunScripts();}};
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
    const stored=getRunScriptSnapshot().scripts[0];
    assert.equal(stored.beforeStep.fingerprint,fingerprint+':end');
    assert.equal(page.document.querySelector('[data-testid="script-blocks-run"]'),null);
    await act(async()=>page.updateExtra({passedRun:true,results:[{kind:'runScript',rowId:stored.id,status:'passed'}],executionOrder:[{kind:'step',index:0},{kind:'runScript',rowId:stored.id}]}));
    assert.match(page.document.body.textContent!,/✓ Passed/);
    assert.match(page.document.body.textContent!,/Ran after the last step/);
    assert.equal(page.document.querySelector('[data-testid="script-not-run"]'),null);
    await act(async()=>page.replaceGraph({...graph,screens:[{...graph.screens[0],tests:[...graph.screens[0].tests,{id:'next',label:'Next',role:'assertion',reference:{...reference,fingerprint:other},check:{visibility:'visible',target:'text',match:'exact',value:'Next'}}]}],paths:[{...graph.paths[0],visits:[{id:'v1',operationIds:['ready','next']}]}]}));
    assert.equal(getRunScriptSnapshot().scripts[0].beforeStep.fingerprint,fingerprint+':end');
    assert.match(page.document.body.textContent!,/Step changed · relink before running/);
    assert.equal(page.document.querySelector('[data-block-kind="stale-anchor"]')!.getAttribute('data-testid'),'script-blocks-run');
    await act(async()=>page.updateExtra({scrubFailed:true,failedAtScript:false,passedRun:false,results:[]}));
    assert.equal(page.document.querySelector('[data-testid="evidence-scrub-failed"]')!.textContent,SCRUB_FAILED_TEXT);
    assert.equal(page.document.querySelector('[data-testid="redacted-chip"]')!.textContent,'[redacted]');
    assert.match(page.document.querySelector('[data-testid="reserved-variable-error"]')!.textContent!,/Reserved TnT variable · line 1/);
  }finally{await page.close();}
});

test('imported scripts are trusted one at a time and a failure stops later steps',async()=>{
  resetRunScripts('workspace');
  seedImportedScript('main',{id:'one',label:'First',source:'console.log(1)',beforeStep:{index:0,fingerprint}});
  seedImportedScript('main',{id:'two',label:'Second',source:'console.log(2)',beforeStep:{index:0,fingerprint}});
  const page=await mount(false);
  try{
    assert.equal(page.document.querySelectorAll('[data-testid="script-not-trusted"]').length,2);
    assert.match(page.document.querySelector('[data-testid="run-blocked"]')!.textContent!,/2 imported scripts need Trust/);
    await click(page.document,'[data-script-id="one"] .script-row-summary');
    const editor=page.document.querySelector('.script-editor')!;
    assert.equal(editor.getAttribute('role'),null);
    assert.equal(page.document.querySelector('[data-testid="script-source"]')!.textContent,'console.log(1)');
    assert.match(editor.textContent!,/Imported from Imported workspace/);
    assert.match(editor.textContent!,/1 of 2 left after this/);
    assert.doesNotMatch(editor.textContent!,/Trust all/);
    await act(async()=>{page.document.querySelector<HTMLButtonElement>('[data-testid="trust-this-script"]')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(page.document.querySelectorAll('[data-testid="script-not-trusted"]').length,1);
    assert.match(page.document.querySelector('[data-script-id="two"]')!.textContent!,/Not trusted on this Mac/);
    await act(async()=>page.updateExtra({revealBlocks:true,results:[{kind:'runScript',rowId:'one',status:'script-error',message:'switch failed'}],executionOrder:[{kind:'runScript',rowId:'one'},{kind:'step',index:0},{kind:'runScript',rowId:'two'}],failedAtScript:true}));
    assert.match(page.document.querySelector('[data-testid="script-error-reason"]')!.textContent!,/switch failed/);
    assert.equal(page.document.querySelector('[data-testid="script-not-run"]')!.textContent,'Not run');
    assert.match(page.document.querySelector('[data-testid="failed-at-script"]')!.textContent!,/Failed at Run script/);
    assert.equal(blocksFor(scriptsFor('main'),[step(0)],getRunScriptSnapshot().trust).some(item=>item.kind==='untrusted'),true);
  }finally{await page.close();}
});
