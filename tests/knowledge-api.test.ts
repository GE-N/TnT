import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkspaceStore} from '../server/workspace-store.js';
import {createRunner} from '../server/runner.js';
import {createApiHandler} from '../server/http.js';
import {createKnowledgeService,type ContextContent} from '../server/knowledge/index.js';

const content:ContextContent={purpose:'Purpose',expectedOutcome:'Expected',rationale:'Why',preconditions:'Before',exceptions:'Except',scope:'Scope'};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'tnt-knowledge-http-'));const store=createWorkspaceStore(root,workspace=>workspace);const workspace=await store.save({id:'',name:'Knowledge HTTP',yaml:'appId: example.App\n---\n- launchApp\n',scenarios:[{id:'one',name:'One',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]}]});
 const knowledge=createKnowledgeService({root,store,queue:{enqueue(){}},reconcileIntervalMs:0});const runner=createRunner({artifactDirectory:join(root,'launches'),execute:async()=>({stdout:JSON.stringify({devices:{}}),stderr:''})});
 const server=createServer(createApiHandler(runner,join(root,'launches'),undefined,undefined,undefined,knowledge));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No server');const base='http://127.0.0.1:'+address.port;
 const token=(await (await fetch(base+'/api/status')).json()).token as string;
 const path='/api/knowledge/workspaces/'+workspace.id+'/scenarios/one/context';
 const request=(url=path,method='GET',body?:unknown,headers:Record<string,string>={})=>fetch(base+url,{method,headers:{origin:base,'x-tnt-token':token,'content-type':'application/json',...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
 return {root,store,workspace,knowledge,path,request,async close(){knowledge.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(root,{recursive:true,force:true});}};
}

test('knowledge HTTP routes enforce authentication, exact response fields, conflict draft recovery and live freshness',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request(f.path,'GET',undefined,{'x-tnt-token':''})).status,403);assert.equal((await f.request(f.path,'PUT',{expectedContextRevision:0,context:content},{origin:'http://foreign.example'})).status,403);
  const read=await f.request();assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');const detail=await read.json();assert.equal(detail.context.contextRevision,0);assert.equal(detail.readerUrl,'/knowledge/workspaces/'+f.workspace.id+'/#scenario-one');assert.equal(detail.evidence.label,'No runs yet');
  const save=await f.request(f.path,'PUT',{expectedContextRevision:0,context:content});assert.equal(save.status,200);assert.equal((await save.json()).freshness,'updating');
  const conflict=await f.request(f.path,'PUT',{expectedContextRevision:0,context:{...content,purpose:'Retained local draft'}});assert.equal(conflict.status,409);const rejected=await conflict.json();assert.deepEqual(Object.keys(rejected).sort(),['code','context','currentContextRevision','error']);assert.equal(rejected.code,'CONTEXT_REVISION_CONFLICT');assert.equal(rejected.currentContextRevision,1);assert.equal(rejected.context.purpose,'Purpose');
  await f.knowledge.publish(f.workspace.id);const status=await f.request('/api/knowledge/workspaces/'+f.workspace.id+'/status');assert.equal(status.status,200);assert.equal((await status.json()).freshness,'up-to-date');
 }finally{await f.close();}
});

test('knowledge HTTP errors distinguish validation, oversized text, absent saved entities and unsupported methods',async()=>{
 const f=await fixture();try{
  const malformed=await f.request(f.path,'PUT','{');assert.equal(malformed.status,400);assert.equal((await malformed.json()).code,'INVALID_KNOWLEDGE_INPUT');
  const schema=await f.request(f.path,'PUT',{expectedContextRevision:-1,context:content});assert.equal(schema.status,400);
  const large=await f.request(f.path,'PUT',{expectedContextRevision:0,context:{...content,purpose:'x'.repeat(16001)}});assert.equal(large.status,413);assert.equal((await large.json()).code,'KNOWLEDGE_TOO_LARGE');
  const bodyTooLarge=await f.request(f.path,'PUT',JSON.stringify({pad:'x'.repeat(650001)}));assert.equal(bodyTooLarge.status,413);
  const badId=await f.request(f.path.replace(f.workspace.id,'bad-id'));assert.equal(badId.status,400);assert.equal((await badId.json()).code,'INVALID_KNOWLEDGE_INPUT');
  const badScenario=await f.request(f.path.replace('/one/','/x%2Fy/'));assert.equal(badScenario.status,400);
  const absent=await f.request(f.path.replace('/one/','/absent/'));assert.equal(absent.status,404);assert.equal((await absent.json()).code,'KNOWLEDGE_NOT_FOUND');
  assert.equal((await f.request(f.path,'POST',{})).status,405);
  await f.store.trash(f.workspace.id);const trashed=await f.request();assert.equal(trashed.status,404);assert.equal((await trashed.json()).code,'KNOWLEDGE_NOT_FOUND');
 }finally{await f.close();}
});
