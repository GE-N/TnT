import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';

const yaml='appId: com.example.App\n---\n- launchApp\n';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'tnt-workspaces-'));
 const service=createScenarios({root,runner:createRunner({artifactDirectory:root,execute:async()=>{throw new Error('Must not execute');}}),maestro:{version:async()=>'',run:async()=>{throw new Error('Must not execute');}}});
 return {root,service,close:()=>rm(root,{recursive:true,force:true})};
}
test('the workspace library searches all saved work and opening determines recency independently of saves',async()=>{
 const {service,close}=await fixture();
 try{
  const first=await service.save({name:'Older work',yaml});
  for(let i=0;i<6;i++)await service.save({name:'Recent '+i,yaml});
  assert.equal((await service.listWorkspaces('Older')).items[0].id,first.id);
  await service.openWorkspace(first.id);
  await service.save({...first,name:'Renamed work'});
  const library=await service.listWorkspaces();
  assert.equal(library.items.length,7);
  assert.equal(library.items[0].id,first.id);
  assert.equal(library.items[0].name,'Renamed work');
  assert.ok(library.items[0].createdAt);
 }finally{await close();}
});

test('legacy and duplicate-name workspaces remain discoverable beside unreadable records and unsafe links',async()=>{
 const {root,service,close}=await fixture();
 const {mkdir,writeFile,symlink}=await import('node:fs/promises');
 try{
  const first=await service.save({name:'Same name',yaml});const second=await service.save({name:'Same name',yaml});
  await writeFile(join(root,'workspaces',first.id,'workspace.json'),JSON.stringify({id:first.id,name:first.name,yaml}));
  const broken='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';await mkdir(join(root,'workspaces',broken));await writeFile(join(root,'workspaces',broken,'workspace.json'),'{broken');
  const unsafe='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';await symlink(join(root,'workspaces',first.id),join(root,'workspaces',unsafe));
  const list=await service.listWorkspaces('same');assert.equal(list.items.length,2);assert.equal(list.unreadable,2);assert.deepEqual(new Set(list.items.map(item=>item.id)),new Set([first.id,second.id]));
  assert.equal((await service.openWorkspace(first.id)).name,'Same name');
  await assert.rejects(service.workspace('../escape'));
  await assert.rejects(service.workspace('cccccccc-cccc-cccc-cccc-cccccccccccc'),/ENOENT/);
 }finally{await close();}
});

test('copies preserve authored internal references and exclude outer identity, runtime and execution ownership',async()=>{
 const {service,close}=await fixture();
 try{
  const original=await service.save({name:'Original',yaml,canvas:{screens:[{id:'home',title:'Home',x:0,y:0,tests:[]}],edges:[],paths:[{id:'route',name:'Scenario',scenarioId:'scenario',screenId:'home',edgeIds:[],visits:[{id:'visit'}]}]},scenarios:[{id:'scenario',name:'Scenario',authoring:'canvas',pathId:'route',steps:[],inputs:{},parameters:{},enabledHandlerIds:[]}]});
  const copy=await service.copyWorkspace({...original,name:'Copy',runtimeInputs:{PASSWORD:'private'},token:'private',run:{status:'passed'}} as Parameters<typeof service.copyWorkspace>[0]);
  assert.notEqual(copy.id,original.id);assert.deepEqual(copy.canvas,original.canvas);assert.deepEqual(copy.scenarios,original.scenarios);
  assert.ok(!JSON.stringify(copy).includes('private'));assert.ok(!JSON.stringify(copy).includes('passed'));
  await service.renameWorkspace(copy.id,'  Edited copy  ',copy.metadata!.revision);assert.equal((await service.workspace(original.id)).name,'Original');
  assert.equal((await service.workspace(copy.id)).name,'Edited copy');
  const count=(await service.listWorkspaces()).items.length;
  await assert.rejects(service.copyWorkspace({...original,name:'Broken',yaml:'broken: ['}));
  assert.equal((await service.listWorkspaces()).items.length,count);
 }finally{await close();}
});

test('serialized opens and renames retain metadata; failed writes preserve the previous saved record',async()=>{
 const {root,service,close}=await fixture();const {chmod}=await import('node:fs/promises');let path='';
 try{
  const workspace=await service.save({name:'Original',yaml});path=join(root,'workspaces',workspace.id);
  const [,renamed]=await Promise.all([service.openWorkspace(workspace.id),service.renameWorkspace(workspace.id,'Renamed',workspace.metadata!.revision)]);
  assert.equal((await service.workspace(workspace.id)).metadata?.openedAt,renamed.metadata?.openedAt);
  await chmod(path,0o500);
  await assert.rejects(service.save({...renamed,name:'Failure'}),/EACCES/);
  const retained=await service.workspace(workspace.id);assert.equal(retained.name,'Renamed');assert.deepEqual(retained.metadata,renamed.metadata);
  await chmod(path,0o700);await service.save({...retained,name:'Retry succeeded'});assert.equal((await service.workspace(workspace.id)).name,'Retry succeeded');
 }finally{if(path)await chmod(path,0o700);await close();}
});

test('workspace discovery and management require the existing authenticated same-origin HTTP session',async()=>{
 const {root,service,close}=await fixture();const {createServer}=await import('node:http');const {createApiHandler}=await import('../server/http.js');
 const runner=createRunner({artifactDirectory:root,execute:async()=>({stdout:'{"devices":{}}',stderr:''})});
 const server=createServer(createApiHandler(runner,root,undefined,service));
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  const source=await service.save({name:'HTTP workspace',yaml});
  assert.equal((await fetch(base+'/api/workspaces')).status,403);
  const {token}=await (await fetch(base+'/api/status')).json();const headers={'X-TnT-Token':token,'Content-Type':'application/json',Origin:base};
  assert.equal((await fetch(base+'/api/workspaces/'+source.id+'/rename',{method:'POST',headers:{...headers,Origin:'https://foreign.example'},body:JSON.stringify({name:'Wrong origin'})})).status,403);
  const library=await (await fetch(base+'/api/workspaces?q=HTTP',{headers})).json();assert.equal(library.items[0].name,'HTTP workspace');
  const renamed=await fetch(base+'/api/workspaces/'+source.id+'/rename',{method:'POST',headers,body:JSON.stringify({name:'Renamed HTTP',expectedRevision:source.metadata!.revision})});assert.equal(renamed.status,200);
  const stale=await fetch(base+'/api/workspaces',{method:'POST',headers,body:JSON.stringify({...source,name:'Stale HTTP'})});assert.equal(stale.status,409);
  const opened=await (await fetch(base+'/api/workspaces/'+source.id+'/open',{method:'POST',headers,body:'{}'})).json();assert.equal(opened.name,'Renamed HTTP');
  const copy=await (await fetch(base+'/api/workspaces/copy',{method:'POST',headers,body:JSON.stringify({...opened,name:'HTTP copy'})})).json();assert.notEqual(copy.id,source.id);assert.equal((await service.listWorkspaces()).items.length,2);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await close();}
});

test('an accepted large canvas and its legacy formatted record reopen through workspace discovery',async()=>{
 const {root,service,close}=await fixture();const {writeFile}=await import('node:fs/promises');
 try{
  const canvas={screens:Array.from({length:10},(_,screen)=>({id:'screen-'+screen,title:'Screen '+screen,x:0,y:0,tests:Array.from({length:300},(_,test)=>({id:'test-'+screen+'-'+test,label:'Test',role:'test' as const,reference:{kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'a'.repeat(64)}}))})),edges:[],paths:[]};
  const saved=await service.save({name:'Large legacy canvas',yaml,canvas});
  await writeFile(join(root,'workspaces',saved.id,'workspace.json'),JSON.stringify(saved,null,2));
  assert.equal((await service.workspace(saved.id)).canvas?.screens[9].tests.length,300);
  assert.equal((await service.listWorkspaces('Large')).items[0].id,saved.id);
 }finally{await close();}
});

test('competing editor revisions reject stale and delayed saves without overwriting acknowledged content',async()=>{
 const {service,close}=await fixture();
 try{
  const original=await service.save({name:'Original',yaml});
  const results=await Promise.allSettled([service.save({...original,name:'First editor'}),service.save({...original,name:'Second editor'})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(String((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason),/newer revision/i);
  await assert.rejects(service.save({...original,name:'Delayed edit'}),/newer revision/i);
  const current=await service.workspace(original.id);assert.equal(current.name,'First editor');assert.equal(current.metadata?.revision,2);
  assert.equal(current.metadata?.openedAt,original.metadata?.openedAt);
 }finally{await close();}
});

test('malformed revision metadata is unreadable while legacy records without metadata remain editable',async()=>{
 const {root,service,close}=await fixture();const {writeFile}=await import('node:fs/promises');
 try{
  const original=await service.save({name:'Legacy',yaml});const path=join(root,'workspaces',original.id,'workspace.json');
  await writeFile(path,JSON.stringify({...original,metadata:{...original.metadata,revision:'bad'}}));
  await assert.rejects(service.workspace(original.id),/Unreadable workspace revision/);
  assert.equal((await service.listWorkspaces()).unreadable,1);
  await writeFile(path,JSON.stringify({id:original.id,name:'Legacy',yaml}));
  const legacy=await service.workspace(original.id);assert.equal(legacy.metadata?.revision,0);
  const edited=await service.save({...legacy,name:'Updated legacy'});assert.equal(edited.metadata?.revision,1);assert.equal((await service.workspace(original.id)).name,'Updated legacy');
 }finally{await close();}
});
