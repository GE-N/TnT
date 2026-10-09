import {isSeq,parseAllDocuments} from 'yaml';
import {attachLeadingComments,authoredChecks,edgeActions,edgeChecks,initialCanvasScreen,screenChecks,isAuthored,refreshChecks} from '../shared/canvas-authoring.js';
import {inspectCanvas,referenceCatalog,type CanvasGraph} from './canvas.js';
import type {Automation} from './default-actions.js';

// Project canvas-owned commands for one explicit route; retain every unassociated command.
// Legacy association-only canvases continue to execute their authored YAML unchanged.
export function projectCanvasRoute(graph:CanvasGraph,yaml:string,flows:Record<string,string>,pathId:unknown,automation?:Automation){
 const path=graph.paths.find(path=>path.id===pathId);
 if(!path||!path.edgeIds.some(id=>graph.edges.find(edge=>edge.id===id)?.actionTestIds))return {canvas:graph,yaml,automation};
 const edges=path.edgeIds.map(id=>graph.edges.find(edge=>edge.id===id));
 const initial=initialCanvasScreen(graph,path);
 const ordered=[...screenChecks(graph,initial).map(test=>test.id),...edges.flatMap(edge=>edge?[...edgeActions(edge),...edgeChecks(graph,edge)]:[])];
 if(new Set(ordered).size!==ordered.length)throw new Error('This route repeats a screen check or action. Use a route with distinct visits until per-visit authoring is available.');
 const required=new Set(['yaml',path.id,...path.edgeIds,...ordered]);
 const diagnostics=inspectCanvas(graph,yaml,flows,automation).diagnostics.filter(item=>required.has(item.ownerId));
 if(diagnostics.length)throw new Error(diagnostics.map(item=>item.detail).join(' '));
 const docs=parseAllDocuments(yaml);const sequence=docs[1]?.contents;
 if(!isSeq(sequence)||docs.some(doc=>doc.errors.length))throw new Error('Repair the executable YAML before running.');
 attachLeadingComments(sequence);
 const catalog=referenceCatalog(yaml,flows,automation).references;
 const tests=graph.screens.flatMap(screen=>screen.tests);
 const linked=new Set(graph.edges.flatMap(edge=>[...edgeActions(edge),...edgeChecks(graph,edge)]));
 const owned=new Map<number,string>(tests.filter(test=>linked.has(test.id)&&!isAuthored(test)&&test.reference.kind==='step'&&catalog.some(entry=>entry.kind==='step'&&entry.index===test.reference.index&&entry.fingerprint===test.reference.fingerprint)).map(test=>[test.reference.index!,test.id]));
 for(const item of authoredChecks(yaml).filter(item=>tests.some(test=>test.id===item.id)))owned.set(item.index,item.id!);
 const indices=ordered.flatMap(id=>{const ref=tests.find(test=>test.id===id)?.reference;return ref&&['handler','setup'].includes(ref.kind)?[]:[ref?.index];});
 if(indices.some(index=>index===undefined||!sequence.items[index]))throw new Error('Restore the selected action or check in YAML before running.');
 const selected=new Set(ordered);let cursor=0;
 const positions=new Map<number,number>();
 const retained:typeof sequence.items=[];
 for(const [index,node] of sequence.items.entries()){
  const owner=owned.get(index);
  if(owner&&!selected.has(owner))continue;
  const original=owner?indices[cursor++]!:index;
  positions.set(original,retained.length);retained.push(sequence.items[original]);
 }
 sequence.items=retained;
 const executionYaml=docs[0].toString()+'---\n'+docs[1].toString({directives:false});
 const target=referenceCatalog(executionYaml,flows).references;
 const projectedAutomation=automation&&{...automation,checkpoints:automation.checkpoints.flatMap(check=>{
  const original=catalog.find(entry=>entry.kind==='step'&&entry.index===check.beforeStep);
  if(original?.fingerprint!==check.fingerprint)throw new Error('Repair the stale default-action checkpoint before running.');
  const index=positions.get(check.beforeStep);if(index===undefined)return [];
  return [{...check,beforeStep:index,fingerprint:target.find(entry=>entry.kind==='step'&&entry.index===index)!.fingerprint}];
 })};
 const projectedCatalog=referenceCatalog(executionYaml,flows,projectedAutomation).references;
 const projected=structuredClone(graph);
 for(const screen of projected.screens)for(const test of screen.tests){
  if(isAuthored(test)||!['step','handler','setup'].includes(test.reference.kind))continue;
  const ref=test.reference;
  if(!catalog.some(entry=>entry.kind===ref.kind&&entry.file===ref.file&&entry.index===ref.index&&entry.actionId===ref.actionId&&entry.fingerprint===ref.fingerprint))continue;
  const index=ref.kind==='setup'?undefined:positions.get(ref.index!);const entry=projectedCatalog.find(entry=>entry.kind===ref.kind&&entry.file===ref.file&&entry.index===index&&entry.actionId===ref.actionId);
  test.reference=entry?{...ref,index,fingerprint:entry.fingerprint}:{...ref,fingerprint:'not-selected'};
 }
 return {canvas:refreshChecks(projected,executionYaml),yaml:executionYaml,automation:projectedAutomation};
}
