import {parseAllDocuments,stringify} from 'yaml';
import {referenceCatalog,type YAMLReference,type CanvasGraph} from './canvas.js';
import {readAutomation,instrument,type Automation,type FlowCall} from './default-actions.js';
import {validateMock,type MockPlan} from './mockoon.js';
export type Parameter={type:'text'|'number'|'boolean';required:boolean};
export type ScenarioDefinition={id:string;name:string;steps:YAMLReference[];pathId?:string;inputs:Record<string,string>;parameters:Record<string,Parameter>;setup:FlowCall;enabledHandlerIds:string[];mockResponseId?:string};
export function namedInputs(value:unknown):Record<string,string>{
 if(value===undefined)return {};
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>20||Object.entries(value).some(([key,input])=>! /^[A-Z][A-Z0-9_]{0,63}$/.test(key)||key.startsWith('MAESTRO_')||typeof input!=='string'||input.length>4000||input.includes('\0')))throw new Error('Inputs require at most 20 uppercase names and bounded strings; MAESTRO_ names are reserved.');
 return {...value} as Record<string,string>;
}
export function readScenarios(value:unknown):ScenarioDefinition[]|undefined{
 if(value===undefined)return;
 if(!Array.isArray(value)||value.length>20)throw new Error('Use at most 20 named scenarios.');
 const ids=new Set<string>();
 return value.map((item:ScenarioDefinition)=>{
  if(!item||typeof item.id!=='string'||! /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.id)||ids.has(item.id)||typeof item.name!=='string'||!item.name.trim()||item.name.length>120)throw new Error('Scenarios require unique IDs and nonempty names.');
  ids.add(item.id);
  if(!Array.isArray(item.steps)||!item.steps.length||item.steps.length>100||item.steps.some(ref=>!ref||ref.kind!=='step'||ref.file!=='flow.yaml'||!Number.isInteger(ref.index)||ref.index!<0||typeof ref.fingerprint!=='string'||ref.fingerprint.length!==64)||new Set(item.steps.map(ref=>ref.index)).size!==item.steps.length||item.steps.some((ref,index)=>index>0&&ref.index!<=item.steps[index-1].index!))throw new Error('Scenarios require unique explicit authored step references.');
  if(item.pathId!==undefined&&(typeof item.pathId!=='string'||!item.pathId||item.pathId.length>120))throw new Error('Provide an explicit scenario path ID.');
  if(!item.setup||typeof item.setup.file!=='string')throw new Error('Each scenario must declare setup.');
  if(!Array.isArray(item.enabledHandlerIds)||item.enabledHandlerIds.length>20||item.enabledHandlerIds.some(id=>typeof id!=='string')||new Set(item.enabledHandlerIds).size!==item.enabledHandlerIds.length)throw new Error('Declare unique enabled default-action IDs.');
  const parameters=item.parameters??{};
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)||Object.keys(parameters).length>20)throw new Error('Declare at most 20 parameter requirements.');
  namedInputs(Object.fromEntries(Object.keys(parameters).map(name=>[name,''])));
  for(const rule of Object.values(parameters))if(!rule||!['text','number','boolean'].includes(rule.type)||typeof rule.required!=='boolean')throw new Error('Parameter requirements need text/number/boolean type and required flag.');
  if(item.mockResponseId!==undefined&&(typeof item.mockResponseId!=='string'||!item.mockResponseId||item.mockResponseId.length>120))throw new Error('Choose a mock response identity.');
  return {id:item.id,name:item.name.trim(),pathId:item.pathId,steps:item.steps.map(ref=>({kind:'step',file:'flow.yaml',index:ref.index,fingerprint:ref.fingerprint})),setup:{file:item.setup.file,parameters:namedInputs(item.setup.parameters)},enabledHandlerIds:[...item.enabledHandlerIds],inputs:namedInputs(item.inputs),parameters:structuredClone(parameters),mockResponseId:item.mockResponseId};
 });
}
// Selection references the authored commands; the execution projection never edits them.
export function selectScenario(workspace:{yaml:string;flows?:Record<string,string>;canvas?:CanvasGraph;automation?:Automation;mock?:MockPlan;scenarios?:ScenarioDefinition[]},id:unknown,runtime:Record<string,string>){
 const definitions=readScenarios(workspace.scenarios);
 if(!definitions?.length){if(id!==undefined)throw new Error('Unknown scenario.');return;}
 const scenario=definitions.find(item=>item.id===id);if(!scenario)throw new Error('Explicitly select a saved scenario.');
 const flows=workspace.flows??{};const source=referenceCatalog(workspace.yaml,flows,workspace.automation);
 for(const ref of scenario.steps)if(!source.references.some(entry=>entry.kind==='step'&&entry.index===ref.index&&entry.fingerprint===ref.fingerprint))throw new Error('Broken or stale scenario step reference. Explicitly relink its selected steps.');
 const inputs=namedInputs({...scenario.inputs,...runtime});
 for(const [name,rule] of Object.entries(scenario.parameters)){
  const value=inputs[name];
  if(rule.required&&(value===undefined||!value.trim()))throw new Error('Missing required input: '+name);
  if(value!==undefined&&((rule.type==='number'&&(!value.trim()||!Number.isFinite(Number(value))))||(rule.type==='boolean'&&!['true','false'].includes(value))))throw new Error('Invalid '+rule.type+' input: '+name);
 }
 const docs=parseAllDocuments(workspace.yaml);const commands=docs[1].toJS();
 const yaml=docs[0].toString()+'---\n'+stringify(scenario.steps.map(ref=>commands[ref.index!]),{aliasDuplicateObjects:false,lineWidth:0});
 const catalog=referenceCatalog(yaml,flows);
 const positions=new Map(scenario.steps.map((ref,index)=>[ref.index!,index]));
 const base=workspace.automation;
 if(scenario.enabledHandlerIds.some(id=>!base?.actions.some(action=>action.id===id)))throw new Error('Scenario references an unknown default action.');
 const automation=readAutomation({setup:scenario.setup,actions:(base?.actions??[]).map(action=>({...action,enabled:scenario.enabledHandlerIds.includes(action.id)})),checkpoints:(base?.checkpoints??[]).filter(check=>positions.has(check.beforeStep)).map(check=>{
  const original=source.references.find(ref=>ref.kind==='step'&&ref.index===check.beforeStep);
  if(original?.fingerprint!==check.fingerprint)throw new Error('Broken or stale checkpoint reference. Explicitly relink before running.');
  const index=positions.get(check.beforeStep)!;
  return {...check,beforeStep:index,fingerprint:catalog.references.find(ref=>ref.kind==='step'&&ref.index===index)!.fingerprint};
 })},flows,yaml)!;
 const target=referenceCatalog(yaml,flows,automation);
 const canvas=workspace.canvas&&structuredClone(workspace.canvas);
 if(canvas)for(const screen of canvas.screens)for(const test of screen.tests){
  const ref=test.reference;
  const original=source.references.find(entry=>entry.kind===ref.kind&&entry.file===ref.file&&entry.index===ref.index&&entry.actionId===ref.actionId&&entry.fingerprint===ref.fingerprint);
  if(!original)continue; // Stale authoring references must stay stale.
  const index=ref.kind==='step'||ref.kind==='handler'?positions.get(ref.index!):undefined;
  const projected=target.references.find(entry=>entry.kind===ref.kind&&entry.file===ref.file&&entry.index===index&&entry.actionId===ref.actionId);
  test.reference=projected?{kind:projected.kind,file:projected.file,index:projected.index,actionId:projected.actionId,fingerprint:projected.fingerprint}:{...ref,fingerprint:'not-selected'};
 }
 validateFlowInputs(instrument(yaml,automation).yaml,flows,inputs);
 if(scenario.mockResponseId&&!workspace.mock)throw new Error('Configure the shared mock environment before choosing a response.');
 let mock=scenario.mockResponseId?validateMock({...workspace.mock,responseId:scenario.mockResponseId}):undefined;
 if(mock&&canvas&&scenario.pathId){const path=canvas.paths.find(path=>path.id===scenario.pathId);const edges=path?.edgeIds.map(id=>canvas.edges.find(edge=>edge.id===id));const first=edges?.[0];const last=edges?.at(-1);if(first&&last)mock={...mock,fromScreen:canvas.screens.find(screen=>screen.id===first.from)!.title,toScreen:canvas.screens.find(screen=>screen.id===last.to)!.title};}
 if(canvas&&!scenario.pathId)throw new Error('Select a canvas path for this scenario.');
 return {scenario,yaml,automation,canvas,mock,inputs};
}

// Validate simple Maestro placeholders at invocation scopes. JavaScript expressions stay YAML-owned.
function validateFlowInputs(yaml:string,flows:Record<string,string>,inputs:Record<string,string>,ancestors:string[]=[]){
 const docs=parseAllDocuments(yaml);
 if(docs.length!==2||docs.some(doc=>doc.errors.length))throw new Error('Repair reusable-flow YAML before running.');
 const config=docs[0].toJS();const values={...inputs,...config?.env};
 const builtIns=new Set(['MAESTRO_FILENAME','MAESTRO_DEVICE_UDID','MAESTRO_SHARD_ID','MAESTRO_SHARD_INDEX']);
 const check=(value:unknown,scope:Record<string,unknown>)=>{
  if(typeof value!=='string')return;
  for(const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g))if(!builtIns.has(match[1])&&(scope[match[1]]===undefined||scope[match[1]]===''))throw new Error('Missing required input: '+match[1]);
 };
 const walk=(value:unknown,scope:Record<string,unknown>):void=>{
  if(typeof value==='string'){check(value,scope);return;}
  if(Array.isArray(value)){value.forEach(item=>walk(item,scope));return;}
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){
   if(key==='runFlow'){
    const invocation=typeof child==='string'?{file:child}:child as {file?:string;env?:Record<string,string>;commands?:unknown};
    if(!invocation||typeof invocation!=='object')continue;
    const {file,env,commands,...conditions}=invocation as Record<string,unknown>;walk(conditions,scope);
    walk(invocation.env,scope);
    const nested={...scope,...invocation.env};
    if(invocation.file){if(ancestors.includes(invocation.file))throw new Error('Recursive reusable flows are unsupported.');if(flows[invocation.file])validateFlowInputs(flows[invocation.file],flows,nested as Record<string,string>,[...ancestors,invocation.file]);}
    else walk(invocation.commands,nested);
   }else walk(child,scope);
  }
 };
 walk(config?.env,inputs);walk(docs[1].toJS(),values);
}
