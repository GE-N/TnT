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
      screen('more','More',420,320,[check('more-ready','More')]),
    ],
    edges:[edge('open','home','detail','tap-gear','detail-ready','Tap Gear')],
    paths:[{id:'route',name:'Text tap',screenId:'home',edgeIds:['open'],visits:[{id:'visit-home'},{id:'visit-detail'}]}],
  };
  return {id:'text-tap',description:'tapOn matches by text. Editing the selector rewrites the command, then the tap is retargeted from Detail onto More. Visits stay unfrozen so the destination check follows More.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[
    {op:'edit',actionId:'tap-gear',value:'Open settings'},
    {op:'retarget',screenId:'home',actionId:'tap-gear',to:'more'},
  ]};
}

function idTap():GoldenFixture{
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[tap('tap-gear','gear.button','id')]),
      screen('detail','Detail',420,40,[check('detail-ready','detail.ready','id')]),
      screen('more','More',420,320,[check('more-ready','more.ready','id')]),
    ],
    edges:[edge('open','home','detail','tap-gear','detail-ready','Tap gear.button')],
    paths:[{id:'route',name:'Id tap',screenId:'home',edgeIds:['open'],visits:[{id:'visit-home'},{id:'visit-detail'}]}],
  };
  return {id:'id-tap',description:'tapOn matches by element id. Editing the selector rewrites the command, then the tap is retargeted from Detail onto More. Visits stay unfrozen so the destination check follows More.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[
    {op:'edit',actionId:'tap-gear',value:'gear.button.primary'},
    {op:'retarget',screenId:'home',actionId:'tap-gear',to:'more'},
  ]};
}

// Literal Back retains its authored id selector through save/open refresh (#52).
function literalBack():GoldenFixture{
  const step=(index:number):YAMLReference=>({kind:'step',file:'flow.yaml',index,fingerprint:'draft'});
  const yaml='appId: com.example.App\n---\n- launchApp\n# tnt-check:go-back\n- back\n# tnt-check:previous-ready\n# tnt-match:exact\n- assertVisible:\n    text: "^Previous$"\n';
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[{id:'go-back',label:'Back',role:'action',reference:step(1),back:true,backSelector:{target:'id',match:'exact',value:'nav.back'}}]),
      screen('previous','Previous',420,40,[{id:'previous-ready',label:'Previous',role:'assertion',reference:step(2),check:{visibility:'visible',target:'text',match:'exact',value:'Previous'}}]),
    ],
    edges:[edge('back-edge','home','previous','go-back','previous-ready','Back')],
    paths:[{id:'route',name:'Literal back',screenId:'home',edgeIds:['back-edge'],visits:[{id:'visit-home',operationIds:['go-back']},{id:'visit-previous',operationIds:['previous-ready']}]}],
  };
  return {id:'literal-back',description:'A literal - back command is linked to a Back action whose backSelector matches an element id. Route projection rewrites that command as tapOn by id. Saving and opening refresh the canvas, and the page keeps projecting the authored Back element id.',scenarioMode:false,pathId:'route',scenarios:[],yaml,canvas,scripts:[]};
}

function backControlFixture():GoldenFixture{
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home'),{id:'go-back',label:'Back',role:'action',reference:{...draft},back:true,backSelector:{target:'id',match:'exact',value:'nav.back'}}]),
      screen('previous','Previous',420,40,[check('previous-ready','Previous')]),
    ],
    edges:[edge('back-edge','home','previous','go-back','previous-ready','Back')],
    paths:[{id:'route',name:'Back',screenId:'home',edgeIds:['back-edge']}],
  };
  return {id:'back',description:'Back matches an element id. Editing the selector rewrites the tapOn command that carries tnt-back.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[
    {op:'edit',actionId:'go-back',value:'nav.back.button'},
  ]};
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
  return {id:'repeated-visit',description:'Home → Detail → Home reuses the Home check on the return visit. Editing Visit 3 copies that shared check.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Return',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'edit',actionId:'home-ready',visitId:'visit-3',value:'Home again'},
  ]};
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
  return {id:'shared-step',description:'One tap is shared by two scenario routes. Editing it in scenario A copies the step and leaves scenario B unchanged.',scenarioMode:true,pathId:'path-a',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Scenario A',pathId:'path-a'},{id:'scenario-b',name:'Scenario B',pathId:'path-b'}],...materialize(canvas),scripts:[
    {op:'edit',actionId:'shared-tap',visitId:'a-home',value:'Gears'},
  ]};
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
  return {id:'multi-action-edge',description:'One edge carries a tap and an input. Removing the sibling action and the destination check lets a retarget onto Other keep a projectable route.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Multi-action',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'delete-step',actionId:'tap-field',visitId:'visit-home'},
    {op:'delete-step',actionId:'done-ready',visitId:'visit-done'},
    {op:'retarget',screenId:'home',actionId:'input-name',to:'other',visitId:'visit-home'},
  ]};
}

function unfrozenVisits():GoldenFixture{
  const scenarios=['scenario-a'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home','text',scenarios),tap('open-detail','Detail','text',scenarios)]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail','text',scenarios)]),
    ],
    edges:[edge('go','home','detail','open-detail','detail-ready','Home → Detail',['open-detail'])],
    paths:[{id:'route',name:'Unfrozen',scenarioId:'scenario-a',screenId:'home',edgeIds:['go'],visits:[{id:'visit-1'},{id:'visit-2'}]}],
  };
  return {id:'unfrozen-visits',description:'A scenario route whose visits have no operationIds. Editing Visit 1 by visitId freezes those visits.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Unfrozen',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'edit',actionId:'home-ready',visitId:'visit-1',value:'Home ready'},
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
  return {id:'legacy-visits',description:'Saved visits have no operationIds. Deleting the return connection freezes visits and then stores them again without operationIds.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[
    {op:'delete-connection',edgeId:'return'},
  ]};
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
  return {id:'default-actions',description:'A setup reference and a handler checkpoint stay attached to the ordered route. Editing the authored tap keeps that checkpoint.',scenarioMode:false,pathId:'route',scenarios:[],yaml,flows,automation,canvas:refreshChecks(canvas,yaml),scripts:[
    {op:'edit',actionId:'tap-done',value:'Finished'},
  ]};
}

function sameScreenSteps():GoldenFixture{
  const scenarios=['scenario-a'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home','text',scenarios),tap('show-error','Submit','text',scenarios),typed('type-name','Ada',scenarios),tap('open-detail','Detail','text',scenarios)]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail','text',scenarios)]),
    ],
    edges:[edge('go','home','detail','open-detail','detail-ready','Home → Detail',['open-detail'])],
    paths:[{id:'route',name:'Same-screen steps',scenarioId:'scenario-a',screenId:'home',edgeIds:['go'],visits:[
      {id:'visit-1',operationIds:['home-ready','show-error','type-name','open-detail']},
      {id:'visit-2',operationIds:['detail-ready']},
    ]}],
  };
  return {id:'same-screen-steps',description:'A same-screen tap and a same-screen input run in place before the navigating tap. Only the navigating tap carries the connection. Editing the same-screen input rewrites it in place.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Same-screen steps',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'edit',actionId:'type-name',visitId:'visit-1',value:'Grace'},
  ]};
}

function staysOnScreen():GoldenFixture{
  const scenarios=['scenario-a'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home','text',scenarios),tap('open-detail','Detail','text',scenarios)]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail','text',scenarios),tap('open-done','Done','text',scenarios)]),
      screen('done','Done',800,40,[check('done-ready','Done','text',scenarios)]),
    ],
    edges:[
      edge('home-detail','home','detail','open-detail','detail-ready','Home → Detail',['open-detail']),
      edge('detail-done','detail','done','open-done','done-ready','Detail → Done',['open-done']),
    ],
    paths:[{id:'route',name:'Stays on this screen',scenarioId:'scenario-a',screenId:'home',edgeIds:['home-detail','detail-done'],visits:[
      {id:'visit-1',operationIds:['home-ready','open-detail']},
      {id:'visit-2',operationIds:['detail-ready','open-done']},
      {id:'visit-3',operationIds:['done-ready']},
    ]}],
  };
  return {id:'stays-on-screen',description:'Clearing the destination of the navigating tap in Visit 1 cuts the route after Visit 1. The tap stays in Visit 1 as a same-screen step and the route still projects. Undo restores the route.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Stays on this screen',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'clear-destination',screenId:'home',actionId:'open-detail',visitId:'visit-1'},
    {op:'undo'},
  ]};
}

function checkAfterNavigation():GoldenFixture{
  const scenarios=['scenario-a'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[tap('open-detail','Detail','text',scenarios),check('detail-title','Detail title','text',scenarios)]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail','text',scenarios)]),
    ],
    edges:[edge('go','home','detail','open-detail','detail-ready','Home → Detail',['open-detail'])],
    paths:[{id:'route',name:'Check after navigation',scenarioId:'scenario-a',screenId:'home',edgeIds:['go'],visits:[
      {id:'visit-1',operationIds:['open-detail','detail-title']},
      {id:'visit-2',operationIds:['detail-ready']},
    ]}],
  };
  return {id:'check-after-navigation',description:'A check placed after the navigating tap in the same visit runs after that tap, with no diagnostic.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Check after navigation',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'edit',actionId:'detail-title',visitId:'visit-1',value:'Detail heading'},
  ]};
}

function sameScreenLastVisit():GoldenFixture{
  const scenarios=['scenario-a'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home','text',scenarios),tap('open-detail','Detail','text',scenarios)]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail','text',scenarios),tap('dismiss','Dismiss','text',scenarios),check('detail-dismissed','Dismissed','text',scenarios)]),
    ],
    edges:[edge('go','home','detail','open-detail','detail-ready','Home → Detail',['open-detail'])],
    paths:[{id:'route',name:'Same-screen last visit',scenarioId:'scenario-a',screenId:'home',edgeIds:['go'],visits:[
      {id:'visit-1',operationIds:['home-ready','open-detail']},
      {id:'visit-2',operationIds:['detail-ready','dismiss','detail-dismissed']},
    ]}],
  };
  return {id:'same-screen-last-visit',description:'The last visit has no outgoing connection and holds a same-screen tap between two checks. It runs in place.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Same-screen last visit',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'edit',actionId:'dismiss',visitId:'visit-2',value:'Close'},
  ]};
}

function retargetFrozenVisit():GoldenFixture{
  const scenarios=['scenario-a'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home','text',scenarios),tap('show-error','Submit','text',scenarios),tap('open-detail','Detail','text',scenarios)]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail','text',scenarios)]),
      screen('more','More',420,320,[check('more-ready','More','text',scenarios)]),
    ],
    edges:[edge('go','home','detail','open-detail','detail-ready','Home → Detail',['open-detail'])],
    paths:[{id:'route',name:'Retarget frozen visit',scenarioId:'scenario-a',screenId:'home',edgeIds:['go'],visits:[
      {id:'visit-1',operationIds:['home-ready','show-error','open-detail']},
      {id:'visit-2',operationIds:['detail-ready']},
    ]}],
  };
  return {id:'retarget-frozen-visit',description:'Visit 1 holds a same-screen tap before the navigating tap. After the Detail check is removed from Visit 2, retargeting the navigating tap onto More keeps the route id, keeps the same-screen tap in place and off the connection, and the route still projects.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Retarget frozen visit',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'delete-step',actionId:'detail-ready',visitId:'visit-2'},
    {op:'retarget',screenId:'home',actionId:'open-detail',to:'more',visitId:'visit-1'},
  ]};
}

function retargetSameScreen():GoldenFixture{
  const scenarios=['scenario-a'];
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[check('home-ready','Home','text',scenarios),tap('show-error','Submit','text',scenarios),tap('open-detail','Detail','text',scenarios)]),
      screen('detail','Detail',420,40,[check('detail-ready','Detail','text',scenarios)]),
    ],
    edges:[edge('go','home','detail','open-detail','detail-ready','Home → Detail',['open-detail'])],
    paths:[{id:'route',name:'Retarget to same screen',scenarioId:'scenario-a',screenId:'home',edgeIds:['go'],visits:[
      {id:'visit-1',operationIds:['home-ready','show-error','open-detail']},
      {id:'visit-2',operationIds:['detail-ready']},
    ]}],
  };
  return {id:'retarget-same-screen',description:'Choosing the current destination again for the navigating tap is a no-op. The graph, YAML and route projection stay as they were.',scenarioMode:true,pathId:'route',scenarioId:'scenario-a',scenarios:[{id:'scenario-a',name:'Retarget to same screen',pathId:'route'}],...materialize(canvas),scripts:[
    {op:'retarget',screenId:'home',actionId:'open-detail',to:'detail',visitId:'visit-1'},
  ]};
}

function legacyMissingDestination():GoldenFixture{
  const canvas:CanvasGraph={
    screens:[
      screen('home','Home',40,40,[{...tap('gear','Gear'),label:'tap Gear'},check('home-ready','Home')]),
      screen('settings','Settings',420,40,[check('settings-ready','Settings')]),
    ],
    edges:[],
    paths:[{id:'route',name:'Home checks',screenId:'home',edgeIds:[]}],
  };
  return {id:'legacy-missing-destination',description:'A legacy start-only route whose tap has no destination does not project: it reports the missing destination. Connecting the tap to Settings makes the route project.',scenarioMode:false,pathId:'route',scenarios:[],...materialize(canvas),scripts:[
    {op:'connect',screenId:'home',actionId:'gear',to:'settings'},
  ]};
}

export function buildGoldenFixtures():GoldenFixture[]{
  return [linearRoute(),textTap(),idTap(),literalBack(),backControlFixture(),repeatedVisit(),sharedStep(),multiActionEdge(),unfrozenVisits(),legacyVisits(),deletionCut(),defaultActions(),sameScreenSteps(),staysOnScreen(),checkAfterNavigation(),sameScreenLastVisit(),retargetFrozenVisit(),retargetSameScreen(),legacyMissingDestination()];
}
