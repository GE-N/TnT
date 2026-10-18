import {addVisitStep,editVisitField,commitVisitEdits,inspected,inspectorCard,inspectorOwner,inspectScreen,openScenarioPanel,workspaceCommand} from './workspace-ui-helpers.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
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

async function journey(work:(ui:{document:Document;selectedCommand:(label:string)=>Promise<void>;click:(label:string)=>Promise<void>;fill:(label:string,value:string)=>Promise<void>;saved:()=>Promise<Awaited<ReturnType<ReturnType<typeof createScenarios>['workspace']>>>;service:ReturnType<typeof createScenarios>;failNext:(index?:number)=>void;holdNext:()=>void;calls:()=>number})=>Promise<void>,draft=false){
 const directory=await mkdtemp(join(tmpdir(),'tnt-sequences-ui-'));const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
 let fail=false;let failIndex=3;let hold=false;let liveBatch=false;let runCalls=0;let batchId='';
 const service=createScenarios({root:directory,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=> '2.11.0',run:async({directory,flow,signal})=>{
  runCalls++;if(hold){hold=false;await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});}
  const commands=parseAllDocuments(await readFile(flow,'utf8'))[1].toJS();
  const failing=fail;fail=false;
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="'+(failing?1:0)+'"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify(commands.map((command:any,index:number)=>({command:{[command==='back'?'backPressCommand':command==='launchApp'||command.launchApp?'launchAppCommand':command.tapOn?'tapOnElement':command.inputText?'inputTextCommand':'assertConditionCommand']:{}},metadata:{depth:0,status:failing&&index===failIndex?'FAILED':failing&&index>failIndex?'SKIPPED':'COMPLETED'}}))));
  return {code:failing?1:0,log:'Simulator boundary fixture',cleanup:{verified:true,detail:'Fixture exited'}};
 }}});
 async function startBatch(input:Parameters<typeof service.startBatch>[0]){const batch=await service.startBatch(input);batchId=batch.id;return liveBatch?batch:service.waitBatch(batch.id);}
 const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
 const canvas:CanvasGraph={screens:['1','2','3','4'].map((id,index)=>({id,title:id,x:400*index,y:0,tests:[{id:'check'+id,label:id,role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Screen '+id}}]})),edges:[],paths:[]};
 const edges=[['1','2'],['2','3'],['3','2'],['2','1'],['3','4']];
 for(const [from,to] of edges){const id=from+to;canvas.screens.find(screen=>screen.id===from)!.tests.push({id:'go'+id,label:'Go '+to,role:'action',reference,tap:{target:'text',match:'exact',value:'Go '+to}});canvas.edges.push({id,from,to,actionTestId:'go'+id,actionTestIds:['go'+id],assertionTestId:'check'+to,responseCondition:from+' → '+to});}
 if(draft){canvas.screens=canvas.screens.slice(0,2).map((screen,index)=>({...screen,title:index?'Details':'Home',tests:[]}));canvas.edges=[];}
 const workspace=await service.save({name:'Four shared nodes',yaml:writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas),canvas,scenarios:[]});
 const dom=new JSDOM('<div id="root"></div>');const document=dom.window.document;
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const pending:Promise<Response>[]=[];
 const request=async(path:string,options?:{body?:string})=>{try{const body=options?.body?JSON.parse(options.body):undefined;return Response.json(path==='/api/workspaces'?await service.save(body):path==='/api/scenarios/duplicate'?await service.duplicateScenario(body):path.startsWith('/api/workspaces?q=')?await service.listWorkspaces():path.endsWith('/open')?await service.openWorkspace(path.split('/')[3]):path==='/api/canvas/references'?await service.references(body):path==='/api/batches'?await startBatch(body):path.startsWith('/api/batches/')?(path.endsWith('/cancel')?await service.cancelBatch(path.split('/')[3]):await service.batch(path.split('/')[3])):path.startsWith('/api/runs/')?await service.result(path.slice('/api/runs/'.length)):path==='/api/runs'?await service.wait((await service.start(body)).id):await service.workspace(path.slice('/api/workspaces/'.length)));}catch(error){return Response.json({error:error instanceof Error?error.message:'Failed'},{status:400});}};
 const fetch=(path:string,options?:{body?:string})=>{const result=request(path,options);pending.push(result);return result;};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetch:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const click=async(label:string)=>{const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});if(await addVisitStep(document,label))return;await commitVisitEdits(document);if(label==='Save workspace'||label==='Open saved workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open',async()=>{do{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pending.length);});const scenarioMatch=(node:HTMLElement)=>node.getAttribute('data-testid')!=='scenario-bar-trigger'&&(node.getAttribute('aria-label')??node.textContent)===label;const scenarioReady=()=>label.startsWith('Actions for ')?!!document.querySelector('[aria-label="Scenario list"]'):[...document.querySelectorAll<HTMLElement>('button,summary')].some(scenarioMatch);if(!scenarioReady())await openScenarioPanel(document,act);return act(async()=>{if(label.startsWith('Actions for ')){const name=label.slice('Actions for '.length);const row=[...document.querySelectorAll<HTMLElement>('[aria-label="Scenario list"] [aria-pressed]')].find(node=>node.textContent===name);assert.ok(row,name);row.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:150,clientY:150}));return;}const node=[...document.querySelectorAll<HTMLElement>('[role="menu"] button'),...document.querySelectorAll<HTMLElement>('button,summary')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(node,label);assert.ok(!(node as HTMLButtonElement).disabled,label+' is enabled');node.click();do{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pending.length);})};
 const selectedCommand=async(label:string)=>{await openScenarioPanel(document,act);await click('Actions for '+document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')!.textContent);await click(label);};
 const fillRaw=async(label:string,value:string)=>{if(label==='Scenario name'||label==='Search scenarios'||label==='Rename scenario')await openScenarioPanel(document,act);if(label==='Scenario name'){const selected=document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')!;await click('Actions for '+selected.textContent);await click('Rename');await fill('Rename scenario',value);await act(async()=>document.querySelector('[aria-label="Rename scenario"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));return;}return act(async()=>{const node=document.querySelector('[aria-label="'+label+'"]')??document.getElementById([...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});};
 const fill=async(label:string,value:string)=>{await editVisitField(document,label);await fillRaw(label,value);await commitVisitEdits(document);};
 try{await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId,bundleId:'com.example.App',launchBusy:false,onRunning:()=>{}})));await click('Open saved workspace');await work({document,selectedCommand,click,fill,saved:()=>service.workspace(workspace.id),service,failNext:(index=3)=>{fail=true;failIndex=index;},holdNext:()=>{hold=true;liveBatch=true;},calls:()=>runCalls});}
 finally{if(batchId){const batch=await service.batch(batchId);if(batch.status==='running'||batch.status==='cancelling')await service.cancelBatch(batchId);await service.waitBatch(batchId);}await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true,force:true});}
}

test('sidebar duplication creates fresh scenario and visit identities while sharing canvas nodes and connections',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await fill('Scenario name','Original');await click('Use 1 as scenario start');await click('Save workspace');const before=await saved();
 await selectedCommand('Duplicate');await fill('Scenario name','Copy');await click('Save workspace');const after=await saved();
 assert.equal(after.scenarios!.length,2);assert.equal(after.canvas!.screens.length,4);assert.deepEqual(after.canvas!.edges,before.canvas!.edges);
 assert.notEqual(after.scenarios![0].id,after.scenarios![1].id);assert.notEqual(after.scenarios![0].pathId,after.scenarios![1].pathId);
 assert.notEqual(after.canvas!.paths[0].visits![0].id,after.canvas!.paths[1].visits![0].id);
 await selectedCommand('Delete');await click('Save workspace');assert.equal((await saved()).scenarios!.length,1);assert.equal((await saved()).canvas!.paths.length,1);await click('Original');
}));

test('three finite scenarios reuse four nodes, choose branches explicitly, save/reopen and run only their numbered visits',()=>journey(async({document,selectedCommand,click,fill,saved,failNext})=>{
 const routes=[['1','2','3','2','1'],['1','2','3','4'],['1','2','1']];
 for(const [index,route] of routes.entries()){
  await click('New scenario');await fill('Scenario name','Journey '+(index+1));await click('Use 1 as scenario start');
  assert.equal(document.querySelector('[aria-label="Scenario sequence"]')!.textContent,'1 · 1');
  await act(async()=>document.querySelector('[aria-label="Screen 4"]')!.dispatchEvent(new document.defaultView!.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120})));await click('Add 4 to scenario sequence');assert.match(document.querySelector('[role="alert"]')!.textContent!,/No connection.*1.*4/);
  for(let position=1;position<route.length;position++){
   await click('Append connection '+route[position-1]+' → '+route[position]);
   await inspectScreen(document,{title:route[position]},{number:position+1});await addVisitStep(document,'Add check to visit',document.querySelector('[aria-label="Visit '+(position+1)+' · '+route[position]+' operations"]')!);
   await inspectScreen(document,{title:route[position]},{number:position+1});await act(async()=>{const input=document.querySelector<HTMLInputElement>('[aria-label="Visit '+(position+1)+' · '+route[position]+' operations"] [aria-label="Check 1 selector"]')!;Object.getOwnPropertyDescriptor(document.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(input,'Screen '+route[position]);input.dispatchEvent(new document.defaultView!.Event('input',{bubbles:true}));});
  }
  await click('Finish sequence');await click('Save workspace');
  const snapshot=await saved();const path=snapshot.canvas!.paths.find(path=>path.id===snapshot.scenarios![index].pathId)!;
  assert.deepEqual(path.edgeIds,route.slice(1).map((to,i)=>route[i]+to));assert.equal(Reflect.get(path,'finished'),true);
  assert.equal(new Set(path.visits!.map(visit=>visit.id)).size,route.length);
 }
 const workspace=await saved();assert.equal(workspace.canvas!.screens.length,4);assert.equal(workspace.canvas!.edges.length,5);
 await click('Open saved workspace');
 for(const [index,route] of routes.entries()){
  await click('Journey '+(index+1));
  const strip=document.querySelector('[aria-label="Scenario sequence"]')!;assert.equal(strip.querySelector('[aria-pressed="true"]'),null,'Switching clears the previous scenario occurrence');assert.equal(strip.textContent,route.map((id,i)=>(i+1)+' · '+id).join(''));
  await click('Visit 3 · '+route[2]);assert.equal(strip.querySelector('[aria-pressed="true"]')!.getAttribute('aria-label'),'Visit 3 · '+route[2]);assert.equal(document.querySelector('.selected-screen')!.getAttribute('data-screen-id'),route[2]);
  await click('Run scenario');assert.equal(document.querySelector('.run-error-toast')?.textContent,undefined);assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
  const results=[...document.querySelectorAll('[aria-label="Visit execution details"] summary')].map(node=>node.textContent);assert.deepEqual(results,route.map((id,i)=>'Visit '+(i+1)+' · '+id+' · passed'));
 }
 assert.deepEqual((await saved()).canvas!.paths,workspace.canvas!.paths,'Selecting/running never changes a scenario sequence');
 const reportButtons=[...document.querySelectorAll<HTMLButtonElement>('[aria-label="Scenario reports"] button')];
 assert.equal(reportButtons.length,3,'All three independent reports remain inspectable');
 await click('Journey 1');
 assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Journey 3','Sidebar selection preserves the inspected report');
 await act(async()=>reportButtons[0].click());
 assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Journey 1');
 assert.equal(document.querySelectorAll('[aria-label="Visit execution details"] summary').length,5);
 await fill('Scenario name','Renamed Journey');await click('Save workspace');
 assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Journey 1','Authoring edits cannot rename historical evidence');
 await fill('Scenario name','Journey 1');
 await click('Journey 1');failNext(7);await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'assertion-failed');
 const failedVisits=[...document.querySelectorAll('[aria-label="Visit execution details"] summary')].map(node=>node.textContent);
 assert.equal(failedVisits.length,5);assert.match(failedVisits[1]!,/passed/);assert.match(failedVisits[3]!,/failed/);assert.ok(!failedVisits.at(-1)!.endsWith('passed'),'A check failure stops the finite route');
 await click('Inspect visit 4');
 const evidence=document.querySelector('[aria-label="Execution evidence"]');assert.ok(evidence,'Selecting a visit opens its evidence inspector');
 assert.match(evidence.textContent!,/Expected/);assert.match(evidence.textContent!,/Screen 2/);assert.match(evidence.textContent!,/FAILED/);assert.match(evidence.textContent!,/Screenshot evidence unavailable/);assert.match(evidence.textContent!,/Simulator boundary fixture/);
 await click('Inspect transition 4');assert.match(document.querySelector('[aria-label="Execution evidence"]')!.textContent!,/skipped/);
 await selectedCommand('Duplicate');await fill('Scenario name','Return copy');await click('Save workspace');const duplicated=await saved();
 const original=workspace.canvas!.paths[0];const copy=duplicated.canvas!.paths.at(-1)!;assert.deepEqual(copy.edgeIds,original.edgeIds);assert.ok(copy.visits!.every(visit=>!original.visits!.some(item=>item.id===visit.id)));assert.equal(Reflect.get(copy,'finished'),true);
 await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');

}));

test('action destinations support connection reuse and contextual ordered actions without route forms',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await fill('Scenario name','Drawn journey');await click('Use 1 as scenario start');
 const node=await inspectScreen(document,{title:'1'});
 assert.ok(!node.querySelector('.canvas-navigation-actions'));await click('Add action to 1');
 await fill('Action 1 selector','Focus field');
 const select=async(label:string,value:string)=>{await editVisitField(document,label);await act(async()=>{const input=document.querySelector<HTMLSelectElement>('[aria-label="'+label+'"]')!;assert.ok(input,label);input.value=value;input.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);};
 await select('Action 1 destination','4');await click('Add action to 1');await select('Action 2 type','input');await fill('Action 2 text','hello');await select('Action 2 destination','4');await click('Add action to 1');await select('Action 3 type','back');await select('Action 3 destination','4');
 await click('Finish sequence');await click('Save workspace');const first=await saved();const firstPath=first.canvas!.paths.at(-1)!;const visitIds=firstPath.visits!.map(visit=>visit.id);
 assert.equal(firstPath.edgeIds.length,1);const edge=first.canvas!.edges.at(-1)!;
 assert.deepEqual(edge.actionTestIds!.map(id=>first.canvas!.screens[0].tests.find(test=>test.id===id)!.input??first.canvas!.screens[0].tests.find(test=>test.id===id)!.back??first.canvas!.screens[0].tests.find(test=>test.id===id)!.tap!.value),['Focus field','hello',true]);
 await select('Action 1 destination','4');await click('Save workspace');assert.deepEqual((await saved()).canvas!.paths.at(-1)!.visits!.map(visit=>visit.id),visitIds,'Choosing a destination after Finish never extends the sequence');
 await fill('Connection name '+edge.id,'First choice');await click('New scenario');await click('Use 1 as scenario start');await act(async()=>document.querySelector('[aria-label="Screen 4"]')!.dispatchEvent(new document.defaultView!.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120})));await click('Add 4 to scenario sequence');assert.equal(document.querySelector('[role="alert"]'),null);
 await click('Finish sequence');await click('Save workspace');
 assert.deepEqual((await saved()).canvas!.paths.at(-1)!.edgeIds,[edge.id]);
 await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
 assert.ok(!document.querySelector('.workspace-canvas select[aria-label="Next transition"]'));
 assert.ok(!document.querySelector('.workspace-canvas select[aria-label="Source screen"]'));
}));


test('a node action keeps its destination picker in the default canvas',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await click('Use Home as scenario start');await click('Add action to Home');await fill('Action 1 selector','Details');
 assert.ok(!document.querySelector('[aria-label^="Connect from"]'));assert.ok(!document.body.textContent!.includes('Selector tools'));
 const destination=document.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]');assert.ok(destination,'The action must let the author choose its destination');
 await editVisitField(document,'Action 1 destination');await act(async()=>{destination.value='2';destination.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);
 await click('Save workspace');const graph=(await saved()).canvas!;assert.equal(graph.edges.length,1);assert.equal(graph.edges[0].to,'2');assert.equal(graph.edges[0].actionTestId,graph.screens[0].tests[0].id);assert.deepEqual(graph.paths[0].edgeIds,[graph.edges[0].id]);
},true));

test('a new blank check stays local, exposes its inline error and blocks execution until valid',()=>journey(async({document,click,fill})=>{
 await click('New scenario');await fill('Scenario name','Repair journey');await click('Use Home as scenario start');await click('Add check to Home');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350));});
 const run=document.querySelector<HTMLButtonElement>('[aria-label^="Run scenario"]')!;
 assert.ok(run.disabled);assert.equal(run.getAttribute('aria-label'),'Run scenario — Draft kept, not valid yet');
 const input=document.querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;assert.equal(input.getAttribute('aria-invalid'),'true');assert.match(input.closest('.visit-step')!.textContent!,/Enter text|selector/);assert.equal(document.querySelector('.result-tag'),null);
 await fill('Check 1 selector','Home');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
 await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
},true));

test('choosing action destinations creates connections and an action-only Home Details Back journey runs without mandatory checks',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await click('Use Home as scenario start');await click('Add action to Home');await fill('Action 1 selector','Details');
 await inspectScreen(document,{title:'Home'});await editVisitField(document,'Action 1 destination');await act(async()=>{const destination=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;destination.value='2';destination.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await click('Save workspace');
 const graph=(await saved()).canvas!;assert.equal(graph.edges[0].actionTestId,graph.screens[0].tests[0].id,'Choosing a destination must attach the existing action rather than creating an empty connection');
 assert.equal((await inspectScreen(document,{title:'Details'})).querySelector('.screen-check-guidance')?.textContent,undefined);
 assert.ok(![...document.querySelectorAll('button')].some(button=>button.textContent==='Append visit'),'Redundant append controls are removed');
 await click('Add action to Details');await inspectScreen(document,{title:'Details'});await editVisitField(document,'Action 1 type');await act(async()=>{const kind=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 type"]')!;kind.value='back';kind.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);
 await inspectScreen(document,{title:'Details'});await editVisitField(document,'Action 1 destination');await act(async()=>{const destination=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;destination.value='1';destination.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);
 assert.equal(inspectorCard(document)!.querySelector<HTMLInputElement>('[aria-label="Action 1 selector"]')?.value,'Back');
 await click('Save workspace');const backWorkspace=await saved();assert.equal(backWorkspace.canvas!.screens[1].tests[0].back,true);assert.deepEqual(backWorkspace.canvas!.screens[1].tests[0].backSelector,{target:'text',match:'exact',value:'Back'});assert.match(backWorkspace.yaml,/tapOn:[\s\S]*\^Back\$/);
 await inspectScreen(document,{title:'Details'});await editVisitField(document,'Action 1 selector');await act(async()=>{const selector=inspectorCard(document)!.querySelector<HTMLInputElement>('[aria-label="Action 1 selector"]')!;Object.getOwnPropertyDescriptor(document.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(selector,'Go back');selector.dispatchEvent(new document.defaultView!.Event('input',{bubbles:true}));});await commitVisitEdits(document);await click('Save workspace');const customized=await saved();assert.equal(customized.canvas!.screens[1].tests[0].back,true);assert.equal(customized.canvas!.screens[1].tests[0].backSelector!.value,'Go back');assert.match(customized.yaml,/\^Go back\$/);
 await click('Run scenario');assert.equal(document.querySelector('.run-error-toast')?.textContent,undefined);assert.equal(document.querySelector('.result-tag')!.textContent,'passed');assert.deepEqual([...document.querySelectorAll('.step-results code')].map(node=>node.textContent),['launchApp','tapOn','tapOn']);
 await click('Add check to Details');await fill('Check 1 selector','Details');await click('Add check to Home');await fill('Check 1 selector','Home');
 await click('Run scenario');assert.equal(document.querySelector('.run-error-toast')?.textContent,undefined);assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
},true));


test('actions and checks share one reorderable node list and execute in that order',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await click('Use Home as scenario start');await click('Add action to Home');await fill('Action 1 selector','Focus field');
 await inspectScreen(document,{title:'Home'});await editVisitField(document,'Action 1 destination');await act(async()=>{const destination=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;destination.value='2';destination.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);
 assert.ok(![...document.querySelectorAll('legend')].some(node=>node.textContent?.startsWith('Actions to reach')));
 assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!.value,'2');
 await click('Add check to Home');await fill('Check 1 selector','Ready');assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="Move check 1 down"]')!.disabled,true,'Last step cannot move down');
 await click('Save workspace');const graph=(await saved()).canvas!;assert.equal(graph.screens[0].tests[0].tap?.value,'Focus field');assert.equal(graph.screens[0].tests[1].check?.value,'Ready');
 await click('Run scenario');assert.equal(document.querySelector('.run-error-toast')?.textContent,undefined);assert.deepEqual([...document.querySelectorAll('.step-results code')].map(node=>node.textContent),['launchApp','tapOn','assertVisible']);
 await click('Move check 1 up');await click('Run scenario');assert.deepEqual([...document.querySelectorAll('.step-results code')].map(node=>node.textContent),['launchApp','assertVisible','tapOn']);
},true));


test('editing one grouped action destination preserves the other action and its saved sequence',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 const destination=async(value:string)=>{await editVisitField(document,'Action 2 destination');await act(async()=>{const select=document.querySelector<HTMLSelectElement>('[aria-label=\"Action 2 destination\"]')!;select.value=value;select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);};
 await click('New scenario');await click('Use Home as scenario start');await click('Add action to Home');await fill('Action 1 selector','Focus field');await inspectScreen(document,{title:'Home'});await editVisitField(document,'Action 1 destination');await act(async()=>{const destination=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;destination.value='2';destination.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);
 await click('Add action to Home');await fill('Action 2 selector','Details');await editVisitField(document,'Action 2 destination');await act(async()=>{const field=document.querySelector<HTMLSelectElement>('[aria-label="Action 2 destination"]')!;field.value='2';field.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await click('Save workspace');const initial=(await saved()).canvas!;const edge=initial.edges[0];
 await destination('1');await click('Save workspace');const changed=(await saved()).canvas!;assert.equal(changed.edges.find(item=>item.id===edge.id)!.to,'2');assert.deepEqual(changed.edges.find(item=>item.id===edge.id)!.actionTestIds,[edge.actionTestIds![0]]);assert.equal(changed.edges.find(item=>item.actionTestId===edge.actionTestIds![1])!.to,'1');assert.deepEqual(changed.paths[0].edgeIds,[changed.edges.find(item=>item.actionTestId===edge.actionTestIds![1])!.id]);
 await destination('2');await destination('');assert.ok(document.querySelector('[role="alertdialog"]'));assert.match(document.querySelector('[role="alertdialog"]')!.textContent!,/Remove the link to/);await click('Remove link');await click('Save workspace');const cleared=(await saved()).canvas!;assert.equal(cleared.edges.length,1);assert.deepEqual(cleared.edges[0].actionTestIds,[edge.actionTestIds![0]]);assert.deepEqual(cleared.paths[0].visits!.map(visit=>visit.id),initial.paths[0].visits!.slice(0,1).map(visit=>visit.id));
 await click('New scenario');await click('Use Home as scenario start');await click('Add action to Home');await fill('Action 1 selector','Details');await editVisitField(document,'Action 1 destination');await act(async()=>{const select=document.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;select.value='2';select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await click('Save workspace');assert.deepEqual((await saved()).canvas!.paths.at(-1)!.edgeIds,[edge.id]);await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
},true));


test('retargeting the first grouped picker action saves distinct connections and preserves its sibling',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 const destination=async(value:string)=>{await editVisitField(document,'Action 1 destination');await act(async()=>{const select=document.querySelector<HTMLSelectElement>('[aria-label=\"Action 1 destination\"]')!;select.value=value;select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);};
 await click('New scenario');await click('Use Home as scenario start');await click('Add action to Home');await fill('Action 1 selector','Focus');await destination('2');await click('Add action to Home');await fill('Action 2 selector','Details');await editVisitField(document,'Action 2 destination');await act(async()=>{const field=document.querySelector<HTMLSelectElement>('[aria-label="Action 2 destination"]')!;field.value='2';field.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await click('Save workspace');const initial=(await saved()).canvas!;
 await destination('1');await click('Save workspace');const changed=(await saved()).canvas!;assert.equal(changed.edges.length,2);assert.equal(new Set(changed.edges.map(edge=>edge.id)).size,2);const original=changed.edges.find(edge=>edge.id===initial.edges[0].id)!;assert.equal(original.to,'2');assert.deepEqual(original.actionTestIds,[initial.screens[0].tests[1].id]);assert.deepEqual(changed.paths[0].visits,initial.paths[0].visits);
},true));

test('node visit sections isolate the return check and follow the selected scenario after save and reopen',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await fill('Scenario name','Return journey');await click('Use Home as scenario start');await click('Add action to Home');await fill('Action 1 selector','Details');await inspectScreen(document,{title:'Home'});await editVisitField(document,'Action 1 destination');await act(async()=>{const destination=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;destination.value='2';destination.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await click('Add action to Details');
 await inspectScreen(document,{title:'Details'});await editVisitField(document,'Action 1 type');await act(async()=>{const kind=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 type"]')!;kind.value='back';kind.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await inspectScreen(document,{title:'Details'});await editVisitField(document,'Action 1 destination');await act(async()=>{const destination=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;destination.value='1';destination.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);
 await click('Visit 3 · Home');
 const section=(await inspected(document,'Home')).querySelector<HTMLElement>('[aria-label="Visit 3 · Home operations"]');assert.ok(section,'Home must expose an independent section for its third visit');
 await addVisitStep(document,'Add check to Home',section);
 await act(async()=>{const input=section.querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;Object.getOwnPropertyDescriptor(document.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(input,'Returned Home');input.dispatchEvent(new document.defaultView!.Event('input',{bubbles:true}));});await commitVisitEdits(document);
 assert.equal((await inspected(document,'Home',1)).querySelector('[aria-label="Visit 1 · Home operations"] [aria-label="Check 1 selector"]'),null);
 await click('Save workspace');await click('Open saved workspace');await click('Run scenario');assert.equal(document.querySelector('.run-error-toast')?.textContent,undefined);assert.equal(document.querySelector('.result-tag')!.textContent,'passed');assert.deepEqual([...document.querySelectorAll('.step-results code')].map(node=>node.textContent),['launchApp','tapOn','tapOn','assertVisible']);assert.equal(document.querySelector('[aria-label="Executed screen canvas"]'),null,'Reports do not create a second canvas');await click('Inspect visit 3');assert.match(document.querySelector('[aria-label="Execution evidence"]')!.textContent!,/Returned Home/);
 await click('New scenario');await fill('Scenario name','Home only');await click('Use Home as scenario start');assert.equal((await inspectScreen(document,{title:'Home'})).querySelectorAll('.canvas-visit-section').length,1);assert.ok(!(await inspected(document,'Home')).querySelector('[aria-label="Visit 3 · Home operations"]'),'Return visit must be removed');assert.equal((await inspectScreen(document,{title:'Details'})).querySelectorAll('.canvas-visit-section').length,0);
 await click('Add check to Home');await fill('Check 1 selector','Initial Home');await click('Save workspace');await click('Open saved workspace');await click('Home only');await click('Run scenario');assert.deepEqual([...document.querySelectorAll('.step-results code')].map(node=>node.textContent),['launchApp','assertVisible']);
 await click('Return journey');assert.equal((await inspectScreen(document,{title:'Home'})).querySelectorAll('.canvas-visit-section').length,2);assert.equal((await inspectScreen(document,{title:'Home'},{number:3})).querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!.value,'Returned Home');await click('Run scenario');assert.deepEqual([...document.querySelectorAll('.step-results code')].map(node=>node.textContent),['launchApp','tapOn','tapOn','assertVisible']);
},true));

test('editing, ordering and deleting visit steps keeps another visit and a duplicated scenario independent',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 const section=(number:number)=>document.querySelector<HTMLElement>('[aria-label="Visit '+number+' · 1 operations"]')!;
 const openSection=async(number:number)=>{await inspectScreen(document,{title:'1'},{number});return section(number);};
 const scopedClick=async(number:number,label:string)=>{await inspectScreen(document,{title:'1'},{number});if(await addVisitStep(document,label,section(number)))return;await act(async()=>{const button=[...section(number).querySelectorAll<HTMLButtonElement>('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label);assert.ok(button,label);button.click();});};
 const scopedFill=async(number:number,label:string,value:string)=>{await inspectScreen(document,{title:'1'},{number});await editVisitField(document,label,section(number));await act(async()=>{const input=section(number).querySelector<HTMLInputElement>('[aria-label="'+label+'"]')!;assert.ok(input,label);Object.getOwnPropertyDescriptor(document.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new document.defaultView!.Event('input',{bubbles:true}));});await commitVisitEdits(document);};
 await click('New scenario');await fill('Scenario name','Original visits');await click('Use 1 as scenario start');await click('Append connection 1 → 2');await click('Append connection 2 → 1');await click('Copy Visible text · Screen 1 to Visit 3');await scopedFill(3,'Check 1 selector','Returned original');assert.equal((await openSection(1)).querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!.value,'Screen 1');
 await click('Save workspace');const original=(await saved()).canvas!.paths[0];
 await selectedCommand('Duplicate');await fill('Scenario name','Independent copy');await scopedFill(1,'Check 1 selector','Copy initial');await scopedFill(1,'Action 1 selector','Copy details');await scopedFill(3,'Check 1 selector','Copy returned');await scopedClick(1,'Move check 1 down');await scopedClick(3,'Delete check 1');assert.equal(document.querySelector('[role="alertdialog"]'),null);
 await click('Save workspace');await click('Open saved workspace');await click('Independent copy');await click('Run scenario');assert.equal(document.querySelector('.run-error-toast')?.textContent,undefined);assert.deepEqual([...document.querySelectorAll('.step-results code')].map(node=>node.textContent),['launchApp','tapOn','assertVisible','tapOn']);assert.equal((await openSection(3)).querySelector('[aria-label="Check 1 selector"]'),null);
 await click('Original visits');assert.equal((await openSection(1)).querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!.value,'Screen 1');assert.equal((await openSection(1)).querySelector<HTMLInputElement>('[aria-label="Action 1 selector"]')!.value,'Go 2');assert.equal((await openSection(3)).querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!.value,'Returned original');await click('Run scenario');assert.deepEqual([...document.querySelectorAll('.step-results code')].map(node=>node.textContent),['launchApp','assertVisible','tapOn','tapOn','assertVisible']);assert.deepEqual((await saved()).canvas!.paths[0],original);
 await scopedClick(3,'Add action to 1');await scopedFill(3,'Action 1 selector','Go 2');await openSection(3);await editVisitField(document,'Action 1 destination');await act(async()=>{const select=section(3).querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;select.value='2';select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await click('Save workspace');const extended=await saved();const end=extended.canvas!.paths[0].visits!.at(-2)!;const operations=end.operationIds!.flatMap(id=>extended.canvas!.screens[0].tests.filter(test=>test.id===id));assert.deepEqual(operations.filter(test=>test.tap).map(test=>test.tap!.value),['Go 2']);await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
 await click('New scenario');await fill('Scenario name','Fresh journey');await click('Use 1 as scenario start');await click('Append connection 1 → 2');await click('Save workspace');const fresh=await saved();const start=fresh.canvas!.paths.at(-1)!.visits![0];assert.deepEqual(start.operationIds!.flatMap(id=>fresh.canvas!.screens[0].tests.filter(test=>test.id===id&&test.tap).map(test=>test.tap!.value)),['Go 2']);
}));

test('two visits can save more than thirty total node steps while keeping their own bounded lists',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await click('Use 1 as scenario start');await click('Append connection 1 → 2');await click('Append connection 2 → 1');
 for(const number of [1,3])for(let index=0;index<16;index++){
  await inspectScreen(document,{title:'1'},{number});await addVisitStep(document,'Add check to 1',document.querySelector('[aria-label="Visit '+number+' · 1 operations"]')!);
  await inspectScreen(document,{title:'1'},{number});await act(async()=>{const input=[...document.querySelectorAll<HTMLInputElement>('[aria-label="Visit '+number+' · 1 operations"] input[aria-label^="Check "][aria-label$=" selector"]')].at(-1)!;Object.getOwnPropertyDescriptor(document.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(input,'Visit '+number+' value '+index);input.dispatchEvent(new document.defaultView!.Event('input',{bubbles:true}));});await commitVisitEdits(document);
 }
 await click('Save workspace');assert.equal(document.querySelector('.run-error-toast')?.textContent,undefined);assert.ok((await saved()).canvas!.screens[0].tests.length>30);await click('Open saved workspace');assert.equal((await inspected(document,'1',1)).querySelectorAll('[aria-label="Visit 1 · 1 operations"] input[aria-label^="Check "][aria-label$=" selector"]').length,17);assert.equal((await inspected(document,'1',3)).querySelectorAll('[aria-label="Visit 3 · 1 operations"] input[aria-label^="Check "][aria-label$=" selector"]').length,16);await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
}));

test('changing a copied visit destination updates its route and keeps displaced checks available for explicit repair',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await fill('Scenario name','Original destination');await click('Use 1 as scenario start');await click('Append connection 1 → 2');await click('Add check to 2');await inspectScreen(document,{title:'2'},{number:2});await inspectScreen(document,{title:'2'},{number:2});await act(async()=>{const input=document.querySelector<HTMLInputElement>('[aria-label="Visit 2 · 2 operations"] [aria-label="Check 1 selector"]')!;Object.getOwnPropertyDescriptor(document.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(input,'Screen 2');input.dispatchEvent(new document.defaultView!.Event('input',{bubbles:true}));});await click('Save workspace');const original=(await saved()).canvas!.paths[0];
 await selectedCommand('Duplicate');await fill('Scenario name','Changed destination');await inspectScreen(document,{title:'1'},{number:1});await inspectScreen(document,{title:'1'},{number:1});await editVisitField(document,'Action 1 destination');await act(async()=>{const select=document.querySelector<HTMLSelectElement>('[aria-label="Visit 1 · 1 operations"] [aria-label="Action 1 destination"]')!;select.value='4';select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await fill('Action 1 selector','Go 4');
 assert.equal((await inspectScreen(document,{title:'4'})).querySelectorAll('.canvas-visit-section').length,1);assert.match((await inspected(document,'4')).querySelector('[aria-label="Visit 2 · 4 operations"]')!.textContent!,/previous destination/);await click('Run scenario');assert.match(document.querySelector('.run-error-toast')!.textContent!,/missing actions or checks/);await click('Remove from this visit');await click('Save workspace');await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');assert.deepEqual((await saved()).canvas!.paths[0],original);
 await click('Original destination');assert.equal((await inspected(document,'2',2)).querySelector<HTMLInputElement>('[aria-label="Visit 2 · 2 operations"] [aria-label="Check 1 selector"]')!.value,'Screen 2');await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
}));


test('repair follows a diagnostic visit identity even when the message contains a visit ID',()=>journey(async({document,selectedCommand,click,fill,saved,service})=>{
 await click('New scenario');await fill('Scenario name','Broken return check');await click('Use 1 as scenario start');await click('Append connection 1 → 2');await click('Append connection 2 → 1');await click('Save workspace');
 const workspace=await saved();const path=workspace.canvas!.paths[0];const last=path.visits!.at(-1)!;last.id='return-visit-uuid';delete last.operationIds;last.checkIds=['deleted-check'];await service.save(workspace);await click('Open saved workspace');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350));});
 await click('Repair Broken return check');assert.equal(document.activeElement?.closest('[data-visit-id]')?.getAttribute('data-visit-id'),'return-visit-uuid');
}));

test('linked actions and reusable checks expose their executed YAML expectations',()=>journey(async({document,click,saved,service})=>{
 const workspace=await saved();const yaml='appId: com.example.App\n---\n- launchApp\n- tapOn: Linked Settings\n- runFlow: settings.yaml\n';const flows={'settings.yaml':'appId: com.example.App\n---\n- assertVisible: Settings content\n'};
 const catalog=await service.references({yaml,flows});
 const canvas:CanvasGraph={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'linked-action',label:'Linked Settings',role:'action',reference:catalog.references[1]}]},{id:'settings',title:'Settings',x:400,y:0,tests:[{id:'linked-check',label:'Reusable Settings',role:'assertion',reference:catalog.references[2]}]}],edges:[{id:'settings-edge',from:'home',to:'settings',actionTestId:'linked-action',assertionTestId:'linked-check',responseCondition:'Open Settings'}],paths:[{id:'linked-route',scenarioId:'linked-scenario',name:'Linked route',screenId:'home',edgeIds:['settings-edge']}]};
 await service.save({...workspace,yaml,flows,canvas,scenarios:[{id:'linked-scenario',name:'Linked scenario',authoring:'canvas' as const,steps:catalog.references.filter(ref=>ref.kind==='step').map(ref=>({kind:'step' as const,file:'flow.yaml',index:ref.index,fingerprint:ref.fingerprint})),pathId:'linked-route',inputs:{},parameters:{},enabledHandlerIds:[]}]});await click('Open saved workspace');
 await click('Linked scenario');
 await click('Run scenario');await click('Inspect visit 1');assert.match(document.querySelector('[aria-label="Execution evidence"]')!.textContent!,/Linked Settings/);
 const expected=document.querySelector('[aria-label="Execution evidence"] pre')!.textContent!;assert.match(expected,/tapOn/);assert.match(expected,/Linked Settings/);
 await click('Inspect visit 2');assert.match(document.querySelector('[aria-label="Execution evidence"]')!.textContent!,/Settings content/);
}));


test('Run all shows independent batch outcomes and opens reports without changing authoring selection',()=>journey(async({document,selectedCommand,click,fill,failNext})=>{
 for(let index=1;index<=3;index++){
  await click('New scenario');await fill('Scenario name','Batch journey '+index);await click('Use 1 as scenario start');await click('Save workspace');
 }
 await click('Run all');
 const batch=document.querySelector('[aria-label="Batch report"]')!;
 assert.match(batch.textContent!,/completed/);assert.match(batch.textContent!,/Batch journey 1 · passed/);assert.match(batch.textContent!,/Batch journey 2 · passed/);assert.match(batch.textContent!,/Batch journey 3 · passed/);
 assert.equal(document.querySelectorAll('[aria-label="Scenario reports"] button').length,3);
 await click('Open report for Batch journey 1');assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Batch journey 1');
 assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')!.textContent,'Batch journey 3');
 await fill('Scenario name','Later edit');await click('Save workspace');
 assert.match(batch.textContent!,/Batch journey 3/);assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Batch journey 1');
}));


test('batch sidebar labels invalid drafts and still executes valid scenarios',()=>journey(async({document,click,fill})=>{
 await click('New scenario');await fill('Scenario name','Invalid draft');await click('Save workspace');
 await click('New scenario');await fill('Scenario name','Valid home');await click('Use 1 as scenario start');await click('Run all');
 const report=document.querySelector('[aria-label="Batch report"]')!;
 assert.match(report.textContent!,/Invalid draft · not-run/);assert.match(report.textContent!,/nonempty.*path/);assert.match(report.textContent!,/Valid home · passed/);
 assert.equal(document.querySelectorAll('[aria-label="Scenario reports"] button').length,1);
}));

test('batch sidebar shows running and queued states and cancels the remaining queue',()=>journey(async({document,selectedCommand,click,fill,holdNext,calls})=>{
 for(let index=1;index<=2;index++){await click('New scenario');await fill('Scenario name','Queued '+index);await click('Use 1 as scenario start');await click('Save workspace');}
 holdNext();await click('Run all');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1100));});
 const report=document.querySelector('[aria-label="Batch report"]')!;
 assert.match(report.textContent!,/Queued 1 · running/);assert.match(report.textContent!,/Queued 2 · queued/);
 await click('Cancel batch');assert.match(report.textContent!,/Batch · cancelled/);assert.match(report.textContent!,/Queued 1 · cancelled/);assert.match(report.textContent!,/Queued 2 · not-run/);assert.equal(calls(),1);
 await click('Open report for Queued 1');assert.equal(document.querySelector('.result-tag')!.textContent,'cancelled');
}));


test('row run targets an unselected scenario and search leaves saved order and batch scope intact',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 for(let index=1;index<=12;index++){await click('New scenario');await fill('Scenario name','Case '+index);await click('Use 1 as scenario start');}
 await click('Save workspace');const before=await saved();
 await fill('Search scenarios','Case 1');
 assert.equal(document.querySelectorAll('[aria-label="Scenario list"] [aria-pressed]').length,4);
 await click('Run Case 1');assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Case 1');
 await click('Clear search');await click('Actions for Case 2');await click('Run scenario');assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Case 2');
 assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')!.textContent,'Case 12');
 await fill('Search scenarios','Case 1');await click('Run all');
 assert.deepEqual([...document.querySelectorAll('[aria-label="Batch report"] button')].map(button=>button.textContent),before.scenarios!.map(item=>'Open report for '+item.name));
 assert.deepEqual((await saved()).scenarios,before.scenarios);
 await fill('Search scenarios','missing');assert.match(document.querySelector('[aria-label="Scenario list"]')!.textContent!,/No scenarios match/);
}));


test('row rename commits or cancels without changing identity, sequence or historical evidence',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await fill('Scenario name','Original name');await click('Use 1 as scenario start');await click('Run scenario');const before=await saved();
 await click('Actions for Original name');await click('Rename');await fill('Rename scenario','Cancelled');await click('Save workspace');assert.ok(document.querySelector('[aria-label="Rename scenario"]'),'Blur leaves the draft open');assert.equal((await saved()).scenarios![0].name,'Original name');
 await act(async()=>document.querySelector('[aria-label="Rename scenario"]')!.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 assert.ok([...document.querySelectorAll('button')].some(button=>button.textContent==='Original name'));
 await click('Actions for Original name');await click('Rename');await fill('Rename scenario','   ');
 await act(async()=>document.querySelector('[aria-label="Rename scenario"]')!.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
 assert.match(document.querySelector('[data-testid="scenario-panel"] [role="alert"]')!.textContent!,/nonempty/);
 await fill('Rename scenario','  Updated name  ');await act(async()=>document.querySelector('[aria-label="Rename scenario"]')!.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
 await click('Save workspace');const after=await saved();
 assert.deepEqual(after.scenarios,[{...before.scenarios![0],name:'Updated name'}]);
 assert.deepEqual(after.canvas!.paths,[{...before.canvas!.paths[0],name:'Updated name'}]);
 assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Original name');
 await click('Open saved workspace');await openScenarioPanel(document,act);assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')!.textContent,'Updated name');
}));


test('deleting an unselected row and undo restores saved references without overwriting later edits',()=>journey(async({document,selectedCommand,click,fill,saved,service})=>{
 await click('New scenario');await fill('Scenario name','Original');await click('Use 1 as scenario start');await click('Run scenario');
 await click('Actions for Original');await click('Duplicate');await fill('Scenario name','Other');await click('Save workspace');const initial=await saved();initial.canvas!.screens[0].tests[0].scenarioIds=initial.scenarios!.map(item=>item.id);await service.save(initial);await click('Open saved workspace');await click('Other');await click('Run Original');const before=await saved();
 await click('Actions for Original');await click('Delete');
 assert.match(document.querySelector('[data-testid="scenario-panel"] [role="status"]')!.textContent!,/\u201COriginal\u201D deleted/);
 assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')!.textContent,'Other');
 await fill('Scenario name','Later edit');await click('Save workspace');assert.equal((await saved()).scenarios!.length,1);
 assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Original');
 await click('Undo');await click('Save workspace');const restored=await saved();
 assert.deepEqual(restored.scenarios,[before.scenarios![0],{...before.scenarios![1],name:'Later edit'}]);
 assert.deepEqual(restored.canvas!.paths,[before.canvas!.paths[0],{...before.canvas!.paths[1],name:'Later edit'}]);
 assert.deepEqual(restored.canvas!.screens,before.canvas!.screens);
 await click('Open saved workspace');await click('Original');await click('Actions for Original');await click('Delete');await click('Actions for Later edit');await click('Delete');
 assert.match(document.querySelector('[aria-label="Scenario list"]')!.textContent!,/No scenarios yet/);await click('Save workspace');assert.equal((await saved()).scenarios!.length,0);
 await click('Undo');assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')!.textContent,'Later edit');await click('Save workspace');await click('Open saved workspace');assert.equal((await saved()).scenarios![0].name,'Later edit');
}));


test('right click and keyboard menus expose identical row commands without selecting their target',()=>journey(async({document,click,fill})=>{
 await click('New scenario');await fill('Scenario name','First');await click('Use 1 as scenario start');await click('New scenario');await fill('Scenario name','Second');
 const first=[...document.querySelectorAll<HTMLButtonElement>('[aria-label="Scenario list"] button')].find(button=>button.textContent==='First')!;
 await act(async()=>first.dispatchEvent(new document.defaultView!.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:150,clientY:150})));
 const commands=[...document.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"]')].map(node=>node.textContent);assert.deepEqual(commands,['Run scenario','Rename','Duplicate','Skip in Run All','Delete']);
 await act(async()=>document.activeElement!.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(document.activeElement,first);
 await act(async()=>first.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true})));assert.deepEqual([...document.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"]')].map(node=>node.textContent),commands);
 await act(async()=>document.activeElement!.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));assert.equal(document.activeElement!.textContent,'Rename');
 await act(async()=>document.activeElement!.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 await act(async()=>first.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true})));
 assert.deepEqual([...document.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"]')].map(node=>node.textContent),commands);
 assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')!.textContent,'Second');
 await click('Rename');await fill('Rename scenario','Discard this');await act(async()=>document.querySelector('[aria-label="Rename scenario"]')!.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(document.activeElement!.textContent,'First');
}));


test('an unselected row can duplicate its definition and dismissal clears the latest deletion notification',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await fill('Scenario name','Target');await click('Use 1 as scenario start');await click('Save workspace');const before=await saved();
 await click('New scenario');await fill('Scenario name','Selected');await click('Actions for Target');await click('Duplicate');await openScenarioPanel(document,act);await click('Save workspace');const after=await saved();
 assert.deepEqual(after.scenarios![2],{...before.scenarios![0],id:after.scenarios![2].id,pathId:after.scenarios![2].pathId,name:'Target copy'});
 assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')!.textContent,'Target copy');
 await click('Actions for Target');await click('Delete');await act(async()=>document.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(document.querySelector('[data-testid="scenario-panel"]'),null);
 await click('Save workspace');await click('Open saved workspace');assert.deepEqual((await saved()).scenarios!.map(item=>item.name),['Selected','Target copy']);
}));


test('authors can create, duplicate, restore and run more than twenty scenarios in saved order',()=>journey(async({document,selectedCommand,click,fill,saved,service})=>{
 for(let index=1;index<=21;index++){await click('New scenario');await fill('Scenario name','Large case '+index);await click('Use 1 as scenario start');}
 await click('Save workspace');let workspace=await saved();
 workspace.canvas!.screens[0].tests[0].scenarioIds=workspace.scenarios!.map(item=>item.id);await service.save(workspace);await click('Open saved workspace');
 await selectedCommand('Duplicate');await fill('Scenario name','Large copy');await click('Save workspace');workspace=await saved();
 assert.equal(workspace.scenarios!.length,22);assert.equal(workspace.canvas!.paths.length,22);assert.equal(workspace.canvas!.screens[0].tests[0].scenarioIds!.length,22);
 await selectedCommand('Delete');await click('New scenario');await fill('Scenario name','Later draft');await click('Undo');await click('Save workspace');
 const restored=await saved();assert.equal(restored.scenarios!.length,23);assert.equal(restored.canvas!.paths.length,23);assert.deepEqual(restored.canvas!.screens[0].tests[0].scenarioIds,workspace.canvas!.screens[0].tests[0].scenarioIds);
 await click('Open saved workspace');await click('Run all');
 const batch=document.querySelector('[aria-label="Batch report"]')!;assert.match(batch.textContent!,/Later draft · not-run/);
 assert.deepEqual([...batch.querySelectorAll('button')].map(button=>button.textContent),restored.scenarios!.slice(0,-1).map(item=>'Open report for '+item.name));
 const create=document.querySelector('[aria-label="Scenarios"] button[aria-label="New scenario"]')!;assert.equal(create.textContent,'+');
 assert.equal(document.querySelector('[aria-label="Scenarios"] button[aria-label^="Actions for "]'),null);
}));


test('a return to Home offers only visit-local authoring rather than continuing its earlier action',()=>journey(async({document,click,fill,saved})=>{
 const destination=async(screen:string,value:string)=>{await inspectScreen(document,{title:screen});await editVisitField(document,'Action 1 destination');await act(async()=>{const select=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;select.value=value;select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);};
 await click('New scenario');await click('Use Home as scenario start');await click('Add action to Home');await fill('Action 1 selector','Details');await destination('Home','2');
 await click('Add action to Details');await inspectScreen(document,{title:'Details'});await editVisitField(document,'Action 1 type');await act(async()=>{const kind=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 type"]')!;kind.value='back';kind.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await destination('Details','1');
 await click('Save workspace');const reproduced=await saved();assert.equal(reproduced.canvas!.paths[0].edgeIds.length,2);assert.deepEqual(reproduced.canvas!.paths[0].visits![2].operationIds,[]);
 const returned=(await inspected(document,'Home',3)).querySelector('[aria-label="Visit 3 · Home operations"]')!;assert.ok(returned);
 assert.equal(returned.querySelectorAll('.add-visit-step').length,1);await act(async()=>returned.querySelector<HTMLButtonElement>('.add-visit-step')!.click());assert.deepEqual([...document.querySelectorAll('[role=option]')].map(option=>option.textContent),['Tap','Input text','Back','assertVisible','assertNotVisible']);await act(async()=>document.querySelector('[role=combobox]')!.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
 assert.equal([...returned.querySelectorAll('button')].some(button=>button.textContent?.startsWith('Continue →')),false,'Visit 3 has no action leading to another visit');
 await click('Save workspace');await click('Open saved workspace');assert.equal((await inspected(document,'Details')).querySelector('[aria-label="Visit 4 · Details operations"]'),null);assert.equal((await saved()).canvas!.paths[0].edgeIds.length,2);
},true));

test('authors persist two skips, run ten searched cases in saved order, and restore skipped definitions',()=>journey(async({document,click,fill,saved,calls})=>{
 for(let index=1;index<=12;index++){await click('New scenario');await fill('Scenario name','Skip case '+index);await click('Use 1 as scenario start');}
 await click('Save workspace'); await click('Open saved workspace');await openScenarioPanel(document,act);
 const counts=()=>document.querySelector('[aria-label="Run All inclusion"]')!.textContent;
 assert.equal(counts(),'12 included · 0 skipped');
 // Right click exposes the checkable command for an unselected row.
 await click('Actions for Skip case 3');
 assert.equal(document.querySelector('[role="menuitemcheckbox"]')!.getAttribute('aria-checked'),'false');
 await click('Skip in Run All');
 await click('Actions for Skip case 10');
 await click('Skip in Run All');assert.equal(counts(),'10 included · 2 skipped');
 await click('Save workspace');const before=await saved();await click('Open saved workspace');
 await click('Actions for Skip case 3');assert.equal(document.querySelector('[role="menuitemcheckbox"]')!.getAttribute('aria-checked'),'true');
 await click('Rename');await fill('Rename scenario','Renamed skip');await act(async()=>document.querySelector('[aria-label="Rename scenario"]')!.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
 await click('Save workspace');assert.equal((await saved()).scenarios![2].skipInRunAll,true);
 await click('Actions for Renamed skip');await click('Delete');await click('Undo');await click('Save workspace');await click('Open saved workspace');
 assert.deepEqual((await saved()).scenarios![2],{...before.scenarios![2],name:'Renamed skip'});
 assert.deepEqual((await saved()).canvas!.screens,before.canvas!.screens);
 await fill('Search scenarios','Skip case 1');await click('Run all');
 assert.equal(counts(),'10 included · 2 skipped');
 assert.deepEqual([...document.querySelectorAll('[aria-label="Batch report"] button')].map(button=>button.textContent),['Skip case 1','Skip case 2','Skip case 4','Skip case 5','Skip case 6','Skip case 7','Skip case 8','Skip case 9','Skip case 11','Skip case 12'].map(name=>'Open report for '+name));
 assert.equal(calls(),10);
 await click('Clear search');await click('Run Renamed skip');assert.equal(document.querySelector('.scenario-result h3')!.textContent,'Renamed skip');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');assert.equal(calls(),11);
 await click('Actions for Renamed skip');await click('Skip in Run All');assert.equal(counts(),'11 included · 1 skipped');
 await click('Actions for Renamed skip');await click('Skip in Run All');await click('Actions for Renamed skip');await click('Duplicate');await openScenarioPanel(document,act);await click('Save workspace');
 assert.equal((await saved()).scenarios!.at(-1)!.skipInRunAll,true);assert.equal(counts(),'10 included · 3 skipped');
 for(const item of (await saved()).scenarios!.filter(item=>!item.skipInRunAll)){await click('Actions for '+item.name);await click('Skip in Run All');}
 assert.equal(counts(),'0 included · 13 skipped');
 const runAll=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Run all')!;assert.equal(runAll.disabled,true);
 await act(async()=>runAll.click());assert.equal(calls(),11);
 await click('Save workspace');await click('Open saved workspace');await openScenarioPanel(document,act);assert.equal(counts(),'0 included · 13 skipped');
 await click('Run Renamed skip');assert.equal(calls(),12);assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
}));

test('deleting a return action immediately removes its destination visit and Undo restores it',()=>journey(async({document,click,fill,saved})=>{
 await click('New scenario');await click('Use Home as scenario start');await click('Add action to Home');await fill('Action 1 selector','Details');
 const destination=async(screen:string,value:string)=>{await inspectScreen(document,{title:screen});await editVisitField(document,'Action 1 destination');await act(async()=>{const select=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;select.value=value;select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);};
 await destination('Home','2');await click('Add action to Details');await inspectScreen(document,{title:'Details'});await editVisitField(document,'Action 1 type');await act(async()=>{const select=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 type"]')!;select.value='back';select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await destination('Details','1');
 await inspectScreen(document,{title:'Details'});await act(async()=>inspectorCard(document)!.querySelector<HTMLButtonElement>('[aria-label="Delete action 1"]')!.click());
 assert.equal(document.querySelector('[role="alertdialog"]'),null);assert.ok(!(await inspected(document,'Home')).querySelector('[aria-label="Visit 3 · Home operations"]'));await click('Undo canvas deletion');
 assert.ok((await inspected(document,'Home')).querySelector('[aria-label="Visit 3 · Home operations"]'));
 await inspectScreen(document,{title:'Details'});await act(async()=>inspectorCard(document)!.querySelector<HTMLButtonElement>('[aria-label="Delete action 1"]')!.click());assert.equal(document.querySelector('[role="alertdialog"]'),null);
 assert.ok(!(await inspected(document,'Home')).querySelector('[aria-label="Visit 3 · Home operations"]'),'Return visit must be removed');
 await click('Undo canvas deletion');assert.ok((await inspected(document,'Home')).querySelector('[aria-label="Visit 3 · Home operations"]'));
 await inspectScreen(document,{title:'Details'});await act(async()=>inspectorCard(document)!.querySelector<HTMLButtonElement>('[aria-label="Delete action 1"]')!.click());assert.equal(document.querySelector('[role="alertdialog"]'),null);
 await click('Save workspace');assert.equal((await saved()).canvas!.paths[0].visits!.length,2);await click('Open saved workspace');assert.ok(!(await inspected(document,'Home')).querySelector('[aria-label="Visit 3 · Home operations"]'));await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
},true));

for(const mode of ['destination','node'] as const)test(mode+' cleanup preserves shared scenario steps and Undo history',()=>journey(async({document,selectedCommand,click,fill,saved})=>{
 await click('New scenario');await fill('Scenario name','Original');await click('Use Home as scenario start');
 const destination=async(screen:string,value:string)=>{await inspectScreen(document,{title:screen});await editVisitField(document,'Action 1 destination');await act(async()=>{const select=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;select.value=value;select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);};
 await click('Add action to Home');await fill('Action 1 selector','Details');await destination('Home','2');await click('Add action to Details');await inspectScreen(document,{title:'Details'});await editVisitField(document,'Action 1 type');await act(async()=>{const select=inspectorCard(document)!.querySelector<HTMLSelectElement>('[aria-label="Action 1 type"]')!;select.value='back';select.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});await commitVisitEdits(document);await destination('Details','1');
 await inspectScreen(document,{title:'Home'},{number:3});await addVisitStep(document,'Add check to visit',document.querySelector('[aria-label="Visit 3 · Home operations"]')!);await inspectScreen(document,{title:'Home'},{number:3});await act(async()=>{const section=document.querySelector('[aria-label="Visit 3 · Home operations"]')!;const input=section.querySelector('[aria-label="Check 1 selector"]')!;Object.getOwnPropertyDescriptor(document.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(input,'Returned');input.dispatchEvent(new document.defaultView!.Event('input',{bubbles:true}));});
 await click('Save workspace');await selectedCommand('Duplicate');await fill('Scenario name','Copy');await click('Save workspace');const before=(await saved()).canvas!;
 const remove=async()=>{if(mode==='destination')await destination('Details','');else{await act(async()=>document.querySelector('[aria-label="Screen Details"]')!.dispatchEvent(new document.defaultView!.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:100})));await click('Delete node');}};
 await remove();if(mode==='node'){assert.ok(document.querySelector('[role="alertdialog"]'));await click('Cancel deletion');}else{assert.ok(document.querySelector('[role="alertdialog"]'));assert.match(document.querySelector('[role="alertdialog"]')!.textContent||'',/Remove the link to/);await click('Cancel');}await click('Save workspace');assert.deepEqual((await saved()).canvas,before);
 await remove();if(mode==='node')await click('Delete anyway');else{assert.ok(document.querySelector('[role="alertdialog"]'));await click('Remove link');}assert.ok(!(await inspected(document,'Home')).querySelector('[aria-label="Visit 3 · Home operations"]'));await click('Save workspace');const after=(await saved()).canvas!;
 assert.equal(after.paths[1].visits!.length,mode==='node'?1:2);
 if(mode!=='node'){assert.deepEqual(after.paths[0],before.paths[0]);assert.equal(after.screens.length,2);await click('Original');assert.ok((await inspected(document,'Home')).querySelector('[aria-label="Visit 3 · Home operations"]'));await click('Run scenario');assert.equal(document.querySelector('.run-error-toast')?.textContent,undefined);assert.equal(document.querySelector('.result-tag')!.textContent,'passed');}
 else{assert.equal(after.paths[0].visits!.length,1);assert.ok(!after.screens.some(screen=>screen.title==='Details'));assert.equal(after.edges.length,0);}
},true));

test('the workspace library remains browsable during a batch while switching, New and copy wait for cleanup',()=>journey(async({document,click,holdNext})=>{
 await click('New scenario');await click('Use 1 as scenario start');await click('Save workspace');holdNext();await click('Run all');
 await click('Manage workspace');
 const manager=document.querySelector('[aria-label="Workspace manager"]')!;
 for(const label of ['New workspace','Save a copy','Rename workspace'])assert.equal([...manager.querySelectorAll<HTMLButtonElement>('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label)?.disabled,true);
 assert.ok(document.querySelector<HTMLButtonElement>('.workspace-library button')?.disabled);
 assert.match(manager.textContent!,/Active execution/);
 await click('Close workspace manager');await click('Cancel batch');
}));
