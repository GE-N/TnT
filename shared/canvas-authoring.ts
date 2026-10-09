import {isNode,isSeq,parseAllDocuments,stringify,type YAMLSeq} from 'yaml';
import type {CanvasGraph,CanvasTest} from '../server/canvas.js';

export type ScreenCheck={visibility:'visible'|'absent';target:'text'|'id';match:'exact'|'contains'|'regex';value:string};
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function checkPattern(check:ScreenCheck){return check.match==='regex'?check.value:check.match==='contains'?'.*'+escape(check.value)+'.*':'^'+escape(check.value)+'$';}
export function checkLabel(check:ScreenCheck){return `${check.visibility==='visible'?'Visible':'Absent'} ${check.target==='text'?'text':'element'} · ${check.value||'Draft — selector needed'}`;}
export function checkProblem(check:ScreenCheck){
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
  let check:ScreenCheck|undefined;
  if(!node?.anchor&&!node?.tag&&['assertVisible','assertNotVisible'].includes(command)&&target&&typeof pattern==='string'){
   let match:ScreenCheck['match']='regex';let value=pattern;
   for(const mode of ['exact','contains'] as const){const inner=mode==='exact'&&pattern.startsWith('^')&&pattern.endsWith('$')?pattern.slice(1,-1):mode==='contains'&&pattern.startsWith('.*')&&pattern.endsWith('.*')?pattern.slice(2,-2):undefined;
    if(inner!==undefined){const literal=inner.replace(/\\([.*+?^${}()|[\]\\])/g,'$1');if(checkPattern({visibility:'visible',target,match:mode,value:literal})===pattern){match=mode;value=literal;break;}}
   }
   if(/(?:^|\n)\s*tnt-match:regex\s*(?:\n|$)/.test(node?.commentBefore??'')){match='regex';value=pattern;}
   check={visibility:command==='assertVisible'?'visible':'absent',target,match,value};
  }
  return {id,index,check};
 }).filter(item=>item.id);
}
export function refreshChecks(graph:CanvasGraph,yaml:string):CanvasGraph{
 let checks:ReturnType<typeof authoredChecks>;try{checks=authoredChecks(yaml);}catch{return graph;}
 return {...graph,screens:graph.screens.map(screen=>{
  const tests=screen.tests.map(test=>{
   if(!test.check)return test;
   const matches=checks.filter(item=>item.id===test.id);const found=matches.length===1?matches[0]:undefined;
   return found?.check?{...test,check:found.check,reference:{...test.reference,index:found.index}}:test;
  });
  const executable=tests.filter(test=>test.check&&checks.some(item=>item.id===test.id&&item.check)).sort((a,b)=>a.reference.index!-b.reference.index!);
  let cursor=0;return {...screen,tests:tests.map(test=>executable.some(item=>item.id===test.id)?executable[cursor++]:test)};
 })};
}
// Edit identified commands in place. Explicit reorder swaps only surviving check slots.
export function writeChecks(yaml:string,previous:CanvasGraph,next:CanvasGraph){
 const {docs,sequence}=source(yaml);
 if(sequence.flow)throw new Error('Convert the command list to block YAML before editing canvas checks.');
 const before=previous.screens.flatMap(screen=>screen.tests).filter(test=>test.check);
 const after=next.screens.flatMap(screen=>screen.tests).filter((test):test is CanvasTest & {check:ScreenCheck}=>!!test.check);
 const owned=new Set([...before,...after].map(test=>test.id));
 const parsed=authoredChecks(yaml);
 const originals=new Map(sequence.items.map(node=>[marker(node?.commentBefore),node] as const));
 const replacements=new Map<string,(typeof sequence.items)[number]>();
 for(const test of after){
  const matches=parsed.filter(item=>item.id===test.id);const prior=before.find(item=>item.id===test.id);
  const unchanged=JSON.stringify(prior?.check)===JSON.stringify(test.check);
  if(matches.length>1)throw new Error('Ambiguous check YAML. Keep one command identity before editing this check.');
  if(matches.length&&!matches[0].check){if(unchanged){replacements.set(test.id,originals.get(test.id)!);continue;}throw new Error('This check contains unsupported YAML. Edit its code before changing the canvas form.');}
  if(!matches.length&&prior?.check&&!checkProblem(prior.check)&&unchanged)throw new Error('A check command was removed from YAML. Restore it or explicitly edit its selector before changing other checks.');
  if(checkProblem(test.check))continue;
  if(matches[0]?.check&&JSON.stringify(matches[0].check)===JSON.stringify(test.check)){replacements.set(test.id,originals.get(test.id)!);continue;}
  const single=source('appId: placeholder\n---\n'+stringify([{[test.check.visibility==='visible'?'assertVisible':'assertNotVisible']:{[test.check.target]:checkPattern(test.check)}}]));
  const node=single.sequence.items[0]!;
  const comments=originals.get(test.id)?.commentBefore?.split('\n').filter(line=>!/^\s*tnt-(check|match):/.test(line))??[];
  node.commentBefore=[...comments,' tnt-check:'+test.id,' tnt-match:'+test.check.match].join('\n');replacements.set(test.id,node);
 }
 const retained=sequence.items.filter(node=>!owned.has(marker(node?.commentBefore)??'')||replacements.has(marker(node?.commentBefore)??''));
 for(const screen of next.screens){
  const desired=screen.tests.map(test=>test.id).filter(id=>replacements.has(id));
  const existing=desired.filter(id=>originals.has(id));let cursor=0;
  for(let index=0;index<retained.length;index++)if(existing.includes(marker(retained[index]?.commentBefore)??''))retained[index]=replacements.get(existing[cursor++])!;
  for(let position=0;position<desired.length;position++){
   const id=desired[position];if(originals.has(id))continue;
   const following=desired.slice(position+1).find(id=>retained.some(node=>marker(node?.commentBefore)===id));
   const preceding=desired.slice(0,position).findLast(id=>retained.some(node=>marker(node?.commentBefore)===id));
   const insertion=following?retained.findIndex(node=>marker(node?.commentBefore)===following):preceding?retained.findIndex(node=>marker(node?.commentBefore)===preceding)+1:retained.length;
   retained.splice(insertion,0,replacements.get(id)!);
  }
 }
 sequence.items=retained;
 const yamlNext=docs[0].toString()+'---\n'+docs[1].toString({directives:false});source(yamlNext);return yamlNext;
}
