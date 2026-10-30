import {createHash} from 'node:crypto';
import {parseAllDocuments} from 'yaml';
import type {Workspace,Run} from '../scenarios.js';
import type {ScenarioDefinition} from '../scenario-definitions.js';
import {canvasTestLabel,routeVisits,visitOperations,visitScreenId,unconnectedScenarioActions} from '../../shared/canvas-authoring.js';
import type {FlowFacts,SourceDescriptor,Evidence,ScenarioContext,ScenarioDetail} from './types.js';

export function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
}
export const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function parsed(yaml:string){
 const docs=parseAllDocuments(yaml);
 if(docs.length!==2||docs.some(doc=>doc.errors.length))return {config:null,commands:[] as unknown[],invalid:sha256(yaml)};
 try{const commands=docs[1].toJS({maxAliasCount:100});return {config:docs[0].toJS({maxAliasCount:100}) as unknown,commands:Array.isArray(commands)?commands:[],...(!Array.isArray(commands)?{invalid:sha256(yaml)}:{})};}
 catch{return {config:null,commands:[] as unknown[],invalid:sha256(yaml)};}
}
function commandLabel(value:unknown):string {
 const key=typeof value==='string'?value:value&&typeof value==='object'?Object.keys(value)[0]:undefined;
 if(!key)return 'Unavailable command';
 // Values (including input values, arbitrary JS and mock payloads) are not indexed.
 const names:Record<string,string>={launchApp:'Launch app',tapOn:'Tap',assertVisible:'Visible',assertNotVisible:'Absent',inputText:'Input text',back:'Back',runFlow:'Reusable flow',runScript:'Opaque script',evalScript:'Opaque script'};
 return names[key]??key;
}
function route(workspace:Workspace,scenario:ScenarioDefinition){
 const graph=workspace.canvas;const path=graph?.paths.find(path=>path.id===scenario.pathId);
 return {graph,path:path?{...path,scenarioId:scenario.id}:undefined};
}
/** Hash only scenario-relevant saved data. This never invokes the compiler or runner. */
export function sourceProjection(workspace:Workspace,scenario:ScenarioDefinition){
 const root=parsed(workspace.yaml);const {graph,path}=route(workspace,scenario);
 const tests=new Map(graph?.screens.flatMap(screen=>screen.tests.map(test=>[test.id,test] as const))??[]);
 let selected:unknown[];let visits:unknown[]|undefined;
 if(scenario.authoring==='canvas'&&graph&&path){
  const selectedIds=new Set<string>();
  visits=routeVisits(graph,path).map((visit,index)=>({id:visit.id,screenId:visitScreenId(graph,path,index)??null,operations:visitOperations(graph,path,index).map(id=>{
   selectedIds.add(id);const test=tests.get(id);
   return test?{id,role:test.role,check:test.check,tap:test.tap,input:test.input,back:test.back,backSelector:test.backSelector,command:root.commands[test.reference.index??-1]??{missing:true},referenceKind:test.reference.kind,file:test.reference.file}: {id,missing:true};
  })}));
  const ownedIndices=new Set([...tests.values()].filter(test=>test.reference.kind==='step').map(test=>test.reference.index));
  selected=root.commands.filter((_value,index)=>!ownedIndices.has(index));
  for(const id of unconnectedScenarioActions(graph,scenario.id)){const test=tests.get(id);selected.push({unconnected:id,command:test?root.commands[test.reference.index??-1]??{missing:true}:null});}
 }else selected=scenario.steps.map(ref=>root.commands[ref.index??-1]??{missing:ref.index});
 const setup=scenario.setup??workspace.automation?.setup;
 const actions=workspace.automation?.actions.filter(action=>scenario.enabledHandlerIds.includes(action.id)).map(({name,...action})=>action)??[];
 const selectedIndices=new Set(scenario.authoring==='canvas'&&graph&&path?routeVisits(graph,path).flatMap((_v,index)=>visitOperations(graph,path,index)).map(id=>tests.get(id)?.reference.index):scenario.steps.map(ref=>ref.index));
 const checkpoints=workspace.automation?.checkpoints.filter(check=>selectedIndices.has(check.beforeStep));
 const dependencies:Record<string,unknown>={};
 function walk(value:unknown){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach(walk);return;}
  const object=value as Record<string,unknown>;const invocation=object.runFlow;
  const file=typeof invocation==='string'?invocation:invocation&&typeof invocation==='object'&&'file' in invocation?invocation.file:undefined;
  if(typeof file==='string'&&!Object.hasOwn(dependencies,file)){
   dependencies[file]=null;const yaml=workspace.flows?.[file];if(yaml!==undefined){const source=parsed(yaml);dependencies[file]=source;walk(source.commands);}
  }
  Object.values(object).forEach(walk);
 }
 walk([selected,visits,setup?{runFlow:{file:setup.file}}:null,...actions.map(action=>({runFlow:{file:action.file}}))]);
 return {projectionVersion:1,config:root.config,invalid:root.invalid,commands:selected,visits,pathMissing:scenario.authoring==='canvas'&&!path?scenario.pathId??true:undefined,setup,actions,checkpoints,dependencies,parameters:scenario.parameters,inputNames:Object.keys(scenario.inputs??{}).sort(),mock:workspace.mock,mockResponseId:scenario.mockResponseId,scripts:scenario.scripts?.map(row=>({id:row.id,beforeStep:row.beforeStep,contentHash:sha256(row.source)}))};
}
export function sourceDescriptor(workspace:Workspace,scenario:ScenarioDefinition):SourceDescriptor{return {projectionVersion:1,workspaceRevision:workspace.metadata?.revision??0,sourceHash:sha256(canonical(sourceProjection(workspace,scenario)))};}
export function deriveFlow(workspace:Workspace,scenario:ScenarioDefinition):FlowFacts {
 const result:FlowFacts={steps:[],visits:[],diagnostics:[]};const {graph,path}=route(workspace,scenario);const root=parsed(workspace.yaml);
 if(root.invalid)result.diagnostics.push('Saved YAML is unavailable or invalid.');
 if(graph&&path){
  const tests=new Map(graph.screens.flatMap(screen=>screen.tests.map(test=>[test.id,test] as const)));
  result.visits=routeVisits(graph,path).map((visit,index)=>{
   const screenId=visitScreenId(graph,path,index)??'';const screen=graph.screens.find(screen=>screen.id===screenId);
   if(!screen)result.diagnostics.push('Missing screen for visit '+(index+1)+'.');
   const steps=visitOperations(graph,path,index).map(id=>{
    const test=tests.get(id);if(!test)result.diagnostics.push('Missing saved operation '+id+'.');
    else if(test.reference.kind==='step'&&root.commands[test.reference.index??-1]===undefined)result.diagnostics.push('Unavailable command for '+id+'.');
    const number=result.steps.length+1;const step={number,text:number+' · '+(test?canvasTestLabel(test):'Unavailable operation'),visitId:visit.id,testId:id};result.steps.push(step);return step;
   });
   return {number:index+1,id:visit.id,screenId,title:screen?.title??'Unavailable screen',steps};
  });
 }else {
  if(scenario.pathId)result.diagnostics.push('Saved scenario path is unavailable.');
  for(const ref of scenario.steps){const number=result.steps.length+1;const command=root.commands[ref.index??-1];if(command===undefined)result.diagnostics.push('Unavailable step '+number+'.');result.steps.push({number,text:number+' · '+commandLabel(command)});}
 }
 for(const script of scenario.scripts??[]){const number=result.steps.length+1;result.steps.push({number,text:number+' · Opaque script · '+script.label});}
 return result;
}
export const evidenceNotice='Run results do not establish authored expected outcomes.';
export function evidenceFor(runs:readonly Run[],workspaceId:string,scenarioId:string):Evidence{
 const run=runs.filter(run=>run.snapshot?.workspaceId===workspaceId&&run.snapshot?.scenario?.id===scenarioId&&run.status!=='running'&&typeof run.finishedAt==='string').sort((a,b)=>b.finishedAt!.localeCompare(a.finishedAt!)||b.id.localeCompare(a.id))[0];
 return run?{status:run.status,runId:run.id,finishedAt:run.finishedAt!,label:run.status,notice:evidenceNotice}:{status:null,runId:null,finishedAt:null,label:'No runs yet',notice:evidenceNotice};
}
export function makeDetail(workspace:Workspace,scenario:ScenarioDefinition,context:ScenarioContext,runs:readonly Run[]):ScenarioDetail{
 const descriptor=sourceDescriptor(workspace,scenario);const intentFreshness=context.reviewedAgainstSourceHash===descriptor.sourceHash?'reviewed':'intent-needs-review';
 return {workspaceId:workspace.id,scenarioId:scenario.id,title:scenario.name,context,sourceDescriptor:descriptor,flow:deriveFlow(workspace,scenario),evidence:evidenceFor(runs,workspace.id,scenario.id),freshness:intentFreshness==='reviewed'?'updating':'needs-review',publicationFreshness:'publication-stale',intentFreshness,generationId:null,generatedAt:null,publicationError:null,readerUrl:'/knowledge/workspaces/'+workspace.id+'/#scenario-'+scenario.id};
}
