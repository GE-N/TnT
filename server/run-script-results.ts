import type {RunPlan} from './run-script-plan.js';
import type {ScriptStepResult} from './run-script-contract.js';

const scriptCommand=(entry:any)=>entry?.command?.runScriptCommand;
const events=(commands:any[])=>commands.filter(entry=>entry.metadata?.depth===0&&!entry.command?.defineVariablesCommand&&!entry.command?.applyConfigurationCommand);
function marker(message:unknown,rowId:string):string|undefined{
 if(typeof message!=='string')return;
 const prefix='TNT_SCRIPT_FAILED row='+rowId+' ';
 // Maestro/Graal renders Error.message as "Error: ...". Remove only this transport prefix.
 const normalized=message.startsWith('Error: ')?message.slice('Error: '.length):message;
 return normalized.startsWith(prefix)?normalized.slice(prefix.length):undefined;
}
/** Consume sanitized metadata only. Return an authored-only view for protected legacy mappers. */
export function mapScriptResults(plan:RunPlan,commands:any[],log:string,confidential:boolean){
 const top=events(commands);const scriptSteps:Record<string,ScriptStepResult>={};const omitted=new Set<any>();const notRunIndexes:number[]=[];
 let stopped=false;let failure:string|undefined;let toolFailure:string|undefined;let ambiguous=false;
 for(const [position,item] of plan.executionItems.entries()){
  const entry=top[position];
  if(item.kind!=='runScript'){
   if(item.kind==='step'&&stopped)notRunIndexes.push(item.index!);
   if(entry?.metadata?.status==='FAILED')stopped=true;
   continue;
  }
  const result:ScriptStepResult={kind:'runScript',rowId:item.rowId,status:'not-run'};scriptSteps[item.rowId]=result;
  const fromLog=log.split(/\r?\n/).findIndex(line=>line.startsWith('TNT_SCRIPT_FAILED row='+item.rowId+' '));
  const logMessage=fromLog<0?undefined:marker(log.split(/\r?\n/).slice(fromLog).join('\n'),item.rowId);
  if(entry&&!scriptCommand(entry)){ambiguous=true;continue;}
  if(entry){
   const start=commands.indexOf(entry);let end=start+1;
   while(end<commands.length&&commands[end].metadata?.depth>0)end++;
   commands.slice(start,end).forEach(value=>omitted.add(value));
  }
  if(stopped)continue;
  if(entry?.metadata?.status==='FAILED'){
   const structured=marker(entry?.metadata?.error?.message,item.rowId);
   const readable=entry?.metadata?.error?.message;
   const fallback=typeof readable!=='string'||readable==='Unknown error'?logMessage:undefined;
   if(structured!==undefined||fallback!==undefined){
    result.status='script-error';
    result.message=confidential?'Script failed. Evaluated detail withheld for confidential inputs.':structured??fallback;
    failure=result.message;
   }else toolFailure=confidential?'Script execution failed. Detail withheld for confidential inputs.':typeof readable==='string'?readable:'Script execution failed without a script marker.';
   stopped=true;
  }else if(entry?.metadata?.status==='COMPLETED')result.status='passed';
 }
 if(top.length>plan.executionItems.length)ambiguous=true;
 return {scriptSteps,commands:commands.filter(entry=>!omitted.has(entry)),notRunIndexes,failure,toolFailure,ambiguous};
}
