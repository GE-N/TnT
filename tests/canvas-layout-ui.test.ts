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
test('offline simulator status stays in the toolbar and Run exposes the disabled reason',()=>{
 const document=new JSDOM(renderToStaticMarkup(createElement(Scenarios,{token:'',deviceId:'',bundleId:'',launchBusy:false,onRunning:()=>{}}))).window.document;
 const toolbar=document.querySelector('[aria-label="Scenario run controls"]')!;
 assert.match(toolbar.textContent!,/○ Simulator not connected/);
 const run=toolbar.querySelector('button')!;
 assert.ok(run.hasAttribute('disabled'));
 assert.equal(run.getAttribute('aria-label'),'Run scenario — Simulator not connected');
 assert.equal(document.querySelectorAll('[role="status"]').length,2);
 assert.equal(document.querySelector('.picker'),null);
 const stale=new JSDOM(renderToStaticMarkup(createElement(Scenarios,{token:'',deviceId:'remembered-device',bundleId:'',launchBusy:false,onRunning:()=>{},simulatorConnected:true}))).window.document;
 assert.ok(stale.querySelector('[aria-label="Run scenario — Simulator not connected"]')!.hasAttribute('disabled'),'A remembered connection without a runner token must remain offline');
});

test('opening a floating control closes the previous floating popover',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const keys=['window','document','HTMLElement','Event','IS_REACT_ACT_ENVIRONMENT','fetch'];
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='fetch'?async()=>Response.json({ready:false,devices:[],token:'',tool:'test'}):Reflect.get(dom.window,key),configurable:true});
 const {act}=await import('react');
 const {App}=await import('../src/app.js');
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!);
 try{
  await act(async()=>root.render(createElement(App)));
  const scenarios=dom.window.document.querySelector<HTMLDetailsElement>('.scenario-controls')!;
  const device=dom.window.document.querySelector<HTMLDetailsElement>('.device-toolbar')!;
  await act(async()=>{scenarios.open=true;scenarios.dispatchEvent(new dom.window.Event('toggle'));});
  assert.ok(scenarios.open);
  await act(async()=>{device.open=true;device.dispatchEvent(new dom.window.Event('toggle'));});
  assert.ok(device.open);
  assert.equal(scenarios.open,false,'The old floating popover closes so controls cannot crowd the inspector');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
