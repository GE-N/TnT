import type {CanvasGraph} from '../server/canvas.js';
import {parseAllDocuments, isMap, isSeq, isScalar} from 'yaml';

export const formCommands = ['tapOn','inputText','assertVisible','assertNotVisible','runFlow'] as const;
export type FormCommand = typeof formCommands[number];
export type FormField = {name:string;value:string;type:'string'|'number'|'boolean';range:[number,number]};
export type FormStep = {index:number; command:string; value?:string; editable:boolean; reason?:string; raw:string; range?:[number,number];fields?:FormField[]};
function parse(yaml:string) {
  const docs=parseAllDocuments(yaml);
  const errors=docs.flatMap(doc=>doc.errors.map(error=>error.message));
  if(errors.length) throw new Error('Invalid YAML: '+errors.join(' '));
  if(docs.length!==2 || !isMap(docs[0].contents) || !isSeq(docs[1].contents)) throw new Error('Use an appId header, --- separator and command list.');
  for(const doc of docs) doc.toJS({maxAliasCount:100});
  return docs;
}
export function readForms(yaml:string):{steps:FormStep[];error?:string;canAppend:boolean} {
  try {
    const docs=parse(yaml);const sequence=docs[1].contents;
    if(!isSeq(sequence)) throw new Error('Expected command list.');
    return {canAppend:!sequence.flow||sequence.items.length===0,steps:sequence.items.map((item,index)=>{
      const raw=item?.range?yaml.slice(item.range[0],item.range[2]):'';
      const fallback={index,command:isScalar(item)?String(item.value):'Complex command',raw,editable:false,reason:'Edit this command in YAML code.'};
      if(!isMap(item)||item.items.length!==1||item.anchor) return fallback;
      const pair=item.items[0]; const command=isScalar(pair.key)?String(pair.key.value):'Complex command';
      if(!formCommands.includes(command as FormCommand)) return {...fallback,command};
      const node=pair.value;
      if(isMap(node)&&!node.anchor&&!node.tag) {
        const fields:FormField[]=[];
        for(const argument of node.items){
          const value=argument.value;
          if(!isScalar(argument.key)||typeof argument.key.value!=='string'||!isScalar(value)||value.tag||value.anchor||!value.range||!['string','number','boolean'].includes(typeof value.value)||['BLOCK_LITERAL','BLOCK_FOLDED'].includes(value.type??'')) return {...fallback,command};
          fields.push({name:argument.key.value,value:String(value.value),type:typeof value.value as FormField['type'],range:[value.range[0],value.range[1]]});
        }
        if(fields.length) return {...fallback,command,fields};
      }
      if(!isScalar(node)||node.tag||typeof node.value!=='string'||node.anchor||!node.range||['BLOCK_LITERAL','BLOCK_FOLDED'].includes(node.type??'')) return {...fallback,command,reason:'Complex selectors, anchors, aliases and block values are code-only.'};
      return {index,command,raw,editable:true,value:node.value,range:[node.range[0],node.range[1]] as [number,number]};
    })};
  }catch(error){return {steps:[],canAppend:false,error:error instanceof Error?error.message:'Invalid YAML.'};}
}
export function editForm(yaml:string,input:{source:string;index:number;value:string;field?:string}) {
  if(yaml!==input.source) throw new Error('YAML changed after this form draft began. Review the current code and start the form edit again.');
  const view=readForms(yaml);if(view.error) throw new Error(view.error);
  const step=view.steps[input.index];
  const field=input.field===undefined?undefined:step?.fields?.find(field=>field.name===input.field);
  const range=field?.range??(input.field===undefined&&step?.editable?step.range:undefined);
  if(!range) throw new Error('This transformation is unsafe; edit the command in YAML code.');
  if(!input.value.trim()||input.value.length>4000) throw new Error('Provide a nonempty value up to 4000 characters.');
  let encoded=JSON.stringify(input.value);
  if(field?.type==='boolean') {if(!['true','false'].includes(input.value)) throw new Error('Provide true or false.');encoded=input.value;}
  if(field?.type==='number') {if(!Number.isFinite(Number(input.value))) throw new Error('Provide a finite number.');encoded=String(Number(input.value));}
  const next=yaml.slice(0,range[0])+encoded+yaml.slice(range[1]);
  parse(next);
  return next;
}
export function appendForm(yaml:string,command:FormCommand,value:string) {
  const view=readForms(yaml);if(view.error) throw new Error(view.error);
  if(!view.canAppend) throw new Error('Flow-style command lists are code-only.');
  if(!formCommands.includes(command)||!value.trim()||value.length>4000) throw new Error('Choose a supported command and provide a nonempty value up to 4000 characters.');
  const docs=parse(yaml);
  if(docs[1].range&&yaml.slice(docs[1].range[1]).trimStart().startsWith('...')) throw new Error('Explicit document endings are code-only.');
  const sequence=docs[1].contents;
  if(!isSeq(sequence)||!sequence.range) throw new Error('This command list is code-only.');
  const start=sequence.range[0];
  const indentation=yaml.slice(yaml.lastIndexOf('\n',start-1)+1,start);
  if(!/^ *$/.test(indentation)) throw new Error('This command-list layout is code-only.');
  const commandSource=indentation+'- '+command+': '+JSON.stringify(value);
  const next=sequence.items.length===0?yaml.slice(0,start)+commandSource.trimStart()+yaml.slice(sequence.range[1]):yaml+(yaml.endsWith('\n')?'':'\n')+commandSource+'\n';
  parse(next);
  return next;
}

export function deleteForm(yaml:string,index:number) {
  const docs=parse(yaml);const sequence=docs[1].contents;
  if(!isSeq(sequence)||sequence.flow) throw new Error('This command-list style is code-only for deletion.');
  const item=sequence.items[index];
  if(!item?.range) throw new Error('Choose an existing step.');
  const start=yaml.lastIndexOf('\n',item.range[0]-1)+1;
  if(!/^ *- /.test(yaml.slice(start,item.range[0]+2))) throw new Error('This command-list layout is code-only for deletion.');
  let end=item.range[2];
  if(end>0&&yaml[end-1]!=='\n') {const newline=yaml.indexOf('\n',end);end=newline<0?yaml.length:newline+1;}
  const replacement=sequence.items.length===1?yaml.slice(start,item.range[0]).replace(/-\s*$/,'')+'[]\n':'';
  const next=yaml.slice(0,start)+replacement+yaml.slice(end);
  parse(next); // Reject deletions that leave unresolved aliases or invalid documents.
  return next;
}

// Invalidate explicitly: identical adjacent commands must never silently inherit a deleted reference.
export function canvasAfterDeletion(graph:CanvasGraph|undefined,index:number):CanvasGraph|undefined {
  if(!graph)return;
  return {...graph,screens:graph.screens.map(screen=>({...screen,tests:screen.tests.map(test=>{
    const affected=test.reference.kind==='flow'||(test.reference.file==='flow.yaml'&&(test.reference.index??-1)>=index);
    return affected?{...test,reference:{...test.reference,fingerprint:'deleted:'+test.reference.fingerprint.slice(-56)}}:test;
  })}))};
}

export function restoreDeletionReferences(current:CanvasGraph|undefined,previous:CanvasGraph|undefined,deleted:CanvasGraph|undefined):CanvasGraph|undefined {
  if(!current||!previous||!deleted)return current;
  const priorTests=new Map(previous.screens.flatMap(screen=>screen.tests.map(test=>[test.id,test] as const)));
  const deletedTests=new Map(deleted.screens.flatMap(screen=>screen.tests.map(test=>[test.id,test] as const)));
  return {...current,screens:current.screens.map(screen=>({...screen,tests:screen.tests.map(test=>{
    const prior=priorTests.get(test.id);const invalidated=deletedTests.get(test.id);
    const reference=test.reference;const expected=invalidated?.reference;
    const unchanged=expected&&reference.kind===expected.kind&&reference.file===expected.file&&reference.index===expected.index&&reference.actionId===expected.actionId&&reference.fingerprint===expected.fingerprint;
    return prior&&unchanged?{...test,reference:prior.reference}:test;
  })}))};
}
