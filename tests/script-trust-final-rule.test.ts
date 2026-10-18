// Adapted from Edison's #83 acceptance cases R1–R7; no device or Maestro execution.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
const yaml='appId: com.example.App\n---\n- launchApp\n';
async function fx(){
 const root=await mkdtemp(join(tmpdir(),'tnt-final-'));
 const options={root,trustDirectory:join(root,'trust'),runner:createRunner({artifactDirectory:root,execute:async()=>{throw new Error('No');}}),maestro:{version:async()=>'x',run:async()=>{throw new Error('No');}}};
 const service=createScenarios(options);
 const refs=(await service.references({yaml})).references;
 const mk=(id:string,source:string)=>({id,label:id,source,beforeStep:{index:0,fingerprint:refs[0].fingerprint}});
 const local=await service.save({name:'W',yaml,scenarios:[{id:'s',name:'S',steps:refs,inputs:{},parameters:{},enabledHandlerIds:[],scripts:[mk('one','output.a=1')]}]});
 const pkg=await service.exportWorkspace({id:local.id,expectedRevision:1,includeValues:true});
 const imported=await service.importWorkspace({package:pkg.package,name:'Imp',filename:'x.tnt'});
 // mixed: add a user-created local row to the imported workspace
 const cur=await service.workspace(imported.id);
 const mixed=await service.save({...cur,scenarios:[{...cur.scenarios![0],scripts:[...cur.scenarios![0].scripts!,mk('mine','output.mine=1')]}]});
 const trust=async(id:string)=>Object.fromEntries((await service.scriptTrust(id)).scripts.map(t=>[t.rowId,t]));
 return {root,options,service,local,mixed,mk,trust};
}
const done=(f:{root:string})=>rm(f.root,{recursive:true,force:true});
test('R1 editor-created row is local, even with imported text (no drop)',async()=>{const f=await fx();try{
 const w=await f.service.workspace(f.mixed.id);
 const s=await f.service.save({...w,scenarios:[{...w.scenarios![0],scripts:[...w.scenarios![0].scripts!,f.mk('pasted','output.a=1')]}]});
 const t=await f.trust(s.id);assert.equal(t.pasted.origin,'local');assert.equal(t.pasted.trusted,true);assert.equal(t.one.origin,'imported');
}finally{await done(f);}});
test('R2 duplicateScenario keeps each source row status under new ids',async()=>{const f=await fx();try{
 const d=await f.service.duplicateScenario({workspaceId:f.mixed.id,scenarioId:'s',expectedRevision:f.mixed.metadata!.revision});
 const copy=d.scenarios!.find(s=>s.id!=='s')!;const t=await f.trust(d.id);
 const [c1,c2]=copy.scripts!;assert.notEqual(c1.id,'one');assert.notEqual(c2.id,'mine');
 assert.equal(t[c1.id].origin,'imported');assert.equal(t[c1.id].trusted,false);assert.equal(t[c2.id].origin,'local');assert.equal(t[c2.id].trusted,true);
}finally{await done(f);}});
test('R3 copyWorkspace keeps each source row status',async()=>{const f=await fx();try{
 const src=await f.service.workspace(f.mixed.id);
 const c=await f.service.copyWorkspace({...src,id:undefined,name:'Copy',sourceWorkspaceId:src.id});
 assert.notEqual(c.id,src.id);const t=await f.trust(c.id);
 assert.equal(t.one.origin,'imported');assert.equal(t.one.trusted,false);assert.equal(t.mine.origin,'local');assert.equal(t.mine.trusted,true);
}finally{await done(f);}});
test('R4 single save drops imported id + adds new id same hash -> accepted, stays imported',async()=>{const f=await fx();try{
 const w=await f.service.workspace(f.mixed.id);
 const rows=w.scenarios![0].scripts!.filter(r=>r.id!=='one');
 const s=await f.service.save({...w,scenarios:[{...w.scenarios![0],scripts:[...rows,f.mk('renamed','output.a=1')]}]}); // must not reject
 const t=await f.trust(s.id);
 assert.equal(t.renamed.origin,'imported');assert.equal(t.renamed.trusted,false);
}finally{await done(f);}});
test('R5 same-save only: drop imported in save N, add same-hash new id in save N+1 -> local',async()=>{const f=await fx();try{
 const w=await f.service.workspace(f.mixed.id);
 const a=await f.service.save({...w,scenarios:[{...w.scenarios![0],scripts:w.scenarios![0].scripts!.filter(r=>r.id!=='one')}]});
 const b=await f.service.save({...a,scenarios:[{...a.scenarios![0],scripts:[...a.scenarios![0].scripts!,f.mk('later','output.a=1')]}]});
 const t=await f.trust(b.id);assert.equal(t.later.origin,'local');assert.equal(t.later.trusted,true);
}finally{await done(f);}});
test('R6 Undo of deleted local stays local/trusted; Undo of deleted imported stays imported/untrusted',async()=>{const f=await fx();try{
 const w=await f.service.workspace(f.mixed.id);const before=w.scenarios![0].scripts!;
 const del=await f.service.save({...w,scenarios:[{...w.scenarios![0],scripts:[]}]});
 const re=await createScenarios(f.options).save({...del,scenarios:[{...del.scenarios![0],scripts:before}]});
 const t=await f.trust(re.id);
 assert.equal(t.mine.origin,'local');assert.equal(t.mine.trusted,true);assert.equal(t.one.origin,'imported');assert.equal(t.one.trusted,false);
 // local workspace Undo with identical text imported elsewhere
 const lw=await f.service.workspace(f.local.id);
 const ld=await f.service.save({...lw,scenarios:[{...lw.scenarios![0],scripts:[]}]});
 const lr=await f.service.save({...ld,scenarios:lw.scenarios});
 const lt=await f.trust(lr.id);assert.equal(lt.one.origin,'local');assert.equal(lt.one.trusted,true);
}finally{await done(f);}});
test('R7 client payload cannot flip imported id to local',async()=>{const f=await fx();try{
 const w=await f.service.workspace(f.mixed.id);
 const s=await f.service.save({...w,scenarios:[{...w.scenarios![0],scripts:w.scenarios![0].scripts!.map(r=>({...r,origin:'local',trusted:true} as any))}]});
 const t=await f.trust(s.id);assert.equal(t.one.origin,'imported');assert.equal(t.one.trusted,false);
}finally{await done(f);}});
