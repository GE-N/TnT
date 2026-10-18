import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {singleWorkspaceLibrary,workspaceCommand} from './workspace-ui-helpers.js';
import {sha256} from '../src/run-script.js';

const fingerprint='ab'.repeat(32);
const source='1+1';

function workspace(mock:boolean){
  return {
    id:'saved',
    name:'Saved home',
    yaml:'appId: com.example.App\n---\n- launchApp\n',
    flows:{},
    ...(mock?{mock:{environment:{name:'Pay',routes:[{uuid:'pay',type:'http',method:'get',endpoint:'pay',responses:[{uuid:'ok',label:'OK',statusCode:200,body:'{}'}]}]},port:4320,routeId:'pay',responseId:'ok',backendUrl:'http://127.0.0.1',passthroughRouteIds:[],fromScreen:'home',toScreen:'home',failureSemantics:'HTTP 500'}}:{}),
    scenarios:[{id:'paid',name:'Paid',authoring:'canvas' as const,pathId:'route',steps:[],inputs:{},parameters:{},enabledHandlerIds:[],scripts:[{id:'script-paid',label:'Run script',source,beforeStep:{index:0,fingerprint}}]}],
    canvas:{
      screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'ready',label:'Home',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint},check:{visibility:'visible',target:'text',match:'exact',value:'Home'}}]}],
      edges:[],
      paths:[{id:'route',name:'Main',scenarioId:'paid',screenId:'home',edgeIds:[],visits:[{id:'v1',operationIds:['ready']}]}],
    },
  };
}

async function openWorkspace(options:{mock:boolean;trusted:boolean;failTrust?:boolean;onRuns?:()=>Response;onBatches?:()=>Response}){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
  const keys=['window','document','HTMLElement','Event','KeyboardEvent','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch','sessionStorage'];
  const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  class ResizeObserver{observe(){}disconnect(){}}
  const saved=workspace(options.mock);
  const runs:string[]=[];
  const batches:string[]=[];
  const duplicates:unknown[]=[];
  const saves:unknown[]=[];
  let trustCalls=0;
  const grant={rowId:'script-paid',origin:'local' as const,trusted:true,hash:sha256(source)};
  const denied={rowId:'script-paid',origin:'imported' as const,trusted:false,hash:sha256(source)};
  Object.defineProperty(globalThis,'sessionStorage',{value:dom.window.sessionStorage,configurable:true});
  for(const key of keys){
    if(key==='sessionStorage')continue;
    Object.defineProperty(globalThis,key,{value:key==='fetch'?async(path:string,init?:RequestInit)=>{
      if(path==='/api/session')return Response.json({});
      if(path==='/api/canvas/references')return Response.json({references:[],diagnostics:[]});
      if(path.includes('/api/scripts/trust')){trustCalls+=1;if(options.failTrust&&trustCalls===1)return new Response('no',{status:500});return Response.json({scripts:options.trusted?[grant]:[denied]});}
      if(path.includes('/api/runs')){runs.push(path);return options.onRuns?options.onRuns():Response.json({id:'run',status:'passed',snapshot:{workspaceId:saved.id,id:'run',name:saved.name,yaml:saved.yaml,steps:[],toolVersions:{maestro:'',node:''},runtimeInputPolicy:''}});}
      if(path.includes('/api/batches')){batches.push(path);return options.onBatches?options.onBatches():Response.json({id:'batch',status:'completed',entries:[]});}
      if(path.startsWith('/api/workspaces?q='))return Response.json(singleWorkspaceLibrary(saved));
      if(path==='/api/scenarios/duplicate'){const body=JSON.parse(String(init?.body??'{}'));duplicates.push(body);const copy={...saved.scenarios[0],id:'scenario-server',name:'From server',pathId:'sequence-server',scripts:[{...saved.scenarios[0].scripts[0],id:'script-server'}]};return Response.json({...saved,metadata:{revision:2},scenarios:[saved.scenarios[0],copy],canvas:{...saved.canvas,paths:[...saved.canvas.paths,{...saved.canvas.paths[0],id:'sequence-server',scenarioId:'scenario-server',name:'From server',visits:[{id:'visit-server',operationIds:['ready']}]}]}});}
      if((init?.method??'GET')==='POST'&&path==='/api/workspaces'){const body=JSON.parse(String(init?.body??'{}'));saves.push(body);return Response.json({...saved,metadata:{revision:1}});}
      return Response.json(saved);
    }:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
  }
  const {Scenarios}=await import('../src/scenarios.js');
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(dom.window.document.getElementById('root')!);
  await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId:'device',bundleId:'',launchBusy:false,onRunning:()=>{}})));
  await workspaceCommand(dom.window.document,'open');
  for(let i=0;i<8;i++)await act(async()=>{await new Promise(resolve=>setImmediate(resolve));});
  return {dom,runs,batches,duplicates,saves,trustCalls:()=>trustCalls,async close(){await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}};
}

async function clickRun(document:Document){
  const button=document.querySelector<HTMLButtonElement>('[aria-label="Run scenario"]');
  assert.ok(button,[...document.querySelectorAll('button')].map(item=>item.getAttribute('aria-label')||item.textContent).join(' | '));
  assert.equal(button.disabled,false);
  await act(async()=>{button.click();for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));});
}

test('Run does not start while a script row blocks the scenario',async()=>{
  const page=await openWorkspace({mock:false,trusted:false});
  try{
    await clickRun(page.dom.window.document);
    assert.deepEqual(page.runs,[]);
  }finally{await page.close();}
});

test('Run All does not post a batch while every scenario is script-blocked',async()=>{
  const page=await openWorkspace({mock:false,trusted:false});
  try{
    const button=[...page.dom.window.document.querySelectorAll('button')].find(item=>item.textContent==='Run all');
    assert.ok(button);
    assert.equal(button.disabled,false);
    await act(async()=>{button.click();for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));});
    assert.deepEqual(page.batches,[]);
  }finally{await page.close();}
});

test('a blank script is not saved and Escape from the name field removes it',async()=>{
  const page=await openWorkspace({mock:false,trusted:true});
  try{
    const document=page.dom.window.document;
    await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Visit 1 · Home"]')?.click());
    await act(async()=>document.querySelector<HTMLButtonElement>('.add-visit-step')?.click());
    await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="add-run-script"]')?.click());
    const focused=document.activeElement;
    assert.equal(focused?.getAttribute('aria-label'),'Script name');
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,400));});
    assert.equal(page.saves.some(body=>JSON.stringify(body).includes('"source":""')),false);
    await act(async()=>focused!.dispatchEvent(new page.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    assert.equal(document.querySelector('[data-script-editor]'),null);
    assert.ok(document.querySelector('.floating-inspector'));
  }finally{await page.close();}
});

test('a failed trust load blocks Run until Retry succeeds',async()=>{
  const page=await openWorkspace({mock:false,trusted:false,failTrust:true});
  try{
    const document=page.dom.window.document;
    assert.equal(document.querySelector('[data-testid="trust-load-failed"]')?.textContent,"⚠ Trust couldn't be loaded · ↻ Retry");
    await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Visit 1 · Home"]')?.click());
    assert.equal(document.querySelector('[data-testid="trust-unknown"]')?.textContent,'⚠ Trust unknown');
    assert.equal(document.querySelector('[role="alertdialog"]'),null);
    await clickRun(document);
    assert.deepEqual(page.runs,[]);
    await act(async()=>{document.querySelector<HTMLButtonElement>('[data-testid="trust-load-retry"]')!.click();for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));});
    assert.equal(page.trustCalls(),2);
    assert.equal(document.querySelector('[data-testid="trust-load-failed"]'),null);
    assert.equal(document.querySelector('[data-testid="trust-unknown"]'),null);
  }finally{await page.close();}
});

test('duplicate posts the saved revision and adopts the server ids',async()=>{
  const page=await openWorkspace({mock:false,trusted:false});
  try{
    const document=page.dom.window.document;
    const row=document.querySelector<HTMLElement>('[aria-label="Scenario list"] [aria-pressed="true"]')!;
    assert.equal(row.textContent,'Paid');
    await act(async()=>row.parentElement!.dispatchEvent(new page.dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20})));
    const duplicate=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent==='Duplicate');
    assert.ok(duplicate);
    await act(async()=>{duplicate.click();for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));});
    assert.deepEqual(page.duplicates,[{workspaceId:'saved',scenarioId:'paid',expectedRevision:1}]);
    assert.equal(document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')?.textContent,'From server');
    await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Visit 1 · Home"]')?.click());
    assert.equal(document.querySelector('[data-script-id="script-server"]')?.getAttribute('data-script-id'),'script-server');
    assert.equal(document.querySelector('[data-script-id="script-paid"]'),null);
  }finally{await page.close();}
});
