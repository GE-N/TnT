import {lstat,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {killProcess,lookupProcess,ownerAlive as probeOwner,sameOwnedProcess,type OwnedProcess,type ProcessIdentity} from './owned-process.js';
import {assertEvidenceRoot} from './run-script-evidence.js';

export type RecoveryIO={
 /** Live identity of a PID. Undefined means that PID is not running. */
 lookup?:(pid:number)=>Promise<ProcessIdentity|undefined>;
 /** Signal a PID, or a process group when the PID is negative. */
 kill?:(pid:number,signal:NodeJS.Signals)=>Promise<void>;
 /** True when the server owner PID is still alive. */
 ownerAlive?:(pid:number)=>boolean;
 pause?:(ms:number)=>Promise<void>;
 /** How long to wait after SIGTERM before SIGKILL, and after SIGKILL before giving up. */
 graceMs?:number;
 pollMs?:number;
};
const settlingLock=/^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/i;
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
 const lookup=io.lookup??lookupProcess;const kill=io.kill??killProcess;const alive=io.ownerAlive??probeOwner;const pause=io.pause??delay;
 const graceMs=io.graceMs??2_000;const pollMs=io.pollMs??50;
 try{if((await lstat(root)).isSymbolicLink())throw new Error('Recovery root must not be a symlink.');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const base=await realpath(root);
 // A second server must never delete a living server's execution files.
 let owner:{pid?:number;processes?:unknown}|undefined;
 try{owner=JSON.parse(await readFile(join(base,'device-ownership.lock'),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 // Release the lock only after every recorded tool process is confirmed gone.
 let releaseLock=false;
 if(owner!==undefined){
  if(typeof owner?.pid!=='number'||!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw new Error('Cannot verify the existing device owner before recovery.');
  if(alive(owner.pid!))throw new Error('Device owner is still alive; unfinished-run recovery refused.');
  const recorded=recordedProcesses(owner.processes);
  for(const process of recorded)await stopRecorded(process);
  releaseLock=recorded.length>0;
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
 const names=await readdir(base).catch(()=>[] as string[]);
 await Promise.all(names.filter(name=>settlingLock.test(name)).map(name=>rm(join(base,name),{force:true})));
 if(releaseLock)await rm(join(base,'device-ownership.lock'),{force:true});

 async function stopRecorded(process:OwnedProcess){
  const matches=async()=>{const current=await lookup(process.pid);return !!current&&sameOwnedProcess(process,current);};
  if(!(await matches()))return;
  await kill(-process.pid,'SIGTERM');
  const deadline=Date.now()+graceMs;
  while(await matches()){
   if(Date.now()>=deadline){await kill(-process.pid,'SIGKILL');break;}
   await pause(pollMs);
  }
  const killDeadline=Date.now()+graceMs;
  while(await matches()){
   if(Date.now()>=killDeadline)throw new Error('Recorded tool process is still running; unfinished-run recovery refused.');
   await pause(pollMs);
  }
 }
}
