import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {CanvasBoard} from '../src/canvas.js';
import {Scenarios} from '../src/scenarios.js';
import type {CanvasGraph,CanvasResult} from '../server/canvas.js';

const graph:CanvasGraph={screens:[{id:'home',title:'Home',x:40,y:40,referenceScreenshot:'data:image/png;base64,YQ==',tests:[{id:'check',label:'Visible Home',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'stored'}}]}],edges:[],paths:[]};
test('screen cards retain only stored capture, title and nonidle symbolic outcome',()=>{
 const idle=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph}))).window.document;
 const card=idle.querySelector('[data-screen-id="home"]')!;
 assert.equal(card.querySelector('img')?.getAttribute('src'),graph.screens[0].referenceScreenshot);
 assert.match(card.textContent!,/Home/);
 assert.match(card.textContent!,/✓ Captured/);
 assert.equal(card.querySelector('.node-outcome'),null);
 assert.doesNotMatch(card.textContent!,/Visible Home|linked|Not run|Partly run|1 step/);
 const result:CanvasResult={pathId:'',note:'',screens:[{id:'home',status:'passed'}],tests:[],edges:[]};
 const completed=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph,result}))).window.document;
 assert.equal(completed.querySelector('.node-outcome')?.textContent,'✓ passed');
 const empty=new JSDOM(renderToStaticMarkup(createElement(CanvasBoard,{graph:{...graph,screens:[{...graph.screens[0],referenceScreenshot:undefined}]}}))).window.document;
 assert.match(empty.querySelector('[data-screen-id]')!.textContent!,/No capture yet/);
 assert.equal(empty.querySelector('img'),null);
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
  const scenarios=dom.window.document.querySelector<HTMLDetailsElement>('.scenario-controls')!;
  const device=dom.window.document.querySelector<HTMLDetailsElement>('.device-toolbar')!;
  assert.match(device.querySelector('summary')?.textContent??'',/Simulator not ready/);
  assert.equal(device.querySelector('[role="alert"]')?.textContent,'Runner unavailable','Runner details belong inside the simulator popup, clear of authoring controls');
  assert.equal(dom.window.document.querySelector('.workbench>main>.notice'),null);
  await act(async()=>{scenarios.open=true;scenarios.dispatchEvent(new dom.window.Event('toggle'));});
  assert.ok(scenarios.open);
  await act(async()=>{device.open=true;device.dispatchEvent(new dom.window.Event('toggle'));});
  assert.ok(device.open);
  assert.equal(scenarios.open,false,'The old floating popover closes so controls cannot crowd the inspector');
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
  await act(async()=>{summary().click();});
  const device=document.querySelector<HTMLDetailsElement>('.device-toolbar')!;
  assert.ok(device.open,'Tapping the simulator state button opens the simulator popup');
  assert.ok(device.querySelector('#device'));
  assert.ok(device.querySelector('.launch-tools'));
  await act(async()=>{[...document.querySelectorAll('button')].find(button=>button.textContent==='Enter bundle ID manually')!.click();});
  const bundle=document.querySelector<HTMLInputElement>('#bundle')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(bundle,'com.example.Manual');bundle.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  assert.equal(summary().textContent,'iPhone 16 connected for com.example.Manual');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
