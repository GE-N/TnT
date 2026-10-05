import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRunner } from '../server/runner.js';
import { createScenarios } from '../server/scenarios.js';
const deviceId = 'E5C92F6E-40DC-493C-93B4-469E67193736';
const portProbe=createServer();
await new Promise<void>(resolve=>portProbe.listen(0,'127.0.0.1',resolve));
const probeAddress=portProbe.address(); if (!probeAddress || typeof probeAddress==='string') throw new Error('No mock port');
const mockPort=probeAddress.port;
await new Promise<void>(resolve=>portProbe.close(()=>resolve()));
const environment = JSON.parse(await readFile(new URL('./fixtures/mockoon.json', import.meta.url), 'utf8'));
const yaml = 'appId: com.example.HybridApp\n---\n- tapOn: Refresh\n- runFlow:\n    file: maintenance.yaml\n    env:\n      EXPECTED_PAGE: Maintenance\n';
const flows = { 'maintenance.yaml': 'appId: com.example.HybridApp\n---\n- assertVisible: ${EXPECTED_PAGE}\n' };
function runner(root: string) { return createRunner({ artifactDirectory: root, execute: async (_file,args) => ({stdout: args.includes('list') ? JSON.stringify({devices:{iOS:[{udid:deviceId,name:'iPhone',state:'Booted',isAvailable:true}]}}) : '/app', stderr:''}) }); }
test('mock selection is acknowledged before the action, reusable YAML is snapshotted, and observed traffic is separate from intent', async () => {
  const root = await mkdtemp(join(tmpdir(),'tnt-mock-'));
  const backend = createServer((_request,response)=>response.end('real test backend'));
  await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const address = backend.address(); if (!address || typeof address === 'string') throw new Error('No backend address');
  try {
    const scenarios = createScenarios({root,runner:runner(root),maestro:{version:async()=> '2.11.0',run:async({directory,flow})=>{
      assert.match(await readFile(join(directory,'maintenance.yaml'),'utf8'), /EXPECTED_PAGE/);
      assert.match(await readFile(flow,'utf8'), /file: maintenance.yaml/);
      const selected = await fetch(`http://127.0.0.1:${mockPort}/items`);
      assert.equal(selected.status,500); assert.deepEqual(await selected.json(),{code:'MAINTENANCE'});
      assert.equal(await (await fetch(`http://127.0.0.1:${mockPort}/unmocked`)).text(),'real test backend');
      await writeFile(join(directory,'report.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
      await writeFile(join(directory,'commands.json'),JSON.stringify([
        {command:{tapOnElement:{}},metadata:{depth:0,status:'COMPLETED'}},
        {command:{runFlowCommand:{}},metadata:{depth:0,status:'COMPLETED'}},
      ]));
      return {code:0,log:'Fixture Maestro execution',cleanup:{verified:true,detail:'Fixture process exited.'}};
    }}});
    const mock = {environment,port:mockPort,routeId:environment.routes[0].uuid,responseId:environment.routes[0].responses[1].uuid,backendUrl:`http://127.0.0.1:${address.port}`,passthroughRouteIds:[],fromScreen:'Home',toScreen:'Maintenance',failureSemantics:'HTTP 500; body code MAINTENANCE'};
    const workspace = await scenarios.save({name:'Maintenance',yaml,flows,mock});
    const result = await scenarios.wait((await scenarios.start({workspaceId:workspace.id,deviceId})).id);
    assert.equal(result.status,'passed');
    assert.equal(result.mock!.intent.status,'acknowledged');
    assert.equal(result.mock!.evidence.status,'captured');
    assert.equal(result.mock!.evidence.transactions.find(t=>t.routeId===mock.routeId)?.statusCode,500);
    assert.equal(result.snapshot.flows!['maintenance.yaml'],flows['maintenance.yaml']);
    assert.equal(result.cleanup.verified,true);
    assert.deepEqual(environment.routes[0].responses.map((r:any)=>r.statusCode),[200,500]);
    await assert.rejects(fetch(`http://127.0.0.1:${mockPort}/items`));
  } finally { await new Promise<void>(resolve=>backend.close(()=>resolve())); await rm(root,{recursive:true,force:true}); }
});

test('a reusable assertion cannot silently launch against another application', async () => {
  const root=await mkdtemp(join(tmpdir(),'tnt-flow-target-'));
  try {
    const scenarios=createScenarios({root,runner:runner(root),maestro:{version:async()=> '2.11.0',run:async()=>{throw new Error('Execution must not begin');}}});
    const workspace=await scenarios.save({name:'Wrong target',yaml,flows:{'maintenance.yaml':flows['maintenance.yaml'].replace('com.example.HybridApp','com.example.OtherApp')}});
    await assert.rejects(scenarios.start({workspaceId:workspace.id,deviceId}), /same appId/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('mock setup failure prevents triggering the app and preserves setup-error instead of assertion failure', async () => {
  const root=await mkdtemp(join(tmpdir(),'tnt-setup-failure-'));
  const occupied=createServer((_request,response)=>{response.writeHead(401);response.end();});
  await new Promise<void>(resolve=>occupied.listen(mockPort,'127.0.0.1',resolve));
  try {
    const scenarios=createScenarios({root,runner:runner(root),maestro:{version:async()=> '2.11.0',run:async()=>{assert.fail('App action must not execute');}}});
    const workspace=await scenarios.save({name:'Setup failure',yaml,flows,mock:{environment,port:mockPort,routeId:environment.routes[0].uuid,responseId:environment.routes[0].responses[1].uuid,backendUrl:'http://127.0.0.1:4321',passthroughRouteIds:[],fromScreen:'Home',toScreen:'Maintenance',failureSemantics:'HTTP 500'}});
    const result=await scenarios.wait((await scenarios.start({workspaceId:workspace.id,deviceId})).id);
    assert.equal(result.status,'setup-error');
    assert.equal(result.mock?.intent.status,'failed');
    assert.equal(result.cleanup.verified,true);
    assert.equal(result.steps.every(step=>step.status==='unavailable'),true);
    assert.equal((await fetch(`http://127.0.0.1:${mockPort}/`)).status,401);
  } finally {await new Promise<void>(resolve=>occupied.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});

test('a wrong destination fails the reusable assertion and preserves observed mock traffic', async () => {
  const root=await mkdtemp(join(tmpdir(),'tnt-wrong-page-'));
  try {
    const scenarios=createScenarios({root,runner:runner(root),maestro:{version:async()=> '2.11.0',run:async({directory})=>{
      await fetch(`http://127.0.0.1:${mockPort}/items`);
      await writeFile(join(directory,'commands.json'),JSON.stringify([
        {command:{tapOnElement:{}},metadata:{depth:0,status:'COMPLETED'}},
        {command:{runFlowCommand:{}},metadata:{depth:0,status:'FAILED'}},
        {command:{assertConditionCommand:{condition:{visible:{textRegex:'Maintenance'}}}},metadata:{depth:1,status:'FAILED',error:{message:'Maintenance missing'}}}
      ]));
      await writeFile(join(directory,'failure.png'),'fixture screen');
      return {code:1,log:'Wrong page',cleanup:{verified:true,detail:'Fixture execution stopped.'}};
    }}});
    const workspace=await scenarios.save({name:'Wrong destination',yaml,flows,mock:{environment,port:mockPort,routeId:environment.routes[0].uuid,responseId:environment.routes[0].responses[1].uuid,backendUrl:'http://127.0.0.1:4321',passthroughRouteIds:[],fromScreen:'Home',toScreen:'Maintenance',failureSemantics:'HTTP 500'}});
    const result=await scenarios.wait((await scenarios.start({workspaceId:workspace.id,deviceId})).id);
    assert.equal(result.status,'assertion-failed');assert.equal(result.steps[1].status,'failed');
    assert.equal(result.mock?.evidence.transactions[0].statusCode,500);
    assert.equal(result.cleanup.verified,true);
    assert.equal((await scenarios.artifact(result.id,'failure.png')).toString(),'fixture screen');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('cancellation destroys owned mock state before releasing the device', async () => {
  const root=await mkdtemp(join(tmpdir(),'tnt-mock-cancel-'));
  let started!:()=>void;const gate=new Promise<void>(resolve=>{started=resolve;});
  try {
    const device=runner(root);
    const scenarios=createScenarios({root,runner:device,maestro:{version:async()=> '2.11.0',run:async({signal})=>{
      assert.equal((await fetch(`http://127.0.0.1:${mockPort}/items`)).status,500);
      started();
      await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
      return {code:null,log:'Cancelled fixture execution',cleanup:{verified:true,detail:'Fixture process stopped.'}};
    }}});
    const workspace=await scenarios.save({name:'Cancelled mock',yaml,flows,mock:{environment,port:mockPort,routeId:environment.routes[0].uuid,responseId:environment.routes[0].responses[1].uuid,backendUrl:'http://127.0.0.1:4321',passthroughRouteIds:[],fromScreen:'Home',toScreen:'Maintenance',failureSemantics:'HTTP 500'}});
    const run=await scenarios.start({workspaceId:workspace.id,deviceId});await gate;
    await assert.rejects(device.acquireDevice(deviceId),/in progress/);
    const result=await scenarios.cancel(run.id);
    assert.equal(result.status,'cancelled');assert.equal(result.cleanup.verified,true);assert.equal(result.mock?.cleanup.verified,true);
    await assert.rejects(fetch(`http://127.0.0.1:${mockPort}/items`));
    const release=await device.acquireDevice(deviceId);await release();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('fallback cannot forward requests recursively to a loopback alias of the owned mock', async () => {
  const root=await mkdtemp(join(tmpdir(),'tnt-self-proxy-'));
  try {
    const scenarios=createScenarios({root,runner:runner(root),maestro:{version:async()=> '2.11.0',run:async()=>{throw new Error('Must not execute');}}});
    for (const hostname of ['localhost','localhost.','127.0.0.2','[::1]','[::ffff:127.0.0.1]']) {
      await assert.rejects(scenarios.save({name:'Self proxy',yaml,flows,mock:{environment,port:mockPort,routeId:environment.routes[0].uuid,responseId:environment.routes[0].responses[1].uuid,backendUrl:`http://${hostname}:${mockPort}`,passthroughRouteIds:[],fromScreen:'Home',toScreen:'Maintenance',failureSemantics:'HTTP 500'}}),/mock itself/);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
