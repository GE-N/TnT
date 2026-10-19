import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {act,createElement,useState,type ReactNode} from 'react';
import type {CanvasGraph} from '../server/canvas.js';
import type {ScriptRow} from '../server/run-script-contract.js';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';
import {RecoveredFields} from '../src/workspace-drafts.js';
import {recordsFor} from '../src/run-script.js';
import {emptyCanvas} from '../src/canvas.js';

const fingerprint='ab'.repeat(32);
const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint};
const graph:CanvasGraph={
 screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'ready',label:'Home',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Home'}}]}],
 edges:[],
 paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:[],visits:[{id:'v1',operationIds:['ready']}]}],
};
function definition(id:string,name:string,pathId='route'):ScenarioDefinition{
 return {id,name,authoring:'canvas',steps:[],pathId,inputs:{},parameters:{},enabledHandlerIds:[]};
}

async function mount(options?:{scenarios?:ScenarioDefinition[];pathId?:string;graph?:CanvasGraph;script?:boolean;recovered?:Record<string,string>}){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const window=dom.window;
 const previous=new Map<string,PropertyDescriptor|undefined>();
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of ['window','document','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Node','Element','Event','KeyboardEvent','PointerEvent','MutationObserver','ResizeObserver','IS_REACT_ACT_ENVIRONMENT']){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
  Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(window,key),configurable:true});
 }
 const {createRoot}=await import('react-dom/client');
 const {CanvasEditor}=await import('../src/canvas.js');
 const {ScenarioDetails}=await import('../src/scenario-details.js');
 const {ScenarioSidebar}=await import('../src/scenario-sidebar.js');
 const scenarios=options?.scenarios??[definition('main','Checkout'),definition('other','Receipt')];
 const pathId=options?.pathId??'route';
 const currentGraph=options?.graph??graph;
 let latest:ScriptRow[]=[{id:'s1',beforeStep:{index:0,fingerprint},label:'Run script',source:'hello'}];
 let currentId='main';
 const controls:{running:boolean;save:'idle'|'saving'|'saved'|'failed';renames:number;retries:number;drops:string[];setRunning:(value:boolean)=>void;setSave:(value:'idle'|'saving'|'saved'|'failed')=>void}={running:false,save:'idle',renames:0,retries:0,drops:[],setRunning(){},setSave(){}};
 function Host(){
  const [items,setItems]=useState(scenarios);
  const [selected,setSelected]=useState(items[0]?.id??'');
  const [rows,setRows]=useState(latest);
  const [recovered,setRecovered]=useState(options?.recovered??{});
  const [deleted,setDeleted]=useState<{id:string;index:number;name:string;restore:()=>void}|undefined>();
  const [running,setRunning]=useState(false);
  const [save,setSave]=useState(controls.save);
  controls.running=running;controls.save=save;
  controls.setRunning=setRunning;
  controls.setSave=setSave;
  currentId=selected;latest=rows;
  const records=recordsFor(selected||'main',rows,[]);
  const sidebar=createElement(ScenarioSidebar,{
   items,selected,disabled:running,canRun:!running,running,runningId:running?selected:undefined,stepCounts:Object.fromEntries(items.map(item=>[item.id,item.id==='main'?3:1])),
   onStop:()=>setRunning(false),onSelect:id=>{setDeleted(undefined);setSelected(id);},
   onCreate:()=>{setDeleted(undefined);const next=definition('created','Scenario 2');setItems(value=>[...value,next]);setSelected(next.id);},
   onRun:()=>setRunning(true),onRunAll:()=>{},
   onRename:(name,id)=>{controls.renames++;setDeleted(undefined);setItems(value=>value.map(item=>item.id===id?{...item,name}:item));},
   onRenameDropped:(id:string)=>{controls.drops.push(id);setRecovered(current=>{const next={...current};delete next['scenario-rename:'+id];return next;});},
   onDuplicate:()=>setDeleted(undefined),
   onDelete:(id:string)=>{
    setItems(current=>{
     const index=current.findIndex(item=>item.id===id);const target=current[index];if(!target)return current;
     const next=current[index+1]??current[index-1];
     if(selected===id)setSelected(next?.id??'');
     setDeleted({id,index,name:target.name,restore:()=>setItems(value=>{if(value.some(item=>item.id===id))return value;const copy=[...value];copy.splice(index,0,target);return copy;})});
     return current.filter(item=>item.id!==id);
    });
   },
   onToggleSkip:()=>setDeleted(undefined),
   saveState:{status:save,retry:()=>{controls.retries++;setSave('saved');}},
   deleted,onDismissDeleted:()=>setDeleted(undefined),
  });
  const runScripts=options?.script===false?undefined:{scenarioId:selected||'main',rows:records,trust:[],results:[],executionOrder:[],hasMock:false,revealBlocks:false,running:false,passedRun:false,timedOut:false,scrubFailed:false,failedAtScript:false,trustBlockCount:1,onAdd:()=>'s2',onUpdate:(rowId:string,patch:{source?:string;label?:string})=>setRows(value=>value.map(item=>item.id===rowId?{...item,...patch}:item)),onMove:()=>{},onDelete:(rowId:string)=>setRows(value=>value.filter(item=>item.id!==rowId)),onReplace:setRows,onTrust:async()=>{}};
  return createElement(CanvasEditor,{graph:currentGraph,onChange:()=>{},yaml:'appId: app\n---\n- assertVisible: Home\n',onYamlChange:()=>{},catalog:[],diagnostics:[],pathId,onPathChange:()=>{},disabled:false,scenarioMode:true,scenarioId:selected,scenarios:items.map(item=>({id:item.id,name:item.name,pathId:item.pathId})),initialView:pathId?{selectedScreenId:'home',selectedVisitId:'v1'}:undefined,onRun:()=>{},runScripts,scenarioPanel:createElement(ScenarioDetails,null,createElement(RecoveredFields.Provider,{value:recovered},sidebar as ReactNode))});
 }
 const root=createRoot(window.document.getElementById('root')!);
 await act(async()=>root.render(createElement(Host)));
 return {window,document:window.document,controls,rows:()=>latest,selected:()=>currentId,async close(){await act(async()=>root.unmount());for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];}}};
}

test('the sequence bar keeps its contents and the Scenarios trigger opens the details panel',async()=>{
 const page=await mount();
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
 try{
  const {document,window}=page;
  assert.equal(document.querySelector('.sequence-scenario-name')!.textContent,'Checkout');
  assert.match(document.querySelector('[aria-label="Scenario sequence"]')!.textContent!,/1 · Home/);
  assert.equal(document.querySelector('.sequence-finish')!.textContent,'Finish sequence');
  assert.ok(document.querySelector('[data-testid="run-blocked"]'));
  const trigger=document.querySelector<HTMLButtonElement>('[data-testid="scenario-bar-trigger"]')!;
  assert.equal(trigger.getAttribute('aria-label'),'Scenarios');
  assert.equal(trigger.getAttribute('title'),'Scenarios');
  assert.equal(trigger.querySelector('.scenario-bar-tooltip'),null);
  assert.doesNotMatch(css,/\.scenario-bar-tooltip/);
  assert.equal(trigger.getAttribute('aria-haspopup'),'dialog');
  assert.equal(trigger.getAttribute('aria-expanded'),'false');
  assert.equal(trigger.querySelectorAll('path')[1].getAttribute('d'),'M15 14.5l2.5 2.5 2.5-2.5');
  assert.match(css,/\.scenario-bar-trigger\{[^}]*width:44px;height:44px/);
  assert.match(css,/\.workbench \.scenario-sequence-bar \.scenario-bar-trigger:focus-visible\{[^}]*outline:none/);
  assert.match(css,/\.scenario-details-panel\{[^}]*width:min\(440px,calc\(100vw - 48px\)\)[^}]*overflow:auto/);
  assert.match(css,/\.workbench \.scenario-sequence-bar\{flex-wrap:wrap/);
  assert.match(css,/\.workbench \.canvas-editor>\.notice:not\(\.canvas-delete-dialog\)\{[^}]*width:250px/);
  assert.match(css,/\.workbench \.go-to-issue\{[^}]*left:24px[^}]*text-decoration:underline/);
  assert.match(css,/\.workbench \.canvas-editor>\.notice:not\(\.canvas-delete-dialog\),\.workbench \.scenario-notice\{width:200px/);
  const bar=document.querySelector<HTMLElement>('.scenario-sequence-bar')!;
  const box=(bottom:number,right=1000)=>({top:24,bottom,left:390,right,width:right-390,height:bottom-24,x:390,y:24,toJSON(){return {};}}) as DOMRect;
  bar.getBoundingClientRect=()=>box(80);
  Object.defineProperty(window,'innerWidth',{configurable:true,value:1280});
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-script-id="s1"] .script-row-summary')!.click());
  const source=document.querySelector<HTMLTextAreaElement>('[aria-label="Script source"]')!;
  await act(async()=>{
   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(source,'hello world');
   source.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  assert.equal(page.rows()[0].source,'hello world');
  await act(async()=>trigger.click());
  const panel=document.querySelector<HTMLElement>('[data-testid="scenario-panel"]')!;
  assert.equal(panel.getAttribute('role'),'dialog');
  assert.equal(panel.getAttribute('aria-label'),'Scenario details');
  assert.equal(trigger.getAttribute('aria-expanded'),'true');
  assert.equal(trigger.getAttribute('aria-controls'),panel.id);
  assert.equal(trigger.querySelectorAll('path')[1].getAttribute('d'),'M15 17l2.5-2.5 2.5 2.5');
  assert.equal(document.querySelector('[data-script-editor],.script-editor'),null);
  assert.equal(page.rows()[0].source,'hello world');
  assert.equal(document.querySelector('.floating-inspector')?.getAttribute('data-inspector-yielded'),'true');
  assert.equal(document.activeElement?.getAttribute('aria-label'),'Search scenarios');
  assert.equal(panel.style.top,'88px');
  assert.equal(panel.style.right,'280px');
  assert.equal(panel.style.maxHeight,'calc(100dvh - 112px)');
  assert.equal(document.querySelector('.sequence-scenario-name')!.textContent,'Checkout');
  assert.ok(document.querySelector('.scenario-sequence-bar [data-testid="run-blocked"]'));
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[aria-label="Scenario list"] button')].find(button=>button.textContent==='Receipt')!.click());
  assert.equal(document.querySelector('.sequence-scenario-name')!.textContent,'Receipt');
  assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-current="true"]')!.textContent,'Receipt');
  const search=document.querySelector<HTMLInputElement>('[aria-label="Search scenarios"]')!;
  await act(async()=>{
   Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(search,'pay');
   search.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  search.focus();
  bar.getBoundingClientRect=()=>box(140);
  Object.defineProperty(window,'innerWidth',{configurable:true,value:900});
  await act(async()=>window.dispatchEvent(new window.Event('resize')));
  assert.equal(document.querySelector('[data-testid="scenario-panel"]'),panel);
  assert.equal(document.activeElement,search);
  assert.equal(search.value,'pay');
  assert.equal(panel.style.top,'148px');
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="New scenario"]')!.click());
  assert.equal(document.querySelector('.sequence-scenario-name')!.textContent,'Scenario 2');
  await act(async()=>{
   Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(search,'');
   search.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-current="true"]')!.textContent,'Scenario 2');
  const keep=(event:Event)=>{if((event as KeyboardEvent).key==='Escape')event.preventDefault();};
  document.addEventListener('keydown',keep,true);
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  assert.equal(document.querySelector('[data-testid="scenario-panel"]'),panel);
  document.removeEventListener('keydown',keep,true);
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(document.querySelector('[data-testid="scenario-panel"]'),null);
  assert.equal(document.activeElement,trigger);
  assert.equal(trigger.getAttribute('aria-expanded'),'false');
  assert.equal(document.querySelector('.floating-inspector')?.getAttribute('data-inspector-yielded'),null);
  assert.equal(page.rows()[0].source,'hello world');
  await act(async()=>trigger.click());
  assert.equal(document.activeElement?.getAttribute('aria-label'),'Search scenarios');
  await act(async()=>document.body.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));
  assert.equal(document.querySelector('[data-testid="scenario-panel"]'),null);
  assert.equal(document.activeElement,trigger);
 }finally{await page.close();}
});

test('an empty workspace shows No scenarios and the panel still offers New scenario',async()=>{
 const page=await mount({scenarios:[],pathId:'',graph:emptyCanvas(),script:false});
 try{
  assert.equal(page.document.querySelector('.sequence-scenario-name')!.textContent,'No scenarios');
  assert.equal(page.document.querySelector('.sequence-empty-hint')!.textContent,'Create one to start a sequence');
  assert.equal(page.document.querySelector('[aria-label="Scenario sequence"]'),null);
  assert.equal(page.document.querySelector('[data-testid="scenario-panel"]'),null);
  await act(async()=>page.document.querySelector<HTMLButtonElement>('[data-testid="scenario-bar-trigger"]')!.click());
  assert.ok(page.document.querySelector('[data-testid="scenario-panel"]'));
  assert.equal(page.document.querySelector('[aria-label="New scenario"]')!.textContent,'New scenario');
  assert.match(page.document.querySelector('[aria-label="Scenario list"]')!.textContent!,/No scenarios yet/);
 }finally{await page.close();}
});


test('scenario details rows, rename, escape, undo, running, and box-free focus',async()=>{
 const page=await mount({scenarios:[definition('main','Alpha'),definition('mid','Beta'),definition('end','Gamma')]});
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
 try{
  const {document,window}=page;
  assert.doesNotMatch(css,/\.scenario-sidebar button:focus-visible\{[^}]*outline:2px/);
  assert.match(css,/\.scenario-details-panel \.sidebar-search input:focus-visible\{[^}]*border-bottom:3px solid #0a84ff[^}]*outline:none/);
  assert.match(css,/\.scenario-details-panel \.sidebar-search input:focus:not\(:focus-visible\)\{[^}]*border-bottom:2px solid #0a84ff/);
  assert.match(css,/\.scenario-details-panel \.scenario-select:focus-visible\{[^}]*outline:none[^}]*background:#dfeafb/);
  assert.match(css,/\.scenario-details-panel \.scenario-select\[aria-current="true"\]\{[^}]*background:#eef4fd[^}]*#0a63d1/);
  assert.match(css,/\.scenario-details-panel button:focus[^{]*\{[^}]*outline:none/);
  const trigger=document.querySelector<HTMLButtonElement>('[data-testid="scenario-bar-trigger"]')!;
  const bar=()=>document.querySelector('.sequence-scenario-name')!.textContent;
  const current=()=>document.querySelector('[aria-label="Scenario list"] [aria-current="true"]');
  const key=async(target:Element,name:string)=>act(async()=>target.dispatchEvent(new window.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true})));
  const fill=async(input:HTMLInputElement,value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await act(async()=>trigger.click());
  const panel=document.querySelector('[data-testid="scenario-panel"]')!;
  assert.equal(document.querySelectorAll('[data-testid="scenario-row"]').length,3);
  assert.equal(document.querySelectorAll('[aria-current="true"]').length,1);
  assert.equal(current()!.textContent,'Alpha');
  assert.match(document.querySelector('[data-scenario-id="main"]')!.textContent!,/● Current · 3 steps · in Run All/);
  assert.equal(document.querySelector('[data-testid="scenario-add"]')!.textContent,'New');
  const alpha=document.querySelector<HTMLButtonElement>('[data-scenario-id="main"] .scenario-select')!;
  await key(alpha,'ArrowDown');
  assert.equal(document.activeElement?.textContent,'Beta');
  assert.equal(current()!.textContent,'Alpha');
  assert.equal(bar(),'Alpha');
  await key(document.activeElement!,'Enter');
  assert.equal(current()!.textContent,'Beta');
  assert.equal(bar(),'Beta');
  assert.equal(document.querySelectorAll('[aria-current="true"]').length,1);
  await key(document.activeElement!,'ArrowUp');
  assert.equal(document.activeElement?.textContent,'Alpha');
  assert.equal(current()!.textContent,'Beta');
  const beta=document.querySelector<HTMLElement>('[data-scenario-id="mid"]')!;
  await act(async()=>beta.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20})));
  assert.ok(document.querySelector('[data-testid="scenario-row-action-delete"]')!.className.includes('scenario-menu-delete'));
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="scenario-row-action-rename"]')!.click());
  const editor=document.querySelector<HTMLInputElement>('[aria-label="Rename scenario"]')!;
  await fill(editor,'Uncommitted');
  assert.equal(bar(),'Beta');
  await act(async()=>editor.focus());
  await act(async()=>window.dispatchEvent(new window.Event('resize')));
  assert.equal(document.activeElement,editor);
  assert.equal(editor.value,'Uncommitted');
  assert.equal(document.querySelector('[data-testid="scenario-panel"]'),panel);
  await fill(editor,'');
  await key(editor,'Enter');
  assert.match(document.querySelector('[role="alert"]')!.textContent!,/Use a name of 1–120 characters/);
  await fill(editor,'y'.repeat(121));
  await key(editor,'Enter');
  assert.match(document.querySelector('[role="alert"]')!.textContent!,/1–120 characters/);
  const search=document.querySelector<HTMLInputElement>('[data-testid="scenario-search"]')!;
  await act(async()=>search.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true})));
  assert.equal(document.querySelector('[aria-label="Rename scenario"]'),null);
  assert.equal(bar(),'Beta');
  await act(async()=>beta.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20})));
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="scenario-row-action-rename"]')!.click());
  await fill(document.querySelector<HTMLInputElement>('[aria-label="Rename scenario"]')!,'Kept');
  await key(document.querySelector('[aria-label="Rename scenario"]')!,'Enter');
  assert.equal(bar(),'Kept');
  assert.equal(page.controls.renames,1);
  await act(async()=>page.controls.setSave('failed'));
  const retry=document.querySelector<HTMLButtonElement>('[data-scenario-id="mid"] [role="status"] button')!;
  assert.match(retry.parentElement!.textContent!,/Couldn't save/);
  await act(async()=>retry.click());
  assert.equal(page.controls.retries,1);
  assert.equal(page.controls.renames,1);
  assert.equal(bar(),'Kept');
  assert.match(document.querySelector('[data-scenario-id="mid"] [role="status"]')!.textContent!,/Saved locally/);
  assert.equal(document.querySelector('[data-scenario-id="main"] [role="status"]'),null);
  await act(async()=>document.querySelector<HTMLElement>('[data-scenario-id="mid"]')!.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20})));
  await key(document.querySelector('[role="menu"]')!,'Escape');
  assert.equal(document.querySelector('[role="menu"]'),null);
  assert.equal(document.querySelector('[data-testid="scenario-panel"]'),panel);
  await key(document.body,'Escape');
  assert.equal(document.querySelector('[data-testid="scenario-panel"]'),null);
  assert.equal(document.activeElement,trigger);
  await act(async()=>trigger.click());
  await act(async()=>document.querySelector<HTMLElement>('[data-scenario-id="mid"]')!.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20})));
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="scenario-row-action-delete"]')!.click());
  const undo=document.querySelector<HTMLElement>('.scenario-undo')!;
  assert.match(undo.textContent!,/“Kept” deleted/);
  assert.equal(document.activeElement?.textContent,'Undo');
  assert.equal(current()!.textContent,'Gamma');
  assert.deepEqual([...document.querySelectorAll('[data-testid="scenario-row"] .scenario-select')].map(node=>node.textContent),['Alpha','Gamma']);
  await act(async()=>undo.querySelector<HTMLButtonElement>('button')!.click());
  assert.equal(document.querySelector('.scenario-undo'),null);
  assert.deepEqual([...document.querySelectorAll('[data-testid="scenario-row"] .scenario-select')].map(node=>node.textContent),['Alpha','Kept','Gamma']);
  await act(async()=>page.controls.setRunning(true));
  assert.match(document.querySelector('.scenario-running-note')!.textContent!,/Running — actions unavailable/);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-testid="scenario-add"]')!.disabled,true);
  assert.equal(document.querySelector<HTMLButtonElement>('.sidebar-run .primary')!.disabled,true);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-testid="scenario-row-menu"]')!.disabled,true);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-testid="scenario-row-action-stop"]')!.disabled,false);
  assert.match(document.querySelector('[data-scenario-id="end"]')!.textContent!,/◷ Running/);
  const liveSearch=document.querySelector<HTMLInputElement>('[data-testid="scenario-search"]')!;
  await fill(liveSearch,'Al');
  await act(async()=>window.dispatchEvent(new window.Event('resize')));
  assert.equal(liveSearch.value,'Al');
  assert.equal(document.querySelector('[aria-label="Rename scenario"]'),null);
  await act(async()=>page.controls.setRunning(false));
  assert.equal(document.querySelector('.scenario-running-note'),null);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-testid="scenario-add"]')!.disabled,false);
  assert.equal(document.querySelector('[data-testid="scenario-row-action-stop"]'),null);
 }finally{await page.close();}
});

test('a dropped rename clears the recovered field and is not offered when the panel opens again',async()=>{
 const page=await mount({recovered:{'scenario-rename:main':'Drafted'}});
 try{
  const {document,window}=page;
  const trigger=document.querySelector<HTMLButtonElement>('[data-testid="scenario-bar-trigger"]')!;
  await act(async()=>trigger.click());
  const rename=document.querySelector<HTMLInputElement>('[aria-label="Rename scenario"]')!;
  assert.equal(rename.value,'Drafted');
  assert.equal(document.querySelector('.sequence-scenario-name')!.textContent,'Checkout');
  await act(async()=>rename.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  assert.equal(document.querySelector('[aria-label="Rename scenario"]'),null);
  assert.deepEqual(page.controls.drops,['main']);
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await act(async()=>trigger.click());
  assert.equal(document.querySelector('[aria-label="Rename scenario"]'),null);
  assert.equal(document.querySelector('.sequence-scenario-name')!.textContent,'Checkout');
  void window;
 }finally{await page.close();}
});
