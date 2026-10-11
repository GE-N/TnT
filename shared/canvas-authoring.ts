import {isNode,isSeq,parseAllDocuments,stringify,type YAMLSeq} from 'yaml';
import type {CanvasGraph,CanvasTest,CanvasVisit,Transition} from '../server/canvas.js';

export type ScreenSelector={target:'text'|'id';match:'exact'|'contains'|'regex';value:string};
export type ScreenCheck=ScreenSelector & {visibility:'visible'|'absent'};
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function checkPattern(check:ScreenSelector){return check.match==='regex'?check.value:check.match==='contains'?'.*'+escape(check.value)+'.*':'^'+escape(check.value)+'$';}
export function tapLabel(tap:ScreenSelector){return `Tap ${tap.target==='text'?'text':'element'} · ${tap.value||'Draft — selector needed'}`;}
export function checkLabel(check:ScreenCheck){return `${check.visibility==='visible'?'Visible':'Absent'} ${check.target==='text'?'text':'element'} · ${check.value||'Draft — selector needed'}`;}
export function isAuthored(test:Pick<CanvasTest,'check'|'tap'|'input'|'back'>){return Boolean(test.check||test.tap||test.input!==undefined||test.back);}
export function edgeActions(edge:Pick<Transition,'actionTestIds'|'actionTestId'>){return edge.actionTestIds??[edge.actionTestId];}
export function usedByScenario(test:CanvasTest,scenarioId?:string){return !scenarioId||test.scenarioIds===undefined||test.scenarioIds.includes(scenarioId);}
function scenarioOperationIds(graph:CanvasGraph,ids:string[],scenarioId?:string){
 const tests=new Map(graph.screens.flatMap(screen=>screen.tests.map(test=>[test.id,test] as const)));
 return ids.filter(id=>{const test=tests.get(id);return !test||usedByScenario(test,scenarioId);});
}
export function scenarioActions(graph:CanvasGraph,edge:Transition,scenarioId?:string){return scenarioOperationIds(graph,edgeActions(edge),scenarioId);}
export function unconnectedScenarioActions(graph:CanvasGraph,scenarioId:string){
 const connected=new Set(graph.edges.flatMap(edgeActions));
 return graph.screens.flatMap(screen=>screen.tests).filter(test=>isAuthored(test)&&!test.check&&test.scenarioIds?.includes(scenarioId)&&!connected.has(test.id)).map(test=>test.id);
}
export function backControl(test:Pick<CanvasTest,'back'|'backSelector'>):ScreenSelector|undefined{return test.back?(test.backSelector??{target:'text',match:'exact',value:'Back'}):undefined;}
export function operationProblem(test:CanvasTest){const selector=test.check??test.tap??backControl(test);return selector?checkProblem(selector):test.input!==undefined&&!test.input.trim()?'Enter input text before running.':undefined;}
export function canvasTestLabel(test:CanvasTest){return test.check?checkLabel(test.check):test.tap?tapLabel(test.tap):test.input!==undefined?'Input text · '+(test.input||'Draft — text needed'):test.back?'Back':test.label;}
export function checkProblem(check:ScreenSelector){
 if(!check.value.trim())return 'Enter a text or element identifier selector before running.';
 if(check.match==='regex')try{new RegExp(check.value);}catch{return 'Repair the check’s invalid Regex selector before running.';}
}
function source(yaml:string){
 const docs=parseAllDocuments(yaml);const sequence=docs[1]?.contents;
 if(docs.length!==2||docs.some(doc=>doc.errors.length)||!isSeq(sequence))throw new Error('Repair YAML: use an appId header, --- separator and command list.');
 for(const doc of docs)doc.toJS({maxAliasCount:100});
 attachLeadingComments(sequence);
 return {docs,sequence};
}
// Leading sequence comments belong to the original first command when projecting or editing.
export function attachLeadingComments(sequence:YAMLSeq){const first=sequence.items[0];if(sequence.commentBefore&&isNode(first)){first.commentBefore=[sequence.commentBefore,first.commentBefore].filter(Boolean).join('\n');sequence.commentBefore=undefined;}}
const marker=(comment?:string|null)=>comment?.match(/(?:^|\n)\s*tnt-check:([^\s]+)\s*(?:\n|$)/)?.[1];
export function authoredChecks(yaml:string){
 const {sequence}=source(yaml);
 return sequence.items.map((node,index)=>{
  const id=marker(node?.commentBefore);const value=node?.toJSON() as Record<string,unknown>|string|undefined;
  const command=typeof value==='string'?value:value&&Object.keys(value).length===1?Object.keys(value)[0]:'';
  const argument=command&&typeof value==='object'?value?.[command]:undefined;
  const selector=typeof argument==='string'?{text:argument}:argument&&typeof argument==='object'?argument as Record<string,unknown>:undefined;
  const target=selector&&Object.keys(selector).length===1&&['text','id'].includes(Object.keys(selector)[0])?Object.keys(selector)[0] as ScreenCheck['target']:undefined;
  const pattern=target?selector?.[target]:undefined;
  let check:ScreenCheck|undefined;let tap:ScreenSelector|undefined;
  if(!node?.anchor&&!node?.tag&&['assertVisible','assertNotVisible','tapOn'].includes(command)&&target&&typeof pattern==='string'){
   let match:ScreenCheck['match']='regex';let value=pattern;
   for(const mode of ['exact','contains'] as const){const inner=mode==='exact'&&pattern.startsWith('^')&&pattern.endsWith('$')?pattern.slice(1,-1):mode==='contains'&&pattern.startsWith('.*')&&pattern.endsWith('.*')?pattern.slice(2,-2):undefined;
    if(inner!==undefined){const literal=inner.replace(/\\([.*+?^${}()|[\]\\])/g,'$1');if(checkPattern({target,match:mode,value:literal})===pattern){match=mode;value=literal;break;}}
   }
   if(/(?:^|\n)\s*tnt-match:regex\s*(?:\n|$)/.test(node?.commentBefore??'')){match='regex';value=pattern;}
   if(command==='tapOn')tap={target,match,value};else check={visibility:command==='assertVisible'?'visible':'absent',target,match,value};
  }
  const input=!node?.anchor&&!node?.tag&&command==='inputText'&&typeof argument==='string'?argument:undefined;
  const back=!node?.anchor&&!node?.tag&&(value==='back'||tap&&/(?:^|\n)\s*tnt-back\s*(?:\n|$)/.test(node.commentBefore??''))?true:undefined;
  return {id,index,check,tap:back?undefined:tap,input,back,backSelector:back?tap:undefined};
 }).filter(item=>item.id);
}
export function refreshChecks(graph:CanvasGraph,yaml:string):CanvasGraph{
 let checks:ReturnType<typeof authoredChecks>;try{checks=authoredChecks(yaml);}catch{return graph;}
 return {...graph,edges:graph.edges.map(edge=>{const ordered=edge.actionTestIds?.every(id=>checks.some(item=>item.id===id))?[...edge.actionTestIds].sort((a,b)=>checks.find(item=>item.id===a)!.index-checks.find(item=>item.id===b)!.index):edge.actionTestIds;edge={...edge,actionTestIds:ordered};return edge.assertionTestId==='pending:'+edge.id?{...edge,assertionTestId:graph.screens.find(screen=>screen.id===edge.to)?.tests.find(test=>test.check)?.id??edge.assertionTestId}:edge;}),screens:graph.screens.map(screen=>{
  const tests=screen.tests.map(test=>{
   if(!isAuthored(test))return test;
   const matches=checks.filter(item=>item.id===test.id);const found=matches.length===1?matches[0]:undefined;
   return found&&isAuthored(found)?{...test,check:found.check,tap:found.tap,input:found.input,back:found.back,backSelector:found.backSelector,role:!found.check?'action' as const:'assertion' as const,reference:{...test.reference,index:found.index}}:test;
  });
  const executable=tests.filter(test=>isAuthored(test)&&checks.some(item=>item.id===test.id&&isAuthored(item))).sort((a,b)=>a.reference.index!-b.reference.index!);
  let cursor=0;return {...screen,tests:tests.map(test=>executable.some(item=>item.id===test.id)?executable[cursor++]:test)};
 })};
}
// Edit identified commands in place. Explicit reorder swaps only surviving check slots.
export function writeChecks(yaml:string,previous:CanvasGraph,next:CanvasGraph){
 const {docs,sequence}=source(yaml);
 if(sequence.flow)throw new Error('Convert the command list to block YAML before editing canvas checks.');
 const before=previous.screens.flatMap(screen=>screen.tests).filter(isAuthored);
 const after=next.screens.flatMap(screen=>screen.tests).filter(isAuthored);
 const owned=new Set([...before,...after].map(test=>test.id));
 const parsed=authoredChecks(yaml);
 const originals=new Map(sequence.items.map(node=>[marker(node?.commentBefore),node] as const));
 const replacements=new Map<string,(typeof sequence.items)[number]>();
 for(const test of after){
  const matches=parsed.filter(item=>item.id===test.id);const prior=before.find(item=>item.id===test.id);
  const selector=test.check??test.tap??backControl(test);const matched=matches[0]&&isAuthored(matches[0]);
  const shape=(test:{check?:ScreenCheck;tap?:ScreenSelector;input?:string;back?:boolean;backSelector?:ScreenSelector}|undefined)=>JSON.stringify({check:test?.check,tap:test?.tap,input:test?.input,back:test?.back,backSelector:test?.backSelector});
  const unchanged=shape(prior)===shape(test);
  if(matches.length>1)throw new Error('Ambiguous check YAML. Keep one command identity before editing this check.');
  if(matches.length&&!matched){if(unchanged){replacements.set(test.id,originals.get(test.id)!);continue;}throw new Error('This check contains unsupported YAML. Edit its code before changing the canvas form.');}
  if(!matches.length&&prior&&isAuthored(prior)&&!operationProblem(prior)&&unchanged)throw new Error('A check command was removed from YAML. Restore it or explicitly edit its selector before changing other checks.');
  if(operationProblem(test))continue;
  if(matched&&shape(matches[0])===shape(test)){replacements.set(test.id,originals.get(test.id)!);continue;}
  const single=source('appId: placeholder\n---\n'+stringify([test.input!==undefined?{inputText:test.input}:{[test.tap||test.back?'tapOn':test.check!.visibility==='visible'?'assertVisible':'assertNotVisible']:{[selector!.target]:checkPattern(selector!)}}]));
  const node=single.sequence.items[0]!;
  const comments=originals.get(test.id)?.commentBefore?.split('\n').filter(line=>!/^\s*tnt-(check|match):|^\s*tnt-back\s*$/.test(line))??[];
  node.commentBefore=[...comments,' tnt-check:'+test.id,...(test.back?[' tnt-back']:[]),...(selector?[' tnt-match:'+selector.match]:[])].join('\n');replacements.set(test.id,node);
 }
 const retained=sequence.items.filter(node=>!owned.has(marker(node?.commentBefore)??'')||replacements.has(marker(node?.commentBefore)??''));
 for(const [screenIndex,screen] of next.screens.entries()){
  const desired=screen.tests.map(test=>test.id).filter(id=>replacements.has(id));
  const existing=desired.filter(id=>originals.has(id));let cursor=0;
  for(let index=0;index<retained.length;index++)if(existing.includes(marker(retained[index]?.commentBefore)??''))retained[index]=replacements.get(existing[cursor++])!;
  for(let position=0;position<desired.length;position++){
   const id=desired[position];if(originals.has(id))continue;
   const following=desired.slice(position+1).find(id=>retained.some(node=>marker(node?.commentBefore)===id))??next.screens.slice(screenIndex+1).flatMap(screen=>screen.tests).find(test=>retained.some(node=>marker(node?.commentBefore)===test.id))?.id;
   const preceding=desired.slice(0,position).findLast(id=>retained.some(node=>marker(node?.commentBefore)===id))??next.screens.slice(0,screenIndex).flatMap(screen=>screen.tests).findLast(test=>retained.some(node=>marker(node?.commentBefore)===test.id))?.id;
   const insertion=following?retained.findIndex(node=>marker(node?.commentBefore)===following):preceding?retained.findIndex(node=>marker(node?.commentBefore)===preceding)+1:retained.length;
   retained.splice(insertion,0,replacements.get(id)!);
  }
 }
 sequence.items=retained;
 const yamlNext=docs[0].toString()+'---\n'+docs[1].toString({directives:false});source(yamlNext);return yamlNext;
}

// Choosing a destination owns the connection and extends only the active route's tail.
export function connectCanvasAction(graph:CanvasGraph,from:string,actionId:string,to:string,pathId:string){
 const connected=graph.edges.find(edge=>edge.from===from&&edgeActions(edge).includes(actionId));
 // Each destination control edits only its own action, preserving its siblings.
 if(connected&&edgeActions(connected).length>1&&connected.to!==to){
  const ids=edgeActions(connected).filter(id=>id!==actionId);
  graph={...graph,edges:graph.edges.map(edge=>edge.id===connected.id?{...edge,actionTestId:ids[0],actionTestIds:ids}:edge)};
 }
 const candidates=graph.edges.filter(edge=>edge.from===from&&edge.to===to);
 const previous=graph.edges.find(edge=>edge.from===from&&edgeActions(edge).includes(actionId))??(candidates.length===1?candidates[0]:candidates.find(edge=>edgeActions(edge).length===0));
 if(!to){const removed=graph.edges.filter(edge=>edgeActions(edge).includes(actionId)).map(edge=>edge.id);return {graph:{...graph,edges:graph.edges.filter(edge=>!removed.includes(edge.id)),paths:graph.paths.map(path=>({...path,edgeIds:path.edgeIds.filter(id=>!removed.includes(id)),visits:routeVisits(graph,path).filter((_visit,index)=>index===0||!removed.includes(path.edgeIds[index-1]))}))},pathId};}
 const destination=graph.screens.find(screen=>screen.id===to);if(!destination)throw new Error('Choose an existing destination screen.');
 if(!previous&&graph.edges.length>=80)throw new Error('This canvas supports up to 80 connections.');
 const preferred='action-link:'+actionId;
 const id=previous?.id??(graph.edges.some(edge=>edge.id===preferred)?crypto.randomUUID():preferred);
 const actions=previous?[...new Set([...edgeActions(previous),actionId])].filter(id=>!id.startsWith('pending:')):[actionId];
 const edge={id,from,to,actionTestId:actions[0],actionTestIds:previous?.actionTestIds!==undefined||actions.length>1?actions:undefined,assertionTestId:destination.tests.find(test=>test.check)?.id??'pending:'+id,responseCondition:previous?.responseCondition??graph.screens.find(screen=>screen.id===from)!.title+' → '+destination.title};
 let paths=graph.paths;let path=paths.find(path=>path.id===pathId)??paths.find(path=>path.edgeIds.includes(id))??paths.find(path=>path.screenId===from&&!path.edgeIds.length);
 if(!path){path={id:id+':path',name:(graph.screens.find(screen=>screen.id===from)!.title+' → '+destination.title).slice(0,120),screenId:from,edgeIds:[]};paths=[...paths,path];}
 const tail=visitScreenId(graph,path,path.edgeIds.length);
 if(tail===from&&!path.finished&&!path.edgeIds.includes(id))paths=paths.map(item=>item.id===path!.id?{...item,...appendRouteTransition(graph,item,id)}:item);
 return {graph:{...graph,edges:previous?graph.edges.map(item=>item.id===id?edge:item):[...graph.edges,edge],paths},pathId:path.id};
}

// A new connection extends only the explicitly selected tail; no branch is chosen for the user.
export function appendCanvasConnection(graph:CanvasGraph,edge:Transition,pathId:string):CanvasGraph{
 const path=graph.paths.find(item=>item.id===pathId);
 const tail=path?visitScreenId(graph,path,path.edgeIds.length):undefined;
 return {...graph,edges:[...graph.edges,edge],paths:graph.paths.map(item=>item.id===pathId&&!item.finished&&tail===edge.from?{...item,...appendRouteTransition(graph,item,edge.id)}:item)};
}

export function initialCanvasScreen(graph:CanvasGraph,path:CanvasGraph['paths'][number]){
 return path.screenId??(path.edgeIds.some(id=>graph.edges.find(edge=>edge.id===id)?.actionTestIds)?graph.edges.find(edge=>edge.id===path.edgeIds[0])?.from:undefined);
}
export function screenChecks(graph:CanvasGraph,screenId?:string){return graph.screens.find(screen=>screen.id===screenId)?.tests.filter(test=>test.check)??[];}
export function edgeChecks(graph:CanvasGraph,edge:Transition){
 const authored=edge.actionTestIds||graph.screens.find(screen=>screen.id===edge.from)?.tests.some(test=>test.id===edge.actionTestId&&isAuthored(test)&&!test.check);
 const checks=authored?screenChecks(graph,edge.to).map(test=>test.id):[];
 return authored?checks:[edge.assertionTestId];
}

// Older routes gain deterministic visit identities once saved. Edits retain surviving visits.
export function routeVisits(graph:CanvasGraph,path:CanvasGraph['paths'][number]):CanvasVisit[]{
 return path.visits??Array.from({length:path.edgeIds.length+1},(_value,index)=>({id:path.id+':visit:'+index,checkIds:undefined as string[]|undefined}));
}
export function visitChecks(graph:CanvasGraph,path:CanvasGraph['paths'][number],index:number){
 const screenId=visitScreenId(graph,path,index);
 const operations=routeVisits(graph,path)[index]?.operationIds;
 if(operations!==undefined)return operations.filter(id=>graph.screens.find(screen=>screen.id===screenId)?.tests.some(test=>test.id===id&&test.check));
 const selected=routeVisits(graph,path)[index]?.checkIds;
 const ids=selected??(index===0?screenChecks(graph,screenId).map(test=>test.id):graph.edges.find(edge=>edge.id===path.edgeIds[index-1])?edgeChecks(graph,graph.edges.find(edge=>edge.id===path.edgeIds[index-1])!):[]);
 return scenarioOperationIds(graph,ids,path.scenarioId);
}

export function appendRouteTransition(graph:CanvasGraph,path:CanvasGraph['paths'][number],edgeId:string){
 if(path.edgeIds.length>=80)throw new Error('A finite route supports up to 80 transitions.');
 return {...path,edgeIds:[...path.edgeIds,edgeId],visits:[...routeVisits(graph,path),{id:crypto.randomUUID(),...(routeVisits(graph,path).some(visit=>visit.operationIds!==undefined)?{operationIds:[]}: {})}]};
}

export function visitScreenId(graph:CanvasGraph,path:CanvasGraph['paths'][number],index:number){
 return index===0?(initialCanvasScreen(graph,path)??graph.edges.find(edge=>edge.id===path.edgeIds[0])?.from):graph.edges.find(edge=>edge.id===path.edgeIds[index-1])?.to;
}

// Explicit lists own the execution order of an individual visit. Older workspaces
// derive their original selection until an edit freezes it into visit lists.
export function visitOperations(graph:CanvasGraph,path:CanvasGraph['paths'][number],index:number):string[]{
 const visit=routeVisits(graph,path)[index];
 if(visit?.operationIds!==undefined)return visit.operationIds;
 const screenId=visitScreenId(graph,path,index);const screen=graph.screens.find(screen=>screen.id===screenId);
 const edge=graph.edges.find(edge=>edge.id===path.edgeIds[index]);
 const ids=new Set([...visitChecks(graph,path,index),...(edge?scenarioActions(graph,edge,path.scenarioId):[])]);
 if(path.scenarioId&&!routeVisits(graph,path).slice(0,index).some((_visit,i)=>visitScreenId(graph,path,i)===screenId)){
  for(const id of unconnectedScenarioActions(graph,path.scenarioId))if(screen?.tests.some(test=>test.id===id))ids.add(id);
 }
 return screen?.tests.filter(test=>ids.has(test.id)).map(test=>test.id)??[];
}
export function freezeVisitOperations(graph:CanvasGraph):CanvasGraph{
 return {...graph,paths:graph.paths.map(path=>path.scenarioId&&initialCanvasScreen(graph,path)?{...path,visits:routeVisits(graph,path).map((visit,index)=>({...visit,operationIds:visitOperations(graph,path,index)}))}:path)};
}
export function updateVisitOperations(graph:CanvasGraph,pathId:string,visitId:string,operationIds:string[]):CanvasGraph{
 if(operationIds.length>30)throw new Error('A visit supports up to 30 actions and checks.');
 return {...graph,paths:graph.paths.map(path=>path.id===pathId?{...path,visits:routeVisits(graph,path).map(visit=>visit.id===visitId?{...visit,operationIds,checkIds:undefined}:visit)}:path)};
}
// Copy on edit also isolates imported shared operations and duplicated scenarios.
export function privateVisitOperation(graph:CanvasGraph,pathId:string,visitId:string,testId:string){
 graph=freezeVisitOperations(graph);
 const path=graph.paths.find(path=>path.id===pathId)!;const index=routeVisits(graph,path).findIndex(visit=>visit.id===visitId);
 if(index<0||!visitOperations(graph,path,index).includes(testId))throw new Error('Select the visit that owns this operation.');
 const shared=graph.paths.some(item=>routeVisits(graph,item).some((visit,i)=>(item.id!==pathId||visit.id!==visitId)&&visitOperations(graph,item,i).includes(testId)));
 if(!shared)return {graph,testId};
 const id=crypto.randomUUID();const screenId=visitScreenId(graph,path,index)!;const test=graph.screens.find(screen=>screen.id===screenId)!.tests.find(test=>test.id===testId)!;
 const edgeId=path.edgeIds[index];
 graph={...graph,screens:graph.screens.map(screen=>screen.id===screenId?{...screen,tests:[...screen.tests,{...structuredClone(test),id,scenarioIds:path.scenarioId?[path.scenarioId]:undefined}]}:screen),edges:graph.edges.map(edge=>edge.id===edgeId&&!test.check?{...edge,actionTestIds:[...edgeActions(edge),id]}:edge)};
 return {graph:updateVisitOperations(graph,pathId,visitId,visitOperations(graph,path,index).map(item=>item===testId?id:item)),testId:id};
}

export function connectionVisitActions(graph:CanvasGraph,path:CanvasGraph['paths'][number],edge:Transition){
 // Prefer this scenario's own earlier occurrence, never the pooled edge union.
 for(const item of [path,...graph.paths.filter(item=>item.id!==path.id)]){
  const index=item.edgeIds.indexOf(edge.id);
  if(index>=0){const actions=visitOperations(graph,item,index).filter(id=>edgeActions(edge).includes(id));if(actions.length)return actions;}
 }
 return scenarioActions(graph,edge,path.scenarioId);
}
export function connectVisitAction(graph:CanvasGraph,pathId:string,visitId:string,actionId:string,to:string){
 const path=graph.paths.find(item=>item.id===pathId)!;const index=routeVisits(graph,path).findIndex(visit=>visit.id===visitId);const from=visitScreenId(graph,path,index)!;
 const previous=graph.edges.find(edge=>edge.from===from&&edgeActions(edge).includes(actionId));
 let next:CanvasGraph;
 if(to)next=connectCanvasAction(graph,from,actionId,to,pathId).graph;
 else next={...graph,edges:graph.edges.map(edge=>edge.id===previous?.id?{...edge,actionTestIds:edgeActions(edge).filter(id=>id!==actionId),actionTestId:edgeActions(edge).find(id=>id!==actionId)??'pending:'+edge.id}:edge)};
 const current=next.paths.find(item=>item.id===pathId)!;
 const ids=visitOperations(next,current,index).filter(id=>id!==actionId);
 const edge=to?next.edges.find(edge=>edge.from===from&&edgeActions(edge).includes(actionId)):next.edges.find(edge=>edge.from===from&&edgeActions(edge).some(id=>ids.includes(id)));
 if(edge){
  if(current.edgeIds[index])next={...next,paths:next.paths.map(item=>item.id===pathId?{...item,edgeIds:item.edgeIds.map((id,i)=>i===index?edge.id:id)}:item)};
  else if(!current.finished&&current.edgeIds.length===index)next={...next,paths:next.paths.map(item=>item.id===pathId?appendRouteTransition(next,item,edge.id):item)};
 }
 if(!to&&previous&&!edgeActions(next.edges.find(edge=>edge.id===previous.id)!).length&&!next.paths.some(item=>item.edgeIds.includes(previous.id)))next={...next,edges:next.edges.filter(edge=>edge.id!==previous.id)};
 return next;
}
