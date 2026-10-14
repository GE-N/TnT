import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement,useState} from 'react';
import {CanvasEditor} from '../src/canvas.js';
import {inspectCanvas,type CanvasGraph,type CanvasTest} from '../server/canvas.js';
import {projectCanvasRoute} from '../server/canvas-route.js';
import {refreshChecks,writeChecks} from '../shared/canvas-authoring.js';

const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
function tap(id:string,label:string,value:string):CanvasTest{return {id,label,role:'action',reference,tap:{target:'text',match:'exact',value}};}
const warning=(label:string)=>`⚠ "${label}" has no destination. Choose a screen, or set it to Stays on this screen.`;
function workspace(){
 const canvas:CanvasGraph={
  screens:[{id:'home',title:'Home',x:0,y:0,tests:[tap('gear','tap Gear','Gear'),tap('profile','open Profile','Profile'),{id:'home-ready',label:'Home',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Home'}}]},{id:'settings',title:'Settings',x:400,y:0,tests:[{id:'settings-ready',label:'Settings',role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value:'Settings'}}]}],
  edges:[],
  paths:[{id:'route',name:'Home checks',screenId:'home',edgeIds:[]}],
 };
 const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);
 return {yaml,canvas:refreshChecks(canvas,yaml)};
}

async function mount(scenarioMode:boolean,brokenReference=false){
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 const state={...workspace()};
 if(brokenReference)state.canvas.screens[0].tests.push({id:'stale',label:'Broken reference',role:'assertion',reference:{...reference,index:999,fingerprint:'missing'}});
 function Host(){
  const [graph,setGraph]=useState(state.canvas);const [yaml,setYaml]=useState(state.yaml);
  state.canvas=graph;state.yaml=yaml;
  return createElement(CanvasEditor,{graph,onChange:next=>setGraph(next!),yaml,onYamlChange:setYaml,catalog:[],diagnostics:inspectCanvas(graph,yaml).diagnostics,pathId:'route',onPathChange:()=>{},disabled:false,scenarioMode});
 }
 await act(async()=>root.render(createElement(Host)));
 const document=dom.window.document;
 const pickerCalls:string[]=[];
 Object.defineProperty(dom.window.HTMLSelectElement.prototype,'showPicker',{value:function(this:HTMLSelectElement){assert.equal(document.activeElement,this);pickerCalls.push(this.closest<HTMLElement>('[data-operation-id]')!.dataset.operationId!);},configurable:true});
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Select screen Home"]')!.click());
 const row=(id:string)=>document.querySelector<HTMLElement>(`[data-operation-id="${id}"]`)!;
 return {
  document,state,row,pickerCalls,
  warnings:()=>[...document.querySelectorAll('.destination-warning p')].map(node=>node.textContent),
  choose:async(id:string,value:string)=>act(async()=>{const select=row(id).querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!;Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(select,value);select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));}),
  option:(id:string,text:string)=>[...row(id).querySelectorAll<HTMLOptionElement>('select[aria-label$=" destination"] option')].find(option=>option.textContent===text)!.value,
  async close(){await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}},
 };
}

for(const scenarioMode of [false,true])test(`each legacy start-only step without a destination shows its own warning (${scenarioMode?'contextual':'legacy'} canvas)`,async()=>{
 const page=await mount(scenarioMode);
 try{
  assert.deepEqual(page.warnings(),[warning('tap Gear'),warning('open Profile')]);
  assert.equal(page.row('gear').querySelector('.destination-warning p')?.textContent,warning('tap Gear'));
  assert.equal(page.row('profile').querySelector('.destination-warning p')?.textContent,warning('open Profile'));
  assert.equal(page.row('home-ready').querySelector('.destination-warning'),null);
  assert.equal(page.document.querySelector('.notice.error,[role="alert"],.reference-error')===null,true);
  assert.equal(page.document.querySelector('button[aria-label="Repair tap Gear"],button[aria-label="Repair open Profile"]'),null);
 }finally{await page.close();}
});

for(const scenarioMode of [false,true])test(`Choose destination opens that step's Destination dropdown and focuses it (${scenarioMode?'contextual':'legacy'} canvas)`,async()=>{
 const page=await mount(scenarioMode);
 try{
  for(const id of ['profile','gear']){
   const button=[...page.row(id).querySelectorAll<HTMLButtonElement>('.destination-warning button')].find(item=>item.textContent==='Choose destination')!;
   assert.ok(button);
   await act(async()=>button.click());
   const select=page.row(id).querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!;
   assert.equal(page.document.activeElement,select);
   assert.equal(select.closest('details')!.open,true);
   assert.equal(page.pickerCalls.at(-1),id);
  }
 }finally{await page.close();}
});

for(const scenarioMode of [false,true])test(`the warning clears once Stays on this screen or a screen is chosen (${scenarioMode?'contextual':'legacy'} canvas)`,async()=>{
 const page=await mount(scenarioMode);
 try{
  await page.choose('gear',page.option('gear','Stays on this screen'));
  assert.deepEqual(page.warnings(),[warning('open Profile')]);
  assert.equal(page.row('gear').querySelector<HTMLSelectElement>('select[aria-label$=" destination"]')!.selectedOptions[0].textContent,'Stays on this screen');
  await page.choose('profile','settings');
  assert.deepEqual(page.warnings(),[]);
  assert.equal(page.document.querySelector('[role="alert"]'),null);
  assert.equal(inspectCanvas(page.state.canvas,page.state.yaml).diagnostics.length,0);
  const projected=projectCanvasRoute(page.state.canvas,page.state.yaml,{},'route');
  assert.deepEqual(projected.canvas.execution!.occurrences.map(item=>[item.testId,item.edgeId??null]),[['gear',null],['home-ready',null],['profile',page.state.canvas.edges[0].id],['settings-ready',null]]);
 }finally{await page.close();}
});

for(const scenarioMode of [false,true])test(`missing destinations stay amber while genuine stale references retain their error and Repair action (${scenarioMode?'contextual':'legacy'} canvas)`,async()=>{
 const page=await mount(scenarioMode,true);
 try{
  assert.deepEqual(page.warnings(),[warning('tap Gear'),warning('open Profile')]);
  const alert=page.document.querySelector('[role="alert"]')!;
  assert.ok(alert);
  assert.match(alert.textContent!,/Broken reference.*Broken or stale YAML reference/);
  assert.doesNotMatch(alert.textContent!,/has no destination|tap Gear|open Profile/);
  assert.ok(alert.querySelector('button[aria-label="Repair Broken reference"]'));
  assert.equal(page.document.querySelector('button[aria-label="Repair tap Gear"],button[aria-label="Repair open Profile"]'),null);
  const referenceErrors=[...page.document.querySelectorAll('.reference-error')];
  assert.equal(referenceErrors.length,scenarioMode?0:1);
  for(const referenceError of referenceErrors){assert.match(referenceError.textContent!,/Broken or stale YAML reference/);assert.doesNotMatch(referenceError.textContent!,/has no destination/);}
 }finally{await page.close();}
});

test('a screen choice alone also clears the warning',async()=>{
 const page=await mount(false);
 try{
  await page.choose('gear','settings');
  assert.equal(page.row('gear').querySelector('.destination-warning'),null);
 }finally{await page.close();}
});

test('the destination warning uses #8a4b00 on #fff4e5 at 12px or larger',()=>{
 const rule=readFileSync(new URL('../src/style.css',import.meta.url),'utf8').match(/\.destination-warning\{([^}]*)\}/)?.[1]??'';
 assert.match(rule,/(?:^|;)color:#8a4b00(?:;|$)/);
 assert.match(rule,/background:#fff4e5/);
 assert.ok(Number(rule.match(/font-size:(\d+)px/)?.[1])>=12);
});
