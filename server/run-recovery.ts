import {lstat,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {killProcess,lookupProcess,type OwnedProcess,type ProcessIdentity} from './owned-process.js';
import {assertEvidenceRoot} from './run-script-evidence.js';

export type RecoveryIO={
 /** Live identity of a PID. Undefined means that PID is not running. */
 lookup?:(pid:number)=>Promise<ProcessIdentity|undefined>;
 /** Stop one recorded PID. Tests supply this; production uses SIGTERM. */
 kill?:(pid:number)=>Promise<void>;
};
function recordedProcesses(value:unknown):OwnedProcess[]{
 if(!Array.isArray(value))return [];
 return value.flatMap(item=>{
  if(!item||typeof item!=='object')return [];
  const process=item as OwnedProcess;
  if((process.role!=='maestro'&&process.role!=='mockoon')||!Number.isSafeInteger(process.pid)||process.pid<=0||typeof process.command!=='string'||!process.command||typeof process.startedAt!=='string'||!process.startedAt)return [];
  return [process];
 });
}

/** Before accepting requests, stop recorded tool processes, then discard unfinished evidence left by a server crash. */
export async function sweepUnfinishedRuns(root:string,io:RecoveryIO={}){
 const lookup=io.lookup??lookupProcess;const kill=io.kill??killProcess;
 try{if((await lstat(root)).isSymbolicLink())throw new Error('Recovery root must not be a symlink.');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const base=await realpath(root);
 // A second server must never delete a living server's execution files.
 let owner:{pid?:number;processes?:unknown}|undefined;
 try{owner=JSON.parse(await readFile(join(base,'device-ownership.lock'),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(owner!==undefined){
  if(typeof owner?.pid!=='number'||!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw new Error('Cannot verify the existing device owner before recovery.');
  try{process.kill(owner.pid!,0);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;owner={...owner,pid:undefined};}
  if(typeof owner.pid==='number')throw new Error('Device owner is still alive; unfinished-run recovery refused.');
  // Stop only processes this server recorded, and only after the PID still matches command and start time.
  for(const process of recordedProcesses(owner.processes)){
   const current=await lookup(process.pid);
   if(!current||current.command!==process.command||current.startedAt!==process.startedAt)continue;
   await kill(process.pid);
  }
 }
 const terminal=new Set(['passed','assertion-failed','path-failed','script-error','tool-error','setup-error','handler-error','cancelled','error']);
 for(const kind of ['runs','private']){
  const directory=join(base,kind);
  try{await assertEvidenceRoot(directory);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name);
   await assertEvidenceRoot(path);
   // Finder files such as .DS_Store must not block crash recovery. Symlinks already failed above.
   if(!entry.isDirectory())continue;
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
