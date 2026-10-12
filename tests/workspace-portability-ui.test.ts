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
 const directory=await mkdtemp(join(tmpdir(),'tnt-portable-ui-'));
 const faults=options?.faults??createWriteFaults();
 const service=createScenarios({root:directory,faults:faults.faults,runner:createRunner({artifactDirectory:directory,execute:async(_file,args)=>({stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''})}),maestro:{version:async()=>'2.11.0',run:async({directory:flowDirectory})=>{await writeFile(join(flowDirectory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');await writeFile(join(flowDirectory,'commands.json'),JSON.stringify([{command:{launchAppCommand:{}},metadata:{depth:0,status:'COMPLETED'}}]));return {code:0,log:'Fixture',cleanup:{verified:true,detail:'Fixture process exited'}};}}});
 const dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','Event','ResizeObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];
 const previous=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 class ResizeObserver{observe(){}disconnect(){}}
 const pending:Promise<Response>[]=[];
 let pickerHold:Promise<void>|undefined;
 let releasePickerHold=()=>{};
 const holdPicker=()=>{pickerHold=new Promise(resolve=>{releasePickerHold=()=>{pickerHold=undefined;resolve();};});};
 const releasePicker=()=>{releasePickerHold();releasePickerHold=()=>{};};
 const request=async(path:string,init?:{body?:string})=>{
  try{
   if(path==='/api/picker/captures'){if(pickerHold)await pickerHold;return Response.json({id:'cap',deviceName:'Phone',width:100,height:100,capturedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()});}
   const body=init?.body?JSON.parse(init.body):undefined;const id=path.split('/')[3];
   const data=path==='/api/workspaces/export'?await service.exportWorkspace(body):path==='/api/workspaces/import/review'?await service.reviewWorkspacePackage(body):path==='/api/workspaces/import'?await service.importWorkspace(body):path==='/api/session'?await service.session():path==='/api/workspaces/draft'&&body?await service.createDraftWorkspace(body):path==='/api/workspaces'?(body?await service.save(body):await service.listWorkspaces()):path.startsWith('/api/workspaces?q=')?await service.listWorkspaces(decodeURIComponent(path.split('q=')[1]??'')):path==='/api/workspaces/copy'?await service.copyWorkspace(body):path.endsWith('/draft/discard')?await service.discardDraft(id,body.expectedDraftRevision):path.endsWith('/draft')?await service.saveDraft(id,body):path.endsWith('/view')?await service.saveView(id,body):path.endsWith('/open')?await service.openWorkspace(id):path==='/api/canvas/references'?await service.references(body):path==='/api/runs'&&body?await service.wait((await service.start(body)).id):path.startsWith('/api/runs/')?await service.result(path.split('/')[3]):/^\/api\/workspaces\/[0-9a-f-]{36}$/.test(path)?await service.workspaceDetail(id):undefined;
   return Response.json(data);
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Request failed'},{status:error instanceof WorkspacePayloadTooLarge?413:error instanceof WorkspaceConflict||error instanceof DraftConflict?409:400});}
 };
 const fetchImpl=(path:string,init?:{body?:string})=>{const response=request(path,init);pending.push(response);return response;};
 for(const key of keys)Object.defineProperty(globalThis,key,{value:key==='fetch'?fetchImpl:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?ResizeObserver:Reflect.get(dom.window,key),configurable:true});
 const {createRoot}=await import('react-dom/client');let root=createRoot(dom.window.document.getElementById('root')!);const document=dom.window.document;
 const settle=async()=>{do{await Promise.all(pending.splice(0));await new Promise(resolve=>setImmediate(resolve));}while(pending.length);};
 const click=async(label:string)=>act(async()=>{const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert.ok(button,label);button.click();await settle();});
 const render=async(overrides?:{token?:string;recoverSession?:boolean})=>{await act(async()=>{root.render(createElement(Scenarios,{token:overrides?.token??options?.token??'local',deviceId:options?.deviceId??'',bundleId:'com.example.App',launchBusy:false,onRunning:()=>{},recoverSession:overrides?.recoverSession??options?.recoverSession??false}));});await act(async()=>{for(let attempt=0;attempt<12;attempt++)await settle();});};
 const reload=async()=>{await act(async()=>{root.unmount();});root=createRoot(document.getElementById('root')!);await render({recoverSession:true});};
 const editYaml=async(value:string)=>act(async()=>{const node=document.getElementById('scenario-yaml') as HTMLTextAreaElement;Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const fill=async(label:string,value:string)=>act(async()=>{const input=[...document.querySelectorAll('label')].find(node=>node.textContent===label);const node=document.getElementById(input?.htmlFor??'') as HTMLInputElement;assert.ok(node,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 const openNamed=async(name:string)=>{await click('Manage workspace');const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.getAttribute('aria-label')?.startsWith('Open '+name+' ·'));assert.ok(button,name);await act(async()=>{button.click();await settle();});};
 return {directory,service,faults,document,dom,click,render,reload,editYaml,fill,openNamed,settle,holdPicker,releasePicker,close:async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true,force:true}).catch(()=>rm(directory,{recursive:true,force:true}));}};
}

test('workspace picker import starts empty, reviews an exported file, then opens a distinct copy after explicit commit',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const source=await page.service.save({name:'Portable source',yaml,canvas:{screens:[{id:'home',title:'Home',x:0,y:0,tests:[]}],edges:[],paths:[]}});
  await page.render();await page.click('Manage workspace');await page.click('Import workspace…');
  assert.match(page.document.body.textContent!,/Choose file/);
  assert.equal(page.document.querySelector('[aria-label="Import title"]'),null);
  const exported=await page.service.exportWorkspace({id:source.id,expectedRevision:1});
  const file=new page.dom.window.File([JSON.stringify(exported.package)],exported.filename,{type:'application/json'});
  const picker=page.document.querySelector<HTMLInputElement>('input[type="file"]');assert.ok(picker);
  await act(async()=>{Object.defineProperty(picker,'files',{value:[file],configurable:true});picker.dispatchEvent(new page.dom.window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,40));await page.settle();});
  assert.match(page.document.body.textContent!,/Portable-source/);
  assert.equal((await page.service.listWorkspaces()).items.length,1);
  await page.click('Import and open');
  const list=await page.service.listWorkspaces();assert.equal(list.items.length,2);assert.notEqual(list.items[0].id,source.id);
  assert.match(page.document.querySelector('[aria-label="Manage workspace"]')!.textContent!,/Portable source imported/);
  assert.equal((await page.service.workspace(source.id)).name,'Portable source');
 }finally{await page.close();}
});

test('the downloaded representative package round-trips through library drop with repeated visits, flows, mocks and reference imagery',async()=>{
 const page=await mount({recoverSession:true});
 const oldCreate=Object.getOwnPropertyDescriptor(URL,'createObjectURL');const oldRevoke=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
 let downloaded:Blob|undefined;let downloadName='';
 Object.defineProperty(URL,'createObjectURL',{configurable:true,value:(blob:Blob)=>{downloaded=blob;return 'blob:export';}});
 Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:()=>{}});
 page.dom.window.HTMLAnchorElement.prototype.click=function(){downloadName=this.download;};
 try{
  const {writeChecks}=await import('../shared/canvas-authoring.js');
  const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
  const canvas={screens:[{id:'home',title:'Home',x:0,y:0,referenceScreenshot:image,tests:[{id:'go',label:'Go',role:'action' as const,reference,tap:{target:'text' as const,match:'exact' as const,value:'Details'}}]},{id:'details',title:'Details',x:500,y:0,tests:[{id:'back',label:'Return',role:'action' as const,reference,tap:{target:'text' as const,match:'exact' as const,value:'Home'}}]}],edges:[{id:'out',from:'home',to:'details',actionTestId:'go',assertionTestId:'pending:out',responseCondition:'Go'},{id:'return',from:'details',to:'home',actionTestId:'back',assertionTestId:'pending:return',responseCondition:'Return'}],paths:[{id:'sequence',scenarioId:'journey',name:'Return journey',screenId:'home',edgeIds:['out','return'],visits:[{id:'first',operationIds:['go'],checkIds:[]},{id:'second',operationIds:['back'],checkIds:[]},{id:'third',operationIds:[],checkIds:[]}]}]};
  const authored=writeChecks(yaml,{screens:[],edges:[],paths:[]},canvas);
  const environment=JSON.parse(await readFile(join(process.cwd(),'tests/fixtures/mockoon.json'),'utf8'));
  const source=await page.service.save({name:'Representative',yaml:authored,canvas,flows:{'setup.yaml':yaml},automation:{setup:{file:'setup.yaml',parameters:{USER:'stored-user'}},actions:[],checkpoints:[]},scenarios:[{id:'journey',name:'Journey',authoring:'canvas',pathId:'sequence',steps:[],inputs:{ACCOUNT:'stored-account'},parameters:{ACCOUNT:{type:'text',required:true}},enabledHandlerIds:[]}],mock:{environment,port:4320,routeId:environment.routes[0].uuid,responseId:environment.routes[0].responses[0].uuid,backendUrl:'https://backend.example.test',passthroughRouteIds:[],fromScreen:'Home',toScreen:'Details',failureSemantics:'Maintenance'}});
  await page.render();await page.click('Manage workspace');await page.click('Export workspace…');
  assert.match(page.document.body.textContent!,/Repair required before execution/);
  await page.click('Export file');assert.ok(downloaded);assert.match(downloadName,/Representative.*json/);
  const text=await downloaded.text();const pkg=JSON.parse(text);
  assert.ok(!text.includes('stored-user'));assert.ok(!text.includes('stored-account'));
  assert.equal(pkg.workspace.canvas.screens[0].referenceScreenshot,image);
  assert.deepEqual(pkg.workspace.canvas.paths[0].visits,source.canvas!.paths[0].visits);
  assert.equal(pkg.workspace.mock.environment.routes[0].responses.length,2);
  await page.click('Cancel');await page.click('Manage workspace');await page.click('View all workspaces');
  const file=new page.dom.window.File([text],downloadName,{type:'application/json'});
  const library=page.document.querySelector('[aria-label="All workspaces"]')!;
  await act(async()=>{const event=new page.dom.window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],files:[file]}});library.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,40));await page.settle();});
  await page.click('Import and open');const copy=(await page.service.listWorkspaces()).items.find(item=>item.id!==source.id)!;
  assert.ok(copy);const loaded=await page.service.workspace(copy.id);
  assert.deepEqual(loaded.canvas,source.canvas);assert.deepEqual(loaded.flows,source.flows);
  assert.notEqual(loaded.id,source.id);assert.deepEqual((await page.service.workspace(source.id)).automation,source.automation);
  assert.equal(page.document.querySelector('[aria-label="Scenario reports"]'),null);
  await page.click('Manage workspace');await page.click('Rename workspace');await page.fill('Workspace title','Changed imported copy');await page.click('Done');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,400));await page.settle();});
  assert.equal((await page.service.workspace(source.id)).name,'Representative');
 }finally{
  if(oldCreate)Object.defineProperty(URL,'createObjectURL',oldCreate);if(oldRevoke)Object.defineProperty(URL,'revokeObjectURL',oldRevoke);
  await page.close();
 }
});

test('drop errors, choosing another file and Cancel retain editor work; successful import first preserves an invalid draft',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const source=await page.service.save({name:'Current',yaml});const exported=await page.service.exportWorkspace({id:source.id,expectedRevision:1});
  await page.render();await page.editYaml('appId: com.example.App\n---\n- tapOn: *missing\n');
  await page.click('Manage workspace');await page.click('Import workspace…');
  const file=new page.dom.window.File([JSON.stringify(exported.package)],'workspace.json',{type:'application/json'});
  const drop=async(files:File[])=>act(async()=>{const event=new page.dom.window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],files}});page.document.querySelector('.workspace-drop-target')!.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,40));await page.settle();});
  await drop([file,file]);assert.match(page.document.querySelector('[role="alert"]')!.textContent!,/exactly one/);
  await drop([new page.dom.window.File(['{broken'],'broken.json')]);assert.match(page.document.querySelector('[role="alert"]')!.textContent!,/Unreadable/);
  await drop([file]);await page.click('Cancel');assert.match((page.document.getElementById('scenario-yaml') as HTMLTextAreaElement).value,/\*missing/);
  assert.equal((await page.service.listWorkspaces()).items.length,1);
  await page.click('Manage workspace');await page.click('Import workspace…');await drop([file]);await page.click('Import and open');
  const detail=await page.service.workspaceDetail(source.id);assert.match(String(detail.draft?.content.yaml),/\*missing/);assert.equal(detail.yaml,yaml);
  assert.equal((await page.service.listWorkspaces()).items.length,2);
 }finally{await page.close();}
});

test('keyboard cancellation returns focus, and invalid drafts only export an explicitly identified saved revision',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const source=await page.service.save({name:'Saved version',yaml});await page.render();
  await page.editYaml('appId: com.example.App\n---\n- tapOn: *broken\n');
  await page.click('Manage workspace');await page.click('Export workspace…');
  assert.match(page.document.querySelector('.workspace-transfer [role="alert"]')!.textContent!,/Unresolved alias|Repair incomplete YAML/);
  assert.equal([...page.document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Export file')!.disabled,true);
  await page.click('Review last saved revision');assert.match(page.document.body.textContent!,/Only the identified saved revision/);
  assert.match(page.document.body.textContent!,/Saved revision 1/);
  assert.equal((await page.service.workspace(source.id)).yaml,yaml);
  await act(async()=>page.document.querySelector('[aria-label="Workspace manager"]')!.dispatchEvent(new page.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(page.document.activeElement?.getAttribute('aria-label'),'Manage workspace');
  assert.match((page.document.getElementById('scenario-yaml') as HTMLTextAreaElement).value,/\*broken/);
 }finally{await page.close();}
});

test('failed import preservation keeps the current editor and the reviewed file for retry',async()=>{
 const page=await mount({recoverSession:true});
 try{
  const source=await page.service.save({name:'Retained',yaml});const exported=await page.service.exportWorkspace({id:source.id,expectedRevision:1});await page.render();
  await page.editYaml('appId: com.example.App\n---\n- tapOn: Changed\n');page.faults.reject();
  await page.click('Manage workspace');await page.click('Import workspace…');
  const file=new page.dom.window.File([JSON.stringify(exported.package)],'workspace.json');const picker=page.document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async()=>{Object.defineProperty(picker,'files',{value:[file]});picker.dispatchEvent(new page.dom.window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,40));await page.settle();});
  await page.click('Import and open');assert.match(page.document.body.textContent!,/Injected write rejection/);
  assert.equal((await page.service.listWorkspaces()).items.length,1);assert.match((page.document.getElementById('scenario-yaml') as HTMLTextAreaElement).value,/Changed/);
  page.faults.pass();await page.click('Import and open');assert.equal((await page.service.listWorkspaces()).items.length,2);
  assert.match((await page.service.workspace(source.id)).yaml,/Changed/);
 }finally{page.faults.pass();await page.close();}
});
