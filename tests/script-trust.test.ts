import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
import {importedTombstoneCap,ScriptTrustConflict} from '../server/script-trust-store.js';
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
  const persisted=(await createScenarios(f.options).scriptTrust(imported.id)).scripts;
  assert.ok(persisted.filter(item=>copy.scripts!.some(row=>row.id===item.rowId)).every(item=>item.origin==='imported'&&!item.trusted));
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
test('copy preserves verified local origin; brand-new editor IDs are local even for imported text',async()=>{
 const f=await fixture();try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const imported=await f.service.importWorkspace({package:pkg.package,name:'Imported'});
  const copiedLocal=await f.service.copyWorkspace({...f.workspace,id:undefined,sourceWorkspaceId:f.workspace.id});assert.ok((await f.service.scriptTrust(copiedLocal.id)).scripts.every(item=>item.origin==='local'&&item.trusted));
  const edited=structuredClone(imported);edited.scenarios![0].scripts!.push({...edited.scenarios![0].scripts![0],id:'pasted'});
  const saved=await f.service.save(edited);const added=(await f.service.scriptTrust(saved.id)).scripts.at(-1)!;assert.equal(added.origin,'local');assert.equal(added.trusted,true);
  const noScripts=await f.service.save({...f.workspace,scenarios:[]});await writeFile(join(f.trustDirectory,'state.json'),'unreadable');assert.deepEqual(await f.service.scriptTrust(noScripts.id),{scripts:[]});
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('Undo restores a deleted local row as local/trusted even when its source was imported elsewhere',async()=>{
 const f=await fixture();try{
  const exported=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const imported=await f.service.importWorkspace({package:exported.package,name:'Same source elsewhere'});
  assert.ok((await f.service.scriptTrust(imported.id)).scripts.every(row=>row.origin==='imported'&&!row.trusted));
  for(const removeAll of [false,true]){
   const before=await f.service.workspace(f.workspace.id);const removed=await f.service.save({...before,scenarios:before.scenarios!.map(scenario=>({...scenario,scripts:removeAll?[]:scenario.scripts!.filter(row=>row.id!=='one')}))});
   const restarted=createScenarios(f.options);await restarted.save({...removed,scenarios:before.scenarios});
   const restored=(await restarted.scriptTrust(f.workspace.id)).scripts;assert.ok(restored.every(row=>row.origin==='local'&&row.trusted));
   assert.deepEqual((await restarted.workspace(f.workspace.id)).scenarios,before.scenarios);
  }
  assert.ok((await createScenarios(f.options).scriptTrust(imported.id)).scripts.every(row=>row.origin==='imported'&&!row.trusted));
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('Undo restores an imported row as imported/untrusted and still checks its approved hash',async()=>{
 const f=await fixture();try{
  const exported=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});const imported=await f.service.importWorkspace({package:exported.package,name:'Imported Undo'});
  let before=imported;
  for(const edited of [false,true]){
   if(edited){const row=(await f.service.scriptTrust(imported.id)).scripts[0];await f.service.trustScript({workspace:imported.id,rowId:row.rowId,hash:row.hash});}
   const deleted=await f.service.save({...before,scenarios:before.scenarios!.map(scenario=>({...scenario,scripts:scenario.scripts!.filter(row=>row.id!=='one')}))});
   const scenarios=structuredClone(before.scenarios!);if(edited)scenarios[0].scripts![0].source+='; // changed during restore';
   const restarted=createScenarios(f.options);before=await restarted.save({...deleted,scenarios});
   const row=(await restarted.scriptTrust(imported.id)).scripts.find(row=>row.rowId==='one')!;assert.equal(row.origin,'imported');assert.equal(row.trusted,false);
  }
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('client save cannot change an existing imported row ID to local, including with new source text',async()=>{
 const f=await fixture();try{
  const exported=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});const imported=await f.service.importWorkspace({package:exported.package,name:'Imported identity'});
  for(const edited of [false,true]){
   const current=await f.service.workspace(imported.id);const scripts=current.scenarios![0].scripts!.map(row=>({...row,source:row.source+(edited?'; // edited':''),origin:'local',trusted:true}));
   await f.service.save({...current,scenarios:[{...current.scenarios![0],scripts}]});
   assert.ok((await createScenarios(f.options).scriptTrust(imported.id)).scripts.every(row=>row.origin==='imported'&&!row.trusted));
  }
 }finally{await rm(f.root,{recursive:true,force:true});}
});
for(const destination of ['same-scenario','other-scenario'] as const)test('one save replacing an imported ID with identical source stays imported/untrusted: '+destination,async()=>{
 const f=await fixture();try{
  const exported=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});exported.package.workspace.scenarios![0].scripts!.splice(1);
  const imported=await f.service.importWorkspace({package:exported.package,name:'Imported replacement'});
  const original=imported.scenarios![0].scripts![0];const approval=(await f.service.scriptTrust(imported.id)).scripts[0];
  await f.service.trustScript({workspace:imported.id,rowId:original.id,hash:approval.hash});
  const replacement={...original,id:'replacement',origin:'local',trusted:true};
  const scenario={...imported.scenarios![0],id:destination==='same-scenario'?'first':'other',scripts:[replacement]};
  const saved=await f.service.save({...imported,scenarios:destination==='same-scenario'?[scenario]:[{...imported.scenarios![0],scripts:[]},scenario]});
  assert.equal(saved.scenarios!.flatMap(scenario=>scenario.scripts??[]).some(row=>row.id===original.id),false);
  const restarted=createScenarios(f.options);const trust=(await restarted.scriptTrust(imported.id)).scripts;
  assert.deepEqual(trust,[{rowId:replacement.id,origin:'imported',trusted:false,hash:approval.hash}]);
  await assert.rejects(restarted.start({workspaceId:imported.id,deviceId:'not-used',scenarioId:scenario.id}),/Script needs trust/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('scenario-switch retires local tombstones and keeps imported ones, including active rows',async()=>{
 const f=await fixture();try{
  const saved=await f.service.save({...f.workspace,scenarios:[...f.workspace.scenarios!,{...f.workspace.scenarios![0],id:'other',scripts:[{...f.workspace.scenarios![0].scripts![0],id:'other-row'}]}]});
  const exported=await f.service.exportWorkspace({id:saved.id,expectedRevision:2,includeValues:true});const imported=await f.service.importWorkspace({package:exported.package,name:'Tombstone lifecycle'});
  await f.service.saveView(imported.id,{scenarioId:'first'});
  await f.service.save({...imported,scenarios:imported.scenarios!.map(scenario=>({...scenario,scripts:scenario.scripts!.filter(row=>row.id==='two')}))});
  const readEntries=async()=>JSON.parse(await readFile(join(f.trustDirectory,'state.json'),'utf8')).workspaces[imported.id];
  assert.equal((await readEntries()).one.origin,'imported');assert.equal((await readEntries())['other-row'].origin,'imported');
  await f.service.saveView(imported.id,{panels:{advanced:true}});assert.ok((await readEntries()).one,'Unrelated view saves leave the Undo window open');
  const restarted=createScenarios(f.options);await restarted.saveView(imported.id,{scenarioId:'other'});
  const entries=await readEntries();assert.equal(entries.one.origin,'imported','An imported tombstone survives the scenario switch');assert.equal(entries['other-row'].origin,'imported','An unrelated scenario tombstone remains');
  assert.equal(entries.two.origin,'imported','Active imported IDs are never retired');
  assert.ok((await restarted.scriptTrust(imported.id)).scripts.every(row=>row.origin==='imported'&&!row.trusted));
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('scenario switching tolerates trust-store failure while the script trust gate stays closed',async()=>{
 const f=await fixture();try{
  await f.service.saveView(f.workspace.id,{scenarioId:'first'});
  const file=join(f.trustDirectory,'state.json');await writeFile(file,'unreadable');
  await f.service.saveView(f.workspace.id,{scenarioId:'other'});
  assert.equal(await readFile(file,'utf8'),'unreadable','Failed retirement must not replace provenance');
  await assert.rejects(f.service.scriptTrust(f.workspace.id),/unreadable/);
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
  assert.notEqual(copy.id,imported.id);assert.ok((await createScenarios(f.options).scriptTrust(copy.id)).scripts.every(item=>item.origin==='imported'&&!item.trusted));
  const input=structuredClone(f.workspace);input.scenarios![0].scripts![0].source='output.changedInCopy = 102938';input.scenarios![0].scripts!.push({...input.scenarios![0].scripts![0],id:'unknown',source:'output.unseen = 918273'});
  const extra=await f.service.copyWorkspace({...input,id:undefined,sourceWorkspaceId:f.workspace.id});const trust=(await f.service.scriptTrust(extra.id)).scripts.find(item=>item.rowId==='unknown')!;assert.equal(trust.origin,'imported');assert.equal(trust.trusted,false);
  const copiedTrust=(await f.service.scriptTrust(extra.id)).scripts;assert.equal(copiedTrust.find(item=>item.rowId==='one')!.trusted,false);assert.equal(copiedTrust.find(item=>item.rowId==='one')!.origin,'imported');assert.equal(copiedTrust.find(item=>item.rowId==='two')!.origin,'local');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('a returning imported row id stays imported after a scenario switch',async()=>{
 const f=await fixture();const deviceId='E5C92F6E-40DC-493C-93B4-469E67193736';try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const imported=await f.service.importWorkspace({package:pkg.package,name:'Imp',filename:'x.json'});
  const base=imported.scenarios![0];const row=base.scripts![0];const other={...base,id:'b',name:'B',scripts:[] as typeof base.scripts};
  await f.service.saveView(imported.id,{scenarioId:base.id});
  const emptied=await f.service.save({...imported,scenarios:[{...base,scripts:[]},other]});
  await f.service.saveView(emptied.id,{scenarioId:'b'});
  await f.service.saveView(emptied.id,{scenarioId:base.id});
  const same=await f.service.save({...await f.service.workspace(emptied.id),scenarios:[{...base,scripts:[row]},other]});
  const trust=(await f.service.scriptTrust(same.id)).scripts.find(item=>item.rowId===row.id)!;
  assert.equal(trust.origin,'imported');assert.equal(trust.trusted,false);
  await assert.rejects(f.service.start({workspaceId:same.id,deviceId,scenarioId:base.id}),/Script needs trust/);
  const moved=await f.service.save({...await f.service.workspace(same.id),scenarios:[{...base,scripts:[]},{...other,scripts:[row]}]});
  const elsewhere=(await f.service.scriptTrust(moved.id)).scripts.find(item=>item.rowId===row.id)!;
  assert.equal(elsewhere.origin,'imported');assert.equal(elsewhere.trusted,false);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('scenario switch still retires a local tombstone, and imported tombstones are capped per workspace',async()=>{
 const f=await fixture();try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const second=await f.service.save({...f.workspace,scenarios:[...f.workspace.scenarios!,{...f.workspace.scenarios![0],id:'b',name:'B',scripts:[]}]});
  await f.service.saveView(second.id,{scenarioId:'first'});
  const cleared=await f.service.save({...second,scenarios:second.scenarios!.map(scenario=>({...scenario,scripts:[]}))});
  await f.service.saveView(cleared.id,{scenarioId:'b'});
  const localEntries=JSON.parse(await readFile(join(f.trustDirectory,'state.json'),'utf8')).workspaces[cleared.id];
  assert.equal(localEntries.one,undefined,'A local tombstone retires when its scenario closes');
  const restored=await f.service.save({...await f.service.workspace(cleared.id),scenarios:[{...f.workspace.scenarios![0],scripts:f.workspace.scenarios![0].scripts}, {...f.workspace.scenarios![0],id:'b',name:'B',scripts:[]}]});
  assert.equal((await f.service.scriptTrust(restored.id)).scripts.find(item=>item.rowId==='one')!.origin,'local');
  const imported=await f.service.importWorkspace({package:pkg.package,name:'Capped'});
  const emptied=await f.service.save({...imported,scenarios:[{...imported.scenarios![0],scripts:[]},{...imported.scenarios![0],id:'b',name:'B',scripts:[]}]});
  await f.service.saveView(emptied.id,{scenarioId:'first'});
  const file=join(f.trustDirectory,'state.json');const state=JSON.parse(await readFile(file,'utf8'));
  const entries=state.workspaces[imported.id];
  for(let index=0;index<importedTombstoneCap+2;index++)entries['old-'+String(index).padStart(4,'0')]={origin:'imported',scenarioId:'first'};
  await writeFile(file,JSON.stringify(state));
  await f.service.saveView(imported.id,{scenarioId:'b'});
  const kept=JSON.parse(await readFile(file,'utf8')).workspaces[imported.id];
  const tombstones=Object.keys(kept).filter(id=>id.startsWith('old-'));
  assert.equal(tombstones.length,importedTombstoneCap);
  assert.equal(kept['old-0000'],undefined);assert.equal(kept['old-0001'],undefined);
  assert.equal(kept['old-'+String(importedTombstoneCap+1).padStart(4,'0')].origin,'imported');
  const survivor='old-'+String(importedTombstoneCap+1).padStart(4,'0');
  const row={...imported.scenarios![0].scripts![0],id:survivor};
  const back=await f.service.save({...await f.service.workspace(imported.id),scenarios:[{...imported.scenarios![0],scripts:[row]},{...imported.scenarios![0],id:'b',name:'B',scripts:[]}]});
  const trust=(await f.service.scriptTrust(back.id)).scripts.find(item=>item.rowId===survivor)!;
  assert.equal(trust.origin,'imported');assert.equal(trust.trusted,false);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('import rejects control characters and right-to-left overrides in the claimed name and filename',async()=>{
 const f=await fixture();try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const filenames=['a\u0001b.json','a\nb.json','a\rb.json','a\tb.json','a\u001b[31mb.json','a\u007fb.json','a\u0085b.json','\u202Enosj.exe','\u2067x.json','a\u200Eb.json'];
  for(const filename of filenames)await assert.rejects(f.service.importWorkspace({package:pkg.package,name:'Dest',filename}),/import filename/);
  for(const name of ['A\u0001B','\u202EA','A\nB']){
   const claimed=structuredClone(pkg.package);claimed.workspace.name=name;
   await assert.rejects(f.service.importWorkspace({package:claimed,name:'Dest',filename:'ok.json'}),/source workspace name/);
  }
  const thai=structuredClone(pkg.package);thai.workspace.name='ชื่อ ไทย';
  const accepted=await f.service.importWorkspace({package:thai,name:'Dest',filename:'ชื่อ.json'});
  assert.deepEqual(accepted.metadata!.sourceWorkspace,{kind:'import',name:'ชื่อ ไทย',filename:'ชื่อ.json'});
  const emoji=structuredClone(pkg.package);emoji.workspace.name='Family \u200D test';
  const zwj=await f.service.importWorkspace({package:emoji,name:'Dest',filename:'emoji\u200D.json'});
  assert.equal(zwj.metadata!.sourceWorkspace?.kind,'import');
  const invisible=['\u200B','\uFEFF','\u200C','\u061C','\u2028','\u2029'];
  for(const mark of invisible){
   await assert.rejects(f.service.importWorkspace({package:pkg.package,name:'Dest',filename:'a'+mark+'b.json'}),/import filename/);
   const claimed=structuredClone(pkg.package);claimed.workspace.name='A'+mark+'B';
   await assert.rejects(f.service.importWorkspace({package:claimed,name:'Dest',filename:'ok.json'}),/source workspace name/);
  }
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('new titles reject bidirectional controls, and a legacy title can still be saved, copied, and exported',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.service.save({...f.workspace,id:undefined,name:'Hello\u202E'}),/source workspace name/);
  await assert.rejects(f.service.renameWorkspace(f.workspace.id,'Hello\u202E',f.workspace.metadata!.revision),/source workspace name/);
  await assert.rejects(f.service.copyWorkspace({...f.workspace,id:undefined,name:'Copy\u202E'}),/source workspace name/);
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  await assert.rejects(f.service.importWorkspace({package:pkg.package,name:'Import\u202E',filename:'ok.json'}),/source workspace name/);
  const zwj=await f.service.save({...f.workspace,id:undefined,name:'Family \u200D ok'});
  assert.equal(zwj.name,'Family \u200D ok');
  const file=join(f.root,'workspaces',f.workspace.id,'workspace.json');
  const raw=JSON.parse(await readFile(file,'utf8'));
  raw.name='Re\u202Eport\u200Bjson';
  await writeFile(file,JSON.stringify(raw));
  const opened=await f.service.workspace(f.workspace.id);
  assert.equal(opened.name,'Re\u202Eport\u200Bjson');
  const saved=await f.service.save(opened);
  assert.equal(saved.name,'Re\u202Eport\u200Bjson');
  const copy=await f.service.copyWorkspace({...opened,id:undefined,sourceWorkspaceId:opened.id,name:'Clean copy'});
  assert.equal(copy.name,'Clean copy');
  assert.equal(copy.metadata!.sourceWorkspace?.name,'Reportjson');
  const exported=await f.service.exportWorkspace({id:opened.id,expectedRevision:saved.metadata!.revision,includeValues:true});
  assert.equal(exported.package.workspace.name,'Reportjson');
  const imported=await f.service.importWorkspace({package:exported.package,name:'Imported',filename:'ok.json'});
  assert.equal(imported.metadata!.sourceWorkspace?.name,'Reportjson');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('an invalid stored source claim is dropped on read instead of locking the workspace',async()=>{
 const f=await fixture();try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const imported=await f.service.importWorkspace({package:pkg.package,name:'Dest',filename:'ok.json'});
  const file=join(f.root,'workspaces',imported.id,'workspace.json');
  const raw=JSON.parse(await readFile(file,'utf8'));
  raw.metadata.sourceWorkspace.filename='report\u202Ejson.exe';
  await writeFile(file,JSON.stringify(raw));
  const opened=await f.service.workspace(imported.id);
  assert.equal(opened.metadata!.sourceWorkspace,undefined);
  assert.equal(opened.name,'Dest');
  assert.equal((await f.service.scriptTrust(imported.id)).scripts[0].origin,'imported');
  assert.equal((await f.service.listWorkspaces()).items.some(item=>item.id===imported.id),true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('an imported row id evicted by the tombstone cap comes back imported and untrusted',async()=>{
 const f=await fixture();try{
  const pkg=await f.service.exportWorkspace({id:f.workspace.id,expectedRevision:1,includeValues:true});
  const imported=await f.service.importWorkspace({package:pkg.package,name:'Capped',filename:'rows.json'});
  const file=join(f.trustDirectory,'state.json');const state=JSON.parse(await readFile(file,'utf8'));
  const entries=state.workspaces[imported.id];
  for(let index=0;index<importedTombstoneCap;index++)entries['old-'+String(index).padStart(4,'0')]={origin:'imported',scenarioId:'first'};
  await writeFile(file,JSON.stringify(state));
  const before=Object.keys(entries);
  const emptied=await f.service.save({...imported,scenarios:[{...imported.scenarios![0],scripts:[]}]});
  const kept=JSON.parse(await readFile(file,'utf8'));
  const evicted=before.filter(id=>!kept.workspaces[imported.id][id]);
  assert.ok(evicted.includes('one')&&evicted.includes('two'));
  assert.ok(kept.importedOverflow.includes(imported.id));
  const row={...imported.scenarios![0].scripts![0],id:evicted[0]};
  const back=await f.service.save({...await f.service.workspace(emptied.id),scenarios:[{...imported.scenarios![0],scripts:[row,{...row,id:'brandnew',source:'globalThis.other=true'}]}]});
  for(const id of [evicted[0],'brandnew']){
   const trust=(await f.service.scriptTrust(back.id)).scripts.find(item=>item.rowId===id)!;
   assert.equal(trust.origin,'imported',id);assert.equal(trust.trusted,false,id);
  }
  await assert.rejects(f.service.start({workspaceId:back.id,deviceId:'not-used',scenarioId:'first'}),/Script needs trust/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
