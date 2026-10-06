import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement,useState} from 'react';
import {YamlEditor} from '../src/yaml-editor.js';

test('users can alternate form and code edits, see unsupported content, and repair invalid drafts without losing them',async()=>{
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','IS_REACT_ACT_ENVIRONMENT'];
 const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const key of keys) Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root')!);
 const original='appId: com.example.App\n---\n- tapOn: Home # keep\n- waitForAnimationToEnd\n';
 function Host(){const [yaml,setYaml]=useState(original);return createElement(YamlEditor,{yaml,onChange:setYaml,disabled:false});}
 const document=dom.window.document;
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent===label);assert.ok(button);button.click();});
 const fill=async(id:string,value:string)=>act(async()=>{const node=document.getElementById(id) as HTMLInputElement|HTMLTextAreaElement;assert.ok(node);const prototype=node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 try{
  await act(async()=>{root.render(createElement(Host));});
  await click('Command forms');
  assert.match(document.body.textContent!,/waitForAnimationToEnd/);
  await fill('form-step-0','Coordinator');await click('Apply step 1');await click('YAML code');
  const text=document.getElementById('scenario-yaml') as HTMLTextAreaElement;
  assert.equal(text.value,original.replace('Home','"Coordinator"'));
  const direct=text.value.replace('"Coordinator"','Settings');await fill('scenario-yaml',direct);await click('Command forms');
  assert.equal((document.getElementById('form-step-0') as HTMLInputElement).value,'Settings');
  await click('YAML code');await fill('scenario-yaml','appId: [');await click('Command forms');
  assert.match(document.body.textContent!,/Your code is retained/);
  assert.equal((document.querySelector('fieldset') as HTMLFieldSetElement).disabled,true);
  await click('YAML code');assert.equal((document.getElementById('scenario-yaml') as HTMLTextAreaElement).value,'appId: [');
  await fill('scenario-yaml',direct);await click('Command forms');assert.equal(document.querySelector('[role="alert"]'),null);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
