import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

const ps=promisify(execFile);

export type OwnedProcess={role:'maestro'|'mockoon';pid:number;command:string;startedAt:string};
export type ProcessIdentity={command:string;startedAt:string};
const lstart=/^([A-Za-z]{3} [A-Za-z]{3} [ 0-9]\d [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})\s+([\s\S]+)$/;

/** Maestro's shell script execs java on the same PID. The command changes; the start time does not. */
export function isMaestroLauncher(command:string){return /(?:^|\/)(?:sh|bash|zsh)\b/.test(command)&&/maestro/.test(command);}
export function isMaestroRuntime(command:string){return command.includes('maestro.cli.AppKt');}
export function sameOwnedProcess(recorded:OwnedProcess,current:ProcessIdentity){
 if(current.startedAt!==recorded.startedAt)return false;
 if(current.command===recorded.command)return true;
 return recorded.role==='maestro'&&isMaestroLauncher(recorded.command)&&isMaestroRuntime(current.command);
}

/** Identity of a live PID. Undefined means the PID is not running. Any other ps failure names the reason and is not treated as gone. */
export async function lookupProcess(pid:number,run:typeof ps=ps):Promise<ProcessIdentity|undefined>{
 if(!Number.isSafeInteger(pid)||pid<=0)return;
 try{
  const {stdout}=await run('ps',['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:2000,env:{...process.env,LC_ALL:'C',LANG:'C'}});
  const match=lstart.exec(String(stdout??'').trim());
  if(!match)return;
  return {startedAt:match[1],command:match[2].trim()};
 }catch(error){
  if((error as {code?:string|number}).code===1)return;
  const reason=error instanceof Error?error.message:String(error);
  throw new Error('Cannot identify process '+pid+' before recovery: '+reason);
 }
}

/** Signal one PID or, when negative, its process group. An already-exited PID is not a failure. */
export async function killProcess(pid:number,signal:NodeJS.Signals='SIGTERM'){
 try{process.kill(pid,signal);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
}

/** True when a server owner PID is still alive. */
export function ownerAlive(pid:number){
 try{process.kill(pid,0);return true;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}
}

/** True while any process remains in this process group, including a child that ignored SIGTERM. A dying group can report EPERM for signal 0; that is still alive until ESRCH. */
export async function groupAlive(pid:number){
 try{process.kill(-pid,0);return true;}
 catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='ESRCH')return false;if(code==='EPERM')return true;throw error;}
}

async function updateLock(root:string,mutate:(current:Record<string,unknown>)=>void){
 const path=join(root,'device-ownership.lock');
 let current:Record<string,unknown>;
 try{current=JSON.parse(await readFile(path,'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(!current||typeof current!=='object'||Array.isArray(current))return;
 mutate(current);
 const temporary=join(root,'.'+randomUUID()+'.lock');
 let pending=true;
 try{await writeFile(temporary,JSON.stringify(current),{mode:0o600});await rename(temporary,path);pending=false;}
 finally{if(pending)await rm(temporary,{force:true});}
}

/** Remember that a tool is about to start, before its process can exec. Recovery keeps the lock until this role is recorded. */
export async function markToolStarted(root:string,role:OwnedProcess['role']){
 await updateLock(root,current=>{
  const started=Array.isArray(current.started)?current.started.filter((item):item is OwnedProcess['role']=>item==='maestro'||item==='mockoon'):[];
  started.push(role);
  current.started=started;
 });
}

/** Drop one start mark when spawn fails, so a tool that never launched does not block recovery. */
export async function clearToolStarted(root:string,role:OwnedProcess['role']){
 await updateLock(root,current=>{
  if(!Array.isArray(current.started))return;
  const index=current.started.findIndex(item=>item===role);
  if(index>=0)current.started.splice(index,1);
 });
}

/** Append or replace a TnT-spawned Maestro or Mockoon process in the device-ownership lock. */
export async function recordOwnedProcess(root:string,process:OwnedProcess){
 await updateLock(root,current=>{
  const processes=Array.isArray(current.processes)?current.processes.filter(item=>item&&typeof item==='object'):[];
  const index=processes.findIndex((item:OwnedProcess)=>item.pid===process.pid&&item.role===process.role);
  if(index<0)processes.push(process);else processes[index]=process;
  current.processes=processes;
 });
}

/** Record the launcher PID immediately, then update the command if Maestro execs java on that same PID. */
export async function recordSettledProcess(root:string,role:OwnedProcess['role'],pid:number,io:{lookup?:typeof lookupProcess;pause?:(ms:number)=>Promise<void>;settleMs?:number}={}){
 const lookup=io.lookup??lookupProcess;const pause=io.pause??delay;const deadline=Date.now()+(io.settleMs??2_000);
 const identity=await lookup(pid);
 if(!identity)return;
 await recordOwnedProcess(root,{role,pid,command:identity.command,startedAt:identity.startedAt});
 let current=identity;
 while(role==='maestro'&&isMaestroLauncher(current.command)&&Date.now()<deadline){
  await pause(50);
  const next=await lookup(pid);
  if(!next)return;
  current=next;
 }
 if(current.command!==identity.command||current.startedAt!==identity.startedAt)await recordOwnedProcess(root,{role,pid,command:current.command,startedAt:current.startedAt});
}
