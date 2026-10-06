import {parseAllDocuments, isMap, isSeq, isScalar} from 'yaml';

export const formCommands = ['tapOn','inputText','assertVisible','assertNotVisible','runFlow'] as const;
export type FormCommand = typeof formCommands[number];
export type FormStep = {index:number; command:string; value?:string; editable:boolean; reason?:string; raw:string; range?:[number,number]};
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
    return {canAppend:!sequence.flow,steps:sequence.items.map((item,index)=>{
      const raw=item?.range?yaml.slice(item.range[0],item.range[2]):'';
      const fallback={index,command:isScalar(item)?String(item.value):'Complex command',raw,editable:false,reason:'Edit this command in YAML code.'};
      if(!isMap(item)||item.items.length!==1||item.anchor) return fallback;
      const pair=item.items[0]; const command=isScalar(pair.key)?String(pair.key.value):'Complex command';
      if(!formCommands.includes(command as FormCommand)) return {...fallback,command};
      const node=pair.value;
      if(!isScalar(node)||node.tag||typeof node.value!=='string'||node.anchor||!node.range||['BLOCK_LITERAL','BLOCK_FOLDED'].includes(node.type??'')) return {...fallback,command,reason:'Complex selectors, anchors, aliases and block values are code-only.'};
      return {index,command,raw,editable:true,value:node.value,range:[node.range[0],node.range[1]] as [number,number]};
    })};
  }catch(error){return {steps:[],canAppend:false,error:error instanceof Error?error.message:'Invalid YAML.'};}
}
export function editForm(yaml:string,input:{source:string;index:number;value:string}) {
  if(yaml!==input.source) throw new Error('YAML changed after this form draft began. Review the current code and start the form edit again.');
  const view=readForms(yaml);if(view.error) throw new Error(view.error);
  const step=view.steps[input.index];if(!step?.editable||!step.range) throw new Error('This transformation is unsafe; edit the command in YAML code.');
  if(!input.value.trim()||input.value.length>4000) throw new Error('Provide a nonempty value up to 4000 characters.');
  return yaml.slice(0,step.range[0])+JSON.stringify(input.value)+yaml.slice(step.range[1]);
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
  const next=yaml+(yaml.endsWith('\n')?'':'\n')+indentation+'- '+command+': '+JSON.stringify(value)+'\n';
  parse(next);
  return next;
}
