import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir,writeFile,symlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkspaceStore} from '../server/workspace-store.js';
import {createKnowledgeService,ContextRevisionConflict,KnowledgeError,sourceDescriptor,deriveFlow,type KnowledgeOptions,type ContextContent,type FaultStage} from '../server/knowledge/index.js';
import type {Workspace,Run} from '../server/scenarios.js';
import {referenceCatalog} from '../server/canvas.js';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';

const content:ContextContent={purpose:'Open directory',expectedOutcome:'Contacts are visible',rationale:'Find the responsible person',preconditions:'Signed in',exceptions:'Empty directory',scope:'Display only'};
const yaml='appId: com.example.App\n---\n- launchApp\n- tapOn: Continue\n- assertVisible: Directory\n';
function definition(source=yaml):ScenarioDefinition{return {id:'directory',name:'Directory',steps:referenceCatalog(source).references.filter(ref=>ref.kind==='step').map(({kind,file,index,fingerprint})=>({kind,file,index,fingerprint})),inputs:{},parameters:{},enabledHandlerIds:[]};}
async function fixture(options:Partial<KnowledgeOptions>={}){
 const root=await mkdtemp(join(tmpdir(),'tnt-knowledge-'));const store=createWorkspaceStore(root,workspace=>workspace);
 const workspace=await store.save({id:'',name:'Knowledge fixture',yaml,scenarios:[definition()]});
 const jobs:(()=>Promise<void>)[]=[];
 const service=createKnowledgeService({root,store,queue:{enqueue(_scope,job){jobs.push(job);}},reconcileIntervalMs:0,...options});
 return {root,store,workspace,service,jobs,async close(){service.close();await rm(root,{recursive:true,force:true});}};
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function pointer(root:string,id:string){return JSON.parse(await readFile(join(root,'knowledge','current','workspace-'+id+'.json'),'utf8')) as {generationId:string;previousGenerationId:string|null};}

for(const [label,value,status] of [
 ['unknown field',{...content,extra:'no'},400],['missing field',{purpose:'only'},400],['wrong type',{...content,scope:[]},400],['NUL',{...content,purpose:'x\0'},400],['UTF-8 limit',{...content,purpose:'ก'.repeat(5334)},413],
] as const)test('context schema rejects '+label,async()=>{const f=await fixture();try{await assert.rejects(f.service.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:value}),error=>error instanceof KnowledgeError&&error.status===status);}finally{await f.close();}});

test('context read is lazy, saves increment only changed revisions, and conflicts return server context',async()=>{
 const f=await fixture();try{
  const first=await f.service.readContext(f.workspace.id,'directory');assert.equal(first.context.contextRevision,0);assert.equal(first.evidence.label,'No runs yet');assert.equal(first.freshness,'needs-review');
  await assert.rejects(readFile(join(f.root,'workspaces',f.workspace.id,'knowledge','scenarios','directory.json')),/ENOENT/);
  const saved=await f.service.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:content});assert.equal(saved.context.contextRevision,1);assert.equal(saved.freshness,'updating');
  const same=await f.service.saveContext(f.workspace.id,'directory',{expectedContextRevision:1,context:content});assert.equal(same.context.contextRevision,1);
  await assert.rejects(f.service.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:{...content,purpose:'lost draft'}}),error=>error instanceof ContextRevisionConflict&&error.currentContextRevision===1&&error.context.purpose===content.purpose);
  const published=await f.service.publish(f.workspace.id);assert.equal(published.published,true);assert.equal((await f.service.readContext(f.workspace.id,'directory')).freshness,'up-to-date');
  const changed=yaml.replace('Continue','Next');const workspace=await f.store.save({...f.workspace,yaml:changed,scenarios:[definition(changed)]},1);
  const stale=await f.service.readContext(workspace.id,'directory');assert.equal(stale.intentFreshness,'intent-needs-review');assert.equal(stale.publicationFreshness,'publication-stale');assert.equal(stale.freshness,'needs-review');
  await f.service.publish(workspace.id);const current=await f.service.readContext(workspace.id,'directory');assert.equal(current.publicationFreshness,'current');assert.equal(current.freshness,'needs-review');
  const reviewed=await f.service.saveContext(workspace.id,'directory',{expectedContextRevision:1,context:content});assert.equal(reviewed.context.contextRevision,2);assert.equal(reviewed.freshness,'updating');
  await f.service.publish(workspace.id);assert.equal((await f.service.status(workspace.id)).freshness,'up-to-date');
 }finally{await f.close();}
});

test('concurrent context writers share the workspace store queue and only one wins',async()=>{
 const f=await fixture();try{
  const second=createKnowledgeService({root:f.root,queue:{enqueue(){}},reconcileIntervalMs:0});
  try{const results=await Promise.allSettled([f.service.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:content}),second.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:{...content,purpose:'Other'}})]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected'&&result.reason instanceof ContextRevisionConflict).length,1);}finally{second.close();}
 }finally{await f.close();}
});

test('rebuild restores a deleted index without touching authored context or workspace bytes',async()=>{
 const f=await fixture();try{
  await f.service.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:content});await f.service.publish(f.workspace.id);
  const old=await pointer(f.root,f.workspace.id);const contextPath=join(f.root,'workspaces',f.workspace.id,'knowledge','scenarios','directory.json');const workspacePath=join(f.root,'workspaces',f.workspace.id,'workspace.json');
  const before=await Promise.all([readFile(contextPath),readFile(workspacePath)]);
  await rm(join(f.root,'knowledge','generations','workspace-'+f.workspace.id,old.generationId,'index.jsonl'));
  assert.equal((await f.service.status(f.workspace.id)).publicationFreshness,'publication-stale');
  await f.service.publish(f.workspace.id);const current=await pointer(f.root,f.workspace.id);assert.notEqual(current.generationId,old.generationId);
  assert.deepEqual(await Promise.all([readFile(contextPath),readFile(workspacePath)]),before);assert.equal((await f.service.status(f.workspace.id)).freshness,'up-to-date');
 }finally{await f.close();}
});

for(const stage of ['after-descriptor-capture','artifact-write','before-generation-complete','before-validation','after-validation','before-final-check','after-final-check','before-pointer-rename','after-pointer-rename'] as FaultStage[])test('publication fault '+stage+' leaves a complete old or committed new generation',async()=>{
 let fail=false;const f=await fixture({faults:{hit(point){if(fail&&point===stage)throw new Error('Injected '+stage);}}});
 try{
  await f.service.publish(f.workspace.id);const old=await pointer(f.root,f.workspace.id);fail=true;
  await assert.rejects(f.service.publish(f.workspace.id),/Injected/);const current=await pointer(f.root,f.workspace.id);
  assert.equal(current.generationId===old.generationId,stage!=='after-pointer-rename');
  const directory=join(f.root,'knowledge','generations','workspace-'+f.workspace.id,current.generationId);for(const name of ['manifest.json','index.jsonl','index.html','documents/directory.txt'])assert.ok((await readFile(join(directory,name))).length);
  const restarted=createKnowledgeService({root:f.root,queue:{enqueue(){}},reconcileIntervalMs:0});try{const pinned=await restarted.pinCurrent(f.workspace.id);assert.equal(pinned.pointer.generationId,current.generationId);pinned.release();}finally{restarted.close();}
 }finally{await f.close();}
});

test('failure after source commit saves context, never enqueues, and restart reconciliation recovers',async()=>{
 const f=await fixture({faults:{hit(stage){if(stage==='after-source-commit')throw new Error('Source/enqueue crash');}}});
 try{
  await f.service.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:content});await tick();await f.service.idle();assert.equal(f.jobs.length,0);assert.equal((await f.service.readContext(f.workspace.id,'directory')).context.contextRevision,1);
  f.service.close();const jobs:(()=>Promise<void>)[]=[];const restarted=createKnowledgeService({root:f.root,queue:{enqueue(_scope,job){jobs.push(job);}},reconcileIntervalMs:0});
  try{await restarted.reconcile();await tick();assert.equal(jobs.length,1);await jobs[0]();assert.equal((await restarted.status(f.workspace.id)).freshness,'up-to-date');}finally{restarted.close();}
 }finally{await f.close();}
});

test('a generation missing its text index or documents never replaces the pointer',async()=>{
 let remove=false;const f=await fixture({faults:{async hit(stage,detail){if(remove&&stage==='after-validation'){await rm(join(f.root,'knowledge','generations','workspace-'+f.workspace.id,detail.generationId!,'index.jsonl'));}}}});
 try{await f.service.publish(f.workspace.id);const old=await pointer(f.root,f.workspace.id);remove=true;await assert.rejects(f.service.publish(f.workspace.id),/ENOENT/);assert.deepEqual(await pointer(f.root,f.workspace.id),old);}finally{await f.close();}
});

test('current and previous generations are retained and active reads stay pinned during cleanup',async()=>{
 const f=await fixture();try{
  await f.service.publish(f.workspace.id);const pinned=await f.service.pinCurrent(f.workspace.id);await f.service.publish(f.workspace.id);await f.service.publish(f.workspace.id);
  assert.equal((await readdir(join(f.root,'knowledge','generations','workspace-'+f.workspace.id))).length,3);assert.ok(await readFile(join(pinned.directory,'manifest.json')));
  pinned.release();pinned.release();await f.service.publish(f.workspace.id);assert.equal((await readdir(join(f.root,'knowledge','generations','workspace-'+f.workspace.id))).length,2);
 }finally{await f.close();}
});

test('invalid IDs and symlinked sidecar paths cannot write outside the workspace',async()=>{
 const f=await fixture();const outside=await mkdtemp(join(tmpdir(),'tnt-knowledge-outside-'));
 try{
  for(const id of ['../escape','x/y','%2e%2e','not-a-uuid'])await assert.rejects(f.service.saveContext(id,'directory',{expectedContextRevision:0,context:content}),error=>error instanceof KnowledgeError&&error.status===400);
  for(const id of ['../escape','a/b','%2e%2e','.',''])await assert.rejects(f.service.saveContext(f.workspace.id,id,{expectedContextRevision:0,context:content}),error=>error instanceof KnowledgeError&&error.status===400);
  await symlink(outside,join(f.root,'workspaces',f.workspace.id,'knowledge'));await assert.rejects(f.service.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:content}),/Unsafe knowledge directory/);assert.deepEqual(await readdir(outside),[]);
 }finally{await f.close();await rm(outside,{recursive:true,force:true});}
});

test('late publication cannot resurrect a trashed workspace or replace newer saved flow',async()=>{
 let release!:()=>void;let captured!:()=>void;const reached=new Promise<void>(resolve=>captured=resolve);const gate=new Promise<void>(resolve=>release=resolve);let block=false;
 const f=await fixture({faults:{async hit(stage){if(block&&stage==='after-descriptor-capture'){captured();await gate;}}}});
 try{
  await f.service.publish(f.workspace.id);const old=await pointer(f.root,f.workspace.id);block=true;const publishing=f.service.publish(f.workspace.id);await reached;
  await f.store.trash(f.workspace.id);release();await assert.rejects(publishing,error=>error instanceof KnowledgeError&&error.status===404);assert.deepEqual(await pointer(f.root,f.workspace.id),old);
  await assert.rejects(readFile(join(f.root,'workspaces',f.workspace.id,'workspace.json')),/ENOENT/);
 }finally{release?.();await f.close();}
});

test('same-scope superseded work is discarded; independent scope publications coexist',async()=>{
 let release!:()=>void;let reached!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const captured=new Promise<void>(resolve=>reached=resolve);let block=true;
 const f=await fixture({faults:{async hit(stage){if(block&&stage==='after-descriptor-capture'){reached();await gate;}}}});
 try{
  const old=f.service.publish(f.workspace.id);await captured;const changed=yaml.replace('Continue','Next');await f.store.save({...f.workspace,yaml:changed,scenarios:[definition(changed)]},1);release();assert.equal((await old).published,false);block=false;
  const second=await f.store.save({id:'',name:'Second',yaml,scenarios:[definition()]});const result=await Promise.all([f.service.publish(f.workspace.id),f.service.publish(second.id)]);assert.ok(result.every(item=>item.published));assert.ok(await pointer(f.root,f.workspace.id));assert.ok(await pointer(f.root,second.id));
 }finally{release?.();await f.close();}
});

test('RootGuard is rechecked before sidecars, artifacts, pointers and recovery enqueue',async()=>{
 let owned=true;const guard={assertOwned(){if(!owned)throw new Error('Ownership lost');}};const f=await fixture({guard});
 try{
  await f.service.publish(f.workspace.id);const before=await pointer(f.root,f.workspace.id);owned=false;
  await assert.rejects(f.service.saveContext(f.workspace.id,'directory',{expectedContextRevision:0,context:content}),/Ownership lost/);await assert.rejects(f.service.publish(f.workspace.id),/Ownership lost/);await assert.rejects(f.service.reconcile(),/Ownership lost/);assert.deepEqual(await pointer(f.root,f.workspace.id),before);
 }finally{await f.close();}
});

test('evidence uses latest completed scenario result and never publishes logs or runtime payloads',async()=>{
 const f=await fixture();try{
  const completed={id:'old',finishedAt:'2026-10-30T00:00:00Z',status:'passed',snapshot:{workspaceId:f.workspace.id,scenario:definition()},log:'SECRET LOG',runtimeInputs:{TOKEN:'SECRET TOKEN'}} as unknown as Run;
  const service=createKnowledgeService({root:f.root,readRuns:async()=>[completed,{...completed,id:'running',status:'running',finishedAt:undefined},{...completed,id:'other',finishedAt:'2026-10-31T00:00:00Z',snapshot:{...completed.snapshot,scenario:{...definition(),id:'other'}}}],queue:{enqueue(){}},reconcileIntervalMs:0});
  try{const detail=await service.readContext(f.workspace.id,'directory');assert.equal(detail.evidence.runId,'old');assert.match(detail.evidence.notice,/do not establish/);await service.publish(f.workspace.id);const pinned=await service.pinCurrent(f.workspace.id);try{const text=await readFile(join(pinned.directory,'documents','directory.txt'),'utf8');assert.doesNotMatch(text,/SECRET/);assert.match(text,/passed/);}finally{pinned.release();}}finally{service.close();}
 }finally{await f.close();}
});
