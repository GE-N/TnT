import {referenceCatalog} from '../server/canvas.js';
import type {CanvasGraph,CanvasTest,YAMLReference} from '../server/canvas.js';
import type {Automation} from '../server/default-actions.js';
import {refreshChecks,writeChecks} from '../shared/canvas-authoring.js';
import type {GoldenFixture} from './golden-canvas-runner.js';

const draft:YAMLReference={kind:'step',file:'flow.yaml',index:0,fingerprint:'draft'};
const baseYaml='appId: com.example.App\n---\n- launchApp\n';

function check(id:string,value:string,target:'text'|'id'='text',scenarioIds?:string[]):CanvasTest{
  return {id,label:value,role:'assertion',reference:{...draft},...(scenarioIds?{scenarioIds}:{}),check:{visibility:'visible',target,match:'exact',value}};
}
function tap(id:string,value:string,target:'text'|'id'='text',scenarioIds?:string[]):CanvasTest{
  return {id,label:value,role:'action',reference:{...draft},...(scenarioIds?{scenarioIds}:{}),tap:{target,match:'exact',value}};
}
function typed(id:string,value:string,scenarioIds?:string[]):CanvasTest{
  return {id,label:value,role:'action',reference:{...draft},...(scenarioIds?{scenarioIds}:{}),input:value};
}
function back(id:string,scenarioIds?:string[]):CanvasTest{
  return {id,label:'Back',role:'action',reference:{...draft},...(scenarioIds?{scenarioIds}:{}),back:true};
}
function screen(id:string,title:string,x:number,y:number,tests:CanvasTest[]):CanvasGraph['screens'][number]{
  return {id,title,x,y,tests};
}
function edge(id:string,from:string,to:string,actionId:string,assertionId:string,responseCondition:string,actionTestIds?:string[]):CanvasGraph['edges'][number]{
  return {id,from,to,actionTestId:actionId,assertionTestId:assertionId,responseCondition,...(actionTestIds?{actionTestIds}:{})};
}
function materialize(canvas:CanvasGraph,yaml=baseYaml){
  const written=writeChecks(yaml,{screens:[],edges:[],paths:[]},canvas);
  return {yaml:written,canvas:refreshChecks(canvas,written)};
}

function linearRoute():GoldenFixture{
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home'),tap('open-detail','Detail')]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail'),tap('continue-settings','Settings')]),
      screen('settings','Settings',800,40,[check('settings-ready','Settings')]),
    ],
    edges:[edge('home-detail','home','detail','open-detail','detail-ready','Home → Detail')],
    paths:[{id:'route',name:'Home → Detail',screenId:'home',edgeIds:['home-detail']}],
  };
  return {id:'linear-route',description:'A linear Home → Detail route. An unconnected tail action can connect to the existing Settings screen, then its destination can be cleared and undone.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[
    {op:'connect',screenId:'detail',actionId:'continue-settings',to:'settings'},
    {op:'clear-destination',screenId:'detail',actionId:'continue-settings'},
    {op:'undo'},
  ]};
}

function textTap():GoldenFixture{
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[tap('tap-gear','Gear','text')]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail')]),
    ],
    edges:[edge('open','home','detail','tap-gear','detail-ready','Tap Gear')],
    paths:[{id:'route',name:'Text tap',screenId:'home',edgeIds:['open'],visits:[{id:'visit-home',operationIds:['tap-gear']},{id:'visit-detail',operationIds:['detail-ready']}]}],
  };
  return {id:'text-tap',description:'tapOn matches by text.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[]};
}

function idTap():GoldenFixture{
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[tap('tap-gear','gear.button','id')]),
      screen('detail','Detail',420,40,[check('detail-ready','detail.ready','id')]),
    ],
    edges:[edge('open','home','detail','tap-gear','detail-ready','Tap gear.button')],
    paths:[{id:'route',name:'Id tap',screenId:'home',edgeIds:['open'],visits:[{id:'visit-home',operationIds:['tap-gear']},{id:'visit-detail',operationIds:['detail-ready']}]}],
  };
  return {id:'id-tap',description:'tapOn matches by element id.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[]};
}

function repeatedVisit():GoldenFixture{
  const scenarios=['scenario-a'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home','text',scenarios),tap('open-detail','Detail','text',scenarios)]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail','text',scenarios),back('back-home',scenarios)]),
    ],
    edges:[
      edge('go','home','detail','open-detail','detail-ready','Home → Detail',['open-detail']),
      edge('return','detail','home','back-home','home-ready','Detail → Home',['back-home']),
    ],
    paths:[{id:'route',name:'Home → Detail → Home',scenarioId:'scenario-a',screenId:'home',edgeIds:['go','return'],visits:[
      {id:'visit-1',operationIds:['home-ready','open-detail']},
      {id:'visit-2',operationIds:['detail-ready','back-home']},
      {id:'visit-3',operationIds:['home-ready']},
    ]}],
  };
  return {id:'repeated-visit',description:'Home → Detail → Home reuses the Home check on the return visit.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Return',pathId:'route'}],...materialize(canvas),scripts:[]};
}

function sharedStep():GoldenFixture{
  const scenarios=['scenario-a','scenario-b'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[tap('shared-tap','Gear','text',scenarios)]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail','text',scenarios)]),
    ],
    edges:[edge('go','home','detail','shared-tap','detail-ready','Home → Detail',['shared-tap'])],
    paths:[
      {id:'path-a',name:'Scenario A',scenarioId:'scenario-a',screenId:'home',edgeIds:['go'],visits:[{id:'a-home',operationIds:['shared-tap']},{id:'a-detail',operationIds:['detail-ready']}]},
      {id:'path-b',name:'Scenario B',scenarioId:'scenario-b',screenId:'home',edgeIds:['go'],visits:[{id:'b-home',operationIds:['shared-tap']},{id:'b-detail',operationIds:['detail-ready']}]},
    ],
  };
  return {id:'shared-step',description:'One tap is shared by two scenario routes.',scenarioMode:true,pathId:'path-a',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Scenario A',pathId:'path-a'},{id:'scenario-b',name:'Scenario B',pathId:'path-b'}],...materialize(canvas),scripts:[]};
}

function multiActionEdge():GoldenFixture{
  const scenarios=['scenario-a'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[tap('tap-field','Field','text',scenarios),typed('input-name','Ada',scenarios)]),
      screen('done','Done',420,40,[check('done-ready','Done','text',scenarios)]),
      screen('other','Other',420,320,[check('other-ready','Other','text',scenarios)]),
    ],
    edges:[edge('home-done','home','done','tap-field','done-ready','Home → Done',['tap-field','input-name'])],
    paths:[{id:'route',name:'Multi-action',scenarioId:'scenario-a',screenId:'home',edgeIds:['home-done'],visits:[
      {id:'visit-home',operationIds:['tap-field','input-name']},
      {id:'visit-done',operationIds:['done-ready']},
    ]}],
  };
  return {id:'multi-action-edge',description:'One edge carries a tap and an input. Retargeting the input splits that edge.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Multi-action',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'retarget',screenId:'home',actionId:'input-name',to:'other',visitId:'visit-home'},
  ]};
}

function legacyVisits():GoldenFixture{
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home'),check('home-returned','Returned'),tap('open-detail','Detail')]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail'),back('back-home')]),
    ],
    edges:[
      edge('go','home','detail','open-detail','detail-ready','Home → Detail'),
      edge('return','detail','home','back-home','home-ready','Detail → Home'),
    ],
    paths:[{id:'route',name:'Legacy return',screenId:'home',edgeIds:['go','return'],visits:[
      {id:'legacy-1'},
      {id:'legacy-2'},
      {id:'legacy-3',checkIds:['home-returned']},
    ]}],
  };
  return {id:'legacy-visits',description:'Saved visits have no operationIds. The return visit selects one check and the others stay derived.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[]};
}

function deletionCut():GoldenFixture{
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home'),tap('open-detail','Detail')]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail'),tap('open-done','Done')]),
      screen('done','Done',800,40,[check('done-ready','Done')]),
    ],
    edges:[
      edge('home-detail','home','detail','open-detail','detail-ready','Home → Detail',['open-detail']),
      edge('detail-done','detail','done','open-done','done-ready','Detail → Done',['open-done']),
    ],
    paths:[{id:'route',name:'Home Detail Done',screenId:'home',edgeIds:['home-detail','detail-done'],visits:[
      {id:'visit-1',operationIds:['home-ready','open-detail']},
      {id:'visit-2',operationIds:['detail-ready','open-done']},
      {id:'visit-3',operationIds:['done-ready']},
    ]}],
  };
  return {id:'deletion-cut',description:'Deleting the only outgoing action, its connection, or the destination screen cuts the route suffix. Undo restores it.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[
    {op:'delete-step',actionId:'open-done'},
    {op:'undo'},
    {op:'delete-connection',edgeId:'detail-done'},
    {op:'undo'},
    {op:'delete-screen',screenId:'done'},
    {op:'undo'},
  ]};
}

function defaultActions():GoldenFixture{
  const flows={'setup.yaml':'appId: com.example.App\n---\n- assertVisible: Home\n','open.yaml':'appId: com.example.App\n---\n- tapOn: Middle\n'};
  const yaml='appId: com.example.App\n---\n- assertVisible: Middle\n# tnt-check:tap-done\n# tnt-match:exact\n- tapOn:\n    text: "^Done$"\n# tnt-check:done-ready\n# tnt-match:exact\n- assertVisible:\n    text: "^Done$"\n';
  const step=referenceCatalog(yaml,flows).references.find(item=>item.kind==='step'&&item.index===0);
  if(!step)throw new Error('Default-action fixture is missing its checkpoint step.');
  const automation:Automation={setup:{file:'setup.yaml',parameters:{}},actions:[{id:'open',name:'Open Middle',condition:{text:'Home'},file:'open.yaml',parameters:{},enabled:true}],checkpoints:[{beforeStep:0,fingerprint:step.fingerprint,timeoutMs:0}]};
  const catalog=referenceCatalog(yaml,flows,automation);
  const setup=catalog.references.find(item=>item.kind==='setup');
  const handler=catalog.references.find(item=>item.kind==='handler');
  if(!setup||!handler)throw new Error('Default-action fixture could not resolve setup or handler references.');
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[
        {id:'setup',label:'Independent setup',role:'setup',reference:{kind:'setup',file:setup.file,fingerprint:setup.fingerprint}},
        {id:'handler',label:'Open Middle',role:'handler',reference:{kind:'handler',file:handler.file,index:handler.index,actionId:handler.actionId,fingerprint:handler.fingerprint}},
      ]),
      screen('middle','Middle',420,40,[
        {id:'middle-ready',label:'Middle',role:'assertion',reference:{kind:'step',file:'flow.yaml',index:0,fingerprint:step.fingerprint}},
        tap('tap-done','Done'),
      ]),
      screen('done','Done',800,40,[check('done-ready','Done')]),
    ],
    edges:[
      edge('handler-edge','home','middle','handler','middle-ready','Handler opens Middle'),
      edge('ordered-edge','middle','done','tap-done','done-ready','Tap Done',['tap-done']),
    ],
    paths:[{id:'route',name:'Setup and handler',screenId:'home',edgeIds:['handler-edge','ordered-edge']}],
  };
  return {id:'default-actions',description:'A setup reference and a handler checkpoint stay attached to the ordered route.',scenarioMode:false,pathId:'route',scenarios:[],yaml,flows,automation,canvas:refreshChecks(canvas,yaml),scripts:[]};
}

export function buildGoldenFixtures():GoldenFixture[]{
  return [linearRoute(),textTap(),idTap(),repeatedVisit(),sharedStep(),multiActionEdge(),legacyVisits(),deletionCut(),defaultActions()];
}
