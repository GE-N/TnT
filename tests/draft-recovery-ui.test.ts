import {DraftConflict,WorkspaceConflict,WorkspacePayloadTooLarge,createWriteFaults} from '../server/workspace-store.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Scenarios} from '../src/scenarios.js';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';

const yaml='appId: com.example.App\n---\n- launchApp\n';
const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';

async function mount(options?:{recoverSession?:boolean;faults?:ReturnType<typeof createWriteFaults>;deviceId?:string;token?:string}){
 const directory=await mkdtemp(join(tmpdir(),'tnt-draft-ui-'));
 const faults=options?.faults??createWriteFaults();
 const service=createScenarios({root:directory,faults:faults.faults,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=>'2.11.0',run:async({directory:flowDirectory})=>{await writeFile(join(flowDirectory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');await writeFile(join(flowDirectory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}}]));return {code:0,log:'Fixture',cleanup:{verified:true,detail:'Fixture process exited'}};}}});
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const pending:Promise<Response>[]=[];
 const request=async(path:string,init?:{body?:string})=>{
  try{
   const body=init?.body?JSON.parse(init.body):undefined;const id=path.split('/')[3];
   const data=path==='/api/session'?await service.session():path==='/api/workspaces/draft'&&body?await service.createDraftWorkspace(body):path==='/api/workspaces'?(body?await service.save(body):await service.listWorkspaces()):path.startsWith('/api/workspaces?q=')?await service.listWorkspaces(decodeURIComponent(path.split('q=')[1]??'')):path==='/api/workspaces/copy'?await service.copyWorkspace(body):path.endsWith('/draft/discard')?await service.discardDraft(id,body.expectedDraftRevision):path.endsWith('/draft')?await service.saveDraft(id,body):path.endsWith('/view')?await service.saveView(id,body):path.endsWith('/open')?await service.openWorkspace(id):path==='/api/canvas/references'?await service.references(body):path==='/api/runs'&&body?await service.wait((await service.start(body)).id):path.startsWith('/api/runs/')?await service.result(path.split('/')[3]):/^\/api\/workspaces\/[0-9a-f-]{36}$/.test(path)?await service.workspaceDetail(id):undefined;
   return Response.json(data);
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Request failed'},{status:error instanceof WorkspacePayloadTooLarge?413:error instanceof WorkspaceConflict||error instanceof DraftConflict?409:400});}
 };
 const fetchImpl=(path:string,init?:{body?:string})=>{const response=request(path,init);pending.push(response);return response;};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetchImpl:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);const document=dom.window.document;
 const settle=async()=>{do{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pending.length);};
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(button,label);button.click();await settle();});
 const render=async()=>{await act(async()=>{root.render(createElement(Scenarios,{token:options?.token??'local',deviceId:options?.deviceId??'',bundleId:'com.example.App',launchBusy:false,onRunning:()=>{},recoverSession:options?.recoverSession??false}));});await act(async()=>{for(let attempt=0;attempt<12;attempt++)await settle();});};
 const editYaml=async(value:string)=>act(async()=>{const node=document.getElementById('scenario-yaml') as HTMLTextAreaElement;Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const fill=async(label:string,value:string)=>act(async()=>{const input=[...document.querySelectorAll('label')].find(node=>node.textContent===label);const node=document.getElementById(input?.htmlFor??'') as HTMLInputElement;assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const openNamed=async(name:string)=>{await click('Manage workspace');const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.getAttribute('aria-label')?.startsWith('Open '+name+' ·'));assert.ok(button,name);await act(async()=>{button.click();await settle();});};
 return {directory,service,faults,document,dom,click,render,editYaml,fill,openNamed,settle,close:async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true,force:true});}};
}

test('queued and rejected draft writes never show Saved locally, and Retry does after a durable ack',async()=>{
 const faults=createWriteFaults();const page=await mount({faults});
 try{
  await page.render();
  faults.queue();
  await page.editYaml('appId: com.example.App\n---\n- tapOn: *missing\n');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));});
  await faults.untilQueued();
  const title=()=>page.document.querySelector('[aria-label="Manage workspace"]')!.textContent!;
  assert.ok(!title().includes('Saved locally'));assert.match(title(),/Saving|Not saved/);
  faults.release();await page.settle();await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));await page.settle();});
  assert.match(title(),/Draft kept, not valid yet/);
  assert.equal(page.document.querySelector('.workspace-save-icon')?.textContent,'!');
  assert.match(page.document.body.textContent!,/Drafts are kept on this computer's runner store/);
  faults.reject();
  await page.editYaml('appId: com.example.App\n---\n- tapOn: *still\n');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await page.settle();});
  assert.match(title(),/Couldn't save/);assert.ok(!title().includes('Saved locally'));
  faults.pass();await page.click('Retry');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await page.settle();});
  assert.match(title(),/Draft kept, not valid yet/);
 }finally{faults.pass();await page.close();}
});

test('refresh offers the recovered draft, Keep saved version hides it, and a newer draft shows it again',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const saved=await page.service.save({name:'Recovered workspace',yaml});
  await page.service.saveDraft(saved.id,{baseRevision:1,expectedDraftRevision:0,name:saved.name,content:{yaml:'appId: com.example.App\n---\n- tapOn: *missing\n',flows:'{}'},fields:{'yaml-command':'pending command'}});
  await page.service.setSession(saved.id);
  await page.render();
  assert.match(page.document.body.textContent!,/Unsaved changes from/);assert.match(page.document.body.textContent!,/were recovered/);
  assert.equal([...page.document.querySelectorAll('button')].some(button=>button.textContent==='Compare'),false);
  assert.match(page.document.getElementById('scenario-yaml')!.textContent??(page.document.getElementById('scenario-yaml') as HTMLTextAreaElement).value,/launchApp/);
  await page.click('Restore draft');
  assert.match((page.document.getElementById('scenario-yaml') as HTMLTextAreaElement).value,/missing/);
  assert.equal((page.document.getElementById('form-value') as HTMLInputElement|null)?.value??'', 'pending command');
  await page.click('Keep saved version');
  assert.equal(page.document.querySelector('.draft-banner'),null);
  assert.equal((await page.service.workspaceDetail(saved.id)).view?.dismissedDraftRevision,1);
  await page.editYaml('appId: com.example.App\n---\n- tapOn: *newer\n');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await page.settle();});
  assert.ok(page.document.querySelector('.draft-banner'));
  assert.equal((await page.service.workspace(saved.id)).yaml,yaml);
 }finally{await page.close();}
});

test('a stale draft offers restore as a copy and never a compare link',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const saved=await page.service.save({name:'Older base',yaml});
  await page.service.saveDraft(saved.id,{baseRevision:1,expectedDraftRevision:0,name:saved.name,content:{yaml:'appId: com.example.App\n---\n- tapOn: *missing\n'},fields:{}});
  await page.service.save({...saved,name:'Newer saved'});
  await page.service.setSession(saved.id);
  await page.render();
  assert.match(page.document.body.textContent!,/Based on an older version/);
  assert.equal([...page.document.querySelectorAll('button')].some(button=>button.textContent==='Compare'),false);
  assert.equal([...page.document.querySelectorAll('button')].some(button=>button.textContent==='Restore draft'),false);
  await page.click('Restore as a copy');
  const copies=(await page.service.listWorkspaces('copy')).items;
  assert.equal(copies.length,1);
  assert.match((page.document.getElementById('scenario-yaml') as HTMLTextAreaElement).value,/missing/);
  assert.match(String((await page.service.workspaceDetail(copies[0].id)).draft?.content.yaml),/missing/);
  assert.match(String((await page.service.workspaceDetail(saved.id)).draft?.content.yaml),/missing/);
 }finally{await page.close();}
});

test('an unreadable draft can be discarded only after confirmation, and the saved workspace stays open',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const saved=await page.service.save({name:'Saved content',yaml});
  const {writeFile}=await import('node:fs/promises');
  await writeFile(join(page.directory,'workspaces',saved.id,'draft.json'),'{');
  await page.service.setSession(saved.id);
  await page.render();
  assert.match(page.document.body.textContent!,/A recovered draft couldn't be read/);
  assert.match((page.document.getElementById('scenario-yaml') as HTMLTextAreaElement).value,/launchApp/);
  await page.click('Discard draft');
  assert.match(page.document.body.textContent!,/Discard the unreadable draft\? This can't be undone/);
  assert.equal(page.document.activeElement?.textContent,'Cancel');
  await page.click('Cancel');
  assert.equal(page.document.activeElement?.textContent,'Discard draft');
  assert.match(await readFile(join(page.directory,'workspaces',saved.id,'draft.json'),'utf8'),/\{/);
  await page.click('Discard draft');await page.click('Discard');
  await assert.rejects(readFile(join(page.directory,'workspaces',saved.id,'draft.json')));
  assert.match((page.document.getElementById('scenario-yaml') as HTMLTextAreaElement).value,/launchApp/);
 }finally{await page.close();}
});

test('a missing last workspace opens the chooser and no other identity',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const other=await page.service.save({name:'Unrelated',yaml});
  const saved=await page.service.save({name:'Missing workspace',yaml});
  await page.service.setSession(saved.id);await page.service.trashWorkspace(saved.id);
  await page.render();
  assert.match(page.document.body.textContent!,/That workspace isn't available anymore/);
  assert.match(page.document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Untitled workspace/);
  assert.equal(page.document.querySelector('.artifact-id'),null);
  assert.ok(other.id);
 }finally{await page.close();}
});

test('each workspace restores its own scenario, zoom, and screen, and a deleted scenario is named',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const canvas={screens:[{id:'home',title:'Home',x:10,y:20,tests:[]},{id:'away',title:'Away',x:400,y:30,tests:[]}],edges:[],paths:[{id:'path-a',name:'A',edgeIds:[]},{id:'path-b',name:'B',edgeIds:[]}]};
  const scenarios=[{id:'alpha',name:'Alpha',authoring:'canvas' as const,pathId:'path-a',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]},{id:'beta',name:'Beta',authoring:'canvas' as const,pathId:'path-b',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]}];
  const first=await page.service.save({name:'Workspace A',yaml,canvas,scenarios});
  const second=await page.service.save({name:'Workspace B',yaml,canvas,scenarios:[scenarios[0]]});
  await page.service.saveView(first.id,{scenarioId:'beta',scenarioName:'Beta',pathId:'path-b',canvas:{zoom:1.2,scrollLeft:30,scrollTop:8,selectedScreenId:'away'}});
  await page.service.saveView(second.id,{scenarioId:'alpha',scenarioName:'Alpha',pathId:'path-a',canvas:{zoom:0.5,scrollLeft:0,scrollTop:0,selectedScreenId:'home'}});
  await page.service.setSession(first.id);
  await page.render();
  assert.equal(page.document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')?.textContent,'Beta');
  assert.match(page.document.querySelector('.canvas-surface')?.getAttribute('style')??'',/scale\(1\.2\)/);
  assert.ok(page.document.querySelector('[data-screen-id="away"]')?.className.includes('selected-screen'));
  await page.openNamed('Workspace B');
  assert.equal(page.document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')?.textContent,'Alpha');
  assert.match(page.document.querySelector('.canvas-surface')?.getAttribute('style')??'',/scale\(0\.5\)/);
  await page.openNamed('Workspace A');
  assert.equal(page.document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')?.textContent,'Beta');
  assert.ok(page.document.querySelector('[data-screen-id="away"]')?.className.includes('selected-screen'));
  await page.service.saveView(first.id,{scenarioId:'gone',scenarioName:'Gone'});
  await page.openNamed('Workspace A');
  assert.match(page.document.body.textContent!,/Scenario 'Gone' was deleted, showing 'Alpha'/);
 }finally{await page.close();}
});

test('a workspace without view.json uses the first scenario and the default canvas zoom',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[]}],edges:[],paths:[]};
  const saved=await page.service.save({name:'Imported stand-in',yaml,canvas,scenarios:[{id:'alpha',name:'Alpha',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]},{id:'beta',name:'Beta',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]}]});
  await page.service.setSession(saved.id);
  await page.render();
  assert.equal(page.document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')?.textContent,'Alpha');
  assert.match(page.document.querySelector('.canvas-surface')?.getAttribute('style')??'',/scale\(0\.85\)/);
  assert.equal(page.document.body.textContent!.includes('was deleted'),false);
  const empty=await page.service.save({name:'No scenarios',yaml,scenarios:[]});
  await page.service.saveView(empty.id,{scenarioId:'gone',scenarioName:'Gone'});
  await page.service.setSession(empty.id);
  await page.openNamed('No scenarios');
  assert.match(page.document.body.textContent!,/No scenarios yet/);
 }finally{await page.close();}
});

test('confidential runtime input stays out of the draft file',async()=>{
 const page=await mount();
 try{
  await page.render();await page.click('New scenario');
  const created=page.document.querySelector('.artifact-id');
  await page.editYaml('appId: com.example.App\n---\n- launchApp\n');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await page.settle();});
  assert.ok(created||page.document.querySelector('.artifact-id'));
  const id=page.document.querySelector('.artifact-id')!.textContent!.replace('Workspace: ','');
  await page.fill('Confidential runtime inputs (optional JSON)','{"PASSWORD":"super-secret-value"}');
  await page.editYaml('appId: com.example.App\n---\n- tapOn: *missing\n');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await page.settle();});
  const draft=await readFile(join(page.directory,'workspaces',id,'draft.json'),'utf8');
  assert.equal(draft.includes('super-secret-value'),false);
  assert.equal(draft.includes('RUNNING_SENTINEL'),false);
 }finally{await page.close();}
});

test('narrow save status exposes an icon label, and the switch dialog keeps keyboard dismissal',async()=>{
 const css=await readFile(new URL('../src/style.css',import.meta.url),'utf8');
 assert.match(css,/max-width:760px\)\{\.workspace-save-text\{position:absolute/);
 assert.match(css,/min-height:44px/);
 assert.match(css,/\.workspace-danger\{color:var\(--danger\)\}/);
 assert.match(css,/\.draft-banner\.danger\{/);
 assert.match(css,/\.go-to-issue,\.save-retry/);
 assert.match(css,/draft-banner\{flex-direction:column/);
 assert.match(css,/workspace-management-surface,\.workspace-management-surface\.expanded\{position:fixed;inset:auto 12px 12px/);
 const faults=createWriteFaults();const page=await mount({faults});
 try{
  await page.render();
  const status=page.document.querySelector('.workspace-save-status')!;
  assert.equal(status.getAttribute('aria-live'),'polite');assert.equal(status.getAttribute('role'),'status');
  faults.reject();
  await page.editYaml('appId: com.example.App\n---\n- tapOn: *missing\n');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await page.settle();});
  const failed=page.document.querySelector('.workspace-save-status')!;
  assert.equal(failed.getAttribute('role'),'alert');assert.equal(failed.getAttribute('aria-live'),'assertive');
  assert.equal(failed.querySelector('.workspace-save-icon')?.textContent,'×');
  await page.click('Manage workspace');await page.click('New workspace');await page.click('Create workspace');
  assert.match(page.document.body.textContent!,/Couldn't save your changes before switching/);
  assert.equal(page.document.activeElement?.textContent,'Retry');
  await page.click('Discard changes and switch');
  assert.equal(page.document.activeElement?.textContent,'Cancel');
  await page.click('Cancel');
  assert.equal(page.document.activeElement?.textContent,'Discard changes and switch');
  const dialog=page.document.querySelector('[aria-label="Workspace manager"]') as HTMLElement;
  const controls=[...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  controls.at(-1)!.focus();
  await act(async()=>{dialog.dispatchEvent(new page.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));});
  assert.equal(page.document.activeElement,controls[0]);
  await act(async()=>{dialog.dispatchEvent(new page.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});
  assert.equal(page.document.body.textContent!.includes("Couldn't save your changes before switching."),false);
  assert.equal(page.document.activeElement?.textContent,'Create workspace');
 }finally{faults.pass();await page.close();}
});

test('switching workspaces clears undo history and the selected report',async()=>{
 const page=await mount({recoverSession:true,deviceId});
 try{
  const scenarios=[{id:'alpha',name:'Alpha',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]}];
  const first=await page.service.save({name:'Undo workspace',yaml,scenarios});
  const second=await page.service.save({name:'Other workspace',yaml,scenarios});
  await page.service.setSession(first.id);
  await page.render();
  const row=page.document.querySelector('.scenario-row')!;
  await act(async()=>{row.dispatchEvent(new page.dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}));});
  await page.click('Delete');
  assert.match(page.document.body.textContent!,/Deleted Alpha/);
  await page.click('Run scenario');
  const selectedReport=page.document.querySelector('nav[aria-label="Scenario reports"] button[aria-pressed="true"]');
  assert.ok(selectedReport,page.document.body.textContent??'');
  assert.match(selectedReport.textContent??'',/Undo workspace/);
  await page.click('Command forms');
  await page.click('Delete step 1');
  assert.match(page.document.body.textContent!,/Undo deletion/);
  await page.openNamed('Other workspace');
  assert.equal(page.document.body.textContent!.includes('Undo deletion'),false);
  assert.equal([...page.document.querySelectorAll('button')].some(button=>button.textContent==='Undo'),false);
  assert.equal(page.document.querySelector('nav[aria-label="Scenario reports"] button[aria-pressed="true"]'),null);
  assert.match(page.document.body.textContent!,/Your scenario result/);
  assert.ok(second.id);
 }finally{await page.close();}
});

test('an imported workspace opens with the first scenario and the default canvas zoom',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[]}],edges:[],paths:[]};
  const imported=await page.service.save({name:'Imported workspace',yaml,canvas,scenarios:[{id:'alpha',name:'Alpha',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]},{id:'beta',name:'Beta',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]}]});
  await page.render();
  await page.openNamed('Imported workspace');
  assert.equal(page.document.querySelector('[aria-label="Scenario list"] [aria-pressed="true"]')?.textContent,'Alpha');
  assert.match(page.document.querySelector('.canvas-surface')?.getAttribute('style')??'',/scale\(0\.85\)/);
  await assert.rejects(readFile(join(page.directory,'workspaces',imported.id,'view.json')));
 }finally{await page.close();}
});

test('Saving does not stick after a rejected write, a 409, a switch that cancels the debounce, or an acknowledged invalid draft',async()=>{
 const faults=createWriteFaults();const page=await mount({faults});
 const status=()=>page.document.querySelector('.workspace-save-text')!.textContent!;
 const id=()=>page.document.querySelector('.artifact-id')!.textContent!.replace('Workspace: ','');
 const wait=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,500));await page.settle();});
 const valid='appId: com.example.App\n---\n- tapOn: Home\n';
 try{
  await page.render();
  faults.reject();
  await page.editYaml(valid);
  await wait();
  assert.equal(status(),"Couldn't save.");
  await wait();
  assert.equal(status(),"Couldn't save.");
  faults.pass();
  await page.editYaml('appId: com.example.App\n---\n- tapOn: *missing\n');
  await wait();
  assert.equal(status(),'Draft kept, not valid yet.');
  await wait();
  assert.equal(status(),'Draft kept, not valid yet.');
  assert.match(await readFile(join(page.directory,'workspaces',id(),'draft.json'),'utf8'),/missing/);
  await page.editYaml(valid);
  await wait();
  assert.equal(status(),'Saved locally');
  assert.match((await page.service.workspace(id())).yaml,/tapOn: Home/);
  const saved=await page.service.workspace(id());
  await page.service.save({...saved,name:'Other editor version'});
  await page.editYaml('appId: com.example.App\n---\n- tapOn: Away\n');
  await wait();
  assert.equal(status(),"Couldn't save.");
  await page.editYaml('appId: com.example.App\n---\n- tapOn: Later\n');
  await wait();
  assert.equal(status(),"Couldn't save.");
  assert.equal(status().includes('Saving'),false);
  await page.click('Load latest');
  assert.equal(status(),'Saved locally');
  const previous=id();
  await page.editYaml('appId: com.example.App\n---\n- tapOn: Flushed\n');
  await page.click('Manage workspace');await page.click('New workspace');await page.click('Create workspace');
  assert.equal(status().includes('Saving'),false);
  assert.match(status(),/Not saved yet|Saved locally/);
  assert.match((await page.service.workspace(previous)).yaml,/Flushed/);
  faults.reject();
  await page.editYaml('appId: com.example.App\n---\n- tapOn: Interrupted\n');
  await page.click('Manage workspace');await page.click('New workspace');await page.click('Create workspace');
  assert.match(page.document.body.textContent!,/Couldn't save your changes before switching/);
  assert.equal(status(),"Couldn't save.");
  await page.click('Cancel');
  await wait();
  assert.equal(status(),"Couldn't save.");
  assert.equal(status().includes('Saving'),false);
 }finally{faults.pass();await page.close();}
});

test('an edit made before the runner token exists stays Not saved yet',async()=>{
 const page=await mount({token:''});
 try{
  await page.render();
  await page.editYaml('appId: com.example.App\n---\n- tapOn: Home\n');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,500));await page.settle();});
  assert.equal(page.document.querySelector('.workspace-save-text')!.textContent,'Not saved yet');
 }finally{await page.close();}
});
