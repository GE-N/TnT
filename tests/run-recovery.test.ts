import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {sweepUnfinishedRuns} from '../server/run-recovery.js';
import {lookupProcess,recordSettledProcess} from '../server/owned-process.js';
import {createRunner} from '../server/runner.js';

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
  assert.deepEqual(await readdir(join(root,'runs')),[]);assert.equal(await readFile(lock,'utf8'),record,'A lock with no recorded processes stays, because recovery cannot confirm the children are gone');
  await assert.rejects(createRunner({artifactDirectory:root,ownershipDirectory:root,execute:async()=>({stdout:'',stderr:''})}).acquireDevice('E5C92F6E-40DC-493C-93B4-469E67193736'),/ownership survived a runner crash/);
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
test('startup skips plain files in runs and private without aborting the sweep',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-plain-'));
 try{
  const done=join(root,'runs','done');const unfinished=join(root,'runs','interrupted');
  await mkdir(join(done,'raw'),{recursive:true});await mkdir(unfinished,{recursive:true});
  await writeFile(join(done,'result.json'),JSON.stringify({status:'passed'}));
  await writeFile(join(unfinished,'.tnt-execution.yaml'),'short-lived-secret');
  await writeFile(join(root,'runs','.DS_Store'),'x');await writeFile(join(root,'runs','notes.txt'),'x');
  await mkdir(join(root,'private'),{recursive:true});await writeFile(join(root,'private','.DS_Store'),'x');
  await sweepUnfinishedRuns(root);
  assert.deepEqual((await readdir(join(root,'runs'))).sort(),['.DS_Store','done','notes.txt']);
  assert.equal(await readFile(join(done,'result.json'),'utf8'),JSON.stringify({status:'passed'}));
  assert.deepEqual(await readdir(join(root,'private')),['.DS_Store']);
 }finally{await rm(root,{recursive:true,force:true});}
});
async function deadOwner(root:string,processes:unknown[]){
 const child=spawn(process.execPath,['-e','']);await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});
 await writeFile(join(root,'device-ownership.lock'),JSON.stringify({pid:child.pid,processes}));
}
test('startup does not kill a reused PID and skips an already-exited recorded process',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-reuse-'));
 try{
  await mkdir(join(root,'runs','interrupted'),{recursive:true});
  const reused={role:'mockoon',pid:11,command:'mockoon',startedAt:'Sun Oct 18 12:00:45 2026'};
  const restarted={role:'maestro',pid:13,command:'maestro test',startedAt:'Sun Oct 18 12:00:46 2026'};
  const exited={role:'maestro',pid:12,command:'maestro',startedAt:'Sun Oct 18 12:00:47 2026'};
  await deadOwner(root,[reused,restarted,exited,{role:'other',pid:14,command:'nope',startedAt:'x'}]);
  const killed:number[]=[];
  await sweepUnfinishedRuns(root,{graceMs:0,pause:async()=>{},
   lookup:async pid=>pid===reused.pid?{command:'unrelated',startedAt:reused.startedAt}:pid===restarted.pid?{command:restarted.command,startedAt:'Sun Oct 18 12:01:00 2026'}:undefined,
   kill:async pid=>{killed.push(pid);},
  });
  assert.deepEqual(killed,[]);
  assert.deepEqual(await readdir(join(root,'runs')),[]);
  await assert.rejects(access(join(root,'device-ownership.lock')),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('startup stops a live recorded process group before sweeping, then releases the lock',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-kill-'));
 try{
  const unfinished=join(root,'runs','interrupted');await mkdir(unfinished,{recursive:true});
  const mockoon={role:'mockoon',pid:21,command:'node mockoon',startedAt:'Sun Oct 18 12:00:45 2026'};
  const maestro={role:'maestro',pid:22,command:'maestro test',startedAt:'Sun Oct 18 12:00:46 2026'};
  await deadOwner(root,[mockoon,maestro]);
  const stopped=new Set<number>();const killed:[number,NodeJS.Signals][]=[];
  await sweepUnfinishedRuns(root,{graceMs:0,pause:async()=>{},
   lookup:async pid=>stopped.has(pid)?undefined:pid===mockoon.pid?{command:mockoon.command,startedAt:mockoon.startedAt}:pid===maestro.pid?{command:maestro.command,startedAt:maestro.startedAt}:undefined,
   kill:async(pid,signal)=>{await access(unfinished);killed.push([pid,signal]);stopped.add(Math.abs(pid));},
  });
  assert.deepEqual(killed,[[-mockoon.pid,'SIGTERM'],[-maestro.pid,'SIGTERM']]);
  assert.deepEqual(await readdir(join(root,'runs')),[]);
  await assert.rejects(access(join(root,'device-ownership.lock')),{code:'ENOENT'});
  const release=await createRunner({artifactDirectory:root,ownershipDirectory:root,execute:async()=>({stdout:'',stderr:''})}).acquireDevice('E5C92F6E-40DC-493C-93B4-469E67193736');
  await release();
 }finally{await rm(root,{recursive:true,force:true});}
});
test('startup escalates to SIGKILL and keeps the lock when a recorded process survives',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-escalate-'));
 try{
  const unfinished=join(root,'runs','interrupted');await mkdir(unfinished,{recursive:true});
  const owned={role:'mockoon' as const,pid:21,command:'node mockoon',startedAt:'Sun Oct 18 12:00:45 2026'};
  await deadOwner(root,[owned]);
  const killed:[number,NodeJS.Signals][]=[];let force=false;
  await sweepUnfinishedRuns(root,{graceMs:0,pause:async()=>{},
   lookup:async()=>force?undefined:{command:owned.command,startedAt:owned.startedAt},
   kill:async(pid,signal)=>{await access(unfinished);killed.push([pid,signal]);if(signal==='SIGKILL')force=true;},
  });
  assert.deepEqual(killed,[[-owned.pid,'SIGTERM'],[-owned.pid,'SIGKILL']]);
  assert.deepEqual(await readdir(join(root,'runs')),[]);
  await assert.rejects(access(join(root,'device-ownership.lock')),{code:'ENOENT'});
  killed.length=0;force=false;await deadOwner(root,[owned]);await mkdir(unfinished,{recursive:true});
  await assert.rejects(sweepUnfinishedRuns(root,{graceMs:0,pause:async()=>{},
   lookup:async()=>({command:owned.command,startedAt:owned.startedAt}),
   kill:async(pid,signal)=>{killed.push([pid,signal]);},
  }),/still running/);
  assert.deepEqual(killed,[[-owned.pid,'SIGTERM'],[-owned.pid,'SIGKILL']]);
  assert.equal(await readFile(join(unfinished,'..','..','device-ownership.lock'),'utf8')!=='',true);
  await assert.rejects(createRunner({artifactDirectory:root,ownershipDirectory:root,execute:async()=>({stdout:'',stderr:''})}).acquireDevice('E5C92F6E-40DC-493C-93B4-469E67193736'),/ownership survived a runner crash/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('startup stops Maestro after its launcher execs java on the same PID and start time',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-exec-'));
 try{
  const unfinished=join(root,'runs','interrupted');await mkdir(unfinished,{recursive:true});
  const startedAt='Sun Oct 18 12:00:45 2026';
  const launcher={role:'maestro',pid:31,command:'/bin/sh /opt/maestro/bin/maestro --device phone',startedAt};
  await deadOwner(root,[launcher]);
  let stopped=false;const killed:[number,NodeJS.Signals][]=[];
  await sweepUnfinishedRuns(root,{graceMs:0,pause:async()=>{},
   lookup:async pid=>pid===launcher.pid&&!stopped?{command:'/usr/bin/java -cp app maestro.cli.AppKt',startedAt}:undefined,
   kill:async(pid,signal)=>{await access(unfinished);killed.push([pid,signal]);stopped=true;},
  });
  assert.deepEqual(killed,[[-launcher.pid,'SIGTERM']]);
  assert.deepEqual(await readdir(join(root,'runs')),[]);
  await assert.rejects(access(join(root,'device-ownership.lock')),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('maestro recording waits until the launcher execs java',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-owned-settle-'));
 try{
  const lock=join(root,'device-ownership.lock');const startedAt='Sun Oct 18 12:00:45 2026';
  await writeFile(lock,JSON.stringify({pid:1}));
  let calls=0;
  await recordSettledProcess(root,'maestro',50,{pause:async()=>{},settleMs:5_000,lookup:async()=>{calls++;return calls<2?{command:'/bin/sh /opt/maestro/bin/maestro --device phone',startedAt}:{command:'/usr/bin/java maestro.cli.AppKt',startedAt};}});
  const saved=JSON.parse(await readFile(lock,'utf8'));
  assert.equal(saved.processes[0].command,'/usr/bin/java maestro.cli.AppKt');
  assert.equal(saved.processes[0].startedAt,startedAt);
  await writeFile(lock,JSON.stringify({pid:1}));calls=0;
  await recordSettledProcess(root,'maestro',51,{pause:async()=>{},settleMs:5_000,lookup:async()=>calls++?undefined:{command:'/bin/sh /opt/maestro/bin/maestro',startedAt}});
  assert.equal(JSON.parse(await readFile(lock,'utf8')).processes,undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('production recovery uses the real lookup and kill, and records settled tool processes',async()=>{
 const source=await readFile(new URL('../server/main.ts',import.meta.url),'utf8');
 assert.match(source,/recordSettledProcess\(ownershipRoot, role, pid\)/);
 assert.match(source,/createMaestro\(\{ noteProcess: noteProcess\('maestro'\) \}\)/);
 assert.match(source,/noteProcess: noteProcess\('mockoon'\)/);
 assert.match(source,/lookup: lookupProcess/);
 assert.match(source,/kill: killProcess/);
});
test('the production server stops a recorded process group and releases the lock before listening',{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-recovery-live-'));let server:ReturnType<typeof spawn>|undefined;let sleep:ReturnType<typeof spawn>|undefined;
 try{
  const path=join(root,'.tnt','runs','interrupted');await mkdir(path,{recursive:true});await writeFile(join(path,'.tnt-execution.yaml'),'secret');
  const owner=spawn(process.execPath,['-e','']);await new Promise<void>((resolve,reject)=>{owner.once('error',reject);owner.once('close',()=>resolve());});
  sleep=spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'});
  const identity=await lookupProcess(sleep.pid!);assert.ok(identity);
  await writeFile(join(root,'.tnt','device-ownership.lock'),JSON.stringify({pid:owner.pid,processes:[{role:'mockoon',pid:sleep.pid,command:identity.command,startedAt:identity.startedAt}]}));
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const address=probe.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  server=spawn(process.execPath,['--import',import.meta.resolve('tsx'),new URL('../server/main.ts',import.meta.url).pathname,'--production'],{cwd:root,env:{...process.env,PORT:String(port)},signal:t.signal,stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{
   let output='';let errors='';server!.stdout!.on('data',chunk=>{output+=chunk.toString();if(output.includes('TnT workbench:'))resolve();});server!.stderr!.on('data',chunk=>errors+=chunk.toString());server!.once('error',reject);server!.once('exit',()=>reject(new Error('Server exited before listening: '+errors+output)));
  });
  await assert.rejects(access(join(root,'.tnt','device-ownership.lock')),{code:'ENOENT'});
  assert.deepEqual(await readdir(join(root,'.tnt','runs')),[]);
  assert.equal(await lookupProcess(sleep.pid!),undefined);
 }finally{
  if(sleep?.pid)try{process.kill(-sleep.pid,'SIGKILL');}catch{/* already stopped */}
  if(server&&server.exitCode===null&&server.signalCode===null){const closed=once(server,'close');server.kill('SIGTERM');await closed;}
  await rm(root,{recursive:true,force:true});
 }
});
