import {RecoveredFields,useWorkspaceDraft} from './workspace-drafts.js';
import {createContext,useCallback,useContext,useEffect,useMemo,useState,type ReactNode} from 'react';
import {readForms,editForm,appendForm,deleteForm,formCommands,type FormCommand,type FormStep,type FormField} from './yaml-forms.js';

type YamlFormDraft={source:string;value:string;dirty:boolean;index?:number;field?:string};
type YamlDraftStore={command:string;setCommand:(value:string)=>void;forms:Record<string,YamlFormDraft>;setForm:(key:string,draft:YamlFormDraft)=>void;retired:ReadonlySet<string>};
const YamlDraftContext=createContext<YamlDraftStore|null>(null);
const formDraftKey=(index:number,field?:string)=>`yaml-form:${index}${field?':'+encodeURIComponent(field):''}`;
function formKeyParts(key:string){
  const match=/^yaml-form:(\d+)(?::(.*))?$/.exec(key);
  if(!match)return;
  return {index:Number(match[1]),field:match[2]===undefined?undefined:decodeURIComponent(match[2])};
}
function stepStructure(step:FormStep){return step.command+'\0'+(step.fields?.map(field=>field.name).join('\0')??(step.editable?'*':'-'));}
function stepIdentity(step:FormStep){return stepStructure(step)+'\0'+(step.value??'')+'\0'+(step.fields?.map(field=>field.name+'='+field.value).join('\0')??'');}
function fieldOnStep(step:FormStep,field?:string){return field?!!step.fields?.some(item=>item.name===field):!!step.editable;}
function fieldStillPresent(view:ReturnType<typeof readForms>,key:string){
  const parts=formKeyParts(key);const step=parts&&view.steps[parts.index];
  return !!step&&fieldOnStep(step,parts?.field);
}
function uniqueStep(steps:FormStep[],identity:string){
  const hits=steps.filter(step=>stepIdentity(step)===identity);
  return hits.length===1?hits[0]:undefined;
}
/** Keep a pending value on the same step when YAML changes, and drop it when that step or field is gone. Identical steps are not guessed apart. */
function locateFormDraft(key:string,draft:YamlFormDraft,current:ReturnType<typeof readForms>){
  const parts=formKeyParts(key);
  if(!parts)return;
  const originIndex=draft.index??parts.index;
  const originField=draft.field??parts.field;
  if(!draft.source)return fieldStillPresent(current,key)?key:undefined;
  const origin=readForms(draft.source);
  if(origin.error)return;
  const originStep=origin.steps[originIndex];
  if(!originStep||!fieldOnStep(originStep,originField))return;
  const identity=stepIdentity(originStep);
  const exact=uniqueStep(current.steps,identity);
  const originUnique=uniqueStep(origin.steps,identity);
  if(exact&&originUnique&&fieldOnStep(exact,originField))return formDraftKey(exact.index,originField);
  const occupant=current.steps[originIndex];
  const occupantOrigin=occupant&&uniqueStep(origin.steps,stepIdentity(occupant));
  const shiftedIn=!!occupantOrigin&&occupantOrigin.index!==originStep.index;
  if(!shiftedIn&&originUnique&&occupant&&stepStructure(occupant)===stepStructure(originStep)&&fieldOnStep(occupant,originField))return formDraftKey(originIndex,originField);
}
function reconcileFormDrafts(forms:Record<string,YamlFormDraft>,yaml:string,retired:ReadonlySet<string>){
  const current=readForms(yaml);
  if(current.error)return {forms,retired};
  const nextRetired=new Set(retired);
  const claims=new Map<string,{from:string;draft:YamlFormDraft}>();
  const blocked=new Set<string>();
  const dropped=new Set<string>();
  for(const [key,draft] of Object.entries(forms)){
    if(!draft.dirty)continue;
    const target=locateFormDraft(key,draft,current);
    const previous=target?claims.get(target):undefined;
    if(!target||blocked.has(target)||previous){
      dropped.add(key);
      if(previous)dropped.add(previous.from);
      if(target){blocked.add(target);claims.delete(target);nextRetired.add(target);}
      continue;
    }
    claims.set(target,{from:key,draft});
  }
  const next:Record<string,YamlFormDraft>={};
  for(const [target,claim] of claims){
    if(blocked.has(target))continue;
    next[target]=claim.draft;
    nextRetired.delete(target);
    if(claim.from!==target)nextRetired.add(claim.from);
  }
  for(const key of dropped)nextRetired.add(key);
  for(const [key,draft] of Object.entries(forms)){
    if(draft.dirty||next[key]||nextRetired.has(key))continue;
    if(fieldStillPresent(current,key))next[key]=draft;
    else nextRetired.add(key);
  }
  return {forms:next,retired:nextRetired};
}
function seedForms(recovered:Record<string,string>){
  const forms:Record<string,YamlFormDraft>={};
  for(const [key,value] of Object.entries(recovered)){
    const parts=formKeyParts(key);
    if(parts)forms[key]={source:'',value,dirty:true,index:parts.index,field:parts.field};
  }
  return forms;
}
function recoveredStamp(recovered:Record<string,string>){
  return JSON.stringify(Object.entries(recovered).filter(([key])=>key==='yaml-command'||key.startsWith('yaml-form:')).sort(([left],[right])=>left<right?-1:left>right?1:0));
}
function ReportedDraft({fieldKey,value}:{fieldKey:string;value:string}){
  useWorkspaceDraft(true,fieldKey,value);
  return null;
}
/** One pending command and one pending value per step field, shared by every YAML editor. */
export function YamlDraftProvider({children,resetToken=0,yaml}:{children:ReactNode;resetToken?:number;yaml?:string}){
  const recovered=useContext(RecoveredFields);
  const stamp=recoveredStamp(recovered);
  const [generation,setGeneration]=useState(stamp);
  const [token,setToken]=useState(resetToken);
  const [command,setCommand]=useState(recovered['yaml-command']??'');
  const [forms,setForms]=useState(()=>seedForms(recovered));
  const [retired,setRetired]=useState<ReadonlySet<string>>(()=>new Set());
  const [boundYaml,setBoundYaml]=useState(yaml);
  if(token!==resetToken||generation!==stamp){setToken(resetToken);setGeneration(stamp);setCommand(recovered['yaml-command']??'');setForms(seedForms(recovered));setRetired(new Set());setBoundYaml(yaml);}
  else if(yaml!==undefined&&yaml!==boundYaml){const result=reconcileFormDrafts(forms,yaml,retired);setBoundYaml(yaml);setForms(result.forms);setRetired(result.retired);}
  const setForm=useCallback((key:string,draft:YamlFormDraft)=>{
    setForms(current=>{const previous=current[key];if(previous&&previous.source===draft.source&&previous.value===draft.value&&previous.dirty===draft.dirty)return current;return {...current,[key]:draft};});
    setRetired(current=>{if(!current.has(key))return current;const next=new Set(current);next.delete(key);return next;});
  },[]);
  const store=useMemo(()=>({command,setCommand,forms,setForm,retired}),[command,forms,setForm,retired]);
  useWorkspaceDraft(command.length>0,'yaml-command',command);
  return <YamlDraftContext.Provider value={store}>{children}{Object.entries(forms).map(([key,draft])=>draft.dirty?<ReportedDraft key={key} fieldKey={key} value={draft.value}/>:null)}</YamlDraftContext.Provider>;
}
function useYamlDrafts(){
  const store=useContext(YamlDraftContext);
  if(!store)throw new Error('YAML drafts are unavailable.');
  return store;
}

type EditorProps={
  yaml:string;onChange:(yaml:string)=>void;disabled:boolean;
  /** Defaults to the advanced-panel id so an on-demand card can host a second editor. */
  inputId?:string;
  deletionWarnings?:(index:number)=>string[];
  onDelete?:(yaml:string,index:number)=>(()=>void);
};
function visibleDraft(stored:YamlFormDraft|undefined,committed:string,yaml:string,recoveredValue:string|undefined,retired:boolean):YamlFormDraft{
  if(stored?.dirty&&stored.value!==committed)return {source:stored.source||yaml,value:stored.value,dirty:true};
  if(!retired&&!stored&&recoveredValue!==undefined&&recoveredValue!==committed)return {source:yaml,value:recoveredValue,dirty:true};
  return {source:yaml,value:committed,dirty:false};
}
function DraftBinding({fieldKey,committed,yaml}:{fieldKey:string;committed:string;yaml:string}){
  const store=useYamlDrafts();const recovered=useContext(RecoveredFields);const stored=store.forms[fieldKey];const retired=store.retired.has(fieldKey);
  useEffect(()=>{
    if(stored?.dirty&&stored.value===committed){store.setForm(fieldKey,{source:yaml,value:committed,dirty:false});return;}
    if(stored?.dirty&&stored.source===''){const parts=formKeyParts(fieldKey);store.setForm(fieldKey,{...stored,source:yaml,index:stored.index??parts?.index,field:stored.field??parts?.field});return;}
    if(!retired&&!stored&&recovered[fieldKey]!==undefined&&recovered[fieldKey]!==committed){const parts=formKeyParts(fieldKey);store.setForm(fieldKey,{source:yaml,value:recovered[fieldKey],dirty:true,index:parts?.index,field:parts?.field});}
  },[store,stored,fieldKey,committed,yaml,recovered,retired]);
  return null;
}
function ValueEditor({step,field,yaml,onChange,disabled,idPrefix}:{step:FormStep;field?:FormField;yaml:string;onChange:(yaml:string)=>void;disabled:boolean;idPrefix:string}){
  const committed=field?.value??step.value??'';
  const store=useYamlDrafts();const recovered=useContext(RecoveredFields);
  const fieldKey=formDraftKey(step.index,field?.name);
  const draft=visibleDraft(store.forms[fieldKey],committed,yaml,recovered[fieldKey],store.retired.has(fieldKey));
  const [error,setError]=useState('');
  const id=`${idPrefix}form-step-${step.index}${field?'-'+field.name:''}`;
  const name=`step ${step.index+1}${field?' '+field.name:''}`;
  function apply(){
    try{const next=editForm(yaml,{source:draft.dirty?draft.source:yaml,index:step.index,field:field?.name,value:draft.value});onChange(next);store.setForm(fieldKey,{source:next,value:draft.value,dirty:false});setError('');}
    catch(error){setError(error instanceof Error?error.message:'Form edit failed.');}
  }
  return <div className="yaml-value">
    <label className={field?'':'sr-only'} htmlFor={id}>{field?field.name:`Step ${step.index+1} value`}</label>
    <input id={id} value={draft.value} disabled={disabled} onChange={event=>store.setForm(fieldKey,{source:draft.dirty?draft.source:yaml,value:event.target.value,dirty:true,index:step.index,field:field?.name})} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();apply();}}}/>
    <button type="button" className="confirm" disabled={disabled} onClick={apply} aria-label={`Apply ${name}`}>Apply</button>
    {draft.dirty&&<button type="button" className="text-button" disabled={disabled} onClick={()=>{store.setForm(fieldKey,{source:yaml,value:committed,dirty:false});setError('');}}>Reset {name} draft</button>}
    {error&&<p role="alert" className="notice error">{error}</p>}
  </div>;
}
function StepRow({step,yaml,onChange,disabled,expanded,onExpand,onDelete,onCode,idPrefix}:{step:FormStep;yaml:string;onChange:(yaml:string)=>void;disabled:boolean;expanded:boolean;onExpand:()=>void;onDelete:()=>void;onCode:()=>void;idPrefix:string}){
  const summary=step.fields?.map(field=>`${field.name}: ${field.value}`).join(' · ')??step.raw.trim();
  return <div className="yaml-step">
    {step.editable&&<DraftBinding fieldKey={formDraftKey(step.index)} committed={step.value??''} yaml={yaml}/>}
    {step.fields?.map(field=><DraftBinding key={field.name} fieldKey={formDraftKey(step.index,field.name)} committed={field.value} yaml={yaml}/>)}
    <div className="yaml-step-row">
      <strong title={step.command}>{step.index+1}. {step.command}</strong>
      {step.editable?<ValueEditor step={step} yaml={yaml} onChange={onChange} disabled={disabled} idPrefix={idPrefix}/>:<span className="yaml-step-summary" title={summary}>{summary}</span>}
      {!step.editable&&<button type="button" className="text-button" aria-expanded={expanded} onClick={onExpand} aria-label={`Details step ${step.index+1}`}>Details</button>}
      <button type="button" className="text-button" disabled={disabled} onClick={onDelete} aria-label={`Delete step ${step.index+1}`}>Delete</button>
    </div>
    {expanded&&!step.editable&&<div className="yaml-step-details">
      {step.fields?step.fields.map(field=><ValueEditor key={field.name} step={step} field={field} yaml={yaml} onChange={onChange} disabled={disabled} idPrefix={idPrefix}/>):<><p className="field-hint">{step.reason}</p><pre>{step.raw}</pre><button className="text-button" type="button" onClick={onCode}>Edit YAML</button></>}
    </div>}
  </div>;
}
function YamlEditorBody({yaml,onChange,disabled,deletionWarnings,onDelete,inputId='scenario-yaml'}:EditorProps){
  const view=useMemo(()=>readForms(yaml),[yaml]);
  const idPrefix=inputId==='scenario-yaml'?'':inputId+'-';
  const commandId=idPrefix+'form-command';
  const valueId=idPrefix+'form-value';
  const [mode,setMode]=useState<'code'|'forms'>('code');
  const [expanded,setExpanded]=useState<number>();
  const [command,setCommand]=useState<FormCommand>('tapOn');
  const drafts=useYamlDrafts();
  const value=drafts.command;
  const [error,setError]=useState('');
  const [pending,setPending]=useState<{index:number;source:string;warnings:string[]}>();
  const [undo,setUndo]=useState<{before:string;after:string;restore?:()=>void}>();
  function append(){try{onChange(appendForm(yaml,command,value));drafts.setCommand('');setError('');}catch(error){setError(error instanceof Error?error.message:'Form edit failed.');}}
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
    <div hidden={mode!=='code'}><label htmlFor={inputId}>Maestro YAML</label><textarea id={inputId} value={yaml} disabled={disabled} onChange={event=>onChange(event.target.value)} spellCheck={false} maxLength={100_000}/></div><div hidden={mode!=='forms'}>
      <p className="field-hint">Edit values inline; expand Details for arguments. Enter or Apply saves a value. Complex YAML remains editable in code.</p>
      {view.steps.map(step=><StepRow key={step.index+':'+step.command} step={step} yaml={yaml} onChange={onChange} disabled={disabled} expanded={expanded===step.index} onExpand={()=>setExpanded(expanded===step.index?undefined:step.index)} onDelete={()=>requestDeletion(step.index)} onCode={()=>setMode('code')} idPrefix={idPrefix}/>)}
      <fieldset className="yaml-add" disabled={disabled||!!view.error||!view.canAppend}><legend>Add command</legend><label className="sr-only" htmlFor={commandId}>Command</label><select id={commandId} value={command} onChange={event=>setCommand(event.target.value as FormCommand)}>{formCommands.map(command=><option key={command}>{command}</option>)}</select><label className="sr-only" htmlFor={valueId}>New command value</label><input id={valueId} placeholder="Command value" value={value} onChange={event=>drafts.setCommand(event.target.value)}/><button type="button" className="confirm" onClick={append}>Append command</button></fieldset>
      {!view.canAppend&&!view.error&&<p className="field-hint">This command-list style is code-only for additions.</p>}
    </div>
    {pending&&<div role="alertdialog" aria-label="Step reference warning" className="notice"><p>Deleting step {pending.index+1} affects references: {pending.warnings.join(', ')}. These references will need repair before running the affected path.</p><button type="button" disabled={disabled||yaml!==pending.source} onClick={()=>remove(pending.index)}>Delete anyway</button><button type="button" onClick={()=>setPending(undefined)}>Cancel deletion</button>{yaml!==pending.source&&<p>YAML changed. Cancel and select the step again.</p>}</div>}
    {error&&<p className="notice error" role="alert">{error}</p>}
  </section>;
}
export function YamlEditor(props:EditorProps){
  const shared=useContext(YamlDraftContext);
  if(shared)return <YamlEditorBody {...props}/>;
  return <YamlDraftProvider yaml={props.yaml}><YamlEditorBody {...props}/></YamlDraftProvider>;
}
