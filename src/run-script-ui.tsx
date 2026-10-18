import {useEffect,useRef,useState} from 'react';
import type {ScriptAnchor,ScriptBlockReason,ScriptRow,ScriptSourceWorkspace,ScriptStepResult,ScriptTrust} from '../server/run-script-contract.js';
import {REDACTED} from '../server/run-script-contract.js';
import {RunStatusBadge} from './visit-steps.js';
import {SCRIPT_EXAMPLE,SCRIPT_TIMEOUT,TRUST_UNKNOWN_TEXT,scriptFirstLine,scriptSourceLine,type ScriptRecord,type ScriptRowView} from './run-script.js';
import type {ScriptExecutionReference} from '../server/run-script-contract.js';

export function RedactedText({text}:{text:string}){
  if(!text.includes(REDACTED))return <>{text}</>;
  const parts=text.split(REDACTED);
  return <>{parts.map((part,index)=><span key={index}>{part}{index<parts.length-1&&<span className="redacted-chip" data-testid="redacted-chip">{REDACTED}</span>}</span>)}</>;
}

export function ReservedInline({reason}:{reason:Extract<ScriptBlockReason,{kind:'reserved-variable'|'reserved-input'}>}){
  const testId=reason.kind==='reserved-variable'?'reserved-variable-error':'reserved-input-error';
  return <p className="script-inline-error" data-testid={testId} role="alert">✕ {reason.message}{reason.kind==='reserved-variable'&&reason.line?' · line '+reason.line:''}</p>;
}

export function ScriptStepRow({row,view,reveal,open,runLocked,stepNumber,afterLast=false,canMoveUp,canMoveDown,onOpen,onMove,onDelete}:{row:ScriptRecord;view:ScriptRowView;reveal:boolean;open:boolean;runLocked:boolean;stepNumber:number;afterLast?:boolean;canMoveUp:boolean;canMoveDown:boolean;onOpen:()=>void;onMove:(direction:-1|1)=>void;onDelete:()=>void}){
  const preview=scriptFirstLine(row.source);
  const failed=view.tone==='failed';
  const showBlock=!!view.block&&(reveal||view.block.kind==='untrusted'||view.block.kind==='stale-anchor'||view.block.kind==='draft-anchor');
  const place=afterLast?'after the last step':'before step '+stepNumber;
  return <div className={'script-row'+(failed?' script-row-failed':'')+(open?' script-row-open':'')+(view.tone==='not-run'?' script-row-muted':'')} data-testid={showBlock?'script-blocks-run':'script-row'} data-script-id={row.id} data-block-kind={view.block?.kind} data-open={open?'true':undefined}>
    <button type="button" className="script-row-summary" aria-expanded={open} aria-label={'Run script · '+row.label+' '+place} onClick={onOpen}>
      <span className="script-chip" aria-hidden="true">{'</>'}</span>
      <span className="script-row-copy"><span className="script-row-title"><strong>Run script</strong> · {row.label}</span>{preview&&<span className="script-preview">{preview}</span>}{view.tone&&<span className="script-row-status"><RunStatusBadge status={{tone:view.tone==='failed'?'failed':view.tone}} testId={view.tone==='not-run'?'script-not-run':undefined}/></span>}</span>
    </button>
    {view.trustUnknown&&<p className="script-untrusted" data-testid="trust-unknown">{TRUST_UNKNOWN_TEXT}</p>}
    {!view.trustUnknown&&view.trust.origin==='imported'&&!view.trust.trusted&&<p className="script-untrusted" data-testid="script-not-trusted">⚠ Not trusted on this Mac</p>}
    {failed&&<p className="script-inline-error" data-testid="script-error-reason" role="alert">✕ Script failed: <RedactedText text={view.message||'Script failed'}/> · scenario stopped</p>}
    {showBlock&&view.block&&view.block.kind!=='untrusted'&&<p className="script-inline-error" role="alert">✕ {view.blockText??view.block.message}</p>}
    {!runLocked&&<details className="visit-step-actions script-row-actions"><summary aria-label={'Script actions '+row.label}>⋯</summary>
      <button type="button" disabled={!canMoveUp} aria-label={'Move '+row.label+' up'} onClick={event=>{event.currentTarget.closest('details')!.open=false;onMove(-1);}}>↑ Move up</button>
      <button type="button" disabled={!canMoveDown} aria-label={'Move '+row.label+' down'} onClick={event=>{event.currentTarget.closest('details')!.open=false;onMove(1);}}>↓ Move down</button>
      <button type="button" className="visit-step-delete" aria-label={'Delete '+row.label} onClick={onDelete}>Delete</button>
    </details>}
  </div>;
}

export function ScriptEditor({row,view,sourceWorkspace,stepNumber,afterLast=false,hasMock,untrustedLeft,running,timedOut,onChange,onTrust,onStop,onRunAgain,onOpenLog,onClose}:{row:ScriptRecord;view:ScriptRowView;sourceWorkspace?:ScriptSourceWorkspace;stepNumber:number;afterLast?:boolean;hasMock:boolean;untrustedLeft:number;running:boolean;timedOut:boolean;onChange:(patch:{label?:string;source?:string})=>void;onTrust:()=>Promise<void>;onStop?:()=>void;onRunAgain?:()=>void;onOpenLog?:()=>void;onClose:()=>void}){
  const [editing,setEditing]=useState(false);
  const [trusting,setTrusting]=useState(false);
  const [trustError,setTrustError]=useState('');
  const trustUnknown=!!view.trustUnknown;
  const readOnly=trustUnknown||(view.trust.origin==='imported'&&!view.trust.trusted);
  const showResult=running||view.tone==='passed'||view.tone==='failed'||view.tone==='not-run';
  const place=afterLast?'after the last step':'before step '+stepNumber;
  const title=showResult&&!editing?'Run script · '+row.label:'Run script · '+place;
  const remaining=Math.max(0,untrustedLeft-1);
  const nameRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(!readOnly)nameRef.current?.focus();},[row.id,readOnly]);
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();onClose();}};
    document.addEventListener('keydown',onKey);
    return ()=>document.removeEventListener('keydown',onKey);
  },[onClose]);
  return <aside className="script-editor" aria-label={title} data-script-editor={row.id}>
    <header className="script-editor-header"><h3>{title}</h3><button type="button" aria-label="Close script editor" onClick={onClose}>✕</button></header>
    {readOnly&&<div className="script-trust">
      {!trustUnknown&&<p>{scriptSourceLine(sourceWorkspace)} Scripts can read files and call the network.</p>}
      <div className="script-code-label"><span>Script · JavaScript</span><span className="script-readonly-badge">Read only until trusted</span></div>
      <ScriptSource source={row.source} readOnly/>
      {!trustUnknown&&<button type="button" className="primary script-trust-button" data-testid="trust-this-script" disabled={trusting} onClick={()=>{setTrusting(true);setTrustError('');void onTrust().then(()=>setTrusting(false)).catch(()=>{setTrustError('Trust could not be saved on this Mac.');setTrusting(false);});}}>Trust this script</button>}
      {trustError&&<p className="script-inline-error" role="alert">{trustError}</p>}
      {!trustUnknown&&<p className="script-trust-note">Each script is trusted on its own, after you've seen it in full. {remaining} of {untrustedLeft} left after this.</p>}
    </div>}
    {showResult&&!editing&&<div className="script-result">
      {running&&<div className="script-running"><p>While running</p><p className="script-running-label"><span className="run-status-spinner" aria-hidden="true"/> Running</p>{onStop&&<button type="button" className="script-stop" onClick={onStop}>■ Stop</button>}<p className="field-hint">Result is shown after the run ends. No banners.</p></div>}
      {!running&&view.tone==='passed'&&<div><p>After the run</p><p className="script-passed">✓ Passed</p><p>{(afterLast?'Ran after the last step':'Ran before step '+stepNumber)+(view.took?' · took '+view.took:'')}.</p>{onOpenLog&&<button type="button" className="text-button" onClick={onOpenLog}>Open run log</button>}</div>}
      {!running&&view.tone==='failed'&&<div><p>Result</p><p className="script-inline-error">✕ Script failed</p><p className="script-error-box" data-testid="script-error-reason">Error: <RedactedText text={view.message||'Script failed'}/></p><p>Scenario stopped. ✕ Failed at Run script. Step {stepNumber} did not run.</p><div className="script-result-actions">{onOpenLog&&<button type="button" className="text-button" onClick={onOpenLog}>Open run log</button>}{onRunAgain&&<button type="button" onClick={onRunAgain}>↻ Run again</button>}</div></div>}
      {!running&&view.tone==='not-run'&&<p className="script-muted">○ Not run</p>}
      {timedOut&&<p className="script-inline-error">✕ Run stopped at 300s cap</p>}
      {!running&&!trustUnknown&&<button type="button" className="text-button" onClick={()=>setEditing(true)}>Edit script</button>}
    </div>}
    {(!showResult||editing)&&!readOnly&&<div className="script-author">
      <label>Name<input ref={nameRef} aria-label="Script name" value={row.label} maxLength={120} onChange={event=>onChange({label:event.target.value})}/></label>
      <div className="script-code-label"><span>Script · JavaScript</span><button type="button" className="text-button" onClick={()=>onChange({source:SCRIPT_EXAMPLE})}>Example code</button></div>
      <ScriptSource source={row.source} onChange={source=>onChange({source})}/>
      {view.block?.kind==='syntax'&&<p className="script-inline-error script-code-error" role="alert">✕ {view.block.message}</p>}
      <p className="field-hint">Throw an error to fail this step and stop the scenario. http doesn't throw on 4xx/5xx. Check res.ok yourself.</p>
      <div className="script-provided">
        <p>Provided by TnT</p>
        {hasMock?<dl>
          <dt><code>TNT_MOCK_URL</code></dt><dd>for this run only, never saved</dd>
          <dt><code>TNT_MOCK_TOKEN</code></dt><dd>for this run only, never saved</dd>
        </dl>:<p className="script-muted" data-testid="script-no-mock">No mock in this scenario · TNT_MOCK_URL and TNT_MOCK_TOKEN aren't set</p>}
      </div>
      <p className="script-secret-warning">⚠ Script text appears in the run log. Keep secrets out.</p>
      <p className="script-timeout" data-testid="script-timeout">{SCRIPT_TIMEOUT}</p>
    </div>}
  </aside>;
}

function ScriptSource({source,readOnly,onChange}:{source:string;readOnly?:boolean;onChange?:(source:string)=>void}){
  const lines=source.split('\n');
  return <div className="script-code"><div className="script-gutter" aria-hidden="true">{(lines.length?lines:['']).map((_,index)=><span key={index}>{index+1}</span>)}</div>{readOnly?<pre className="script-source" data-testid="script-source">{source}</pre>:<textarea aria-label="Script source" className="script-source" spellCheck={false} value={source} onChange={event=>onChange?.(event.target.value)}/>}</div>;
}

export function resultHasScriptError(results:ScriptStepResult[]){return results.some(item=>item.status==='script-error');}

export type RunScriptModel={
  scenarioId:string;
  rows:ScriptRecord[];
  trust:ScriptTrust[];
  results:ScriptStepResult[];
  executionOrder:ScriptExecutionReference[];
  hasMock:boolean;
  revealBlocks:boolean;
  running:boolean;
  passedRun:boolean;
  timedOut:boolean;
  scrubFailed:boolean;
  failedAtScript:boolean;
  trustBlockCount:number;
  trustLoadFailed?:boolean;
  sourceWorkspace?:ScriptSourceWorkspace;
  onAdd:(anchor:ScriptAnchor)=>string;
  onUpdate:(rowId:string,patch:{label?:string;source?:string})=>void;
  onMove:(rowId:string,direction:-1|1,stepCount:number,fingerprintAt:(index:number)=>string)=>void;
  onDelete:(rowId:string)=>void;
  onReplace:(rows:ScriptRow[])=>void;
  onTrust:(rowId:string)=>Promise<void>;
  onRetryTrust?:()=>void;
  onStop?:()=>void;
  onRunAgain?:()=>void;
  onOpenLog?:()=>void;
};

export type {ScriptTrust};
