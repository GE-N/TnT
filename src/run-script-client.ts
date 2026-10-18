import type {ScriptTrust} from '../server/run-script-contract.js';

function trustPayload(value:unknown):ScriptTrust|undefined{
  if(!value||typeof value!=='object')return;
  const trust=(value as {trust?:ScriptTrust}).trust;
  if(!trust||typeof trust.rowId!=='string'||(trust.origin!=='local'&&trust.origin!=='imported')||trust.trusted!==true||typeof trust.hash!=='string')return;
  return trust;
}

function trustList(value:unknown):ScriptTrust[]|undefined{
  if(!value||typeof value!=='object'||!Array.isArray((value as {scripts?:unknown}).scripts))return;
  const scripts=(value as {scripts:unknown[]}).scripts.flatMap(item=>{
    if(!item||typeof item!=='object')return [];
    const trust=item as ScriptTrust;
    if(typeof trust.rowId!=='string'||(trust.origin!=='local'&&trust.origin!=='imported')||typeof trust.trusted!=='boolean'||typeof trust.hash!=='string')return [];
    return [trust];
  });
  return scripts;
}

/** Trust is whatever GET /api/scripts/trust returned. Any failure leaves the caller with no grant. */
export async function pullScriptTrust(workspaceId:string,token:string):Promise<ScriptTrust[]>{
  const response=await fetch('/api/scripts/trust?workspace='+encodeURIComponent(workspaceId),{headers:{'X-TnT-Token':token}});
  const body=await response.json().catch(()=>undefined);
  const scripts=response.ok?trustList(body):undefined;
  if(!scripts)throw new Error('Script trust could not be loaded.');
  return scripts;
}

/** A 200 with the server's trust object is the only approval. 400 and every other failure throw. */
export async function approveScriptTrust(input:{workspace:string;rowId:string;hash:string;token:string}):Promise<ScriptTrust>{
  const response=await fetch('/api/scripts/trust',{method:'POST',headers:{'X-TnT-Token':input.token,'Content-Type':'application/json'},body:JSON.stringify({workspace:input.workspace,rowId:input.rowId,hash:input.hash})});
  const body=await response.json().catch(()=>undefined);
  const trust=response.ok?trustPayload(body):undefined;
  if(!trust||trust.rowId!==input.rowId||trust.hash!==input.hash)throw new Error('Script trust was not saved.');
  return trust;
}
