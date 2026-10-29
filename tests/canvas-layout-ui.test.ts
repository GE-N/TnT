import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {CanvasBoard} from '../src/canvas.js';
import {Scenarios} from '../src/scenarios.js';
import type {CanvasGraph,CanvasResult} from '../server/canvas.js';

const graph:CanvasGraph={screens:[{id:'home',title:'Home',x:40,y:40,referenceScreenshot:'data:image/png;base64,YQ==',tests:[{id:'check',label:'Visible Home',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'stored'}}]}],edges:[],paths:[]};
test('screen cards fit a stored capture, offer delete, and keep title plus nonidle symbolic outcome',()=>{
 const idle=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph,onRemoveCapture:()=>{}}))).window.document;
 const card=idle.querySelector('[data-screen-id="home"]')!;
 assert.equal(card.querySelector('img')?.getAttribute('src'),graph.screens[0].referenceScreenshot);
 assert.equal(card.querySelector('img')?.getAttribute('draggable'),'false');
 assert.ok(card.querySelector('.screen-reference-frame'));
 assert.ok(card.querySelector('[aria-label="Delete capture for Home"] svg'));
 assert.match(card.textContent!,/Home/);
 assert.doesNotMatch(card.textContent!,/✓ Captured/);
 assert.equal(card.querySelector('.screen-capture-label'),null);
 assert.equal(card.querySelector('.node-outcome'),null);
 assert.doesNotMatch(card.textContent!,/Visible Home|linked|Not run|Partly run|1 step/);
 const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
 assert.match(css,/\.screen-reference\{[^}]*width:100%[^}]*height:auto/);
 assert.doesNotMatch(css,/\.screen-reference\{[^}]*max-height/);
 assert.match(css,/\.screen-reference-delete\{[^}]*position:absolute[^}]*right:/);
 const result:CanvasResult={pathId:'',note:'',screens:[{id:'home',status:'passed'}],tests:[],edges:[]};
 const completed=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph,onRemoveCapture:()=>{},result}))).window.document;
 assert.equal(completed.querySelector('.node-outcome')?.textContent,'✓ passed');
 const empty=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph:{...graph,screens:[{...graph.screens[0],referenceScreenshot:undefined}]}}))).window.document;
 assert.doesNotMatch(empty.querySelector('[data-screen-id]')!.textContent!,/No capture yet/);
 assert.equal(empty.querySelector('.screen-capture-label'),null);
 assert.equal(empty.querySelector('.screen-node-steps'),null);
 assert.equal(empty.querySelector('img'),null);
 assert.equal(empty.querySelector('.screen-reference-delete'),null);
});
test('dragging a capture moves the node and delete removes only that capture',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const keys=['window','document','HTMLElement','Event','PointerEvent','IS_REACT_ACT_ENVIRONMENT'];
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:Reflect.get(dom.window,key),configurable:true});
 const {act}=await import('react');
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!);
 const moved:Array<[string,number,number]>=[];
 const removed:string[]=[];
 try{
  await act(async()=>root.render(createElement(CanvasBoard,{graph,initialView:{zoom:1},onMove:(id:string,x:number,y:number)=>moved.push([id,x,y]),onRemoveCapture:(id:string)=>removed.push(id)})));
  const frame=dom.window.document.querySelector('.screen-reference-frame')!;
  const pointer=(type:string,x:number,y:number)=>frame.dispatchEvent(new dom.window.PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,pointerId:1}));
  await act(async()=>{pointer('pointerdown',0,0);pointer('pointermove',10,20);pointer('pointerup',10,20);});
  assert.deepEqual(moved,[['home',50,60]]);
  await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Delete capture for Home"]')!.click());
  assert.deepEqual(removed,['home']);
  assert.deepEqual(moved,[['home',50,60]]);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
test('scenario authoring does not host the simulator state or a floating Run control',()=>{
 const document=new JSDOM(renderToStaticMarkup(createElement(Scenarios,{token:'',deviceId:'',bundleId:'',launchBusy:false,onRunning:()=>{}}))).window.document;
 assert.equal(document.querySelector('.run-toolbar'),null);
 assert.equal(document.querySelector('[aria-label="Scenario run controls"]'),null);
 assert.doesNotMatch(document.body.textContent!,/Simulator connected|Simulator not ready/);
 assert.equal(document.querySelector('.picker'),null);
 const stale=new JSDOM(renderToStaticMarkup(createElement(Scenarios,{token:'',deviceId:'remembered-device',bundleId:'',launchBusy:false,onRunning:()=>{},simulatorConnected:true}))).window.document;
 assert.equal(stale.querySelector('[aria-label="Run scenario"]'),null,'A remembered connection without a runner token must not offer Run scenario');
});

test('opening a floating control closes the previous floating popover',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const keys=['window','document','HTMLElement','Event','IS_REACT_ACT_ENVIRONMENT','fetch'];
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='fetch'?async()=>Response.json({ready:false,devices:[],token:'',tool:'test',error:'Runner unavailable'}):Reflect.get(dom.window,key),configurable:true});
 const {act}=await import('react');
 const {App}=await import('../src/app.js');
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!);
 try{
  await act(async()=>root.render(createElement(App)));
  const device=dom.window.document.querySelector<HTMLDetailsElement>('.device-toolbar')!;
  assert.match(device.querySelector('summary')?.textContent??'',/Simulator not ready/);
  assert.equal(device.querySelector('[role="alert"]')?.textContent,'Runner unavailable','Runner details belong inside the simulator popup, clear of authoring controls');
  assert.equal(dom.window.document.querySelector('.workbench>main>.notice'),null);
  await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('[data-testid="scenario-bar-trigger"]')!.click());
  assert.ok(dom.window.document.querySelector('[data-testid="scenario-panel"]'));
  assert.equal(dom.window.document.querySelector('.floating-inspector:not([data-inspector-yielded="true"])'),null);
  await act(async()=>device.querySelector('summary')!.dispatchEvent(new dom.window.PointerEvent('pointerdown',{bubbles:true})));
  assert.equal(dom.window.document.querySelector('[data-testid="scenario-panel"]'),null,'A press outside the panel closes it');
  await act(async()=>{device.open=true;device.dispatchEvent(new dom.window.Event('toggle'));});
  assert.ok(device.open);
  const launch=device.querySelector<HTMLDetailsElement>('.launch-tools')!;
  assert.ok(launch,'Advanced launch controls remain reachable inside Simulator & app');
  await act(async()=>{launch.open=true;launch.dispatchEvent(new dom.window.Event('toggle'));});
  assert.ok(device.open,'Opening nested launch tools must keep its simulator popover open');
  assert.ok(launch.open);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('the simulator state button names the connected app and opens the simulator popup',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const keys=['window','document','HTMLElement','Event','IS_REACT_ACT_ENVIRONMENT','fetch','localStorage'];
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 const fetch=async(path:string)=>{
  if(path==='/api/status')return Response.json({ready:true,devices:[{id:'sim',name:'iPhone 16',runtime:'iOS'}],token:'tok',tool:'test'});
  if(path.endsWith('/apps'))return Response.json({deviceId:'sim',apps:[{bundleId:'com.apple.Preferences',name:'Settings',type:'system'}]});
  return Response.json({});
 };
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='fetch'?fetch:Reflect.get(dom.window,key),configurable:true});
 const {act}=await import('react');
 const {App}=await import('../src/app.js');
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!);
 const document=dom.window.document;
 try{
  await act(async()=>root.render(createElement(App)));
  const summary=()=>document.querySelector<HTMLElement>('.simulator-state')!;
  assert.equal(summary().textContent,'Simulator not ready');
  assert.equal(document.querySelector('.run-toolbar'),null);
  assert.equal([...document.querySelectorAll('summary')].some(node=>node.textContent==='Simulator & app'),false);
  const app=document.querySelector<HTMLSelectElement>('#installed-app')!;
  await act(async()=>{app.value='com.apple.Preferences';app.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.equal(summary().textContent,'iPhone 16 connected for Settings');
  assert.equal(summary().querySelector('.simulator-state-dot')?.classList.contains('connected'),true);
  assert.doesNotMatch(document.body.textContent!,/User-installed and system/);
  const refreshDevices=document.querySelector('button[aria-label="Refresh devices"]');
  assert.ok(refreshDevices);
  assert.equal(refreshDevices.textContent?.trim(),'');
  await act(async()=>{summary().click();});
  const device=document.querySelector<HTMLDetailsElement>('.device-toolbar')!;
  assert.ok(device.open,'Tapping the simulator state button opens the simulator popup');
  assert.ok(device.querySelector('#device'));
  assert.ok(device.querySelector('.launch-tools'));
  const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
  assert.match(css,/\.simulator-state-dot\.connected\{[^}]*background:#1f9d55/);
  assert.match(css,/\.simulator-select select\{[^}]*right 16px center/);
  assert.match(css,/\.device-toolbar\[open\]\{[^}]*width:max-content/);
  assert.match(css,/\.simulator-state\{[^}]*width:fit-content/);
  assert.match(css,/\.simulator-state\{[^}]*margin:0 0 0 auto/);
  assert.doesNotMatch(css,/\.simulator-state\{[^}]*max-width:100%/);
  await act(async()=>{[...document.querySelectorAll('button')].find(button=>button.textContent==='Enter bundle ID manually')!.click();});
  const bundle=document.querySelector<HTMLInputElement>('#bundle')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(bundle,'com.example.Manual');bundle.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  assert.equal(summary().textContent,'iPhone 16 connected for com.example.Manual');
  const close=document.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  assert.ok(close);
  await act(async()=>{close.click();});
  assert.equal(device.open,false,'The close button dismisses the simulator popup');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
