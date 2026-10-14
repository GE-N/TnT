import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement,useState} from 'react';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
import {edgeActions,refreshChecks,writeChecks} from '../shared/canvas-authoring.js';

const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
const tap=(id:string,value:string,scenarioIds=['main']):CanvasTest=>({id,label:value,role:'action',reference,scenarioIds,tap:{target:'text',match:'exact',value}});
const check=(id:string,value:string,scenarioIds=['main']):CanvasTest=>({id,label:value,role:'assertion',reference,scenarioIds,check:{visibility:'visible',target:'text',match:'exact',value}});

const canvas:CanvasGraph={
 screens:[
  {id:'home',title:'Home',x:40,y:40,tests:[check('home-ready','Home'),tap('open-profile','Profile'),tap('show-error','Submit')]},
  {id:'profile',title:'Profile',x:420,y:40,tests:[check('profile-ready','Profile')]},
  {id:'settings',title:'Settings',x:800,y:40,tests:[check('settings-ready','Settings')]},
 ],
 edges:[{id:'go',from:'home',to:'profile',actionTestId:'open-profile',actionTestIds:['open-profile'],assertionTestId:'profile-ready',responseCondition:'Home → Profile'}],
 paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:['go'],visits:[{id:'v1',operationIds:['home-ready','open-profile','show-error']},{id:'v2',operationIds:['profile-ready']}]}],
};
const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);

async function mount(graph:CanvasGraph=canvas){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const window=dom.window;const document=window.document;
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'] as const;
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(window,key),configurable:true});
 window.HTMLElement.prototype.getBoundingClientRect=function(){return {x:0,y:0,left:0,top:0,width:280,height:160,right:280,bottom:160,toJSON(){}} as DOMRect;};
 Object.defineProperty(window,'innerWidth',{value:1200,configurable:true});
 Object.defineProperty(window,'innerHeight',{value:800,configurable:true});
 const {createRoot}=await import('react-dom/client');
 const {CanvasEditor}=await import('../src/canvas.js');
 const changes:CanvasGraph[]=[];
 let latest=refreshChecks(structuredClone(graph),yaml);
 let latestYaml=yaml;
 function Host(){
  const [graphState,setGraph]=useState<CanvasGraph|undefined>(()=>latest);
  const [source,setSource]=useState(yaml);
  latest=graphState!;latestYaml=source;
  return createElement(CanvasEditor,{graph:graphState,onChange:next=>{if(next){changes.push(next);setGraph(next);}else setGraph(undefined);},yaml:source,onYamlChange:setSource,catalog:[],diagnostics:[],pathId:'route',onPathChange:()=>{},disabled:false,scenarioMode:true,scenarioId:'main',scenarios:[{id:'main',name:'Main',pathId:'route'}],initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 }
 const root=createRoot(document.getElementById('root')!);
 await act(async()=>root.render(createElement(Host)));
 const card=()=>document.querySelector<HTMLElement>('.floating-inspector');
 const row=(id:string)=>card()!.querySelector<HTMLElement>(`[data-operation-id="${id}"]`)!;
 async function edit(id:string){
  const summary=row(id).querySelector<HTMLButtonElement>('.visit-step-summary')!;
  if(summary.getAttribute('aria-expanded')==='false')await act(async()=>summary.click());
 }
 async function choose(id:string,value:string){
  await edit(id);
  await act(async()=>{
   const select=row(id).querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!;
   Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value')!.set!.call(select,value);
   select.dispatchEvent(new window.Event('change',{bubbles:true}));
  });
 }
 async function click(label:string){
  await act(async()=>{
   const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>(item.getAttribute('aria-label')??item.textContent)===label);
   assert.ok(button,label);button.click();
  });
 }
 return {document,window,card,row,edit,choose,click,changes,saved:()=>({graph:latest,yaml:latestYaml}),close:async()=>{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}};
}

test('destination options are Stays on this screen, screens, then + New screen',async()=>{
 const page=await mount();
 try{
  await page.edit('show-error');
  const select=page.row('show-error').querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!;
  assert.deepEqual([...select.options].map(option=>option.textContent),['Stays on this screen','Home','Profile','Settings','+ New screen…']);
  assert.equal(select.value,'');
  assert.match(page.row('show-error').querySelector('.visit-step-summary')!.textContent!,/↺ stays on Home/);
  assert.doesNotMatch(page.row('show-error').querySelector('.visit-step-summary')!.textContent!,/→/);
  assert.match(page.row('open-profile').querySelector('.visit-step-summary')!.textContent!,/→ Profile/);
  assert.ok(page.row('open-profile').querySelector('details.connection-name'));
  assert.equal(page.document.body.textContent!.includes('Choose destination screen'),false);
  assert.equal(page.document.body.textContent!.includes('No destination'),false);
 }finally{await page.close();}
});

test('linking Home to Profile announces and highlights the new edge',async()=>{
 const page=await mount();
 try{
  await page.choose('show-error','profile');
  const saved=page.saved().graph;
  assert.equal(saved.edges.find(edge=>edgeActions(edge).includes('show-error'))?.to,'profile');
  assert.match(page.card()!.querySelector('[role=status]')!.textContent!,/Linked Home action .+ to Profile \(Visit 2\)/);
  assert.equal(page.document.querySelector('[data-edge-id][data-highlighted="true"]')?.getAttribute('data-edge-id'),saved.edges.find(edge=>edgeActions(edge).includes('show-error'))!.id);
 }finally{await page.close();}
});

test('retarget splits a shared edge, keeps later visits for repair, and names visits to review',async()=>{
 const shared:CanvasGraph={
  ...structuredClone(canvas),
  edges:[{id:'go',from:'home',to:'profile',actionTestId:'open-profile',actionTestIds:['open-profile','show-error'],assertionTestId:'profile-ready',responseCondition:'Home → Profile'}],
  paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:['go'],visits:[{id:'v1',operationIds:['home-ready','open-profile','show-error']},{id:'v2',operationIds:['profile-ready']}]}],
 };
 const page=await mount(shared);
 try{
  await page.choose('show-error','settings');
  const saved=page.saved().graph;
  assert.equal(saved.edges.find(edge=>edge.id==='go')!.to,'profile');
  assert.deepEqual(edgeActions(saved.edges.find(edge=>edge.id==='go')!),['open-profile']);
  assert.equal(saved.edges.find(edge=>edgeActions(edge).includes('show-error'))!.to,'settings');
  assert.deepEqual(saved.paths[0].visits![1].operationIds,['profile-ready']);
  assert.match(page.document.querySelector('.destination-review-notice')?.textContent??page.card()!.textContent!,/Review Visit 2/);
 }finally{await page.close();}
});

test('+ New screen creates and links in one change, and a failed create loses no screen',async()=>{
 const page=await mount();
 try{
  const before=page.saved().graph.screens.map(screen=>screen.id);
  await page.edit('show-error');
  await act(async()=>{
   const select=page.row('show-error').querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!;
   Object.getOwnPropertyDescriptor(page.window.HTMLSelectElement.prototype,'value')!.set!.call(select,'__new_screen__');
   select.dispatchEvent(new page.window.Event('change',{bubbles:true}));
  });
  const title=page.row('show-error').querySelector<HTMLInputElement>('[aria-label="New screen title"]')!;
  await act(async()=>{
   Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(title,'');
   title.dispatchEvent(new page.window.Event('input',{bubbles:true}));
   title.dispatchEvent(new page.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  });
  assert.deepEqual(page.saved().graph.screens.map(screen=>screen.id),before,'empty title must not add or remove screens');
  assert.equal(page.changes.length,0);
  await act(async()=>{
   Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(title,'More');
   title.dispatchEvent(new page.window.Event('input',{bubbles:true}));
   title.dispatchEvent(new page.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  });
  assert.equal(page.changes.length,1,'create+link must be one graph change');
  const saved=page.saved().graph;
  const created=saved.screens.find(screen=>screen.title==='More');
  assert.ok(created);
  assert.equal(created.x,homeX(saved));
  assert.equal(saved.edges.find(edge=>edgeActions(edge).includes('show-error'))?.to,created.id);
  assert.equal(saved.screens.length,before.length+1);
 }finally{await page.close();}
});

function homeX(graph:CanvasGraph){return graph.screens.find(screen=>screen.id==='home')!.x+370;}

test('Stays on this screen confirms before cutting the route and keeps the action',async()=>{
 const page=await mount();
 try{
  await page.choose('open-profile','');
  const dialog=page.document.querySelector('[role=alertdialog]');
  assert.ok(dialog,'expected clear-destination confirm');
  const dialogText=dialog!.textContent||'';
  assert.match(dialogText,/Remove the link to Profile/);
  assert.match(dialogText,/Visit 2/);
  const cancel=[...dialog!.querySelectorAll('button')].find(button=>button.textContent==='Cancel')!;
  assert.ok(page.document.activeElement===cancel,'focus starts on Cancel');
  assert.equal(page.saved().graph.paths[0].edgeIds.length,1,'route unchanged until confirm');
  await act(async()=>cancel.click());
  assert.equal(page.document.querySelector('[role=alertdialog]'),null);
  assert.equal(page.saved().graph.paths[0].edgeIds.length,1);
  // Close the step editor before reopening the confirm — avoids a stale select/act loop.
  const done=[...page.row('open-profile').querySelectorAll('button')].find(button=>button.textContent==='Done');
  if(done)await act(async()=>done.click());
  await page.choose('open-profile','');
  await page.click('Remove link');
  assert.deepEqual(page.saved().graph.paths[0].edgeIds,[]);
  assert.equal(page.saved().graph.screens.find(screen=>screen.id==='home')!.tests.some(test=>test.id==='open-profile'),true);
  assert.match(page.row('open-profile').querySelector('.visit-step-summary')!.textContent||'',/↺ stays on Home/);
 }finally{await page.close();}
});
