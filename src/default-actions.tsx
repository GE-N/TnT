import {checkpointCommands} from '../shared/checkpoints.js';
import {useEffect,useState} from 'react';
import type {Automation,FlowCall} from '../server/default-actions.js';
import type {CatalogEntry} from '../server/canvas.js';
type Props={value?:Automation;onChange:(value:Automation|undefined)=>void;files:string[];catalog:CatalogEntry[];disabled:boolean;onError:(error:string)=>void};
function Parameters({value,onChange,onError,label}:{value:Record<string,string>;onChange:(value:Record<string,string>)=>void;onError:(error:string)=>void;label:string}){
 const [draft,setDraft]=useState(JSON.stringify(value));
 function change(text:string){setDraft(text);try{const parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.values(parsed).some(value=>typeof value!=='string'))throw new Error();onChange(parsed);onError('');}catch{onError(label+' must be a JSON object of strings.');}}
 return <><label>{label}<textarea value={draft} onChange={event=>change(event.target.value)} spellCheck={false}/></label><p className="field-hint">Use placeholders such as {'${TOKEN}'} for confidential runtime inputs. Never enter secrets here.</p></>;
}
export function DefaultActions({value,onChange,files,catalog,disabled,onError}:Props){
 const [errors,setErrors]=useState<Record<string,string>>({});
 const [step,setStep]=useState('');const [timeout,setTimeout]=useState(1000);
 useEffect(()=>{onError(Object.values(errors).filter(Boolean).join(' '));},[errors,onError]);
 function error(id:string,message:string){setErrors(current=>({...current,[id]:message}));}
 function updateSetup(update:Partial<FlowCall>){if(value)onChange({...value,setup:{...value.setup,...update}});}
 const steps=catalog.filter(entry=>entry.kind==='step'&&checkpointCommands.some(command=>command===entry.command));
 return <fieldset className="default-actions" disabled={disabled}>
  <legend>Independent setup and default actions</legend>
  <label className="checkbox-label"><input type="checkbox" checked={!!value} onChange={event=>{setErrors({});onChange(event.target.checked?{setup:{file:files[0]??'',parameters:{}},actions:[],checkpoints:[]}:undefined);}}/>Enable independent setup</label>
  {value&&<>
   <p className="field-hint">Every run relaunches the app, keeps app data, then runs setup. Checks happen only before selected steps. First matching enabled action wins; it can run again at a later checkpoint. Action failure stops the run. Disable actions when testing their matching screen.</p>
   <label>Setup flow<select value={value.setup.file} onChange={event=>updateSetup({file:event.target.value})}><option value="">Choose a declared reusable flow</option>{files.map(file=><option key={file}>{file}</option>)}</select></label>
   <Parameters value={value.setup.parameters} onChange={parameters=>updateSetup({parameters})} onError={message=>error('setup',message)} label="Setup parameters"/>
   <h4>Default actions · priority order</h4>
   {value.actions.map((action,index)=><details key={action.id} className="default-action"><summary>{index+1}. {action.name} · {action.enabled?'enabled':'disabled'}</summary>
    <label>Name<input value={action.name} onChange={event=>onChange({...value,actions:value.actions.map(item=>item.id===action.id?{...item,name:event.target.value}:item)})}/></label>
    <label className="checkbox-label"><input type="checkbox" checked={action.enabled} onChange={event=>onChange({...value,actions:value.actions.map(item=>item.id===action.id?{...item,enabled:event.target.checked}:item)})}/>Enable {action.name}</label>
    <label>Match by<select value={action.condition.id!==undefined?'id':'text'} onChange={event=>onChange({...value,actions:value.actions.map(item=>item.id===action.id?{...item,condition:{[event.target.value]:Object.values(action.condition)[0]}}:item)})}><option value="text">Visible text</option><option value="id">Accessibility ID</option></select></label>
    <label>Screen condition<input value={Object.values(action.condition)[0]} onChange={event=>onChange({...value,actions:value.actions.map(item=>item.id===action.id?{...item,condition:{[Object.keys(action.condition)[0]]:event.target.value}}:item)})}/></label>
    <label>Action flow<select value={action.file} onChange={event=>onChange({...value,actions:value.actions.map(item=>item.id===action.id?{...item,file:event.target.value}:item)})}><option value="">Choose a declared reusable flow</option>{files.map(file=><option key={file}>{file}</option>)}</select></label>
    <Parameters value={action.parameters} label={action.name+' parameters'} onError={message=>error(action.id,message)} onChange={parameters=>onChange({...value,actions:value.actions.map(item=>item.id===action.id?{...item,parameters}:item)})}/>
    <button type="button" className="text-button" disabled={index===0} onClick={()=>{const actions=[...value.actions];[actions[index-1],actions[index]]=[actions[index],actions[index-1]];onChange({...value,actions});}}>Move earlier</button>
    <button type="button" className="text-button" onClick={()=>{error(action.id,'');onChange({...value,actions:value.actions.filter(item=>item.id!==action.id)});}}>Remove action</button>
   </details>)}
   <button type="button" className="confirm" disabled={value.actions.length>=20} onClick={()=>onChange({...value,actions:[...value.actions,{id:'action-'+crypto.randomUUID().slice(0,8),name:'New default action',condition:{text:''},file:files[0]??'',parameters:{},enabled:true}]})}>Add default action</button>
   <h4>Explicit checkpoints</h4>
   {value.checkpoints.map(checkpoint=>{
    const current=steps.find(entry=>entry.index===checkpoint.beforeStep&&entry.fingerprint===checkpoint.fingerprint);
    return <div key={checkpoint.beforeStep} className="checkpoint"><label>Checkpoint before step {checkpoint.beforeStep+1}<select value={current?String(checkpoint.beforeStep):''} onChange={event=>{const selected=steps.find(entry=>entry.index===Number(event.target.value));if(selected)onChange({...value,checkpoints:value.checkpoints.map(item=>item===checkpoint?{...item,beforeStep:selected.index!,fingerprint:selected.fingerprint}:item)});}}><option value="">Relink stale checkpoint</option>{steps.map(entry=><option key={entry.index} value={entry.index}>{entry.label}</option>)}</select></label>{!current&&<p role="alert" className="notice error">Checkpoint needs repair before saving or running.</p>}<span>{checkpoint.timeoutMs} ms visibility window</span><button type="button" className="text-button" onClick={()=>onChange({...value,checkpoints:value.checkpoints.filter(item=>item!==checkpoint)})}>Remove checkpoint</button></div>;
   })}
   <label>Checkpoint step<select value={step} onChange={event=>setStep(event.target.value)}><option value="">Choose a navigation/assertion step</option>{steps.filter(entry=>!value.checkpoints.some(checkpoint=>checkpoint.beforeStep===entry.index)).map(entry=><option key={entry.index} value={entry.index}>{entry.label}</option>)}</select></label>
   <label>Visibility window (ms, 0–5000)<input type="number" min="0" max="5000" value={timeout} onChange={event=>setTimeout(Number(event.target.value))}/></label>
   <p className="field-hint">0 checks once. A polling window allows delayed screens; an in-progress Maestro visibility query may finish after the window.</p>
   <button type="button" className="confirm" disabled={!step||value.checkpoints.length>=100} onClick={()=>{const entry=steps.find(entry=>entry.index===Number(step));if(entry){onChange({...value,checkpoints:[...value.checkpoints,{beforeStep:entry.index!,fingerprint:entry.fingerprint,timeoutMs:timeout}]});setStep('');}}}>Add checkpoint</button>
   {Object.values(errors).some(Boolean)&&<p role="alert" className="notice error">{Object.values(errors).filter(Boolean).join(' ')}</p>}
  </>}
 </fieldset>;
}
