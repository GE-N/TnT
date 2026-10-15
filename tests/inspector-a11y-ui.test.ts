import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act,createElement,useState} from 'react';
import {refreshChecks,writeChecks} from '../shared/canvas-authoring.js';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
import {isEditableTarget} from '../src/inspector-a11y.js';

const same=(actual:unknown,expected:unknown,message='same node')=>assert.ok(actual===expected,message);
const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
const tap=(id:string,value:string):CanvasTest=>({id,label:value,role:'action',reference,tap:{target:'text',match:'exact',value}});
const check=(id:string,value:string):CanvasTest=>({id,label:value,role:'assertion',reference,check:{visibility:'visible',target:'text',match:'exact',value}});
const canvas:CanvasGraph={
 screens:[
  {id:'home',title:'Home',x:0,y:0,tests:[check('home-ready','Home'),tap('avatar','Avatar'),tap('show-error','Show error')]},
  {id:'profile',title:'Profile',x:400,y:0,tests:[check('profile-ready','Profile')]},
 ],
 edges:[{id:'home-profile',from:'home',to:'profile',actionTestId:'avatar',assertionTestId:'profile-ready',responseCondition:'tap Avatar'}],
 paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:['home-profile'],visits:[{id:'v1'},{id:'v2'}]}],
};
const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},canvas);

async function mount(){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const window=dom.window;const document=window.document;
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'] as const;
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(window,key),configurable:true});
 window.HTMLElement.prototype.getBoundingClientRect=function(){return {left:0,top:0,width:300,height:200,x:0,y:0,right:300,bottom:200,toJSON(){}} as DOMRect;};
 Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{configurable:true,get(){return 400;}});
 Object.defineProperty(window,'innerWidth',{value:1440,configurable:true});
 Object.defineProperty(window,'innerHeight',{value:900,configurable:true});
 const {createRoot}=await import('react-dom/client');
 const {CanvasEditor}=await import('../src/canvas.js');
 function Host(){
  const [graph,setGraph]=useState(()=>refreshChecks(canvas,yaml));
  const [source,setSource]=useState(yaml);
  return createElement(CanvasEditor,{graph,onChange:next=>setGraph(next),yaml:source,onYamlChange:setSource,catalog:[],diagnostics:[],pathId:'route',onPathChange:()=>{},disabled:false,scenarioMode:true,scenarioId:'main',scenarios:[{id:'main',name:'Main',pathId:'route'}],initialView:{selectedScreenId:'home',selectedVisitId:'v1'}});
 }
 const root=createRoot(document.getElementById('root')!);
 await act(async()=>root.render(createElement(Host)));
 const card=()=>document.querySelector<HTMLElement>('.floating-inspector');
 const press=async(target:Element,key:string)=>{
  let prevented=false;
  await act(async()=>{const event=new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});target.dispatchEvent(event);prevented=event.defaultPrevented;});
  return prevented;
 };
 return {window,document,card,press,async close(){await act(async()=>root.unmount());window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}};
}

test('isEditableTarget covers fields, selects and the YAML editor',()=>{
 const dom=new JSDOM('<input id="i"/><select id="s"></select><textarea id="t"></textarea><section aria-label="YAML form and code editor"><button id="y">YAML</button></section><button id="b">Go</button>');
 assert.equal(isEditableTarget(dom.window.document.getElementById('i')),true);
 assert.equal(isEditableTarget(dom.window.document.getElementById('s')),true);
 assert.equal(isEditableTarget(dom.window.document.getElementById('t')),true);
 assert.equal(isEditableTarget(dom.window.document.getElementById('y')),true);
 assert.equal(isEditableTarget(dom.window.document.getElementById('b')),false);
});

test('step list is one tab stop and arrows move between rows',async()=>{
 const page=await mount();
 try{
  const card=page.card()!;
  const summaries=[...card.querySelectorAll<HTMLButtonElement>('.visit-step-summary')];
  assert.ok(summaries.length>=2);
  assert.equal(summaries.filter(item=>item.tabIndex===0).length,1,'exactly one step summary is a tab stop');
  assert.equal(summaries[0].tabIndex,0);
  assert.ok(summaries.slice(1).every(item=>item.tabIndex===-1));
  assert.ok([...card.querySelectorAll<HTMLButtonElement>('.visit-step-drag')].every(item=>item.tabIndex===-1));
  assert.ok([...card.querySelectorAll<HTMLElement>('.visit-step-actions summary')].every(item=>item.tabIndex===-1));
  summaries[0].focus();
  await page.press(summaries[0],'ArrowDown');
  same(page.document.activeElement,summaries[1]);
  assert.equal(summaries[1].tabIndex,0);
  assert.equal(summaries[0].tabIndex,-1);
  await page.press(summaries[1],'ArrowUp');
  same(page.document.activeElement,summaries[0]);
  const close=card.querySelector<HTMLButtonElement>('.floating-inspector-close')!;
  assert.ok(close);
  assert.ok(summaries[0].compareDocumentPosition(close)&page.window.Node.DOCUMENT_POSITION_FOLLOWING,'close follows the step list in DOM/tab order');
 }finally{await page.close();}
});

test('editing exposes Destination, Pick/YAML and keeps close last in tab order',async()=>{
 const page=await mount();
 try{
  const card=page.card()!;
  const row=card.querySelector<HTMLElement>('[data-operation-id="avatar"]')!;
  await act(async()=>row.querySelector<HTMLButtonElement>('.visit-step-summary')!.click());
  const destination=row.querySelector<HTMLSelectElement>('[aria-label="Action 1 destination"]')!;
  assert.ok(destination);
  await act(async()=>row.querySelector<HTMLInputElement>('input[type=radio][value=id]')!.click());
  const pick=row.querySelector<HTMLButtonElement>('.pick-from-screen')!;
  assert.ok(pick);
  assert.ok(pick.closest('.element-field'),'Pick stays built into the Element field');
  const yaml=card.querySelector<HTMLButtonElement>('.visit-yaml-link')!;
  assert.ok(yaml);
  const close=card.querySelector<HTMLButtonElement>('.floating-inspector-close')!;
  assert.ok(destination.compareDocumentPosition(yaml)&page.window.Node.DOCUMENT_POSITION_FOLLOWING,'YAML follows Destination');
  assert.ok(yaml.compareDocumentPosition(close)&page.window.Node.DOCUMENT_POSITION_FOLLOWING,'✕ follows YAML');
  assert.equal(close,card.querySelector(':scope > .floating-inspector-close'),'✕ is the inspector\'s last control');
 }finally{await page.close();}
});

test('single-key shortcuts are suppressed in text fields and selects',async()=>{
 const page=await mount();
 try{
  const card=page.card()!;
  const row=card.querySelector<HTMLElement>('[data-operation-id="home-ready"]')!;
  await act(async()=>row.querySelector<HTMLButtonElement>('.visit-step-summary')!.click());
  const input=row.querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;
  input.focus();
  assert.equal(await page.press(input,'ArrowDown'),false,'arrow shortcuts do not move the step list while typing');
  same(page.document.activeElement,input);
  assert.equal(await page.press(input,'Escape'),true,'Escape still cancels the inline edit');
  assert.equal(row.querySelector('.visit-step-summary')!.getAttribute('aria-expanded'),'false');
  await act(async()=>row.querySelector<HTMLButtonElement>('.visit-step-summary')!.click());
  const matching=row.querySelector<HTMLSelectElement>('[aria-label="Check 1 matching"]')!;
  matching.focus();
  assert.equal(await page.press(matching,'ArrowDown'),false,'select retains arrow keys for its own UI');
  same(page.document.activeElement,matching);
 }finally{await page.close();}
});

test('errors use alert and status badges use status',async()=>{
 const page=await mount();
 try{
  const card=page.card()!;
  assert.equal(card.querySelector('.run-status-badge')?.getAttribute('role'),undefined);
  const row=card.querySelector<HTMLElement>('[data-operation-id="home-ready"]')!;
  await act(async()=>row.querySelector<HTMLButtonElement>('.visit-step-summary')!.click());
  const input=row.querySelector<HTMLInputElement>('[aria-label="Check 1 selector"]')!;
  await act(async()=>{
   Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype,'value')!.set!.call(input,'');
   input.dispatchEvent(new page.window.Event('input',{bubbles:true}));
  });
  await page.press(input,'Enter');
  assert.equal(row.querySelector('.visit-selector-error')?.getAttribute('role'),'alert');
 }finally{await page.close();}
});
