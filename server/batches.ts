import {randomUUID} from 'node:crypto';
import type {Run,RunInput,Workspace} from './scenarios.js';
export type BatchEntry = {scenarioId:string;name:string;status:'queued'|'not-run'|Run['status'];runId?:string;reason?:string};
export type Batch = {
 id:string;workspaceId:string;deviceId:string;startedAt:string;finishedAt?:string;
 status:'running'|'cancelling'|'completed'|'cancelled'|'blocked';entries:BatchEntry[];
 snapshot:{workspace:Workspace;resetApp:boolean;runtimeInputPolicy:string};
};
export type BatchInput = {workspaceId:string;deviceId:string;scenarioIds?:string[];runtimeInputs?:unknown;resetApp?:boolean};
type Dependencies = {
 workspace:(id:string)=>Promise<Workspace>;
 preview:(input:Workspace & {scenarioId:string;runtimeInputs?:unknown;resetApp?:boolean})=>Promise<unknown>;
 start:(input:RunInput,workspace:Workspace,signal:AbortSignal)=>Promise<Run>;
 wait:(id:string)=>Promise<Run>;cancel:(id:string)=>Promise<Run>;
 persist:(batch:Batch)=>Promise<void>;read:(id:string)=>Promise<Batch>;
};
export function createBatches(dependencies:Dependencies){
 let active:{batch:Batch;cancelled:boolean;runId?:string;done:Promise<Batch>;controller:AbortController}|undefined;
 const message=(error:unknown)=>error instanceof Error?error.message:'Batch operation failed.';
 const stopQueue=(batch:Batch,reason:string)=>{for(const entry of batch.entries)if(entry.status==='queued'){entry.status='not-run';entry.reason=reason;}};
 const service={
  get busy(){return !!active;},
  async start(input:BatchInput):Promise<Batch>{
   if(active)throw new Error('A scenario batch is in progress. Wait for cleanup.');
   // Reserve before the first await so simultaneous requests cannot create two queues.
   const state={controller:new AbortController(),batch:undefined as unknown as Batch,cancelled:false,runId:undefined as string|undefined,done:Promise.resolve(undefined as unknown as Batch)};
   active=state;
   try{
    const workspace=structuredClone(await dependencies.workspace(input.workspaceId));
    const ids=input.scenarioIds??workspace.scenarios?.map(item=>item.id)??[];
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new Error('Request distinct scenario IDs from the saved workspace.');
    const entries:BatchEntry[]=ids.map(id=>({scenarioId:id,name:workspace.scenarios?.find(item=>item.id===id)?.name??id,status:'queued'}));
    const batch:Batch={id:randomUUID(),workspaceId:workspace.id,deviceId:input.deviceId,startedAt:new Date().toISOString(),status:'running',entries,snapshot:{workspace,resetApp:input.resetApp??false,runtimeInputPolicy:input.runtimeInputs===undefined?'Saved inputs only; no additional reset or server-session guarantee.':'Runtime values omitted; each run applies the confidential runtime-input policy.'}};
    state.batch=batch;
    for(const entry of entries){
     try{await dependencies.preview({...workspace,scenarioId:entry.scenarioId,runtimeInputs:input.runtimeInputs,resetApp:input.resetApp});}
     catch(error){entry.status='not-run';entry.reason=message(error);}
    }
    await dependencies.persist(batch);
    state.done=(async()=>{
     try{
      for(const entry of entries){
       if(state.cancelled){stopQueue(batch,'Batch cancelled before dispatch.');break;}
       if(entry.status!=='queued')continue;
       entry.status='running';await dependencies.persist(batch);
       const run=await dependencies.start({workspaceId:workspace.id,deviceId:input.deviceId,scenarioId:entry.scenarioId,runtimeInputs:input.runtimeInputs,resetApp:input.resetApp},structuredClone(workspace),state.controller.signal);
       entry.runId=run.id;state.runId=run.id;await dependencies.persist(batch);
       const result=state.cancelled?await dependencies.cancel(run.id).catch(()=>dependencies.wait(run.id)):await dependencies.wait(run.id);
       state.runId=undefined;entry.status=result.status;
       if(!result.cleanup.verified||!['passed','assertion-failed','path-failed'].includes(result.status)){
        batch.status=state.cancelled||result.status==='cancelled'?'cancelled':'blocked';
        stopQueue(batch,!result.cleanup.verified?'Owned-process cleanup is unverified; device reuse blocked.':`Dispatch stopped after ${result.status}.`);
        await dependencies.persist(batch);break;
       }
       await dependencies.persist(batch);
      }
      if(state.cancelled){batch.status='cancelled';stopQueue(batch,'Batch cancelled before dispatch.');}
      else if(batch.status==='running')batch.status='completed';
     }catch(error){
      batch.status=state.cancelled?'cancelled':'blocked';
      const entry=entries.find(item=>item.status==='running');
      // A summary-write failure must not abandon an ordinary run that already owns a process.
      if(state.runId){
       try{
        const result=await dependencies.cancel(state.runId).catch(()=>dependencies.wait(state.runId!));
        if(entry)entry.status=result.status;
       }catch{if(entry)entry.status='tool-error';}
       state.runId=undefined;
      }
      if(entry){if(entry.status==='running')entry.status='not-run';entry.reason='Dispatch failed: '+message(error);}
      stopQueue(batch,'Safe dispatch blocked: '+message(error));
     }finally{
      batch.finishedAt=new Date().toISOString();
      try{await dependencies.persist(batch);}finally{if(active===state)active=undefined;}
     }
     return structuredClone(batch);
    })();
    void state.done.catch(()=>{});
    return structuredClone(batch);
   }catch(error){if(active===state)active=undefined;throw error;}
  },
  async result(id:string):Promise<Batch>{return dependencies.read(id);},
  async wait(id:string):Promise<Batch>{return active?.batch?.id===id?active.done:service.result(id);},
  async cancel(id:string):Promise<Batch>{
   const state=active;if(!state||state.batch?.id!==id)throw new Error('Batch is no longer active.');
   state.cancelled=true;state.controller.abort();state.batch.status='cancelling';stopQueue(state.batch,'Batch cancelled before dispatch.');
   if(state.runId)await dependencies.cancel(state.runId).catch(()=>dependencies.wait(state.runId!));
   return state.done;
  },
 };
 return service;
}
