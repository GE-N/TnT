import {DefaultActions} from './default-actions.js';
import type {Automation} from '../server/default-actions.js';
import {canvasAfterDeletion,restoreDeletionReferences} from './yaml-forms.js';
import {YamlEditor} from './yaml-editor.js';
import { runnerClient } from './runner-client.js';
import { useEffect, useState, useRef, useCallback } from 'react';
import type { Run, Workspace } from '../server/scenarios.js';
import {CanvasEditor,CanvasBoard} from './canvas.js';
import type {CanvasGraph,CanvasDiagnostic,CatalogEntry} from '../server/canvas.js';
import { MockSetup } from './mock-setup.js';
import type { MockPlan } from '../server/mockoon.js';
import { parseAllDocuments } from 'yaml';
import { Picker } from './picker.js';

export function Scenarios({ token, deviceId, bundleId, launchBusy, onRunning }: { token: string; deviceId: string; bundleId: string; launchBusy: boolean; onRunning: (running: boolean) => void }) {
  const [name, setName] = useState('Home screen');
  const [yaml, setYaml] = useState('appId: com.example.HybridApp\n---\n- launchApp\n- assertVisible: Home\n');
  const [openWorkspaceId,setOpenWorkspaceId]=useState('');
  const [loadedMock,setLoadedMock]=useState<MockPlan>();
  const [loadRevision,setLoadRevision]=useState(0);
  const [canvas,setCanvas]=useState<CanvasGraph>();
  const [pathId,setPathId]=useState('');
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
  const [run, setRun] = useState<Run>();
  const [submitting, setSubmitting] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [error, setError] = useState('');
  const [artifact, setArtifact] = useState<{ name: string; text?: string; image?: string }>();
  const artifactSequence = useRef(0);
  const running = run?.status === 'running';
  useEffect(() => { onRunning(running || submitting || pickerBusy); }, [running, submitting, pickerBusy, onRunning]);
  const headers = { 'X-TnT-Token': token, 'Content-Type': 'application/json' };
  const api = runnerClient(token);
  useEffect(()=>{
    if(!token)return;let stopped=false;
    const timer=setTimeout(()=>{
      try {
        const parsedFlows=JSON.parse(flows);
        void runnerClient(token)('/api/canvas/references',{yaml,flows:parsedFlows,canvas}).then(value=>{if(!stopped){setCatalog(value.references);setCanvasDiagnostics(value.diagnostics);}}).catch(error=>{if(!stopped){setCatalog([]);setCanvasDiagnostics([{ownerId:'yaml',detail:error.message}]);}});
      }catch{setCatalog([]);setCanvasDiagnostics([{ownerId:'flows',detail:'Repair the reusable flows JSON.'}]);}
    },250);
    return()=>{stopped=true;clearTimeout(timer);};
  },[yaml,flows,canvas,token]);
  useEffect(() => {
    if (!running || !run) return;
    let stopped = false;
    const timer = setInterval(() => {
      void api('/api/runs/' + run.id).then(result => { if (!stopped) setRun(result); }).catch(error => { if (!stopped) setError(String(error.message)); });
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [run?.id, running, token]);
  useEffect(() => {
    if (!run || running) return;
    const screenshot = run.artifacts.find(name => name.endsWith('.png') && name.includes('screenshots/'));
    if (screenshot) void inspect(screenshot);
  }, [run?.id, running]);
  useEffect(() => () => { if (artifact?.image) URL.revokeObjectURL(artifact.image); }, [artifact?.image]);
  async function openWorkspace() {
    setSubmitting(true);setError('');
    try {
      const workspace:Workspace=await api('/api/workspaces/'+openWorkspaceId.trim());
      setWorkspaceId(workspace.id);setName(workspace.name);setYaml(workspace.yaml);setFlows(JSON.stringify(workspace.flows??{},null,2));
      setAutomation(workspace.automation);setAutomationError('');setPreview(undefined);setCanvas(workspace.canvas);setPathId('');setLoadedMock(workspace.mock);setMock(workspace.mock);setLoadRevision(value=>value+1);
      artifactSequence.current++;setRun(undefined);setArtifact(undefined);setInputs('');
    }catch(error){setError(error instanceof Error?error.message:'Cannot open workspace.');}
    finally{setSubmitting(false);}
  }
  async function save() {
    if(mockError) throw new Error(mockError);
    if(automationError)throw new Error(automationError);
    const workspace: Workspace = await api('/api/workspaces', { id: workspaceId || undefined, name, yaml, flows: JSON.parse(flows), mock, canvas, automation });
    setWorkspaceId(workspace.id);
    return workspace;
  }
  async function submit(execute: boolean) {
    if (execute) { artifactSequence.current++; setArtifact(undefined); }
    setError(''); setSubmitting(true);
    try {
      const workspace = await save();
      if (execute) {
        const runtimeInputs = inputs.trim() ? JSON.parse(inputs) : undefined;
        setArtifact(undefined);
        const next = await api('/api/runs', { workspaceId: workspace.id, deviceId, runtimeInputs, pathId:canvas?pathId:undefined });
        artifactSequence.current++;
        setArtifact(undefined);
        setRun(next);
        setInputs('');
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Scenario request failed.'); }
    finally { setSubmitting(false); }
  }
  async function savePicked(yaml: string) {
    const workspace: Workspace = await api('/api/workspaces', { id: workspaceId || undefined, name, yaml, flows: JSON.parse(flows), mock, canvas, automation });
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
    <div className="panel-heading"><span className="section-number">03</span><div><h2 id="scenario-heading">Run an authored scenario</h2><p>Saved YAML is the executable authority. Each run gets its own snapshot.</p></div></div>
    <div className="workspace-open"><label htmlFor="open-workspace">Saved workspace ID</label><input id="open-workspace" value={openWorkspaceId} onChange={event=>setOpenWorkspaceId(event.target.value)} placeholder="Paste the ID shown after saving"/><button className="confirm" disabled={!token||!openWorkspaceId.trim()||running||submitting||pickerBusy||launchBusy} onClick={()=>void openWorkspace()}>Open saved workspace</button></div>
    <CanvasEditor graph={canvas} onChange={setCanvas} catalog={catalog} diagnostics={canvasDiagnostics} pathId={pathId} onPathChange={setPathId} disabled={running||submitting||pickerBusy||launchBusy}/>
    <MockSetup key={loadRevision} initialPlan={loadedMock} disabled={running||submitting||pickerBusy} onChange={setMockPlan}/>
    <div className="scenario-grid"><div className="scenario-editor">
      <label htmlFor="expected-page">Expected page text for reusable assertion</label><input id="expected-page" value={expectedPage} onChange={event=>setExpectedPage(event.target.value)} disabled={running||submitting||pickerBusy}/><button className="confirm" disabled={running||submitting||pickerBusy} onClick={addAssertion}>Append reusable assertion</button>
      <label htmlFor="reusable-flows">Reusable YAML flows (JSON filename → YAML)</label><textarea id="reusable-flows" value={flows} onChange={event=>setFlows(event.target.value)} disabled={running||submitting||pickerBusy} spellCheck={false}/>
      <label htmlFor="scenario-name">Scenario name</label><input id="scenario-name" value={name} disabled={pickerBusy} onChange={event => setName(event.target.value)} maxLength={120} />
      <div className="label-row"><span>Executable flow</span><button className="text-button" disabled={!bundleId || pickerBusy} onClick={() => setYaml(`appId: ${bundleId}\n---\n- launchApp\n- assertVisible: Home\n`)}>Use launch app ID</button></div>
      <DefaultActions key={'automation-'+loadRevision} value={automation} onChange={setAutomation} catalog={catalog} files={(()=>{try{return Object.keys(JSON.parse(flows));}catch{return [];}})()} disabled={pickerBusy} onError={setAutomationError}/>
      {automation&&<><button type="button" className="confirm" disabled={pickerBusy||submitting||!!automationError} onClick={async()=>{try{const source=JSON.stringify({yaml,flows,automation});const result=await api('/api/automation/preview',{yaml,flows:JSON.parse(flows),automation});setPreview({source,yaml:result.executionYaml});setError('');}catch(error){setError(error instanceof Error?error.message:'Cannot preview execution.');}}}>Preview execution YAML</button>{preview&&<details open><summary>Derived execution preview{preview.source!==JSON.stringify({yaml,flows,automation})?' · outdated, refresh before running':''}</summary><pre className="execution-yaml">{preview.yaml}</pre></details>}</>}
      <YamlEditor key={loadRevision} yaml={yaml} onChange={setYaml} disabled={pickerBusy}
        deletionWarnings={index=>[...(canvas?.screens.flatMap(screen=>screen.tests.filter(test=>test.reference.kind==='flow'||(test.reference.file==='flow.yaml'&&(test.reference.index??-1)>=index)).map(test=>screen.title+' · '+test.label))??[]),...(automation?.checkpoints.filter(checkpoint=>checkpoint.beforeStep>=index).map(checkpoint=>'Default-action checkpoint before step '+(checkpoint.beforeStep+1))??[])]}
        onDelete={(next,index)=>{
          const previous=canvas;const changed=canvasAfterDeletion(canvas,index);
          const previousAutomation=automation;
          const changedAutomation=automation?{...automation,checkpoints:automation.checkpoints.map(checkpoint=>checkpoint.beforeStep>=index?{...checkpoint,fingerprint:'deleted:'+checkpoint.fingerprint.slice(-56)}:checkpoint)}:undefined;
          setYaml(next);setCanvas(changed);setAutomation(changedAutomation);
          return ()=>{setCanvas(current=>restoreDeletionReferences(current,previous,changed));setAutomation(current=>current&&previousAutomation&&changedAutomation?{...current,checkpoints:current.checkpoints.map(checkpoint=>{
            const changed=changedAutomation.checkpoints.find(item=>item.beforeStep===checkpoint.beforeStep&&item.fingerprint===checkpoint.fingerprint);
            const previous=previousAutomation.checkpoints.find(item=>item.beforeStep===checkpoint.beforeStep);
            return changed&&previous?{...checkpoint,fingerprint:previous.fingerprint}:checkpoint;
          })}:current);};
        }}/>

      <p className="field-hint">Reusable files declared above are snapshotted with the scenario; other external files and custom artifact paths are unsupported. Edits during a run apply to the next run.</p>
      <label htmlFor="runtime-inputs">Confidential runtime inputs (optional JSON)</label><input id="runtime-inputs" type="password" value={inputs} onChange={event => setInputs(event.target.value)} autoComplete="off" placeholder={'{"PASSWORD":"value"}'} />
      <p className="field-hint">Use uppercase names and reference them as ${'{NAME}'} in YAML. Values are never saved. Runs with inputs withhold raw logs and images. Keep secrets out of authored YAML.</p>
      <div className="scenario-actions"><button className="confirm" onClick={() => void submit(false)} disabled={submitting || pickerBusy}>Save workspace</button><button className="primary" onClick={() => void submit(true)} disabled={!deviceId || !token || submitting || running || launchBusy || pickerBusy}>{submitting ? 'Preparing…' : 'Run scenario'}</button>{running && <button className="confirm" onClick={() => void cancel()}>Cancel run</button>}</div>
      {workspaceId && <p className="artifact-id">Workspace: {workspaceId}</p>}
      {error && <div role="alert" className="notice error">{error}</div>}
    </div><div className="scenario-result" aria-live="polite">
      {!run ? <div className="empty-state"><h3>Your scenario result</h3><p>Run a saved flow on the selected simulator to see its real outcome and artifacts.</p></div> : <>
        {run.snapshot.expectedPath && <div className="expected-path"><span>{run.snapshot.expectedPath.from}</span><span>→</span><span>Expected: {run.snapshot.expectedPath.to} · {run.status}</span></div>}
        {run.mock && <div className="mock-evidence"><h3>Mock intent: {run.mock.intent.status}</h3><p>{run.mock.intent.method.toUpperCase()} /{run.mock.intent.endpoint} · HTTP {run.mock.intent.httpStatus}</p><p>{run.mock.intent.failureSemantics}</p><h3>Observed requests: {run.mock.evidence.status}</h3><p className="field-hint">{run.mock.evidence.detail}</p>{run.mock.evidence.transactions.map((transaction,index)=><p key={index}>{transaction.method.toUpperCase()} {transaction.path} → {transaction.statusCode} {transaction.proxied?'(forwarded)':'(mocked)'}</p>)}<p>Mock cleanup: {run.mock.cleanup.detail}</p></div>}
        <div className="label-row"><h3>{run.snapshot.name}</h3><span className={'result-tag ' + run.status}>{run.status}</span></div>
        {run.error && <div className="notice error">{run.error}</div>}
        <p>Cleanup ({running ? 'pending' : run.cleanup.verified ? 'verified' : 'failed'}): {run.cleanup.detail}</p>
        {run.automation&&<details open><summary>Setup and default action outcomes</summary><p>Setup: {run.automation.setup.status}</p>{run.automation.actions.map(action=><p key={action.id+':'+action.beforeStep}>{action.name} · before step {action.beforeStep+1}: {action.status} · {action.detail}</p>)}</details>}
        {run.snapshot.executionYaml&&<details><summary>Derived execution YAML</summary><pre className="execution-yaml">{run.snapshot.executionYaml}</pre></details>}
        {run.snapshot.canvas&&run.canvas&&<details open><summary>Executed canvas · {run.snapshot.canvas.paths.find(path=>path.id===run.canvas?.pathId)?.name}</summary><p>{run.canvas.note}</p><CanvasBoard graph={run.snapshot.canvas} pathId={run.canvas.pathId} result={run.canvas}/>{run.canvas.tests.map(test=><p key={test.id}>{run.snapshot.canvas?.screens.flatMap(screen=>screen.tests).find(item=>item.id===test.id)?.label}: {test.status} · {test.detail}</p>)}</details>}
        <p className="field-hint">{run.mappingNote}</p>
        <ol className="step-results">{run.steps.map(step => <li key={step.id}><code>{step.command}</code><span>{step.status}</span></li>)}</ol>
        {run.expectedFailure && <details open><summary>Failed expected assertion</summary><pre>{JSON.stringify(run.expectedFailure, null, 2)}</pre></details>}
        <details><summary>Executed snapshot &amp; versions</summary><p className="artifact-id">Run: {run.id}<br />Snapshot: {run.snapshot.id}<br />Maestro: {run.snapshot.toolVersions.maestro} · Node: {run.snapshot.toolVersions.node}</p><pre>{run.snapshot.yaml}</pre>{Object.entries(run.snapshot.flows??{}).map(([name,yaml])=><div key={name}><h4>{name}</h4><pre>{yaml}</pre></div>)}<p>{run.snapshot.runtimeInputPolicy}</p></details>
        <details open={run.status !== 'passed'}><summary>Raw runner log</summary><pre>{run.log || 'Waiting for Maestro to finish…'}</pre></details>
        <div className="artifact-list">{run.artifacts.map(name => <button className="text-button" key={name} disabled={submitting || running} onClick={() => void inspect(name)}>{name}</button>)}</div>
        {artifact && <div className="artifact-view"><p className="artifact-id">{artifact.name}</p>{artifact.image ? <img className="device-screen" src={artifact.image} alt="Captured failure screen" /> : <pre>{artifact.text}</pre>}</div>}
      </>}
    </div></div>
    <Picker token={token} deviceId={deviceId} yaml={yaml} disabled={launchBusy || running || submitting} onBusy={setPickerBusy} onSave={savePicked} onExecute={executePicked} />
  </section>;
}
