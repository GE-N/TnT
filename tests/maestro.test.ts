import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm,access,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMaestro,type MaestroDependencies} from '../server/maestro.js';
function fakeProcess(gone=true){
 const child=Object.assign(new EventEmitter(),{pid:32123,stdout:new PassThrough(),stderr:new PassThrough()});
 const timers:{fn:()=>void;ms:number;cleared?:boolean}[]=[];const signals:(number|string|undefined)[]=[];let argv:string[]=[];let spawnOptions:any;
 const dependencies:MaestroDependencies={file:'/fixture/maestro',environment:async()=>({HOME:'/real-home',JAVA_HOME:'/java',PATH:'/bin'}),spawn:((_file:any,args:any,options:any)=>{argv=args;spawnOptions=options;return child;}) as any,kill:((_pid:number,signal:any)=>{signals.push(signal);if(signal===0&&gone)throw Object.assign(new Error('Gone'),{code:'ESRCH'});return true;}) as any,schedule:((fn:any,ms:number)=>{const timer={fn,ms};timers.push(timer);return timer;}) as any,unschedule:((timer:any)=>{timer.cleared=true;}) as any,pause:(async()=>{}) as any};
 return {child,timers,signals,dependencies,argv:()=>argv,spawnOptions:()=>spawnOptions};
}
test('script credentials never enter -e; external temporary HOME is deleted; cap kills whole group',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-maestro-'));try{
  const f=fakeProcess();const adapter=createMaestro(f.dependencies);
  const done=adapter.run({directory:root,flow:join(root,'flow.yaml'),deviceId:'fixture',signal:new AbortController().signal,runtimeInputs:{USER:'saved'},scriptEnv:{TNT_MOCK_URL:'http://mock',TNT_MOCK_TOKEN:'secret'}});
  while(!f.timers.length)await new Promise<void>(resolve=>setImmediate(resolve));
  const args=f.argv();assert.deepEqual(args.slice(args.indexOf('-e')),['-e','USER=saved',join(root,'flow.yaml')]);assert.doesNotMatch(JSON.stringify(args),/TNT_MOCK|secret/);
  assert.equal(f.timers[0].ms,300000);f.timers[0].fn();assert.ok(f.signals.includes('SIGTERM'));assert.equal(f.timers[1].ms,2000);f.timers[1].fn();assert.ok(f.signals.includes('SIGKILL'));
  const home=f.spawnOptions().env.HOME;assert.equal(f.spawnOptions().detached,true);assert.notEqual(home,'/real-home');assert.equal(home.startsWith(root+'/'),false);assert.equal(f.spawnOptions().env.JAVA_TOOL_OPTIONS,'-Duser.home='+JSON.stringify(home));
  await mkdir(join(home,'.android'));await writeFile(join(home,'.android','adbkey'),'private adb key');
  assert.ok(args.includes('--test-output-dir'));assert.ok(args.includes('--debug-output'));f.child.emit('close',0);const result=await done;assert.equal(result.code,124);assert.equal(result.cleanup.verified,true);
  await assert.rejects(access(home),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('plain runs preserve HOME/JVM settings; script-only runs isolate HOME without dropping JVM settings',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-maestro-env-'));try{
  const original={HOME:'/real-home',JAVA_HOME:'/java',PATH:'/bin',JAVA_TOOL_OPTIONS:'-Dfixture=1'};
  for(const scriptRun of [false,true]){
   const f=fakeProcess();f.dependencies.environment=async()=>original;
   const done=createMaestro(f.dependencies).run({directory:root,flow:join(root,'flow.yaml'),deviceId:'fixture',signal:new AbortController().signal,scriptRun});
   while(!f.timers.length)await new Promise<void>(resolve=>setImmediate(resolve));
   if(!scriptRun)assert.deepEqual(f.spawnOptions().env,original);
   else {assert.notEqual(f.spawnOptions().env.HOME,original.HOME);assert.match(f.spawnOptions().env.JAVA_TOOL_OPTIONS,/^-Dfixture=1 -Duser.home=/);}
   f.child.emit('close',0);assert.equal((await done).cleanup.verified,true);assert.equal(original.HOME,'/real-home');assert.equal(original.JAVA_TOOL_OPTIONS,'-Dfixture=1');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('spawn records the owned maestro pid',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-maestro-note-'));try{
  const f=fakeProcess();const noted:number[]=[];let prepared=false;
  f.dependencies.prepareProcess=async()=>{prepared=true;};
  const spawn=f.dependencies.spawn!;
  f.dependencies.spawn=((...args:Parameters<NonNullable<MaestroDependencies['spawn']>>)=>{assert.equal(prepared,true);return spawn(...args);}) as MaestroDependencies['spawn'];
  f.dependencies.noteProcess=async pid=>{noted.push(pid);};
  const done=createMaestro(f.dependencies).run({directory:root,flow:join(root,'flow.yaml'),deviceId:'fixture',signal:new AbortController().signal});
  while(!f.timers.length)await new Promise<void>(resolve=>setImmediate(resolve));
  f.child.emit('close',0);await done;assert.deepEqual(noted,[32123]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('cancel kills descendants; live group cannot be marked clean and no script credentials by default',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-maestro-live-'));try{
  const f=fakeProcess(false);const controller=new AbortController();const done=createMaestro(f.dependencies).run({directory:root,flow:join(root,'flow.yaml'),deviceId:'fixture',signal:controller.signal});
  while(!f.timers.length)await new Promise<void>(resolve=>setImmediate(resolve));controller.abort();assert.ok(f.signals.includes('SIGTERM'));assert.equal(f.argv().includes('-e'),false);f.child.emit('close',null);
  assert.equal(f.spawnOptions().env.HOME,'/real-home');assert.equal(f.spawnOptions().env.JAVA_TOOL_OPTIONS,undefined);assert.equal(f.argv().includes('--debug-output'),false);
  assert.equal((await done).cleanup.verified,false);assert.ok(f.signals.includes('SIGKILL'));
 }finally{await rm(root,{recursive:true,force:true});}
});
