import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
import {ScriptTrustConflict} from '../server/script-trust-store.js';
const yaml='appId: com.example.App\n---\n- launchApp\n';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'tnt-trust-'));const trustDirectory=join(root,'trust');
 const options={root,trustDirectory,runner:createRunner({artifactDirectory:root,execute:async()=>{throw new Error('No device calls');}}),maestro:{version:async()=>{throw new Error('No Maestro');},run:async()=>{throw new Error('No Maestro');}}};
 const service=createScenarios(options);const refs=(await service.references({yaml})).references;
 const row={id:'one',label:'One',source:'globalThis.marker=true',beforeStep:{index:0,fingerprint:refs[0].fingerprint}};
 const workspace=await service.save({name:'Scripts',yaml,scenarios:[{id:'first',name:'First',steps:refs,inputs:{},parameters:{},enabledHandlerIds:[],scripts:[row,{...row,id:'two'}]}]});
 return {root,trustDirectory,options,service,workspace};
}
test('import provenance persists unverified file claims and copy provenance captures the local source name',async()=>{
 const f=await fixture();try{
  const exported=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const claimed=structuredClone(exported.package);claimed.workspace.name='Claimed source · ไทย';
  const imported=await f.service.importWorkspace({package:claimed,name:'Destination',filename:'unverified-export.json'});
  const source={kind:'import' as const,name:'Claimed source · ไทย',filename:'unverified-export.json'};
  assert.deepEqual(imported.metadata!.sourceWorkspace,source);
  let restarted=createScenarios(f.options);
  assert.deepEqual((await restarted.workspace(imported.id)).metadata!.sourceWorkspace,source);
  assert.deepEqual((await restarted.scriptTrust(imported.id)).sourceWorkspace,source);
  const trust=(await restarted.scriptTrust(imported.id)).scripts[0];assert.equal(trust.trusted,false);
  const approved=await restarted.trustScript({workspace:imported.id,rowId:trust.rowId,hash:trust.hash});assert.deepEqual(approved.sourceWorkspace,source);
  const saved=await restarted.save({...await restarted.workspace(imported.id),metadata:{...imported.metadata!,sourceWorkspace:{kind:'copy',name:'Forged verified name'}}});
  assert.deepEqual(saved.metadata!.sourceWorkspace,source,'Ordinary saves cannot overwrite server provenance');
  await restarted.renameWorkspace(imported.id,'Renamed destination',saved.metadata!.revision);await restarted.openWorkspace(imported.id);
  await restarted.trashWorkspace(imported.id);await restarted.restoreWorkspace(imported.id);
  restarted=createScenarios(f.options);assert.deepEqual((await restarted.scriptTrust(imported.id)).sourceWorkspace,source);
  const copy=await restarted.copyWorkspace({...await restarted.workspace(imported.id),id:undefined,sourceWorkspaceId:imported.id,name:'Copied destination'});
  const localSource={kind:'copy' as const,name:'Renamed destination'};
  assert.deepEqual(copy.metadata!.sourceWorkspace,localSource);
  assert.deepEqual((await createScenarios(f.options).scriptTrust(copy.id)).sourceWorkspace,localSource);
  assert.ok((await restarted.scriptTrust(copy.id)).scripts.every(row=>!row.trusted),'A local source name never transfers script approvals');
  const again=await restarted.exportWorkspace({id:copy.id,expectedRevision:1,includeValues:true});
  assert.equal((again.package.workspace as any).metadata,undefined,'Local provenance is not asserted as a verified origin in exports');
  const legacy=await restarted.importWorkspace({package:exported.package,name:'Legacy filename caller'});
  assert.deepEqual(legacy.metadata!.sourceWorkspace,{kind:'import',name:f.workspace.name,filename:null});
  const before=(await restarted.listWorkspaces()).items.length;
  await assert.rejects(restarted.importWorkspace({package:exported.package,name:'Invalid filename',filename:'../source.json'}),/import filename/);
  assert.equal((await restarted.listWorkspaces()).items.length,before);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('local trust, import per-workspace/per-row approval, durable hash invalidation and portable exclusion',async()=>{
 const f=await fixture();try{
  assert.ok((await f.service.scriptTrust(f.workspace.id)).scripts.every(item=>item.origin==='local'&&item.trusted));
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});assert.doesNotMatch(JSON.stringify(pkg.package),/trusted|approved|origin/);
  const imported=await f.service.importWorkspace({package:pkg.package,name:'Imported'});
  let list=(await f.service.scriptTrust(imported.id)).scripts;assert.ok(list.every(item=>item.origin==='imported'&&!item.trusted));
  await assert.rejects(f.service.start({workspaceId:imported.id,deviceId:'not-used',scenarioId:'first'}),/Script needs trust/);
  await f.service.trustScript({workspace:imported.id,rowId:'one',hash:list[0].hash});
  list=(await createScenarios(f.options).scriptTrust(imported.id)).scripts;assert.deepEqual(list.map(item=>item.trusted),[true,false]);
  const edited=structuredClone(imported);edited.scenarios![0].scripts![0].source+='; // edited';
  const saved=await f.service.save(edited);
  await assert.rejects(f.service.trustScript({workspace:imported.id,rowId:'one',hash:list[0].hash}),ScriptTrustConflict);
  assert.equal((await f.service.scriptTrust(imported.id)).scripts[0].trusted,false);
  const copy=await f.service.copyWorkspace(saved);assert.ok((await f.service.scriptTrust(copy.id)).scripts.every(item=>!item.trusted));
  const locallyNew=await f.service.save({...saved,scenarios:saved.scenarios!.map(scenario=>({...scenario,scripts:[...scenario.scripts!,{...scenario.scripts![0],id:'new',source:'output.unique = 1037'}]}))});
  assert.equal((await f.service.scriptTrust(locallyNew.id)).scripts.at(-1)!.origin,'local');
  assert.equal((globalThis as any).marker,undefined);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('server duplication assigns fresh script IDs and never transfers an imported approval',async()=>{
 const f=await fixture();try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const imported=await f.service.importWorkspace({package:pkg.package,name:'Duplicate source'});
  for(const trust of (await f.service.scriptTrust(imported.id)).scripts)await f.service.trustScript({workspace:imported.id,rowId:trust.rowId,hash:trust.hash});
  const duplicated=await f.service.duplicateScenario({workspaceId:imported.id,scenarioId:'first',expectedRevision:1});
  const copy=duplicated.scenarios!.at(-1)!;assert.notEqual(copy.id,'first');assert.equal(copy.scripts!.length,2);
  const original=duplicated.scenarios![0];assert.deepEqual(original.scripts,imported.scenarios![0].scripts);
  assert.ok(copy.scripts!.every(row=>!original.scripts!.some(source=>source.id===row.id)));
  assert.deepEqual(copy.scripts!.map(({id,...row})=>row),original.scripts!.map(({id,...row})=>row));
  const trust=(await f.service.scriptTrust(imported.id)).scripts;
  assert.ok(trust.filter(item=>copy.scripts!.some(row=>row.id===item.rowId)).every(item=>item.origin==='imported'&&!item.trusted));
  assert.ok(trust.filter(item=>original.scripts!.some(row=>row.id===item.rowId)).every(item=>item.trusted));
  await assert.rejects(f.service.duplicateScenario({workspaceId:imported.id,scenarioId:'first',expectedRevision:1}),/changed|revision/i);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('trust remains through trash/restore; store loss and corruption cannot trust old rows',async()=>{
 const f=await fixture();try{
  await f.service.trashWorkspace(f.workspace.id);await f.service.restoreWorkspace(f.workspace.id);
  assert.ok((await f.service.scriptTrust(f.workspace.id)).scripts.every(item=>item.trusted));
  const file=join(f.trustDirectory,'state.json');await rm(file);
  assert.ok((await f.service.scriptTrust(f.workspace.id)).scripts.every(item=>!item.trusted));
  await f.service.save(await f.service.workspace(f.workspace.id));assert.ok((await f.service.scriptTrust(f.workspace.id)).scripts.every(item=>!item.trusted));
  await writeFile(file,'{broken');await assert.rejects(f.service.scriptTrust(f.workspace.id),/unreadable/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('approval serializes against source edits and import publication failure is not runnable',async()=>{
 const f=await fixture();try{
  const list=(await f.service.scriptTrust(f.workspace.id)).scripts;
  const edit=structuredClone(f.workspace);edit.scenarios![0].scripts![0].source='output.changed = true';
  const [saved,approval]=await Promise.allSettled([f.service.save(edit),f.service.trustScript({workspace:f.workspace.id,rowId:'one',hash:list[0].hash})]);
  assert.equal(saved.status,'fulfilled');assert.equal(approval.status,'rejected');
  const faults={rejectWrite:()=>new Error('Publication failed')};const failing=createScenarios({...f.options,faults});
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:2,includeValues:true});
  await assert.rejects(failing.importWorkspace({package:pkg.package,name:'Fail'}),/Publication failed/);
  assert.equal((await f.service.listWorkspaces()).items.length,1);
  assert.doesNotMatch(await readFile(join(f.root,'workspaces',f.workspace.id,'workspace.json'),'utf8'),/approved|trusted|origin/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('copy preserves verified local origin; copied imported sources under new row IDs remain imported',async()=>{
 const f=await fixture();try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const imported=await f.service.importWorkspace({package:pkg.package,name:'Imported'});
  const copiedLocal=await f.service.copyWorkspace({...f.workspace,id:undefined,sourceWorkspaceId:f.workspace.id});assert.ok((await f.service.scriptTrust(copiedLocal.id)).scripts.every(item=>item.origin==='local'&&item.trusted));
  const edited=structuredClone(imported);edited.scenarios![0].scripts!.push({...edited.scenarios![0].scripts![0],id:'pasted'});
  const saved=await f.service.save(edited);assert.equal((await f.service.scriptTrust(saved.id)).scripts.at(-1)!.origin,'imported');
  const noScripts=await f.service.save({...f.workspace,scenarios:[]});await writeFile(join(f.trustDirectory,'state.json'),'unreadable');assert.deepEqual(await f.service.scriptTrust(noScripts.id),{scripts:[]});
 }finally{await rm(f.root,{recursive:true,force:true});}
});
for(const state of ['missing','trashed'] as const)test('copy with '+state+' source context falls back to untrusted imported rows',async()=>{
 const f=await fixture();try{
  if(state==='trashed')await f.service.trashWorkspace(f.workspace.id);
  const sourceWorkspaceId=state==='trashed'?f.workspace.id:'00000000-0000-4000-8000-000000000000';
  const copy=await f.service.copyWorkspace({...f.workspace,id:undefined,sourceWorkspaceId,name:'Conservative copy'});
  assert.notEqual(copy.id,f.workspace.id);assert.deepEqual(copy.scenarios![0].scripts,f.workspace.scenarios![0].scripts);
  assert.equal(copy.metadata!.sourceWorkspace,undefined,'An unavailable source is never presented as a verified local copy origin');
  const scripts=(await f.service.scriptTrust(copy.id)).scripts;assert.ok(scripts.every(item=>item.origin==='imported'&&!item.trusted));
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('copy never transfers imported approvals and unknown rows in a source-aware copy are untrusted',async()=>{
 const f=await fixture();try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});const imported=await f.service.importWorkspace({package:pkg.package,name:'Approved import'});
  for(const trust of (await f.service.scriptTrust(imported.id)).scripts)await f.service.trustScript({workspace:imported.id,rowId:trust.rowId,hash:trust.hash});
  assert.ok((await f.service.scriptTrust(imported.id)).scripts.every(item=>item.trusted));
  const copy=await f.service.copyWorkspace({...imported,id:undefined,sourceWorkspaceId:imported.id});assert.ok((await f.service.scriptTrust(copy.id)).scripts.every(item=>item.origin==='imported'&&!item.trusted));
  const input=structuredClone(f.workspace);input.scenarios![0].scripts![0].source='output.changedInCopy = 102938';input.scenarios![0].scripts!.push({...input.scenarios![0].scripts![0],id:'unknown',source:'output.unseen = 918273'});
  const extra=await f.service.copyWorkspace({...input,id:undefined,sourceWorkspaceId:f.workspace.id});const trust=(await f.service.scriptTrust(extra.id)).scripts.find(item=>item.rowId==='unknown')!;assert.equal(trust.origin,'imported');assert.equal(trust.trusted,false);
  const copiedTrust=(await f.service.scriptTrust(extra.id)).scripts;assert.equal(copiedTrust.find(item=>item.rowId==='one')!.trusted,false);assert.equal(copiedTrust.find(item=>item.rowId==='one')!.origin,'imported');assert.equal(copiedTrust.find(item=>item.rowId==='two')!.origin,'local');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
