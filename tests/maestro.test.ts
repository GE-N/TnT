import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMaestro,type MaestroDependencies} from '../server/maestro.js';
function fakeProcess(gone=true){
 const child=Object.assign(new EventEmitter(),{pid:32123,stdout:new PassThrough(),stderr:new PassThrough()});
 const timers:{fn:()=>void;ms:number;cleared?:boolean}[]=[];const signals:(number|string|undefined)[]=[];let argv:string[]=[];let spawnOptions:any;
 const dependencies:MaestroDependencies={file:'/fixture/maestro',environment:async()=>({HOME:'/real-home',JAVA_HOME:'/java',PATH:'/bin'}),spawn:((_file:any,args:any,options:any)=>{argv=args;spawnOptions=options;return child;}) as any,kill:((_pid:number,signal:any)=>{signals.push(signal);if(signal===0&&gone)throw Object.assign(new Error('Gone'),{code:'ESRCH'});return true;}) as any,schedule:((fn:any,ms:number)=>{const timer={fn,ms};timers.push(timer);return timer;}) as any,unschedule:((timer:any)=>{timer.cleared=true;}) as any,pause:(async()=>{}) as any};
 return {child,timers,signals,dependencies,argv:()=>argv,spawnOptions:()=>spawnOptions};
}
test('scriptEnv is emitted as separate -e pairs, diagnostics are owned, cap kills whole group',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-maestro-'));try{
  const f=fakeProcess();const adapter=createMaestro(f.dependencies);
  const done=adapter.run({directory:root,flow:join(root,'flow.yaml'),deviceId:'fixture',signal:new AbortController().signal,runtimeInputs:{USER:'saved'},scriptEnv:{TNT_MOCK_URL:'http://mock',TNT_MOCK_TOKEN:'secret'}});
  while(!f.timers.length)await new Promise<void>(resolve=>setImmediate(resolve));
  const args=f.argv();assert.deepEqual(args.slice(args.indexOf('-e')),['-e','USER=saved','-e','TNT_MOCK_URL=http://mock','-e','TNT_MOCK_TOKEN=secret',join(root,'flow.yaml')]);
  assert.equal(f.timers[0].ms,300000);f.timers[0].fn();assert.ok(f.signals.includes('SIGTERM'));assert.equal(f.timers[1].ms,2000);f.timers[1].fn();assert.ok(f.signals.includes('SIGKILL'));
  assert.equal(f.spawnOptions().detached,true);assert.equal(f.spawnOptions().env.HOME,join(root,'.maestro-home'));assert.equal(f.spawnOptions().env.JAVA_TOOL_OPTIONS,'-Duser.home='+JSON.stringify(join(root,'.maestro-home')));
  assert.ok(args.includes('--test-output-dir'));assert.ok(args.includes('--debug-output'));f.child.emit('close',0);const result=await done;assert.equal(result.code,124);assert.equal(result.cleanup.verified,true);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('cancel kills descendants; live group cannot be marked clean and no script credentials by default',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-maestro-live-'));try{
  const f=fakeProcess(false);const controller=new AbortController();const done=createMaestro(f.dependencies).run({directory:root,flow:join(root,'flow.yaml'),deviceId:'fixture',signal:controller.signal});
  while(!f.timers.length)await new Promise<void>(resolve=>setImmediate(resolve));controller.abort();assert.ok(f.signals.includes('SIGTERM'));assert.equal(f.argv().includes('-e'),false);f.child.emit('close',null);
  assert.equal((await done).cleanup.verified,false);assert.ok(f.signals.includes('SIGKILL'));
 }finally{await rm(root,{recursive:true,force:true});}
});
