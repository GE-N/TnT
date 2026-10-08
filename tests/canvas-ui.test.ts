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
