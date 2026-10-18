import {parseAllDocuments} from 'yaml';
import {workspaceValueSets,missingValues,type OmittedValue} from '../shared/workspace-values.js';
export {missingValues,type OmittedValue} from '../shared/workspace-values.js';
import type {Workspace} from './scenarios.js';
export const packageLimit=1_100_000;
export type WorkspacePackage={format:'tnt-workspace';version:1;source:{revision:number;savedAt:string};dependencies:string[];workspace:Omit<Workspace,'id'|'metadata'|'canvasDiagnostics'>};
export type PackageReview={title:string;screens:number;connections:number;scenarios:number;flows:number;images:number;mock:boolean;automation:boolean;missing:string[];dependencies:string[]};
// Portable authoring is an allowlist. Personal and execution fields cannot hitchhike on graph records.
type Shape={ [key:string]:true|Shape|[Shape] };
const selector:Shape={target:true,match:true,value:true,visibility:true};
const reference:Shape={kind:true,file:true,index:true,actionId:true,fingerprint:true};
const call:Shape={file:true,parameters:true};
const shape:Shape={name:true,yaml:true,flows:true,mock:{environment:true,port:true,routeId:true,responseId:true,backendUrl:true,passthroughRouteIds:true,fromScreen:true,toScreen:true,failureSemantics:true},omittedValues:[{owner:true,name:true}],
 scenarios:[{id:true,name:true,skipInRunAll:true,steps:[reference],authoring:true,pathId:true,inputs:true,parameters:true,setup:call,enabledHandlerIds:true,mockResponseId:true,scripts:[{id:true,beforeStep:{index:true,fingerprint:true},label:true,source:true}]}],
 automation:{setup:call,actions:[{...call,id:true,name:true,condition:true,enabled:true}],checkpoints:[{beforeStep:true,fingerprint:true,timeoutMs:true}]},
 canvas:{screens:[{id:true,title:true,x:true,y:true,referenceScreenshot:true,tests:[{scenarioIds:true,input:true,back:true,backSelector:selector,tap:selector,check:selector,id:true,label:true,role:true,reference}]}],edges:[{actionTestIds:true,id:true,from:true,to:true,actionTestId:true,assertionTestId:true,responseCondition:true}],paths:[{scenarioId:true,id:true,name:true,edgeIds:true,screenId:true,finished:true,visits:[{id:true,operationIds:true,checkIds:true}]}]}};
function project(value:unknown,schema:Shape,strict:boolean):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Workspace package content must be an object.');
 const result:Record<string,unknown>={};
 for(const [key,item] of Object.entries(value)){
  if(item===undefined)continue;
  const rule=schema[key];if(!rule){if(strict)throw new Error('Unsupported package field: '+key);continue;}
  if(rule===true)result[key]=structuredClone(item);
  else if(Array.isArray(rule)){if(!Array.isArray(item))throw new Error('Package '+key+' must be a list.');result[key]=item.map(entry=>project(entry,rule[0],strict));}
  else result[key]=project(item,rule,strict);
 }
 return result;
}
export function readOmittedValues(value:unknown):OmittedValue[]|undefined{
 if(value===undefined)return;
 if(!Array.isArray(value)||value.length>1000||value.some(item=>!item||typeof item.owner!=='string'||! /^(setup|handler:[A-Za-z][A-Za-z0-9_-]{0,63}|scenario(?:-setup)?:[A-Za-z][A-Za-z0-9_-]{0,63})$/.test(item.owner)||typeof item.name!=='string'||! /^[A-Z][A-Z0-9_]{0,63}$/.test(item.name)))throw new Error('Invalid omitted parameter declaration.');
 return value.map(item=>({owner:item.owner,name:item.name}));
}
export function portableContent(workspace:Workspace,includeValues:boolean){
 const content=project(workspace,shape,false) as Workspace;
 content.omittedValues=readOmittedValues(workspace.omittedValues)??[];
 for(const scenario of content.scenarios??[])scenario.parameters=Object.fromEntries(Object.entries(scenario.parameters).map(([name,rule])=>[name,{type:rule.type,required:rule.required}]));
 if(!includeValues)for(const set of workspaceValueSets(content))for(const name of Object.keys(set.values)){if(!content.omittedValues.some(item=>item.owner===set.owner&&item.name===name))content.omittedValues.push({owner:set.owner,name});delete set.values[name];}
 // Dormant TLS paths are machine state, even with TLS disabled.
 if(content.mock){content.mock.environment.tlsOptions.pfxPath='';content.mock.environment.tlsOptions.passphrase='';content.mock.environment.tlsOptions.certPath='';content.mock.environment.tlsOptions.keyPath='';content.mock.environment.tlsOptions.caPath='';}
 return content;
}
export function parsePackage(value:unknown){
 const encoded=typeof value==='string'?value:JSON.stringify(value);
 if(typeof encoded!=='string'||Buffer.byteLength(encoded)>packageLimit)throw new Error('Workspace package exceeds 1.1 MB.');
 let parsed:unknown;try{parsed=JSON.parse(encoded);}catch{throw new Error('Unreadable workspace JSON. Choose a valid exported .json file.');}
 function inspect(item:unknown,depth=0){if(depth>40)throw new Error('Package nesting exceeds supported bounds.');if(item&&typeof item==='object')for(const [key,child] of Object.entries(item)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('Unsafe package key: '+key);inspect(child,depth+1);}}
 inspect(parsed);
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Choose a TnT workspace package.');
 const pkg=parsed as WorkspacePackage;
 if(pkg.format!=='tnt-workspace')throw new Error('Choose a TnT editable workspace JSON package.');
 if(pkg.version!==1)throw new Error('Unsupported workspace package version. This build accepts version 1; use a compatible TnT build.');
 if(!Array.isArray(pkg.dependencies)||pkg.dependencies.length>25||pkg.dependencies.some(item=>typeof item!=='string'||item.length>300))throw new Error('Package requires a bounded dependency summary.');
 if(Object.keys(pkg).some(key=>!['format','version','source','dependencies','workspace'].includes(key))||!pkg.source||Object.keys(pkg.source).some(key=>!['revision','savedAt'].includes(key))||!Number.isSafeInteger(pkg.source.revision)||pkg.source.revision<0||typeof pkg.source.savedAt!=='string'||!Number.isFinite(Date.parse(pkg.source.savedAt)))throw new Error('Invalid package revision or saved time.');
 const workspace=project(pkg.workspace,shape,true) as Workspace;
 const safeFile=(file:unknown)=>typeof file==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}\.yaml$/.test(file);
 for(const scenario of workspace.scenarios??[])if(scenario.setup&&(!safeFile(scenario.setup.file)||scenario.setup.file==='flow.yaml'))throw new Error('Scenario setup requires a simple reusable .yaml filename.');
 for(const screen of workspace.canvas?.screens??[])for(const test of screen.tests??[])if(!safeFile(test.reference?.file))throw new Error('Canvas references require simple .yaml filenames.');
 for(const screen of workspace.canvas?.screens??[]){
  if(screen.referenceScreenshot===undefined)continue;
  const match=typeof screen.referenceScreenshot==='string'?screen.referenceScreenshot.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/):null;
  if(!match)throw new Error('Embedded references must be PNG/JPEG data.');
  const bytes=Buffer.from(match[2],'base64');
  if(bytes.length>250_000||bytes.toString('base64')!==match[2]||(match[1]==='png'?!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217))throw new Error('Embedded references must be PNG/JPEG data up to 250 KB.');
 }
 if(workspace.mock){const tls=workspace.mock.environment?.tlsOptions;if(tls&&[tls.pfxPath,tls.certPath,tls.keyPath,tls.caPath,tls.passphrase].some(Boolean))throw new Error('Portable mock definitions cannot include local TLS paths or credentials.');}
 return {...pkg,workspace} as WorkspacePackage;
}
export function packageReview(workspace:Workspace,missing:string[]):PackageReview{
 return {title:workspace.name,screens:workspace.canvas?.screens.length??0,connections:workspace.canvas?.edges.length??0,scenarios:workspace.scenarios?.length??0,flows:Object.keys(workspace.flows??{}).length,images:workspace.canvas?.screens.filter(screen=>screen.referenceScreenshot).length??0,mock:!!workspace.mock,automation:!!workspace.automation,missing:[...new Set([...missingValues(workspace),...missing])],dependencies:['Installed app: '+parseAllDocuments(workspace.yaml)[0].toJS().appId,'Recipient supplies a compatible installed app and running iOS simulator.','Maestro 2.11.0',...(workspace.mock?['Mockoon 9.9.0; review backend URL and dedicated port.']:[])]};
}
