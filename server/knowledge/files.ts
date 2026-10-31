import {lstat,mkdir,open,readFile,realpath,rename,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {RootGuard} from './types.js';

const absent=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
/** Never follow a generated/sidecar subpath symlink, including an existing file. */
export async function safeDirectory(root:string,parts:string[],guard:RootGuard,create=false){
 const base=await realpath(root);let directory=base;
 for(const part of parts){
  if(!part||part==='.'||part==='..'||/[\\/\0]/.test(part))throw new Error('Unsafe knowledge path.');
  directory=join(directory,part);
  try{const entry=await lstat(directory);if(entry.isSymbolicLink()||!entry.isDirectory())throw new Error('Unsafe knowledge directory.');}
  catch(error){if(!create||!absent(error))throw error;guard.assertOwned();await mkdir(directory);guard.assertOwned();await syncDirectory(join(directory,'..'));}
  if(!(await realpath(directory)).startsWith(base+sep))throw new Error('Knowledge path escapes its root.');
 }
 return directory;
}
export async function safeFile(directory:string,name:string){
 if(!name||name==='.'||name==='..'||/[\\/\0]/.test(name))throw new Error('Unsafe knowledge filename.');
 const path=join(directory,name);
 try{const entry=await lstat(path);if(entry.isSymbolicLink()||!entry.isFile())throw new Error('Unsafe knowledge file.');}catch(error){if(!absent(error))throw error;}
 return path;
}
export async function readSafe(directory:string,name:string){return readFile(await safeFile(directory,name),'utf8');}
export async function syncDirectory(directory:string){const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
export async function atomicWrite(directory:string,name:string,text:string,guard:RootGuard,beforeRename?:()=>Promise<void>){
 const path=await safeFile(directory,name);const temporary=path+'.'+randomUUID()+'.tmp';
 guard.assertOwned();const handle=await open(temporary,'wx',0o600);
 try{
  guard.assertOwned();await handle.writeFile(text);guard.assertOwned();await handle.sync();await handle.close();
  await beforeRename?.();guard.assertOwned();await rename(temporary,path);guard.assertOwned();await syncDirectory(directory);
 }catch(error){await handle.close().catch(()=>{});try{guard.assertOwned();await rm(temporary,{force:true});}catch{/* Preserve the original failure; an unowned writer does no cleanup. */}throw error;}
 return path;
}
export function relativeParts(path:string){
 if(typeof path!=='string'||path.includes('\\')||path.includes('\0')||resolve('/',path)!=='/'+path||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe generation artifact path.');
 return path.split('/');
}
