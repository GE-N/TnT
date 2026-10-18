import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,open,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {Workspace} from './scenarios.js';
import type {ScriptOrigin,ScriptRow,ScriptTrust} from './run-script-contract.js';

export class ScriptTrustConflict extends Error { constructor(){super('Script source changed. Review the current source before trusting it.');} }
export const scriptHash=(source:string)=>createHash('sha256').update(source).digest('hex');
export const workspaceScripts=(workspace:Pick<Workspace,'scenarios'>):ScriptRow[]=>workspace.scenarios?.flatMap(scenario=>scenario.scripts??[])??[];
type Entry={origin:ScriptOrigin;approved?:string};
type State={format:1;workspaces:Record<string,Record<string,Entry>>;importedHashes:string[]};
const queues=new Map<string,Promise<unknown>>();
/** Machine-local only. Loss of provenance defaults existing rows to imported, never to local. */
export function createScriptTrustStore(directory:string){
 const key=resolve(directory);
 function serialize<T>(fn:()=>Promise<T>):Promise<T>{const next=(queues.get(key)??Promise.resolve()).then(fn);const done=next.catch(()=>{});queues.set(key,done);void done.then(()=>{if(queues.get(key)===done)queues.delete(key);});return next;}
 async function read():Promise<State>{
  try{
   const value=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
   if(value?.format!==1||!value.workspaces||typeof value.workspaces!=='object'||Array.isArray(value.workspaces)||!Array.isArray(value.importedHashes)||value.importedHashes.some((hash:unknown)=>typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))throw new Error();
   for(const rows of Object.values(value.workspaces) as Record<string,Entry>[])for(const entry of Object.values(rows))if(!entry||!['local','imported'].includes(entry.origin)||(entry.approved!==undefined&&!/^[a-f0-9]{64}$/.test(entry.approved)))throw new Error();
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
 return {
  list:(workspace:Pick<Workspace,'id'|'scenarios'>)=>serialize(async()=>workspaceScripts(workspace).length?decisions(await read(),workspace):[]),
  register:(workspace:Workspace,previous?:Workspace,origins?:Record<string,ScriptOrigin>)=>serialize(async()=>{
   const rows=workspaceScripts(workspace);if(!rows.length)return;
   const state=await read();const entries=state.workspaces[workspace.id]??={};const oldIds=new Set(previous?workspaceScripts(previous).map(row=>row.id):[]);
   for(const row of rows){
    const hash=scriptHash(row.source);
    const knownImport=state.importedHashes.includes(hash);
    if(!Object.hasOwn(entries,row.id))entries[row.id]={origin:origins&&Object.hasOwn(origins,row.id)?origins[row.id]:knownImport||oldIds.has(row.id)?'imported':'local'};
    else if(entries[row.id].origin==='local'&&knownImport&&previous&&workspaceScripts(previous).find(old=>old.id===row.id)?.source!==row.source)entries[row.id]={origin:'imported'};
    if(entries[row.id].origin==='imported'&&!state.importedHashes.includes(hash))state.importedHashes.push(hash);
   }
   await write(state);
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
