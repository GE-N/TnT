import {mkdir,readFile,readdir,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Workspace} from './scenarios.js';

export type WorkspaceMetadata={createdAt:string;updatedAt:string;openedAt:string;revision:number};
export type WorkspaceSummary=WorkspaceMetadata & {id:string;name:string;screens:number;scenarios:number};
export type WorkspaceLibrary={items:WorkspaceSummary[];unreadable:number};
// Legacy records use indented JSON and can include derived diagnostics.
const recordLimit=16_000_000;
const validId=(id:string)=>{if(typeof id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new Error('Invalid workspace identifier.');return id;};

/** The existing local workspace records, with serialized atomic metadata/content writes. */
export function createWorkspaceStore(root:string,readContent:(value:Workspace)=>Workspace){
 let pending:Promise<unknown>=Promise.resolve();
 function serialize<T>(operation:()=>Promise<T>):Promise<T>{const next=pending.then(operation);pending=next.catch(()=>{});return next;}
 async function base(){const path=resolve(root,'workspaces');await mkdir(path,{recursive:true});if(!(await realpath(path)).startsWith((await realpath(root))+sep))throw new Error('Workspace path escapes its root.');return path;}
 async function file(id:string,create=false){
  const parent=await base();const directory=join(parent,validId(id));if(create)await mkdir(directory,{recursive:true});
  if(!(await realpath(directory)).startsWith((await realpath(parent))+sep))throw new Error('Workspace path escapes its root.');
  const path=join(directory,'workspace.json');
  try{if(!(await realpath(path)).startsWith((await realpath(directory))+sep))throw new Error('Record path escapes its workspace.');}catch(error){if(!create||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return path;
 }
 async function read(id:string):Promise<Workspace>{
  const path=await file(id);const dates=await stat(path);if(dates.size>recordLimit)throw new Error('Workspace record exceeds the supported size.');const raw=JSON.parse(await readFile(path,'utf8'));
  if(!raw||raw.id!==id)throw new Error('Unreadable workspace identity.');
  const content=readContent(raw);
  const date=(value:unknown,fallback:string)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:fallback;
  const metadata:WorkspaceMetadata={createdAt:date(raw.metadata?.createdAt,dates.birthtime.toISOString()),updatedAt:date(raw.metadata?.updatedAt,dates.mtime.toISOString()),openedAt:date(raw.metadata?.openedAt,dates.birthtime.toISOString()),revision:Number.isSafeInteger(raw.metadata?.revision)&&raw.metadata.revision>=0?raw.metadata.revision:0};
  return {...content,metadata};
 }
 async function write(value:Workspace){const path=await file(value.id,true);const temporary=path+'.'+randomUUID()+'.tmp';const encoded=JSON.stringify({...value,canvasDiagnostics:undefined});if(Buffer.byteLength(encoded)>recordLimit)throw new Error('Workspace record exceeds the supported size.');try{await writeFile(temporary,encoded);await rename(temporary,path);return value;}finally{await rm(temporary,{force:true});}}
 return {
  read:(id:string)=>serialize(()=>read(id)),
  save:(content:Workspace)=>serialize(async()=>{
   const previous=content.id?await read(content.id):undefined;
   const now=new Date().toISOString();
   return write({...content,id:content.id||randomUUID(),metadata:{createdAt:previous?.metadata?.createdAt??now,updatedAt:now,openedAt:previous?.metadata?.openedAt??now,revision:(previous?.metadata?.revision??0)+1}});
  }),
  open:(id:string)=>serialize(async()=>{const value=await read(id);return write({...value,metadata:{...value.metadata!,openedAt:new Date().toISOString()}});}),
  rename:(id:string,name:string)=>serialize(async()=>{if(typeof name!=='string'||!name.trim()||name.trim().length>120)throw new Error('Use a workspace title of 1–120 characters.');const value=await read(id);return write({...value,name:name.trim(),metadata:{...value.metadata!,updatedAt:new Date().toISOString(),revision:value.metadata!.revision+1}});}),
  list:(query=''):Promise<WorkspaceLibrary>=>serialize(async()=>{
   const items:WorkspaceSummary[]=[];let unreadable=0;
   for(const entry of await readdir(await base(),{withFileTypes:true})){
    if(!/^[0-9a-f-]{36}$/.test(entry.name))continue;
    try{const value=await read(entry.name);if(value.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()))items.push({id:value.id,name:value.name,...value.metadata!,screens:value.canvas?.screens.length??0,scenarios:value.scenarios?.length??0});}catch{unreadable++;}
   }
   items.sort((a,b)=>b.openedAt.localeCompare(a.openedAt)||a.id.localeCompare(b.id));return {items,unreadable};
  }),
 };
}
