import {parseAllDocuments,stringify} from 'yaml';
import {referenceCatalog} from './canvas.js';
import type {ExecutionItem} from './default-actions.js';
import type {ScriptBlockReason,ScriptRow,ScriptTrust} from './run-script-contract.js';
import {scriptHash} from './script-trust-store.js';
import {readScriptRows} from './script-validation.js';

export type ScriptExecutionItem=ExecutionItem|{kind:'runScript';rowId:string;beforeStep:number;file:string};
export type RunPlan={executionYaml:string;scriptFiles:{name:string;content:string;rowId:string}[];executionItems:ScriptExecutionItem[];authoredStepMap:{index:number;executionIndex:number}[];blocked:ScriptBlockReason[]};
/** Compile alone, never invoke. This gate prevents source escaping the wrapper's braces. */
export function checkScriptSyntax(source:string):{message:string}|undefined {
  try { new Function(source); return; }
  catch(error) { return {message:error instanceof Error?error.message:'Invalid JavaScript syntax'}; }
}
/** Pure composition: automation's random namespace is supplied by the caller, not allocated here.
 * Anchors refer to the script-free projected scenario (including repeated occurrences).
 */
export function buildRunPlan(input:{yaml:string;flows?:Record<string,string>;scripts?:readonly ScriptRow[];trust?:readonly ScriptTrust[];automation?:{yaml:string;plan:ExecutionItem[]};mockAvailable?:boolean}):RunPlan {
  // Sort only this derived copy. Stable sorting preserves saved array order at each anchor.
  const rows=readScriptRows(input.scripts??[]).toSorted((a,b)=>a.beforeStep.index-b.beforeStep.index);
  const catalog=referenceCatalog(input.yaml,input.flows);
  const steps=catalog.references.filter(ref=>ref.kind==='step');
  const endFingerprint=steps.length?steps.at(-1)!.fingerprint+':end':'end';
  const blocked:ScriptBlockReason[]=[];
  for(const row of rows){
    if(!row.source.trim())blocked.push({kind:'empty',rowId:row.id,message:'Script is empty · add code or delete the row'});
    const validAnchor=row.beforeStep.index===steps.length?row.beforeStep.fingerprint===endFingerprint:steps.some(ref=>ref.index===row.beforeStep.index&&ref.fingerprint===row.beforeStep.fingerprint);
    if(!validAnchor)blocked.push({kind:'stale-anchor',rowId:row.id,message:'Step changed · relink before running'});
    const syntax=checkScriptSyntax(row.source);
    if(syntax)blocked.push({kind:'syntax',rowId:row.id,...syntax});
    if(!input.trust?.some(trust=>trust.rowId===row.id&&trust.trusted&&(trust.origin==='local'||trust.hash===scriptHash(row.source))))blocked.push({kind:'untrusted',rowId:row.id,message:'Script needs trust'});
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
    if(item.kind==='step')for(const row of rows.filter(row=>row.beforeStep.index===item.index)){
      append(row,item.index!);
    }
    if(item.kind==='step')authoredStepMap.push({index:item.index!,executionIndex:executionItems.length});
    executionItems.push({...item});generated.push(command);
  });
  for(const row of rows.filter(row=>row.beforeStep.index===steps.length))append(row,steps.length);
  return {executionYaml:scriptFiles.length?docs[0].toString()+'---\n'+stringify(generated,{aliasDuplicateObjects:false,lineWidth:0}):input.automation?.yaml??input.yaml,scriptFiles,executionItems,authoredStepMap,blocked};
}
