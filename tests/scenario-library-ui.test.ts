import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement,useState} from 'react';
import {ScenarioLibrary} from '../src/scenario-library.js';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';
test('authors can create and switch independent scenario inputs and explicitly relink selected steps',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','IS_REACT_ACT_ENVIRONMENT'];const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);const document=dom.window.document;
 const catalog=[{kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'a'.repeat(64),label:'Step 1 · tapOn',command:'tapOn',assertion:false,preview:'tapOn: Load'}];
 function Host(){const [items,setItems]=useState<ScenarioDefinition[]>([]);const [selected,setSelected]=useState('');return createElement(ScenarioLibrary,{items,onChange:setItems,selected,onSelect:setSelected,catalog,files:['setup.yaml'],disabled:false,onError:()=>{}});}
 const click=async(name:string)=>act(async()=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent===name);assert.ok(button);button.click();});
 const fill=async(id:string,value:string)=>act(async()=>{const node=document.getElementById(id) as HTMLInputElement|HTMLTextAreaElement;assert.ok(node);Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));
  await click('Add scenario');await fill('definition-name','Maintenance');await fill('scenario-public-inputs','{"EXPECTED_PAGE":"Maintenance"}');await click('Apply scenario inputs');
  await click('Add scenario');await fill('definition-name','Success');await fill('scenario-public-inputs','{"EXPECTED_PAGE":"Success"}');await click('Apply scenario inputs');
  await click('Maintenance');assert.equal((document.getElementById('scenario-public-inputs') as HTMLTextAreaElement).value,'{\n  "EXPECTED_PAGE": "Maintenance"\n}');
  await click('Relink selected steps');assert.match(document.body.textContent!,/Step 1/);
  await fill('scenario-public-inputs','{broken draft');
  await click('Apply setup parameters');
  assert.equal([...document.querySelectorAll('button')].find(button=>button.textContent==='Success')?.disabled,true,'another field cannot unblock a pending JSON draft');
  await fill('scenario-public-inputs','{"EXPECTED_PAGE":"Maintenance"}');await click('Apply scenario inputs');
  await click('Success');assert.equal((document.getElementById('scenario-public-inputs') as HTMLTextAreaElement).value,'{\n  "EXPECTED_PAGE": "Success"\n}');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('deleting an identical selected command marks scenario references stale and Undo restores the original selection',async()=>{
 const {Scenarios}=await import('../src/scenarios.js');
 const {referenceCatalog}=await import('../server/canvas.js');
 const yaml='appId: com.example.App\n---\n- tapOn: Same\n- tapOn: Same\n';const catalog=referenceCatalog(yaml).references;
 const definition={id:'sample',name:'Sample',steps:[catalog[0]],inputs:{},parameters:{},setup:{file:'setup.yaml',parameters:{}},enabledHandlerIds:[]};
 const workspace={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'Shared',yaml,flows:{'setup.yaml':'appId: com.example.App\n---\n- assertVisible: Home\n'},scenarios:[definition]};
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','IS_REACT_ACT_ENVIRONMENT','fetch'];const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);let saved:any;
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='fetch'?async(path:string,options:{body?:string})=>{const value=path==='/api/workspaces'?(saved=JSON.parse(options.body!),{...workspace,...saved}):path.includes('/api/workspaces/')?workspace:{references:catalog,diagnostics:[]};return {ok:true,json:async()=>value};}:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);const document=dom.window.document;
 const click=async(name:string)=>act(async()=>{const button=[...document.querySelectorAll('button')].find(item=>(item.getAttribute('aria-label')??item.textContent)===name);assert.ok(button,name);button.click();});
 const fill=async(id:string,value:string)=>act(async()=>{const node=document.getElementById(id) as HTMLInputElement;Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Scenarios,{token:'test-token',deviceId:'',bundleId:'',launchBusy:false,onRunning:()=>{}})));
  await fill('open-workspace',workspace.id);await click('Open saved workspace');await click('Sample');
  await click('Command forms');await click('Delete step 1');await click('Delete anyway');await click('Save workspace');
  assert.match(saved.scenarios[0].steps[0].fingerprint,/^deleted:/);
  await click('Undo deletion');await click('Save workspace');assert.equal(saved.scenarios[0].steps[0].fingerprint,catalog[0].fingerprint);
  await fill('scenario-public-inputs','{pending draft');await click('Open saved workspace');
  assert.equal([...document.querySelectorAll('button')].find(button=>button.textContent==='Sample')?.disabled,false,'loading a workspace resets its previous draft guard');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
