import type {Batch} from '../server/batches.js';
import {canvasTestLabel,routeVisits} from '../shared/canvas-authoring.js';
import {ExecutedCanvas} from './executed-canvas.js';
import {ScenarioLibrary} from './scenario-library.js';
import type {ScenarioDefinition} from '../server/scenario-definitions.js';
import {DefaultActions} from './default-actions.js';
import type {Automation} from '../server/default-actions.js';
import {canvasAfterDeletion,restoreDeletionReferences} from './yaml-forms.js';
import {YamlEditor} from './yaml-editor.js';
import { runnerClient } from './runner-client.js';
import { useEffect, useState, useRef, useCallback } from 'react';
import type { Run, Workspace } from '../server/scenarios.js';
import {CanvasEditor,emptyCanvas} from './canvas.js';
import type {CanvasGraph,CanvasDiagnostic,CatalogEntry} from '../server/canvas.js';
import { MockSetup } from './mock-setup.js';
import type { MockPlan } from '../server/mockoon.js';
import { parseAllDocuments } from 'yaml';
import { Picker } from './picker.js';

export function Scenarios({ token, deviceId, bundleId, launchBusy, onRunning }: { token: string; deviceId: string; bundleId: string; launchBusy: boolean; onRunning: (running: boolean) => void }) {
  const [definitions,setDefinitions]=useState<ScenarioDefinition[]>([]);
  const [scenarioId,setScenarioId]=useState('');
  const [definitionError,setDefinitionError]=useState('');
  const [resetApp,setResetApp]=useState(false);
  const selectedScenario=definitions.find(item=>item.id===scenarioId);
  const [name, setName] = useState('Home screen');
  const [yaml, setYaml] = useState('appId: com.example.HybridApp\n---\n- launchApp\n');
  const [openWorkspaceId,setOpenWorkspaceId]=useState('');
  const [loadedMock,setLoadedMock]=useState<MockPlan>();
  const [loadRevision,setLoadRevision]=useState(0);
  const [canvas,setCanvas]=useState<CanvasGraph|undefined>(emptyCanvas);
  const [pathId,setPathId]=useState('');
  const [legacyCanvas,setLegacyCanvas]=useState(false);
  const [catalog,setCatalog]=useState<CatalogEntry[]>([]);
  const [canvasDiagnostics,setCanvasDiagnostics]=useState<CanvasDiagnostic[]>([]);
  const [mock,setMock]=useState<MockPlan>();
  const [mockError,setMockError]=useState('');
  const [flows,setFlows]=useState('{}');
  const [automation,setAutomation]=useState<Automation>();
  const [automationError,setAutomationError]=useState('');
  const [preview,setPreview]=useState<{source:string;yaml:string}>();
  const [expectedPage,setExpectedPage]=useState('');
  const setMockPlan=useCallback((plan:MockPlan|undefined,error:string)=>{setMock(plan);setMockError(error);},[]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [inputs, setInputs] = useState('');
  const [sourceRepair,setSourceRepair]=useState<{ownerId:string}>();
  const advanced=useRef<HTMLDetailsElement>(null);
  const [run, setRun] = useState<Run>();
  const [batch,setBatch]=useState<Batch>();
  const [reports,setReports]=useState<Run[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [error, setError] = useState('');
  const [runError,setRunError]=useState('');
  const [artifact, setArtifact] = useState<{ name: string; text?: string; image?: string }>();
  const artifactSequence = useRef(0);
  const batchRunning=batch?.status==='running'||batch?.status==='cancelling';
  const running = run?.status === 'running'||batchRunning;
  useEffect(() => { onRunning(running || submitting || pickerBusy); }, [running, submitting, pickerBusy, onRunning]);
  const headers = { 'X-TnT-Token': token, 'Content-Type': 'application/json' };
  const api = runnerClient(token);
  useEffect(()=>{
    if(!sourceRepair)return;
    if(advanced.current)advanced.current.open=true;
    const target=sourceRepair.ownerId==='flows'||sourceRepair.ownerId.endsWith('.yaml')?document.getElementById('reusable-flows'):sourceRepair.ownerId==='automation'?advanced.current?.querySelector<HTMLElement>('.default-actions input,.default-actions select'):advanced.current?.querySelector<HTMLElement>('[aria-label="YAML form and code editor"] button');
    target?.scrollIntoView?.({block:'nearest'});target?.focus();
  },[sourceRepair]);
  useEffect(()=>{
    if(run)setReports(current=>current.some(item=>item.id===run.id)?current.map(item=>item.id===run.id?run:item):[...current,run]);
  },[run]);
  useEffect(()=>{artifactSequence.current++;setArtifact(undefined);},[run?.id]);
  useEffect(()=>{
    if(!token)return;let stopped=false;
    const timer=setTimeout(()=>{
      try {
        const parsedFlows=JSON.parse(flows);
        void runnerClient(token)('/api/canvas/references',{yaml,flows:parsedFlows,canvas,automation}).then(value=>{if(!stopped){setCatalog(value.references);setCanvasDiagnostics(value.diagnostics);}}).catch(error=>{if(!stopped){setCatalog([]);setCanvasDiagnostics([{ownerId:'yaml',detail:error.message}]);}});
      }catch{setCatalog([]);setCanvasDiagnostics([{ownerId:'flows',detail:'Repair the reusable flows JSON.'}]);}
    },250);
    return()=>{stopped=true;clearTimeout(timer);};
  },[yaml,flows,canvas,automation,token]);
  useEffect(() => {
    if (run?.status !== 'running') return;
    let stopped = false;
    const timer = setInterval(() => {
      void api('/api/runs/' + run.id).then(result => { if (!stopped) setRun(result); }).catch(error => { if (!stopped) setError(String(error.message)); });
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [run?.id, running, token]);
  useEffect(() => () => { if (artifact?.image) URL.revokeObjectURL(artifact.image); }, [artifact?.image]);
  async function receiveBatch(next:Batch){
    setBatch(next);
    const records:Run[]=await Promise.all(next.entries.filter(entry=>entry.runId).map(entry=>api('/api/runs/'+entry.runId)));
    setReports(current=>[...current.filter(item=>!records.some(record=>record.id===item.id)),...records]);
    setRun(current=>records.find(item=>item.id===current?.id)??current);
  }
  useEffect(()=>{
    if(!batchRunning||!batch)return;
    let stopped=false;
    const timer=setInterval(()=>{void api('/api/batches/'+batch.id).then(next=>{if(!stopped)return receiveBatch(next);}).catch(error=>{if(!stopped)setError(error.message);});},1000);
    return()=>{stopped=true;clearInterval(timer);};
  },[batch?.id,batchRunning,token]);
  async function runAll(){
    if(running||submitting||pickerBusy||launchBusy)return;
    setSubmitting(true);setRunError('');
    try{
      const workspace=await save();
      await receiveBatch(await api('/api/batches',{workspaceId:workspace.id,deviceId,resetApp,runtimeInputs:inputs.trim()?JSON.parse(inputs):undefined}));
      setInputs('');
    }catch(error){setRunError(error instanceof Error?error.message:'Batch request failed.');}
    finally{setSubmitting(false);}
  }
  async function cancelBatch(){
    try{await receiveBatch(await api('/api/batches/'+batch?.id+'/cancel',{}));}
    catch(error){setError(error instanceof Error?error.message:'Batch cancellation failed.');}
  }
  async function openReport(id:string){
    try{setRun(await api('/api/runs/'+id));}
    catch(error){setError(error instanceof Error?error.message:'Report unavailable.');}
  }
  function renameScenario(value:string){
    setDefinitions(current=>current.map(item=>item.id===scenarioId?{...item,name:value}:item));
    if(selectedScenario?.authoring==='canvas')setCanvas(current=>current&&({...current,paths:current.paths.map(path=>path.id===selectedScenario.pathId?{...path,name:value}:path)}));
  }
  function duplicateScenario(){
    if(!selectedScenario)return;
    const id='scenario-'+crypto.randomUUID().slice(0,8);
    const original=canvas?.paths.find(path=>path.id===selectedScenario.pathId);
    const pathId=original?'sequence-'+crypto.randomUUID():undefined;
    const name=(selectedScenario.name+' copy').slice(0,120);
    setDefinitions(current=>[...current,{...structuredClone(selectedScenario),id,name,pathId}]);
    setCanvas(current=>current&&({...current,screens:current.screens.map(screen=>({...screen,tests:screen.tests.map(test=>test.scenarioIds?.includes(selectedScenario.id)?{...test,scenarioIds:[...test.scenarioIds,id]}:test)})),paths:original?[...current.paths,{...structuredClone(original),id:pathId!,scenarioId:id,name,visits:routeVisits(current,original).map(visit=>({...structuredClone(visit),id:crypto.randomUUID()}))}]:current.paths}));
    setScenarioId(id);setInputs('');
  }
  function deleteScenario(){
    if(!selectedScenario)return;
    setDefinitions(current=>current.filter(item=>item.id!==scenarioId));
    setCanvas(current=>current&&({...current,screens:current.screens.map(screen=>({...screen,tests:screen.tests.map(test=>test.scenarioIds?{...test,scenarioIds:test.scenarioIds.filter(id=>id!==scenarioId)}:test)})),paths:current.paths.filter(path=>path.id!==selectedScenario.pathId||definitions.some(item=>item.id!==scenarioId&&item.pathId===path.id))}));
    setScenarioId(definitions.find(item=>item.id!==scenarioId)?.id??'');setInputs('');
  }
  async function openWorkspace() {
    setSubmitting(true);setError('');setRunError('');
    try {
      const workspace:Workspace=await api('/api/workspaces/'+openWorkspaceId.trim());
      setLegacyCanvas(!workspace.scenarios?.some(item=>item.authoring==='canvas'));setDefinitions(workspace.scenarios??[]);setScenarioId(workspace.scenarios?.[0]?.id??'');setDefinitionError('');setResetApp(false);
      setBatch(undefined);setWorkspaceId(workspace.id);setName(workspace.name);setYaml(workspace.yaml);setFlows(JSON.stringify(workspace.flows??{},null,2));
      setAutomation(workspace.automation);setAutomationError('');setPreview(undefined);setCanvas(workspace.canvas);setPathId('');setLoadedMock(workspace.mock);setMock(workspace.mock);setLoadRevision(value=>value+1);
      artifactSequence.current++;setRun(undefined);setArtifact(undefined);setInputs('');
    }catch(error){setError(error instanceof Error?error.message:'Cannot open workspace.');}
    finally{setSubmitting(false);}
  }
  async function save() {
    if(definitionError)throw new Error(definitionError);
    if(mockError) throw new Error(mockError);
    if(automationError)throw new Error(automationError);
    let source=yaml;
    if(selectedScenario?.authoring==='canvas'&&bundleId){const docs=parseAllDocuments(yaml);if(docs.length===2&&!docs.some(doc=>doc.errors.length)){docs[0].set('appId',bundleId);source=docs[0].toString()+'---\n'+docs[1].toString({directives:false});}}
    const workspace: Workspace = await api('/api/workspaces', { id: workspaceId || undefined, name, yaml:source, flows: JSON.parse(flows), mock, canvas, automation, scenarios:definitions });
    setWorkspaceId(workspace.id);setYaml(workspace.yaml);
    return workspace;
  }
  async function submit(execute: boolean) {
    if(submitting||pickerBusy||(execute&&(running||launchBusy)))return;
    if (execute) {
      setRunError('');
      if(!token){setRunError('Connect to the runner before running a scenario.');return;}
      if(!deviceId){setRunError('Select a device before running a scenario.');return;}
      artifactSequence.current++; setArtifact(undefined);
    }
    setError(''); setSubmitting(true);
    try {
      const workspace = await save();
      if (execute) {
        const runtimeInputs = inputs.trim() ? JSON.parse(inputs) : undefined;
        setArtifact(undefined);
        const next = await api('/api/runs', { workspaceId: workspace.id, deviceId, runtimeInputs, pathId:canvas?pathId:undefined,scenarioId:definitions.length?scenarioId:undefined,resetApp });
        artifactSequence.current++;
        setArtifact(undefined);
        setRun(next);
        setInputs('');
      }
    } catch (error) {
      const message=error instanceof Error ? error.message : 'Scenario request failed.';
      if(execute)setRunError(message);else setError(message);
    }
    finally { setSubmitting(false); }
  }
  async function savePicked(yaml: string) {
    const workspace: Workspace = await api('/api/workspaces', { id: workspaceId || undefined, name, yaml, flows: JSON.parse(flows), mock, canvas, automation, scenarios:definitions });
    setWorkspaceId(workspace.id); setYaml(workspace.yaml);
  }
  async function executePicked(flowYaml: string, captureId: string, pickerReviewId: string) {
    artifactSequence.current++; setArtifact(undefined); setError('');
    const workspace: Workspace = await api('/api/workspaces', { name: 'Picked step — ' + name.slice(0, 100), yaml: flowYaml });
    const next = await api('/api/runs', { workspaceId: workspace.id, deviceId, captureId, pickerReviewId });
    artifactSequence.current++; setArtifact(undefined); setRun(next);
  }
  async function cancel() {
    setError('');
    try { setRun(await api('/api/runs/' + run?.id + '/cancel', {})); }
    catch (error) { setError(error instanceof Error ? error.message : 'Cancellation failed.'); }
  }
  async function inspect(name: string) {
    const sequence = ++artifactSequence.current;
    const id = run?.id;
    try {
      const response = await fetch('/api/runs/' + id + '/artifact?name=' + encodeURIComponent(name), { headers });
      if (!response.ok) throw new Error('Artifact unavailable.');
      if (name.endsWith('.png')) {
        const blob = await response.blob();
        if (sequence === artifactSequence.current) setArtifact({ name, image: URL.createObjectURL(blob) });
      } else {
        const text = await response.text();
        if (sequence === artifactSequence.current) setArtifact({ name, text });
      }
    } catch (error) { if (sequence === artifactSequence.current) setError(error instanceof Error ? error.message : 'Artifact unavailable.'); }
  }
  function addAssertion() {
    try {
      if(!expectedPage.trim()) throw new Error('Enter the expected page text.');
      const docs=parseAllDocuments(yaml);
      if(docs.length!==2 || docs.some(doc=>doc.errors.length) || !Array.isArray(docs[1].toJS())) throw new Error('Repair the scenario YAML before adding a reusable assertion.');
      const appId=docs[0].toJS().appId;
      const nextFlows=JSON.parse(flows);
      nextFlows['maintenance.yaml']='appId: '+JSON.stringify(appId)+'\n---\n- assertVisible: ${EXPECTED_PAGE}\n';
      docs[1].add({runFlow:{file:'maintenance.yaml',env:{EXPECTED_PAGE:'^'+expectedPage.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'}}});
      setFlows(JSON.stringify(nextFlows,null,2));setYaml(docs[0].toString()+docs[1].toString());setError('');
    } catch(error){setError(error instanceof Error?error.message:'Cannot add assertion.');}
  }
  return <section className="panel scenario-panel" aria-labelledby="scenario-heading">
    <div className="panel-heading"><span className="section-number">03</span><div><h2 id="scenario-heading">Scenario workspace</h2><p>Design scenarios on the shared canvas. Connect a simulator when ready to run.</p></div></div>
    <div className="workspace-open"><label htmlFor="open-workspace">Saved workspace ID</label><input id="open-workspace" value={openWorkspaceId} onChange={event=>setOpenWorkspaceId(event.target.value)} placeholder="Paste the ID shown after saving"/><button className="confirm" disabled={!token||!openWorkspaceId.trim()||running||submitting||pickerBusy||launchBusy} onClick={()=>void openWorkspace()}>Open saved workspace</button></div>
    <div className="canvas-workspace"><aside className="scenario-sidebar" aria-label="Scenarios"><h3>Scenarios</h3>
      {definitions.map(item=><button className={scenarioId===item.id?'primary':'confirm'} key={item.id} aria-pressed={scenarioId===item.id} disabled={running||submitting||pickerBusy} onClick={()=>{setScenarioId(item.id);setInputs('');}}>{item.name}</button>)}
      <button className="confirm" disabled={running||submitting||pickerBusy||definitions.length>=20} onClick={()=>{setLegacyCanvas(false);const id='scenario-'+crypto.randomUUID().slice(0,8);const path='sequence-'+crypto.randomUUID();setDefinitions(current=>[...current,{id,name:'Scenario '+(current.length+1),authoring:'canvas',steps:[],pathId:path,inputs:{},parameters:{},setup:automation?.setup,enabledHandlerIds:automation?.actions.filter(action=>action.enabled).map(action=>action.id)??[]}]);setCanvas(current=>({...current??emptyCanvas(),paths:[...current?.paths??[],{id:path,scenarioId:id,name:'Scenario '+(definitions.length+1),edgeIds:[]}]}));setScenarioId(id);}}>New scenario</button>
      {selectedScenario&&<><label htmlFor="canvas-scenario-name">Scenario name</label><input id="canvas-scenario-name" value={selectedScenario.name} maxLength={120} disabled={running||submitting||pickerBusy} onChange={event=>renameScenario(event.target.value)}/><button className="confirm" disabled={running||submitting||pickerBusy||definitions.length>=20||(canvas?.paths.length??0)>=20} onClick={duplicateScenario}>Duplicate scenario</button><button className="confirm" disabled={running||submitting||pickerBusy} onClick={deleteScenario}>Delete scenario</button><p className="field-hint">{canvas?.paths.find(path=>path.id===selectedScenario.pathId)?.screenId?'Start saved':'Draft · choose a screen as the start'}</p></>}
      <button className="primary" disabled={!deviceId||!token||!definitions.length||running||submitting||launchBusy||pickerBusy} onClick={()=>void runAll()}>Run all</button>
      {batch&&batch.workspaceId===workspaceId&&<section aria-label="Batch report" aria-live="polite"><h3>Batch · {batch.status}</h3><p>Saved order · separate reports · {batch.snapshot.resetApp?'Declared app reset':'No additional app reset'}</p>{batch.entries.map(entry=><div key={entry.scenarioId}><p>{entry.name} · {entry.status}</p>{entry.reason&&<p>{entry.reason}</p>}{entry.runId&&<button className="confirm" onClick={()=>void openReport(entry.runId!)}>Open report for {entry.name}</button>}</div>)}{batchRunning&&<button className="confirm" onClick={()=>void cancelBatch()}>Cancel batch</button>}</section>}
    </aside><div className="workspace-canvas">
    <CanvasEditor onRepairSource={ownerId=>setSourceRepair({ownerId})} scenarios={definitions} scenarioId={scenarioId} scenarioMode={!legacyCanvas} onRun={()=>void submit(true)} key={'canvas-'+loadRevision} yaml={yaml} onYamlChange={setYaml} graph={canvas} onChange={setCanvas} catalog={catalog} diagnostics={canvasDiagnostics} pathId={selectedScenario?.pathId??pathId} onPathChange={id=>{setPathId(id);if(selectedScenario)setDefinitions(current=>current.map(item=>item.id===scenarioId?{...item,pathId:id}:item));}} disabled={running||submitting||pickerBusy||launchBusy}/>
    </div></div>
    <details ref={advanced} className="workspace-advanced"><summary>Advanced mode · legacy authoring and settings</summary><button className="confirm" onClick={()=>setLegacyCanvas(value=>!value)}>{legacyCanvas?'Return to contextual canvas':'Show legacy canvas controls'}</button>
    <ScenarioLibrary key={'scenarios-'+loadRevision} items={definitions} onChange={setDefinitions} selected={scenarioId} onSelect={id=>{setScenarioId(id);setPathId(definitions.find(item=>item.id===id)?.pathId??'');setInputs('');}} catalog={catalog} files={(()=>{try{return Object.keys(JSON.parse(flows));}catch{return [];}})()} canvas={canvas} automation={automation} mock={mock} disabled={running||submitting||pickerBusy||launchBusy} onError={setDefinitionError}/>
    <MockSetup key={loadRevision} initialPlan={loadedMock} disabled={running||submitting||pickerBusy} onChange={setMockPlan}/>
    <div className="scenario-editor">
      <label htmlFor="expected-page">Expected page text for reusable assertion</label><input id="expected-page" value={expectedPage} onChange={event=>setExpectedPage(event.target.value)} disabled={running||submitting||pickerBusy}/><button className="confirm" disabled={running||submitting||pickerBusy} onClick={addAssertion}>Append reusable assertion</button>
      <label htmlFor="reusable-flows">Reusable YAML flows (JSON filename → YAML)</label><textarea id="reusable-flows" value={flows} onChange={event=>setFlows(event.target.value)} disabled={running||submitting||pickerBusy} spellCheck={false}/>
      <label htmlFor="scenario-name">Scenario name</label><input id="scenario-name" value={name} disabled={pickerBusy} onChange={event => setName(event.target.value)} maxLength={120} />
      <div className="label-row"><span>Executable flow</span><button className="text-button" disabled={!bundleId || pickerBusy} onClick={() => setYaml(`appId: ${bundleId}\n---\n- launchApp\n- assertVisible: Home\n`)}>Use launch app ID</button></div>
      <DefaultActions key={'automation-'+loadRevision} value={automation} onChange={setAutomation} catalog={catalog} files={(()=>{try{return Object.keys(JSON.parse(flows));}catch{return [];}})()} disabled={pickerBusy} onError={setAutomationError}/>
      {(automation||selectedScenario||canvas)&&<><button type="button" className="confirm" disabled={pickerBusy||submitting||!!automationError} onClick={async()=>{try{const source=JSON.stringify({yaml,flows,automation,definitions,scenarioId,resetApp,inputs,canvas,pathId});const result=await api('/api/automation/preview',{yaml,flows:JSON.parse(flows),automation,canvas,mock,pathId,scenarios:definitions,scenarioId:definitions.length?scenarioId:undefined,resetApp,runtimeInputs:inputs.trim()?JSON.parse(inputs):undefined});setPreview({source,yaml:result.executionYaml});setError('');}catch(error){setError(error instanceof Error?error.message:'Cannot preview execution.');}}}>Preview execution YAML</button>{preview&&<details open><summary>Derived execution preview{preview.source!==JSON.stringify({yaml,flows,automation,definitions,scenarioId,resetApp,inputs,canvas,pathId})?' · outdated, refresh before running':''}</summary><pre className="execution-yaml">{preview.yaml}</pre></details>}</>}
      <YamlEditor key={loadRevision} yaml={yaml} onChange={setYaml} disabled={pickerBusy}
        deletionWarnings={index=>[...definitions.filter(item=>item.steps.some(ref=>ref.index!>=index)).map(item=>'Scenario · '+item.name),...(canvas?.screens.flatMap(screen=>screen.tests.filter(test=>test.reference.kind==='flow'||(test.reference.file==='flow.yaml'&&(test.reference.index??-1)>=index)).map(test=>screen.title+' · '+test.label))??[]),...(automation?.checkpoints.filter(checkpoint=>checkpoint.beforeStep>=index).map(checkpoint=>'Default-action checkpoint before step '+(checkpoint.beforeStep+1))??[])]}
        onDelete={(next,index)=>{
          const previous=canvas;const changed=canvasAfterDeletion(canvas,index);
          const previousDefinitions=definitions;
          const changedDefinitions=definitions.map(item=>({...item,steps:item.steps.map(ref=>ref.index!>=index?{...ref,fingerprint:'deleted:'+ref.fingerprint.slice(-56)}:ref)}));
          setDefinitions(changedDefinitions);
          const previousAutomation=automation;
          const changedAutomation=automation?{...automation,checkpoints:automation.checkpoints.map(checkpoint=>checkpoint.beforeStep>=index?{...checkpoint,fingerprint:'deleted:'+checkpoint.fingerprint.slice(-56)}:checkpoint)}:undefined;
          setYaml(next);setCanvas(changed);setAutomation(changedAutomation);
          return ()=>{setDefinitions(current=>current.map(item=>{const previous=previousDefinitions.find(previous=>previous.id===item.id);const changed=changedDefinitions.find(changed=>changed.id===item.id);return previous&&changed?{...item,steps:item.steps.map(ref=>{const match=changed.steps.find(step=>step.index===ref.index&&step.fingerprint===ref.fingerprint);const original=previous.steps.find(step=>step.index===ref.index);return match&&original?original:ref;})}:item;}));setCanvas(current=>restoreDeletionReferences(current,previous,changed));setAutomation(current=>current&&previousAutomation&&changedAutomation?{...current,checkpoints:current.checkpoints.map(checkpoint=>{
            const changed=changedAutomation.checkpoints.find(item=>item.beforeStep===checkpoint.beforeStep&&item.fingerprint===checkpoint.fingerprint);
            const previous=previousAutomation.checkpoints.find(item=>item.beforeStep===checkpoint.beforeStep);
            return changed&&previous?{...checkpoint,fingerprint:previous.fingerprint}:checkpoint;
          })}:current);};
        }}/>

      <p className="field-hint">Reusable files declared above are snapshotted with the scenario; other external files and custom artifact paths are unsupported. Edits during a run apply to the next run.</p>
      <label className="checkbox-label"><input type="checkbox" checked={resetApp} disabled={running||submitting||pickerBusy||!selectedScenario} onChange={event=>setResetApp(event.target.checked)}/>Reset app data before setup (default: No)</label><p className="field-hint">No preserves app data and relaunches before declared setup. Setup must establish required app/session state. Reset clears app data; it does not clear the simulator Keychain or server-side sessions.</p>
      <label htmlFor="runtime-inputs">Confidential runtime inputs (optional JSON)</label><input id="runtime-inputs" type="password" value={inputs} onChange={event => setInputs(event.target.value)} autoComplete="off" placeholder={'{"PASSWORD":"value"}'} />
      <p className="field-hint">Use uppercase names and reference them as ${'{NAME}'} in YAML. Values are never saved. Runs with inputs withhold raw logs and images. Keep secrets out of authored YAML.</p>
    </div></details>
      <div className="scenario-actions"><button className="confirm" onClick={() => void submit(false)} disabled={submitting || pickerBusy}>Save workspace</button><button className="primary" onClick={() => void submit(true)} disabled={!deviceId || !token || submitting || running || launchBusy || pickerBusy}>{submitting ? 'Preparing…' : 'Run scenario'}</button>{run?.status==='running'&&!batchRunning && <button className="confirm" onClick={() => void cancel()}>Cancel run</button>}</div>
      {workspaceId && <p className="artifact-id">Workspace: {workspaceId}</p>}
      {error && <div role="alert" className="notice error">{error}</div>}
    {reports.some(item=>item.snapshot.workspaceId===workspaceId)&&<nav aria-label="Scenario reports"><p>Reports from this workspace session · selecting a scenario leaves the inspected report open.</p>{reports.filter(item=>item.snapshot.workspaceId===workspaceId).map((item,index)=><button className="confirm" key={item.id} disabled={submitting} aria-pressed={run?.id===item.id} onClick={()=>setRun(item)}>{item.snapshot.scenario?.name??item.snapshot.name} · {item.status} · Run {index+1}</button>)}</nav>}
    <div className="scenario-result" aria-live="polite">
      {!run ? <div className="empty-state"><h3>Your scenario result</h3><p>Run a saved flow on the selected simulator to see its real outcome and artifacts.</p></div> : <>
        {run.snapshot.expectedPath && <div className="expected-path"><span>{run.snapshot.expectedPath.from}</span><span>→</span><span>Expected: {run.snapshot.expectedPath.to} · {run.status}</span></div>}
        {run.mock && <div className="mock-evidence"><h3>Mock intent: {run.mock.intent.status}</h3><p>{run.mock.intent.method.toUpperCase()} /{run.mock.intent.endpoint} · HTTP {run.mock.intent.httpStatus}</p><p>{run.mock.intent.failureSemantics}</p><h3>Observed requests: {run.mock.evidence.status}</h3><p className="field-hint">{run.mock.evidence.detail}</p>{run.mock.evidence.transactions.map((transaction,index)=><p key={index}>{transaction.method.toUpperCase()} {transaction.path} → {transaction.statusCode} {transaction.proxied?'(forwarded)':'(mocked)'}</p>)}<p>Mock cleanup: {run.mock.cleanup.detail}</p></div>}
        <div className="label-row"><h3>{run.snapshot.name}</h3><span className={'result-tag ' + run.status}>{run.status}</span></div>
        {run.error && <div className="notice error">{run.error}</div>}
        <p>Cleanup ({run.status==='running' ? 'pending' : run.cleanup.verified ? 'verified' : 'failed'}): {run.cleanup.detail}</p>
        {run.automation&&<details open><summary>Setup and default action outcomes</summary><p>Setup: {run.automation.setup.status}</p>{run.automation.actions.map(action=><p key={action.id+':'+action.beforeStep}>{action.name} · before step {action.beforeStep+1}: {action.status} · {action.detail}</p>)}</details>}
        {run.snapshot.executionYaml&&<details><summary>Derived execution YAML</summary><pre className="execution-yaml">{run.snapshot.executionYaml}</pre></details>}
        <ExecutedCanvas key={run.id} run={run} onArtifact={name=>void inspect(name)}/>
        <p className="field-hint">{run.mappingNote}</p>
        <ol className="step-results">{run.steps.map(step => <li key={step.id}><code>{step.command}</code><span>{step.status}</span></li>)}</ol>
        {run.expectedFailure && <details open><summary>Failed expected assertion</summary><pre>{JSON.stringify(run.expectedFailure, null, 2)}</pre></details>}
        <details><summary>Executed snapshot &amp; versions</summary><p className="artifact-id">Run: {run.id}<br />Snapshot: {run.snapshot.id}<br />Maestro: {run.snapshot.toolVersions.maestro} · Node: {run.snapshot.toolVersions.node}</p><pre>{run.snapshot.yaml}</pre>{Object.entries(run.snapshot.flows??{}).map(([name,yaml])=><div key={name}><h4>{name}</h4><pre>{yaml}</pre></div>)}<p>{run.snapshot.scenario&&<>Scenario: {run.snapshot.scenario.name} · Reset app: {run.snapshot.resetApp?'Yes':'No'} · Declared setup: {run.snapshot.scenario.setup?.file??'Ordinary app launch'}</>}</p><p>{run.snapshot.runtimeInputPolicy}</p></details>
        <details open={run.status !== 'passed'}><summary>Raw runner log</summary><pre>{run.log || 'Waiting for Maestro to finish…'}</pre></details>
        <div className="artifact-list">{run.artifacts.map(name => <button className="text-button" key={name} disabled={submitting || run.status==='running'} onClick={() => void inspect(name)}>{name}</button>)}</div>
        {artifact && <div className="artifact-view"><p className="artifact-id">{artifact.name}</p>{artifact.image ? <img className="device-screen" src={artifact.image} alt="Captured failure screen" /> : <pre>{artifact.text}</pre>}</div>}
      </>}
    </div>
    <details><summary>Advanced screenshot picker</summary><Picker token={token} deviceId={deviceId} yaml={yaml} disabled={launchBusy || running || submitting} onBusy={setPickerBusy} onSave={savePicked} onExecute={executePicked} /></details>
    {runError&&<div className="run-error-toast" role="alert"><button className="text-button" aria-label="Dismiss run error" onClick={()=>setRunError('')}>×</button><strong>Cannot run scenario</strong><p>{runError}</p></div>}
  </section>;
}
