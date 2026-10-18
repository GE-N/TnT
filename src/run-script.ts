import type {CanvasGraph} from '../server/canvas.js';
import type {ScriptAnchor,ScriptBlockReason,ScriptExecutionReference,ScriptOrigin,ScriptRow,ScriptRunResults,ScriptStepResult,ScriptTrust} from '../server/run-script-contract.js';
import {EVIDENCE_SCRUB_FAILED,REDACTED} from '../server/run-script-contract.js';
import {routeVisits,visitOperations,visitScreenId} from '../shared/canvas-authoring.js';

const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

function rotr(value:number,bits:number){return (value>>>bits)|(value<<(32-bits));}

/** sha256 of the script source. Trust is keyed to this, never to the workspace file. */
export function sha256(message:string){
  const data=new TextEncoder().encode(message);
  const bitLength=data.length*8;
  const padded=new Uint8Array(((data.length+9+63)>>6)<<6);
  padded.set(data);
  padded[data.length]=0x80;
  const view=new DataView(padded.buffer);
  view.setUint32(padded.length-8,Math.floor(bitLength/0x100000000));
  view.setUint32(padded.length-4,bitLength>>>0);
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const words=new Uint32Array(64);
  for(let offset=0;offset<padded.length;offset+=64){
    for(let index=0;index<16;index++)words[index]=view.getUint32(offset+index*4);
    for(let index=16;index<64;index++){
      const earlier=words[index-15];const recent=words[index-2];
      const small=(rotr(earlier,7)^rotr(earlier,18)^(earlier>>>3))>>>0;
      const large=(rotr(recent,17)^rotr(recent,19)^(recent>>>10))>>>0;
      words[index]=(words[index-16]+small+words[index-7]+large)>>>0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for(let index=0;index<64;index++){
      const sum1=(rotr(e,6)^rotr(e,11)^rotr(e,25))>>>0;
      const choose=((e&f)^(~e&g))>>>0;
      const temp1=(h+sum1+choose+K[index]+words[index])>>>0;
      const sum0=(rotr(a,2)^rotr(a,13)^rotr(a,22))>>>0;
      const majority=((a&b)^(a&c)^(b&c))>>>0;
      const temp2=(sum0+majority)>>>0;
      h=g;g=f;f=e;e=(d+temp1)>>>0;d=c;c=b;b=a;a=(temp1+temp2)>>>0;
    }
    h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+h)>>>0;
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map(value=>value.toString(16).padStart(8,'0')).join('');
}

export const SCRIPT_EXAMPLE=[
  '// Switch POST /pay to the 200 response',
  'const res = http.put(',
  '  `${TNT_MOCK_URL}/mockoon-admin/`, {',
  '  headers: { Authorization: TNT_MOCK_TOKEN,',
  "    'Content-Type': 'application/json' },",
  '  body: JSON.stringify({ })',
  '})',
  'if (!res.ok) throw new Error(',
  '  `Switch to 200 failed: ${res.status}`)',
].join('\n');

export const SCRIPT_TIMEOUT='◷ No per-script timeout · the run stops at its 300s cap';
export const DRAFT_STEP_TEXT='Step not captured yet · capture it before running';
export const SCRUB_FAILED_TEXT='✕ Evidence scrub failed · run evidence was removed to protect the token';

export type OrderedStep={id:string;visitId:string;visitIndex:number;globalIndex:number;fingerprint:string};

/** Only authored steps are indexes. Setup and handler rows are never anchors and are never counted. */
function anchorsScript(test:{role?:string;reference?:{kind?:string}}|undefined){
  return !!test&&test.role!=='setup'&&test.role!=='handler'&&test.reference?.kind==='step';
}

export function orderedScenarioSteps(graph:CanvasGraph,pathId:string):OrderedStep[]{
  const path=graph.paths.find(item=>item.id===pathId);
  if(!path?.screenId)return [];
  const steps:OrderedStep[]=[];
  routeVisits(graph,path).forEach((visit,visitIndex)=>{
    const screen=graph.screens.find(item=>item.id===visitScreenId(graph,path,visitIndex));
    for(const id of visitOperations(graph,path,visitIndex)){
      const test=screen?.tests.find(item=>item.id===id);
      if(!anchorsScript(test))continue;
      steps.push({id,visitId:visit.id,visitIndex,globalIndex:steps.length,fingerprint:test!.reference.fingerprint});
    }
  });
  return steps;
}

export function scriptFirstLine(source:string){
  const line=(source.split('\n').find(item=>item.trim())??'').trim();
  return line.length>28?line.slice(0,22).trimEnd()+' ...':line;
}

export type ScriptRecord=ScriptRow&{scenarioId:string;origin:ScriptOrigin;hash:string};

/** Trusted only when the server returned a matching hash. A missing answer is untrusted, and not an import. */
export function trustFor(row:Pick<ScriptRecord,'id'|'hash'>,approvals:ScriptTrust[]):ScriptTrust{
  const approval=approvals.find(item=>item.rowId===row.id&&item.hash===row.hash);
  if(approval?.trusted)return {rowId:row.id,origin:approval.origin==='local'?'local':'imported',trusted:true,hash:row.hash};
  if(approval)return {rowId:row.id,origin:approval.origin==='imported'?'imported':'local',trusted:false,hash:row.hash};
  return {rowId:row.id,origin:'local',trusted:false,hash:row.hash};
}

export function recordsFor(scenarioId:string,rows:ScriptRow[]|undefined,approvals:ScriptTrust[]):ScriptRecord[]{
  return (rows??[]).map(row=>{
    const hash=sha256(row.source);
    const trust=trustFor({id:row.id,hash},approvals);
    return {...row,scenarioId,origin:trust.origin,hash};
  });
}

/** Ids must match the server's script-row pattern, so they cannot start with a digit. */
export function newScriptId(){
  return 'script-'+crypto.randomUUID().replace(/-/g,'').slice(0,12);
}

/** Seconds from a per-script duration, when the result carries one. */
export function scriptTook(result?:ScriptStepResult):string|undefined{
  if(!result||!('durationMs' in result))return;
  const ms=(result as {durationMs?:unknown}).durationMs;
  if(typeof ms!=='number'||!Number.isFinite(ms)||ms<0)return;
  const seconds=ms/1000;
  return (seconds>=10?String(Math.round(seconds)):String(Math.round(seconds*10)/10))+'s';
}

export function compileScript(source:string){
  try{new Function(source);return;}
  catch(error){
    const message=error instanceof Error?error.message:'Syntax error';
    const located=/(\d+):(\d+)/.exec(message);
    return {message,line:located?Number(located[1]):undefined,column:located?Number(located[2]):undefined};
  }
}

/** Checkpoint fingerprint of the last authored step, plus the end suffix. An empty step list is "end". */
export function endAnchorFingerprint(lastFingerprint?:string){
  return lastFingerprint?lastFingerprint+':end':'end';
}

/** A draft step is not an anchor, including the end position when the last step is still draft. */
export function anchorTargetsDraft(anchor:ScriptAnchor,steps:OrderedStep[]){
  if(anchor.index===steps.length)return steps.at(-1)?.fingerprint==='draft';
  return steps[anchor.index]?.fingerprint==='draft';
}

/** True when the stored anchor still names the current step list. End anchors do not slide forward. */
export function anchorMatches(anchor:ScriptAnchor,steps:OrderedStep[]){
  if(!steps.length)return anchor.index===0&&anchor.fingerprint==='end';
  if(anchor.index===steps.length)return anchor.fingerprint===endAnchorFingerprint(steps[steps.length-1].fingerprint);
  const step=steps[anchor.index];
  return !!step&&anchor.fingerprint===step.fingerprint;
}

/** Before-launch block for one row. Empty wins, then a stale anchor, then syntax, then trust. */
export function scriptBlock(row:ScriptRecord,steps:OrderedStep[],approvals:ScriptTrust[]):ScriptBlockReason|undefined{
  if(anchorTargetsDraft(row.beforeStep,steps))return {kind:'stale-anchor',rowId:row.id,message:'Step changed · relink before running'};
  if(!row.source.trim())return {kind:'empty',rowId:row.id,message:'Script is empty · add code or delete the row'};
  if(!anchorMatches(row.beforeStep,steps))return {kind:'stale-anchor',rowId:row.id,message:'Step changed · relink before running'};
  const syntax=compileScript(row.source);
  if(syntax)return {kind:'syntax',rowId:row.id,message:'Script error: '+syntax.message,line:syntax.line,column:syntax.column};
  if(!trustFor(row,approvals).trusted)return {kind:'untrusted',rowId:row.id,message:'Script needs trust'};
}

export function blocksFor(rows:ScriptRecord[],steps:OrderedStep[],approvals:ScriptTrust[]){
  return rows.flatMap(row=>{
    const reason=scriptBlock(row,steps,approvals);
    return reason?[reason]:[];
  });
}

/** Stable by beforeStep.index. Rows that share an anchor keep their array order. */
export function stableScriptOrder(rows:ScriptRecord[]){
  return rows.map((item,order)=>({item,order})).sort((left,right)=>left.item.beforeStep.index-right.item.beforeStep.index||left.order-right.order).map(entry=>entry.item);
}

export function untrustedCount(rows:ScriptRecord[],approvals:ScriptTrust[]){
  return rows.filter(row=>row.source.trim()&&!trustFor(row,approvals).trusted).length;
}

export function runBlockedLabel(count:number){
  return '✕ Run blocked · '+count+' imported '+(count===1?'script needs':'scripts need')+' Trust';
}

export type ScriptRowView={
  block?:ScriptBlockReason;
  blockText?:string;
  trust:ScriptTrust;
  tone?:'running'|'passed'|'failed'|'not-run';
  message?:string;
  took?:string;
};

function scriptFailureIndex(rows:ScriptRecord[],results:ScriptStepResult[],executionOrder:ScriptExecutionReference[]){
  const failed=results.find(item=>item.status==='script-error');
  if(!failed)return -1;
  if(executionOrder.length){
    const at=executionOrder.findIndex(item=>item.kind==='runScript'&&item.rowId===failed.rowId);
    if(at>=0)return at;
  }
  return stableScriptOrder(rows).findIndex(item=>item.id===failed.rowId);
}

export function scriptFollowsFailure(rowId:string,rows:ScriptRecord[],results:ScriptStepResult[],executionOrder:ScriptExecutionReference[]=[]){
  const failed=results.find(item=>item.status==='script-error');
  if(!failed||failed.rowId===rowId)return false;
  if(executionOrder.length){
    const failedAt=scriptFailureIndex(rows,results,executionOrder);
    const place=executionOrder.findIndex(item=>item.kind==='runScript'&&item.rowId===rowId);
    if(failedAt>=0&&place>=0)return place>failedAt;
  }
  const ordered=stableScriptOrder(rows);
  const failedAt=ordered.findIndex(item=>item.id===failed.rowId);
  return failedAt>=0&&ordered.findIndex(item=>item.id===rowId)>failedAt;
}

export function scriptRowView(row:ScriptRecord,rows:ScriptRecord[],steps:OrderedStep[],approvals:ScriptTrust[],results:ScriptStepResult[],running:boolean,passedRun:boolean,executionOrder:ScriptExecutionReference[]=[]):ScriptRowView{
  const trust=trustFor(row,approvals);
  const block=scriptBlock(row,steps,approvals);
  const blockText=anchorTargetsDraft(row.beforeStep,steps)?DRAFT_STEP_TEXT:undefined;
  const result=results.find(item=>item.rowId===row.id);
  const took=scriptTook(result);
  if(result?.status==='script-error')return {block,blockText,trust,tone:'failed',message:result.message};
  if(result?.status==='not-run'||scriptFollowsFailure(row.id,rows,results,executionOrder))return {block,blockText,trust,tone:'not-run',message:result?.message};
  if(result?.status==='passed')return {block,blockText,trust,tone:'passed',took};
  if(!result&&passedRun)return {block,blockText,trust,tone:'not-run'};
  if(running&&!result)return {block,blockText,trust,tone:'running'};
  return {block,blockText,trust};
}

export function stepNotRun(step:OrderedStep,rows:ScriptRecord[],results:ScriptStepResult[],executionOrder:ScriptExecutionReference[]=[]){
  const failed=results.find(item=>item.status==='script-error');
  if(!failed)return false;
  if(executionOrder.length){
    const failedAt=scriptFailureIndex(rows,results,executionOrder);
    const place=executionOrder.findIndex(item=>item.kind==='step'&&item.index===step.globalIndex);
    if(failedAt>=0&&place>=0)return place>failedAt;
  }
  const row=rows.find(item=>item.id===failed.rowId);
  return !!row&&step.globalIndex>=row.beforeStep.index;
}

export function evidenceScrubFailed(run:{status?:string;error?:string;mappingNote?:string}|undefined){
  if(!run)return false;
  const message=run.error??run.mappingNote??'';
  return message===EVIDENCE_SCRUB_FAILED||message.startsWith(EVIDENCE_SCRUB_FAILED+' ');
}

export function runHitCap(run:{status?:string;error?:string;mappingNote?:string;log?:string}|undefined){
  if(!run||run.status==='passed'||run.status==='running')return false;
  return [run.error,run.mappingNote,run.log].some(text=>typeof text==='string'&&text.includes('300s cap'));
}

function readScriptSteps(value:unknown):Record<string,ScriptStepResult>{
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).flatMap(([rowId,item])=>{
    if(!item||typeof item!=='object')return [];
    const result=item as ScriptStepResult;
    if(result.kind!=='runScript'||result.rowId!==rowId||!['passed','script-error','not-run'].includes(result.status))return [];
    return [[rowId,result]];
  }));
}

function readExecutionOrder(value:unknown):ScriptExecutionReference[]{
  if(!Array.isArray(value))return [];
  const order:ScriptExecutionReference[]=[];
  for(const item of value){
    if(!item||typeof item!=='object')continue;
    const reference=item as ScriptExecutionReference;
    if(reference.kind==='step'&&Number.isInteger(reference.index))order.push({kind:'step',index:reference.index});
    else if(reference.kind==='runScript'&&typeof reference.rowId==='string')order.push({kind:'runScript',rowId:reference.rowId});
    else if(reference.kind==='system')order.push({kind:'system'});
  }
  return order;
}

/** Row status comes from scriptSteps. executionOrder is references only. */
export function readScriptRun(run:unknown):ScriptRunResults{
  const empty:ScriptRunResults={scriptSteps:{},executionOrder:[]};
  if(!run||typeof run!=='object')return empty;
  const record=run as ScriptRunResults&{snapshot?:ScriptRunResults};
  const source=record.scriptSteps||record.executionOrder?record:record.snapshot;
  if(!source)return empty;
  return {scriptSteps:readScriptSteps(source.scriptSteps),executionOrder:readExecutionOrder(source.executionOrder)};
}

export function scriptResultsFromRun(run:unknown):ScriptStepResult[]{
  return Object.values(readScriptRun(run).scriptSteps);
}

export function readBlocked(payload:unknown):ScriptBlockReason[]{
  if(!payload||typeof payload!=='object'||!Array.isArray((payload as {blocked?:unknown}).blocked))return [];
  return (payload as {blocked:ScriptBlockReason[]}).blocked.filter(item=>item&&typeof item==='object'&&typeof item.kind==='string'&&typeof item.message==='string');
}

const RESERVED_INPUTS=['TNT_MOCK_URL','TNT_MOCK_TOKEN'] as const;
const RESERVED_VARIABLE=/\$\{TNT_MOCK_(?:URL|TOKEN)\}/;

export function isReservedInput(name:string):name is 'TNT_MOCK_URL'|'TNT_MOCK_TOKEN'{
  return (RESERVED_INPUTS as readonly string[]).includes(name);
}

export type ReservedPlacement={
  target:'yaml'|'flows'|'scenario-input'|'runtime'|'parameters';
  line?:number;
  reason:Extract<ScriptBlockReason,{kind:'reserved-variable'|'reserved-input'}>;
};

function variableLines(text:string,target:ReservedPlacement['target']):ReservedPlacement[]{
  return text.split('\n').flatMap((line,index)=>RESERVED_VARIABLE.test(line)?[{target,line:index+1,reason:{kind:'reserved-variable' as const,message:'Reserved TnT variable' as const,line:index+1}}]:[]);
}

function inputNames(value:unknown,target:'scenario-input'|'runtime'|'parameters'):ReservedPlacement[]{
  if(!value||typeof value!=='object'||Array.isArray(value))return [];
  return Object.keys(value).flatMap(name=>isReservedInput(name)?[{target,reason:{kind:'reserved-input' as const,input:name,message:'TNT_MOCK_URL and TNT_MOCK_TOKEN are reserved by TnT.' as const}}]:[]);
}

function jsonObject(text:string){
  try{const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}
  catch{return undefined;}
}

export function reservedPlacements(input:{yaml:string;flows:string;scenarios:{inputs?:Record<string,string>;parameters?:Record<string,unknown>}[];runtimeText:string}):ReservedPlacement[]{
  const placements=[...variableLines(input.yaml,'yaml'),...variableLines(input.flows,'flows')];
  for(const scenario of input.scenarios){
    placements.push(...inputNames(scenario.inputs,'scenario-input'));
    placements.push(...inputNames(scenario.parameters,'parameters'));
    for(const value of Object.values(scenario.inputs??{}))if(typeof value==='string'&&RESERVED_VARIABLE.test(value))placements.push({target:'scenario-input',reason:{kind:'reserved-variable',message:'Reserved TnT variable'}});
  }
  const runtime=jsonObject(input.runtimeText);
  placements.push(...inputNames(runtime,'runtime'));
  if(RESERVED_VARIABLE.test(input.runtimeText))placements.push({target:'runtime',reason:{kind:'reserved-variable',message:'Reserved TnT variable'}});
  if(!runtime)for(const name of RESERVED_INPUTS)if(input.runtimeText.includes('"'+name+'"'))placements.push({target:'runtime',reason:{kind:'reserved-input',input:name,message:'TNT_MOCK_URL and TNT_MOCK_TOKEN are reserved by TnT.'}});
  return placements;
}

export type BatchLine={scenarioId:string;name:string;status:string;reason?:string;runId?:string};

export type BatchSummary={statusText:string;reason?:string;testId?:string;tone:'trust'|'failed'|'plain'};

/** "Script failed" is a finished run. "Script needs trust" fails before launch. */
export function batchSummary(entry:BatchLine):BatchSummary{
  if(entry.reason==='Script needs trust')return {statusText:'failed',reason:'Script needs trust',testId:'batch-script-untrusted',tone:'trust'};
  if(entry.status==='script-error'||entry.reason==='Script failed')return {statusText:'failed',reason:'Script failed',testId:'batch-script-failed',tone:'failed'};
  return {statusText:entry.status,reason:entry.reason,tone:'plain'};
}

/** Variables are shown when the workspace has a mock and this scenario chose a response or has a trusted script. */
export function scenarioShowsMockVariables(workspaceHasMock:boolean,mockResponseId:string|undefined,rows:ScriptRecord[],approvals:ScriptTrust[]){
  return workspaceHasMock&&(!!mockResponseId||rows.some(row=>trustFor(row,approvals).trusted));
}

export function batchReasonLabel(summary:BatchSummary){
  if(!summary.reason)return;
  if(summary.tone==='trust')return '⚠ '+summary.reason;
  if(summary.tone==='failed')return '✕ '+summary.reason;
  return summary.reason;
}

/** Untrusted scenarios fail before launch. The rest of the batch keeps its order and continues. */
export function batchWithScriptBlocks(order:string[],entries:BatchLine[],blocks:Map<string,ScriptBlockReason>,names:Map<string,string>):BatchLine[]{
  const byId=new Map(entries.map(entry=>[entry.scenarioId,entry]));
  return order.map(id=>{
    const reason=blocks.get(id);
    if(reason)return {scenarioId:id,name:names.get(id)??byId.get(id)?.name??id,status:'failed',reason:reason.kind==='untrusted'?'Script needs trust':reason.message};
    return byId.get(id)??{scenarioId:id,name:names.get(id)??id,status:'not-run'};
  });
}

/** Anchor before the next authored step, or after the last step when this visit is the end. */
export function anchorForNewScript(steps:OrderedStep[],visitIndex:number):ScriptAnchor{
  const index=steps.filter(step=>step.visitIndex<=visitIndex).length;
  if(index>=steps.length)return {index:steps.length,fingerprint:endAnchorFingerprint(steps.at(-1)?.fingerprint)};
  return {index,fingerprint:steps[index].fingerprint};
}

/** Move within the same anchor by swapping order, or retarget the anchor onto the neighboring step. */
export function moveScript(rows:ScriptRecord[],rowId:string,direction:-1|1,stepCount:number,fingerprintAt:(index:number)=>string):ScriptRecord[]|undefined{
  const row=rows.find(item=>item.id===rowId);
  if(!row)return;
  const group=rows.filter(item=>item.scenarioId===row.scenarioId&&item.beforeStep.index===row.beforeStep.index);
  const position=group.findIndex(item=>item.id===rowId);
  const neighbor=group[position+direction];
  if(neighbor){
    const next=rows.slice();
    const from=next.findIndex(item=>item.id===rowId);
    const to=next.findIndex(item=>item.id===neighbor.id);
    [next[from],next[to]]=[next[to],next[from]];
    return next;
  }
  const index=row.beforeStep.index+direction;
  if(index<0||index>stepCount)return;
  const beforeStep:ScriptAnchor={index,fingerprint:fingerprintAt(index)};
  return rows.map(item=>item.id===rowId?{...item,beforeStep}:item);
}

export {REDACTED,EVIDENCE_SCRUB_FAILED};
