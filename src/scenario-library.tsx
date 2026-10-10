import {useState,useEffect} from 'react';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';
import type {CatalogEntry,CanvasGraph} from '../server/canvas.js';
import type {Automation} from '../server/default-actions.js';
import type {MockPlan} from '../server/mockoon.js';
const emptyInputs:Record<string,string>={};
type Props={items:ScenarioDefinition[];onChange:(items:ScenarioDefinition[])=>void;selected:string;onSelect:(id:string)=>void;catalog:CatalogEntry[];files:string[];canvas?:CanvasGraph;automation?:Automation;mock?:MockPlan;disabled:boolean;onError:(error:string)=>void};
function JsonField({id,label,value,onApply,onError}:{id:string;label:string;value:unknown;onApply:(value:any)=>void;onError:(error:string)=>void}){
 const [draft,setDraft]=useState(JSON.stringify(value,null,2));const [error,setError]=useState('');
 useEffect(()=>{setDraft(JSON.stringify(value,null,2));},[value]);
 return <div><label htmlFor={id}>{label}</label><textarea id={id} value={draft} spellCheck={false} onChange={event=>{setDraft(event.target.value);setError('Apply this draft before saving or switching scenarios.');onError('Apply '+label+' before saving or switching scenarios.');}}/><button type="button" className="confirm" onClick={()=>{try{const parsed=JSON.parse(draft);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Use a JSON object.');onApply(parsed);setError('');onError('');}catch(error){const detail=error instanceof Error?error.message:'Invalid JSON';setError(detail);onError(detail);}}}>Apply {label.toLowerCase()}</button>{error&&<p role="alert">{error}</p>}</div>;
}
export function ScenarioLibrary({items,onChange,selected,onSelect,catalog,files,canvas,automation,mock,disabled,onError}:Props){
 const [draftErrors,setDraftErrors]=useState<Record<string,string>>({});
 const pendingDraft=Object.values(draftErrors).some(Boolean);
 useEffect(()=>{onError(Object.values(draftErrors).filter(Boolean).join(' '));},[draftErrors,onError]);
 function fieldError(id:string,message:string){setDraftErrors(current=>({...current,[id]:message}));}
 const current=items.find(item=>item.id===selected);const steps=catalog.filter(ref=>ref.kind==='step');
 function update(change:Partial<ScenarioDefinition>){if(current)onChange(items.map(item=>item.id===current.id?{...item,...change}:item));}
 function choose(id:string){setDraftErrors({});onSelect(id);}
 const responses=mock?.environment.routes.find(route=>route.uuid===mock.routeId)?.responses??[];
 return <fieldset className="scenario-library" disabled={disabled}><legend>Scenarios over shared screens and flows</legend>
  <p className="field-hint">Each scenario explicitly selects steps, path, inputs, setup, handlers and a mock response. Every run starts with its declared setup; starting midway through a flow is unavailable.</p>
  <div className="scenario-actions">{items.map(item=><button type="button" className={selected===item.id?'primary':'confirm'} disabled={pendingDraft} aria-pressed={selected===item.id} key={item.id} onClick={()=>choose(item.id)}>{item.name}</button>)}<button type="button" className="confirm" disabled={pendingDraft||!steps.length||!files.length||items.length>=20} onClick={()=>{const id='scenario-'+crypto.randomUUID().slice(0,8);onChange([...items,{id,name:'Scenario '+(items.length+1),steps:steps.map(({kind,file,index,fingerprint})=>({kind,file,index,fingerprint})),inputs:{},parameters:{},setup:automation?.setup??{file:files[0],parameters:{}},enabledHandlerIds:automation?.actions.filter(action=>action.enabled).map(action=>action.id)??[],mockResponseId:mock?.responseId}]);choose(id);}}>Add scenario</button></div>
  {!items.length&&<p className="field-hint">Add a reusable setup flow first, then create scenarios. Without named scenarios, the existing single-flow runner remains available.</p>}
  {current&&<div key={current.id}>
   <label htmlFor="definition-name">Selected scenario name</label><input id="definition-name" value={current.name} maxLength={120} onChange={event=>update({name:event.target.value})}/>
   <label>Selected path<select aria-label="Scenario path" value={current.pathId??''} onChange={event=>update({pathId:event.target.value||undefined})}><option value="">Choose an explicit path</option>{canvas?.paths.map(path=><option key={path.id} value={path.id}>{path.name}</option>)}</select></label>
   <details><summary>Selected authored steps · {current.steps.length}</summary><p className="field-hint">Steps execute in authored order. Relinking explicitly accepts current YAML identities; inspect changes before doing so.</p>
    {steps.map(ref=><label className="checkbox-label" key={ref.index}><input type="checkbox" checked={current.steps.some(step=>step.index===ref.index)} onChange={event=>{const refs=current.steps.filter(step=>step.index!==ref.index);if(event.target.checked)refs.push({kind:ref.kind,file:ref.file,index:ref.index,fingerprint:ref.fingerprint});update({steps:refs.sort((a,b)=>a.index!-b.index!)});}}/>{ref.label}{current.steps.some(step=>step.index===ref.index&&step.fingerprint!==ref.fingerprint)?' · stale, relink required':''}</label>)}
    {current.steps.filter(step=>!steps.some(ref=>ref.index===step.index)).map(step=><p role="alert" key={step.index}>Missing selected step {step.index!+1}. Remove or repair this selection.</p>)}
    <button type="button" className="confirm" onClick={()=>update({steps:steps.filter(ref=>current.steps.some(step=>step.index===ref.index)).map(({kind,file,index,fingerprint})=>({kind,file,index,fingerprint}))})}>Relink selected steps</button>
   </details>
   <label>Scenario setup flow<select aria-label="Scenario setup flow" value={current.setup?.file??''} onChange={event=>update({setup:{parameters:current.setup?.parameters??emptyInputs,file:event.target.value}})}>{files.map(file=><option key={file}>{file}</option>)}</select></label>
   <JsonField id="scenario-setup-inputs" label="Setup parameters" value={current.setup?.parameters??emptyInputs} onApply={parameters=>update({setup:current.setup?{...current.setup,parameters}:undefined})} onError={message=>fieldError('setup',message)}/>
   <JsonField id="scenario-public-inputs" label="Scenario inputs" value={current.inputs} onApply={inputs=>update({inputs})} onError={message=>fieldError('inputs',message)}/>
   <p className="field-hint">Saved test data only. Reference inputs as {'${NAME}'} in reusable YAML. Supply secrets using confidential runtime inputs below.</p>
   <details><summary>Input requirements</summary><JsonField id="scenario-input-rules" label="Input requirements" value={current.parameters} onApply={parameters=>update({parameters})} onError={message=>fieldError('requirements',message)}/><p className="field-hint">Example: {'{"EXPECTED_PAGE":{"type":"text","required":true}}'}. Types: text, number, boolean.</p></details>
   <details><summary>Enabled default actions · {current.enabledHandlerIds.length}</summary>{automation?.actions.map(action=><label className="checkbox-label" key={action.id}><input type="checkbox" checked={current.enabledHandlerIds.includes(action.id)} onChange={event=>update({enabledHandlerIds:event.target.checked?[...current.enabledHandlerIds,action.id]:current.enabledHandlerIds.filter(id=>id!==action.id)})}/>{action.name}</label>)}</details>
   <label>Scenario mock response<select aria-label="Scenario mock response" value={current.mockResponseId??''} onChange={event=>update({mockResponseId:event.target.value||undefined})}><option value="">No mock</option>{responses.map(response=><option key={response.uuid} value={response.uuid}>{response.label||response.uuid} · HTTP {response.statusCode}</option>)}</select></label>
   <button type="button" className="text-button" onClick={()=>{onChange(items.filter(item=>item.id!==current.id));choose('');}}>Remove selected scenario</button>
  </div>}
 </fieldset>;
}
