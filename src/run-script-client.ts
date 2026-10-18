import type {ScriptAnchor,ScriptOrigin,ScriptTrust} from '../server/run-script-contract.js';
import {moveScript,sha256,type ScriptRecord} from './run-script.js';

type State={workspaceId:string;scripts:ScriptRecord[];trust:ScriptTrust[]};
let state:State={workspaceId:'',scripts:[],trust:[]};
const listeners=new Set<()=>void>();

function emit(){state={...state,scripts:state.scripts.slice(),trust:state.trust.slice()};for(const listener of listeners)listener();}

export function subscribeRunScripts(listener:()=>void){listeners.add(listener);return ()=>listeners.delete(listener);}
export function getRunScriptSnapshot(){return state;}

export function resetRunScripts(workspaceId=''){state={workspaceId,scripts:[],trust:[]};emit();}

export function scriptsFor(scenarioId:string){return state.scripts.filter(item=>item.scenarioId===scenarioId);}

export function addStoredScript(scenarioId:string,anchor:ScriptAnchor){
  const id=crypto.randomUUID();
  const source='';
  const hash=sha256(source);
  const row:ScriptRecord={id,scenarioId,origin:'local',beforeStep:anchor,label:'Run script',source,hash};
  state.scripts=[...state.scripts,row];
  state.trust=[...state.trust,{rowId:id,origin:'local',trusted:true,hash}];
  emit();
  return id;
}

export function updateStoredScript(rowId:string,patch:{label?:string;source?:string}){
  state.scripts=state.scripts.map(item=>{
    if(item.id!==rowId)return item;
    const source=patch.source??item.source;
    return {...item,label:patch.label??item.label,source,hash:sha256(source)};
  });
  emit();
}

export function replaceStoredScripts(rows:ScriptRecord[]){state.scripts=rows;emit();}

export function moveStoredScript(rowId:string,direction:-1|1,stepCount:number,fingerprintAt:(index:number)=>string){
  const next=moveScript(state.scripts,rowId,direction,stepCount,fingerprintAt);
  if(!next)return;
  state.scripts=next;
  emit();
}

export function deleteStoredScript(rowId:string){
  state.scripts=state.scripts.filter(item=>item.id!==rowId);
  state.trust=state.trust.filter(item=>item.rowId!==rowId);
  emit();
}

export function copyStoredScripts(fromScenario:string,toScenario:string){
  const copies=state.scripts.filter(item=>item.scenarioId===fromScenario).map(item=>{
    const id=crypto.randomUUID();
    return {row:{...item,id,scenarioId:toScenario},trust:item.origin==='local'?{rowId:id,origin:'local' as const,trusted:true,hash:item.hash}:undefined};
  });
  state.scripts=[...state.scripts,...copies.map(item=>item.row)];
  state.trust=[...state.trust,...copies.flatMap(item=>item.trust?[item.trust]:[])];
  emit();
}

export function takeStoredScripts(scenarioId:string){
  const taken=state.scripts.filter(item=>item.scenarioId===scenarioId);
  const ids=new Set(taken.map(item=>item.id));
  const trust=state.trust.filter(item=>ids.has(item.rowId));
  state.scripts=state.scripts.filter(item=>item.scenarioId!==scenarioId);
  state.trust=state.trust.filter(item=>!ids.has(item.rowId));
  emit();
  return {scripts:taken,trust};
}

export function restoreStoredScripts(scripts:ScriptRecord[],trust:ScriptTrust[]){
  const ids=new Set(state.scripts.map(item=>item.id));
  state.scripts=[...state.scripts,...scripts.filter(item=>!ids.has(item.id))];
  const known=new Set(state.trust.map(item=>item.rowId));
  state.trust=[...state.trust,...trust.filter(item=>!known.has(item.rowId))];
  emit();
}

function remember(trust:ScriptTrust){
  state.trust=[...state.trust.filter(item=>item.rowId!==trust.rowId),trust];
  emit();
}

export function seedImportedScript(scenarioId:string,row:Omit<ScriptRecord,'scenarioId'|'origin'|'hash'> & {source:string}){
  const hash=sha256(row.source);
  const stored:ScriptRecord={...row,scenarioId,origin:'imported',hash};
  state.scripts=[...state.scripts.filter(item=>item.id!==row.id),stored];
  state.trust=[...state.trust.filter(item=>item.rowId!==row.id),{rowId:row.id,origin:'imported',trusted:false,hash}];
  emit();
  return stored;
}

export function hydrateScenarioScripts(scenarioId:string,value:unknown,origin:ScriptOrigin){
  if(!Array.isArray(value))return;
  for(const item of value){
    if(!item||typeof item!=='object')continue;
    const row=item as {id?:unknown;label?:unknown;source?:unknown;beforeStep?:{index?:unknown;fingerprint?:unknown}};
    if(typeof row.id!=='string'||typeof row.label!=='string'||typeof row.source!=='string')continue;
    if(!row.beforeStep||typeof row.beforeStep.index!=='number'||typeof row.beforeStep.fingerprint!=='string')continue;
    const hash=sha256(row.source);
    state.scripts.push({id:row.id,scenarioId,origin,label:row.label,source:row.source,hash,beforeStep:{index:row.beforeStep.index,fingerprint:row.beforeStep.fingerprint}});
    state.trust.push(origin==='local'?{rowId:row.id,origin,trusted:true,hash}:{rowId:row.id,origin:'imported',trusted:false,hash});
  }
  emit();
}

function trustPayload(value:unknown):ScriptTrust|undefined{
  if(!value||typeof value!=='object')return;
  const trust=(value as {trust?:ScriptTrust}).trust;
  if(!trust||typeof trust.rowId!=='string'||(trust.origin!=='local'&&trust.origin!=='imported')||typeof trust.trusted!=='boolean'||typeof trust.hash!=='string')return;
  return trust;
}

/** Talks to PR A's trust API. A missing route keeps the approval in this session only. */
export async function approveScriptTrust(input:{workspace:string;rowId:string;hash:string;token:string}){
  try{
    const response=await fetch('/api/scripts/trust',{method:'POST',headers:{'X-TnT-Token':input.token,'Content-Type':'application/json'},body:JSON.stringify({workspace:input.workspace,rowId:input.rowId,hash:input.hash})});
    const body=await response.json().catch(()=>undefined);
    const trust=trustPayload(body);
    if(response.ok&&trust){remember(trust);return trust;}
    if(response.status===409)return;
    if(response.ok||response.status===404||response.status===400||response.status===405){
      const local:ScriptTrust={rowId:input.rowId,origin:'imported',trusted:true,hash:input.hash};
      remember(local);
      return local;
    }
  }catch{/* The engine route is not available yet. */}
  const local:ScriptTrust={rowId:input.rowId,origin:'imported',trusted:true,hash:input.hash};
  remember(local);
  return local;
}

export async function pullScriptTrust(workspaceId:string,token:string){
  if(!workspaceId||!token)return;
  try{
    const response=await fetch('/api/scripts/trust?workspace='+encodeURIComponent(workspaceId),{headers:{'X-TnT-Token':token}});
    if(!response.ok)return;
    const body=await response.json();
    if(!body||!Array.isArray(body.scripts))return;
    const scripts=body.scripts.filter((item:ScriptTrust)=>item&&typeof item.rowId==='string'&&typeof item.hash==='string');
    state.trust=scripts;
    emit();
  }catch{/* Stub until the engine PR lands. */}
}
