// Explicit real-tool suite; excluded from npm test. Requires a booted iOS simulator with the fixture app.
// MAESTRO_BIN=/path/to/maestro TNT_REAL_DEVICE=<udid> node --import tsx --test --test-concurrency=1 tests/integration/run-script-maestro.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {createScenarios} from '../../server/scenarios.js';
import {createRunner} from '../../server/runner.js';
import {createMaestro} from '../../server/maestro.js';
import {checkScriptSyntax} from '../../server/run-script-plan.js';
import {tokenForms} from '../../server/run-script-evidence.js';
const exec=promisify(execFile);
const deviceId=process.env.TNT_REAL_DEVICE;
if(!deviceId)throw new Error('Set TNT_REAL_DEVICE for this explicitly invoked real-tool suite.');
const environment=JSON.parse(await readFile(new URL('../fixtures/mockoon.json',import.meta.url),'utf8'));
async function walk(path:string):Promise<string[]>{try{const entries=await readdir(path,{withFileTypes:true});return (await Promise.all(entries.map(entry=>entry.isDirectory()?walk(join(path,entry.name)):entry.isFile()?[join(path,entry.name)]:[]))).flat();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}}
async function fixture(withMock=false){
 const root=await mkdtemp(join(tmpdir(),'tnt-real-script-'));let ownedPid:number|undefined;const maestro=createMaestro({spawn:((...args:Parameters<typeof spawn>)=>{const child=spawn(...args);ownedPid=child.pid;return child;}) as typeof spawn});
 const runner=createRunner({artifactDirectory:join(root,'launches'),ownershipDirectory:process.env.TNT_REAL_OWNERSHIP_DIR??root,execute:async(file,args)=>exec(file,args,{encoding:'utf8',timeout:30000})});
 const tokens:string[]=[];const {createMockSession}=await import('../../server/mockoon.js');
 const service=createScenarios({root,trustDirectory:join(root,'trust'),runner,maestro,createMockSession:(...args)=>{const mock=createMockSession(...args);tokens.push(mock.scriptAccess().token);return mock;}});
 const probe=createServer();await new Promise<void>(res=>probe.listen(0,'127.0.0.1',res));const address=probe.address();if(!address||typeof address==='string')throw new Error('No port');const port=address.port;await new Promise<void>(res=>probe.close(()=>res()));
 const mock=withMock?{environment,port,routeId:environment.routes[0].uuid,responseId:environment.routes[0].responses[0].uuid,backendUrl:'http://127.0.0.1:4321',passthroughRouteIds:[],fromScreen:'Home',toScreen:'Home',failureSemantics:'Fixture response'}:undefined;
 const yaml='appId: '+(process.env.TNT_REAL_APP??'com.example.HybridApp')+'\n---\n- launchApp\n- evalScript: ${if (output.X !== "ไทย quote") throw new Error("output did not round-trip")}\n';
 const refs=(await service.references({yaml})).references.filter(item=>item.kind==='step');
 const row={id:'real-script',label:'Real script',beforeStep:{index:1,fingerprint:refs[1].fingerprint},source:'output.X = `ไทย ${"quote"}`; // trailing comment'};
 async function save(source=row.source,end=false){
  const authored=end?yaml.replace('if (output.X !== \"ไทย quote\") throw new Error(\"output did not round-trip\")','output.X = \"ไทย quote\"'):yaml;
  const steps=(await service.references({yaml:authored})).references.filter(item=>item.kind==='step');
  return service.save({name:'Real script',yaml:authored,scenarios:[{id:'real',name:'Real',steps,inputs:{},parameters:{},enabledHandlerIds:[],scripts:[{...row,source,...(end?{beforeStep:{index:steps.length,fingerprint:steps.length?steps.at(-1)!.fingerprint+':end':'end'}}:{})}]}],mock});
 }
 async function scan(){for(const path of [...await walk(root),...await walk(join(homedir(),'.maestro','tests'))]){const bytes=await readFile(path);for(const token of tokens)for(const form of tokenForms(token))assert.equal(bytes.includes(Buffer.from(form)),false,'Token in '+path);}assert.equal((await walk(join(root,'runs'))).some(path=>/\.tnt-script-\d+\.js$/.test(path)),false);}
 return {root,service,runner,save,tokens,port,scan,pid:()=>ownedPid};
}
test('real Maestro output/escaping happy path and 20 consecutive fresh Mockoon sessions',async t=>{
 const f=await fixture(true);try{
  const workspace=await f.save();
  for(let i=0;i<20;i++){
   const result=await f.service.wait((await f.service.start({workspaceId:workspace.id,deviceId:deviceId!,scenarioId:'real'})).id);
   assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(result.scriptSteps?.['real-script'].status,'passed');assert.equal(result.cleanup.verified,true);
   await f.scan();await assert.rejects(fetch(`http://127.0.0.1:${f.port}/mockoon-admin`));const release=await f.runner.acquireDevice(deviceId!);await release();t.diagnostic('consecutive run '+(i+1)+' passed');
  }
  assert.equal(new Set(f.tokens).size,20);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('real Graal parity and readable script failures including token/Thai evidence',async()=>{
 const f=await fixture(true);try{
  const sources=['output.X = ({x:"ไทย quote"})?.x ?? "fallback"; const arrow=()=>`ok`; arrow();','throw new Error("ไทย " + TNT_MOCK_TOKEN + " " + encodeURIComponent(TNT_MOCK_TOKEN));','const response=http.get(TNT_MOCK_URL+"/does-not-exist"); if (!response.ok) throw new Error("HTTP "+response.status);','return 1;'];
  for(const [index,source] of sources.entries()){
   assert.equal(checkScriptSyntax(source),undefined);
   const workspace=await f.save(source);
   const result=await f.service.wait((await f.service.start({workspaceId:workspace.id,deviceId:deviceId!,scenarioId:'real'})).id);
   if(index===0)assert.equal(result.status,'passed',JSON.stringify(result));
   else {assert.equal(result.status,'script-error',JSON.stringify(result));assert.ok(result.scriptSteps?.['real-script'].message);assert.doesNotMatch(result.scriptSteps!['real-script'].message!,/^Unknown error$/);}
   await f.scan();
  }
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('real 300s whole-group cap, A11 ownership and no token history',async()=>{
 const f=await fixture(true);try{
  const workspace=await f.save('while (true) {}');const started=Date.now();
  const run=await f.service.start({workspaceId:workspace.id,deviceId:deviceId!,scenarioId:'real'});
  await assert.rejects(f.runner.acquireDevice(deviceId!),/in progress/);
  const result=await f.service.wait(run.id);assert.ok(Date.now()-started>=300000);assert.equal(result.status,'tool-error',JSON.stringify(result));assert.equal(result.error,'Run stopped at 300s cap');assert.equal(result.cleanup.verified,true);await f.scan();
  const release=await f.runner.acquireDevice(deviceId!);await release();
 }finally{await rm(f.root,{recursive:true,force:true});}
});

for(const terminal of ['cancel','crash'] as const)test('real '+terminal+' after script start removes tokens from owned artifacts and HOME history',async()=>{
 const f=await fixture(true);try{
  const workspace=await f.save('http.get("http://127.0.0.1:'+f.port+'/items"); while (true) {}');
  const run=await f.service.start({workspaceId:workspace.id,deviceId:deviceId!,scenarioId:'real'});
  const deadline=Date.now()+60000;let observed=false;
  while(Date.now()<deadline){
   try{const response=await fetch('http://127.0.0.1:'+f.port+'/mockoon-admin/logs',{headers:{Authorization:'Bearer '+f.tokens.at(-1)},signal:AbortSignal.timeout(1000)});const logs:any=await response.json();if(Array.isArray(logs)&&logs.some(entry=>entry.request?.urlPath==='/items')){observed=true;break;}}catch{/* Startup continues. */}
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  try{
   assert.equal(observed,true,'Real script must reach the mock before terminal-path test');
   if(terminal==='crash'){assert.ok(f.pid());process.kill(-f.pid()!,'SIGKILL');}
   const result=terminal==='cancel'?await f.service.cancel(run.id):await f.service.wait(run.id);
   assert.equal(result.status,terminal==='cancel'?'cancelled':'tool-error',JSON.stringify(result));assert.equal(result.cleanup.verified,true);await f.scan();
  }finally{await f.service.cancel(run.id).catch(()=>{});}
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('real end anchor executes after the final step without mock variables',async()=>{
 const f=await fixture();try{
  const workspace=await f.save('if (output.X !== "ไทย quote") throw new Error("end order wrong"); if (typeof TNT_MOCK_TOKEN !== "undefined") throw new Error("unexpected env");',true);
  const result=await f.service.wait((await f.service.start({workspaceId:workspace.id,deviceId:deviceId!,scenarioId:'real'})).id);assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(result.executionOrder?.at(-1)?.kind,'runScript');await f.scan();
  for(const yaml of [workspace.yaml+'- evalScript: ${output.unused = true}\n',workspace.yaml.replace('output.X = \"ไทย quote\"','output.X = \"changed\"')]){
   const steps=(await f.service.references({yaml})).references.filter(ref=>ref.kind==='step');
   await f.service.save({...workspace,metadata:(await f.service.workspace(workspace.id)).metadata,yaml,scenarios:workspace.scenarios!.map(scenario=>({...scenario,steps}))});
   const pid=f.pid();await assert.rejects(f.service.start({workspaceId:workspace.id,deviceId:deviceId!,scenarioId:'real'}),/Step changed · relink before running/);assert.equal(f.pid(),pid);
  }
 }finally{await rm(f.root,{recursive:true,force:true});}
});
