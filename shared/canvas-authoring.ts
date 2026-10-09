import {isSeq,parseAllDocuments,stringify} from 'yaml';
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
 // YAML attaches a leading comment to the sequence rather than its first item.
 if(sequence.commentBefore&&sequence.items[0]){sequence.items[0].commentBefore=[sequence.commentBefore,sequence.items[0].commentBefore].filter(Boolean).join('\n');sequence.commentBefore=undefined;}
 return {docs,sequence};
}
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
 const checks=authoredChecks(yaml);
 return {...graph,screens:graph.screens.map(screen=>({...screen,tests:screen.tests.map(test=>{
  if(!test.check)return test;
  const matches=checks.filter(item=>item.id===test.id);const found=matches.length===1?matches[0]:undefined;
  return found?.check?{...test,check:found.check,reference:{...test.reference,index:found.index}}:test;
 })}))};
}
// Mutate only commands carrying stable authoring identities. Other YAML nodes survive intact.
export function writeChecks(yaml:string,previous:CanvasGraph,next:CanvasGraph){
 const {docs,sequence}=source(yaml);
 if(sequence.flow)throw new Error('Convert the command list to block YAML before editing canvas checks.');
 const before=previous.screens.flatMap(screen=>screen.tests).filter(test=>test.check);
 const after=next.screens.flatMap(screen=>screen.tests).filter((test):test is CanvasTest & {check:ScreenCheck}=>!!test.check);
 const owned=new Set([...before,...after].map(test=>test.id));
 const parsed=authoredChecks(yaml);
 for(const test of after){const existing=parsed.filter(item=>item.id===test.id);if(existing.length>1||existing.some(item=>!item.check))throw new Error('This check contains unsupported or ambiguous YAML. Edit its code before changing the canvas form.');}
 for(const test of after){const prior=before.find(item=>item.id===test.id);if(!parsed.some(item=>item.id===test.id)&&prior?.check&&!checkProblem(prior.check)&&JSON.stringify(prior.check)===JSON.stringify(test.check))throw new Error('A check command was removed from YAML. Restore it or explicitly edit its selector before changing other checks.');}
 const nodes=after.filter(test=>!checkProblem(test.check)).map(test=>{const single=source('appId: placeholder\n---\n'+stringify([{[test.check.visibility==='visible'?'assertVisible':'assertNotVisible']:{[test.check.target]:checkPattern(test.check)}}]));const node=single.sequence.items[0]!;node.commentBefore=' tnt-check:'+test.id+'\n tnt-match:'+test.check.match;return node;});
 const retained:typeof sequence.items=[];let cursor=0;let insertion=sequence.items.length;
 for(const node of sequence.items){
  if(owned.has(marker(node?.commentBefore)??'')){if(nodes[cursor])retained.push(nodes[cursor++]);insertion=retained.length;}
  else retained.push(node);
 }
 retained.splice(insertion,0,...nodes.slice(cursor));sequence.items=retained;
 
 const yamlNext=docs[0].toString()+'---\n'+docs[1].toString({directives:false});source(yamlNext);return yamlNext;
}
