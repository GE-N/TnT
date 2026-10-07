import {useEffect,useMemo,useState} from 'react';
import {readForms,editForm,appendForm,deleteForm,formCommands,type FormCommand,type FormStep,type FormField} from './yaml-forms.js';

type EditorProps={
  yaml:string;onChange:(yaml:string)=>void;disabled:boolean;
  deletionWarnings?:(index:number)=>string[];
  onDelete?:(yaml:string,index:number)=>(()=>void);
};
function ValueEditor({step,field,yaml,onChange,disabled}:{step:FormStep;field?:FormField;yaml:string;onChange:(yaml:string)=>void;disabled:boolean}){
  const value=field?.value??step.value??'';
  const [draft,setDraft]=useState({source:yaml,value,dirty:false});
  const [error,setError]=useState('');
  useEffect(()=>{setDraft(current=>current.dirty?current:{source:yaml,value,dirty:false});},[yaml,value]);
  const id=`form-step-${step.index}${field?'-'+field.name:''}`;
  const name=`step ${step.index+1}${field?' '+field.name:''}`;
  function apply(){
    try{const next=editForm(yaml,{source:draft.dirty?draft.source:yaml,index:step.index,field:field?.name,value:draft.value});onChange(next);setDraft({source:next,value:draft.value,dirty:false});setError('');}
    catch(error){setError(error instanceof Error?error.message:'Form edit failed.');}
  }
  return <div className="yaml-value">
    <label className={field?'':'sr-only'} htmlFor={id}>{field?field.name:`Step ${step.index+1} value`}</label>
    <input id={id} value={draft.value} disabled={disabled} onChange={event=>setDraft(current=>({...current,source:current.dirty?current.source:yaml,value:event.target.value,dirty:true}))} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();apply();}}}/>
    <button type="button" className="confirm" disabled={disabled} onClick={apply} aria-label={`Apply ${name}`}>Apply</button>
    {draft.dirty&&<button type="button" className="text-button" disabled={disabled} onClick={()=>{setDraft({source:yaml,value,dirty:false});setError('');}}>Reset {name} draft</button>}
    {error&&<p role="alert" className="notice error">{error}</p>}
  </div>;
}
function StepRow({step,yaml,onChange,disabled,expanded,onExpand,onDelete,onCode}:{step:FormStep;yaml:string;onChange:(yaml:string)=>void;disabled:boolean;expanded:boolean;onExpand:()=>void;onDelete:()=>void;onCode:()=>void}){
  const summary=step.fields?.map(field=>`${field.name}: ${field.value}`).join(' · ')??step.raw.trim();
  return <div className="yaml-step">
    <div className="yaml-step-row">
      <strong title={step.command}>{step.index+1}. {step.command}</strong>
      {step.editable?<ValueEditor step={step} yaml={yaml} onChange={onChange} disabled={disabled}/>:<span className="yaml-step-summary" title={summary}>{summary}</span>}
      {!step.editable&&<button type="button" className="text-button" aria-expanded={expanded} onClick={onExpand} aria-label={`Details step ${step.index+1}`}>Details</button>}
      <button type="button" className="text-button" disabled={disabled} onClick={onDelete} aria-label={`Delete step ${step.index+1}`}>Delete</button>
    </div>
    {expanded&&!step.editable&&<div className="yaml-step-details">
      {step.fields?step.fields.map(field=><ValueEditor key={field.name} step={step} field={field} yaml={yaml} onChange={onChange} disabled={disabled}/>):<><p className="field-hint">{step.reason}</p><pre>{step.raw}</pre><button className="text-button" type="button" onClick={onCode}>Edit YAML</button></>}
    </div>}
  </div>;
}
export function YamlEditor({yaml,onChange,disabled,deletionWarnings,onDelete}:EditorProps){
  const view=useMemo(()=>readForms(yaml),[yaml]);
  const [mode,setMode]=useState<'code'|'forms'>('code');
  const [expanded,setExpanded]=useState<number>();
  const [command,setCommand]=useState<FormCommand>('tapOn');
  const [value,setValue]=useState('');const [error,setError]=useState('');
  const [pending,setPending]=useState<{index:number;source:string;warnings:string[]}>();
  const [undo,setUndo]=useState<{before:string;after:string;restore?:()=>void}>();
  function append(){try{onChange(appendForm(yaml,command,value));setValue('');setError('');}catch(error){setError(error instanceof Error?error.message:'Form edit failed.');}}
  function remove(index:number){
    try{
      const next=deleteForm(yaml,index);
      const restore=onDelete?onDelete(next,index):undefined;
      if(!onDelete)onChange(next);
      setUndo({before:yaml,after:next,restore});setPending(undefined);setExpanded(undefined);setError('');
    }catch(error){setError(error instanceof Error?error.message:'Deletion failed.');setPending(undefined);}
  }
  function requestDeletion(index:number){
    const warnings=deletionWarnings?.(index)??[];
    if(warnings.length)setPending({index,source:yaml,warnings});else remove(index);
  }
  return <section aria-label="YAML form and code editor">
    <div className="label-row"><button className="confirm" type="button" aria-pressed={mode==='code'} onClick={()=>setMode('code')}>YAML code</button><button className="confirm" type="button" aria-pressed={mode==='forms'} onClick={()=>setMode('forms')}>Command forms</button></div>
    {view.error&&<div role="alert" className="notice error">{view.error} Your code is retained. Repair it in YAML code; form transformations are blocked.</div>}
    {undo&&<div role="status" className="yaml-undo">Step deleted. <button type="button" disabled={disabled||yaml!==undo.after} onClick={()=>{onChange(undo.before);undo.restore?.();setUndo(undefined);setError('');}}>Undo deletion</button>{yaml!==undo.after&&<span> Undo unavailable after further YAML edits.</span>}</div>}
    {mode==='code'?<><label htmlFor="scenario-yaml">Maestro YAML</label><textarea id="scenario-yaml" value={yaml} disabled={disabled} onChange={event=>onChange(event.target.value)} spellCheck={false} maxLength={100_000}/></>:<>
      <p className="field-hint">Edit values inline; expand Details for arguments. Enter or Apply saves a value. Complex YAML remains editable in code.</p>
      {view.steps.map(step=><StepRow key={step.index+':'+step.command} step={step} yaml={yaml} onChange={onChange} disabled={disabled} expanded={expanded===step.index} onExpand={()=>setExpanded(expanded===step.index?undefined:step.index)} onDelete={()=>requestDeletion(step.index)} onCode={()=>setMode('code')}/>)}
      <fieldset className="yaml-add" disabled={disabled||!!view.error||!view.canAppend}><legend>Add command</legend><label className="sr-only" htmlFor="form-command">Command</label><select id="form-command" value={command} onChange={event=>setCommand(event.target.value as FormCommand)}>{formCommands.map(command=><option key={command}>{command}</option>)}</select><label className="sr-only" htmlFor="form-value">New command value</label><input id="form-value" placeholder="Command value" value={value} onChange={event=>setValue(event.target.value)}/><button type="button" className="confirm" onClick={append}>Append command</button></fieldset>
      {!view.canAppend&&!view.error&&<p className="field-hint">This command-list style is code-only for additions.</p>}
    </>}
    {pending&&<div role="alertdialog" aria-label="Canvas deletion warning" className="notice"><p>Deleting step {pending.index+1} affects canvas references: {pending.warnings.join(', ')}. These references will need repair before running the affected path.</p><button type="button" disabled={disabled||yaml!==pending.source} onClick={()=>remove(pending.index)}>Delete anyway</button><button type="button" onClick={()=>setPending(undefined)}>Cancel deletion</button>{yaml!==pending.source&&<p>YAML changed. Cancel and select the step again.</p>}</div>}
    {error&&<p className="notice error" role="alert">{error}</p>}
  </section>;
}
