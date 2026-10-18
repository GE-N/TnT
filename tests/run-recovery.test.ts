import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {sweepUnfinishedRuns} from '../server/run-recovery.js';

test('startup removes unfinished token-bearing runs and confidential trees, preserving every terminal status',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-'));
 try{
  const terminal=['passed','assertion-failed','path-failed','script-error','tool-error','setup-error','handler-error','cancelled','error'];
  for(const status of [...terminal,'running','missing','partial','unknown']){
   const path=join(root,'runs',status);await mkdir(join(path,'raw'),{recursive:true});
   if(status!=='missing')await writeFile(join(path,'result.json'),status==='partial'?'{':JSON.stringify({status}));
   const value=terminal.includes(status)?'[redacted]':'short-lived-secret';
   await writeFile(join(path,'.tnt-execution.yaml'),'env: {TNT_MOCK_TOKEN: '+value+'}');
   await writeFile(join(path,'raw','commands.json'),value);
   await writeFile(join(path,'.tnt-script-0001.js'),'generated script');
  }
  const privatePath=join(root,'private','interrupted-private');await mkdir(privatePath,{recursive:true});await writeFile(join(privatePath,'.tnt-execution.yaml'),'short-lived-secret');
  await sweepUnfinishedRuns(root);
  assert.deepEqual((await readdir(join(root,'runs'))).sort(),terminal.sort());assert.deepEqual(await readdir(join(root,'private')),[]);
  for(const status of terminal){assert.equal(await readFile(join(root,'runs',status,'result.json'),'utf8'),JSON.stringify({status}));assert.doesNotMatch(await readFile(join(root,'runs',status,'.tnt-execution.yaml'),'utf8'),/short-lived-secret/);}
  await sweepUnfinishedRuns(root); // Recovery is idempotent.
 }finally{await rm(root,{recursive:true,force:true});}
});
test('startup tolerates a fresh data directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-new-'));
 try{await sweepUnfinishedRuns(join(root,'absent'));await sweepUnfinishedRuns(root);assert.deepEqual(await readdir(root),[]);}
 finally{await rm(root,{recursive:true,force:true});}
});
test('the production server sweeps unfinished evidence before announcing that it is listening',{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-start-'));let child:ReturnType<typeof spawn>|undefined;
 try{
  const path=join(root,'.tnt','runs','interrupted');await mkdir(path,{recursive:true});await writeFile(join(path,'.tnt-execution.yaml'),'TNT_MOCK_TOKEN: short-lived-secret');
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const address=probe.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),new URL('../server/main.ts',import.meta.url).pathname,'--production'],{cwd:root,env:{...process.env,PORT:String(port)},signal:t.signal,stdio:['ignore','pipe','pipe']});
  const server=child;
  await new Promise<void>((resolve,reject)=>{
   let output='';let errors='';server.stdout!.on('data',chunk=>{output+=chunk.toString();if(output.includes('TnT workbench:'))resolve();});server.stderr!.on('data',chunk=>errors+=chunk.toString());server.once('error',reject);server.once('exit',()=>reject(new Error('Server exited before listening: '+errors)));
  });
  assert.deepEqual(await readdir(join(root,'.tnt','runs')),[]);
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGTERM');await closed;}
  await rm(root,{recursive:true,force:true});
 }
});
test('startup refuses to sweep a living server and preserves device ownership after crash recovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-owner-'));
 try{
  const path=join(root,'runs','unfinished');await mkdir(path,{recursive:true});await writeFile(join(path,'.tnt-execution.yaml'),'short-lived-secret');
  const lock=join(root,'device-ownership.lock');await writeFile(lock,JSON.stringify({pid:process.pid}));
  await assert.rejects(sweepUnfinishedRuns(root),/owner is still alive/);assert.equal(await readFile(join(path,'.tnt-execution.yaml'),'utf8'),'short-lived-secret');
  await writeFile(lock,'null');await assert.rejects(sweepUnfinishedRuns(root),/Cannot verify the existing device owner/);
  // Use an exited child PID rather than assuming any particular PID is unused.
  const child=spawn(process.execPath,['-e','']);await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});
  const record=JSON.stringify({pid:child.pid});await writeFile(lock,record);await sweepUnfinishedRuns(root);
  assert.deepEqual(await readdir(join(root,'runs')),[]);assert.equal(await readFile(lock,'utf8'),record);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('startup recovery refuses symlink substitutions without deleting external files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-link-'));const outside=await mkdtemp(join(tmpdir(),'tnt-recovery-outside-'));
 try{
  await writeFile(join(outside,'keep'),'external');await mkdir(join(root,'runs'));await symlink(outside,join(root,'runs','escaped'));
  await assert.rejects(sweepUnfinishedRuns(root),/Evidence root changed/);assert.equal(await readFile(join(outside,'keep'),'utf8'),'external');
  await rm(join(root,'runs'),{recursive:true});await symlink(outside,join(root,'private'));
  await assert.rejects(sweepUnfinishedRuns(root),/Evidence root changed/);assert.equal(await readFile(join(outside,'keep'),'utf8'),'external');
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
