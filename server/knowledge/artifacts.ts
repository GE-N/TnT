import type {GenerationInput,IndexSection,Manifest} from './types.js';
import {contextFields} from './types.js';
import {sha256} from './projection.js';

export const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
/** T4 replaces this minimal inert fallback through renderHtml, using the same generation input. */
export function minimalHtml(input:GenerationInput):Record<string,string>{
 const sections=input.scenarios.map(detail=>'<article id="scenario-'+detail.scenarioId+'"><h2>'+escapeHtml(detail.title)+'</h2>'+contextFields.map(field=>'<h3>'+field+'</h3><p>'+escapeHtml(detail.context[field])+'</p>').join('')+'<h3>Flow</h3><ol>'+detail.flow.steps.map(step=>'<li>'+escapeHtml(step.text)+'</li>').join('')+'</ol><p>'+escapeHtml(detail.evidence.label)+'</p><p>'+escapeHtml(detail.evidence.notice)+'</p></article>').join('');
 const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+escapeHtml(input.workspaceTitle)+'</title><body><h1>'+escapeHtml(input.workspaceTitle)+'</h1><p>As of '+escapeHtml(input.generatedAt)+'</p>'+sections+'</body></html>';
 return {'index.html':html,['workspaces/'+input.workspaceId+'.html']:html};
}
function chunks(text:string){
 // Split by Unicode characters to avoid breaking a UTF-8 sequence; deterministic 8 KiB sections.
 const parts:string[]=[];let part='';let bytes=0;
 for(const character of text){const size=Buffer.byteLength(character);if(bytes+size>8192){parts.push(part);part='';bytes=0;}part+=character;bytes+=size;}
 parts.push(part);return parts;
}
export async function buildArtifacts(input:GenerationInput,renderHtml:(input:GenerationInput)=>Record<string,string>|Promise<Record<string,string>>=minimalHtml){
 const files:Record<string,string>={};const rows:IndexSection[]=[];
 const documents:Manifest['documents']=[];
 for(const scenario of input.scenarios){
  const documentId='scenario:'+input.workspaceId+':'+scenario.scenarioId;
  const content={purpose:scenario.context.purpose,expectedOutcome:scenario.context.expectedOutcome,rationale:scenario.context.rationale,preconditions:scenario.context.preconditions,flow:[...scenario.flow.visits.map(visit=>'Visit '+visit.number+' · '+visit.title),...scenario.flow.steps.map(step=>step.text),...scenario.flow.diagnostics].join('\n'),exceptions:scenario.context.exceptions,scope:scenario.context.scope,evidence:scenario.evidence.label+'\n'+scenario.evidence.notice};
  const text='Scenario: '+scenario.title+'\nWorkspace: '+input.workspaceId+'\nScenario ID: '+scenario.scenarioId+'\nSource: '+scenario.sourceDescriptor.sourceHash+'\nContext revision: '+scenario.context.contextRevision+'\n\n'+Object.entries(content).map(([key,value])=>key+'\n'+value).join('\n\n')+'\n';
  const path='documents/'+scenario.scenarioId+'.txt';files[path]=text;documents.push({documentId,path,sha256:sha256(text)});
  for(const [section,text] of Object.entries(content))for(const [index,chunk] of chunks(text).entries())rows.push({documentId,sectionId:section+(index?':'+(index+1):''),generationId:input.generationId,workspaceId:input.workspaceId,scenarioId:scenario.scenarioId,title:scenario.title,section,text:chunk,tags:[],language:'und',sourceDescriptor:scenario.sourceDescriptor,contextRevision:scenario.context.contextRevision,generatedAt:input.generatedAt,kind:section==='flow'?'derived-flow-facts':section==='evidence'?'observation':'authored-context',publicationFreshness:'current',intentFreshness:scenario.intentFreshness,sourceReferences:[],htmlLocation:'workspaces/'+input.workspaceId+'.html#scenario-'+scenario.scenarioId});
 }
 Object.assign(files,await renderHtml(input));
 files['index.jsonl']=rows.map(row=>JSON.stringify(row)).join('\n')+(rows.length?'\n':'');
 const manifest:Manifest={formatVersion:1,generationId:input.generationId,scopeId:input.scopeId,workspaceId:input.workspaceId,generatedAt:input.generatedAt,sources:input.scenarios.map(scenario=>({scenarioId:scenario.scenarioId,sourceDescriptor:scenario.sourceDescriptor,contextRevision:scenario.context.contextRevision})),documents,artifacts:Object.entries(files).map(([path,text])=>({path,sha256:sha256(text)}))};
 files['manifest.json']=JSON.stringify(manifest,null,2)+'\n';
 return {files,manifest};
}
