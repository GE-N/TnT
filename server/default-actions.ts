import {checkpointCommands} from '../shared/checkpoints.js';
import {randomUUID} from 'node:crypto';
import {parseAllDocuments,stringify} from 'yaml';
import {referenceCatalog} from './canvas.js';
import type {Step} from './scenarios.js';

export type FlowCall={file:string;parameters:Record<string,string>};
export type DefaultAction=FlowCall & {id:string;name:string;condition:{text?:string;id?:string};enabled:boolean};
export type Automation={setup:FlowCall;actions:DefaultAction[];checkpoints:{beforeStep:number;fingerprint:string;timeoutMs:number}[]};
export type ExecutionItem={kind:'reset'|'setup'|'checkpoint'|'step';index?:number};
export type AutomationResult={setup:{status:Step['status']};actions:{id:string;name:string;beforeStep:number;status:Step['status'];detail:string}[]};
const navigationCommands=new Set<string>(checkpointCommands);
function call(value:unknown,flows:Record<string,string>):FlowCall {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Declare a reusable setup/action flow.');
 const input=value as FlowCall;
 if(typeof input.file!=='string'||!Object.hasOwn(flows,input.file))throw new Error('Setup/actions require a declared reusable YAML file.');
 const parameters=input.parameters??{};
 if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)||Object.keys(parameters).length>20||Object.entries(parameters).some(([key,value])=>! /^[A-Z][A-Z0-9_]{0,63}$/.test(key)||key.startsWith('MAESTRO_')||typeof value!=='string'||value.length>4000||value.includes('\0')))throw new Error('Flow parameters require up to 20 uppercase names and bounded string values. Use runtime placeholders for secrets.');
 return {file:input.file,parameters:{...parameters}};
}
export function readAutomation(value:unknown,flows:Record<string,string>,yaml:string):Automation|undefined {
 if(value===undefined)return;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Provide setup and default-action configuration.');
 const input=value as Automation;
 const setup=call(input.setup,flows);
 if(!Array.isArray(input.actions)||input.actions.length>20||!Array.isArray(input.checkpoints)||input.checkpoints.length>100)throw new Error('Use up to 20 default actions and 100 checkpoints.');
 const ids=new Set<string>();
 const actions=input.actions.map(action=>{
  if(!action||typeof action.id!=='string'||! /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(action.id)||ids.has(action.id)||typeof action.name!=='string'||!action.name.trim()||action.name.length>120||typeof action.enabled!=='boolean')throw new Error('Default actions need unique IDs, names and an enabled flag.');
  ids.add(action.id);
  const condition=action.condition;
  if(!condition||typeof condition!=='object'||Array.isArray(condition)||Object.keys(condition).length!==1||!['text','id'].includes(Object.keys(condition)[0])||Object.values(condition).some(value=>typeof value!=='string'||!value.trim()||value.length>1000))throw new Error('Choose a nonempty text or accessibility ID screen condition.');
  return {...call(action,flows),id:action.id,name:action.name.trim(),enabled:action.enabled,condition:{...condition}};
 });
 const catalog=referenceCatalog(yaml,flows);
 if(catalog.diagnostics.length)throw new Error(catalog.diagnostics[0].detail);
 const positions=new Set<number>();
 const checkpoints=input.checkpoints.map(checkpoint=>{
  if(!checkpoint||!Number.isInteger(checkpoint.beforeStep)||checkpoint.beforeStep<0||positions.has(checkpoint.beforeStep)||!Number.isInteger(checkpoint.timeoutMs)||checkpoint.timeoutMs<0||checkpoint.timeoutMs>5000)throw new Error('Checkpoints need unique step positions and a visibility window from 0 to 5000 ms.');
  const reference=catalog.references.find(reference=>reference.kind==='step'&&reference.index===checkpoint.beforeStep);
  if(!reference||!navigationCommands.has(reference.command)||reference.fingerprint!==checkpoint.fingerprint)throw new Error('Broken or stale checkpoint reference. Explicitly relink the checkpoint to a navigation/assertion step.');
  positions.add(checkpoint.beforeStep);
  return {beforeStep:checkpoint.beforeStep,fingerprint:checkpoint.fingerprint,timeoutMs:checkpoint.timeoutMs};
 });
 const header=parseAllDocuments(yaml)[0].toJS();
 if(header.onFlowStart||header.onFlowComplete)throw new Error('For independent setup, move root flow hooks into declared setup or authored commands.');
 return {setup,actions,checkpoints};
}
export function instrument(yaml:string,automation:Automation):{yaml:string;plan:ExecutionItem[]} {
 const documents=parseAllDocuments(yaml);
 const authored=documents[1].toJS() as unknown[];
 const namespace='output.tnt_'+randomUUID().replaceAll('-','');
 const expression=(script:string)=>'${'+script+'}';
 const invoke=(flow:FlowCall,label:string)=>({runFlow:{file:flow.file,...(Object.keys(flow.parameters).length?{env:{...flow.parameters}}:{}),label}});
 const commands:unknown[]=[{launchApp:{stopApp:true,clearState:false}},invoke(automation.setup,'TnT setup')];
 const plan:ExecutionItem[]=[{kind:'reset'},{kind:'setup'}];
 authored.forEach((command,index)=>{
  const checkpoint=automation.checkpoints.find(checkpoint=>checkpoint.beforeStep===index);
  if(checkpoint){
   const actions=automation.actions.filter(action=>action.enabled);
   const checks=actions.map(action=>({runFlow:{when:{true:expression(`!${namespace}.matched`),visible:{...action.condition}},label:`TnT handler ${action.id} checkpoint ${index+1}`,commands:[{evalScript:expression(`${namespace}.matched = true`)},invoke(action,`TnT action ${action.id} checkpoint ${index+1}`)]}}));
   const polling={repeat:{while:{true:expression(`!${namespace}.matched && (${namespace}.polls===0 || Date.now()<${namespace}.deadline)`)},commands:[{evalScript:expression(`${namespace}.polls++`)},...checks]}};
   commands.push({runFlow:{label:`TnT checkpoint ${index+1}`,commands:[{evalScript:expression(`${namespace} = {matched:false, polls:0, deadline:Date.now()+${checkpoint.timeoutMs}}`)},...(checks.length?[polling]:[])]}});
   plan.push({kind:'checkpoint',index});
  }
  commands.push({runFlow:{label:`TnT step ${index+1}`,commands:[command]}});plan.push({kind:'step',index});
 });
 return {yaml:documents[0].toString()+'---\n'+stringify(commands,{aliasDuplicateObjects:false,lineWidth:0}),plan};
}
export function metadataStatus(value:unknown):Step['status'] {return value==='COMPLETED'?'passed':value==='FAILED'?'failed':value==='SKIPPED'?'skipped':'unavailable';}
export function mapAutomation(automation:Automation,plan:ExecutionItem[],commands:any[]):{result:AutomationResult;failedPhase?:'setup'|'handler'} {
 const events=commands.filter(entry=>entry.metadata?.depth===0&&!entry.command?.defineVariablesCommand&&!entry.command?.applyConfigurationCommand);
 const setup=metadataStatus(events[1]?.metadata?.status);
 const actions=automation.checkpoints.flatMap(checkpoint=>automation.actions.map(action=>{
  const label=`TnT handler ${action.id} checkpoint ${checkpoint.beforeStep+1}`;
  const start=commands.findIndex(entry=>entry.metadata?.depth===0&&entry.command?.runFlowCommand?.label===`TnT checkpoint ${checkpoint.beforeStep+1}`);
  let end=start+1;
  while(start>=0&&end<commands.length&&commands[end].metadata?.depth!==0)end++;
  const matches=start<0?[]:commands.slice(start+1,end).filter(entry=>entry.metadata?.depth===2&&entry.command?.runFlowCommand?.label===label);
  const statuses=matches.map(entry=>metadataStatus(entry.metadata?.status));
  const status=!action.enabled?'skipped':statuses.includes('failed')?'failed':statuses.includes('passed')?'passed':statuses.length&&statuses.every(status=>status==='skipped')?'skipped':'unavailable';
  return {id:action.id,name:action.name,beforeStep:checkpoint.beforeStep,status:status as Step['status'],detail:!action.enabled?'Disabled for this scenario.':status==='skipped'?'Condition absent or an earlier action matched.':status==='unavailable'?'No verified handler metadata; no execution inferred.':'Mapped from the conditional handler wrapper.'};
 }));
 const failed=events.findIndex(entry=>entry.metadata?.status==='FAILED');
 return {result:{setup:{status:setup},actions},failedPhase:failed>=0&&['reset','setup'].includes(plan[failed]?.kind)?'setup':failed>=0&&plan[failed]?.kind==='checkpoint'?'handler':undefined};
}
