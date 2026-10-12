import type {Workspace} from '../server/scenarios.js';
export type ValueOwner='setup'|`handler:${string}`|`scenario:${string}`|`scenario-setup:${string}`;
export type OmittedValue={owner:ValueOwner;name:string};
export function workspaceValueSets(workspace:Workspace):{owner:ValueOwner;values:Record<string,string>}[]{return [
 ...(workspace.scenarios??[]).flatMap(scenario=>[{owner:`scenario:${scenario.id}` as ValueOwner,values:scenario.inputs},...(scenario.setup?[{owner:`scenario-setup:${scenario.id}` as ValueOwner,values:scenario.setup.parameters}]:[])]),
 ...(workspace.automation?[{owner:'setup' as const,values:workspace.automation.setup.parameters},...workspace.automation.actions.map(action=>({owner:`handler:${action.id}` as ValueOwner,values:action.parameters}))]:[])];}
/** Package review lists every omission; execution only needs values used by its selected scenario. */
export function missingValues(workspace:Workspace,execution?:{runtime:Record<string,string>;scenarioId?:string}){
 const sets=workspaceValueSets(workspace);
 const scenario=execution?workspace.scenarios?.find(item=>item.id===execution.scenarioId):undefined;
 function needed(owner:ValueOwner){
  if(!execution)return true;
  if(owner.startsWith('scenario:'))return owner===`scenario:${scenario?.id}`;
  if(owner.startsWith('scenario-setup:'))return owner===`scenario-setup:${scenario?.id}`;
  if(owner==='setup')return !scenario?.setup;
  const action=workspace.automation?.actions.find(item=>owner===`handler:${item.id}`);
  return !!workspace.automation?.checkpoints.length&&!!action&&(scenario?scenario.enabledHandlerIds.includes(action.id):action.enabled);
 }
 return (workspace.omittedValues??[]).filter(item=>{const set=sets.find(set=>set.owner===item.owner);return needed(item.owner)&&set&&!set.values[item.name]?.trim()&&!(execution&&item.owner===`scenario:${execution.scenarioId}`&&execution.runtime[item.name]?.trim());}).map(item=>'Supply omitted value '+item.name+' ('+item.owner+').');
}
