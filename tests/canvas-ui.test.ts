import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {act,createElement,useState,type ChangeEvent} from 'react';import {CanvasEditor,CanvasBoard} from '../src/canvas.js';import {selectedCanvasPath} from '../server/canvas.js';import type {CanvasGraph,CatalogEntry} from '../server/canvas.js';
async function addNode(dom:JSDOM,title:string){
 const document=dom.window.document;
 await act(async()=>document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120})));
 await act(async()=>{const add=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent==='Add node');assert.ok(add);add.click();});
 await act(async()=>{const input=document.querySelector('[aria-label="Screen title for New screen"]')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,title);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 await act(async()=>document.querySelector(`[aria-label="Screen title for New screen"]`)!.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));
}
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
 const select=async(label:string,value:string)=>act(async()=>{const id=[...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor;const node=document.querySelector(`[aria-label="${label}"]`)??document.getElementById(id??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Select screen Home"]')!.click());await select('Executable YAML reference','0');
  await act(async()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='Associate test');assert.ok(button);button.click();});
  const association=saved!.screens[0].tests[0];assert.equal(association.role,'handler');assert.deepEqual(association.reference,{kind:'handler',file:'dismiss.yaml',index:1,actionId:'notice',fingerprint:'current'});
  assert.match(document.body.textContent!,/Handler notice · before step 2/);assert.doesNotMatch(document.body.textContent!,/#6.*unavailable/);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('canvas authors create inline checks, reorder, delete with warnings and undo synchronized YAML',async()=>{
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 let authored='';let saved:CanvasGraph|undefined;
 function Host(){const [graph,setGraph]=useState<CanvasGraph>({screens:[],edges:[],paths:[]});const [yaml,setYaml]=useState('appId: com.example.App\n---\n- launchApp\n- evalScript: ${output.keep = true} # untouched\n');const [path,setPath]=useState('');authored=yaml;saved=graph;return createElement('div',null,createElement(CanvasEditor,{graph,onChange:next=>setGraph(next!),yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:path,onPathChange:setPath,disabled:false}),createElement('textarea',{'aria-label':'Executable YAML',value:yaml,onChange:(event:ChangeEvent<HTMLTextAreaElement>)=>setYaml(event.target.value)}));}
 const document=dom.window.document;
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label);assert.ok(button,label);button.click();});
 const fill=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;assert.ok(node,label);Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const select=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));
  await addNode(dom,'Descriptive Home');assert.doesNotMatch(authored,/Descriptive Home/);
  await click('Add check to Descriptive Home');assert.ok(document.querySelector('[aria-label="Delete check 1"]')!.closest('details'),'Bin belongs inside the expanded check');assert.ok(document.querySelector('[aria-label="Delete check 1"] svg'),'Delete is a bin icon');await fill('Check 1 selector','Home (ready)');
  assert.match(authored,/\^Home \\\(ready\\\)\$/);assert.equal(saved!.screens[0].tests[0].check!.match,'exact');
  await select('Check 1 matching','regex');await fill('Check 1 selector','^Home$');assert.equal(saved!.screens[0].tests[0].check!.match,'regex');await select('Check 1 matching','contains');await fill('Check 1 selector','Ready');assert.equal(saved!.screens[0].tests[0].check!.match,'contains');
  await click('Add check to Descriptive Home');await select('Check 2 visibility','absent');await select('Check 2 target','id');await fill('Check 2 selector','error.banner');
  await fill('Executable YAML',authored.replace(/(# tnt-check:[^\n]+\n# tnt-match:[^\n]+\n- assertNotVisible)/,'- evalScript: ${output.between = true} # between\n$1'));
  await click('Move check 2 up');assert.match(authored,/assertNotVisible:[\s\S]*assertVisible:/);
  await click('Delete check 1');assert.match(document.querySelector('[role="alertdialog"]')!.textContent!,/checks/);await click('Delete anyway');assert.equal(saved!.screens[0].tests.length,1);assert.ok(authored.indexOf('output.between')<authored.indexOf('assertVisible'));
  await click('Undo canvas deletion');assert.equal(saved!.screens[0].tests.length,2);assert.match(authored,/error\\\.banner/);assert.match(authored,/evalScript:.*# untouched/);
  const first=authored.indexOf('# tnt-check:');const between=authored.indexOf('- evalScript: ${output.between');const second=authored.indexOf('# tnt-check:',first+1);await fill('Executable YAML',authored.slice(0,first)+authored.slice(second)+authored.slice(between,second)+authored.slice(first,between));
  assert.equal((document.querySelector('[aria-label="Check 1 selector"]') as HTMLInputElement).value,'Ready');await fill('Check 1 selector','Updated');assert.ok(authored.indexOf('assertVisible')<authored.indexOf('output.between'));assert.ok(authored.indexOf('output.between')<authored.indexOf('assertNotVisible'));
  await act(async()=>{document.querySelector('[data-screen-id]')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:100}));});await click('Delete node');await click('Delete anyway');assert.equal(saved!.screens.length,0);assert.doesNotMatch(authored,/assertVisible|assertNotVisible/);
  await click('Undo canvas deletion');assert.equal(saved!.screens[0].title,'Descriptive Home');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('opening a saved workspace replaces the canvas editor without duplicating it beside the YAML editor',async()=>{
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const workspace={id:'saved',name:'Saved home',yaml:'appId: com.example.App\n---\n- launchApp\n',canvas:{screens:[{id:'home',title:'Reloaded',x:60,y:70,tests:[]}],edges:[],paths:[]}};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?async()=>new Response(JSON.stringify(workspace)):key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {Scenarios}=await import('../src/scenarios.js');const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 try{
  await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId:'',bundleId:'',launchBusy:false,onRunning:()=>{}})));
  await act(async()=>{const input=dom.window.document.getElementById('open-workspace')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'saved');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await act(async()=>{[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent==='Open saved workspace')!.click();});
  assert.equal(dom.window.document.querySelectorAll('#canvas-heading').length,1);
  assert.equal(dom.window.document.querySelectorAll('[aria-label="Select screen Reloaded"]').length,1);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('Home can choose a destination in Add action and immediately see its connection',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);let authored='';let saved:CanvasGraph|undefined;
 function Host(){const [graph,setGraph]=useState<CanvasGraph>({screens:[{id:'home',title:'Home',x:0,y:0,tests:[]},{id:'coordinator',title:'Coordinator',x:400,y:0,tests:[]}],edges:[],paths:[]});const [yaml,setYaml]=useState('appId: com.example.App\n---\n- launchApp\n');const [path,setPath]=useState('');authored=yaml;saved=graph;return createElement(CanvasEditor,{graph,onChange:next=>setGraph(next!),yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:path,onPathChange:setPath,disabled:false});}
 const document=dom.window.document;
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label);assert.ok(button,label);button.click();});
 const fill=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`)??document.getElementById([...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const select=async(label:string,value:string)=>act(async()=>{const id=[...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor;const node=document.querySelector(`[aria-label="${label}"]`)??document.getElementById(id??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));await click('Add check to Coordinator');await fill('Check 1 selector','Coordinator');await click('Add action to Home');await fill('Action 1 selector','Coordinator');
  assert.match(authored,/tapOn:[\s\S]*\^Coordinator\$[\s\S]*assertVisible:/);
  await select('Action 1 destination','coordinator');assert.ok(document.querySelector('[aria-label="Connection Home to Coordinator"]'),'Destination selection immediately draws the line');
  assert.equal(saved!.edges.length,1);assert.deepEqual(saved!.paths[0].edgeIds,[saved!.edges[0].id]);assert.equal(saved!.edges[0].actionTestId,saved!.screens[0].tests[0].id);
  await click('Delete action 1');await click('Delete anyway');assert.equal(saved!.screens[0].tests.length,0);assert.equal(saved!.edges.length,0);assert.equal(saved!.paths[0].edgeIds.length,0);assert.doesNotMatch(authored,/tapOn:/);await click('Undo canvas deletion');assert.match(authored,/tapOn:/);assert.equal(saved!.edges.length,1);assert.deepEqual(saved!.paths[0].edgeIds,[saved!.edges[0].id]);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('dragged connections author ordered edge actions and preserve invalid routes for Undo',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);let authored='';let saved:CanvasGraph|undefined;let chosen='';
 function Host(){const [graph,setGraph]=useState<CanvasGraph>({screens:[{id:'home',title:'Home',x:0,y:0,tests:[]},{id:'other',title:'Other',x:400,y:400,tests:[]}],edges:[],paths:[{id:'route',name:'Chosen route',screenId:'home',edgeIds:[]}]});const [yaml,setYaml]=useState('appId: com.example.App\n---\n- launchApp\n- evalScript: ${output.keep = true} # untouched\n');const [path,setPath]=useState('route');authored=yaml;saved=graph;chosen=path;return createElement('div',null,createElement(CanvasEditor,{graph,onChange:next=>setGraph(next!),yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:path,onPathChange:setPath,disabled:false}),createElement('textarea',{'aria-label':'Executable YAML',value:yaml,onChange:(event:ChangeEvent<HTMLTextAreaElement>)=>setYaml(event.target.value)}));}
 const document=dom.window.document;
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label);assert.ok(button,label);button.click();});
 const fill=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`)??document.getElementById([...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const select=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`);assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 const connect=async(from:string,to:string)=>act(async()=>{const transfer={value:'',setData(_type:string,value:string){this.value=value;},getData(){return this.value;}};const start=new dom.window.Event('dragstart',{bubbles:true});Object.defineProperty(start,'dataTransfer',{value:transfer});document.querySelector(`[aria-label="Connect from ${from}"]`)!.dispatchEvent(start);const drop=new dom.window.Event('drop',{bubbles:true});Object.defineProperty(drop,'dataTransfer',{value:transfer});document.querySelector(`[aria-label="Screen ${to}"]`)!.dispatchEvent(drop);});
 try{
  await act(async()=>root.render(createElement(Host)));await addNode(dom,'Done');
  assert.equal(saved!.screens[2].title,'Done');assert.ok(!document.querySelector('[aria-label^="Add next screen"]'),'Nodes expose no Add next screen control');
  await click('Add check to Home');await fill('Check 1 selector','Home');await click('Add check to Done');
  const done=document.querySelector('[aria-label="Screen Done"]')!;await act(async()=>{const node=done.querySelector('[aria-label="Check 1 selector"]')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,'Done');node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await connect('Home','Done');
  await click('Add action to connection Home → Done');
  assert.deepEqual(saved!.paths[0].edgeIds,[saved!.edges[0].id]);assert.equal(chosen,'route');
  await fill('Home → Done action 1 selector','Field');
  await click('Add action to connection Home → Done');await select('Home → Done action 2 type','input');await fill('Home → Done action 2 text','hello');
  await click('Add action to connection Home → Done');await select('Home → Done action 3 type','back');
  assert.match(authored,/assertVisible:[\s\S]*tapOn:[\s\S]*inputText: hello[\s\S]*- back[\s\S]*assertVisible:/);
  await click('Move home → done action 3 up');assert.match(authored,/- back[\s\S]*inputText: hello/);
  await fill('Executable YAML',authored.replace('inputText: hello','inputText: changed'));assert.equal((document.querySelector('[aria-label="Home → Done action 3 text"]') as HTMLInputElement).value,'changed');
  const before=structuredClone(saved!);const beforeYaml=authored;
  await click('Delete home → done action 2');assert.match(document.querySelector('[role="alertdialog"]')!.textContent!,/Chosen route/);await click('Delete anyway');
  assert.deepEqual(saved!.paths[0].edgeIds,before.paths[0].edgeIds);assert.deepEqual(saved!.edges[0].actionTestIds,before.edges[0].actionTestIds);assert.doesNotMatch(authored,/- back/);
  await click('Undo canvas deletion');assert.deepEqual(saved!.edges,before.edges);assert.deepEqual(saved!.paths,before.paths);assert.equal(saved!.screens[0].tests.find(test=>test.input!==undefined)!.input,'changed');assert.equal(authored,beforeYaml);
  await connect('Home','Other');
  assert.equal(saved!.edges.length,2);assert.deepEqual(saved!.paths[0].edgeIds,before.paths[0].edgeIds,'Connecting a branch does not extend the active tail');assert.equal(saved!.paths.length,1);
  await click('Remove transition');await click('Delete anyway');assert.equal(saved!.edges.length,1);assert.deepEqual(saved!.paths[0].edgeIds,before.paths[0].edgeIds);await click('Undo canvas deletion');assert.equal(saved!.edges.length,2);assert.match(authored,/# untouched/);
  const beforeRename=authored;const title=document.querySelector('[aria-label="Screen title for Done"]') as HTMLInputElement;assert.ok(title,'Title is editable on the canvas node');assert.ok(title.closest('[data-screen-id]'));
  await fill('Screen title for Done','Details');await act(async()=>title.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));assert.equal(saved!.screens[2].title,'Details');assert.equal(authored,beforeRename);assert.ok(document.querySelector('[aria-label="Connection Home to Details"]'));
  await fill('Screen title for Details','');await act(async()=>title.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));assert.equal(saved!.screens[2].title,'Details');assert.equal(title.value,'Details');
  await fill('Screen title for Details','Cancelled');await act(async()=>title.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(saved!.screens[2].title,'Details');assert.equal(title.value,'Details');
  await fill('Screen title for Details','Done');await act(async()=>title.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));
  const beforeNode=authored;const references=structuredClone(saved!.paths);await act(async()=>{document.querySelector('[aria-label="Screen Done"]')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:100}));});await click('Delete node');assert.match(document.querySelector('[role="alertdialog"]')!.textContent!,/Chosen route/);await click('Delete anyway');assert.ok(!saved!.screens.some(screen=>screen.title==='Done'));assert.deepEqual(saved!.paths,references);assert.ok(!document.querySelector('[aria-label="Screen Done"]'));await click('Undo canvas deletion');assert.ok(document.querySelector('[aria-label="Screen Done"]'));assert.equal(authored,beforeNode);
  const intact=authored;
  for(const command of ['inputText: changed','back']){
   const removed=intact.replace(new RegExp('# tnt-check:[^\\n]+\\n- '+command+'\\n'),'');await fill('Executable YAML',removed);await fill('Check 1 selector','Changed Home');assert.match(document.body.textContent!,/command was removed from YAML/);assert.equal(authored,removed);await fill('Executable YAML',intact);
  }
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('creating the first screen selects its explicit route without Add next screen',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);let authored='';let saved:CanvasGraph|undefined;let chosen='';
 function Host(){const [graph,setGraph]=useState<CanvasGraph>({screens:[],edges:[],paths:[]});const [yaml,setYaml]=useState('appId: com.example.App\n---\n- launchApp\n- evalScript: ${output.keep = true} # untouched\n');const [path,setPath]=useState('');authored=yaml;saved=graph;chosen=path;return createElement('div',null,createElement(CanvasEditor,{graph,onChange:next=>setGraph(next!),yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:path,onPathChange:setPath,disabled:false}),createElement('textarea',{'aria-label':'Executable YAML',value:yaml,onChange:(event:ChangeEvent<HTMLTextAreaElement>)=>setYaml(event.target.value)}));}
 const document=dom.window.document;
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label);assert.ok(button,label);button.click();});
 const fill=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`)??document.getElementById([...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));await addNode(dom,'Home');
  assert.equal(chosen,saved!.paths[0].id,'Creating the initial screen selects its explicit route');
  assert.ok(!document.querySelector('[aria-label^="Add next screen"]'));
  assert.ok(![...document.querySelectorAll('button')].some(button=>button.textContent==='Use as single-screen scenario'));
  await click('Add check to Home');await fill('Check 1 selector','Home');
  assert.doesNotThrow(()=>selectedCanvasPath(saved!,authored,{},chosen));
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('visit editors preserve subsets and identities through repeated transitions and deletion Undo',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
 const check=(id:string,value:string)=>({id,label:value,role:'assertion' as const,reference,check:{visibility:'visible' as const,target:'text' as const,match:'regex' as const,value}});
 const initial:CanvasGraph={screens:[{id:'home',title:'Home',x:0,y:0,tests:[check('initial','Initial'),check('returned','Returned'),{id:'open',label:'Open',role:'action',reference,tap:{target:'text',match:'regex',value:'Coordinator'}}]},{id:'details',title:'Coordinator',x:400,y:0,tests:[check('fixed','Fixed'),{id:'back',label:'Back',role:'action',reference,back:true}]}],edges:[{id:'go',from:'home',to:'details',actionTestId:'open',actionTestIds:['open'],assertionTestId:'fixed',responseCondition:'Go'},{id:'return',from:'details',to:'home',actionTestId:'back',actionTestIds:['back'],assertionTestId:'initial',responseCondition:'Back'}],paths:[{id:'route',name:'Home return',screenId:'home',edgeIds:['go','return']}]};
 let saved=initial;
 function Host(){const [graph,setGraph]=useState(initial);const [yaml,setYaml]=useState('appId: com.example.App\n---\n# tnt-check:initial\n- assertVisible: Initial\n# tnt-check:returned\n- assertVisible: Returned\n# tnt-check:open\n- tapOn: Coordinator\n# tnt-check:fixed\n- assertVisible: Fixed\n# tnt-check:back\n- back\n');saved=graph;return createElement(CanvasEditor,{graph,onChange:next=>setGraph(next!),yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:'route',onPathChange:()=>{},disabled:false});}
 const document=dom.window.document;
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll<HTMLElement>('button,input[type=checkbox]')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(button,label);button.click();});
 const select=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;assert.ok(node,label);node.value=value;node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));
  await select('Visit 1 checks','subset');await click('Visit 1 check Returned');
  await select('Visit 3 checks','subset');await click('Visit 3 check Initial');
  assert.deepEqual(saved.paths[0].visits!.map(visit=>visit.checkIds),[['initial'],undefined,['returned']]);const ids=saved.paths[0].visits!.map(visit=>visit.id);
  await select('Next transition','go');await click('Append transition to path');assert.deepEqual(saved.paths[0].edgeIds,['go','return','go']);assert.deepEqual(saved.paths[0].visits!.slice(0,3).map(visit=>visit.id),ids);
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].filter(button=>button.textContent==='Remove from path').at(-1)!.click();});assert.ok(document.querySelector('[role=alertdialog]'));await click('Delete anyway');assert.equal(saved.paths[0].visits!.length,3);await click('Undo canvas deletion');assert.equal(saved.paths[0].visits!.length,4);assert.deepEqual(saved.paths[0].visits!.slice(0,3).map(visit=>visit.id),ids);
  await click('Delete check 2');assert.match(document.querySelector('[role="alertdialog"]')!.textContent!,/Home return/);await click('Delete anyway');
  assert.match(document.querySelector('[aria-label="Visit 3"]')!.textContent!,/Missing check: returned/);assert.deepEqual(saved.paths[0].visits![2].checkIds,['returned']);
  await click('Undo canvas deletion');assert.deepEqual(saved.paths[0].visits![2].checkIds,['returned']);assert.doesNotMatch(document.querySelector('[aria-label="Visit 3"]')!.textContent!,/Missing check/);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('canvas context menus add at the clicked position and delete nodes with warnings and Undo',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);let saved:CanvasGraph|undefined;let path='';
 function Host({disabled=false}:{disabled?:boolean}){const [graph,setGraph]=useState<CanvasGraph>({screens:[],edges:[],paths:[]});const [selected,setSelected]=useState('');saved=graph;path=selected;return createElement(CanvasEditor,{graph,onChange:next=>setGraph(next!),catalog:[],diagnostics:[],pathId:selected,onPathChange:setSelected,disabled});}
 const document=dom.window.document;
 const context=async(target:Element)=>act(async()=>{target.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:340,clientY:170}));});
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(button,label);button.click();});
 try{
  await act(async()=>root.render(createElement(Host)));
  await context(document.querySelector('.canvas-surface')!);assert.ok(document.querySelector('[role=menu]'));assert.equal(document.activeElement?.getAttribute('role'),'menuitem');
  await act(async()=>document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.ok(!document.querySelector('[role=menu]'));
  await context(document.querySelector('.canvas-surface')!);await click('Add node');
  assert.equal(saved!.screens.length,1);assert.equal(saved!.screens[0].x,400);assert.equal(saved!.screens[0].y,200);assert.equal(saved!.paths[0].screenId,saved!.screens[0].id);assert.equal(path,saved!.paths[0].id);assert.ok(!document.querySelector('.screen-node-delete'));
  const node=document.querySelector('[data-screen-id]')!;const position={x:saved!.screens[0].x,y:saved!.screens[0].y};
  await context(node);assert.deepEqual([...document.querySelectorAll('[role=menuitem]')].map(item=>item.textContent),['Node info','Delete node']);
  await act(async()=>document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true})));assert.ok(!document.querySelector('[role=menu]'));
  await context(node);await click('Delete node');assert.ok(document.querySelector('[role=alertdialog]'));await click('Delete anyway');assert.equal(saved!.screens.length,0);await click('Undo canvas deletion');assert.deepEqual({x:saved!.screens[0].x,y:saved!.screens[0].y},position);
  await act(async()=>root.render(createElement(Host,{disabled:true})));await context(document.querySelector('.canvas-surface')!);assert.ok(!document.querySelector('[role=menu]'));await context(document.querySelector('[data-screen-id]')!);assert.ok(!document.querySelector('[role=menu]'));
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('canvas Run scenario uses the selected path and shows blocked runs in a dismissible toast',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const workspace={id:'saved',name:'Home route',yaml:'appId: com.example.App\n---\n- launchApp\n',canvas:{screens:[{id:'home',title:'Home',x:60,y:70,tests:[]}],edges:[],paths:[{id:'route',name:'Home checks',screenId:'home',edgeIds:[]}]}};
 const requests:Record<string,unknown>[]=[];let rejectRun=true;
 const fetchMock=async(path:string,options?:RequestInit)=>{
  if(path==='/api/runs'){
   requests.push(JSON.parse(String(options?.body)));
   if(rejectRun)return Response.json({error:'Select a nonempty explicit scenario path.'},{status:400});
   return Response.json({id:'run',status:'passed',snapshot:{id:'snapshot',name:workspace.name,yaml:workspace.yaml,toolVersions:{maestro:'test',node:'test'}},cleanup:{verified:true,detail:'Done'},steps:[],artifacts:[],log:''});
  }
  if(path==='/api/canvas/references')return Response.json({references:[],diagnostics:[]});
  return Response.json(workspace);
 };
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetchMock:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {Scenarios}=await import('../src/scenarios.js');const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);const document=dom.window.document;
 const render=async(deviceId='device')=>act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId,bundleId:'',launchBusy:false,onRunning:()=>{}})));
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(button,label);button.click();});
 const context=async()=>act(async()=>document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120})));
 const runFromMenu=async()=>{await context();await act(async()=>{const menu=document.querySelector('[role=menu]')!;menu.querySelectorAll<HTMLButtonElement>('button')[1].click();});};
 try{
  await render();await act(async()=>{const input=document.getElementById('open-workspace')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'saved');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});await click('Open saved workspace');
  await context();assert.deepEqual([...document.querySelectorAll('[role=menuitem]')].map(node=>node.textContent),['Add node','Run scenario']);
  await act(async()=>document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));assert.equal(document.activeElement?.textContent,'Run scenario');
  await act(async()=>document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));assert.equal(document.activeElement?.textContent,'Add node');
  await runFromMenu();assert.ok(!document.querySelector('[role=menu]'));assert.equal(requests[0].pathId,'');
  const toast=document.querySelector('.run-error-toast[role=alert]')!;assert.match(toast.textContent!,/Cannot run scenario.*Select a nonempty explicit scenario path/);assert.equal(document.querySelector('.scenario-editor [role=alert]'),null);
  await click('Dismiss run error');assert.equal(document.querySelector('.run-error-toast'),null);
  await runFromMenu();assert.ok(document.querySelector('.run-error-toast'));
  await act(async()=>{const label=[...document.querySelectorAll('label')].find(node=>node.textContent==='Scenario path')!;const select=document.getElementById(label.htmlFor) as HTMLSelectElement;select.value='route';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  rejectRun=false;await runFromMenu();assert.equal(requests.at(-1)!.pathId,'route');assert.equal(requests.at(-1)!.deviceId,'device');assert.equal(document.querySelector('.run-error-toast'),null);assert.match(document.querySelector('.result-tag')!.textContent!,/passed/);
  await render('');await runFromMenu();assert.match(document.querySelector('.run-error-toast')!.textContent!,/Select a device/);assert.equal(requests.length,3,'Missing device does not submit a run');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});


test('Run scenario receives menu focus when the canvas node limit disables Add node',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 const graph:CanvasGraph={screens:Array.from({length:40},(_,index)=>({id:String(index),title:'Screen '+index,x:0,y:0,tests:[]})),edges:[],paths:[]};
 try{
  await act(async()=>root.render(createElement(CanvasBoard,{graph,onAdd:()=>{},onRun:()=>{}})));
  await act(async()=>dom.window.document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120})));
  assert.equal(dom.window.document.activeElement?.textContent,'Run scenario');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
