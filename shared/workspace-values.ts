import type {Workspace} from '../server/scenarios.js';
export type OmittedValue={owner:string;name:string};
export function workspaceValueSets(workspace:Workspace){return [
 ...(workspace.scenarios??[]).flatMap(scenario=>[{owner:'scenario:'+scenario.id,values:scenario.inputs},...(scenario.setup?[{owner:'scenario-setup:'+scenario.id,values:scenario.setup.parameters}]:[])]),
 ...(workspace.automation?[{owner:'setup',values:workspace.automation.setup.parameters},...workspace.automation.actions.map(action=>({owner:'handler:'+action.id,values:action.parameters}))]:[])];}
/** Removed owners no longer require repair; names remain until the recipient supplies values. */
export function missingValues(workspace:Workspace,runtime:Record<string,string>={},scenarioId?:string){
 const sets=workspaceValueSets(workspace);
 return (workspace.omittedValues??[]).filter(item=>{const set=sets.find(set=>set.owner===item.owner);return set&&!set.values[item.name]?.trim()&&!(item.owner==='scenario:'+scenarioId&&runtime[item.name]?.trim());}).map(item=>'Supply omitted value '+item.name+' ('+item.owner+').');
}
