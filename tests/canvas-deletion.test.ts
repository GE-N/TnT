import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planCanvasDeletion,writeChecks} from '../shared/canvas-authoring.js';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';
const operation=(id:string,check=false):CanvasTest=>({id,label:id,role:check?'assertion':'action',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'},...(check?{check:{visibility:'visible',target:'text',match:'exact',value:id}}:{tap:{target:'text',match:'exact',value:id}})});
function fixture():CanvasGraph{return {screens:[{id:'home',title:'Home',x:0,y:0,tests:[operation('go'),operation('returned',true),operation('again')]},{id:'details',title:'Details',x:100,y:0,tests:[operation('back'),operation('later',true)]}],edges:[{id:'go-edge',from:'home',to:'details',actionTestId:'go',assertionTestId:'pending:go-edge',responseCondition:'Go'},{id:'back-edge',from:'details',to:'home',actionTestId:'back',assertionTestId:'returned',responseCondition:'Back'},{id:'again-edge',from:'home',to:'details',actionTestId:'again',assertionTestId:'later',responseCondition:'Again'}],paths:[{id:'route',name:'Return journey',scenarioId:'original',screenId:'home',edgeIds:['go-edge','back-edge','again-edge'],visits:[{id:'first',operationIds:['go']},{id:'second',operationIds:['back']},{id:'third',operationIds:['returned','again']},{id:'fourth',operationIds:['later']}]}]};}
for(const kind of ['operation','connection','screen'] as const)test(kind+' deletion removes the entire dependent suffix and owned YAML',()=>{
 const before=fixture();const untouched=structuredClone(before);
 const deletion=kind==='operation'?{kind,id:'back',pathId:'route',visitId:'second'} as const:kind==='connection'?{kind,id:'back-edge',pathId:'route'} as const:{kind,id:'details'} as const;
 const {graph,warnings}=planCanvasDeletion(before,deletion);
 assert.deepEqual(before,untouched,'Planning must leave the workspace untouched');
 assert.deepEqual(graph.paths[0].edgeIds,kind==='screen'?[]:['go-edge']);
 assert.deepEqual(graph.paths[0].visits!.map(v=>v.id),kind==='screen'?['first']:['first','second']);
 assert.ok(!graph.screens.flatMap(s=>s.tests).some(t=>['back','returned','again','later'].includes(t.id)));
 assert.equal(graph.screens.length,kind==='screen'?1:2);assert.match(warnings[0],/remove Visit/);
 const yaml=writeChecks('appId: app\n---\n- launchApp\n', {screens:[],edges:[],paths:[]},before);
 const afterYaml=writeChecks(yaml,before,graph);assert.doesNotMatch(afterYaml,/tnt-check:(back|returned|again|later)/);
});
test('selected visit deletion preserves duplicated scenarios and shared steps',()=>{
 const before=fixture();before.paths.push({...structuredClone(before.paths[0]),id:'copy',scenarioId:'copy',visits:before.paths[0].visits!.map(v=>({...v,id:'copy-'+v.id}))});
 const {graph}=planCanvasDeletion(before,{kind:'operation',id:'back',pathId:'route',visitId:'second'});
 assert.deepEqual(graph.paths[1],before.paths[1]);assert.deepEqual(graph.screens,before.screens);assert.deepEqual(graph.edges,before.edges);
 assert.deepEqual(graph.paths[0].visits!.map(v=>v.id),['first','second']);
});
test('clearing a shared destination trims only the selected scenario',()=>{
 const before=fixture();before.paths.push({...structuredClone(before.paths[0]),id:'copy',scenarioId:'copy',visits:before.paths[0].visits!.map(v=>({...v,id:'copy-'+v.id}))});
 const {graph}=planCanvasDeletion(before,{kind:'operation',id:'back',pathId:'route',visitId:'second',clearDestination:true});
 assert.deepEqual(graph.paths[0].edgeIds,['go-edge']);assert.deepEqual(graph.paths[1],before.paths[1]);assert.deepEqual(graph.edges,before.edges);
});
test('deleting the initial node resets each affected scenario without dangling references',()=>{
 const {graph}=planCanvasDeletion(fixture(),{kind:'screen',id:'home'});
 assert.equal(graph.paths[0].screenId,undefined);assert.deepEqual(graph.paths[0].edgeIds,[]);assert.deepEqual(graph.paths[0].visits![0].operationIds,[]);assert.deepEqual(graph.edges,[]);
});
test('deleting one grouped action keeps the continuation provided by its sibling',()=>{
 const before=fixture();before.paths[0].finished=true;before.screens[1].tests.push(operation('other-back'));before.edges[1].actionTestIds=['back','other-back'];before.paths[0].visits![1].operationIds!.push('other-back');
 const {graph}=planCanvasDeletion(before,{kind:'operation',id:'back',pathId:'route',visitId:'second'});
 assert.equal(graph.paths[0].finished,true);assert.deepEqual(graph.paths[0].edgeIds,before.paths[0].edgeIds);assert.deepEqual(graph.edges[1].actionTestIds,['other-back']);assert.deepEqual(graph.paths[0].visits![1].operationIds,['other-back']);
});
test('removing a later repeated connection keeps its earlier occurrence and trims the suffix',()=>{
 const before=fixture();before.paths[0].edgeIds=['go-edge','back-edge','go-edge'];before.paths[0].visits![2].operationIds=['returned','go'];
 const {graph}=planCanvasDeletion(before,{kind:'connection',id:'go-edge',pathId:'route',visitId:'third'});
 assert.deepEqual(graph.paths[0].edgeIds,['go-edge','back-edge']);assert.equal(graph.paths[0].visits!.length,3);assert.deepEqual(graph.paths[0].visits![2].operationIds,['returned']);assert.ok(graph.edges.some(edge=>edge.id==='go-edge'));
});
