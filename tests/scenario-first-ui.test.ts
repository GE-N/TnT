import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Scenarios} from '../src/scenarios.js';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';

test('an offline author creates a draft, adds ordered contextual checks, reopens and runs the selected scenario',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tnt-canvas-journey-'));
 const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
 const service=createScenarios({root:directory,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{visible:{textRegex:'^Home$'}}}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{notVisible:{textRegex:'^Error$'}}}},metadata:{depth:0,status:'COMPLETED'}}]));
  return {code:0,log:'External simulator fixture',cleanup:{verified:true,detail:'Fixture process exited'}};
 }}});
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const pendingRequests:Promise<Response>[]=[];
 const request=async(path:string,options?:{body?:string})=>{
  try{
   const body=options?.body?JSON.parse(options.body):undefined;
   const data=path==='/api/workspaces'?await service.save(body):path==='/api/canvas/references'?await service.references(body):path==='/api/runs'?await service.wait((await service.start(body)).id):path.startsWith('/api/workspaces/')?await service.workspace(path.slice('/api/workspaces/'.length)):undefined;
   return Response.json(data);
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Request failed'},{status:400});}
 };
 const fetch=(path:string,options?:{body?:string})=>{const response=request(path,options);pendingRequests.push(response);return response;};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetch:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);const document=dom.window.document;
 const render=async(device='')=>act(async()=>root.render(createElement(Scenarios,{token:'local',deviceId:device,bundleId:'com.example.App',launchBusy:false,onRunning:()=>{}})));
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(button,label);button.click();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});
 const field=(label:string)=>document.querySelector(`[aria-label="${label}"]`)??document.getElementById([...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor??'');
 const fill=async(label:string,value:string)=>act(async()=>{const node=field(label) as HTMLInputElement;assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const select=async(label:string,value:string)=>act(async()=>{const node=field(label) as HTMLSelectElement;assert.ok(node,label);node.value=value;node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await render();await click('New scenario');await fill('Scenario name','Home scenario');await click('Save workspace');
  const workspaceId=document.querySelector('.artifact-id')!.textContent!.replace('Workspace: ','');
  await fill('Saved workspace ID',workspaceId);await click('Open saved workspace');assert.ok([...document.querySelectorAll('button')].some(button=>button.textContent==='Home scenario'));
  await fill('New screen title','Home');await click('Add screen');await fill('Screen title','Welcome');await click('Use as scenario start');
  await click('Add check to Welcome');await fill('Check 1 selector','Home');
  await click('Add check to Welcome');await select('Check 2 visibility','absent');await fill('Check 2 selector','Error');
  assert.equal((field('Check 1 matching') as HTMLSelectElement).value,'exact');
  await click('Save workspace');await click('Open saved workspace');await click('Select screen Welcome');
  assert.equal((field('Check 1 selector') as HTMLInputElement).value,'Home');assert.equal((field('Check 2 visibility') as HTMLSelectElement).value,'absent');
  assert.equal(document.querySelector('select[aria-label="Scenario path"]')?.closest('details')?.open,false,'The default journey requires no route form');
  assert.equal([...document.querySelectorAll('button')].find(button=>button.textContent==='Run scenario')!.disabled,true,'Execution requires a device while authoring remains available');
  await render(deviceId);await click('Run scenario');
  assert.equal(document.querySelector('.result-tag')!.textContent,'passed');
  assert.match(document.querySelector('.scenario-result')!.textContent!,/Home scenario/);assert.match(document.querySelector('.scenario-result')!.textContent!,/Visible text · Home: passed/);assert.match(document.querySelector('.scenario-result')!.textContent!,/Absent text · Error: passed/);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true,force:true});}
});
