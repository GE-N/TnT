import {WorkspaceConflict} from '../server/workspace-store.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act,createElement} from 'react';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
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
   const data=path==='/api/workspaces'?(body?await service.save(body):await service.listWorkspaces()):path.startsWith('/api/workspaces?q=')?await service.listWorkspaces(decodeURIComponent(path.split('q=')[1])):path==='/api/workspaces/copy'?await service.copyWorkspace(body):path.endsWith('/rename')?await service.renameWorkspace(path.split('/')[3],body.name):path.endsWith('/open')?await service.openWorkspace(path.split('/')[3]):path==='/api/canvas/references'?await service.references(body):path==='/api/runs'?await service.wait((await service.start(body)).id):path.startsWith('/api/workspaces/')?await service.workspace(path.slice('/api/workspaces/'.length)):undefined;
   return Response.json(data);
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Request failed'},{status:error instanceof WorkspaceConflict?409:400});}
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
  await act(async()=>{open().click();await Promise.all(pendingRequests.splice(0));});
  assert.equal(document.querySelectorAll('[aria-label="Scenario list"] .scenario-select').length,1);
  await click('Manage workspace');await fill('Find workspace','Independent');await act(async()=>{await Promise.all(pendingRequests.splice(0));});
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Open Independent ·'))!.click();await Promise.all(pendingRequests.splice(0));});
  assert.equal(document.querySelectorAll('[aria-label="Scenario list"] .scenario-select').length,2);
  await click('Command forms');await fill('New command value','pending command');
  await click('Manage workspace');await click('Save a copy');await click('Create copy');
  assert.ok(document.body.textContent?.includes('Apply or cancel'));
  await click('Cancel');assert.equal((field('New command value') as HTMLInputElement).value,'pending command');
  await fill('New command value','');
  await click('New scenario');await click('Manage workspace');await click('New workspace');await fill('New workspace title','Fresh');await click('Create workspace');await click('Cancel');assert.equal(document.querySelectorAll('.scenario-select').length,3);await click('Close workspace manager');
  await click('Manage workspace');await click('New workspace');await fill('New workspace title','Fresh');await click('Create workspace');await click('Save and continue');assert.equal(document.querySelectorAll('.scenario-select').length,0);assert.match(document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Fresh.*Not saved/);assert.ok(!(await service.listWorkspaces('Fresh')).items.length,'untouched blank contexts are not persisted');
  await click('Manage workspace');await click('Rename workspace');await fill('Workspace title','Cancelled');await act(async()=>field('Workspace title')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.match(document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Fresh/);assert.equal(document.activeElement?.getAttribute('aria-label'),'Manage workspace');
  await click('New scenario');await click('Manage workspace');await click('Save workspace');await click('Close workspace manager');
  await act(async()=>document.querySelector('.scenario-select')!.dispatchEvent(new dom.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true})));await click('Rename');await fill('Rename scenario','Pending name');
  await click('Manage workspace');await click('Save a copy');await click('Create copy');assert.match(document.body.textContent!,/Apply or cancel/);await click('Cancel');assert.equal((field('Rename scenario') as HTMLInputElement).value,'Pending name');await act(async()=>field('Rename scenario')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await click('New scenario');await click('Manage workspace');await click('New workspace');await fill('New workspace title','After save');await click('Create workspace');
  delaySave=true;await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Save and continue')!.click();});
  const yamlInput=document.getElementById('scenario-yaml') as HTMLTextAreaElement;assert.equal(yamlInput.disabled,true,'authoring is disabled during a save before navigation');
  // Exercise the revision guard too: a new edit arriving from an input event must survive the old acknowledgement.
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(yamlInput,'appId: com.example.App\n---\n- tapOn: Newer edit\n');yamlInput.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await act(async()=>{releaseSave();do{await Promise.all(pendingRequests.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pendingRequests.length);});
  assert.match(document.body.textContent!,/Newer edits are still unsaved/);assert.match(yamlInput.value,/Newer edit/);assert.match(document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Fresh/);await click('Cancel');await click('Close workspace manager');
  const configured=await service.save({name:'Checkpoint workspace',yaml:'appId: com.example.App\n---\n- tapOn: Next\n',flows:{'setup.yaml':'appId: com.example.App\n---\n- launchApp\n'},automation:{setup:{file:'setup.yaml',parameters:{}},actions:[],checkpoints:[]}});
  await click('Manage workspace');await fill('Find workspace','Checkpoint workspace');await act(async()=>{await Promise.all(pendingRequests.splice(0));});await act(async()=>{document.querySelector<HTMLButtonElement>('.workspace-library button')!.click();await Promise.all(pendingRequests.splice(0));});await click('Save and continue');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300));await Promise.all(pendingRequests.splice(0));});
  const checkpoint=[...document.querySelectorAll('label')].find(label=>label.textContent?.startsWith('Checkpoint step'))!.querySelector('select')!;
  await act(async()=>{checkpoint.value='0';checkpoint.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  await click('Manage workspace');await click('Save a copy');await click('Create copy');assert.match(document.body.textContent!,/Apply or cancel/);assert.equal(checkpoint.value,'0');await click('Cancel');await click('Cancel checkpoint draft');assert.equal((await service.workspace(configured.id)).automation?.checkpoints.length,0);
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
   assert.match(title(),/Save failed/);assert.match(document.body.textContent!,/EACCES/);
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
  assert.match(title(),/Revision conflict/);assert.equal((await service.workspace(current.id)).name,'Other editor version');
  await click('Manage workspace');await click('Save a copy');await fill('Copy title','Recovered edits');await click('Create copy');
  assert.match(title(),/Recovered edits.*Saved locally/);
  const recovered=(await service.listWorkspaces('Recovered edits')).items[0];assert.equal((await service.workspace(recovered.id)).scenarios!.length,newerCount+1);
  assert.deepEqual(await service.workspace(current.id),other);
  await click('Manage workspace');await fill('Find workspace','Recovered edits');await act(async()=>{await Promise.all(pendingRequests.splice(0));});await act(async()=>{document.querySelector<HTMLButtonElement>('.workspace-library button')!.click();await Promise.all(pendingRequests.splice(0));});
  assert.equal(document.querySelectorAll('.scenario-select').length,newerCount+1);
  const raw=document.getElementById('scenario-yaml') as HTMLTextAreaElement;const validCode=raw.value;
  const editCode=async(value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(raw,value);raw.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  await editCode('appId: com.example.App\n---\n- tapOn: *missing\n');
  assert.match(title(),/Unsaved draft/);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));await Promise.all(pendingRequests.splice(0));});
  assert.equal((await service.workspace(recovered.id)).yaml,validCode);
  const unload=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  await click('Manage workspace');await click('New workspace');await fill('New workspace title','Guarded');await click('Create workspace');await click('Save and continue');assert.match(document.body.textContent!,/retained/);assert.match(raw.value,/missing/);await click('Cancel');await click('Close workspace manager');
  await editCode(validCode);
  // Run must check the revision even when this editor has made no further edits.
  const opened=await service.workspace(recovered.id);await service.save({...opened,name:'Newer external content'});
  await render(deviceId);const runButton=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Run Scenario '));assert.ok(runButton);
  await click(runButton.getAttribute('aria-label')!);assert.match(document.body.textContent!,/Cannot run scenario/);assert.match(title(),/Revision conflict/);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true,force:true});}
});
