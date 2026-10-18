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

/** Identity of a live PID. Undefined means the PID is not running. A lookup failure is thrown so recovery does not treat it as gone. */
export async function lookupProcess(pid:number):Promise<ProcessIdentity|undefined>{
 if(!Number.isSafeInteger(pid)||pid<=0)return;
 try{
  const {stdout}=await ps('ps',['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:2000,env:{...process.env,LC_ALL:'C',LANG:'C'}});
  const match=lstart.exec(String(stdout??'').trim());
  if(!match)return;
  return {startedAt:match[1],command:match[2].trim()};
 }catch(error){if((error as {code?:string|number}).code===1)return;throw error;}
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

/** Append a TnT-spawned Maestro or Mockoon process to the device-ownership lock. */
export async function recordOwnedProcess(root:string,process:OwnedProcess){
 const path=join(root,'device-ownership.lock');
 let current:Record<string,unknown>;
 try{current=JSON.parse(await readFile(path,'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(!current||typeof current!=='object'||Array.isArray(current))return;
 const processes=Array.isArray(current.processes)?current.processes.filter(item=>item&&typeof item==='object'):[];
 if(!processes.some((item:OwnedProcess)=>item.pid===process.pid&&item.role===process.role))processes.push(process);
 current.processes=processes;
 const temporary=join(root,'.'+randomUUID()+'.lock');
 let pending=true;
 try{await writeFile(temporary,JSON.stringify(current),{mode:0o600});await rename(temporary,path);pending=false;}
 finally{if(pending)await rm(temporary,{force:true});}
}

/** Record the PID after Maestro's launcher has exec'd java, so recovery sees the runtime command. */
export async function recordSettledProcess(root:string,role:OwnedProcess['role'],pid:number,io:{lookup?:typeof lookupProcess;pause?:(ms:number)=>Promise<void>;settleMs?:number}={}){
 const lookup=io.lookup??lookupProcess;const pause=io.pause??delay;const deadline=Date.now()+(io.settleMs??2_000);
 let identity=await lookup(pid);
 if(!identity)return;
 while(role==='maestro'&&isMaestroLauncher(identity.command)&&Date.now()<deadline){
  await pause(50);
  const next=await lookup(pid);
  if(!next)return;
  identity=next;
 }
 await recordOwnedProcess(root,{role,pid,command:identity.command,startedAt:identity.startedAt});
}
