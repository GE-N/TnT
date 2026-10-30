import {parentPort,workerData} from 'node:worker_threads';
import {tsImport} from 'tsx/esm/api';

try {
 const {operation,input}=workerData;
 let value;
 if(operation==='project'){
  const {makeDetail}=await tsImport(new URL('./projection.ts',import.meta.url).href,import.meta.url);
  value=(input.workspace.scenarios??[]).map(scenario=>makeDetail(input.workspace,scenario,input.contexts[scenario.id],input.runs));
 }else if(operation==='artifacts'){
  const {buildArtifacts}=await tsImport(new URL('./artifacts.ts',import.meta.url).href,import.meta.url);
  value=await buildArtifacts(input.generation,()=>input.html);
 }else throw new Error('Unknown knowledge indexing task.');
 parentPort.postMessage({value});
}catch(error){parentPort.postMessage({error:error instanceof Error?error.message:'Knowledge indexing worker failed.'});}
