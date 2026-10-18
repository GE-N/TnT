import {lstat,readdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join,basename,resolve} from 'node:path';
import {REDACTED} from './run-script-contract.js';
export type EvidenceInput={directories:string[];token?:string;value:unknown};
export type EvidenceScrubber=(input:EvidenceInput)=>Promise<void>;
export function tokenForms(token?:string):string[]{return token?[...new Set([token,encodeURIComponent(token),Buffer.from(token).toString('base64')])].sort((a,b)=>b.length-a.length):[];}
export function redact(value:string,token?:string){for(const form of tokenForms(token))value=value.replaceAll(form,REDACTED);return value;}
function redactValue(value:unknown,token?:string):unknown {
 if(typeof value==='string')return redact(value,token);
 if(Array.isArray(value))return value.map(item=>redactValue(item,token));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[redact(key,token),redactValue(child,token)]));
 return value;
}
export async function assertEvidenceRoot(directory:string){
 // Callers capture canonical directories before launching tools. Reject changed ancestors too.
 if(await realpath(directory)!==resolve(directory)||(await lstat(directory)).isSymbolicLink())throw new Error('Evidence root changed.');
}
async function files(directory:string):Promise<string[]>{
 await assertEvidenceRoot(directory);
 const result:string[]=[];
 async function walk(path:string){
  const info=await lstat(path);
  if(info.isSymbolicLink())throw new Error('Evidence symlinks are unsupported.');
  if(info.isDirectory())for(const name of await readdir(path))await walk(join(path,name));
  else if(info.isFile())result.push(path);
  else throw new Error('Unsupported evidence file.');
 }
 await walk(directory);return result;
}
export const defaultEvidenceScrubber:EvidenceScrubber=async input=>{
 if(!input.token)return; // No secret exists to replace; the same terminal guard still deletes scripts and checks roots.
 for(const directory of input.directories)for(const file of await files(directory)){
  const bytes=await readFile(file);const text=bytes.toString('utf8');
  if(/^commands.*\.json$/.test(basename(file)))await writeFile(file,JSON.stringify(redactValue(JSON.parse(text),input.token),null,2));
  else if(Buffer.from(text).equals(bytes)){
   const safe=redact(text,input.token);if(safe!==text)await writeFile(file,safe);
  }
 }
 input.value=redactValue(input.value,input.token);
};
/** Independent verifier: injected scrubbers cannot replace/disable this scan. Includes binary bytes and filenames. */
export async function verifyEvidence(input:EvidenceInput){
 const forms=tokenForms(input.token);
 const scan=(bytes:Buffer)=>{if(forms.some(form=>bytes.includes(Buffer.from(form))))throw new Error('Unsafe evidence.');};
 const scanValue=(value:unknown):void=>{if(typeof value==='string')scan(Buffer.from(value));else if(Array.isArray(value))value.forEach(scanValue);else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){scan(Buffer.from(key));scanValue(child);}};
 scanValue(input.value);
 scan(Buffer.from(JSON.stringify(input.value)??''));
 for(const directory of input.directories)for(const file of await files(directory)){if(!forms.length)continue;scan(Buffer.from(file));const bytes=await readFile(file);scan(bytes);if(/^commands.*\.json$/.test(basename(file)))scanValue(JSON.parse(bytes.toString('utf8')));}
}
/** Delete only captured physical roots, never a substituted root/ancestor symlink. */
export async function removeRunEvidence(directories:string[]){
 let removed=true;
 for(const directory of directories)try{
  await assertEvidenceRoot(directory);
  for(const entry of await readdir(directory))await rm(join(directory,entry),{recursive:true,force:true});
 }catch{removed=false;}
 return removed;
}
/** All terminal paths call this before mapping or listing artifacts, even without a mock. */
export async function protectRunEvidence<T>(input:EvidenceInput&{value:T;scriptFiles:string[]},scrubber:EvidenceScrubber=defaultEvidenceScrubber):Promise<{ok:true;value:T}|{ok:false;removed:boolean}>{
 let failed=false;
 try{await scrubber(input);}catch{failed=true;}
 for(const file of input.scriptFiles)try{await rm(file,{force:true});}catch{failed=true;}
 try{await verifyEvidence(input);}catch{failed=true;}
 if(!failed)return {ok:true,value:input.value as T};
 // Deny all evidence, including hidden output, rather than publish a partially scrubbed tree.
 return {ok:false,removed:await removeRunEvidence(input.directories)};
}
