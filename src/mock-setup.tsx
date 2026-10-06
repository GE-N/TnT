import { useEffect, useState } from 'react';
import type { MockPlan } from '../server/mockoon.js';
import type { Environment } from '@mockoon/commons';

export function MockSetup({disabled,onChange,initialPlan}: {disabled:boolean;initialPlan?:MockPlan;onChange:(plan:MockPlan|undefined,error:string)=>void}) {
  const [enabled,setEnabled]=useState(Boolean(initialPlan));
  const [environment,setEnvironment]=useState<Environment|undefined>(initialPlan?.environment);
  const [routeId,setRouteId]=useState(initialPlan?.routeId??'');
  const [responseId,setResponseId]=useState(initialPlan?.responseId??'');
  const [port,setPort]=useState(String(initialPlan?.port??4320));
  const [backendUrl,setBackendUrl]=useState(initialPlan?.backendUrl??'');
  const [fromScreen,setFromScreen]=useState(initialPlan?.fromScreen??'');
  const [toScreen,setToScreen]=useState(initialPlan?.toScreen??'');
  const [failureSemantics,setFailureSemantics]=useState(initialPlan?.failureSemantics??'');
  const [passthrough,setPassthrough]=useState<string[]>(initialPlan?.passthroughRouteIds??[]);
  const [importError,setImportError]=useState('');
  const route=environment?.routes.find(route=>route.uuid===routeId);
  const response=route?.responses.find(response=>response.uuid===responseId);
  useEffect(()=>{
    if (!enabled) {onChange(undefined,'');return;}
    if (!environment || !route || !response || !backendUrl || !fromScreen || !toScreen || !failureSemantics) {onChange(undefined,'Complete the enabled mock setup before saving or running.');return;}
    onChange({environment,port:Number(port),routeId,responseId,backendUrl,passthroughRouteIds:passthrough,fromScreen,toScreen,failureSemantics},'');
  },[enabled,environment,port,routeId,responseId,backendUrl,passthrough,fromScreen,toScreen,failureSemantics,onChange]);
  async function load(file?:File) {
    if (!file) return;
    setImportError('');
    try {
      if(file.size>500_000) throw new Error('Environment JSON must be at most 500 KB.');
      const value=JSON.parse(await file.text());
      if (!Array.isArray(value.routes) || !value.routes.every((route:any)=>Array.isArray(route.responses))) throw new Error('Choose an exported Mockoon environment JSON.');
      setEnvironment(value);setRouteId('');setResponseId('');setPassthrough([]);setBackendUrl(value.proxyHost||'');
    } catch(error) {setImportError(error instanceof Error ? error.message:'Import failed');setEnvironment(undefined);}
  }
  return <fieldset disabled={disabled} className="mock-setup"><legend>API response scenario</legend>
    <label><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/> Use an isolated Mockoon copy for this scenario</label>
    {enabled && <>
      <p className="field-hint">Import your existing environment. The original file/server stays untouched. Route the app to the dedicated localhost port before running. The selected response applies to every matching request for this run.</p>
      <label htmlFor="mock-file">Existing Mockoon environment JSON</label><input id="mock-file" type="file" accept=".json,application/json" onChange={event=>void load(event.target.files?.[0])}/>
      {environment && <p className="field-hint">Imported: {environment.name}</p>}
      <label htmlFor="mock-port">Dedicated mock port</label><input id="mock-port" type="number" min="1024" max="65535" value={port} onChange={event=>setPort(event.target.value)}/>
      <label htmlFor="mock-backend">Real test backend fallback URL</label><input id="mock-backend" value={backendUrl} onChange={event=>setBackendUrl(event.target.value)} placeholder="https://your-test-backend.example"/>
      <label htmlFor="mock-route">API route</label><select id="mock-route" value={routeId} onChange={event=>{setRouteId(event.target.value);setResponseId('');setPassthrough(ids=>ids.filter(id=>id!==event.target.value));}}><option value="">Select the proof endpoint</option>{environment?.routes.filter(route=>route.type==='http').map(route=><option key={route.uuid} value={route.uuid}>{route.method.toUpperCase()} /{route.endpoint}</option>)}</select>
      <label htmlFor="mock-response">Preconfigured response</label><select id="mock-response" value={responseId} onChange={event=>setResponseId(event.target.value)}><option value="">Select response variant</option>{route?.responses.map(response=><option key={response.uuid} value={response.uuid}>{response.label||response.uuid} · HTTP {response.statusCode}</option>)}</select>
      {response && <><p className="field-hint">HTTP status: {response.statusCode}. Body error codes are separate; confirm what the app expects.</p><pre>{response.body}</pre></>}
      <label htmlFor="failure-semantics">Chosen failure semantics</label><input id="failure-semantics" value={failureSemantics} onChange={event=>setFailureSemantics(event.target.value)} placeholder="Example: HTTP 500, body code MAINTENANCE" maxLength={300}/>
      <label htmlFor="from-screen">Trigger screen</label><input id="from-screen" value={fromScreen} onChange={event=>setFromScreen(event.target.value)} maxLength={300}/>
      <label htmlFor="to-screen">Expected destination screen</label><input id="to-screen" value={toScreen} onChange={event=>setToScreen(event.target.value)} maxLength={300}/>
      <p className="field-hint">Unmatched requests forward to the backend. Choose any declared routes that should also forward:</p>
      {environment?.routes.filter(route=>route.uuid!==routeId).map(route=><label key={route.uuid}><input type="checkbox" checked={passthrough.includes(route.uuid)} onChange={event=>setPassthrough(ids=>event.target.checked?[...ids,route.uuid]:ids.filter(id=>id!==route.uuid))}/> Forward {route.method.toUpperCase()} /{route.endpoint}</label>)}
      <div className="expected-path"><span>{fromScreen||'Trigger screen'}</span><span aria-label="expected transition">→</span><span>{toScreen||'Expected screen'}</span></div>
      <p className="field-hint">Save the picked triggering step, then add a reusable assertion below and run the scenario. The isolated picker buttons test only the picked command.</p>
    </>}
    {importError && <p role="alert" className="notice error">{importError}</p>}
  </fieldset>;
}
