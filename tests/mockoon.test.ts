import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMockSession,validateMock} from '../server/mockoon.js';
const environment=JSON.parse(await readFile(new URL('./fixtures/mockoon.json',import.meta.url),'utf8'));
async function port(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No port');await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;}
test('real Mockoon preserves all responses/rules/modes, defaults at launch, original defaults, passthrough and token-free result',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-mockoon-'));const backend=createServer((_req,res)=>res.end('backend'));await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));const address=backend.address();if(!address||typeof address==='string')throw new Error('No backend');
 try{
  const env=structuredClone(environment);env.routes[0].responses[0].rules=[{target:'header',modifier:'x-special',value:'yes',invert:false,operator:'equals'}];
  const extra=structuredClone(env.routes[0]);extra.uuid='55555555-5555-4555-8555-555555555555';extra.endpoint='other';extra.responseMode='SEQUENTIAL';extra.responses.forEach((response:any,index:number)=>response.uuid=index?'88888888-8888-4888-8888-888888888888':'77777777-7777-4777-8777-777777777777');env.routes.push(extra);env.rootChildren.push({type:'route',uuid:extra.uuid});
  const pass=structuredClone(extra);pass.uuid='66666666-6666-4666-8666-666666666666';pass.endpoint='passthrough';pass.responses=[{...extra.responses[0],uuid:'99999999-9999-4999-8999-999999999999'}];env.routes.push(pass);env.rootChildren.push({type:'route',uuid:pass.uuid});
  const plan=validateMock({environment:env,port:await port(),routeId:env.routes[0].uuid,responseId:env.routes[0].responses[1].uuid,backendUrl:`http://127.0.0.1:${address.port}`,passthroughRouteIds:[pass.uuid],fromScreen:'Home',toScreen:'Maintenance',failureSemantics:'HTTP 500'})!;const before=structuredClone(plan);
  for(const overrideResponse of [true,false]){
   const mock=createMockSession(plan,root,{overrideResponse});const access=mock.scriptAccess();assert.doesNotMatch(JSON.stringify(mock.result),new RegExp(access.token));
   try{
    await mock.prepare(new AbortController().signal);
    const selected=JSON.parse(await readFile(join(root,'mock-environment.json'),'utf8'));
    assert.equal(selected.routes[0].responses.length,2);assert.deepEqual(selected.routes[0].responses[0].rules,env.routes[0].responses[0].rules);assert.deepEqual(selected.routes[1],env.routes[1]);assert.equal(selected.routes.some((route:any)=>route.uuid===pass.uuid),false);
    assert.deepEqual(selected.routes[0].responses.map((response:any)=>response.default),overrideResponse?[false,true]:[true,false]);
    const base=`http://127.0.0.1:${plan.port}`;assert.equal((await fetch(base+'/items')).status,overrideResponse?500:200);assert.equal((await fetch(base+'/items',{headers:{'x-special':'yes'}})).status,200);assert.equal(await (await fetch(base+'/passthrough')).text(),'backend');
    await mock.evidence(false);assert.doesNotMatch(JSON.stringify(mock.result),new RegExp(access.token));
    assert.equal(mock.result.intent.responseRole,'default');assert.match(mock.result.intent.failureSemantics,/Configured default response/);assert.match(mock.result.evidence.detail,/rules and modes may select another response/);
    assert.ok(mock.result.evidence.transactions.some(transaction=>transaction.statusCode===200));
   }finally{assert.equal((await mock.cleanup()).verified,true);}
   await assert.rejects(fetch(`http://127.0.0.1:${plan.port}/items`));assert.deepEqual(plan,before);
  }
 }finally{await new Promise<void>(resolve=>backend.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
test('Mockoon spawn records the owned pid',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tnt-mockoon-note-'));
 try{
  const plan=validateMock({environment,port:19876,routeId:environment.routes[0].uuid,responseId:environment.routes[0].responses[0].uuid,backendUrl:'http://127.0.0.1:9',passthroughRouteIds:[],fromScreen:'Home',toScreen:'Home',failureSemantics:'HTTP'})!;
  const child=Object.assign(new EventEmitter(),{pid:424242});
  let noted:number|undefined;let prepared=false;
  const controller=new AbortController();
  const mock=createMockSession(plan,root,{prepareProcess:async()=>{prepared=true;},spawn:(()=>{assert.equal(prepared,true);return child;}) as unknown as typeof import('node:child_process').spawn,noteProcess:async pid=>{noted=pid;}});
  const prepare=mock.prepare(controller.signal);
  const deadline=Date.now()+2_000;
  while(noted===undefined&&Date.now()<deadline)await new Promise<void>(resolve=>setTimeout(resolve,10));
  if(noted===undefined)controller.abort();
  assert.equal(noted,424242);
  child.emit('exit',1);
  await assert.rejects(prepare,/exited during setup/);
 }finally{await rm(root,{recursive:true,force:true});}
});
