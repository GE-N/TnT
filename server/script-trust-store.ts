import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,open,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {Workspace} from './scenarios.js';
import type {ScriptOrigin,ScriptRow,ScriptTrust} from './run-script-contract.js';

export class ScriptTrustConflict extends Error { constructor(){super('Script source changed. Review the current source before trusting it.');} }
/** Inactive imported row ids kept per workspace after scenario switches. Older ones are dropped first. */
export const importedTombstoneCap=128;
export const scriptHash=(source:string)=>createHash('sha256').update(source).digest('hex');
export const workspaceScripts=(workspace:Pick<Workspace,'scenarios'>):ScriptRow[]=>workspace.scenarios?.flatMap(scenario=>scenario.scripts??[])??[];
type Entry={origin:ScriptOrigin;approved?:string;scenarioId?:string};
// importedHashes is retained for on-disk v1 compatibility, never used to infer a row's origin.
// importedOverflow lists workspaces whose imported tombstones were evicted. By design this is permanent and fail-closed: every id that is not already stored in that workspace registers as imported and untrusted, including a brand-new editor row.
type State={format:1;workspaces:Record<string,Record<string,Entry>>;importedHashes:string[];importedOverflow?:string[]};
const queues=new Map<string,Promise<unknown>>();
/** Machine-local only. Loss of provenance defaults existing rows to imported, never to local. */
export function createScriptTrustStore(directory:string,faults?:{beforeList?:()=>Promise<void>}){
 const key=resolve(directory);
 function serialize<T>(fn:()=>Promise<T>):Promise<T>{const next=(queues.get(key)??Promise.resolve()).then(fn);const done=next.catch(()=>{});queues.set(key,done);void done.then(()=>{if(queues.get(key)===done)queues.delete(key);});return next;}
 async function read():Promise<State>{
  try{
   const value=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
   if(value?.format!==1||!value.workspaces||typeof value.workspaces!=='object'||Array.isArray(value.workspaces)||!Array.isArray(value.importedHashes)||value.importedHashes.some((hash:unknown)=>typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))||(value.importedOverflow!==undefined&&(!Array.isArray(value.importedOverflow)||value.importedOverflow.some((id:unknown)=>typeof id!=='string'||!id))))throw new Error();
   for(const rows of Object.values(value.workspaces) as Record<string,Entry>[])for(const entry of Object.values(rows))if(!entry||!['local','imported'].includes(entry.origin)||(entry.approved!==undefined&&!/^[a-f0-9]{64}$/.test(entry.approved))||(entry.scenarioId!==undefined&&typeof entry.scenarioId!=='string'))throw new Error();
   return value;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {format:1,workspaces:{},importedHashes:[]};throw new Error('Script trust state is unreadable. Restore the local trust store before running scripts.');}
 }
 async function write(state:State){
  await mkdir(directory,{recursive:true,mode:0o700});
  const temporary=join(directory,randomUUID()+'.tmp');let handle;
  try{handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(state));await handle.sync();await handle.close();handle=undefined;await rename(temporary,join(directory,'state.json'));
   const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}
  }finally{await handle?.close();await rm(temporary,{force:true});}
 }
 function decisions(state:State,workspace:Pick<Workspace,'id'|'scenarios'>):ScriptTrust[]{return workspaceScripts(workspace).map(row=>{const entries=state.workspaces[workspace.id];const entry=entries&&Object.hasOwn(entries,row.id)?entries[row.id]:undefined;const hash=scriptHash(row.source);return {rowId:row.id,origin:entry?.origin??'imported',trusted:entry?.origin==='local'||entry?.approved===hash,hash};});}
 function trimImportedTombstones(state:State,workspaceId:string,active:Set<string>){
  const entries=state.workspaces[workspaceId];if(!entries)return false;
  const tombstones=Object.keys(entries).filter(id=>entries[id].origin==='imported'&&!active.has(id));
  let changed=false;
  while(tombstones.length>importedTombstoneCap){
   delete entries[tombstones.shift()!];changed=true;
   const overflow=state.importedOverflow??(state.importedOverflow=[]);
   if(!overflow.includes(workspaceId))overflow.push(workspaceId);
  }
  return changed;
 }
 return {
  list:(workspace:Pick<Workspace,'id'|'scenarios'>)=>serialize(async()=>{await faults?.beforeList?.();return workspaceScripts(workspace).length?decisions(await read(),workspace):[];}),
  register:(workspace:Workspace,previous?:Workspace,origins?:Record<string,ScriptOrigin>)=>serialize(async()=>{
   const rows=workspaceScripts(workspace);if(!rows.length&&!workspaceScripts(previous??{}).length)return;
   const state=await read();const entries=state.workspaces[workspace.id]??={};const oldRows=workspaceScripts(previous??{});const oldIds=new Set(oldRows.map(row=>row.id));const nextIds=new Set(rows.map(row=>row.id));const overflow=state.importedOverflow?.includes(workspace.id)??false;
   // Only imports removed in this transaction can carry origin to a replacement ID.
   // Older tombstones and matching text elsewhere must not classify an editor-created row.
   const removedImportedHashes=new Set(oldRows.filter(row=>!nextIds.has(row.id)&&(!Object.hasOwn(entries,row.id)||entries[row.id].origin==='imported')).map(row=>scriptHash(row.source)));
   // Associate legacy entries before removal, so only the closed scenario's tombstones retire.
   for(const scenario of previous?.scenarios??[])for(const row of scenario.scripts??[])if(Object.hasOwn(entries,row.id))entries[row.id].scenarioId=scenario.id;
   for(const scenario of workspace.scenarios??[])for(const row of scenario.scripts??[]){
    // Entries survive deletion as durable Undo tombstones. An existing row ID
    // keeps its origin; imported approvals still require the current source hash.
    if(!Object.hasOwn(entries,row.id))entries[row.id]={origin:origins&&Object.hasOwn(origins,row.id)?origins[row.id]:oldIds.has(row.id)||removedImportedHashes.has(scriptHash(row.source))||overflow?'imported':'local'};
    entries[row.id].scenarioId=scenario.id;
   }
   trimImportedTombstones(state,workspace.id,nextIds);
   await write(state);
  }),
  closeScenario:(workspace:Workspace,scenarioId:string)=>serialize(async()=>{
   const state=await read();const entries=state.workspaces[workspace.id];if(!entries)return;
   const active=new Set(workspaceScripts(workspace).map(row=>row.id));let changed=false;
   // Local Undo ends with the scenario. Imported ids stay, so a returning draft fails closed.
   for(const [id,entry] of Object.entries(entries))if(entry.scenarioId===scenarioId&&!active.has(id)&&entry.origin!=='imported'){delete entries[id];changed=true;}
   if(trimImportedTombstones(state,workspace.id,active))changed=true;
   if(changed)await write(state);
  }),
  approve:(workspace:Workspace,rowId:string,hash:string)=>serialize(async()=>{
   const row=workspaceScripts(workspace).find(row=>row.id===rowId);
   if(!row)throw new Error('Unknown script row.');
   if(hash!==scriptHash(row.source))throw new ScriptTrustConflict();
   const state=await read();const entries=state.workspaces[workspace.id]??={};if(!Object.hasOwn(entries,rowId))entries[rowId]={origin:'imported'};entries[rowId].approved=hash;await write(state);
   return decisions(state,workspace).find(item=>item.rowId===rowId)!;
  }),
 };
}
