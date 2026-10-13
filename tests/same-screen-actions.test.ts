import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inspectCanvas,type CanvasGraph,type CanvasTest} from '../server/canvas.js';
import {edgeActions,privateVisitOperation,visitOperations,writeChecks} from '../shared/canvas-authoring.js';

const reference={kind:'step' as const,file:'flow.yaml',index:0,fingerprint:'draft'};
const scenarioIds=['scenario-a','scenario-b'];
function tap(id:string,value:string):CanvasTest{return {id,label:value,role:'action',reference,scenarioIds,tap:{target:'text',match:'exact',value}};}
const graph:CanvasGraph={
 screens:[
  {id:'home',title:'Home',x:40,y:40,tests:[tap('show-error','Submit'),tap('open-detail','Detail')]},
  {id:'detail',title:'Detail',x:420,y:40,tests:[{id:'detail-ready',label:'Detail',role:'assertion',reference,scenarioIds,check:{visibility:'visible',target:'text',match:'exact',value:'Detail'}}]},
 ],
 edges:[{id:'go',from:'home',to:'detail',actionTestId:'open-detail',actionTestIds:['open-detail'],assertionTestId:'detail-ready',responseCondition:'Home → Detail'}],
 paths:['a','b'].map(name=>({id:'path-'+name,name,scenarioId:'scenario-'+name,screenId:'home',edgeIds:['go'],visits:[{id:name+'-home',operationIds:['show-error','open-detail']},{id:name+'-detail',operationIds:['detail-ready']}]})),
};

test('editing a shared same-screen action copies it without attaching the copy to the outgoing connection',()=>{
 const copied=privateVisitOperation(structuredClone(graph),'path-a','a-home','show-error');
 assert.notEqual(copied.testId,'show-error');
 assert.equal(copied.graph.screens.find(screen=>screen.id==='home')?.tests.some(test=>test.id===copied.testId),true);
 assert.equal(copied.graph.edges.some(edge=>edgeActions(edge).includes(copied.testId)),false);
 assert.deepEqual(copied.graph.edges,graph.edges);
 const [pathA,pathB]=copied.graph.paths;
 assert.deepEqual(visitOperations(copied.graph,pathA,0),[copied.testId,'open-detail']);
 assert.deepEqual(visitOperations(copied.graph,pathB,0),['show-error','open-detail']);
});

test('editing a shared navigating action still attaches the copy to the outgoing connection',()=>{
 const copied=privateVisitOperation(structuredClone(graph),'path-a','a-home','open-detail');
 assert.deepEqual(edgeActions(copied.graph.edges[0]),['open-detail',copied.testId]);
 assert.deepEqual(visitOperations(copied.graph,copied.graph.paths[0],0),['show-error',copied.testId]);
});

test('a visit action that navigates through a different connection from the same screen is still rejected',()=>{
 const sibling:CanvasGraph={...structuredClone(graph),
  screens:[...structuredClone(graph.screens),{id:'more',title:'More',x:420,y:320,tests:[]}],
  edges:[...structuredClone(graph.edges),{id:'go-more',from:'home',to:'more',actionTestId:'show-error',actionTestIds:['show-error'],assertionTestId:'pending:go-more',responseCondition:'Home → More'}],
 };
 const yaml=writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},sibling);
 const rejected=inspectCanvas(sibling,yaml).diagnostics.filter(item=>item.ownerId==='path-a'&&item.visitId==='a-home');
 assert.deepEqual(rejected.map(item=>item.detail),['Choose a destination for each action in Visit 1 that continues its sequence.']);
 assert.equal(inspectCanvas(graph,writeChecks('appId: com.example.App\n---\n- launchApp\n',{screens:[],edges:[],paths:[]},graph)).diagnostics.some(item=>item.visitId==='a-home'),false);
});
