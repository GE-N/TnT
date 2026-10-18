import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createApiHandler} from '../server/http.js';
import {scriptFixture,deviceId} from './run-script-helpers.js';
async function fixture(){
 const f=await scriptFixture({mock:true});const server=createServer(createApiHandler(f.runner,f.root,undefined,f.service));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No port');const base=`http://127.0.0.1:${address.port}`;
 const token=(await (await fetch(base+'/api/status')).json()).token;
 const request=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'x-tnt-token':token,origin:base,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {...f,request,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.cleanup();}};
}
test('Run returns typed 422 before any launch; trust routes require origin/session and stale hash is 409',async()=>{
 const f=await fixture();try{
  await f.service.save({...f.workspace,scenarios:[{...f.scenario,scripts:[{...f.row,source:' '}]}]});const before=f.stats();
  const blocked=await f.request('/api/runs',{workspaceId:f.workspace.id,deviceId,scenarioId:'one'});assert.equal(blocked.status,422);assert.equal(blocked.headers.get('cache-control'),'no-store');assert.equal((await blocked.json()).blocked[0].message,'Script is empty · add code or delete the row');assert.deepEqual(f.stats(),before);
  const list=await f.request('/api/scripts/trust?workspace='+f.workspace.id);const {scripts}=await list.json();assert.equal(scripts.length,1);
  const stale=await f.request('/api/scripts/trust',{workspace:f.workspace.id,rowId:f.row.id,hash:'a'.repeat(64)});assert.equal(stale.status,409);
  const good=await f.request('/api/scripts/trust',{workspace:f.workspace.id,rowId:f.row.id,hash:scripts[0].hash});assert.equal(good.status,200);
  const bulk=await f.request('/api/scripts/trust',{workspace:f.workspace.id,scripts,trustAll:true});assert.equal(bulk.status,400);
  const cross=await f.request('/api/scripts/trust',{workspace:f.workspace.id,rowId:f.row.id,hash:scripts[0].hash},{origin:'http://other.local'});assert.equal(cross.status,403);
  const anonymous=await f.request('/api/scripts/trust?workspace='+f.workspace.id,undefined,{'x-tnt-token':''});assert.equal(anonymous.status,403);
 }finally{await f.close();}
});
test('reserved input and variable errors are structured at save/import/runtime/preflight, including unused nested flows',async()=>{
 const f=await fixture();try{
  const badYaml=f.workspace.yaml.replace('tapOn: Load','evalScript: ${TNT_MOCK_TOKEN + ""}');
  const save=await f.request('/api/workspaces',{...f.workspace,yaml:badYaml});assert.equal(save.status,400);assert.equal((await save.json()).blocked[0].kind,'reserved-variable');
  const unused=await f.request('/api/workspaces',{...f.workspace,flows:{'unused.yaml':badYaml}});assert.equal(unused.status,400);
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});pkg.package.workspace.yaml=badYaml;
  const imported=await f.request('/api/workspaces/import',{package:pkg.package,name:'Rejected'});assert.equal(imported.status,400);assert.equal((await imported.json()).blocked[0].message,'Reserved TnT variable');
  const runtime=await f.request('/api/runs',{workspaceId:f.workspace.id,deviceId,scenarioId:'one',runtimeInputs:{TNT_MOCK_URL:'shadow'}});assert.equal(runtime.status,422);assert.equal((await runtime.json()).blocked[0].kind,'reserved-input');
  const disk={...f.workspace,yaml:badYaml};await writeFile(join(f.root,'workspaces',f.workspace.id,'workspace.json'),JSON.stringify(disk));
  const before=f.stats();const preflight=await f.request('/api/runs',{workspaceId:f.workspace.id,deviceId,scenarioId:'one'});assert.equal(preflight.status,422);assert.deepEqual(f.stats(),before);
 }finally{await f.close();}
});
