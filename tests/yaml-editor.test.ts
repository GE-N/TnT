import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readForms, editForm, appendForm} from '../src/yaml-forms.js';

const mixed = `# header comment
appId: com.example.HybridApp
env:
  TARGET: Home
---
# leading comment
- tapOn: "Settings" # retain trailing comment
- assertVisible: &target Home
- repeat:
    times: 2
    commands:
      - assertVisible: *target
      - assertVisible: '\${TARGET}'
# footer comment
`;
test('a form edit changes only its value, preserving comments, anchors, expressions and complex commands',()=>{
  const view=readForms(mixed);
  assert.equal(view.error,undefined);
  assert.equal(view.steps[0].value,'Settings');
  assert.equal(view.steps[1].editable,false);
  assert.equal(view.steps[2].editable,false);
  const edited=editForm(mixed,{source:mixed,index:0,value:'Coordinator'});
  assert.equal(edited,mixed.replace('"Settings"','"Coordinator"'));
  assert.equal(readForms(edited).steps[0].value,'Coordinator');
});

test('invalid code is retained and unsafe or stale form edits are rejected',()=>{
  const invalid='appId: com.example.App\n---\n- tapOn: [\n';
  assert.match(readForms(invalid).error!,/Invalid YAML/);
  assert.throws(()=>editForm(invalid,{source:invalid,index:0,value:'Home'}),/Invalid YAML/);
  assert.throws(()=>editForm(mixed,{source:mixed,index:1,value:'Changed'}),/unsafe/);
  assert.throws(()=>editForm(mixed+'# external change\n',{source:mixed,index:0,value:'Changed'}),/YAML changed/);
});
test('adding each common command preserves preceding code and rejects explicit document endings',()=>{
  for(const command of ['tapOn','inputText','assertVisible','assertNotVisible','runFlow'] as const){
    const edited=appendForm(mixed,command,'new value');
    assert.ok(edited.startsWith(mixed));
    assert.equal(readForms(edited).steps.at(-1)?.value,'new value');
  }
  assert.throws(()=>appendForm('appId: com.example.App\n---\n- tapOn: Home\n...\n','tapOn','Next'),/code-only/);
});
test('unresolved aliases are explained as invalid code instead of offered as editable forms',()=>{
  const invalid='appId: com.example.App\n---\n- assertVisible: *missing\n';
  assert.match(readForms(invalid).error!,/alias|anchor/i);
});
test('form edits make old canvas associations repairable and prevent executing the changed route',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createRunner}=await import('../server/runner.js');const {createScenarios}=await import('../server/scenarios.js');
 const root=await mkdtemp(join(tmpdir(),'tnt-form-canvas-'));
 try{
  const runner=createRunner({artifactDirectory:root,execute:async()=>{throw new Error('No device commands allowed for stale references');}});
  const service=createScenarios({root,runner,maestro:{version:async()=> '2.11.0',run:async()=>{throw new Error('Must not execute stale route');}}});
  const source='appId: com.example.HybridApp\n---\n- tapOn: Settings\n- assertVisible: Settings\n';
  const catalog=await service.references({yaml:source});
  const canvas={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'action',label:'Settings',role:'action',reference:catalog.references[0]}]},{id:'target',title:'Settings',x:400,y:0,tests:[{id:'assertion',label:'Settings visible',role:'assertion',reference:catalog.references[1]}]}],edges:[{id:'edge',from:'home',to:'target',actionTestId:'action',assertionTestId:'assertion',responseCondition:'Settings opens'}],paths:[{id:'path',name:'Settings',edgeIds:['edge']}]};
  const yaml=editForm(source,{source,index:1,value:'Maintenance'});
  const saved=await service.save({name:'Changed form',yaml,canvas});
  assert.match(saved.canvasDiagnostics!.find(error=>error.ownerId==='assertion')!.detail,/stale.*relink/i);
  await assert.rejects(service.start({workspaceId:saved.id,deviceId:'E5C92F6E-40DC-493C-93B4-469E67193736',pathId:'path'}),/stale/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('appending to an indented command list retains valid YAML and all original source',()=>{
 const source='appId: com.example.App\n---\n  - tapOn: Home # keep\n';
 const edited=appendForm(source,'inputText','hello');
 assert.equal(edited,source+'  - inputText: "hello"\n');
 assert.equal(readForms(edited).error,undefined);
 assert.equal(readForms(edited).steps.at(-1)?.value,'hello');
});
test('deleting middle and tail steps preserves other source and refuses breaking aliases',async()=>{
 const {deleteForm}=await import('../src/yaml-forms.js');
 const source='appId: com.example.App\n---\n- launchApp\n# keep\n- tapOn:\n    text: Home\n    optional: true\n- assertVisible: Home # keep too\n';
 const middle=deleteForm(source,1);
 assert.equal(middle,'appId: com.example.App\n---\n- launchApp\n# keep\n- assertVisible: Home # keep too\n');
 assert.equal(deleteForm(middle,1),'appId: com.example.App\n---\n- launchApp\n# keep\n');
 assert.equal(readForms(deleteForm(deleteForm(middle,1),0)).steps.length,0);
 assert.throws(()=>deleteForm(mixed,1),/alias|anchor/i);
});
test('argument forms edit a selected scalar without rewriting sibling arguments or comments',()=>{
 const source='appId: com.example.App\n---\n- tapOn:\n    text: Home # keep\n    optional: true\n    index: 0\n';
 assert.equal(readForms(source).steps[0].fields?.length,3);
 assert.equal(editForm(source,{source,index:0,field:'text',value:'Coordinator'}),source.replace('Home','"Coordinator"'));
 assert.equal(editForm(source,{source,index:0,field:'optional',value:'false'}),source.replace('true','false'));
 assert.throws(()=>editForm(source,{source,index:0,field:'index',value:'no'}),/number/);
});
test('deleting a duplicate step explicitly invalidates affected canvas references and an empty list can be rebuilt',async()=>{
 const {deleteForm,canvasAfterDeletion}=await import('../src/yaml-forms.js');
 const {referenceCatalog,inspectCanvas}=await import('../server/canvas.js');
 const source='appId: com.example.App\n---\n- tapOn: Home\n- tapOn: Home\n';
 const reference=referenceCatalog(source).references[0];
 const graph={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'action',label:'Home',role:'action' as const,reference}]}],edges:[],paths:[]};
 const changed=canvasAfterDeletion(graph,0);
 assert.match(inspectCanvas(changed!,deleteForm(source,0)).diagnostics[0].detail,/stale/);
 assert.equal(inspectCanvas(graph,source).diagnostics.length,0);
 const empty=deleteForm(deleteForm(source,0),0);
 assert.equal(readForms(appendForm(empty,'tapOn','Next')).steps[0].value,'Next');
});
test('Undo restores invalidated references while preserving later canvas edits and explicit relinking',async()=>{
 const {canvasAfterDeletion,restoreDeletionReferences}=await import('../src/yaml-forms.js');
 const {referenceCatalog}=await import('../server/canvas.js');
 const source='appId: com.example.App\n---\n- tapOn: Home\n';
 const graph={screens:[{id:'home',title:'Home',x:0,y:0,tests:[{id:'action',label:'Home',role:'action' as const,reference:referenceCatalog(source).references[0]}]}],edges:[],paths:[]};
 const deleted=canvasAfterDeletion(graph,0)!;
 const moved={...deleted,screens:deleted.screens.map(screen=>({...screen,title:'Renamed',x:120}))};
 const restored=restoreDeletionReferences(moved,graph,deleted)!;
 assert.equal(restored.screens[0].x,120);assert.equal(restored.screens[0].title,'Renamed');
 assert.deepEqual(restored.screens[0].tests[0].reference,graph.screens[0].tests[0].reference);
 const relinked=structuredClone(moved);relinked.screens[0].tests[0].reference.fingerprint='user-relinked';
 assert.equal(restoreDeletionReferences(relinked,graph,deleted)!.screens[0].tests[0].reference.fingerprint,'user-relinked');
});
