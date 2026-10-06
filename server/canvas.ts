import {createHash} from 'node:crypto';
import {parseAllDocuments, stringify} from 'yaml';
import type {Step} from './scenarios.js';

export type YAMLReference={kind:'step'|'flow';file:string;index?:number;fingerprint:string};
export type CanvasTest={id:string;label:string;role:'action'|'assertion'|'setup'|'handler'|'test';reference:YAMLReference};
export type ScreenNode={id:string;title:string;x:number;y:number;referenceScreenshot?:string;tests:CanvasTest[]};
export type Transition={id:string;from:string;to:string;actionTestId:string;assertionTestId:string;responseCondition:string};
export type CanvasGraph={screens:ScreenNode[];edges:Transition[];paths:{id:string;name:string;edgeIds:string[]}[]};
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
export function referenceCatalog(yaml:string,flows:Record<string,string>={}){
 const references:CatalogEntry[]=[];const diagnostics:CanvasDiagnostic[]=[];
 let root:ReturnType<typeof document>|undefined;
 try{
  const source=document(yaml);root=source;source.commands.forEach((value,index)=>{const command=commandName(value)||'Unknown';references.push({kind:'step',file:'flow.yaml',index,fingerprint:executableFingerprint([value],flows,source.config),label:`Step ${index+1} · ${command}`,command,assertion:containsAssertion([value],flows),preview:stringify(value)});});
 }catch(error){diagnostics.push({ownerId:'yaml',detail:(error as Error).message});}
 for(const [file,yaml] of Object.entries(flows)){
  try{const source=document(yaml);const values=source.commands;const configuration={file:source.config,root:root?.config,invocations:root?.commands.filter(value=>calledFile(value)===file)};references.push({kind:'flow',file,fingerprint:executableFingerprint(values,flows,configuration),label:file,command:'runFlow',assertion:containsAssertion(values,flows),preview:yaml});}
  catch(error){diagnostics.push({ownerId:file,detail:(error as Error).message});}
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
  for(const test of screen.tests){id(test.id);if(!text(test.label)||!['action','assertion','setup','handler','test'].includes(test.role)||!test.reference||!['step','flow'].includes(test.reference.kind)||!text(test.reference.file,80)||!text(test.reference.fingerprint,64))throw new Error('Provide named tests with explicit YAML references.');
   const reference=test.reference;test.reference={kind:reference.kind,file:reference.file,index:reference.index,fingerprint:reference.fingerprint};
  }
 }
 for(const edge of graph.edges){id(edge.id);if(![edge.from,edge.to,edge.actionTestId,edge.assertionTestId].every(item=>text(item))||!text(edge.responseCondition,300))throw new Error('Transitions require source/destination, action/assertion references and response condition.');}
 for(const path of graph.paths){id(path.id);if(!text(path.name)||!Array.isArray(path.edgeIds)||path.edgeIds.length>80||path.edgeIds.some(item=>!text(item)))throw new Error('Paths need a name and explicitly ordered transition identities.');}
 return graph;
}
function sameLocation(a:YAMLReference,b:YAMLReference){return a.kind===b.kind&&a.file===b.file&&a.index===b.index;}
function resolveReference(reference:YAMLReference,catalog:CatalogEntry[]){return catalog.find(entry=>sameLocation(entry,reference)&&entry.fingerprint===reference.fingerprint);}
function executionIndex(reference:YAMLReference,yaml:string){
 if(reference.kind==='step')return reference.index;
 const matches=commands(yaml).flatMap((value,index)=>calledFile(value)===reference.file?[index]:[]);
 return matches.length===1?matches[0]:undefined;
}
export function inspectCanvas(graph:CanvasGraph,yaml:string,flows:Record<string,string>={}){
 const catalog=referenceCatalog(yaml,flows);const diagnostics=[...catalog.diagnostics];
 const screens=new Map(graph.screens.map(screen=>[screen.id,screen]));
 const tests=new Map(graph.screens.flatMap(screen=>screen.tests.map(test=>[test.id,{test,screen}] as const)));
 for(const {test} of tests.values()){
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
  const edges=path.edgeIds.map(id=>graph.edges.find(edge=>edge.id===id));
  if(edges.some(edge=>!edge)||edges.some((edge,index)=>index>0&&edge?.from!==edges[index-1]?.to))diagnostics.push({ownerId:path.id,detail:'Repair the ordered route: every transition must exist and continue from the previous destination.'});
 }
 return {references:catalog.references,diagnostics};
}
export function selectedCanvasPath(graph:CanvasGraph,yaml:string,flows:Record<string,string>,pathId:unknown){
 if(typeof pathId!=='string')throw new Error('Explicitly select a canvas scenario path before running.');
 const path=graph.paths.find(path=>path.id===pathId);if(!path||!path.edgeIds.length)throw new Error('Select a nonempty explicit scenario path.');
 const inspection=inspectCanvas(graph,yaml,flows);
 const edges=path.edgeIds.map(id=>graph.edges.find(edge=>edge.id===id));
 const required=new Set(['yaml',pathId,...path.edgeIds,...edges.flatMap(edge=>edge?[edge.actionTestId,edge.assertionTestId]:[])]);
 const errors=inspection.diagnostics.filter(diagnostic=>required.has(diagnostic.ownerId));
 if(errors.length)throw new Error(errors.map(error=>error.detail).join(' '));
 const tests=new Map(graph.screens.flatMap(screen=>screen.tests.map(test=>[test.id,test] as const)));
 let previous=-1;
 for(const edge of edges as Transition[]){
  const action=tests.get(edge.actionTestId)!;const assertion=tests.get(edge.assertionTestId)!;
  const actionIndex=executionIndex(action.reference,yaml);const assertionIndex=executionIndex(assertion.reference,yaml);
  if(action.role==='handler'||assertion.role==='handler')throw new Error('Handler execution requires #6; choose authored action/assertion references.');
  if(actionIndex===undefined||assertionIndex===undefined)throw new Error('A selected flow is uncalled or called ambiguously. Reference its explicit top-level runFlow step instead.');
  if(actionIndex<=previous||assertionIndex<=actionIndex)throw new Error('The selected route must follow executable YAML action/assertion order. Repair references or YAML; the canvas cannot rewrite execution.');
  previous=assertionIndex;
 }
 return path;
}
export function mapCanvas(graph:CanvasGraph,pathId:string,yaml:string,steps:Step[],running=false):CanvasResult{
 const path=graph.paths.find(path=>path.id===pathId)!;
 const selectedEdges=graph.edges.filter(edge=>path.edgeIds.includes(edge.id));
 const selectedTests=new Set(selectedEdges.flatMap(edge=>[edge.actionTestId,edge.assertionTestId]));
 const tests=graph.screens.flatMap(screen=>screen.tests.map(test=>{
  const index=executionIndex(test.reference,yaml);const step=index===undefined?undefined:steps[index];
  const available=!running&&selectedTests.has(test.id)&&test.role!=='handler'&&step;
  return {id:test.id,status:available?step.status:'unavailable' as Step['status'],stepId:available?step.id:undefined,detail:test.role==='handler'?'Handler execution/reporting requires #6.':!selectedTests.has(test.id)?'Not selected in this route.':running?'Outcomes become available after execution.':index===undefined?'Uncalled or ambiguous reusable flow; no outcome inferred.':'Mapped from top-level YAML command outcome.'};
 }));
 const status=(ids:string[]):Step['status']=>{const outcomes=ids.map(id=>tests.find(test=>test.id===id)?.status??'unavailable');return outcomes.includes('failed')?'failed':outcomes.length&&outcomes.every(status=>status==='passed')?'passed':outcomes.length&&outcomes.every(status=>status==='skipped')?'skipped':'unavailable';};
 return {pathId,note:'Post-run top-level command outcomes are the verified reporting baseline. No live per-step or handler outcome is inferred. The graph shows the executed snapshot, not subsequent workspace edits.',tests,screens:graph.screens.map(screen=>({id:screen.id,status:status(screen.tests.filter(test=>selectedTests.has(test.id)).map(test=>test.id))})),edges:graph.edges.map(edge=>({id:edge.id,status:path.edgeIds.includes(edge.id)?status([edge.actionTestId,edge.assertionTestId]):'unavailable'}))};
}
