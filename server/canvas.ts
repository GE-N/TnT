import type {Automation,AutomationResult} from './default-actions.js';
import {createHash} from 'node:crypto';
import {parseAllDocuments, stringify} from 'yaml';
import {authoredChecks,checkProblem,type ScreenCheck} from '../shared/canvas-authoring.js';
import type {Step} from './scenarios.js';

export type YAMLReference={kind:'step'|'flow'|'setup'|'handler';file:string;index?:number;actionId?:string;fingerprint:string};
export type CanvasTest={check?:ScreenCheck;id:string;label:string;role:'action'|'assertion'|'setup'|'handler'|'test';reference:YAMLReference};
export type ScreenNode={id:string;title:string;x:number;y:number;referenceScreenshot?:string;tests:CanvasTest[]};
export type Transition={id:string;from:string;to:string;actionTestId:string;assertionTestId:string;responseCondition:string};
export type CanvasGraph={screens:ScreenNode[];edges:Transition[];paths:{id:string;name:string;edgeIds:string[];screenId?:string}[]};
export type CatalogEntry=YAMLReference & {label:string;command:string;assertion:boolean;preview:string};
export type CanvasDiagnostic={ownerId:string;detail:string};
export type CanvasResult={pathId:string;note:string;tests:{id:string;status:Step['status'];stepId?:string;detail:string}[];screens:{id:string;status:Step['status']}[];edges:{id:string;status:Step['status']}[]};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function document(yaml:string){
 const docs=parseAllDocuments(yaml);
 if(docs.length!==2||docs.some(doc=>doc.errors.length)||!Array.isArray(docs[1].toJS())) throw new Error('Repair YAML: an appId header, --- separator and command list are required.');
 return {config:docs[0].toJS() as unknown,commands:docs[1].toJS() as unknown[]};
}
function commands(yaml:string){return document(yaml).commands;}
function commandName(value:unknown){return typeof value==='string'?value:value&&typeof value==='object'?Object.keys(value)[0]:'';}
function calledFile(value:unknown){if(!value||typeof value!=='object'||!('runFlow' in value))return;const flow=value.runFlow;return typeof flow==='string'?flow:flow&&typeof flow==='object'&&'file' in flow&&typeof flow.file==='string'?flow.file:undefined;}
function inlineCommands(value:unknown):unknown[]{
 if(!value||typeof value!=='object'||!('runFlow' in value)||!value.runFlow||typeof value.runFlow!=='object'||!('commands' in value.runFlow))return [];
 return Array.isArray(value.runFlow.commands)?value.runFlow.commands:[];
}
function containsAssertion(values:unknown[],flows:Record<string,string>):boolean{
 const queue=[...values];const seen=new Set<string>();
 while(queue.length){const value=queue.shift();if(commandName(value)?.startsWith('assert'))return true;queue.push(...inlineCommands(value));const file=calledFile(value);if(!file||seen.has(file)||!Object.hasOwn(flows,file))continue;seen.add(file);try{queue.push(...commands(flows[file]));}catch{ /* Invalid references have their own diagnostics. */ }}
 return false;
}
function executableFingerprint(values:unknown[],flows:Record<string,string>,configuration:unknown){
 const dependencies=new Map<string,unknown>();const queue=[...values];
 while(queue.length){const value=queue.shift();queue.push(...inlineCommands(value));const file=calledFile(value);if(!file||dependencies.has(file))continue;
  if(!Object.hasOwn(flows,file)){dependencies.set(file,null);continue;}
  try{const nested=document(flows[file]);dependencies.set(file,nested);queue.push(...nested.commands);}catch{dependencies.set(file,flows[file]);}
 }
 return digest({commands:values,configuration,dependencies:[...dependencies.entries()].sort(([a],[b])=>a.localeCompare(b))});
}
export function referenceCatalog(yaml:string,flows:Record<string,string>={},automation?:Automation){
 const references:CatalogEntry[]=[];const diagnostics:CanvasDiagnostic[]=[];
 let root:ReturnType<typeof document>|undefined;
 try{
  const source=document(yaml);root=source;source.commands.forEach((value,index)=>{const command=commandName(value)||'Unknown';references.push({kind:'step',file:'flow.yaml',index,fingerprint:executableFingerprint([value],flows,source.config),label:`Step ${index+1} · ${command}`,command,assertion:containsAssertion([value],flows),preview:stringify(value)});});
 }catch(error){diagnostics.push({ownerId:'yaml',detail:(error as Error).message});}
 for(const [file,yaml] of Object.entries(flows)){
  try{const source=document(yaml);const values=source.commands;const configuration={file:source.config,root:root?.config,invocations:root?.commands.filter(value=>calledFile(value)===file)};references.push({kind:'flow',file,fingerprint:executableFingerprint(values,flows,configuration),label:file,command:'runFlow',assertion:containsAssertion(values,flows),preview:yaml});}
  catch(error){diagnostics.push({ownerId:file,detail:(error as Error).message});}
 }
 if(automation&&root){
  const setup=automation.setup;
  references.push({kind:'setup',file:setup.file,fingerprint:executableFingerprint([{runFlow:{file:setup.file,env:setup.parameters}}],flows,{root:root.config,policy:'relaunch-preserve-data'}),label:'Independent setup · '+setup.file,command:'runFlow',assertion:false,preview:stringify(setup)});
  for(const checkpoint of automation.checkpoints)for(const action of automation.actions){
   references.push({kind:'handler',file:action.file,index:checkpoint.beforeStep,actionId:action.id,fingerprint:executableFingerprint([{runFlow:{file:action.file,env:action.parameters}}],flows,{root:root.config,checkpoint,actions:automation.actions}),label:`Default action · ${action.name} · before step ${checkpoint.beforeStep+1}`,command:'runFlow',assertion:false,preview:stringify({condition:action.condition,flow:action.file,parameters:action.parameters,enabled:action.enabled,checkpoint})});
  }
 }
 return {references,diagnostics};
}
export function readCanvas(value:unknown):CanvasGraph|undefined{
 if(value===undefined)return;
 if(!value||typeof value!=='object')throw new Error('Provide a screen canvas.');
 const graph=structuredClone(value) as CanvasGraph;
 if(!Array.isArray(graph.screens)||!Array.isArray(graph.edges)||!Array.isArray(graph.paths)||graph.screens.length>40||graph.edges.length>80||graph.paths.length>20)throw new Error('Canvas limits: 40 screens, 80 transitions and 20 paths.');
 const text=(value:unknown,max=120)=>typeof value==='string'&&value.length>0&&value.length<=max;
 const ids=new Set<string>();const id=(value:unknown)=>{if(!text(value)||ids.has(value as string))throw new Error('Canvas identities must be unique, nonempty strings.');ids.add(value as string);};
 for(const screen of graph.screens){
  id(screen.id);if(!text(screen.title)||!Number.isFinite(screen.x)||!Number.isFinite(screen.y)||screen.x<0||screen.y<0||screen.x>2400||screen.y>1400||!Array.isArray(screen.tests)||screen.tests.length>30)throw new Error('Provide titled screens with positions and up to 30 tests each.');
  if(screen.referenceScreenshot!==undefined&&(!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(screen.referenceScreenshot)||screen.referenceScreenshot.length>350_000))throw new Error('Reference screenshots must be PNG/JPEG data up to 250 KB.');
  for(const test of screen.tests){id(test.id);if(!text(test.label)||!['action','assertion','setup','handler','test'].includes(test.role)||!test.reference||!['step','flow','setup','handler'].includes(test.reference.kind)||!text(test.reference.file,80)||!text(test.reference.fingerprint,64))throw new Error('Provide named tests with explicit YAML references.');
   if(test.check&&(!['visible','absent'].includes(test.check.visibility)||!['text','id'].includes(test.check.target)||!['exact','contains','regex'].includes(test.check.match)||typeof test.check.value!=='string'||test.check.value.length>4000))throw new Error('Provide a bounded visible/absent check selector.');
   const reference=test.reference;
   if(['step','handler'].includes(reference.kind)&&(!Number.isInteger(reference.index)||reference.index!<0))throw new Error('Step/handler references require a nonnegative command position.');
   if(reference.kind==='handler'&&!text(reference.actionId))throw new Error('Handler references require their explicit default-action identity.');
   test.reference={kind:reference.kind,file:reference.file,index:reference.index,actionId:reference.actionId,fingerprint:reference.fingerprint};
  }
 }
 for(const edge of graph.edges){id(edge.id);if(![edge.from,edge.to,edge.actionTestId,edge.assertionTestId].every(item=>text(item))||!text(edge.responseCondition,300))throw new Error('Transitions require source/destination, action/assertion references and response condition.');}
 for(const path of graph.paths){id(path.id);if(path.screenId!==undefined&&!text(path.screenId))throw new Error('Choose an initial screen identity.');if(!text(path.name)||!Array.isArray(path.edgeIds)||path.edgeIds.length>80||path.edgeIds.some(item=>!text(item)))throw new Error('Paths need a name and explicitly ordered transition identities.');}
 return graph;
}
function sameLocation(a:YAMLReference,b:YAMLReference){return a.kind===b.kind&&a.file===b.file&&a.index===b.index&&a.actionId===b.actionId;}
function resolveReference(reference:YAMLReference,catalog:CatalogEntry[]){return catalog.find(entry=>sameLocation(entry,reference)&&entry.fingerprint===reference.fingerprint);}
function executionIndex(reference:YAMLReference,yaml:string){
 if(reference.kind==='setup')return -1;
 if(reference.kind==='handler'||reference.kind==='step')return reference.index;
 const matches=commands(yaml).flatMap((value,index)=>calledFile(value)===reference.file?[index]:[]);
 return matches.length===1?matches[0]:undefined;
}
export function inspectCanvas(graph:CanvasGraph,yaml:string,flows:Record<string,string>={},automation?:Automation){
 const catalog=referenceCatalog(yaml,flows,automation);const diagnostics=[...catalog.diagnostics];
 const screens=new Map(graph.screens.map(screen=>[screen.id,screen]));
 const tests=new Map(graph.screens.flatMap(screen=>screen.tests.map(test=>[test.id,{test,screen}] as const)));
 let authored:ReturnType<typeof authoredChecks>=[];try{authored=authoredChecks(yaml);}catch{ /* YAML catalog reports parse diagnostics. */ }
 for(const {test} of tests.values()){
  if(test.check){const matches=authored.filter(item=>item.id===test.id);const issue=checkProblem(test.check);if(issue||matches.length!==1||!matches[0].check)diagnostics.push({ownerId:test.id,detail:issue??'Check YAML is missing, unsupported or ambiguous. Repair its command or selector before running.'});continue;}
  if(!resolveReference(test.reference,catalog.references)){
   const alternatives=catalog.references.filter(entry=>entry.kind===test.reference.kind&&entry.file===test.reference.file&&entry.fingerprint===test.reference.fingerprint);
   diagnostics.push({ownerId:test.id,detail:alternatives.length>1?'Ambiguous moved YAML reference. Explicitly choose its intended command again.':'Broken or stale YAML reference. Explicitly relink to the intended command; references are never retargeted automatically.'});
  }
 }
 for(const edge of graph.edges){
  const action=tests.get(edge.actionTestId);const assertion=tests.get(edge.assertionTestId);
  if(!screens.has(edge.from)||!screens.has(edge.to)||action?.screen.id!==edge.from||assertion?.screen.id!==edge.to)diagnostics.push({ownerId:edge.id,detail:'Repair transition screen/action/assertion associations.'});
  const target=assertion&&resolveReference(assertion.test.reference,catalog.references);
  if(target&&!target.assertion)diagnostics.push({ownerId:edge.id,detail:'The destination must reference an executable assertion or assertion flow.'});
 }
 for(const path of graph.paths){
  if(path.screenId&&!screens.has(path.screenId))diagnostics.push({ownerId:path.id,detail:'Restore or select the initial screen for this scenario.'});
  const edges=path.edgeIds.map(id=>graph.edges.find(edge=>edge.id===id));
  if(edges.some(edge=>!edge)||edges.some((edge,index)=>index>0&&edge?.from!==edges[index-1]?.to))diagnostics.push({ownerId:path.id,detail:'Repair the ordered route: every transition must exist and continue from the previous destination.'});
 }
 return {references:catalog.references,diagnostics};
}
export function selectedCanvasPath(graph:CanvasGraph,yaml:string,flows:Record<string,string>,pathId:unknown,automation?:Automation){
 if(typeof pathId!=='string')throw new Error('Explicitly select a canvas scenario path before running.');
 const path=graph.paths.find(path=>path.id===pathId);if(!path||(!path.edgeIds.length&&!path.screenId))throw new Error('Select a nonempty explicit scenario path.');
 const inspection=inspectCanvas(graph,yaml,flows,automation);
 const edges=path.edgeIds.map(id=>graph.edges.find(edge=>edge.id===id));
 const required=new Set(['yaml',pathId,...path.edgeIds,...edges.flatMap(edge=>edge?[edge.actionTestId,edge.assertionTestId]:[])]);
 if(path.screenId){required.add(path.screenId);for(const test of graph.screens.find(screen=>screen.id===path.screenId)?.tests??[])required.add(test.id);}
 const errors=inspection.diagnostics.filter(diagnostic=>required.has(diagnostic.ownerId));
 if(errors.length)throw new Error(errors.map(error=>error.detail).join(' '));
 if(path.screenId&&!path.edgeIds.length){const screen=graph.screens.find(screen=>screen.id===path.screenId)!;if(!screen.tests.some(test=>test.check))throw new Error('Add at least one screen check before running.');return path;}
 const tests=new Map(graph.screens.flatMap(screen=>screen.tests.map(test=>[test.id,test] as const)));
 let previous=-Infinity;
 for(const edge of edges as Transition[]){
  const action=tests.get(edge.actionTestId)!;const assertion=tests.get(edge.assertionTestId)!;
  const actionIndex=executionIndex(action.reference,yaml);const assertionIndex=executionIndex(assertion.reference,yaml);
  if(['handler','setup'].includes(assertion.reference.kind))throw new Error('A destination requires an authored assertion, separate from setup/default actions.');
  if(actionIndex===undefined||assertionIndex===undefined)throw new Error('A selected flow is uncalled or called ambiguously. Reference its explicit top-level runFlow step instead.');
  const actionPosition=action.reference.kind==='setup'?-1:actionIndex*2+(action.reference.kind==='handler'?0:1);
  const assertionPosition=assertionIndex*2+1;
  if(actionPosition<=previous||assertionPosition<=actionPosition)throw new Error('The selected route must follow executable YAML action/assertion order. Repair references or YAML; the canvas cannot rewrite execution.');
  previous=assertionPosition;
 }
 return path;
}
export function mapCanvas(graph:CanvasGraph,pathId:string,yaml:string,steps:Step[],running=false,execution?:{definition:Automation;result?:AutomationResult;flows?:Record<string,string>}):CanvasResult{
 const path=graph.paths.find(path=>path.id===pathId)!;
 const selectedEdges=graph.edges.filter(edge=>path.edgeIds.includes(edge.id));
 const selectedScreens=new Set(selectedEdges.flatMap(edge=>[edge.from,edge.to]));
 const selectedTests=new Set(selectedEdges.flatMap(edge=>[edge.actionTestId,edge.assertionTestId]));
 if(path.screenId){selectedScreens.add(path.screenId);for(const test of graph.screens.find(screen=>screen.id===path.screenId)?.tests??[])selectedTests.add(test.id);}
 const destinationTests=new Set(selectedEdges.map(edge=>edge.assertionTestId));
 if(path.screenId)for(const test of graph.screens.find(screen=>screen.id===path.screenId)?.tests??[])if(test.check)destinationTests.add(test.id);
 const authored=authoredChecks(yaml);
 const catalog=execution?referenceCatalog(yaml,execution.flows,execution.definition).references:[];
 const tests=graph.screens.flatMap(screen=>screen.tests.map(test=>{
  const reference=test.reference;
  const auxiliary=reference.kind==='setup'||reference.kind==='handler';
  const included=selectedTests.has(test.id)||(auxiliary&&selectedScreens.has(screen.id));
  if(running||!included)return {id:test.id,status:'unavailable' as Step['status'],detail:running?'Outcomes become available after execution.':'Not selected in this route.'};
  if(auxiliary&&!resolveReference(reference,catalog))return {id:test.id,status:'unavailable' as Step['status'],detail:'Broken or stale setup/handler reference in this snapshot; explicitly relink it.'};
  if(reference.kind==='setup')return {id:test.id,status:execution?.result?.setup.status??'unavailable' as Step['status'],detail:'Mapped from the declared setup invocation in this snapshot.'};
  if(reference.kind==='handler'){
   const outcome=execution?.result?.actions.find(action=>action.id===reference.actionId&&action.beforeStep===reference.index);
   return {id:test.id,status:outcome?.status??'unavailable' as Step['status'],detail:outcome?.detail??'No verified outcome for this action at its explicit checkpoint.'};
  }
  const index=test.check?authored.find(item=>item.id===test.id)?.index:executionIndex(reference,yaml);const step=index===undefined?undefined:steps[index];
  const outcome=destinationTests.has(test.id)?step?.status==='failed'?'failed':step?.assertionStatus??'unavailable':step?.status??'unavailable';
  return {id:test.id,status:outcome as Step['status'],stepId:step?.id,detail:index===undefined?'Uncalled or ambiguous reusable flow; no outcome inferred.':destinationTests.has(test.id)?'Destination requires completed assertion metadata; a successful flow wrapper alone is insufficient.':'Mapped from top-level authored YAML command outcome.'};
 }));
 const status=(ids:string[]):Step['status']=>{const outcomes=ids.map(id=>tests.find(test=>test.id===id)?.status??'unavailable');return outcomes.includes('failed')?'failed':outcomes.length&&outcomes.every(status=>status==='passed')?'passed':outcomes.length&&outcomes.every(status=>status==='skipped')?'skipped':'unavailable';};
 return {pathId,note:'Post-run authored step, declared setup and checkpoint-specific handler outcomes are mapped from the executed snapshot. Live per-step reporting remains unavailable; no alternate route is inferred.',tests,screens:graph.screens.map(screen=>({id:screen.id,status:screen.tests.some(test=>tests.find(outcome=>outcome.id===test.id)?.status==='failed')?'failed':status(screen.tests.filter(test=>selectedTests.has(test.id)).map(test=>test.id))})),edges:graph.edges.map(edge=>({id:edge.id,status:path.edgeIds.includes(edge.id)?status([edge.actionTestId,edge.assertionTestId]):'unavailable'}))};
}
