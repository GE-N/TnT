import {lstat,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {assertEvidenceRoot} from './run-script-evidence.js';

/** Before accepting requests, discard unfinished evidence left by a server crash. */
export async function sweepUnfinishedRuns(root:string){
 try{if((await lstat(root)).isSymbolicLink())throw new Error('Recovery root must not be a symlink.');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const base=await realpath(root);
 // A second server must never delete a living server's execution files.
 let owner:{pid?:number}|undefined;
 try{owner=JSON.parse(await readFile(join(base,'device-ownership.lock'),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(owner!==undefined){
  if(typeof owner?.pid!=='number'||!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw new Error('Cannot verify the existing device owner before recovery.');
  try{process.kill(owner.pid!,0);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;owner=undefined;}
  if(owner)throw new Error('Device owner is still alive; unfinished-run recovery refused.');
 }
 const terminal=new Set(['passed','assertion-failed','path-failed','script-error','tool-error','setup-error','handler-error','cancelled','error']);
 for(const kind of ['runs','private']){
  const directory=join(base,kind);
  try{await assertEvidenceRoot(directory);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name);
   await assertEvidenceRoot(path);
   if(!entry.isDirectory())throw new Error('Unexpected recovery entry.');
   if(kind==='runs'){
    let status:unknown;
    try{
     const result=join(path,'result.json');
     if((await lstat(result)).isSymbolicLink())throw new Error('Recovery result must not be a symlink.');
     status=JSON.parse(await readFile(result,'utf8'))?.status;
    }
    catch(error){if(!(error instanceof SyntaxError)&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(typeof status==='string'&&terminal.has(status))continue;
   }
   // Token is no longer available to scrub partial metadata. Remove the whole tree.
   // Confidential temporary trees are never retained, even after a terminal result.
   await rm(path,{recursive:true,force:true});
  }
 }
 // Deliberately retain device-ownership.lock: surviving children still require recovery.
}
