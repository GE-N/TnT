import {addVisitStep,commitVisitEdits,editVisitField,inspectorCard,inspectorOwner,inspectScreen,openScenarioPanel,workspaceCommand} from './workspace-ui-helpers.js';
import assert from 'node:assert/strict';
import {test,describe} from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseAllDocuments} from 'yaml';
import {Scenarios} from '../src/scenarios.js';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
import {writeChecks} from '../shared/canvas-authoring.js';
import type {CanvasGraph} from '../server/canvas.js';

const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
describe('inspector run states',{concurrency:false},()=>{

async function journey(work:(ui:{
 document:Document;
 click:(label:string)=>Promise<void>;
 fill:(label:string,value:string)=>Promise<void>;
 holdNext:()=>void;
 holdPicker:()=>void;
 failNext:(index?:number)=>void;
 setToken:(token:string)=>Promise<void>;
 settle:()=>Promise<void>;
})=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'tnt-run-states-'));
 let fail=false;let failIndex=3;let hold=false;let returnRunning=false;let releaseHold:(()=>void)|undefined;let token='test';
 let holdCapture=false;let releaseCapture:(value:Response)=>void=()=>{};
 const service=createScenarios({root:directory,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=>'2.11.0',run:async({directory:dir,flow,signal})=>{
  if(hold){hold=false;await new Promise<void>(resolve=>{releaseHold=resolve;if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});releaseHold=undefined;}
  const commands=parseAllDocuments(await readFile(flow,'utf8'))[1].toJS() as unknown[];
  const failing=fail;fail=false;
  const assertIndexes=commands.flatMap((command,index)=>command&&typeof command==='object'&&('assertVisible' in (command as object)||'assertNotVisible' in (command as object))?[index]:[]);
  const failedAt=assertIndexes.includes(failIndex)?failIndex:(assertIndexes.at(-1)??failIndex);
  await writeFile(join(dir,'report.xml'),'<testsuites><testsuite tests="1" failures="'+(failing?1:0)+'"/></testsuites>');
  await writeFile(join(dir,'commands.json'),JSON.stringify(commands.map((command:any,index:number)=>({command:{[command==='back'?'backPressCommand':command==='launchApp'||command.launchApp?'launchAppCommand':command.tapOn?'tapOnElement':command.inputText?'inputTextCommand':'assertConditionCommand']:{}},metadata:{depth:0,status:failing&&index===failedAt?'FAILED':failing&&index>failedAt?'SKIPPED':'COMPLETED',error:failing&&index===failedAt?{message:'Assertion failed at visit 3'}:undefined}}))));
  return {code:failing?1:0,log:'Simulator boundary fixture',cleanup:{verified:true,detail:'Fixture exited'}};
 }}});
 const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
 const canvas:CanvasGraph={
  screens:[
   {id:'1',title:'Home',x:0,y:0,tests:[{id:'home-ready',label:'Home',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Home'}},{id:'go-2',label:'Go 2',role:'action',reference,tap:{target:'text',match:'exact',value:'Go 2'}}]},
   {id:'2',title:'Mid',x:400,y:0,tests:[{id:'mid-ready',label:'Mid',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Mid'}},{id:'go-3',label:'Go 3',role:'action',reference,tap:{target:'text',match:'exact',value:'Go 3'}}]},
   {id:'3',title:'End',x:800,y:0,tests:[{id:'end-ready',label:'End',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'End'}}]},
  ],
  edges:[
   {id:'12',from:'1',to:'2',actionTestId:'go-2',actionTestIds:['go-2'],assertionTestId:'mid-ready',responseCondition:'1 → 2'},
   {id:'23',from:'2',to:'3',actionTestId:'go-3',actionTestIds:['go-3'],assertionTestId:'end-ready',responseCondition:'2 → 3'},
  ],
  paths:[],
 };
 const workspace=await service.save({name:'Run states',yaml:writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas),canvas,scenarios:[]});
 const dom=new JSDOM('<div id="root"></div>');const document=dom.window.document;
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const pending:Promise<Response>[]=[];
 const request=async(path:string,options?:{body?:string})=>{
  try{
   const body=options?.body?JSON.parse(options.body):undefined;
   const id=path.split('/')[3];
   if(path==='/api/picker/captures')return Response.json({error:'Capture unavailable in this fixture'},{status:400});
   if(path==='/api/runs'){
    const started=await service.start(body);
    // holdNext clears `hold` inside Maestro; keep a separate latch so the UI can observe running.
    if(returnRunning){returnRunning=false;return Response.json(started,{status:202});}
    return Response.json(await service.wait(started.id));
   }
   if(path.startsWith('/api/runs/')&&path.endsWith('/cancel'))return Response.json(await service.cancel(path.split('/')[3]));
   if(path.startsWith('/api/runs/'))return Response.json(await service.result(path.slice('/api/runs/'.length)));
   if(path==='/api/workspaces')return Response.json(body?await service.save(body):await service.listWorkspaces());
   if(path.startsWith('/api/workspaces?q='))return Response.json(await service.listWorkspaces());
   if(path.endsWith('/open'))return Response.json(await service.openWorkspace(id));
   if(path.endsWith('/view'))return Response.json(await service.saveView(id,body));
   if(path.endsWith('/draft/discard'))return Response.json(await service.discardDraft(id,body.expectedDraftRevision));
   if(path.endsWith('/draft'))return Response.json(await service.saveDraft(id,body));
   if(path==='/api/canvas/references')return Response.json(await service.references(body));
   return Response.json(await service.workspace(path.slice('/api/workspaces/'.length)));
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Failed'},{status:400});}
 };
 const fetch=(path:string,options?:{body?:string})=>{
  if(path==='/api/picker/captures'&&holdCapture){
   holdCapture=false;
   return new Promise<Response>(resolve=>{releaseCapture=resolve;});
  }
  const result=request(path,options);
  pending.push(result);
  return result;
 };
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetch:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const settle=async()=>{do{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pending.length);};
 const setToken=async(next:string)=>{token=next;await act(async()=>root.render(createElement(Scenarios,{token,deviceId,bundleId:'com.example.App',launchBusy:false,onRunning:()=>{},simulatorConnected:!!token})));await settle();};
 const click=async(label:string)=>{
  const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});
  if(label==='Save workspace'||label==='Open saved workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open',settle);
  if(await addVisitStep(document,label))return;
  await commitVisitEdits(document);
  const ready=()=>[...document.querySelectorAll<HTMLElement>('button,summary')].some(item=>item.getAttribute('data-testid')!=='scenario-bar-trigger'&&(item.getAttribute('aria-label')??item.textContent)===label);
  if(!ready())await openScenarioPanel(document,act);
  return act(async()=>{
   const node=[...document.querySelectorAll<HTMLElement>('button,summary')].find(item=>(item.getAttribute('aria-label')??item.textContent)===label);
   assert.ok(node,label);
   assert.ok(!(node as HTMLButtonElement).disabled,label+' is enabled');
   node.click();
   await settle();
  });
 };
 const fill=async(label:string,value:string)=>{await editVisitField(document,label);await act(async()=>{const node=document.querySelector('[aria-label="'+label+'"]')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});await commitVisitEdits(document);};
 try{
  await setToken('test');
  await click('Open saved workspace');
  await click('New scenario');
  await click('Use Home as scenario start');
  await click('Append connection 1 → 2');
  await click('Append connection 2 → 3');
  // Appended destination visits start empty; add each screen's check into its visit.
  await inspectScreen(document,{title:'Mid'},{number:2});
  await click('Add check to Mid');
  await fill('Check 1 selector','Mid');
  await inspectScreen(document,{title:'End'},{number:3});
  await click('Add check to End');
  await fill('Check 1 selector','End');
  await click('Finish sequence');
  await click('Save workspace');
  await work({document,click,fill,holdNext:()=>{hold=true;returnRunning=true;},holdPicker:()=>{holdCapture=true;},failNext:(index=5)=>{fail=true;failIndex=index;},setToken,settle});
 }finally{
  releaseHold?.();
  releaseCapture(Response.json({error:'cancelled'},{status:400}));
  await act(async()=>root.unmount());
  dom.window.close();
  for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  await rm(directory,{recursive:true,force:true});
 }
}

test('running locks the inspector, shows spinner progress, Stop, and edge highlight without moving focus',()=>journey(async({document,click,holdNext,settle})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 const beforeFocus=document.activeElement;
 const selectedBefore=document.querySelector('.canvas-visit-section.selected-visit')?.getAttribute('data-visit-id');
 holdNext();
 await act(async()=>{document.querySelector<HTMLButtonElement>('[aria-label="Run scenario"]')!.click();await settle();});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));await settle();});
 assert.ok(document.querySelector('.scenario-row [aria-label="Stop scenario"]'),'Stop replaces the running scenario play button');
 assert.equal(document.querySelector('.add-visit-step'),null);
 assert.equal(document.querySelector('.visit-step-drag'),null);
 assert.equal(document.querySelector('.visit-step-actions'),null);
 assert.equal(document.querySelector('.visit-yaml-link'),null);
 assert.equal(document.querySelector('[aria-label^="Open YAML"]'),null);
 const badges=[...document.querySelectorAll('.run-status-badge.running')];
 assert.equal(badges.length,2,'Spinner status appears on the current visit and step only');
 assert.ok(badges.every(node=>node.getAttribute('role')==='status'&&/Running/.test(node.textContent??'')));
 assert.equal(document.querySelector('[data-highlighted="true"]')?.getAttribute('data-edge-id'),'12');
 assert.equal(document.activeElement,beforeFocus,'Running does not move focus');
 assert.equal(document.querySelector('.canvas-visit-section.selected-visit')?.getAttribute('data-visit-id'),document.querySelector('[data-visit-id]')?.getAttribute('data-visit-id'));
 assert.ok(selectedBefore===undefined||document.querySelector('[data-visit-id="'+selectedBefore+'"]'));
 await act(async()=>document.querySelector('.canvas-surface')!.dispatchEvent(new document.defaultView!.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:30,clientY:30})));
 const viewYaml=[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button=>button.textContent==='View YAML');
 assert.ok(viewYaml,'View YAML stays on the canvas menu while a run is locked');
 assert.equal(viewYaml.disabled,true);
 assert.equal(viewYaml.title,'Unavailable while the scenario is running.');
 await act(async()=>viewYaml.click());
 assert.equal(document.querySelector('[role="dialog"][aria-label="YAML"]'),null);
 await act(async()=>document.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 await click('Stop scenario');
}));

test('passed run shows subtle ✓ Passed on visits and steps',()=>journey(async({document,click})=>{
 await click('Run scenario');
 await inspectScreen(document,{title:'Home'},{number:1});
 assert.ok([...document.querySelectorAll('.run-status-badge.passed')].some(node=>node.textContent==='✓ Passed'));
 await inspectScreen(document,{title:'End'},{number:3});
 assert.ok([...document.querySelectorAll('.run-status-badge.passed')].every(node=>node.textContent==='✓ Passed'));
 assert.doesNotMatch(inspectorCard(document)!.textContent!,/Not run|Partly run/);
}));

test('failed visit auto-expands with red inline error, no banner or Go to step, and keeps focus',()=>journey(async({document,click,failNext})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 const beforeFocus=document.activeElement;
 const selectedVisit=document.querySelector('[aria-label="Visit 1 · Home operations"]')?.getAttribute('data-visit-id');
 failNext(5);
 await click('Run scenario');
 assert.ok(document.querySelector('.result-tag'),document.querySelector('.run-error-toast')?.textContent??'missing result');
 await inspectScreen(document,{title:'End'},{number:3});
 const section=document.querySelector('[aria-label="Visit 3 · End operations"]')!;
 assert.equal(section.querySelector('.visit-section-heading')?.getAttribute('aria-expanded'),'true');
 assert.ok(section.querySelector('.visit-step-failed'));
 assert.match(section.querySelector('.visit-step-error')?.textContent??'',/Assertion failed at visit 3/);
 assert.ok(section.querySelector('.run-status-badge.failed'));
 assert.equal(document.querySelector('[data-highlighted="true"]')?.getAttribute('data-edge-id'),'23');
 assert.equal(document.querySelector('.go-to-issue'),null);
 assert.doesNotMatch(document.body.textContent!,/Go to step/);
 assert.equal(document.activeElement,beforeFocus);
 assert.ok(selectedVisit);
}));

test('invalid draft shows the warning, inline field errors, and disables Run with the reason',()=>journey(async({document,click,settle})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 await click('Add action to Home');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await settle();});
 assert.match(document.querySelector('.inspector-draft-notice')?.textContent??'',/⚠ Draft kept, not valid yet/);
 assert.ok(document.querySelector('.visit-selector-error[role="alert"]'));
 const field=document.querySelector('[aria-label$="selector"][aria-invalid="true"], .visit-step-summary[aria-describedby]');
 assert.ok(field);
 assert.ok(field.getAttribute('aria-describedby')||document.querySelector('[aria-describedby]'));
 const run=document.querySelector<HTMLButtonElement>('[aria-label^="Run scenario"]')!;
 assert.ok(run.disabled);
 assert.equal(run.getAttribute('aria-label'),'Run scenario — Draft kept, not valid yet');
}));

test('autosave paused by the picker keeps the workspace status without a floating Save button',()=>journey(async({document,click,fill,holdPicker,settle})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 await click('Add action to Home');
 await fill('Action 2 selector','Gear');
 await editVisitField(document,'Action 2 selector');
 await act(async()=>{
  const element=[...document.querySelectorAll('label')].find(node=>node.textContent==='Element')?.querySelector('input');
  element?.click();
 });
 holdPicker();
 await act(async()=>{document.querySelector<HTMLButtonElement>('.pick-from-screen')!.click();});
 await act(async()=>{
  const refresh=[...document.querySelectorAll<HTMLButtonElement>('.picker button')].find(button=>/Refresh screen|Inspecting/.test(button.textContent??''));
  assert.ok(refresh,'Pick from screen opens the picker card');
  refresh.click();
 });
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,80));await settle();});
 assert.match(document.querySelector('.picker button.confirm')?.textContent??'',/Inspecting/);
 assert.equal([...document.querySelectorAll('button')].some(button=>button.textContent==='Save'),false,'Save stays off the simulator state control while the picker pauses autosave');
 assert.match(document.querySelector('.workspace-save-status')?.getAttribute('title')??'',/while the picker is open/);
 assert.equal(document.querySelector('.workspace-save-text')?.textContent,'Unsaved changes · Autosave paused');
}));

test('autosave paused without a runner keeps edits in-tab with leave warning and no Save button',()=>journey(async({document,fill,setToken,settle})=>{
 await setToken('');
 await inspectScreen(document,{title:'Home'},{number:1});
 await fill('Check 1 selector','Home screen');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,80));await settle();});
 const status=document.querySelector('.workspace-save-status')!;
 assert.equal(status.querySelector('.workspace-save-text')?.textContent,'Unsaved changes · Autosave paused');
 assert.match(status.getAttribute('title')??'',/Changes are kept in this tab/);
 assert.match(status.getAttribute('title')??'',/Autosave resumes automatically/);
 assert.equal([...document.querySelectorAll('button')].some(button=>button.textContent==='Save'),false);
 let warned=false;
 const leave=document.createEvent('BeforeUnloadEvent');
 leave.initEvent('beforeunload',false,true);
 Object.defineProperty(leave,'returnValue',{configurable:true,get:()=>warned?'Unsaved changes':'',set:(value:string)=>{warned=String(value).length>0;}});
 document.defaultView!.dispatchEvent(leave);
 assert.equal(warned&&leave.defaultPrevented,true);
}));
});
