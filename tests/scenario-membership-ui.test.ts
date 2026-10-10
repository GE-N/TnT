import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Scenarios} from '../src/scenarios.js';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
import {writeChecks} from '../shared/canvas-authoring.js';
import type {CanvasGraph} from '../server/canvas.js';

test('a second scenario reuses an existing node action through its scenario checkbox and runs its saved flow',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tnt-membership-ui-'));
 const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';let executed='';
 const service=createScenarios({root:directory,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=> '2.11.0',run:async({directory,flow})=>{
  executed=await readFile(flow,'utf8');
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{tapOnElement:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{visible:{textRegex:'^Done$'}}}},metadata:{depth:0,status:'COMPLETED'}}]));
  return {code:0,log:'Fixture',cleanup:{verified:true,detail:'Fixture exited'}};
 }}});
 const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
 const canvas:CanvasGraph={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'go',label:'Go',role:'action',reference,tap:{target:'text',match:'exact',value:'Go'}}]},{id:'done',title:'Done',x:400,y:0,tests:[{id:'ready',label:'Ready',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Done'}}]}],edges:[{id:'next',from:'home',to:'done',actionTestId:'go',assertionTestId:'ready',responseCondition:'Go to Done'}],paths:[{id:'first',name:'Scenario 1',screenId:'home',edgeIds:['next']},{id:'second',name:'Scenario 2',screenId:'home',edgeIds:[]}]};
 const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);
 const scenarios=['first','second'].map((id,index)=>({id,name:'Scenario '+(index+1),authoring:'canvas',pathId:id,steps:[],inputs:{},parameters:{},enabledHandlerIds:[]}));
 const workspace=await service.save({name:'Shared nodes',yaml,canvas,scenarios});
 const dom=new JSDOM('<div id="root"></div>');const document=dom.window.document;
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const pending:Promise<Response>[]=[];
 const request=async(path:string,options?:{body?:string})=>{try{const body=options?.body?JSON.parse(options.body):undefined;return Response.json(path==='/api/workspaces'?await service.save(body):path==='/api/canvas/references'?await service.references(body):path==='/api/runs'?await service.wait((await service.start(body)).id):await service.workspace(path.slice('/api/workspaces/'.length)));}catch(error){return Response.json({error:error instanceof Error?error.message:'Failed'},{status:400});}};
 const fetch=(path:string,options?:{body?:string})=>{const result=request(path,options);pending.push(result);return result;};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetch:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const click=async(label:string)=>act(async()=>{const node=[...document.querySelectorAll<HTMLElement>('button,summary,input[type=checkbox]')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(node,label);node.click();do{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pending.length);});
 try{
  await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId,bundleId:'com.example.App',launchBusy:false,onRunning:()=>{}})));
  await act(async()=>{const input=document.getElementById('open-workspace')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,workspace.id);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});await click('Open saved workspace');await click('Scenario 2');
  assert.ok(!document.querySelector('[aria-label="Action 1 selector"]'),'Another scenario action is not presented as active');
  await click('Run scenario');assert.match(document.querySelector('.run-error-toast')!.textContent!,/at least one screen check/);
  await click('Use existing actions/checks');await click('Scenarios');
  await click('Use Tap text · Go in Scenario 2');
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Action 1 selector"]')!.value,'Go');
  await click('Run scenario');assert.equal(document.querySelector('.result-tag')!.textContent,'passed');assert.match(executed,/tapOn/);assert.match(executed,/\^Done\$/);
  await click('Save workspace');await click('Open saved workspace');await click('Scenario 2');assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Action 1 selector"]')!.value,'Go');
  await click('Scenario 1');assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Action 1 selector"]')!.value,'Go');
  await click('Add check to Home');
  await act(async()=>{const input=document.querySelector('[aria-label="Screen Home"] [aria-label="Check 1 selector"]')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'First only');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await click('Save workspace');await click('Open saved workspace');await click('Scenario 2');
  assert.ok(!document.querySelector('[aria-label="Screen Home"] [aria-label="Check 1 selector"]'),'A new check belongs only to its authoring scenario');
  await click('Scenario 1');assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Screen Home"] [aria-label="Check 1 selector"]')!.value,'First only');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true,force:true});}
});
