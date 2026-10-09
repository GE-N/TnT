import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {act,createElement,useState} from 'react';import {CanvasEditor} from '../src/canvas.js';import type {CanvasGraph,CatalogEntry} from '../server/canvas.js';
test('authors can associate an explicit checkpoint handler without losing its action identity',async()=>{
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 const handler:CatalogEntry={kind:'handler',file:'dismiss.yaml',index:1,actionId:'notice',fingerprint:'current',label:'Default action · Dismiss notice · before step 2',command:'runFlow',assertion:false,preview:'Dismiss notice'};
 let saved:CanvasGraph|undefined;
 function Host(){const [graph,setGraph]=useState<CanvasGraph>({screens:[{id:'home',title:'Home',x:0,y:0,tests:[]}],edges:[],paths:[]});return createElement(CanvasEditor,{graph,onChange:next=>{saved=next;if(next)setGraph(next);},catalog:[handler],diagnostics:[],pathId:'',onPathChange:()=>{},disabled:false});}
 const document=dom.window.document;
 const select=async(label:string,value:string)=>act(async()=>{const id=[...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor;assert.ok(id);const node=document.getElementById(id)!;Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));
  await select('Selected screen','home');await select('Executable YAML reference','0');
  await act(async()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='Associate test');assert.ok(button);button.click();});
  const association=saved!.screens[0].tests[0];assert.equal(association.role,'handler');assert.deepEqual(association.reference,{kind:'handler',file:'dismiss.yaml',index:1,actionId:'notice',fingerprint:'current'});
  assert.match(document.body.textContent!,/Handler notice · before step 2/);assert.doesNotMatch(document.body.textContent!,/#6.*unavailable/);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('canvas authors create inline checks, reorder, delete with warnings and undo synchronized YAML',async()=>{
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 let authored='';let saved:CanvasGraph|undefined;
 function Host(){const [graph,setGraph]=useState<CanvasGraph>({screens:[],edges:[],paths:[]});const [yaml,setYaml]=useState('appId: com.example.App\n---\n- launchApp\n- evalScript: ${output.keep = true} # untouched\n');const [path,setPath]=useState('');authored=yaml;saved=graph;return createElement(CanvasEditor,{graph,onChange:next=>setGraph(next!),yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:path,onPathChange:setPath,disabled:false});}
 const document=dom.window.document;
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label);assert.ok(button,label);button.click();});
 const fill=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const select=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));
  await act(async()=>{const id=[...document.querySelectorAll('label')].find(node=>node.textContent==='New screen title')!.htmlFor;const input=document.getElementById(id)!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'Descriptive Home');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await click('Add screen');assert.doesNotMatch(authored,/Descriptive Home/);
  await click('Add check to Descriptive Home');await fill('Check 1 selector','Home (ready)');
  assert.match(authored,/\^Home \\\(ready\\\)\$/);assert.equal(saved!.screens[0].tests[0].check!.match,'exact');
  await select('Check 1 matching','regex');await fill('Check 1 selector','^Home$');assert.equal(saved!.screens[0].tests[0].check!.match,'regex');await select('Check 1 matching','contains');await fill('Check 1 selector','Ready');assert.equal(saved!.screens[0].tests[0].check!.match,'contains');
  await click('Add check to Descriptive Home');await select('Check 2 visibility','absent');await select('Check 2 target','id');await fill('Check 2 selector','error.banner');
  await click('Move check 2 up');assert.match(authored,/assertNotVisible:[\s\S]*assertVisible:/);
  await click('Delete check 1');assert.match(document.querySelector('[role="alertdialog"]')!.textContent!,/Home checks/);await click('Delete anyway');assert.equal(saved!.screens[0].tests.length,1);
  await click('Undo canvas deletion');assert.equal(saved!.screens[0].tests.length,2);assert.match(authored,/error\\\.banner/);assert.match(authored,/evalScript:.*# untouched/);
  await click('Remove screen (references remain visible for repair)');await click('Delete anyway');assert.equal(saved!.screens.length,0);assert.doesNotMatch(authored,/assertVisible|assertNotVisible/);
  await click('Undo canvas deletion');assert.equal(saved!.screens[0].title,'Descriptive Home');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('opening a saved workspace replaces the canvas editor without duplicating it beside the YAML editor',async()=>{
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const workspace={id:'saved',name:'Saved home',yaml:'appId: com.example.App\n---\n- launchApp\n',canvas:{screens:[{id:'home',title:'Reloaded',x:60,y:70,tests:[]}],edges:[],paths:[]}};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?async()=>new Response(JSON.stringify(workspace)):key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {Scenarios}=await import('../src/scenarios.js');const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 try{
  await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId:'',bundleId:'',launchBusy:false,onRunning:()=>{}})));
  await act(async()=>{const input=dom.window.document.getElementById('open-workspace')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'saved');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await act(async()=>{[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent==='Open saved workspace')!.click();});
  assert.equal(dom.window.document.querySelectorAll('#canvas-heading').length,1);
  assert.equal(dom.window.document.querySelectorAll('[aria-label="Select screen Reloaded"]').length,1);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
