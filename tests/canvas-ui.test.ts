import {inspectorCard,inspectorOwner,inspectScreen,showLegacyCanvasControls,workspaceCommand,singleWorkspaceLibrary} from './workspace-ui-helpers.js';
import {openStepMenuItem} from './step-menu.js';
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM} from 'jsdom';import {act,createElement,useState,type ChangeEvent} from 'react';import {CanvasEditor,CanvasBoard} from '../src/canvas.js';import {selectedCanvasPath} from '../server/canvas.js';import type {CanvasGraph,CatalogEntry} from '../server/canvas.js';
async function addNode(dom:JSDOM,title:string){
 const document=dom.window.document;
 await act(async()=>document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120})));
 await act(async()=>{const add=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent==='Add node');assert.ok(add);add.click();});
 const node=document.querySelector('[aria-label="Screen New screen"]');assert.ok(node);
 await act(async()=>node.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:140,clientY:140})));
 await act(async()=>{const rename=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent==='Rename');assert.ok(rename);rename.click();});
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
 const click=async(label:string)=>{const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});if(label==='Open saved workspace'||label==='Save workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open');return act(async()=>{let button=[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label)??openStepMenuItem(document,label);assert.ok(button,label);button.click();})};
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
  await click('Delete check 1');assert.equal(document.querySelector('[role="alertdialog"]'),null,'Step deletion uses Undo');assert.equal(saved!.screens[0].tests.length,1);assert.ok(authored.indexOf('output.between')<authored.indexOf('assertVisible'));
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
 // Force the reference debounce to run while Open is pending, as it does under load.
 let referencesRequested!:()=>void;
 const initialReferences=new Promise<void>(resolve=>{referencesRequested=resolve;});
 const workspace={id:'saved',name:'Saved home',yaml:'appId: com.example.App\n---\n- launchApp\n',canvas:{screens:[{id:'home',title:'Reloaded',x:60,y:70,tests:[]}],edges:[],paths:[]}};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?async(path:string)=>{if(path==='/api/canvas/references')referencesRequested();if(path.endsWith('/open')){await initialReferences;await new Promise(resolve=>setImmediate(resolve));}return Response.json(path==='/api/canvas/references'?{references:[],diagnostics:[]}:path.startsWith('/api/workspaces?q=')?singleWorkspaceLibrary(workspace):workspace);}:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {Scenarios}=await import('../src/scenarios.js');const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 try{
  await act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId:'',bundleId:'',launchBusy:false,onRunning:()=>{}})));
  await workspaceCommand(dom.window.document,'open');
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
 const click=async(label:string)=>{const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});if(label==='Open saved workspace'||label==='Save workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open');return act(async()=>{let button=[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label)??openStepMenuItem(document,label);assert.ok(button,label);button.click();})};
 const fill=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`)??document.getElementById([...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const select=async(label:string,value:string)=>act(async()=>{const id=[...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor;const node=document.querySelector(`[aria-label="${label}"]`)??document.getElementById(id??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));await click('Add check to Coordinator');await fill('Check 1 selector','Coordinator');await click('Add action to Home');await fill('Action 1 selector','Coordinator');
  assert.match(authored,/tapOn:[\s\S]*\^Coordinator\$[\s\S]*assertVisible:/);
  await select('Action 1 destination','coordinator');assert.ok(document.querySelector('[aria-label="Connection Home to Coordinator"]'),'Destination selection immediately draws the line');
  assert.equal(saved!.edges.length,1);assert.deepEqual(saved!.paths[0].edgeIds,[saved!.edges[0].id]);assert.equal(saved!.edges[0].actionTestId,saved!.screens[0].tests[0].id);
  await click('Delete action 1');assert.equal(document.querySelector('[role="alertdialog"]'),null);assert.equal(saved!.screens[0].tests.length,0);assert.equal(saved!.edges.length,0);assert.equal(saved!.paths[0].edgeIds.length,0);assert.doesNotMatch(authored,/tapOn:/);await click('Undo canvas deletion');assert.match(authored,/tapOn:/);assert.equal(saved!.edges.length,1);assert.deepEqual(saved!.paths[0].edgeIds,[saved!.edges[0].id]);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});

test('action destinations clean deleted references and Undo restores the original route',async()=>{
 const dom=new JSDOM('<div id="root"></div>');const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT'];const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);let authored='';let saved:CanvasGraph|undefined;let chosen='';
 function Host(){const [graph,setGraph]=useState<CanvasGraph>({screens:[{id:'home',title:'Home',x:0,y:0,tests:[]},{id:'other',title:'Other',x:400,y:400,tests:[]}],edges:[],paths:[{id:'route',name:'Chosen route',screenId:'home',edgeIds:[]}]});const [yaml,setYaml]=useState('appId: com.example.App\n---\n- launchApp\n- evalScript: ${output.keep = true} # untouched\n');const [path,setPath]=useState('route');authored=yaml;saved=graph;chosen=path;return createElement('div',null,createElement(CanvasEditor,{graph,onChange:next=>setGraph(next!),yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:path,onPathChange:setPath,disabled:false}),createElement('textarea',{'aria-label':'Executable YAML',value:yaml,onChange:(event:ChangeEvent<HTMLTextAreaElement>)=>setYaml(event.target.value)}));}
 const document=dom.window.document;
 const click=async(label:string)=>{const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});if(label==='Open saved workspace'||label==='Save workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open');return act(async()=>{let button=[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label)??openStepMenuItem(document,label);assert.ok(button,label);button.click();})};
 const fill=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`)??document.getElementById([...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor??'');assert.ok(node,label);Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const select=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`);assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 const connect=async(from:string,to:string)=>{await click('Add action to '+from);await act(async()=>{const destination=inspectorCard(document)!.querySelector<HTMLSelectElement>(`[aria-label$=" destination"]`)!;destination.value=saved!.screens.find(screen=>screen.title===to)!.id;destination.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});};
 try{
  await act(async()=>root.render(createElement(Host)));await addNode(dom,'Done');
  assert.equal(saved!.screens[2].title,'Done');assert.ok(!document.querySelector('[aria-label^="Add next screen"]'),'Nodes expose no Add next screen control');
  await click('Add check to Home');await fill('Check 1 selector','Home');await click('Add check to Done');
  const done=await inspectScreen(document,{title:'Done'});await act(async()=>{const node=done.querySelector('[aria-label="Check 1 selector"]')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,'Done');node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await connect('Home','Done');
  assert.deepEqual(saved!.paths[0].edgeIds,[saved!.edges[0].id]);assert.equal(chosen,'route');
  await fill('Home → Done action 1 selector','Field');
  await click('Add action to connection Home → Done');await select('Home → Done action 2 type','input');await fill('Home → Done action 2 text','hello');
  await click('Add action to connection Home → Done');await select('Home → Done action 3 type','back');
  assert.match(authored,/assertVisible:[\s\S]*tapOn:[\s\S]*inputText: hello[\s\S]*\^Back\$[\s\S]*assertVisible:/);
  await click('Move home → done action 3 up');assert.match(authored,/\^Back\$[\s\S]*inputText: hello/);
  await fill('Executable YAML',authored.replace('inputText: hello','inputText: changed'));assert.equal((document.querySelector('[aria-label="Home → Done action 3 text"]') as HTMLInputElement).value,'changed');
  const before=structuredClone(saved!);const beforeYaml=authored;
  await click('Delete home → done action 2');assert.equal(document.querySelector('[role="alertdialog"]'),null,'Step deletion uses Undo');
  assert.deepEqual(saved!.paths[0].edgeIds,before.paths[0].edgeIds);assert.deepEqual(saved!.edges[0].actionTestIds,before.edges[0].actionTestIds!.filter(id=>id!==before.screens[0].tests.find(test=>test.back)!.id));assert.doesNotMatch(authored,/- back/);
  await click('Undo canvas deletion');assert.deepEqual(saved!.edges,before.edges);assert.deepEqual(saved!.paths,before.paths);assert.equal(saved!.screens[0].tests.find(test=>test.input!==undefined)!.input,'changed');assert.equal(authored,beforeYaml);
  await connect('Home','Other');
  assert.equal(saved!.edges.length,2);assert.deepEqual(saved!.paths[0].edgeIds,before.paths[0].edgeIds,'Connecting a branch does not extend the active tail');assert.equal(saved!.paths.length,1);
  await click('Remove transition');await click('Delete anyway');assert.equal(saved!.edges.length,1);assert.deepEqual(saved!.paths[0].edgeIds,[]);await click('Undo canvas deletion');assert.equal(saved!.edges.length,2);assert.match(authored,/# untouched/);
  const beforeRename=authored;assert.equal(document.querySelector('[aria-label="Screen title for Done"]'),null);
  const startRename=async(name:string)=>{await act(async()=>document.querySelector(`[aria-label="Screen ${name}"]`)!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:100})));await click('Rename');};
  await startRename('Done');const title=document.querySelector('[aria-label="Screen title for Done"]') as HTMLInputElement;assert.ok(title,'Rename opens the title on the canvas node');assert.ok(title.closest('[data-screen-id]'));
  await fill('Screen title for Done','Details');await act(async()=>title.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));assert.equal(saved!.screens[2].title,'Details');assert.equal(authored,beforeRename);assert.ok(document.querySelector('[aria-label="Connection Home to Details"]'));assert.equal(document.querySelector('[aria-label="Screen title for Details"]'),null);
  await startRename('Details');await fill('Screen title for Details','');await act(async()=>document.querySelector('[aria-label="Screen title for Details"]')!.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));assert.equal(saved!.screens[2].title,'Details');assert.equal(document.querySelector('[aria-label="Screen title for Details"]'),null);
  await startRename('Details');await fill('Screen title for Details','Cancelled');await act(async()=>document.querySelector('[aria-label="Screen title for Details"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(saved!.screens[2].title,'Details');assert.equal(document.querySelector('[aria-label="Screen title for Details"]'),null);assert.ok(document.querySelector('.floating-inspector'));
  await startRename('Details');await fill('Screen title for Details','Done');await act(async()=>document.querySelector('[aria-label="Screen title for Details"]')!.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));
  const beforeNode=authored;const references=structuredClone(saved!.paths);await act(async()=>{document.querySelector('[aria-label="Screen Done"]')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:100}));});await click('Delete node');assert.match(document.querySelector('[role="alertdialog"]')!.textContent!,/Chosen route/);await click('Delete anyway');assert.ok(!saved!.screens.some(screen=>screen.title==='Done'));assert.deepEqual(saved!.paths[0].edgeIds,[]);assert.equal(saved!.paths[0].visits!.length,1);assert.ok(!document.querySelector('[aria-label="Screen Done"]'));await click('Undo canvas deletion');assert.ok(document.querySelector('[aria-label="Screen Done"]'));assert.equal(authored,beforeNode);
  const intact=authored;
  for(const command of ['inputText: changed','tapOn:\\n    text: \\^Back\\$']){
   const removed=intact.replace(new RegExp('# tnt-check:[^\\n]+\\n(?:# tnt-back\\n# tnt-match:exact\\n)?- '+command+'\\n'),'');await fill('Executable YAML',removed);await fill('Check 1 selector','Changed Home');assert.match(document.body.textContent!,/command was removed from YAML/);assert.equal(authored,removed);await fill('Executable YAML',intact);
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
 const click=async(label:string)=>{const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});if(label==='Open saved workspace'||label==='Save workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open');return act(async()=>{let button=[...document.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)===label)??openStepMenuItem(document,label);assert.ok(button,label);button.click();})};
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
 const click=async(label:string)=>{const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});if(label==='Open saved workspace'||label==='Save workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open');return act(async()=>{let button=[...document.querySelectorAll<HTMLElement>('button,input[type=checkbox]')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label)??openStepMenuItem(document,label);assert.ok(button,label);button.click();})};
 const select=async(label:string,value:string)=>act(async()=>{const node=document.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;assert.ok(node,label);node.value=value;node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await act(async()=>root.render(createElement(Host)));
  await select('Visit 1 checks','subset');await click('Visit 1 check Returned');
  await select('Visit 3 checks','subset');await click('Visit 3 check Initial');
  assert.deepEqual(saved.paths[0].visits!.map(visit=>visit.checkIds),[['initial'],undefined,['returned']]);const ids=saved.paths[0].visits!.map(visit=>visit.id);
  await select('Next transition','go');await click('Append transition to path');assert.deepEqual(saved.paths[0].edgeIds,['go','return','go']);assert.deepEqual(saved.paths[0].visits!.slice(0,3).map(visit=>visit.id),ids);
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].filter(button=>button.textContent==='Remove from path').at(-1)!.click();});assert.ok(document.querySelector('[role=alertdialog]'));await click('Delete anyway');assert.equal(saved.paths[0].visits!.length,3);await click('Undo canvas deletion');assert.equal(saved.paths[0].visits!.length,4);assert.deepEqual(saved.paths[0].visits!.slice(0,3).map(visit=>visit.id),ids);
  await inspectScreen(document,{title:'Home'});await click('Delete check 2');assert.equal(document.querySelector('[role="alertdialog"]'),null);
  assert.doesNotMatch(document.querySelector('[aria-label="Visit 3"]')!.textContent!,/Missing check/);assert.deepEqual(saved.paths[0].visits![2].checkIds,[]);
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
 const click=async(label:string)=>{const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});if(label==='Open saved workspace'||label==='Save workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open');return act(async()=>{let button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label)??openStepMenuItem(document,label);assert.ok(button,label);button.click();})};
 try{
  await act(async()=>root.render(createElement(Host)));
  await context(document.querySelector('.canvas-surface')!);assert.ok(document.querySelector('[role=menu]'));assert.equal(document.activeElement?.getAttribute('role'),'menuitem');
  await act(async()=>document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.ok(!document.querySelector('[role=menu]'));
  await context(document.querySelector('.canvas-surface')!);await click('Add node');
  assert.equal(saved!.screens.length,1);assert.equal(saved!.screens[0].x,400);assert.equal(saved!.screens[0].y,200);assert.equal(saved!.paths[0].screenId,saved!.screens[0].id);assert.equal(path,saved!.paths[0].id);assert.ok(!document.querySelector('.screen-node-delete'));
  const node=document.querySelector('[data-screen-id]')!;const position={x:saved!.screens[0].x,y:saved!.screens[0].y};
  await context(node);assert.deepEqual([...document.querySelectorAll('[role=menuitem]')].map(item=>item.textContent),['Rename','Node info','Delete node']);
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
  return Response.json(path.startsWith('/api/workspaces?q=')?singleWorkspaceLibrary(workspace):workspace);
 };
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetchMock:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {Scenarios}=await import('../src/scenarios.js');const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);const document=dom.window.document;
 const render=async(deviceId='device')=>act(async()=>root.render(createElement(Scenarios,{token:'test',deviceId,bundleId:'',launchBusy:false,onRunning:()=>{}})));
 const click=async(label:string)=>{const owner=inspectorOwner(label);if(owner)await inspectScreen(document,{title:owner});if(label==='Open saved workspace'||label==='Save workspace')return workspaceCommand(document,label==='Save workspace'?'save':'open');return act(async()=>{let button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label)??openStepMenuItem(document,label);assert.ok(button,label);button.click();})};
 const context=async()=>act(async()=>document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120})));
 const runFromMenu=async()=>{await context();await act(async()=>{const menu=document.querySelector('[role=menu]')!;menu.querySelectorAll<HTMLButtonElement>('button')[1].click();});};
 try{
  await render();await click('Open saved workspace');await showLegacyCanvasControls(document,act);
  await context();assert.deepEqual([...document.querySelectorAll('[role=menuitem]')].map(node=>node.textContent),['Add node','Run scenario','View YAML']);
  await act(async()=>document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));assert.equal(document.activeElement?.textContent,'Run scenario');
  await act(async()=>document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));assert.equal(document.activeElement?.textContent,'View YAML');
  await act(async()=>document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));assert.equal(document.activeElement?.textContent,'Add node');
  await runFromMenu();assert.ok(!document.querySelector('[role=menu]'));assert.equal(requests[0].pathId,'');
  const toast=document.querySelector('.run-error-toast[role=alert]')!;assert.match(toast.textContent!,/Cannot run scenario.*Select a nonempty explicit scenario path/);assert.equal(document.querySelector('.scenario-editor [role=alert]'),null);
  await click('Dismiss run error');assert.equal(document.querySelector('.run-error-toast'),null);
  await runFromMenu();assert.ok(document.querySelector('.run-error-toast'));
  await act(async()=>{const label=[...document.querySelectorAll('label')].find(node=>node.textContent==='Scenario path')!;const select=document.getElementById(label.htmlFor) as HTMLSelectElement;select.value='route';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  rejectRun=false;await runFromMenu();assert.equal(requests.at(-1)!.pathId,'route');assert.equal(requests.at(-1)!.deviceId,'device');assert.equal(document.querySelector('.run-error-toast'),null);assert.match(document.querySelector('.result-tag')!.textContent!,/passed/);
  await render('');await context();assert.deepEqual([...document.querySelectorAll('[role=menu] button')].map(node=>node.textContent),['Add node','View YAML'],'Offline canvas offers Add node and View YAML');assert.equal(document.querySelector('[aria-label="Run scenario"]'),null,'Offline work does not offer an enabled Run scenario control');assert.equal(requests.length,3,'Missing device does not submit a run');
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

const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
const scenarioGraph:CanvasGraph={
 screens:[
  {id:'home',title:'Home',x:40,y:40,tests:[{id:'go',label:'Go',role:'action',reference,tap:{target:'text',match:'exact',value:'Go'}}]},
  {id:'done',title:'Done',x:420,y:40,tests:[{id:'ready',label:'Ready',role:'assertion',reference:{...reference,index:1},check:{visibility:'visible',target:'text',match:'exact',value:'Ready'}}]},
  {id:'other',title:'Other',x:40,y:280,tests:[]},
 ],
 edges:[{id:'home-done',from:'home',to:'done',actionTestId:'go',assertionTestId:'ready',responseCondition:'Go'}],
 paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:['home-done'],visits:[{id:'v-home'},{id:'v-done'}]}],
};
const scenarioYaml='appId: com.example.App\n---\n- launchApp\n';

async function withDom(run:(dom:JSDOM)=>Promise<void>){
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Node','Event','KeyboardEvent','MouseEvent','PointerEvent','ResizeObserver','MutationObserver','IS_REACT_ACT_ENVIRONMENT'];
 const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 try{await run(dom);}finally{dom.window.close();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
}

test('Node details has no YAML row for any node or visit',async()=>{
 await withDom(async dom=>{
  const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
  const document=dom.window.document;
  function Host(){const [graph,setGraph]=useState(scenarioGraph);const [yaml,setYaml]=useState(scenarioYaml);return createElement(CanvasEditor,{graph,onChange:next=>{if(next)setGraph(next);},yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:'route',onPathChange:()=>{},disabled:false,scenarioMode:true,scenarioId:'main',scenarios:[{id:'main',name:'Main',pathId:'route'}],onRun:()=>{}});}
  try{
   await act(async()=>root.render(createElement(Host)));
   for(const visit of [{title:'Home',number:1},{title:'Done',number:2}] as const){
    const section=await inspectScreen(document,{title:visit.title},{number:visit.number});
    assert.equal(section.querySelector('.visit-yaml-link'),null,visit.title);
    assert.equal(section.textContent?.includes('YAML'),false,visit.title);
    assert.equal(section.querySelector('[aria-label^="Open YAML"]'),null,visit.title);
   }
   const other=await inspectScreen(document,{title:'Other'});
   assert.equal(other.querySelector('.visit-yaml-link'),null);
   assert.equal(document.querySelector('.visit-yaml-link'),null);
   assert.equal(document.querySelector('[aria-label^="Open YAML"]'),null);
   assert.equal(inspectorCard(document)?.textContent?.includes('{ } YAML'),false);
  }finally{await act(async()=>root.unmount());}
 });
});

test('View YAML on the empty-canvas menu opens the existing YAML card and returns focus to the canvas',async()=>{
 await withDom(async dom=>{
  const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
  const document=dom.window.document;
  function Host(){const [graph,setGraph]=useState(scenarioGraph);const [yaml,setYaml]=useState(scenarioYaml);return createElement(CanvasEditor,{graph,onChange:next=>{if(next)setGraph(next);},yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:'route',onPathChange:()=>{},disabled:false,scenarioMode:true,scenarioId:'main',scenarios:[{id:'main',name:'Main',pathId:'route'}],onRun:()=>{}});}
  try{
   await act(async()=>root.render(createElement(Host)));
   const surface=document.querySelector<HTMLElement>('.canvas-surface')!;
   await act(async()=>surface.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:80})));
   const items=[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
   assert.deepEqual(items.map(item=>item.textContent),['Add node','Run scenario','View YAML']);
   const view=items.at(-1)!;
   assert.equal(view.className,items[0].className);
   assert.equal(view.disabled,false);
   assert.equal(view.getAttribute('title'),null);
   await act(async()=>view.click());
   assert.equal(document.querySelector('[role=menu]'),null);
   const card=document.querySelector<HTMLElement>('[role="dialog"][aria-label="YAML"]');
   assert.ok(card);
   assert.equal(card.hidden,false);
   assert.equal(card.querySelector('textarea')?.id,'yaml-card');
   await act(async()=>card.querySelector<HTMLButtonElement>('[aria-label="Close YAML"]')!.click());
   assert.equal(document.querySelector('[role="dialog"][aria-label="YAML"]:not([hidden])'),null);
   assert.equal(document.activeElement,surface);
  }finally{await act(async()=>root.unmount());}
 });
});

test('View YAML is disabled with the run-lock reason and the menu still opens when it is the only action',async()=>{
 await withDom(async dom=>{
  const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
  const document=dom.window.document;
  function Host(){const [graph,setGraph]=useState(scenarioGraph);const [yaml,setYaml]=useState(scenarioYaml);return createElement(CanvasEditor,{graph,onChange:next=>{if(next)setGraph(next);},yaml,onYamlChange:setYaml,catalog:[],diagnostics:[],pathId:'route',onPathChange:()=>{},disabled:false,scenarioMode:true,scenarioId:'main',scenarios:[{id:'main',name:'Main',pathId:'route'}],onRun:()=>{},run:{status:'running'}});}
  try{
   await act(async()=>root.render(createElement(Host)));
   await act(async()=>document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:90,clientY:90})));
   const items=[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
   assert.deepEqual(items.map(item=>item.textContent),['View YAML']);
   assert.equal(items[0].disabled,true);
   assert.equal(items[0].title,'Unavailable while the scenario is running.');
   await act(async()=>items[0].click());
   assert.equal(document.querySelector('[role="dialog"][aria-label="YAML"]'),null);
   await act(async()=>root.render(createElement(CanvasBoard,{graph:scenarioGraph,onViewYaml:()=>{}})));
   await act(async()=>document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:90,clientY:90})));
   assert.deepEqual([...document.querySelectorAll('[role=menuitem]')].map(item=>item.textContent),['View YAML']);
  }finally{await act(async()=>root.unmount());}
 });
});

test('the node menu keeps Add to sequence, Rename, Node info, and Delete node',async()=>{
 await withDom(async dom=>{
  const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
  const document=dom.window.document;
  const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
  try{
   await act(async()=>root.render(createElement(CanvasBoard,{graph:scenarioGraph,onAdd:()=>{},onRun:()=>{},onViewYaml:()=>{},onAppend:()=>{},onRename:()=>{},onInfo:()=>{},onDelete:()=>{}})));
   const node=document.querySelector('[data-screen-id="home"]')!;
   await act(async()=>node.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:40})));
   const menu=document.querySelector<HTMLElement>('[role=menu]')!;
   assert.equal(menu.getAttribute('aria-label'),'Node menu');
   assert.equal(menu.className,'canvas-context-menu');
   assert.equal(menu.style.width,'');
   assert.match(css,/\.canvas-context-menu\{[^}]*width:180px/);
   assert.deepEqual([...menu.querySelectorAll('[role=menuitem]')].map(item=>item.textContent),['Add to sequence','Rename','Node info','Delete node']);
   assert.equal([...menu.querySelectorAll('[role=menuitem]')].some(item=>item.textContent==='View YAML'),false);
  }finally{await act(async()=>root.unmount());}
 });
});

test('canvas and node menus clamp to the window using their rendered size',async()=>{
 await withDom(async dom=>{
  const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
  const document=dom.window.document;
  const innerWidth=400;const innerHeight=300;const width=220;const height=200;
  Object.defineProperty(dom.window,'innerWidth',{configurable:true,value:innerWidth});
  Object.defineProperty(dom.window,'innerHeight',{configurable:true,value:innerHeight});
  const original=dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect=function(this:HTMLElement){
   if(this.classList.contains('canvas-context-menu')){
    const left=parseFloat(this.style.left)||0;const top=parseFloat(this.style.top)||0;
    return {x:left,y:top,left,top,width,height,right:left+width,bottom:top+height,toJSON(){return {};}} as DOMRect;
   }
   return original.call(this);
  };
  const open=async(target:Element)=>act(async()=>target.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-4,clientY:innerHeight-4})));
  try{
   await act(async()=>root.render(createElement(CanvasBoard,{graph:scenarioGraph,onAdd:()=>{},onRun:()=>{},onViewYaml:()=>{},onAppend:()=>{},onRename:()=>{},onInfo:()=>{},onDelete:()=>{}})));
   await open(document.querySelector('.canvas-surface')!);
   const canvasMenu=document.querySelector<HTMLElement>('[aria-label="Canvas menu"]')!;
   assert.equal(parseFloat(canvasMenu.style.left),172);
   assert.equal(parseFloat(canvasMenu.style.top),92);
   const canvasRect=canvasMenu.getBoundingClientRect();
   assert.ok(canvasRect.left>=8&&canvasRect.top>=8);
   assert.ok(canvasRect.right<=innerWidth-8&&canvasRect.bottom<=innerHeight-8);
   await act(async()=>document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
   await open(document.querySelector('[data-screen-id="done"]')!);
   const nodeMenu=document.querySelector<HTMLElement>('[aria-label="Node menu"]')!;
   assert.equal(parseFloat(nodeMenu.style.left),172);
   assert.equal(parseFloat(nodeMenu.style.top),92);
   const nodeRect=nodeMenu.getBoundingClientRect();
   assert.ok(nodeRect.left>=8&&nodeRect.top>=8);
   assert.ok(nodeRect.right<=innerWidth-8&&nodeRect.bottom<=innerHeight-8);
   assert.deepEqual([...nodeMenu.querySelectorAll('[role=menuitem]')].map(item=>item.textContent),['Add to sequence','Rename','Node info','Delete node']);
  }finally{dom.window.HTMLElement.prototype.getBoundingClientRect=original;await act(async()=>root.unmount());}
 });
});
