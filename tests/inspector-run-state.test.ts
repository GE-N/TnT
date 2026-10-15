import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CanvasGraph} from '../server/canvas.js';
import type {Run} from '../server/scenarios.js';
import {inspectorRunView,runStatusLabel} from '../src/inspector-run-state.js';

const graph:CanvasGraph={
 screens:[
  {id:'home',title:'Home',x:0,y:0,tests:[{id:'ready',label:'Home',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'d'},check:{visibility:'visible',target:'text',match:'exact',value:'Home'}},{id:'go',label:'Go',role:'action',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'d'},tap:{target:'text',match:'exact',value:'Go'}}]},
  {id:'detail',title:'Detail',x:400,y:0,tests:[{id:'detail-ready',label:'Detail',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:'d'},check:{visibility:'visible',target:'text',match:'exact',value:'Detail'}}]},
 ],
 edges:[{id:'home-detail',from:'home',to:'detail',actionTestId:'go',actionTestIds:['go'],assertionTestId:'detail-ready',responseCondition:'tap Go'}],
 paths:[{id:'route',name:'Main',scenarioId:'main',screenId:'home',edgeIds:['home-detail'],visits:[{id:'v1',operationIds:['ready','go']},{id:'v2',operationIds:['detail-ready']}]}],
};

function run(status:Run['status'],canvas:Run['canvas']):Run{
 return {id:'00000000-0000-4000-8000-000000000001',deviceId:'device',startedAt:'2026-10-15T00:00:00.000Z',status,canvas,snapshot:{id:'snap',workspaceId:'ws',name:'Demo',yaml:'',steps:[],toolVersions:{maestro:'1',node:'1'},runtimeInputPolicy:'none'},steps:[],log:'',cleanup:{verified:true,detail:'ok'},artifacts:[],mappingNote:''};
}

test('running highlights only the first visit and step',()=>{
 const view=inspectorRunView(graph,'route',run('running',{pathId:'route',note:'',tests:[],screens:[],edges:[],visits:[{id:'v1',screenId:'home',status:'unavailable',checkIds:[]},{id:'v2',screenId:'detail',status:'unavailable',checkIds:[]}],occurrences:[]}));
 assert.equal(view?.activeVisitId,'v1');
 assert.equal(view?.currentStepId,'ready');
 assert.equal(view?.activeEdgeId,'home-detail');
 assert.equal(view?.visitStatus('v1')?.tone,'running');
 assert.equal(view?.visitStatus('v2'),undefined);
 assert.equal(view?.stepStatus('v1','ready')?.tone,'running');
 assert.equal(view?.stepStatus('v1','go'),undefined);
 assert.equal(runStatusLabel('running'),'Running');
});

test('passed marks visits and steps without inventing idle labels',()=>{
 const view=inspectorRunView(graph,'route',run('passed',{pathId:'route',note:'',tests:[{id:'ready',status:'passed',detail:''},{id:'go',status:'passed',detail:''},{id:'detail-ready',status:'passed',detail:''}],screens:[{id:'home',status:'passed'},{id:'detail',status:'passed'}],edges:[{id:'home-detail',status:'passed'}],visits:[{id:'v1',screenId:'home',status:'passed',checkIds:[]},{id:'v2',screenId:'detail',status:'passed',checkIds:[]}],occurrences:[{id:'o1',visitId:'v1',testId:'ready',status:'passed',detail:''},{id:'o2',visitId:'v1',testId:'go',status:'passed',detail:''},{id:'o3',visitId:'v2',testId:'detail-ready',status:'passed',detail:''}]}));
 assert.equal(view?.visitStatus('v1')?.tone,'passed');
 assert.equal(view?.stepStatus('v2','detail-ready')?.tone,'passed');
 assert.equal(runStatusLabel('passed'),'✓ Passed');
});

test('failed points at the failing visit and step and keeps earlier passes',()=>{
 const view=inspectorRunView(graph,'route',run('assertion-failed',{pathId:'route',note:'',tests:[{id:'ready',status:'passed',detail:''},{id:'go',status:'passed',detail:''},{id:'detail-ready',status:'failed',detail:'Element not found'}],screens:[{id:'home',status:'passed'},{id:'detail',status:'failed'}],edges:[{id:'home-detail',status:'failed'}],visits:[{id:'v1',screenId:'home',status:'passed',checkIds:[]},{id:'v2',screenId:'detail',status:'failed',checkIds:[]}],occurrences:[{id:'o1',visitId:'v1',testId:'ready',status:'passed',detail:''},{id:'o2',visitId:'v1',testId:'go',status:'passed',detail:''},{id:'o3',visitId:'v2',testId:'detail-ready',status:'failed',detail:'Element not found'}]}));
 assert.equal(view?.activeVisitId,'v2');
 assert.equal(view?.activeEdgeId,'home-detail');
 assert.equal(view?.visitStatus('v1')?.tone,'passed');
 assert.deepEqual(view?.stepStatus('v2','detail-ready'),{tone:'failed',detail:'Element not found'});
 assert.equal(runStatusLabel('failed'),'✕ Failed');
});
