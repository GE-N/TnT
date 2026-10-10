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

async function journey(work:(ui:{document:Document;click:(label:string)=>Promise<void>;fill:(label:string,value:string)=>Promise<void>;saved:()=>Promise<Awaited<ReturnType<ReturnType<typeof createScenarios>['workspace']>>>;failNext:()=>void})=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'tnt-sequences-ui-'));const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
 let fail=false;
 const service=createScenarios({root:directory,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=> '2.11.0',run:async({directory,flow})=>{
  const commands=parseAllDocuments(await readFile(flow,'utf8'))[1].toJS();
  const failing=fail;fail=false;
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="'+(failing?1:0)+'"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify(commands.map((command:any,index:number)=>({command:{[command==='back'?'backPressCommand':command==='launchApp'||command.launchApp?'launchAppCommand':command.tapOn?'tapOnElement':command.inputText?'inputTextCommand':'assertConditionCommand']:{}},metadata:{depth:0,status:failing&&index===3?'FAILED':failing&&index>3?'SKIPPED':'COMPLETED'}}))));
  return {code:failing?1:0,log:'Simulator boundary fixture',cleanup:{verified:true,detail:'Fixture exited'}};
 }}});
 const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
 const canvas:CanvasGraph={screens:['1','2','3','4'].map((id,index)=>({id,title:id,x:400*index,y:0,tests:[{id:'check'+id,label:id,role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Screen '+id}}]})),edges:[],paths:[]};
 const edges=[['1','2'],['2','3'],['3','2'],['2','1'],['3','4']];
 for(const [from,to] of edges){const id=from+to;canvas.screens.find(screen=>screen.id===from)!.tests.push({id:'go'+id,label:'Go '+to,role:'action',reference,tap:{target:'text',match:'exact',value:'Go '+to}});canvas.edges.push({id,from,to,actionTestId:'go'+id,actionTestIds:['go'+id],assertionTestId:'check'+to,responseCondition:from+' → '+to});}
 const workspace=await service.save({name:'Four shared nodes',yaml:writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas),canvas,scenarios:[]});
 const dom=new JSDOM('<div id="root"></div>');const document=dom.window.document;
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const pending:Promise<Response>[]=[];
 const request=async(path:string,options?:{body?:string})=>{try{const body=options?.body?JSON.parse(options.body):undefined;return Response.json(path==='/api/workspaces'?await service.save(body):path==='/api/canvas/references'?await service.references(body):path==='/api/runs'?await service.wait((await service.start(body)).id):await service.workspace(path.slice('/api/workspaces/'.length)));}catch(error){return Response.json({error:error instanceof Error?error.message:'Failed'},{status:400});}};
 const fetch=(path:string,options?:{body?:string})=>{const result=request(path,options);pending.push(result);return result;};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetch:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const click=async(label:string)=>act(async()=>{const node=[...document.querySelectorAll<HTMLElement>('button,summary')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(node,label);assert.ok(!(node as HTMLButtonElement).disabled,label+' is enabled');node.click();do{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pending.length);});
 const fill=async(label:string,value:string)=>act(async()=>{const node=document.querySelector('[aria-label="'+label+'"]')??document.getElementById([...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 try{await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId,bundleId:'com.example.App',launchBusy:false,onRunning:()=>{}})));await fill('Saved workspace ID',workspace.id);await click('Open saved workspace');await work({document,click,fill,saved:()=>service.workspace(workspace.id),failNext:()=>{fail=true;}});}
 finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true,force:true});}
}

test('sidebar duplication creates fresh scenario and visit identities while sharing canvas nodes and connections',()=>journey(async({click,fill,saved})=>{
 await click('New scenario');await fill('Scenario name','Original');await click('Use 1 as scenario start');await click('Save workspace');const before=await saved();
 await click('Duplicate scenario');await fill('Scenario name','Copy');await click('Save workspace');const after=await saved();
 assert.equal(after.scenarios!.length,2);assert.equal(after.canvas!.screens.length,4);assert.deepEqual(after.canvas!.edges,before.canvas!.edges);
 assert.notEqual(after.scenarios![0].id,after.scenarios![1].id);assert.notEqual(after.scenarios![0].pathId,after.scenarios![1].pathId);
 assert.notEqual(after.canvas!.paths[0].visits![0].id,after.canvas!.paths[1].visits![0].id);
 await click('Delete scenario');await click('Save workspace');assert.equal((await saved()).scenarios!.length,1);assert.equal((await saved()).canvas!.paths.length,1);await click('Original');
}));

test('three finite scenarios reuse four nodes, choose branches explicitly, save/reopen and run only their numbered visits',()=>journey(async({document,click,fill,saved,failNext})=>{
 const routes=[['1','2','3','2','1'],['1','2','3','4'],['1','2','1']];
 for(const [index,route] of routes.entries()){
  await click('New scenario');await fill('Scenario name','Journey '+(index+1));await click('Use 1 as scenario start');
  assert.equal(document.querySelector('[aria-label="Scenario sequence"]')!.textContent,'1 · 1');
  await click('Append visit to 4');assert.match(document.querySelector('[role="alert"]')!.textContent!,/No connection.*1.*4/);
  for(let position=1;position<route.length;position++)await click('Append connection '+route[position-1]+' → '+route[position]);
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
  await click('Run scenario');assert.equal(document.querySelector('.run-error-toast'),null);assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
  const results=[...document.querySelectorAll('[aria-label="Visit execution details"] summary')].map(node=>node.textContent);assert.deepEqual(results,route.map((id,i)=>'Visit '+(i+1)+' · '+id+' · passed'));
 }
 assert.deepEqual((await saved()).canvas!.paths,workspace.canvas!.paths,'Selecting/running never changes a scenario sequence');
 await click('Journey 1');failNext();await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'assertion-failed');
 const failedVisits=[...document.querySelectorAll('[aria-label="Visit execution details"] summary')].map(node=>node.textContent);
 assert.equal(failedVisits.length,5);assert.match(failedVisits[1]!,/failed/);assert.ok(!failedVisits.at(-1)!.endsWith('passed'),'A check failure stops the finite route');
 await click('Duplicate scenario');await fill('Scenario name','Return copy');await click('Save workspace');const duplicated=await saved();
 const original=workspace.canvas!.paths[0];const copy=duplicated.canvas!.paths.at(-1)!;assert.deepEqual(copy.edgeIds,original.edgeIds);assert.ok(copy.visits!.every(visit=>!original.visits!.some(item=>item.id===visit.id)));assert.equal(Reflect.get(copy,'finished'),true);
 await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');

}));

test('canvas connection drawing supports keyboard selection, parallel choices and contextual ordered actions without route forms',()=>journey(async({document,click,fill,saved})=>{
 await click('New scenario');await fill('Scenario name','Drawn journey');await click('Use 1 as scenario start');
 await click('Connect from 1');await click('Select screen 4');
 const node=document.querySelector('[aria-label="Screen 1"]')!;
 const actionButton=[...node.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')==='Add action to connection 1 → 4');assert.ok(actionButton);await click('Add action to connection 1 → 4');
 await fill('1 → 4 action 1 selector','Focus field');await click('Add action to connection 1 → 4');
 const select=async(label:string,value:string)=>act(async()=>{const input=document.querySelector<HTMLSelectElement>('[aria-label="'+label+'"]')!;assert.ok(input,label);input.value=value;input.dispatchEvent(new document.defaultView!.Event('change',{bubbles:true}));});
 await select('1 → 4 action 2 type','input');await fill('1 → 4 action 2 text','hello');await click('Add action to connection 1 → 4');await select('1 → 4 action 3 type','back');
 await click('Finish sequence');await click('Save workspace');const first=await saved();const firstPath=first.canvas!.paths.at(-1)!;const visitIds=firstPath.visits!.map(visit=>visit.id);
 assert.equal(firstPath.edgeIds.length,1);const edge=first.canvas!.edges.at(-1)!;
 assert.deepEqual(edge.actionTestIds!.map(id=>first.canvas!.screens[0].tests.find(test=>test.id===id)!.input??first.canvas!.screens[0].tests.find(test=>test.id===id)!.back??first.canvas!.screens[0].tests.find(test=>test.id===id)!.tap!.value),['Focus field','hello',true]);
 await click('Connect from 1');await click('Select screen 4');await click('Save workspace');assert.deepEqual((await saved()).canvas!.paths.at(-1)!.visits!.map(visit=>visit.id),visitIds,'Drawing after Finish never extends the sequence');
 await click('New scenario');await click('Use 1 as scenario start');await click('Append visit to 4');assert.match(document.querySelector('[role="alert"]')!.textContent!,/Several connections/);
 await fill('Connection name '+edge.id,'First choice');await click('Append connection First choice');await click('Finish sequence');await click('Save workspace');
 assert.deepEqual((await saved()).canvas!.paths.at(-1)!.edgeIds,[edge.id]);
 await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
 assert.ok(!document.querySelector('.workspace-canvas select[aria-label="Next transition"]'));
 assert.ok(!document.querySelector('.workspace-canvas select[aria-label="Action 1 destination"]'));
}));
