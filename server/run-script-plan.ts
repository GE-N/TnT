import {parseAllDocuments,stringify} from 'yaml';
import {routeVisits,visitOperations,visitScreenId} from '../shared/canvas-authoring.js';
import {referenceCatalog,type CanvasExecution,type CanvasGraph} from './canvas.js';
import type {ExecutionItem} from './default-actions.js';
import type {ScriptAnchor,ScriptBlockReason,ScriptRow,ScriptTrust,ScriptExecutionReference} from './run-script-contract.js';
import {scriptHash} from './script-trust-store.js';
import {readScriptRows} from './script-validation.js';

export type ScriptExecutionItem=ExecutionItem|{kind:'runScript';rowId:string;beforeStep:number;file:string};
export type RunPlan={executionYaml:string;scriptFiles:{name:string;content:string;rowId:string}[];executionItems:ScriptExecutionItem[];executionOrder:ScriptExecutionReference[];authoredStepMap:{index:number;executionIndex:number}[];blocked:ScriptBlockReason[]};
/** Setup/handler occurrences are system work, never authored step indexes or anchors. */
export function canvasScriptAnchors(execution:CanvasExecution|undefined):ScriptAnchor[]|undefined{
  return execution?.occurrences.filter(item=>item.reference.kind==='step').map(item=>({index:item.reference.index!,fingerprint:item.reference.fingerprint}));
}
const draftAnchorMessage='Step not captured yet · capture it before running' as const;
function anchorsScript(test:{role?:string;reference?:{kind?:string;fingerprint?:string}}|undefined){
  return !!test&&test.role!=='setup'&&test.role!=='handler'&&test.reference?.kind==='step'&&typeof test.reference.fingerprint==='string';
}
/** Visit-operation fingerprints, including an uncaptured `draft` step. Setup and handlers are not anchors. */
export function canvasOperationFingerprints(graph:CanvasGraph,pathId:string):string[]{
  const path=graph.paths.find(item=>item.id===pathId);
  if(!path?.screenId)return [];
  const steps:string[]=[];
  routeVisits(graph,path).forEach((_visit,visitIndex)=>{
    const screen=graph.screens.find(item=>item.id===visitScreenId(graph,path,visitIndex));
    for(const id of visitOperations(graph,path,visitIndex)){
      const test=screen?.tests.find(item=>item.id===id);
      if(anchorsScript(test))steps.push(test!.reference.fingerprint);
    }
  });
  return steps;
}
function targetsDraft(row:ScriptRow,steps:readonly {fingerprint:string}[]){
  const stored=row.beforeStep.fingerprint==='draft'||row.beforeStep.fingerprint==='draft:end';
  const current=row.beforeStep.index===steps.length?steps.at(-1)?.fingerprint:steps[row.beforeStep.index]?.fingerprint;
  return stored||current==='draft';
}
/** Run block for a script sitting on a step that has not been captured yet. */
export function draftAnchorBlocks(rows:readonly ScriptRow[]|undefined,graph?:CanvasGraph,pathId?:string):Extract<ScriptBlockReason,{kind:'draft-anchor'}>[]{
  if(!rows?.length)return [];
  const steps=(graph&&pathId?canvasOperationFingerprints(graph,pathId):[]).map(fingerprint=>({fingerprint}));
  return rows.filter(row=>targetsDraft(row,steps)).map(row=>({kind:'draft-anchor',rowId:row.id,message:draftAnchorMessage}));
}
/** Compile alone, never invoke. This gate prevents source escaping the wrapper's braces. */
export function checkScriptSyntax(source:string):{message:string}|undefined {
  try { new Function(source); return; }
  catch(error) { return {message:error instanceof Error?error.message:'Invalid JavaScript syntax'}; }
}
/** Materialize credentials only on our generated runScript commands, never in global flow env. */
export function scriptExecutionYaml(plan:RunPlan,env:Record<string,string>){
  const docs=parseAllDocuments(plan.executionYaml);const commands=docs[1].toJS() as any[];
  const files=new Set(plan.scriptFiles.map(file=>file.name));
  for(const command of commands)if(files.has(command?.runScript?.file))command.runScript.env={...env};
  return docs[0].toString()+'---\n'+stringify(commands,{aliasDuplicateObjects:false,lineWidth:0});
}
/** Pure composition: automation's random namespace is supplied by the caller, not allocated here.
 * Canvas anchors count visit operations; anchorSteps maps those occurrences to projected commands.
 * Other anchors refer to the script-free projected scenario (including repeated occurrences).
 */
export function buildRunPlan(input:{yaml:string;flows?:Record<string,string>;scripts?:readonly ScriptRow[];trust?:readonly ScriptTrust[];anchorSteps?:readonly ScriptAnchor[];automation?:{yaml:string;plan:ExecutionItem[]};mockAvailable?:boolean}):RunPlan {
  // Sort only this derived copy. Stable sorting preserves saved array order at each anchor.
  const rows=readScriptRows(input.scripts??[]).toSorted((a,b)=>a.beforeStep.index-b.beforeStep.index);
  const catalog=referenceCatalog(input.yaml,input.flows);
  const steps=catalog.references.filter(ref=>ref.kind==='step');
  const anchorSteps=input.anchorSteps??steps;
  const endFingerprint=anchorSteps.length?anchorSteps.at(-1)!.fingerprint+':end':'end';
  const projectedIndex=(row:ScriptRow)=>row.beforeStep.index===anchorSteps.length?steps.length:anchorSteps[row.beforeStep.index]?.index;
  const blocked:ScriptBlockReason[]=[];
  for(const row of rows){
    if(!row.source.trim())blocked.push({kind:'empty',rowId:row.id,message:'Script is empty · add code or delete the row'});
    const target=anchorSteps[row.beforeStep.index];
    const validAnchor=row.beforeStep.index===anchorSteps.length?row.beforeStep.fingerprint===endFingerprint:target?.fingerprint===row.beforeStep.fingerprint&&steps.some(ref=>ref.index===target.index&&ref.fingerprint===target.fingerprint);
    if(targetsDraft(row,anchorSteps))blocked.push({kind:'draft-anchor',rowId:row.id,message:draftAnchorMessage});
    else if(!validAnchor)blocked.push({kind:'stale-anchor',rowId:row.id,message:'Step changed · relink before running'});
    const syntax=checkScriptSyntax(row.source);
    if(syntax)blocked.push({kind:'syntax',rowId:row.id,...syntax});
    if(!input.trust?.some(trust=>trust.rowId===row.id&&trust.trusted&&trust.hash===scriptHash(row.source)))blocked.push({kind:'untrusted',rowId:row.id,message:'Script needs trust'});
  }
  const docs=parseAllDocuments(input.automation?.yaml??input.yaml);
  const commands=docs[1].toJS() as unknown[];
  const original:ExecutionItem[]=input.automation?.plan??commands.map((_,index)=>({kind:'step',index}));
  if(commands.length!==original.length)throw new Error('Execution plan does not match generated commands.');
  const executionItems:ScriptExecutionItem[]=[];const generated:unknown[]=[];const scriptFiles:RunPlan['scriptFiles']=[];const authoredStepMap:RunPlan['authoredStepMap']=[];
  function append(row:ScriptRow,index:number){
      // Never emit executable wrapper content when prelaunch validation failed.
      if(blocked.length)return;
      const name=`.tnt-script-${String(scriptFiles.length+1).padStart(4,'0')}.js`;
      scriptFiles.push({name,rowId:row.id,content:'try {\n'+row.source+'\n} catch (e) { throw new Error('+JSON.stringify('TNT_SCRIPT_FAILED row='+row.id+' ')+' + (e && e.message)) }\n'});
      generated.push({runScript:{file:name,...(input.mockAvailable?{env:{TNT_MOCK_URL:'${TNT_MOCK_URL}',TNT_MOCK_TOKEN:'${TNT_MOCK_TOKEN}'}}:{})}});
      executionItems.push({kind:'runScript',rowId:row.id,beforeStep:index,file:name});
  }
  commands.forEach((command,position)=>{
    const item=original[position];
    if(item.kind==='step')for(const row of rows.filter(row=>row.beforeStep.index<anchorSteps.length&&projectedIndex(row)===item.index)){
      append(row,item.index!);
    }
    if(item.kind==='step')authoredStepMap.push({index:item.index!,executionIndex:executionItems.length});
    executionItems.push({...item});generated.push(command);
  });
  for(const row of rows.filter(row=>row.beforeStep.index===anchorSteps.length))append(row,steps.length);
  const executionOrder:ScriptExecutionReference[]=executionItems.map(item=>{
    if(item.kind==='runScript')return {kind:'runScript',rowId:item.rowId};
    const index=item.kind==='step'?(input.anchorSteps?anchorSteps.findIndex(step=>step.index===item.index):item.index!):-1;
    return index>=0?{kind:'step',index}:{kind:'system'};
  });
  return {executionYaml:scriptFiles.length?docs[0].toString()+'---\n'+stringify(generated,{aliasDuplicateObjects:false,lineWidth:0}):input.automation?.yaml??input.yaml,scriptFiles,executionItems,executionOrder,authoredStepMap,blocked};
}
