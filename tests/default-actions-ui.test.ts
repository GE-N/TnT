import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement,useState} from 'react';
import {DefaultActions} from '../src/default-actions.js';
import type {Automation} from '../server/default-actions.js';
test('authors can declare setup, configure and disable actions, and select explicit checkpoints',async()=>{
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 let saved:Automation|undefined;let error='';
 function Host(){const [value,setValue]=useState<Automation>();return createElement(DefaultActions,{value,onChange:next=>{saved=next;setValue(next);},files:['setup.yaml','back.yaml'],catalog:[{kind:'step',file:'flow.yaml',index:0,fingerprint:'abc',label:'Step 1 · assertVisible',command:'assertVisible',assertion:true,preview:'Home'}],disabled:false,onError:message=>{error=message;}});}
 const document=dom.window.document;
 const label=(text:string)=>{const node=[...document.querySelectorAll('label')].find(node=>node.textContent?.startsWith(text))?.querySelector('input,select,textarea');assert.ok(node);return node as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement;};
 const fill=async(text:string,value:string)=>act(async()=>{const node=label(text);const prototype=node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:node.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));});
 const click=async(text:string)=>act(async()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent===text);assert.ok(button);button.click();});
 try{
  await act(async()=>root.render(createElement(Host)));
  await act(async()=>label('Enable independent setup').click());assert.equal(saved?.setup.file,'setup.yaml');
  await fill('Setup parameters','{"USER":"${USER}"}');assert.equal(saved?.setup.parameters.USER,'${USER}');
  await click('Add default action');await fill('Name','Dismiss detail');await fill('Screen condition','Details');await fill('Action flow','back.yaml');
  await act(async()=>label('Enable Dismiss detail').click());assert.equal(saved?.actions[0].enabled,false);
  await fill('Checkpoint step','0');await click('Add checkpoint');assert.equal(saved?.checkpoints[0].fingerprint,'abc');
  await fill('Setup parameters','bad JSON');assert.match(error,/JSON object/);
  await fill('Setup parameters','{}');assert.equal(error,'');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
