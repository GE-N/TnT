import {isSeq,parseAllDocuments} from 'yaml';
import {attachLeadingComments,authoredChecks,unconnectedScenarioActions,scenarioActions,edgeActions,edgeChecks,routeVisits,visitChecks,visitScreenId,isAuthored} from '../shared/canvas-authoring.js';
import {inspectCanvas,referenceCatalog,selectedCanvasPath,type CanvasGraph,type CanvasExecution} from './canvas.js';
import type {Automation} from './default-actions.js';

// Expand a finite route into distinct command occurrences, preserving unassociated YAML.
// Legacy association-only canvases retain their authored YAML order.
export function projectCanvasRoute(graph:CanvasGraph,yaml:string,flows:Record<string,string>,pathId:unknown,automation?:Automation){
 const path=graph.paths.find(path=>path.id===pathId);
 if(path?.screenId&&!path.edgeIds.length)selectedCanvasPath(graph,yaml,flows,pathId,automation);
 if(!path||!path.scenarioId&&(!path.screenId||path.edgeIds.length>0)&&!path.edgeIds.some(id=>graph.edges.find(edge=>edge.id===id)?.actionTestIds)&&new Set(path.edgeIds).size===path.edgeIds.length&&!path.visits?.some(visit=>visit.checkIds!==undefined))return {canvas:graph,yaml,automation};
 const edges=path.edgeIds.map(id=>graph.edges.find(edge=>edge.id===id));
 const visits=routeVisits(graph,path);
 const tests=graph.screens.flatMap(screen=>screen.tests);
 const ordered=[...visitChecks(graph,path,0).map(testId=>({testId,visitId:visits[0].id,assertion:true,edgeId:undefined as string|undefined})),...edges.flatMap((edge,index)=>edge?[...scenarioActions(graph,edge,path.scenarioId).map(testId=>({testId,visitId:visits[index].id,assertion:false,edgeId:edge.id})),...visitChecks(graph,path,index+1).map(testId=>({testId,visitId:visits[index+1].id,assertion:true,edgeId:undefined}))]:[])];
 for(const [index,edge] of edges.entries()){if(edge&&!scenarioActions(graph,edge,path.scenarioId).length)throw new Error('Select at least one action for this scenario on connection '+edge.responseCondition+'.');if(edge&&!visitChecks(graph,path,index+1).length)throw new Error('Select at least one screen check for this scenario on its destination.');}
 const required=new Set(['yaml',path.id,...path.edgeIds,...ordered.map(item=>item.testId)]);
 if(path.scenarioId)for(const id of unconnectedScenarioActions(graph,path.scenarioId))required.add(id);
 const diagnostics=inspectCanvas(graph,yaml,flows,automation).diagnostics.filter(item=>required.has(item.ownerId));
 if(diagnostics.length)throw new Error(diagnostics.map(item=>item.detail).join(' '));
 const docs=parseAllDocuments(yaml);const sequence=docs[1]?.contents;
 if(!isSeq(sequence)||docs.some(doc=>doc.errors.length))throw new Error('Repair the executable YAML before running.');
 attachLeadingComments(sequence);
 const catalog=referenceCatalog(yaml,flows,automation).references;
 const linked=new Set(graph.edges.flatMap(edge=>[...edgeActions(edge),...edgeChecks(graph,edge)]));
 const owned=new Map<number,string>(tests.filter(test=>linked.has(test.id)&&!isAuthored(test)&&test.reference.kind==='step'&&catalog.some(entry=>entry.kind==='step'&&entry.index===test.reference.index&&entry.fingerprint===test.reference.fingerprint)).map(test=>[test.reference.index!,test.id]));
 for(const item of authoredChecks(yaml).filter(item=>tests.some(test=>test.id===item.id)))owned.set(item.index,item.id!);
 const commands=ordered.filter(item=>!['handler','setup'].includes(tests.find(test=>test.id===item.testId)!.reference.kind));
 const indices=commands.map(item=>tests.find(test=>test.id===item.testId)!.reference.index);
 if(indices.some(index=>index===undefined||!sequence.items[index]))throw new Error('Restore the selected action or check in YAML before running.');
 const selected=new Set(ordered.map(item=>item.testId));let cursor=0;
 const positions=new Map<number,number[]>();const occurrencePositions:number[]=[];
 const retained:typeof sequence.items=[];
 const lastSlot=sequence.items.findLastIndex((_node,index)=>selected.has(owned.get(index)??''));
 const originalItems=sequence.items;
 function appendCommand(){
  const original=indices[cursor++]!;const index=retained.length;
  positions.set(original,[...positions.get(original)??[],index]);occurrencePositions.push(index);
  // Serialization reuses selectors/comments without editing the authored command.
  retained.push(originalItems[original]);
 }
 for(const [index,node] of sequence.items.entries()){
  const owner=owned.get(index);
  if(owner){if(selected.has(owner)&&cursor<indices.length)appendCommand();}
  else{positions.set(index,[retained.length]);retained.push(node);}
  if(index===lastSlot)while(cursor<indices.length)appendCommand();
 }
 sequence.items=retained;
 const executionYaml=docs[0].toString()+'---\n'+docs[1].toString({directives:false});
 const target=referenceCatalog(executionYaml,flows).references;
 const projectedAutomation=automation&&{...automation,checkpoints:automation.checkpoints.flatMap(check=>{
  const original=catalog.find(entry=>entry.kind==='step'&&entry.index===check.beforeStep);
  if(original?.fingerprint!==check.fingerprint)throw new Error('Repair the stale default-action checkpoint before running.');
  return (positions.get(check.beforeStep)??[]).map(index=>({...check,beforeStep:index,fingerprint:target.find(entry=>entry.kind==='step'&&entry.index===index)!.fingerprint}));
 })};
 const projectedCatalog=referenceCatalog(executionYaml,flows,projectedAutomation).references;
 const plan:CanvasExecution={pathId:path.id,visits:visits.map((visit,index)=>({id:visit.id,screenId:visitScreenId(graph,path,index)!,checkIds:visitChecks(graph,path,index)})),transitions:edges.map((edge,index)=>({id:visits[index+1].id+':transition',edgeId:edge!.id,visitId:visits[index].id,destinationVisitId:visits[index+1].id})),occurrences:[]};
 cursor=0;
 for(const item of ordered){
  const test=tests.find(test=>test.id===item.testId)!;const ref=test.reference;
  const index=ref.kind==='setup'?undefined:ref.kind==='handler'?(positions.get(ref.index!)??[]).find(index=>index>=(occurrencePositions[cursor-1]??0)):occurrencePositions[cursor++];
  const entry=projectedCatalog.find(entry=>entry.kind===ref.kind&&entry.file===ref.file&&entry.index===index&&entry.actionId===ref.actionId);
  if(!entry)throw new Error('Restore the selected occurrence reference before running.');
  plan.occurrences.push({...item,id:'occurrence:'+JSON.stringify([item.visitId,item.testId]),reference:{kind:entry.kind,file:entry.file,index:entry.index,actionId:entry.actionId,fingerprint:entry.fingerprint}});
 }
 return {canvas:{...structuredClone(graph),execution:plan},yaml:executionYaml,automation:projectedAutomation};
}
