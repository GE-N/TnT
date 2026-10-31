import {readdir,rm,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWorkspaceStore,subscribeWorkspaceChanges} from '../workspace-store.js';
import type {Workspace,Run} from '../scenarios.js';
import {atomicWrite,readSafe,safeDirectory,relativeParts} from './files.js';
import {canonical,sha256,makeDetail,sourceDescriptor} from './projection.js';
import {minimalHtml} from './artifacts.js';
import {projectInBackground,artifactsInBackground} from './background.js';
import {alwaysOwned,contextFields,emptyContext,validateContent,validateSave,workspaceId,scenarioId,scopeId,KnowledgeError,ContextRevisionConflict} from './types.js';
import type {RootGuard,KnowledgeFaults,IndexingQueue,GenerationInput,ScenarioContext,ScenarioDetail,Pointer,Manifest,FaultStage} from './types.js';
export * from './types.js';
export {sourceDescriptor,sourceProjection,deriveFlow} from './projection.js';
export {minimalHtml} from './artifacts.js';

type Store=ReturnType<typeof createWorkspaceStore>;
export type KnowledgeOptions={root:string;store?:Store;guard?:RootGuard;queue?:IndexingQueue;now?:()=>Date;faults?:KnowledgeFaults;readRuns?:(workspaceId:string)=>Promise<readonly Run[]>;renderHtml?:(input:GenerationInput)=>Record<string,string>|Promise<Record<string,string>>;reconcileIntervalMs?:number};
const publicationQueues=new Map<string,Promise<unknown>>();
const commitQueues=new Map<string,Promise<unknown>>();
const pins=new Map<string,number>();
// All sidecar writers share the store queue. This epoch permits coherent reads
// outside that queue without holding up workspace save or run-start reads.
const contextEpochs=new Map<string,number>();
function serializePublication<T>(key:string,job:()=>Promise<T>):Promise<T>{const next=(publicationQueues.get(key)??Promise.resolve()).then(job);const settled=next.catch(()=>{});publicationQueues.set(key,settled);void settled.then(()=>{if(publicationQueues.get(key)===settled)publicationQueues.delete(key);});return next;}
function serializeCommit<T>(key:string,job:()=>Promise<T>):Promise<T>{const next=(commitQueues.get(key)??Promise.resolve()).then(job);const settled=next.catch(()=>{});commitQueues.set(key,settled);void settled.then(()=>{if(commitQueues.get(key)===settled)commitQueues.delete(key);});return next;}
const isMissing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const publicationMessage=(error:unknown)=>error instanceof Error?error.message:'Knowledge publication failed.';
const generationId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
async function readFilePresence(directory:string,name:string){const entry=await lstat(join(directory,name));if(entry.isSymbolicLink()||!entry.isFile())throw new Error('Unsafe knowledge artifact.');}

export function createKnowledgeService(options:KnowledgeOptions){
 const root=resolve(options.root);const guard=options.guard??alwaysOwned;guard.assertOwned();
 const store=options.store??createWorkspaceStore(root,workspace=>workspace);
 const errors=new Map<string,string>();const scheduled=new Set<string>();const dirty=new Set<string>();const active=new Set<Promise<unknown>>();
 let closed=false;
 const now=()=>(options.now??(()=>new Date()))().toISOString();
 const hit=(stage:FaultStage,id:string,gen?:string,path?:string)=>options.faults?.hit?.(stage,{workspaceId:id,generationId:gen,path});
 async function inWorkspace<T>(id:string,operation:(workspace:Workspace,directory:string)=>Promise<T>){
  workspaceId(id);
  try{return await store.withKnowledge(id,operation);}catch(error){if(isMissing(error))throw new KnowledgeError(404,'KNOWLEDGE_NOT_FOUND','Saved workspace or scenario not found.');throw error;}
 }
 async function readContextFile(directory:string,id:string,scenario:string):Promise<ScenarioContext>{
  try{
   const folder=await safeDirectory(directory,['knowledge','scenarios'],guard);
   const text=await readSafe(folder,scenario+'.json');if(Buffer.byteLength(text)>650000)throw new Error('Context sidecar exceeds its size limit.');
   const value=JSON.parse(text) as ScenarioContext;
   if(value.schemaVersion!==1||value.workspaceId!==id||value.scenarioId!==scenario||!Number.isSafeInteger(value.contextRevision)||value.contextRevision<1||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt))||typeof value.reviewedAgainstSourceHash!=='string'||!/^[a-f0-9]{64}$/.test(value.reviewedAgainstSourceHash)||Object.keys(value).length!==12)throw new Error('Invalid knowledge sidecar.');
   validateContent(Object.fromEntries(contextFields.map(key=>[key,value[key]])));
   return value;
  }catch(error){if(isMissing(error))return emptyContext(id,scenario);throw error;}
 }
 async function readRuns(id:string):Promise<readonly Run[]>{
  if(options.readRuns)return options.readRuns(id);
  const runs:Run[]=[];
  let directory:string;
  try{directory=await safeDirectory(root,['runs'],guard);}catch(error){if(isMissing(error))return runs;throw error;}
  for(const entry of await readdir(directory,{withFileTypes:true})){
   if(!entry.isDirectory()||!generationId(entry.name))continue;
   try{const folder=await safeDirectory(directory,[entry.name],guard);const run=JSON.parse(await readSafe(folder,'result.json')) as Run;if(run.snapshot?.workspaceId===id)runs.push(run);}catch(error){if(!isMissing(error))throw error;}
  }
  return runs;
 }
 const epoch=(id:string)=>contextEpochs.get(root+':'+id)??0;
 async function rawCapture(id:string){
  for(;;){
   const captured=await inWorkspace(id,async(workspace,directory)=>({workspace:structuredClone(workspace),directory,contextEpoch:epoch(id)}));
   const contexts:Record<string,ScenarioContext>={};await Promise.all((captured.workspace.scenarios??[]).map(async scenario=>{scenarioId(scenario.id);contexts[scenario.id]=await readContextFile(captured.directory,id,scenario.id);}));
   const stable=await inWorkspace(id,async workspace=>workspace.metadata?.revision===captured.workspace.metadata?.revision&&epoch(id)===captured.contextEpoch);
   if(stable)return {...captured,contexts};
  }
 }
 async function capture(id:string,background=false){
  const [{workspace,contexts,contextEpoch},runs]=await Promise.all([rawCapture(id),readRuns(id)]);
  const scenarios=background?await projectInBackground(workspace,contexts,runs):(workspace.scenarios??[]).map(scenario=>makeDetail(workspace,scenario,contexts[scenario.id],runs));
  const inputHash=sha256(canonical({workspaceId:id,workspaceTitle:workspace.name,scenarios}));
  return {workspace,contexts,contextEpoch,scenarios,inputHash};
 }
 async function generationDirectory(id:string,gen:string,create=false){
  if(!generationId(gen))throw new Error('Invalid generation identity.');
  return safeDirectory(root,['knowledge','generations',scopeId(id),gen],guard,create);
 }
 async function validateGeneration(id:string,gen:string,deep=true){
  const directory=await generationDirectory(id,gen);const manifest=JSON.parse(await readSafe(directory,'manifest.json')) as Manifest;
  if(manifest.formatVersion!==1||manifest.generationId!==gen||manifest.scopeId!==scopeId(id)||manifest.workspaceId!==id||!Array.isArray(manifest.artifacts)||!Array.isArray(manifest.documents)||!Array.isArray(manifest.sources))throw new Error('Invalid generation manifest.');
  const required=new Set(['index.html','workspaces/'+id+'.html','index.jsonl']);
  for(const source of manifest.sources){scenarioId(source.scenarioId);required.add('documents/'+source.scenarioId+'.txt');if(!manifest.documents.some(doc=>doc.path==='documents/'+source.scenarioId+'.txt'))throw new Error('Mandatory text document is missing.');}
  const paths=new Set<string>();
  const folders=new Map<string,Promise<string>>();
  const checkArtifact=async(artifact:Manifest['artifacts'][number])=>{
   if(paths.has(artifact.path))throw new Error('Duplicate generation artifact.');paths.add(artifact.path);
   const parts=relativeParts(artifact.path);const name=parts.pop()!;const key=parts.join('/');if(!folders.has(key))folders.set(key,safeDirectory(directory,parts,guard));const folder=await folders.get(key)!;
   if(deep){const text=await readSafe(folder,name);if(sha256(text)!==artifact.sha256)throw new Error('Generation artifact checksum mismatch.');}
   else await readFilePresence(folder,name);
   required.delete(artifact.path);
  };
  for(let index=0;index<manifest.artifacts.length;index+=4)await Promise.all(manifest.artifacts.slice(index,index+4).map(checkArtifact));
  if(required.size)throw new Error('Generation is missing mandatory HTML or LLM text index.');
  for(const document of manifest.documents){if(!manifest.artifacts.some(artifact=>artifact.path===document.path&&artifact.sha256===document.sha256))throw new Error('Invalid text document checksum.');}
  if(!deep)return {directory,manifest};
  const lines=(await readSafe(directory,'index.jsonl')).trim();const rows=lines?lines.split('\n').map(line=>JSON.parse(line) as Record<string,unknown>):[];
  if(rows.some(row=>row.generationId!==gen||row.workspaceId!==id||typeof row.scenarioId!=='string'||!manifest.sources.some(source=>source.scenarioId===row.scenarioId&&canonical(source.sourceDescriptor)===canonical(row.sourceDescriptor)&&source.contextRevision===row.contextRevision)))throw new Error('Text index source descriptor mismatch.');
  if(manifest.sources.some(source=>!rows.some(row=>row.scenarioId===source.scenarioId&&row.section==='flow')))throw new Error('Text index is missing scenario flow sections.');
  return {directory,manifest};
 }
 async function rawPointer(id:string):Promise<Pointer|null>{
  try{
   const directory=await safeDirectory(root,['knowledge','current'],guard);const value=JSON.parse(await readSafe(directory,scopeId(id)+'.json')) as Pointer;
   if(value.formatVersion!==1||value.scopeId!==scopeId(id)||!generationId(value.generationId)||(value.previousGenerationId!==null&&!generationId(value.previousGenerationId))||typeof value.inputHash!=='string')throw new Error('Invalid knowledge pointer.');
   return value;
  }catch(error){if(isMissing(error))return null;throw error;}
 }
 async function pointer(id:string,deep=true):Promise<Pointer|null>{
  const value=await rawPointer(id);if(!value)return null;
  try{await validateGeneration(id,value.generationId,deep);return value;}catch(error){if(isMissing(error))return null;throw error;}
 }
 async function previousComplete(id:string){
  let previous:Pointer|null=null;try{previous=await rawPointer(id);}catch{return null;}
  for(const gen of [previous?.generationId,previous?.previousGenerationId])if(gen){try{await validateGeneration(id,gen);return gen;}catch{/* Skip incomplete generated data, preserving the last complete generation. */}}
  return null;
 }
 async function decorated(id:string){
  const captured=await capture(id);let current:Pointer|null=null;let pointerError:string|null=null;
  try{current=await serializeCommit(root+':'+scopeId(id),()=>pointer(id));}catch(error){pointerError=publicationMessage(error);}
  const publicationError=errors.get(id)??pointerError;const fresh=!!current&&current.inputHash===captured.inputHash;
  const scenarios=captured.scenarios.map((detail):ScenarioDetail=>({...detail,publicationFreshness:fresh?'current':'publication-stale',freshness:detail.intentFreshness==='intent-needs-review'||publicationError?'needs-review':fresh?'up-to-date':'updating',generationId:current?.generationId??null,generatedAt:current?.generatedAt??null,publicationError}));
  return {...captured,current,scenarios,publicationError,fresh};
 }
 function schedule(id:string,afterCommit=false){
  if(closed)return;workspaceId(id);guard.assertOwned();if(scheduled.has(id)){dirty.add(id);return;}scheduled.add(id);
  // Scheduling stays constant-time in workspace save/run critical paths.
  setImmediate(()=>{
   if(closed){scheduled.delete(id);return;}
   const job=async()=>{
    try{guard.assertOwned();await service.publish(id);}
    catch(error){if(!(error instanceof KnowledgeError&&error.status===404))errors.set(id,publicationMessage(error));}
    finally{scheduled.delete(id);if(dirty.delete(id))schedule(id);}
   };
   const submit=async()=>{
    try{if(afterCommit)await hit('after-source-commit',id);guard.assertOwned();const submitted=options.queue?options.queue.enqueue(scopeId(id),job):job();await submitted;}
    catch(error){errors.set(id,publicationMessage(error));scheduled.delete(id);}
   };
   const tracked=submit();active.add(tracked);void tracked.finally(()=>active.delete(tracked));
  });
 }
 async function cleanup(id:string,current:Pointer){
  const directory=await safeDirectory(root,['knowledge','generations',scopeId(id)],guard);
  for(const entry of await readdir(directory,{withFileTypes:true})){
   if(!entry.isDirectory()||!generationId(entry.name)||entry.name===current.generationId||entry.name===current.previousGenerationId)continue;
   const path=join(directory,entry.name);if(pins.get(path))continue;
   await safeDirectory(directory,[entry.name],guard);guard.assertOwned();await rm(path,{recursive:true,force:true});
  }
 }
 const unsubscribe=subscribeWorkspaceChanges(root,id=>schedule(id,true));
 const interval=options.reconcileIntervalMs===0?undefined:setInterval(()=>{if(!closed)void service.reconcile().catch(()=>{});},options.reconcileIntervalMs??30000);interval?.unref();
 const service={
  async readContext(id:string,scenario:string){
   workspaceId(id);scenarioId(scenario);const data=await decorated(id);const detail=data.scenarios.find(item=>item.scenarioId===scenario);if(!detail)throw new KnowledgeError(404,'KNOWLEDGE_NOT_FOUND','Saved workspace or scenario not found.');
   if(!data.fresh&&!scheduled.has(id))schedule(id);return detail;
  },
  async saveContext(id:string,scenario:string,input:unknown){
   workspaceId(id);scenarioId(scenario);const value=validateSave(input);let saved=false;
   // Projection is outside the store queue; recheck its source revision at commit.
   while(!saved){
    const captured=await rawCapture(id);const definition=captured.workspace.scenarios?.find(item=>item.id===scenario);if(!definition)throw new KnowledgeError(404,'KNOWLEDGE_NOT_FOUND','Saved workspace or scenario not found.');
    const reviewedHash=sourceDescriptor(captured.workspace,definition).sourceHash;
    saved=await inWorkspace(id,async(workspace,directory)=>{
     if(workspace.metadata?.revision!==captured.workspace.metadata?.revision)return false;
     if(!workspace.scenarios?.some(item=>item.id===scenario))throw new KnowledgeError(404,'KNOWLEDGE_NOT_FOUND','Saved workspace or scenario not found.');
     const current=await readContextFile(directory,id,scenario);if(current.contextRevision!==value.expectedContextRevision)throw new ContextRevisionConflict(current);
     if(current.reviewedAgainstSourceHash===reviewedHash&&contextFields.every(field=>current[field]===value.context[field]))return true;
     if(!Number.isSafeInteger(current.contextRevision+1))throw new KnowledgeError(400,'INVALID_KNOWLEDGE_INPUT','Context revision limit exceeded.');
     const next:ScenarioContext={schemaVersion:1,workspaceId:id,scenarioId:scenario,contextRevision:current.contextRevision+1,updatedAt:now(),...value.context,reviewedAgainstSourceHash:reviewedHash};
     guard.assertOwned();const folder=await safeDirectory(directory,['knowledge','scenarios'],guard,true);contextEpochs.set(root+':'+id,epoch(id)+1);await atomicWrite(folder,scenario+'.json',JSON.stringify(next,null,2)+'\n',guard);return true;
    });
   }
   errors.delete(id);schedule(id,true);
   const data=await decorated(id);return data.scenarios.find(item=>item.scenarioId===scenario)!;
  },
  async status(id:string){
   workspaceId(id);const data=await decorated(id);if(!data.fresh&&!scheduled.has(id))schedule(id);
   return {workspaceId:id,scopeId:scopeId(id),generationId:data.current?.generationId??null,generatedAt:data.current?.generatedAt??null,publicationFreshness:data.fresh?'current' as const:'publication-stale' as const,freshness:data.publicationError||data.scenarios.some(item=>item.freshness==='needs-review')?'needs-review' as const:data.fresh?'up-to-date' as const:'updating' as const,publicationError:data.publicationError,scenarios:data.scenarios.map(({scenarioId,freshness,publicationFreshness,intentFreshness})=>({scenarioId,freshness,publicationFreshness,intentFreshness}))};
  },
  async publish(id:string){
   workspaceId(id);guard.assertOwned();
   return serializePublication(root+':'+scopeId(id),async()=>{
    guard.assertOwned();const captured=await capture(id,true);const gen=randomUUID();await hit('after-descriptor-capture',id,gen);
    const input:GenerationInput={generationId:gen,scopeId:scopeId(id),workspaceId:id,workspaceTitle:captured.workspace.name,generatedAt:now(),scenarios:captured.scenarios};
    const html=await (options.renderHtml??minimalHtml)(input);
    const {files}=await artifactsInBackground(input,html);
    guard.assertOwned();const directory=await generationDirectory(id,gen,true);
    const destinations=new Map<string,{folder:string;name:string}>();
    const folders=new Map<string,string>();
    for(const path of Object.keys(files)){const parts=relativeParts(path);const name=parts.pop()!;const key=parts.join('/');if(!folders.has(key))folders.set(key,await safeDirectory(directory,parts,guard,true));destinations.set(path,{folder:folders.get(key)!,name});}
    const entries=Object.entries(files);
    for(let index=0;index<entries.length;index+=2){
     const results=await Promise.allSettled(entries.slice(index,index+2).map(async([path,text])=>{
      await hit('artifact-write',id,gen,path);const {folder,name}=destinations.get(path)!;await atomicWrite(folder,name,text,guard);
     }));
     const failure=results.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
    }
    const verify=async()=>{const complete=await validateGeneration(id,gen);const expected=input.scenarios.map(scenario=>({scenarioId:scenario.scenarioId,sourceDescriptor:scenario.sourceDescriptor,contextRevision:scenario.context.contextRevision}));if(canonical(complete.manifest.sources)!==canonical(expected))throw new Error('Generation does not match captured source descriptors.');return complete;};
    await hit('before-generation-complete',id,gen);await hit('before-validation',id,gen);const complete=await verify();await hit('after-validation',id,gen);
    // Detect tampering/faults after validation too; a missing index never gets switched in.
    await verify();
    const previous=await previousComplete(id);
    await hit('before-final-check',id,gen);
    let committed:Pointer|null=null;
    await inWorkspace(id,async(workspace,directory)=>{
     if(workspace.metadata?.revision!==captured.workspace.metadata?.revision||workspace.name!==captured.workspace.name)return;
     if(epoch(id)!==captured.contextEpoch)return;
     if(canonical((workspace.scenarios??[]).map(item=>item.id))!==canonical(captured.scenarios.map(item=>item.scenarioId)))return;
     await hit('after-final-check',id,gen);guard.assertOwned();
     await serializeCommit(root+':'+scopeId(id),async()=>{
      const next:Pointer={formatVersion:1,scopeId:scopeId(id),generationId:gen,previousGenerationId:previous,generatedAt:input.generatedAt,inputHash:captured.inputHash};
      const pointerDirectory=await safeDirectory(root,['knowledge','current'],guard,true);
      await atomicWrite(pointerDirectory,scopeId(id)+'.json',JSON.stringify(next)+'\n',guard,async()=>{await hit('before-pointer-rename',id,gen);await Promise.all([...destinations.values()].map(({folder,name})=>readFilePresence(folder,name)));});
      committed=next;await hit('after-pointer-rename',id,gen);
     });
    });
    if(!committed)return {published:false,generationId:null};
    errors.delete(id);await serializeCommit(root+':'+scopeId(id),()=>cleanup(id,committed!));return {published:true,generationId:complete.manifest.generationId};
   }).catch(error=>{errors.set(id,publicationMessage(error));throw error;});
  },
  async rebuild(id:string){workspaceId(id);await rawCapture(id);schedule(id);return {queued:true};},
  async reconcile(){
   guard.assertOwned();let directory:string;try{directory=await safeDirectory(root,['workspaces'],guard);}catch(error){if(isMissing(error))return;throw error;}
   for(const entry of await readdir(directory,{withFileTypes:true})){if(!entry.isDirectory()||!generationId(entry.name))continue;try{const state=await decorated(entry.name);if(!state.fresh){guard.assertOwned();schedule(entry.name);}}catch(error){errors.set(entry.name,publicationMessage(error));}}
  },
  async pinCurrent(id:string){
   workspaceId(id);
   // Pins and cleanup share the scope serialization; no check/pin deletion race.
   return inWorkspace(id,async workspace=>serializeCommit(root+':'+scopeId(id),async()=>{
    const current=await pointer(id,false);if(!current)throw new KnowledgeError(503,'KNOWLEDGE_UNAVAILABLE','Knowledge publication is pending.');
    const {directory,manifest}=await validateGeneration(id,current.generationId,false);
    if(manifest.sources.some(source=>!workspace.scenarios?.some(scenario=>scenario.id===source.scenarioId)))throw new KnowledgeError(503,'KNOWLEDGE_UNAVAILABLE','Knowledge visibility changed; publication is pending.');
    pins.set(directory,(pins.get(directory)??0)+1);let released=false;
    return {pointer:current,directory,manifest,release(){if(released)return;released=true;const count=(pins.get(directory)??1)-1;if(count)pins.set(directory,count);else pins.delete(directory);}};
   }));
  },
  close(){closed=true;unsubscribe();if(interval)clearInterval(interval);},
  /** Test/shutdown helper; callers must not await this in save/run paths. */
  async idle(){while(active.size)await Promise.allSettled([...active]);},
 };
 return service;
}
export type KnowledgeService=ReturnType<typeof createKnowledgeService>;
