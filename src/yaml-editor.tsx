import {useMemo,useState} from 'react';
import {readForms,editForm,appendForm,formCommands,type FormCommand,type FormStep} from './yaml-forms.js';

function StepForm({step,yaml,onChange,disabled}:{step:FormStep;yaml:string;onChange:(yaml:string)=>void;disabled:boolean}){
  const [draft,setDraft]=useState({source:yaml,value:step.value??'',dirty:false});
  const [error,setError]=useState('');
  function apply(){try{onChange(editForm(yaml,{source:draft.dirty?draft.source:yaml,index:step.index,value:draft.value}));setError('');}catch(error){setError(error instanceof Error?error.message:'Form edit failed.');}}
  return <div className="yaml-step"><strong>Step {step.index+1} · {step.command}</strong>{step.editable?<>
    <label htmlFor={'form-step-'+step.index}>Step {step.index+1} value</label><input id={'form-step-'+step.index} value={draft.value} disabled={disabled} onChange={event=>setDraft(current=>({...current,source:current.dirty?current.source:yaml,value:event.target.value,dirty:true}))}/>
    <button type="button" className="confirm" disabled={disabled} onClick={apply}>Apply step {step.index+1}</button>
    <button type="button" className="text-button" disabled={disabled} onClick={()=>{setDraft({source:yaml,value:step.value??'',dirty:false});setError('');}}>Reset step {step.index+1} draft</button>
    {error&&<p role="alert" className="notice error">{error}</p>}
  </>:<><p className="field-hint">{step.reason} Its source is preserved by edits to other steps.</p><pre>{step.raw}</pre></>}</div>;
}
export function YamlEditor({yaml,onChange,disabled}:{yaml:string;onChange:(yaml:string)=>void;disabled:boolean}){
  const view=useMemo(()=>readForms(yaml),[yaml]);
  const [mode,setMode]=useState<'code'|'forms'>('code');
  const [command,setCommand]=useState<FormCommand>('tapOn');const [value,setValue]=useState('');const [error,setError]=useState('');
  function append(){try{onChange(appendForm(yaml,command,value));setValue('');setError('');}catch(error){setError(error instanceof Error?error.message:'Form edit failed.');}}
  return <section aria-label="YAML form and code editor">
    <div className="label-row"><button className="confirm" type="button" aria-pressed={mode==='code'} onClick={()=>setMode('code')}>YAML code</button><button className="confirm" type="button" aria-pressed={mode==='forms'} onClick={()=>setMode('forms')}>Command forms</button></div>
    {view.error&&<div role="alert" className="notice error">{view.error} Your code is retained. Repair it in YAML code; form transformations are blocked.</div>}
    {mode==='code'?<><label htmlFor="scenario-yaml">Maestro YAML</label><textarea id="scenario-yaml" value={yaml} disabled={disabled} onChange={event=>onChange(event.target.value)} spellCheck={false} maxLength={100_000}/></>:<>
      <p className="field-hint">Forms edit the same YAML. Apply replaces only the selected scalar; unsupported content remains code-editable. Canvas associations may need explicit relinking after an edit.</p>
      {view.steps.map(step=><StepForm key={step.index+':'+step.raw} step={step} yaml={yaml} onChange={onChange} disabled={disabled}/>)}
      <fieldset disabled={disabled||!!view.error||!view.canAppend}><legend>Add command</legend><label htmlFor="form-command">Command</label><select id="form-command" value={command} onChange={event=>setCommand(event.target.value as FormCommand)}>{formCommands.map(command=><option key={command}>{command}</option>)}</select><label htmlFor="form-value">New command value</label><input id="form-value" value={value} onChange={event=>setValue(event.target.value)}/><button type="button" className="confirm" onClick={append}>Append command</button></fieldset>
      {!view.canAppend&&!view.error&&<p className="field-hint">This command-list style is code-only for additions.</p>}
      {error&&<p className="notice error" role="alert">{error}</p>}
    </>}
  </section>;
}
