import {DraftConflict,WorkspaceConflict,WorkspacePayloadTooLarge} from '../server/workspace-store.js';
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

test('workspace manager creates independent named copies and preserves unapplied drafts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tnt-canvas-journey-'));
 const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
 const service=createScenarios({root:directory,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
  await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
  await writeFile(join(directory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{visible:{textRegex:'^Home$'}}}},metadata:{depth:0,status:'COMPLETED'}},{command:{assertConditionCommand:{condition:{notVisible:{textRegex:'^Error$'}}}},metadata:{depth:0,status:'COMPLETED'}}]));
  return {code:0,log:'External simulator fixture',cleanup:{verified:true,detail:'Fixture process exited'}};
 }}});
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','FileReader','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const pendingRequests:Promise<Response>[]=[];let delaySave=false;let releaseSave:()=>void=()=>{};
 const request=async(path:string,options?:{body?:string})=>{
  try{
   const body=options?.body?JSON.parse(options.body):undefined;
   if(delaySave&&path==='/api/workspaces'&&body){delaySave=false;await new Promise<void>(resolve=>{releaseSave=resolve;});}
   const id=path.split('/')[3];
   const data=path==='/api/session'?await service.session():path==='/api/workspaces/draft'&&body?await service.createDraftWorkspace(body):path==='/api/workspaces'?(body?await service.save(body):await service.listWorkspaces()):path.startsWith('/api/workspaces?q=')?await service.listWorkspaces(decodeURIComponent(path.split('q=')[1])):path==='/api/workspaces/copy'?await service.copyWorkspace(body):path.endsWith('/draft/discard')?await service.discardDraft(id,body.expectedDraftRevision):path.endsWith('/draft')?await service.saveDraft(id,body):path.endsWith('/view')?await service.saveView(id,body):path.endsWith('/rename')?await service.renameWorkspace(id,body.name,body.expectedRevision):path.endsWith('/open')?await service.openWorkspace(id):path==='/api/canvas/references'?await service.references(body):path==='/api/runs'?await service.wait((await service.start(body)).id):/^\/api\/workspaces\/[0-9a-f-]{36}$/.test(path)?await service.workspaceDetail(id):undefined;
   return Response.json(data);
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Request failed'},{status:error instanceof WorkspacePayloadTooLarge?413:error instanceof WorkspaceConflict||error instanceof DraftConflict?409:400});}
 };
 const fetch=(path:string,options?:{body?:string})=>{const response=request(path,options);pendingRequests.push(response);return response;};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetch:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);const document=dom.window.document;
 const render=async(device='')=>act(async()=>root.render(createElement(Scenarios,{token:'local',deviceId:device,bundleId:'com.example.App',launchBusy:false,onRunning:()=>{}})));
 const click=async(label:string)=>{if(label==='Save workspace'){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await Promise.all(pendingRequests.splice(0));});return;}return act(async()=>{const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(button,label);button.click();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});};
 const field=(label:string)=>document.querySelector(`[aria-label="${label}"]`)??document.getElementById([...document.querySelectorAll('label')].find(node=>node.textContent===label)?.htmlFor??'');
 const fill=async(label:string,value:string)=>act(async()=>{const node=field(label) as HTMLInputElement;assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const select=async(label:string,value:string)=>act(async()=>{const node=field(label) as HTMLSelectElement;assert.ok(node,label);node.value=value;node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 try{
  await render();await click('Manage workspace');await act(async()=>{await Promise.all(pendingRequests.splice(0));});assert.match(document.body.textContent!,/No saved workspaces yet/);await click('Close workspace manager');
  for(let i=0;i<7;i++)await service.save({name:'Library item '+i,yaml:'appId: com.example.App\n---\n- launchApp\n'});
  await render();await click('Manage workspace');await act(async()=>{await Promise.all(pendingRequests.splice(0));});assert.equal(document.querySelectorAll('.workspace-library button').length,5);await fill('Find workspace','Library item 0');await act(async()=>{await Promise.all(pendingRequests.splice(0));});assert.equal(document.querySelectorAll('.workspace-library button').length,1);await click('View all workspaces');await fill('Find workspace','');await act(async()=>{await Promise.all(pendingRequests.splice(0));});assert.equal(document.querySelectorAll('.workspace-library button').length,7);await fill('Find workspace','Missing name');await act(async()=>{await Promise.all(pendingRequests.splice(0));});assert.match(document.body.textContent!,/No matching workspaces/);
  const {chmod}=await import('node:fs/promises');await chmod(join(directory,'workspaces'),0o000);try{await fill('Find workspace','Unavailable');await act(async()=>{await Promise.all(pendingRequests.splice(0));});assert.match(document.body.textContent!,/local workspace store is unavailable/);}finally{await chmod(join(directory,'workspaces'),0o700);}
  await click('Retry library');assert.match(document.body.textContent!,/No matching workspaces/);assert.ok(!document.body.textContent?.includes('local workspace store is unavailable'));await click('Close workspace manager');
  await click('New scenario');await click('Manage workspace');await click('Rename workspace');await fill('Workspace title','Original');await click('Done');
  await click('Manage workspace');await click('Save workspace');assert.ok(document.body.textContent?.includes('Saved locally'),document.body.textContent??'');
  await click('Save a copy');await fill('Copy title','Independent');await click('Create copy');
  assert.ok(document.body.textContent?.includes('Independent'));
  await click('New scenario');await click('Manage workspace');await click('Save workspace');
  await fill('Find workspace','Original');await act(async()=>{await Promise.all(pendingRequests.splice(0));});
  const open=()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Open Original ·'))!;
  await act(async()=>{open().click();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});
  assert.equal(document.querySelectorAll('[aria-label="Scenario list"] .scenario-select').length,1);
  await click('Manage workspace');await fill('Find workspace','Independent');await act(async()=>{await Promise.all(pendingRequests.splice(0));});
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Open Independent ·'))!.click();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});
  assert.equal(document.querySelectorAll('[aria-label="Scenario list"] .scenario-select').length,2);
  await click('Command forms');await fill('New command value','pending command');
  await click('Manage workspace');await click('Save a copy');await click('Create copy');
  assert.equal((field('New command value') as HTMLInputElement).value,'','a pending command is stored as a draft and the copy opens the last valid workspace');
  const independent=(await service.listWorkspaces('Independent')).items.find(item=>item.name==='Independent')!;
  assert.equal((await service.workspaceDetail(independent.id)).draft?.fields['yaml-command'],'pending command');
  assert.equal(document.querySelectorAll('[aria-label="Scenario list"] .scenario-select').length,2);
  await click('Manage workspace');await click('New workspace');await fill('New workspace title','Fresh');await click('Create workspace');assert.equal(document.querySelectorAll('.scenario-select').length,0);assert.match(document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Fresh.*Not saved/);assert.ok(!(await service.listWorkspaces('Fresh')).items.length,'untouched blank contexts are not persisted');
  await click('Manage workspace');await click('Rename workspace');await fill('Workspace title','Cancelled');await act(async()=>field('Workspace title')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.match(document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Fresh/);assert.equal(document.activeElement?.getAttribute('aria-label'),'Manage workspace');
  await click('New scenario');await click('Manage workspace');await click('Save workspace');await click('Close workspace manager');
  await act(async()=>document.querySelector('.scenario-select')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true})));await click('Rename');await fill('Rename scenario','Pending name');
  const freshId=(await service.listWorkspaces('Fresh')).items.find(item=>item.name==='Fresh')!.id;
  await click('Manage workspace');await click('Save a copy');await click('Create copy');
  assert.equal((await service.workspaceDetail(freshId)).draft?.fields['scenario-rename:'+(await service.workspace(freshId)).scenarios![0].id],'Pending name');
  assert.match(document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Fresh copy/);
  await click('New scenario');await click('Manage workspace');await click('New workspace');await fill('New workspace title','After save');
  delaySave=true;await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Create workspace')!.click();});
  const yamlInput=document.getElementById('scenario-yaml') as HTMLTextAreaElement;assert.equal(yamlInput.disabled,true,'authoring is disabled during a save before navigation');
  // Exercise the revision guard too: a new edit arriving from an input event must survive the old acknowledgement.
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(yamlInput,'appId: com.example.App\n---\n- tapOn: Newer edit\n');yamlInput.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await act(async()=>{releaseSave();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});
  assert.match(document.body.textContent!,/Newer edits are still unsaved/);assert.match(yamlInput.value,/Newer edit/);assert.match(document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Fresh/);await click('Cancel');await click('Close workspace manager');
  const configured=await service.save({name:'Checkpoint workspace',yaml:'appId: com.example.App\n---\n- tapOn: Next\n',flows:{'setup.yaml':'appId: com.example.App\n---\n- launchApp\n'},automation:{setup:{file:'setup.yaml',parameters:{}},actions:[],checkpoints:[]}});
  await click('Manage workspace');await fill('Find workspace','Checkpoint workspace');await act(async()=>{await Promise.all(pendingRequests.splice(0));});await act(async()=>{document.querySelector<HTMLButtonElement>('.workspace-library button')!.click();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300));await Promise.all(pendingRequests.splice(0));});
  const checkpoint=[...document.querySelectorAll('label')].find(label=>label.textContent?.startsWith('Checkpoint step'))!.querySelector('select')!;
  await act(async()=>{checkpoint.value='0';checkpoint.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  await click('Manage workspace');await click('Save a copy');await click('Create copy');assert.equal((await service.workspace(configured.id)).automation?.checkpoints.length,0);assert.equal((await service.workspaceDetail(configured.id)).draft?.fields['checkpoint-draft'],'0');
  await click('Manage workspace');await click('New workspace');await fill('New workspace title','Unsaved source');await click('Create workspace');await click('New scenario');
  await click('Manage workspace');await click('Save a copy');await fill('Copy title','Unsaved source copy');await click('Create copy');
  const sourceRecord=(await service.listWorkspaces('Unsaved source')).items.find(item=>item.name==='Unsaved source')!;const copiedRecord=(await service.listWorkspaces('Unsaved source')).items.find(item=>item.name==='Unsaved source copy')!;
  assert.equal((await service.workspace(copiedRecord.id)).yaml,(await service.workspace(sourceRecord.id)).yaml,'copy uses the acknowledged source content after normalization');assert.match(document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Unsaved source copy/);
  const duplicateA=await service.save({name:'Same title',yaml:'appId: com.example.App\n---\n- launchApp\n'});const duplicateB=await service.save({name:'Same title',yaml:'appId: com.example.App\n---\n- launchApp\n'});
  await click('Manage workspace');await fill('Find workspace','Same title');await act(async()=>{await Promise.all(pendingRequests.splice(0));});
  const diagnosticControls=[...document.querySelectorAll<HTMLElement>('summary[aria-label="Diagnostic details for Same title"]')];assert.equal(diagnosticControls.length,2);
  await act(async()=>{diagnosticControls[0].click();diagnosticControls[1].click();});const details=[...document.querySelectorAll('details[open]')].map(detail=>detail.textContent).join(' ');assert.ok(details.includes(duplicateA.id));assert.ok(details.includes(duplicateB.id),'same-name copies have accessible distinct diagnostic identities');
  await click('Close workspace manager');
  const title=()=>document.querySelector('[aria-label="Manage workspace"]')!.textContent!;
  const current=(await service.listWorkspaces()).items.find(item=>title().startsWith(item.name))!;
  const storedBefore=await service.workspace(current.id);
  const location=join(directory,'workspaces',current.id);
  await chmod(location,0o500);
  try{
   await click('New scenario');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await Promise.all(pendingRequests.splice(0));});
   assert.match(title(),/Couldn't save/);assert.match(document.body.textContent!,/EACCES/);
   assert.equal((await service.workspace(current.id)).scenarios?.length,storedBefore.scenarios?.length);
  }finally{await chmod(location,0o700);}
  await click('Retry');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await Promise.all(pendingRequests.splice(0));});
  assert.match(title(),/Saved locally/);assert.equal((await service.workspace(current.id)).scenarios!.length,storedBefore.scenarios!.length+1);
  assert.ok(![...document.querySelectorAll('button')].some(button=>button.textContent==='Save workspace'));
  // Hold an older request while another authored edit arrives. The old response must not replace it.
  delaySave=true;await click('New scenario');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));});
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>(button.getAttribute('aria-label')??button.textContent)==='New scenario')!.click();});
  const newerCount=document.querySelectorAll('.scenario-select').length;
  assert.ok(!title().includes('Saved locally'));
  await act(async()=>{releaseSave();await Promise.all(pendingRequests.splice(0));});
  assert.equal(document.querySelectorAll('.scenario-select').length,newerCount);assert.ok(!title().includes('Saved locally'));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await Promise.all(pendingRequests.splice(0));});
  assert.match(title(),/Saved locally/);assert.equal((await service.workspace(current.id)).scenarios!.length,newerCount);
  const beforeConflict=await service.workspace(current.id);
  const other=await service.save({...beforeConflict,name:'Other editor version'});
  await click('New scenario');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await Promise.all(pendingRequests.splice(0));});
  assert.equal(title().includes('another tab'),false);assert.match(document.querySelector('.conflict-bar')!.textContent!,/another tab/);assert.match(title(),/Couldn't save/);assert.equal((await service.workspace(current.id)).name,'Other editor version');
  const draftPath=join(directory,'workspaces',current.id,'draft.json');
  await service.saveDraft(current.id,{baseRevision:other.metadata!.revision,expectedDraftRevision:0,name:other.name,content:{yaml:'appId: com.example.App\n---\n- tapOn: *other-tab\n'},fields:{'yaml-command':'other-tab'}});
  const draftBytes=await readFile(draftPath,'utf8');
  const beforeIds=new Set((await service.listWorkspaces()).items.map(item=>item.id));
  await click('Restore as a copy');
  const recovered=(await service.listWorkspaces()).items.find(item=>!beforeIds.has(item.id))!;
  assert.equal((await service.workspace(recovered.id)).scenarios!.length,newerCount+1);
  await assert.rejects(readFile(join(directory,'workspaces',recovered.id,'draft.json')));
  assert.equal(await readFile(draftPath,'utf8'),draftBytes);
  const {draftCleared:ignored,...returned}=other as typeof other & {draftCleared?:boolean};void ignored;
  assert.deepEqual(await service.workspace(current.id),returned);
  await click('Manage workspace');await fill('Find workspace','Other editor version');await act(async()=>{await Promise.all(pendingRequests.splice(0));});
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Open Other editor version ·'))!.click();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});
  const reloaded=await service.workspace(current.id);await service.save({...reloaded,name:'Other editor version'});
  await click('New scenario');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await Promise.all(pendingRequests.splice(0));});
  assert.match(document.querySelector('.conflict-bar')!.textContent!,/another tab/);assert.equal(title().includes('another tab'),false);
  await click('Load latest');
  assert.equal(await readFile(draftPath,'utf8'),draftBytes,'Load latest and Restore as a copy leave the other tab draft in place');
  await assert.rejects(readFile(join(directory,'workspaces',recovered.id,'draft.json')));
  await click('Manage workspace');await fill('Find workspace',recovered.name);await act(async()=>{await Promise.all(pendingRequests.splice(0));});await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Open '+recovered.name+' ·'))!.click();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});
  assert.equal(document.querySelectorAll('.scenario-select').length,newerCount+1);
  const raw=document.getElementById('scenario-yaml') as HTMLTextAreaElement;const validCode=raw.value;
  const editCode=async(value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(raw,value);raw.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await editCode('appId: com.example.App\n---\n- tapOn: *missing\n');
  assert.match(title(),/Saving|Draft kept/);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await Promise.all(pendingRequests.splice(0));});
  assert.equal((await service.workspace(recovered.id)).yaml,validCode);
  assert.match(title(),/Draft kept, not valid yet/);
  const unload=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,false);
  await click('Manage workspace');await click('New workspace');await fill('New workspace title','Guarded');await click('Create workspace');
  assert.match(title(),/Guarded/);assert.match(String((await service.workspaceDetail(recovered.id)).draft?.content.yaml),/missing/);
  await click('Manage workspace');await fill('Find workspace',recovered.name);await act(async()=>{await Promise.all(pendingRequests.splice(0));});await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Open '+recovered.name+' ·'))!.click();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});
  // Run must check the revision even when this editor has made no further edits.
  const opened=await service.workspace(recovered.id);await service.save({...opened,name:'Newer external content'});
  await render(deviceId);const runButton=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Run Scenario '));assert.ok(runButton);
  await click(runButton.getAttribute('aria-label')!);assert.match(document.body.textContent!,/Cannot run scenario/);assert.equal(title().includes('another tab'),false);assert.match(document.querySelector('.conflict-bar')!.textContent!,/another tab/);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true,force:true});}
});
