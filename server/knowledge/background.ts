import {Worker} from 'node:worker_threads';
import type {Workspace,Run} from '../scenarios.js';
import type {GenerationInput,ScenarioContext,ScenarioDetail,Manifest} from './types.js';

/** CPU-heavy indexing runs off the runner event loop; the injected queue controls when it starts. */
function task<T>(operation:string,input:unknown):Promise<T>{
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{operation,input},execArgv:[]});
  let settled=false;
  worker.once('message',(message:{value?:T;error?:string})=>{settled=true;if(message.error)reject(new Error(message.error));else resolve(message.value as T);void worker.terminate();});
  worker.once('error',error=>{settled=true;reject(error);});
  worker.once('exit',code=>{if(!settled)reject(new Error('Knowledge indexing worker exited before completion ('+code+').'));});
 });
}
export function projectInBackground(workspace:Workspace,contexts:Record<string,ScenarioContext>,runs:readonly Run[]){
 const evidence=runs.map(run=>({id:run.id,status:run.status,finishedAt:run.finishedAt,snapshot:{workspaceId:run.snapshot?.workspaceId,scenario:run.snapshot?.scenario?{id:run.snapshot.scenario.id}:undefined}}));
 return task<ScenarioDetail[]>('project',{workspace,contexts,runs:evidence});
}
export function artifactsInBackground(input:GenerationInput,html:Record<string,string>){return task<{files:Record<string,string>;manifest:Manifest}>('artifacts',{generation:input,html});}
