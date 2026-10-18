import type {RunPlan} from './run-script-plan.js';
import type {ScriptStepResult} from './run-script-contract.js';

const scriptCommand=(entry:any)=>entry?.command?.runScriptCommand;
const events=(commands:any[])=>commands.filter(entry=>entry.metadata?.depth===0&&!entry.command?.defineVariablesCommand&&!entry.command?.applyConfigurationCommand);
function marker(message:unknown,rowId:string):string|undefined{
 if(typeof message!=='string')return;
 const prefix='TNT_SCRIPT_FAILED row='+rowId+' ';
 const index=message.indexOf(prefix);
 return index<0?undefined:message.slice(index+prefix.length).split(/\r?\n/)[0];
}
/** Consume sanitized metadata only. Return an authored-only view for protected legacy mappers. */
export function mapScriptResults(plan:RunPlan,commands:any[],log:string,confidential:boolean){
 const top=events(commands);const scriptSteps:Record<string,ScriptStepResult>={};const omitted=new Set<any>();const notRunIndexes:number[]=[];
 let stopped=false;let failure:string|undefined;let ambiguous=false;
 for(const [position,item] of plan.executionItems.entries()){
  const entry=top[position];
  if(item.kind!=='runScript'){
   if(item.kind==='step'&&stopped)notRunIndexes.push(item.index!);
   if(entry?.metadata?.status==='FAILED')stopped=true;
   continue;
  }
  const result:ScriptStepResult={kind:'runScript',rowId:item.rowId,status:'not-run'};scriptSteps[item.rowId]=result;
  const fromLog=marker(log,item.rowId);
  if(entry&&!scriptCommand(entry)){ambiguous=true;continue;}
  if(entry){
   const start=commands.indexOf(entry);let end=start+1;
   while(end<commands.length&&commands[end].metadata?.depth>0)end++;
   commands.slice(start,end).forEach(value=>omitted.add(value));
  }
  if(stopped)continue;
  if(entry?.metadata?.status==='FAILED'||fromLog!==undefined){
   const structured=marker(entry?.metadata?.error?.message,item.rowId);
   const readable=entry?.metadata?.error?.message;
   result.status='script-error';
   result.message=confidential?'Script failed. Evaluated detail withheld for confidential inputs.':structured??fromLog??(typeof readable==='string'&&readable!=='Unknown error'?readable:'Script failed. Inspect sanitized Maestro logs.');
   failure=result.message;stopped=true;
  }else if(entry?.metadata?.status==='COMPLETED')result.status='passed';
 }
 if(top.length>plan.executionItems.length)ambiguous=true;
 return {scriptSteps,commands:commands.filter(entry=>!omitted.has(entry)),notRunIndexes,failure,ambiguous};
}
