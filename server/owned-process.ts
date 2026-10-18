import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';

const ps=promisify(execFile);

export type OwnedProcess={role:'maestro'|'mockoon';pid:number;command:string;startedAt:string};
export type ProcessIdentity={command:string;startedAt:string};
const lstart=/^([A-Za-z]{3} [A-Za-z]{3} [ 0-9]\d [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})\s+([\s\S]+)$/;

/** Identity of a live PID. Undefined means the PID is not running. */
export async function lookupProcess(pid:number):Promise<ProcessIdentity|undefined>{
 if(!Number.isSafeInteger(pid)||pid<=0)return;
 try{
  const {stdout}=await ps('ps',['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:2000});
  const match=lstart.exec(stdout.trim());
  if(!match)return;
  return {startedAt:match[1],command:match[2].trim()};
 }catch{return;}
}

/** Stop one recorded PID. An already-exited PID is not a failure. */
export async function killProcess(pid:number){
 try{process.kill(pid,'SIGTERM');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
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
 await writeFile(temporary,JSON.stringify(current),{mode:0o600});
 await rename(temporary,path);
}
