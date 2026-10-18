import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {parseAllDocuments} from 'yaml';
import {createScenarios,type Maestro} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
import {createMockSession} from '../server/mockoon.js';
import type {EvidenceScrubber} from '../server/run-script-evidence.js';
import {tokenForms} from '../server/run-script-evidence.js';
export const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';
export const yaml='appId: com.example.HybridApp\n---\n- launchApp\n- tapOn: Load\n- assertVisible: Home\n';
export async function scriptFixture(config:{mock?:boolean;source?:string;terminal?:'timeout'|'cancel'|'crash';scrubber?:EvidenceScrubber;mockFailure?:'prepare'|'evidence'|'cleanup';customRun?:Maestro['run'];httpStatus?:number}={}){
 const root=await mkdtemp(join(tmpdir(),'tnt-script-'));let toolCalls=0;let acquisitions=0;let mockCount=0;let cleanupCount=0;const tokens:string[]=[];const outputs:Record<string,unknown>[]=[];const calls:Parameters<Maestro['run']>[0][]=[];
 const runner=createRunner({artifactDirectory:root,execute:async(_file,args)=>{toolCalls++;return {stdout:args.includes('list')?JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}):'/app',stderr:''};}});
 const acquire=runner.acquireDevice;runner.acquireDevice=async(...args)=>{acquisitions++;return acquire(...args);};
 const mockEnvironment=JSON.parse(await readFile(new URL('./fixtures/mockoon.json',import.meta.url),'utf8'));
 const mock=config.mock?{environment:mockEnvironment,port:19841,routeId:mockEnvironment.routes[0].uuid,responseId:mockEnvironment.routes[0].responses[1].uuid,backendUrl:'http://127.0.0.1:4321',passthroughRouteIds:[],fromScreen:'Home',toScreen:'Home',failureSemantics:'Fixture HTTP'}:undefined;
 const run:Maestro['run']=config.customRun??(async input=>{
  calls.push(input);const commands=parseAllDocuments(await readFile(input.flow,'utf8'))[1].toJS() as any[];const output:Record<string,unknown>={};outputs.push(output);const metadata:any[]=[];let failed=false;
  for(const command of commands){
   if(failed)break;const key=typeof command==='string'?command:Object.keys(command)[0];let internal:any;let error:string|undefined;
   if(key==='runScript'){
    internal={runScriptCommand:{script:command.runScript.file,env:input.scriptEnv}};
    try{runInNewContext(await readFile(join(input.directory,command.runScript.file),'utf8'),{output,...input.scriptEnv,http:{get:()=>({ok:(config.httpStatus??200)<400,status:config.httpStatus??200})}},{timeout:500});}catch(e){failed=true;error=(e as Error).message;}
   }else if(key==='evalScript'){
    internal={evalScriptCommand:{}};try{runInNewContext(command.evalScript.slice(2,-1),{output});}catch(e){failed=true;error=(e as Error).message;}
   }else internal={[{launchApp:'launchAppCommand',tapOn:'tapOnElement',assertVisible:'assertConditionCommand',runFlow:'runFlowCommand'}[key]??key]:{}};
   metadata.push({command:internal,metadata:{depth:0,status:failed?'FAILED':'COMPLETED',...(error?{error:{message:error},evaluatedCommand:{message:error}}:{})}});
  }
  const leak=tokenForms(input.scriptEnv?.TNT_MOCK_TOKEN).join(' ');
  await mkdir(join(input.directory,'raw','nested'),{recursive:true});await writeFile(join(input.directory,'raw','nested','commands.json'),JSON.stringify(metadata));
  await writeFile(join(input.directory,'maestro.log'),leak);await writeFile(join(input.directory,'report.xml'),`<testsuites><testsuite tests="1" failures="${failed?1:0}"><testcase><failure>Unknown error ${leak}</failure></testcase></testsuite></testsuites>`);
  if(config.terminal==='cancel')await new Promise<void>(resolve=>input.signal.aborted?resolve():input.signal.addEventListener('abort',()=>resolve(),{once:true}));
  if(config.terminal==='crash')throw new Error('Crash '+leak);
  return {code:config.terminal==='timeout'?124:failed?1:0,log:metadata.map(item=>item.metadata.error?.message??'').join('\n')+' '+leak,stdout:leak,cleanup:{verified:true,detail:'Stopped '+leak}};
 });
 const factory:typeof createMockSession=(plan,directory)=>{
  mockCount++;const base=createMockSession(plan,directory);const token='token +/ไทย?='+mockCount;tokens.push(token);
  return {...base,scriptAccess:()=>({url:'http://127.0.0.1:19841/mockoon-admin',token}),prepare:async()=>{if(config.mockFailure==='prepare')throw new Error('Prepare '+token);base.result.intent.status='acknowledged';},evidence:async()=>{if(config.mockFailure==='evidence')throw new Error('Evidence '+token);base.result.evidence.detail='captured '+token;},cleanup:async()=>{cleanupCount++;if(config.mockFailure==='cleanup')throw new Error('Cleanup '+token);return {verified:true,detail:'Mock stopped '+token};}};
 };
 const options={root,trustDirectory:join(root,'trust'),runner,maestro:{version:async()=>{toolCalls++;return '2.11.0';},run},createMockSession:factory,scrubber:config.scrubber};
 const service=createScenarios(options);const references=(await service.references({yaml})).references.filter(item=>item.kind==='step');
 const row={id:'script-one',label:'Script',source:config.source??'output.X = `ไทย ${"quote"}`; // trailing',beforeStep:{index:1,fingerprint:references[1].fingerprint}};
 const scenario={id:'one',name:'One',steps:references,inputs:{},parameters:{},enabledHandlerIds:[],scripts:[row]};
 const workspace=await service.save({name:'Scripts',yaml,scenarios:[scenario],mock});
 return {root,runner,service,options,workspace,scenario,row,calls,tokens,outputs,stats:()=>({toolCalls,acquisitions,mockCount,cleanupCount}),cleanup:()=>rm(root,{recursive:true,force:true}),start:()=>service.start({workspaceId:workspace.id,deviceId,scenarioId:'one'})};
}
export async function assertTokenFree(f:Awaited<ReturnType<typeof scriptFixture>>,runId:string){
 const result=await f.service.result(runId);for(const token of f.tokens)for(const form of tokenForms(token))assert.equal(JSON.stringify(result).includes(form),false);
 for(const name of result.artifacts){assert.doesNotMatch(name,/\.tnt-script-\d+\.js/);const bytes=await f.service.artifact(runId,name);for(const token of f.tokens)for(const form of tokenForms(token))assert.equal(bytes.includes(Buffer.from(form)),false,name);}
}
