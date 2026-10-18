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

async function openWorkspace(options:{mock:boolean;trusted:boolean;onRuns?:()=>Response;onBatches?:()=>Response}){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
  const keys=['window','document','HTMLElement','Event','KeyboardEvent','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch','sessionStorage'];
  const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  class ResizeObserver{observe(){}disconnect(){}}
  const saved=workspace(options.mock);
  const runs:string[]=[];
  const batches:string[]=[];
  const grant={rowId:'script-paid',origin:'local' as const,trusted:true,hash:sha256(source)};
  Object.defineProperty(globalThis,'sessionStorage',{value:dom.window.sessionStorage,configurable:true});
  for(const key of keys){
    if(key==='sessionStorage')continue;
    Object.defineProperty(globalThis,key,{value:key==='fetch'?async(path:string,init?:RequestInit)=>{
      if(path==='/api/session')return Response.json({});
      if(path==='/api/canvas/references')return Response.json({references:[],diagnostics:[]});
      if(path.includes('/api/scripts/trust'))return Response.json({scripts:options.trusted?[grant]:[]});
      if(path.includes('/api/runs')){runs.push(path);return options.onRuns?options.onRuns():Response.json({id:'run',status:'passed',snapshot:{workspaceId:saved.id,id:'run',name:saved.name,yaml:saved.yaml,steps:[],toolVersions:{maestro:'',node:''},runtimeInputPolicy:''}});}
      if(path.includes('/api/batches')){batches.push(path);return options.onBatches?options.onBatches():Response.json({id:'batch',status:'completed',entries:[]});}
      if(path.startsWith('/api/workspaces?q='))return Response.json(singleWorkspaceLibrary(saved));
      if((init?.method??'GET')==='POST'&&path==='/api/workspaces')return Response.json({...saved,metadata:{revision:1}});
      return Response.json(saved);
    }:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
  }
  const {Scenarios}=await import('../src/scenarios.js');
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(dom.window.document.getElementById('root')!);
  await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId:'device',bundleId:'',launchBusy:false,onRunning:()=>{}})));
  await workspaceCommand(dom.window.document,'open');
  for(let i=0;i<8;i++)await act(async()=>{await new Promise(resolve=>setImmediate(resolve));});
  return {dom,runs,batches,async close(){await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}};
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

test('a token-carrying run shows the server authored-JavaScript verdict and a no-mock run does not',async()=>{
  const blocked=()=>Response.json({error:'blocked',blocked:[{kind:'authored-javascript',index:0,message:"Can't run with a script · this step runs its own JavaScript"}]},{status:422});
  const carrying=await openWorkspace({mock:true,trusted:true,onRuns:blocked});
  try{
    await clickRun(carrying.dom.window.document);
    assert.equal(carrying.runs.length,1);
    const document=carrying.dom.window.document;
    await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Visit 1 · Home"]')?.click());
    assert.equal(document.querySelector('[data-testid="authored-javascript"]')?.textContent,"✕ Can't run with a script · this step runs its own JavaScript");
    assert.equal(document.querySelector('[data-testid="authored-javascript-run"]')?.textContent,"✕ Run blocked · remove the step's JavaScript or the Run script rows");
    await act(async()=>document.querySelector<HTMLButtonElement>('.add-visit-step')?.click());
    await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="add-run-script"]')?.click());
    assert.equal(document.querySelector('[data-testid="authored-javascript-note"]')?.textContent,"⚠ This scenario has its own JavaScript steps. They'll block Run while a script is here.");
  }finally{await carrying.close();}
  const plain=await openWorkspace({mock:false,trusted:true,onRuns:blocked});
  try{
    await clickRun(plain.dom.window.document);
    assert.equal(plain.runs.length,1);
    const document=plain.dom.window.document;
    await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Visit 1 · Home"]')?.click());
    assert.equal(document.querySelector('[data-testid="authored-javascript"]'),null);
    assert.equal(document.querySelector('[data-testid="authored-javascript-run"]'),null);
    await act(async()=>document.querySelector<HTMLButtonElement>('.add-visit-step')?.click());
    await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="add-run-script"]')?.click());
    assert.equal(document.querySelector('[data-testid="authored-javascript-note"]'),null);
  }finally{await plain.close();}
});
