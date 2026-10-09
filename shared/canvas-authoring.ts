import {isNode,isSeq,parseAllDocuments,stringify,type YAMLSeq} from 'yaml';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';

export type ScreenSelector={target:'text'|'id';match:'exact'|'contains'|'regex';value:string};
export type ScreenCheck=ScreenSelector & {visibility:'visible'|'absent'};
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function checkPattern(check:ScreenSelector){return check.match==='regex'?check.value:check.match==='contains'?'.*'+escape(check.value)+'.*':'^'+escape(check.value)+'$';}
export function tapLabel(tap:ScreenSelector){return `Tap ${tap.target==='text'?'text':'element'} · ${tap.value||'Draft — selector needed'}`;}
export function checkLabel(check:ScreenCheck){return `${check.visibility==='visible'?'Visible':'Absent'} ${check.target==='text'?'text':'element'} · ${check.value||'Draft — selector needed'}`;}
export function canvasTestLabel(test:CanvasTest){return test.check?checkLabel(test.check):test.tap?tapLabel(test.tap):test.label;}
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
  const id=marker(node?.commentBefore);const value=node?.toJSON() as Record<string,unknown>|undefined;
  const command=value&&Object.keys(value).length===1?Object.keys(value)[0]:'';
  const argument=command?value?.[command]:undefined;
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
  return {id,index,check,tap};
 }).filter(item=>item.id);
}
export function refreshChecks(graph:CanvasGraph,yaml:string):CanvasGraph{
 let checks:ReturnType<typeof authoredChecks>;try{checks=authoredChecks(yaml);}catch{return graph;}
 return {...graph,edges:graph.edges.map(edge=>edge.assertionTestId==='pending:'+edge.id?{...edge,assertionTestId:graph.screens.find(screen=>screen.id===edge.to)?.tests.find(test=>test.check)?.id??edge.assertionTestId}:edge),screens:graph.screens.map(screen=>{
  const tests=screen.tests.map(test=>{
   if(!test.check&&!test.tap)return test;
   const matches=checks.filter(item=>item.id===test.id);const found=matches.length===1?matches[0]:undefined;
   return found&&(found.check||found.tap)?{...test,check:found.check,tap:found.tap,role:found.tap?'action' as const:'assertion' as const,reference:{...test.reference,index:found.index}}:test;
  });
  const executable=tests.filter(test=>(test.check||test.tap)&&checks.some(item=>item.id===test.id&&(item.check||item.tap))).sort((a,b)=>a.reference.index!-b.reference.index!);
  let cursor=0;return {...screen,tests:tests.map(test=>executable.some(item=>item.id===test.id)?executable[cursor++]:test)};
 })};
}
// Edit identified commands in place. Explicit reorder swaps only surviving check slots.
export function writeChecks(yaml:string,previous:CanvasGraph,next:CanvasGraph){
 const {docs,sequence}=source(yaml);
 if(sequence.flow)throw new Error('Convert the command list to block YAML before editing canvas checks.');
 const before=previous.screens.flatMap(screen=>screen.tests).filter(test=>test.check||test.tap);
 const after=next.screens.flatMap(screen=>screen.tests).filter(test=>test.check||test.tap);
 const owned=new Set([...before,...after].map(test=>test.id));
 const parsed=authoredChecks(yaml);
 const originals=new Map(sequence.items.map(node=>[marker(node?.commentBefore),node] as const));
 const replacements=new Map<string,(typeof sequence.items)[number]>();
 for(const test of after){
  const matches=parsed.filter(item=>item.id===test.id);const prior=before.find(item=>item.id===test.id);
  const selector=test.check??test.tap!;const priorSelector=prior?.check??prior?.tap;const matched=matches[0]?.check??matches[0]?.tap;
  const unchanged=JSON.stringify({check:prior?.check,tap:prior?.tap})===JSON.stringify({check:test.check,tap:test.tap});
  if(matches.length>1)throw new Error('Ambiguous check YAML. Keep one command identity before editing this check.');
  if(matches.length&&!matched){if(unchanged){replacements.set(test.id,originals.get(test.id)!);continue;}throw new Error('This check contains unsupported YAML. Edit its code before changing the canvas form.');}
  if(!matches.length&&priorSelector&&!checkProblem(priorSelector)&&unchanged)throw new Error('A check command was removed from YAML. Restore it or explicitly edit its selector before changing other checks.');
  if(checkProblem(selector))continue;
  if(matched&&JSON.stringify({check:matches[0].check,tap:matches[0].tap})===JSON.stringify({check:test.check,tap:test.tap})){replacements.set(test.id,originals.get(test.id)!);continue;}
  const single=source('appId: placeholder\n---\n'+stringify([{[test.tap?'tapOn':test.check!.visibility==='visible'?'assertVisible':'assertNotVisible']:{[selector.target]:checkPattern(selector)}}]));
  const node=single.sequence.items[0]!;
  const comments=originals.get(test.id)?.commentBefore?.split('\n').filter(line=>!/^\s*tnt-(check|match):/.test(line))??[];
  node.commentBefore=[...comments,' tnt-check:'+test.id,' tnt-match:'+selector.match].join('\n');replacements.set(test.id,node);
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
 const previous=graph.edges.find(edge=>edge.from===from&&edge.actionTestId===actionId);
 if(!to){const removed=graph.edges.filter(edge=>edge.actionTestId===actionId).map(edge=>edge.id);return {graph:{...graph,edges:graph.edges.filter(edge=>!removed.includes(edge.id)),paths:graph.paths.map(path=>({...path,edgeIds:path.edgeIds.filter(id=>!removed.includes(id))}))},pathId};}
 const destination=graph.screens.find(screen=>screen.id===to);if(!destination)throw new Error('Choose an existing destination screen.');
 if(!previous&&graph.edges.length>=80)throw new Error('This canvas supports up to 80 connections.');
 const id=previous?.id??'action-link:'+actionId;
 const edge={id,from,to,actionTestId:actionId,assertionTestId:destination.tests.find(test=>test.check)?.id??'pending:'+id,responseCondition:'Tap → '+destination.title};
 let paths=graph.paths;let path=paths.find(path=>path.id===pathId)??paths.find(path=>path.edgeIds.includes(id))??paths.find(path=>path.screenId===from&&!path.edgeIds.length);
 if(!path){if(paths.length>=20)throw new Error('Select an existing scenario path; this canvas supports up to 20 paths.');path={id:id+':path',name:(graph.screens.find(screen=>screen.id===from)!.title+' → '+destination.title).slice(0,120),screenId:from,edgeIds:[]};paths=[...paths,path];}
 const tail=path.edgeIds.length?graph.edges.find(edge=>edge.id===path!.edgeIds.at(-1))?.to:path.screenId;
 if(tail===from&&!path.edgeIds.includes(id))paths=paths.map(item=>item.id===path!.id?{...item,edgeIds:[...item.edgeIds,id]}:item);
 return {graph:{...graph,edges:previous?graph.edges.map(item=>item.id===id?edge:item):[...graph.edges,edge],paths},pathId:path.id};
}
