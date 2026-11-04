import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createKnowledgeService,type ContextContent} from '../server/knowledge/index.js';
import {scriptFixture} from './run-script-helpers.js';

const context:ContextContent={purpose:'Navigate Home',expectedOutcome:'Home appears',rationale:'Show the app entry',preconditions:'App installed',exceptions:'None specified',scope:'Navigation'};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('KN-09: context save and publication preserve authored YAML, compiled output, script trust and actual run inputs',async()=>{
 const f=await scriptFixture();const knowledge=createKnowledgeService({root:f.root,queue:{enqueue(){}},reconcileIntervalMs:0});
 try{
  const path=join(f.root,'workspaces',f.workspace.id,'workspace.json');const recordBefore=await readFile(path);const before=await f.service.preview({...f.workspace,scenarioId:'one'});const trust=await f.service.scriptTrust(f.workspace.id);
  const runBefore=await f.service.wait((await f.start()).id);assert.equal(runBefore.status,'passed');
  const filesBefore=await readdir(join(f.root,'runs',runBefore.id));const snapshotBefore=await readFile(join(f.root,'runs',runBefore.id,'snapshot.json'));
  await knowledge.saveContext(f.workspace.id,'one',{expectedContextRevision:0,context});await knowledge.publish(f.workspace.id);
  assert.deepEqual(await readFile(path),recordBefore);assert.equal((await f.service.workspace(f.workspace.id)).yaml,f.workspace.yaml);assert.deepEqual(await f.service.preview({...f.workspace,scenarioId:'one'}),before);assert.deepEqual(await f.service.scriptTrust(f.workspace.id),trust);
  assert.deepEqual(await readFile(join(f.root,'runs',runBefore.id,'snapshot.json')),snapshotBefore);assert.deepEqual(await readdir(join(f.root,'runs',runBefore.id)),filesBefore);
  const runAfter=await f.service.wait((await f.start()).id);assert.equal(runAfter.status,runBefore.status);assert.equal(runAfter.snapshot.authoredYaml,runBefore.snapshot.authoredYaml);assert.equal(runAfter.snapshot.executionYaml,runBefore.snapshot.executionYaml);assert.deepEqual(runAfter.executionOrder,runBefore.executionOrder);assert.deepEqual(f.calls[1].runtimeInputs,f.calls[0].runtimeInputs);assert.deepEqual(runAfter.scriptSteps,runBefore.scriptSteps);
  const detail=await knowledge.readContext(f.workspace.id,'one');assert.equal(detail.evidence.runId,runAfter.id);assert.equal(detail.evidence.status,'passed');assert.equal(detail.publicationFreshness,'publication-stale');
 }finally{knowledge.close();await f.cleanup();}
});

for(const mode of ['blocked','failed'] as const)test('AC14: workspace save, context save and run start/finish do not await a '+mode+' indexing queue',async()=>{
 const f=await scriptFixture();let entered!:()=>void;const enqueued=new Promise<void>(resolve=>entered=resolve);let release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);let released=false;
 const knowledge=createKnowledgeService({root:f.root,queue:{enqueue(){entered();if(mode==='failed')return Promise.reject(new Error('Indexer offline'));return blocked;}},reconcileIntervalMs:0});
 try{
  const saved=await f.service.save({...f.workspace,name:'Saved while indexer unavailable'});await enqueued;assert.equal(saved.name,'Saved while indexer unavailable');assert.equal(released,false);
  const authored=await knowledge.saveContext(f.workspace.id,'one',{expectedContextRevision:0,context});assert.equal(authored.context.contextRevision,1);assert.equal(released,false);
  const run=await f.start();assert.ok(run.id);assert.equal(released,false);const done=await f.service.wait(run.id);assert.equal(done.status,'passed');assert.equal(released,false);
  if(mode==='failed'){await tick();const state=await knowledge.status(f.workspace.id);assert.match(state.publicationError??'',/Indexer offline/);assert.equal(state.freshness,'needs-review');}
 }finally{released=true;release();knowledge.close();await knowledge.idle();await f.cleanup();}
});
