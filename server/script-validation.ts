import {parseAllDocuments} from 'yaml';
import type {ScriptBlockReason,ScriptRow} from './run-script-contract.js';

export const RESERVED_INPUTS = ['TNT_MOCK_URL','TNT_MOCK_TOKEN'] as const;
export class ScriptBlocked extends Error {
  constructor(public readonly blocked: ScriptBlockReason[]) { super(blocked.map(item=>item.message).join('; ')); }
}
export function assertReservedInputs(value:unknown) {
  if (!value || typeof value !== 'object') return;
  const blocked:ScriptBlockReason[]=RESERVED_INPUTS.filter(key=>Object.hasOwn(value,key)).map(input=>({kind:'reserved-input',input,message:'TNT_MOCK_URL and TNT_MOCK_TOKEN are reserved by TnT.'}));
  if(blocked.length)throw new ScriptBlocked(blocked);
}
// Inspect parsed authored values, including nested env declarations and JS expressions.
// ScriptRow.source is intentionally never passed here: trusted code may use the variables.
export function assertAuthoredVariables(yaml:string) {
  const walk=(value:unknown):void=>{
    if(typeof value==='string' && /\$\{[^}]*\bTNT_MOCK_(?:URL|TOKEN)\b/s.test(value))throw new ScriptBlocked([{kind:'reserved-variable',message:'Reserved TnT variable'}]);
    if(Array.isArray(value))value.forEach(walk);
    else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){
      if(key==='env'||key==='parameters'||key==='inputs')assertReservedInputs(child);
      walk(child);
    }
  };
  for(const doc of parseAllDocuments(yaml))if(!doc.errors.length)walk(doc.toJS());
}
export function assertAutomationVariables(value:unknown):void {
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){
    if(key==='parameters'){
      assertReservedInputs(child);
      if(child&&typeof child==='object'&&Object.values(child).some(v=>typeof v==='string'&&/\$\{[^}]*\bTNT_MOCK_(?:URL|TOKEN)\b/s.test(v)))throw new ScriptBlocked([{kind:'reserved-variable',message:'Reserved TnT variable'}]);
    }else assertAutomationVariables(child);
  }
}
export function readScriptRows(value:unknown,ids=new Set<string>()):ScriptRow[]{
  if(!Array.isArray(value)||value.length>100)throw new Error('Provide up to 100 script rows per scenario.');
  return value.map(row=>{
    if(!row||typeof row!=='object'||typeof row.id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.id)||ids.has(row.id)||typeof row.label!=='string'||row.label.length>120||typeof row.source!=='string'||Buffer.byteLength(row.source)>900_000||!row.beforeStep||!Number.isSafeInteger(row.beforeStep.index)||row.beforeStep.index<0||typeof row.beforeStep.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(row.beforeStep.fingerprint))throw new Error('Script rows require workspace-wide unique safe IDs, a label, source and an index/fingerprint anchor.');
    ids.add(row.id);
    return {id:row.id,label:row.label,source:row.source,beforeStep:{index:row.beforeStep.index,fingerprint:row.beforeStep.fingerprint}};
  });
}
