import {projectCanvasRoute} from '../server/canvas-route.js';
import type {Automation} from '../server/default-actions.js';
import type {CanvasGraph} from '../server/canvas.js';
import {connectCanvasAction,connectVisitAction,planCanvasDeletion,privateVisitOperation,refreshChecks,routeVisits,visitOperations,visitScreenId,writeChecks} from '../shared/canvas-authoring.js';

export type GoldenScenario={id:string;name:string;pathId?:string};
export type GoldenScript=
  | {op:'connect'|'retarget'|'clear-destination';screenId:string;actionId:string;to?:string;visitId?:string}
  | {op:'delete-step';actionId:string;visitId?:string}
  | {op:'delete-connection';edgeId:string;visitId?:string}
  | {op:'delete-screen';screenId:string}
  | {op:'undo'};
export type GoldenFixture={
  id:string;
  description:string;
  scenarioMode:boolean;
  pathId:string;
  scenarioId?:string;
  scenarios:GoldenScenario[];
  yaml:string;
  flows?:Record<string,string>;
  automation?:Automation;
  canvas:CanvasGraph;
  scripts:GoldenScript[];
};
type UndoState={graph:CanvasGraph;yaml:string;after:CanvasGraph;afterYaml:string};
type RunnerState={graph:CanvasGraph;yaml:string;undo?:UndoState};

const uuidPattern=/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

function installSeed(){
  const target=globalThis.crypto;
  const original=target.randomUUID.bind(target);
  let next=0;
  const seeded=()=>{
    next+=1;
    return `00000000-0000-4000-8000-${next.toString(16).padStart(12,'0')}` as ReturnType<Crypto['randomUUID']>;
  };
  Object.defineProperty(target,'randomUUID',{configurable:true,writable:true,value:seeded});
  return ()=>Object.defineProperty(target,'randomUUID',{configurable:true,writable:true,value:original});
}
export function withSeededIds<T>(run:()=>T):T{
  const restore=installSeed();
  try{return run();}
  finally{restore();}
}
export async function withSeededIdsAsync<T>(run:()=>Promise<T>):Promise<T>{
  const restore=installSeed();
  try{return await run();}
  finally{restore();}
}

function canonicalize(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonicalize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value as Record<string,unknown>).sort().map(key=>[key,canonicalize((value as Record<string,unknown>)[key])]));
  return value;
}

/** Replace generated ids in first-seen order so a second run compares equal even if a render consumes an extra uuid. */
export function normalizeSnapshot(value:unknown){
  const json=JSON.stringify(canonicalize(value),null,2)+'\n';
  const ids=new Map<string,string>();
  return json.replace(uuidPattern,match=>{
    const key=match.toLowerCase();
    const existing=ids.get(key);
    if(existing)return existing;
    const assigned=`id:${ids.size+1}`;
    ids.set(key,assigned);
    return assigned;
  });
}

function presented(state:RunnerState,fixture:GoldenFixture):CanvasGraph{
  let graph=state.graph;
  try{graph=refreshChecks(graph,state.yaml);}catch{/* Keep the authored graph when YAML cannot be parsed. */}
  if(fixture.scenarioMode&&fixture.scenarioId){
    const scenarios=fixture.scenarios;
    graph={...graph,paths:graph.paths.map(path=>({...path,scenarioId:scenarios.find(item=>item.pathId===path.id)?.id??path.scenarioId}))};
  }
  return graph;
}

function apply(state:RunnerState,fixture:GoldenFixture,next:CanvasGraph,deletion:boolean):RunnerState{
  const previous=presented(state,fixture);
  const yaml=writeChecks(state.yaml,previous,next);
  const graph=refreshChecks(next,yaml);
  return {graph,yaml,undo:deletion?{graph:previous,yaml:state.yaml,after:graph,afterYaml:yaml}:state.undo};
}

function activePath(fixture:GoldenFixture){return fixture.pathId;}

/** Mirrors CanvasEditor destination, deletion and undo without rendering. */
export function applyScript(state:RunnerState,fixture:GoldenFixture,script:GoldenScript):RunnerState{
  const graph=presented(state,fixture);
  const pathId=activePath(fixture);
  if(script.op==='connect'||script.op==='retarget'){
    if(!script.to)throw new Error(script.op+' requires a destination screen.');
    const owned=script.visitId?privateVisitOperation(graph,pathId,script.visitId,script.actionId):{graph,testId:script.actionId};
    const next=script.visitId?connectVisitAction(owned.graph,pathId,script.visitId,owned.testId,script.to):connectCanvasAction(owned.graph,script.screenId,owned.testId,script.to,pathId).graph;
    return apply(state,fixture,next,false);
  }
  if(script.op==='clear-destination'){
    const owned=script.visitId?privateVisitOperation(graph,pathId,script.visitId,script.actionId):{graph,testId:script.actionId};
    const plan=planCanvasDeletion(owned.graph,{kind:'operation',id:owned.testId,clearDestination:true,...(script.visitId?{pathId,visitId:script.visitId}:{})});
    return apply(state,fixture,plan.graph,true);
  }
  if(script.op==='delete-step'){
    const plan=planCanvasDeletion(graph,{kind:'operation',id:script.actionId,...(script.visitId?{pathId,visitId:script.visitId}:{})});
    return apply(state,fixture,plan.graph,true);
  }
  if(script.op==='delete-connection'){
    const plan=planCanvasDeletion(graph,{kind:'connection',id:script.edgeId,...(script.visitId?{pathId,visitId:script.visitId}:fixture.scenarioMode?{pathId}:{})});
    return apply(state,fixture,plan.graph,true);
  }
  if(script.op==='delete-screen'){
    const plan=planCanvasDeletion(graph,{kind:'screen',id:script.screenId});
    return apply(state,fixture,plan.graph,true);
  }
  if(!state.undo)throw new Error('Undo is not available.');
  if(state.yaml!==state.undo.afterYaml||JSON.stringify(state.graph)!==JSON.stringify(state.undo.after))throw new Error('Undo is no longer available for the latest deletion.');
  return {graph:state.undo.graph,yaml:state.undo.yaml};
}

function routeProjection(graph:CanvasGraph,yaml:string,flows:Record<string,string>,automation?:Automation){
  return graph.paths.map(path=>{
    try{
      const result=projectCanvasRoute(graph,yaml,flows,path.id,automation);
      const plan=result.canvas.execution;
      if(!plan)return {pathId:path.id,unchanged:true,executionYaml:result.yaml,steps:[],transitions:[],projectedVisits:[],checkpoints:result.automation?.checkpoints??null,setup:result.automation?.setup??null};
      return {
        pathId:path.id,
        executionYaml:result.yaml,
        steps:plan.occurrences.map(item=>({id:item.id,visitId:item.visitId,testId:item.testId,edgeId:item.edgeId??null,assertion:item.assertion,reference:{kind:item.reference.kind,file:item.reference.file,index:item.reference.index??null,actionId:item.reference.actionId??null,fingerprint:item.reference.fingerprint}})),
        transitions:plan.transitions,
        projectedVisits:plan.visits,
        checkpoints:result.automation?.checkpoints??null,
        setup:result.automation?.setup??null,
      };
    }catch(error){
      return {pathId:path.id,error:error instanceof Error?error.message:String(error)};
    }
  });
}

export function captureState(state:RunnerState,fixture:GoldenFixture){
  return structuredClone({
    workspaceYaml:state.yaml,
    canvas:{
      screens:state.graph.screens.map(screen=>({id:screen.id,title:screen.title,tests:screen.tests.map(test=>test.id)})),
      edges:state.graph.edges.map(edge=>({id:edge.id,from:edge.from,to:edge.to,actionTestId:edge.actionTestId,actionTestIds:edge.actionTestIds??null})),
      paths:state.graph.paths.map(path=>({id:path.id,scenarioId:path.scenarioId??null,screenId:path.screenId??null,edgeIds:path.edgeIds})),
    },
    visits:state.graph.paths.flatMap(path=>routeVisits(state.graph,path).map((visit,index)=>({
      pathId:path.id,
      index,
      visitId:visit.id,
      screenId:visitScreenId(state.graph,path,index)??null,
      operationIds:visitOperations(state.graph,path,index),
      storedOperationIds:visit.operationIds??null,
      checkIds:visit.checkIds??null,
    }))),
    routes:routeProjection(state.graph,state.yaml,fixture.flows??{},fixture.automation),
  });
}

export type GoldenSnapshot={
  fixture:string;
  description:string;
  baseline:ReturnType<typeof captureState>;
  operations:{op:GoldenScript['op'];detail:GoldenScript;result:ReturnType<typeof captureState>}[];
};

export function runPure(fixture:GoldenFixture):GoldenSnapshot{
  return withSeededIds(()=>{
    let state:RunnerState={graph:structuredClone(fixture.canvas),yaml:fixture.yaml};
    const operations=[];
    for(const script of fixture.scripts){
      state=applyScript(state,fixture,script);
      operations.push({op:script.op,detail:script,result:captureState(state,fixture)});
    }
    return {fixture:fixture.id,description:fixture.description,baseline:captureState({graph:structuredClone(fixture.canvas),yaml:fixture.yaml},fixture),operations};
  });
}

export function snapshotText(snapshot:GoldenSnapshot){return normalizeSnapshot(snapshot);}
