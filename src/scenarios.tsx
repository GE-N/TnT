import { useEffect, useState, useRef } from 'react';
import type { Run, Workspace } from '../server/scenarios.js';

export function Scenarios({ token, deviceId, bundleId, launchBusy, onRunning }: { token: string; deviceId: string; bundleId: string; launchBusy: boolean; onRunning: (running: boolean) => void }) {
  const [name, setName] = useState('Home screen');
  const [yaml, setYaml] = useState('appId: com.example.HybridApp\n---\n- launchApp\n- assertVisible: Home\n');
  const [workspaceId, setWorkspaceId] = useState('');
  const [inputs, setInputs] = useState('');
  const [run, setRun] = useState<Run>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [artifact, setArtifact] = useState<{ name: string; text?: string; image?: string }>();
  const artifactSequence = useRef(0);
  const running = run?.status === 'running';
  useEffect(() => { onRunning(running || submitting); }, [running, submitting, onRunning]);
  const headers = { 'X-TnT-Token': token, 'Content-Type': 'application/json' };
  async function api(path: string, body?: unknown) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Scenario operation failed.');
    return result;
  }
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
  async function save() {
    const workspace: Workspace = await api('/api/workspaces', { id: workspaceId || undefined, name, yaml });
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
        const next = await api('/api/runs', { workspaceId: workspace.id, deviceId, runtimeInputs });
        artifactSequence.current++;
        setArtifact(undefined);
        setRun(next);
        setInputs('');
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Scenario request failed.'); }
    finally { setSubmitting(false); }
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
  return <section className="panel scenario-panel" aria-labelledby="scenario-heading">
    <div className="panel-heading"><span className="section-number">03</span><div><h2 id="scenario-heading">Run an authored scenario</h2><p>Saved YAML is the executable authority. Each run gets its own snapshot.</p></div></div>
    <div className="scenario-grid"><div className="scenario-editor">
      <label htmlFor="scenario-name">Scenario name</label><input id="scenario-name" value={name} onChange={event => setName(event.target.value)} maxLength={120} />
      <div className="label-row"><label htmlFor="scenario-yaml">Maestro YAML</label><button className="text-button" disabled={!bundleId} onClick={() => setYaml(`appId: ${bundleId}\n---\n- launchApp\n- assertVisible: Home\n`)}>Use launch app ID</button></div>
      <textarea id="scenario-yaml" value={yaml} onChange={event => setYaml(event.target.value)} spellCheck={false} maxLength={100_000} />
      <p className="field-hint">Single-flow workspace; external files and custom artifact paths are unsupported. Edits during a run apply to the next run.</p>
      <label htmlFor="runtime-inputs">Confidential runtime inputs (optional JSON)</label><input id="runtime-inputs" type="password" value={inputs} onChange={event => setInputs(event.target.value)} autoComplete="off" placeholder={'{"PASSWORD":"value"}'} />
      <p className="field-hint">Use uppercase names and reference them as ${'{NAME}'} in YAML. Values are never saved. Runs with inputs withhold raw logs and images. Keep secrets out of authored YAML.</p>
      <div className="scenario-actions"><button className="confirm" onClick={() => void submit(false)} disabled={submitting}>Save workspace</button><button className="primary" onClick={() => void submit(true)} disabled={!deviceId || !token || submitting || running || launchBusy}>{submitting ? 'Preparing…' : 'Run scenario'}</button>{running && <button className="confirm" onClick={() => void cancel()}>Cancel run</button>}</div>
      {workspaceId && <p className="artifact-id">Workspace: {workspaceId}</p>}
      {error && <div role="alert" className="notice error">{error}</div>}
    </div><div className="scenario-result" aria-live="polite">
      {!run ? <div className="empty-state"><h3>Your scenario result</h3><p>Run a saved flow on the selected simulator to see its real outcome and artifacts.</p></div> : <>
        <div className="label-row"><h3>{run.snapshot.name}</h3><span className={'result-tag ' + run.status}>{run.status}</span></div>
        {run.error && <div className="notice error">{run.error}</div>}
        <p>Cleanup ({running ? 'pending' : run.cleanup.verified ? 'verified' : 'failed'}): {run.cleanup.detail}</p>
        <p className="field-hint">{run.mappingNote}</p>
        <ol className="step-results">{run.steps.map(step => <li key={step.id}><code>{step.command}</code><span>{step.status}</span></li>)}</ol>
        {run.expectedFailure && <details open><summary>Failed expected assertion</summary><pre>{JSON.stringify(run.expectedFailure, null, 2)}</pre></details>}
        <details><summary>Executed snapshot &amp; versions</summary><p className="artifact-id">Run: {run.id}<br />Snapshot: {run.snapshot.id}<br />Maestro: {run.snapshot.toolVersions.maestro} · Node: {run.snapshot.toolVersions.node}</p><pre>{run.snapshot.yaml}</pre><p>{run.snapshot.runtimeInputPolicy}</p></details>
        <details open={run.status !== 'passed'}><summary>Raw runner log</summary><pre>{run.log || 'Waiting for Maestro to finish…'}</pre></details>
        <div className="artifact-list">{run.artifacts.map(name => <button className="text-button" key={name} disabled={submitting || running} onClick={() => void inspect(name)}>{name}</button>)}</div>
        {artifact && <div className="artifact-view"><p className="artifact-id">{artifact.name}</p>{artifact.image ? <img className="device-screen" src={artifact.image} alt="Captured failure screen" /> : <pre>{artifact.text}</pre>}</div>}
      </>}
    </div></div>
  </section>;
}
