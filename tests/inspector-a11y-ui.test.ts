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
import {refreshChecks,writeChecks} from '../shared/canvas-authoring.js';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';

const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
const same=(actual:unknown,expected:unknown,message='same node')=>assert.ok(actual===expected,message);

describe('inspector a11y keyboard journeys',{concurrency:false},()=>{

const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
const tap=(id:string,label:string,value:string):CanvasTest=>({id,label,role:'action',reference,tap:{target:'text',match:'exact',value}});
const check=(id:string,label:string,value:string):CanvasTest=>({id,label,role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value}});
function legacyCanvas(linked:boolean):CanvasGraph{
 return {
  screens:[
   {id:'home',title:'Home',x:0,y:0,tests:[tap('gear','tap Gear','Gear'),tap('profile','open Profile','Profile'),check('home-ready','Home','Home')]},
   {id:'settings',title:'Settings',x:400,y:0,tests:[check('settings-ready','Settings','Settings')]},
  ],
  edges:linked?[{id:'go',from:'home',to:'settings',actionTestId:'gear',assertionTestId:'settings-ready',responseCondition:'Home → Settings'}]:[],
  paths:[{id:'route',name:'Home checks',screenId:'home',edgeIds:linked?['go']:[],visits:linked?[{id:'visit-1',operationIds:['gear','home-ready']},{id:'visit-2',operationIds:['settings-ready']}]:[{id:'visit-1',operationIds:['gear','home-ready']}]}],
 };
}
const hostScenario={id:'scenario-host',name:'Legacy host',authoring:'canvas' as const,steps:[],inputs:{},parameters:{},enabledHandlerIds:[]};

async function journey(work:(ui:{
 document:Document;
 window:Window&typeof globalThis;
 click:(label:string)=>Promise<void>;
 fill:(label:string,value:string)=>Promise<void>;
 press:(target:Element,key:string)=>Promise<boolean>;
 holdNext:()=>void;
 failNext:(index?:number)=>void;
 settle:()=>Promise<void>;
})=>Promise<void>,legacy?:'stay'|'linked'){
 const directory=await mkdtemp(join(tmpdir(),'tnt-a11y-'));
 let fail=false;let failIndex=3;let hold=false;let returnRunning=false;let releaseHold:(()=>void)|undefined;
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
 const canvas:CanvasGraph=legacy?legacyCanvas(legacy==='linked'):{
  screens:[
   {id:'1',title:'Home',x:0,y:0,tests:[{id:'home-ready',label:'Home',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Home'}},{id:'go-2',label:'Go 2',role:'action',reference,tap:{target:'text',match:'exact',value:'Go 2'}},{id:'stay',label:'Stay',role:'action',reference,tap:{target:'text',match:'exact',value:'Stay'}}]},
   {id:'2',title:'Mid',x:400,y:0,tests:[{id:'mid-ready',label:'Mid',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Mid'}},{id:'go-3',label:'Go 3',role:'action',reference,tap:{target:'text',match:'exact',value:'Go 3'}}]},
   {id:'3',title:'End',x:800,y:0,tests:[{id:'end-ready',label:'End',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'End'}}]},
  ],
  edges:[
   {id:'12',from:'1',to:'2',actionTestId:'go-2',actionTestIds:['go-2'],assertionTestId:'mid-ready',responseCondition:'1 → 2'},
   {id:'23',from:'2',to:'3',actionTestId:'go-3',actionTestIds:['go-3'],assertionTestId:'end-ready',responseCondition:'2 → 3'},
  ],
  paths:[],
 };
 const blank={screens:[],edges:[],paths:[]};
 const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',blank,canvas);
 const saved=await service.save({name:'A11y keyboard',yaml,canvas:refreshChecks(canvas,yaml),scenarios:legacy?[hostScenario]:[]});
 if(legacy)await service.saveView(saved.id,{format:1,pathId:'route',scenarioId:hostScenario.id,scenarioName:hostScenario.name,canvas:{selectedScreenId:'home',selectedVisitId:'visit-1',zoom:.85,scrollLeft:0,scrollTop:0}});
 const dom=new JSDOM('<div id="root"></div>');const document=dom.window.document;const window=dom.window as unknown as Window&typeof globalThis;
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
 const fetch=(path:string,options?:{body?:string})=>{const result=request(path,options);pending.push(result);return result;};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetch:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const settle=async()=>{do{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pending.length);};
 const click=async(label:string)=>{
  const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});
  if(label==='Save workspace'||label==='Open saved workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open',settle);
  if(await addVisitStep(document,label))return;
  await commitVisitEdits(document);
  const matches=(node:HTMLElement)=>node.getAttribute('data-testid')!=='scenario-bar-trigger'&&(node.getAttribute('aria-label')??node.textContent)===label;
  if(![...document.querySelectorAll<HTMLElement>('button,summary')].some(matches))await openScenarioPanel(document,act);
  return act(async()=>{
   const node=[...document.querySelectorAll<HTMLElement>('button,summary')].find(matches);
   assert.ok(node,label);
   assert.ok(!(node as HTMLButtonElement).disabled,label+' is enabled');
   node.click();
   await settle();
  });
 };
 const fill=async(label:string,value:string)=>{await editVisitField(document,label);await act(async()=>{const node=document.querySelector('[aria-label="'+label+'"]')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});await commitVisitEdits(document);};
 const press=async(target:Element,key:string)=>{
  let prevented=false;
  await act(async()=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});target.dispatchEvent(event);prevented=event.defaultPrevented;});
  return prevented;
 };
 try{
  await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId,bundleId:'com.example.App',launchBusy:false,onRunning:()=>{},simulatorConnected:true})));
  await settle();
  await click('Open saved workspace');
  if(!legacy){
   await click('New scenario');
   await click('Use Home as scenario start');
   await click('Append connection 1 → 2');
   await click('Append connection 2 → 3');
   await inspectScreen(document,{title:'Mid'},{number:2});
   await click('Add check to Mid');
   await fill('Check 1 selector','Mid');
   await inspectScreen(document,{title:'End'},{number:3});
   await click('Add check to End');
   await fill('Check 1 selector','End');
   await click('Finish sequence');
   await click('Save workspace');
  }else{
   await act(async()=>{await new Promise(resolve=>setTimeout(resolve,400));await settle();});
  }
  if(document.querySelector('[data-testid="scenario-panel"]'))await act(async()=>{document.querySelector<HTMLButtonElement>('[data-testid="scenario-bar-trigger"]')!.click();await settle();});
  await work({document,window,click,fill,press,holdNext:()=>{hold=true;returnRunning=true;},failNext:(index=5)=>{fail=true;failIndex=index;},settle});
 }finally{
  releaseHold?.();
  await settle();
  await act(async()=>root.unmount());
  dom.window.close();
  for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  await rm(directory,{recursive:true,force:true});
 }
}

test('step list stays one tab stop; arrows move; deleting the last focused row keeps a stop',()=>journey(async({document,press,settle})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 const card=inspectorCard(document)!;
 const summaries=()=>[...card.querySelectorAll<HTMLButtonElement>('.visit-step-summary')];
 assert.ok(summaries().length>=2);
 assert.equal(summaries().filter(item=>item.tabIndex===0).length,1);
 summaries()[0].focus();
 await press(summaries()[0],'ArrowDown');
 same(document.activeElement,summaries()[1]);
 assert.equal(summaries().filter(item=>item.tabIndex===0).length,1);
 const last=summaries().at(-1)!;
 last.focus();
 await press(last,'End');
 same(document.activeElement,summaries().at(-1));
 const lastId=summaries().at(-1)!.closest<HTMLElement>('[data-operation-id]')!.dataset.operationId!;
 await act(async()=>{
  const row=card.querySelector(`[data-operation-id="${lastId}"]`)!;
  row.querySelector<HTMLButtonElement>('.step-actions-trigger')!.click();
  await settle();
 });
 await act(async()=>{
  document.querySelector<HTMLButtonElement>('.step-actions-menu [aria-label^="Delete "]')!.click();
  await settle();
 });
 assert.equal(summaries().some(item=>item.closest<HTMLElement>('[data-operation-id]')?.dataset.operationId===lastId),false);
 assert.equal(summaries().filter(item=>item.tabIndex===0).length,1,'surviving rows keep exactly one list tab stop');
}));

test('discarding a new active row restores a surviving list tab stop',()=>journey(async({document,window,click,settle})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 const card=inspectorCard(document)!;
 const before=card.querySelectorAll('.visit-step-summary').length;
 await click('Add action to Home');
 await settle();
 assert.ok(card.querySelector('.visit-step-summary[aria-expanded="true"]'));
 await act(async()=>{
  const editing=card.querySelector('.visit-step-summary[aria-expanded="true"]')!.closest('.visit-step')!;
  const cancel=[...editing.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Cancel');
  assert.ok(cancel);cancel.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true}));cancel.click();
  await settle();
 });
 assert.equal(card.querySelectorAll('.visit-step-summary').length,before);
 assert.equal([...card.querySelectorAll<HTMLButtonElement>('.visit-step-summary')].filter(item=>item.tabIndex===0).length,1);
}));

test('running keeps one list tab stop and arrow navigation without unlocking edits',()=>journey(async({document,click,press,holdNext,settle})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 const card=inspectorCard(document)!;
 holdNext();
 await click('Run scenario');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));await settle();});
 const summaries=[...card.querySelectorAll<HTMLButtonElement>('.visit-step-summary')];
 assert.equal(summaries.filter(item=>item.tabIndex===0).length,1,'run keeps a composite list stop');
 summaries.find(item=>item.tabIndex===0)!.focus();
 await press(summaries.find(item=>item.tabIndex===0)!,'ArrowDown');
 assert.equal([...card.querySelectorAll<HTMLButtonElement>('.visit-step-summary')].filter(item=>item.tabIndex===0).length,1);
 assert.equal(card.querySelector('.visit-step-summary[aria-expanded="true"]'),null);
 assert.equal(card.querySelector('.add-visit-step'),null);
 await click('Stop scenario');
}));

test('edit tab order is fields → Destination → Pick → YAML → ✕',()=>journey(async({document,press})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 const card=inspectorCard(document)!;
 const row=[...card.querySelectorAll<HTMLElement>('[data-operation-id]')].find(item=>item.querySelector('.visit-step-summary')?.textContent?.includes('Stay'))
  ??[...card.querySelectorAll<HTMLElement>('[data-operation-id]')].find(item=>item.querySelector('.visit-step-summary')?.textContent?.includes('Go 2'))!;
 await act(async()=>row.querySelector<HTMLButtonElement>('.visit-step-summary')!.click());
 await act(async()=>row.querySelector<HTMLInputElement>('input[type=radio][value=id]')!.click());
 const selector=row.querySelector<HTMLInputElement>('[aria-label$=" selector"]')!;
 const labelOf=(element:Element|null)=>element?.getAttribute('aria-label')||(element?.textContent??'').replace(/\s+/g,' ').trim()||'';
 const stops=()=>[...card.querySelectorAll<HTMLElement>('button,input,select,textarea,summary,a[href]')].filter(element=>{
  if(element.tabIndex<0||element.closest('[hidden]')||(element as HTMLButtonElement).disabled||element.getAttribute('aria-disabled')==='true')return false;
  const details=element.closest('details');
  if(details&&!details.open&&element.tagName!=='SUMMARY')return false;
  if(element.tagName==='INPUT'&&(element as HTMLInputElement).type==='radio'){
   const group=[...card.querySelectorAll<HTMLInputElement>('input[type=radio]')].filter(item=>item.name===(element as HTMLInputElement).name);
   return element===(group.find(item=>item.checked)??group[0]);
  }
  return true;
 });
 selector.focus();
 const seen:string[]=[];
 for(let step=0;step<16&&!seen.at(-1)?.startsWith('Close ');step++){
  const active=document.activeElement as HTMLElement;
  seen.push(labelOf(active));
  const before=stops();
  const index=before.findIndex(item=>item===active||item.contains(active));
  const prevented=await press(active,'Tab');
  if(!prevented)before[index+1]?.focus();
 }
 const at=(part:string)=>seen.findIndex(label=>label===part||label.endsWith(part)||label.startsWith(part));
 assert.ok(at('matching')>=0&&at('matching')<at('destination'),seen.join(' | '));
 assert.ok(at('destination')<at('Pick from screen'),seen.join(' | '));
 assert.ok(at('Pick from screen')<at('Open YAML'),seen.join(' | '));
 assert.ok(at('Open YAML')<at('Close '),seen.join(' | '));
}));

test('shortcuts stay suppressed in fields; failed run announces status',()=>journey(async({document,press,failNext,click,settle})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 const card=inspectorCard(document)!;
 const row=card.querySelector<HTMLElement>('[data-operation-id]')!;
 await act(async()=>row.querySelector<HTMLButtonElement>('.visit-step-summary')!.click());
 const input=row.querySelector<HTMLInputElement>('[aria-label$=" selector"]')!;
 input.focus();
 assert.equal(await press(input,'ArrowDown'),false);
 same(document.activeElement,input);
 failNext(5);
 await click('Run scenario');
 await settle();
 await inspectScreen(document,{title:'End'},{number:3});
 const failed=inspectorCard(document)!.querySelector('.run-status-badge.failed');
 assert.ok(failed);
 assert.equal(failed.getAttribute('role'),'status');
 assert.match(failed.textContent??'',/Failed/);
 assert.equal(inspectorCard(document)!.querySelector('.visit-step-error')?.getAttribute('role'),'alert');
}));

const warning=(label:string)=>`⚠ "${label}" has no destination. Choose a screen, or set it to Stays on this screen.`;
function row(document:Document,id:string){return inspectorCard(document)!.querySelector<HTMLElement>(`[data-operation-id="${id}"]`)!;}
function summaries(document:Document){return [...inspectorCard(document)!.querySelectorAll<HTMLButtonElement>('.visit-step-summary')];}
function assertReachableStop(document:Document,id:string){
 const summary=row(document,id).querySelector<HTMLButtonElement>('.visit-step-summary')!;
 assert.equal(summaries(document).filter(item=>item.tabIndex===0).length,1);
 assert.equal(summary.tabIndex,0);
 summary.focus();
 assert.equal(document.activeElement,summary);
}

test('a persisted legacy stay row before visit steps keeps one reachable summary stop',()=>journey(async({document})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 assert.equal(row(document,'gear').querySelector('.visit-step-summary'),null);
 assert.equal(row(document,'gear').querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!.selectedOptions[0].textContent,'Stays on this screen');
 assert.equal(row(document,'profile').querySelector('.destination-warning p')?.textContent,warning('open Profile'));
 assertReachableStop(document,'home-ready');
},'stay'));

test('a persisted focused visit step that becomes a legacy stay row keeps one reachable summary stop',()=>journey(async({document,window,click,settle})=>{
 await inspectScreen(document,{title:'Home'},{number:1});
 const gear=row(document,'gear').querySelector<HTMLButtonElement>('.visit-step-summary')!;
 assert.equal(gear.tabIndex,0);
 await act(async()=>gear.click());
 const select=row(document,'gear').querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!;
 const stays=[...select.options].find(option=>option.textContent==='Stays on this screen')!.value;
 await act(async()=>{
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value')!.set!.call(select,stays);
  select.dispatchEvent(new window.Event('change',{bubbles:true}));
 });
 const dialog=document.querySelector('[role=alertdialog]');
 assert.ok(dialog);
 await act(async()=>[...dialog.querySelectorAll('button')].find(button=>button.textContent==='Remove link')!.click());
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,400));await settle();});
 assert.equal(row(document,'gear').querySelector('.visit-step-summary'),null);
 assert.equal(row(document,'gear').querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!.selectedOptions[0].textContent,'Stays on this screen');
 assert.equal(row(document,'profile').querySelector('.destination-warning p')?.textContent,warning('open Profile'));
 assertReachableStop(document,'home-ready');
 await click('Save workspace');
 await click('Open saved workspace');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,400));await settle();});
 await inspectScreen(document,{title:'Home'},{number:1});
 assert.equal(row(document,'gear').querySelector('.visit-step-summary'),null);
 assert.equal(row(document,'gear').querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!.selectedOptions[0].textContent,'Stays on this screen');
 assert.equal(row(document,'profile').querySelector('.destination-warning p')?.textContent,warning('open Profile'));
 assertReachableStop(document,'home-ready');
},'linked'));

});
