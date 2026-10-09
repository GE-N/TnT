import { runnerClient } from './runner-client.js';
import { useEffect, useRef, useState } from 'react';
import type { Capture, Candidate, StepDraft } from '../server/picker.js';

type Preview = { canSave: boolean; matches: Candidate[]; maestroMatches: Candidate[]; stepsYaml: string; note: string };
export function Picker({ token, deviceId, yaml, disabled, onBusy, onSave, onExecute, onCheckSelector }: {
  onCheckSelector?:(selector:string)=>void;token: string; deviceId: string; yaml: string; disabled: boolean; onBusy(busy: boolean): void;
  onSave(yaml: string): Promise<void>; onExecute(flowYaml: string, captureId: string, reviewId: string): Promise<void>;
}) {
  const [capture, setCapture] = useState<Capture>();
  const [screen, setScreen] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Candidate>();
  const [selector, setSelector] = useState('');
  const [clickPoint, setClickPoint] = useState<[number, number]>();
  const [command, setCommand] = useState<StepDraft['command']>(onCheckSelector?'visible':'tap');
  const [inputText, setInputText] = useState('');
  const [fallback, setFallback] = useState<StepDraft['fallback']>();
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  useEffect(() => { sequence.current++; setCapture(undefined); setScreen(''); setCandidates([]); setSelected(undefined); setPreview(undefined); }, [deviceId, token]);
  useEffect(() => {
    if (!capture) return;
    const timer = setTimeout(() => { sequence.current++; setCapture(undefined); setCandidates([]); setSelected(undefined); setPreview(undefined); setScreen(''); setError('Capture expired. Refresh the screen and review again.'); }, Math.max(0, Date.parse(capture.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [capture?.id]);
  useEffect(() => () => { if (screen) URL.revokeObjectURL(screen); }, [screen]);
  const api = runnerClient(token);
  async function refresh() {
    const current = ++sequence.current;
    setBusy(true); setError(''); setNotice(''); setCapture(undefined); setScreen(''); setSelected(undefined); setCandidates([]); setPreview(undefined);
    try {
      const next: Capture = await api('/api/picker/captures', { deviceId });
      const response = await fetch('/api/picker/captures/' + next.id + '/screen', { headers: { 'X-TnT-Token': token } });
      if (!response.ok) throw new Error('Captured screenshot unavailable. Refresh again.');
      const blob = await response.blob();
      if (current === sequence.current) { setCapture(next); setScreen(URL.createObjectURL(blob)); }
    } catch (error) { if (current === sequence.current) setError(describe(error)); }
    finally { setBusy(false); }
  }
  async function pick(event: React.MouseEvent<HTMLImageElement>) {
    if (!capture || busy || disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const current = ++sequence.current;
    setClickPoint([(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height]);
    setSelected(undefined); setPreview(undefined); setError(''); setNotice('');
    try { const found = await api('/api/picker/candidates', { captureId: capture.id, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }); if (current === sequence.current) setCandidates(found); }
    catch (error) { if (current === sequence.current) setError(describe(error)); }
  }
  function choose(candidate: Candidate) {
    sequence.current++; setSelected(candidate); setPreview(undefined); setFallback(undefined); setSelector(candidate.text ? 'text: ' + JSON.stringify(candidate.text) : ''); setNotice(''); setError('');
  }
  function edit(value: string) { sequence.current++; setSelector(value); setPreview(undefined); }
  const draft = { captureId: capture?.id ?? '', candidateId: selected?.id ?? '', command, selector, inputText, fallback };
  async function review() {
    const current = ++sequence.current;
    setBusy(true); setError('');
    try { const result = await api('/api/picker/preview', draft); if (current === sequence.current) setPreview(result); }
    catch (error) { if (current === sequence.current) setError(describe(error)); }
    finally { setBusy(false); }
  }
  async function finish(action: 'save' | 'run' | 'test') {
    if (!capture) return;
    const current = ++sequence.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const step = await api('/api/picker/step', { ...draft, command: action === 'test' ? 'visible' : command, yaml, deviceId });
      if (current !== sequence.current) return;
      if (action !== 'test') { await onSave(step.yaml); setNotice('Reviewed step saved to the workspace.'); }
      if (action !== 'save') { await onExecute(step.flowYaml, capture.id, step.reviewId); setCapture(undefined); setCandidates([]); setScreen(''); setSelected(undefined); setPreview(undefined); }
    } catch (error) { if (current === sequence.current) setError(describe(error)); }
    finally { setBusy(false); }
  }
  const blocked = busy || disabled;
  return <section className="picker" aria-labelledby="picker-heading">
    <div className="label-row"><div><h3 id="picker-heading">Pick from the simulator</h3><p className="field-hint">Refresh, click the screen, and explicitly choose a hierarchy candidate.</p></div><button className="confirm" onClick={() => void refresh()} disabled={blocked || !deviceId || !token}>{busy ? 'Inspecting…' : 'Refresh screen'}</button></div>
    <div className="picker-grid"><div>
      {screen && capture ? <><div className="picker-screen"><img src={screen} alt="Live simulator capture — click to inspect candidates" onClick={event => void pick(event)} />{selected && <div className="pick-highlight" style={{ left: selected.bounds.x / capture.width * 100 + '%', top: selected.bounds.y / capture.height * 100 + '%', width: selected.bounds.width / capture.width * 100 + '%', height: selected.bounds.height / capture.height * 100 + '%' }} />}</div><p className="field-hint">{capture.deviceName} · {capture.width} × {capture.height}<br />Captured {new Date(capture.capturedAt).toLocaleTimeString()}; expires after two minutes. Refresh after UI changes.</p></> : <p className="field-hint">A fresh screenshot and hierarchy will appear here. Unlabeled/custom controls may need a targeted identifier or a deliberate coordinate fallback.</p>}
    </div><div>
      {candidates.length > 0 && <fieldset disabled={blocked}><legend>Element candidates ({candidates.length})</legend><div className="candidate-list">{candidates.map(candidate => <label key={candidate.id}><input type="radio" name="picked-element" checked={selected?.id === candidate.id} onChange={() => choose(candidate)} /><span>{candidate.text || 'Unlabeled element'}<small>{candidate.id} · parent {candidate.parentId ?? 'none'}{candidate.identifier && ' · id ' + candidate.identifier}</small></span></label>)}</div></fieldset>}
      {selected && <fieldset disabled={blocked} className="selector-form"><legend>Review selected element</legend>
        <label htmlFor="picked-command">Command</label><select id="picked-command" value={command} onChange={event => { sequence.current++; setCommand(event.target.value as StepDraft['command']); setPreview(undefined); }}><option value="tap">Tap</option><option value="input">Input text (tap, then type)</option><option value="visible">Assert visible</option><option value="not-visible">Assert not visible</option></select>
        {command === 'input' && <><label htmlFor="picked-input">Non-secret input text</label><input id="picked-input" value={inputText} onChange={event => { sequence.current++; setInputText(event.target.value); setPreview(undefined); }} maxLength={4000} /></>}
        <div className="scenario-actions"><button className="text-button" onClick={() => { setFallback('identifier'); edit(selected.identifier ? 'id: ' + JSON.stringify(selected.identifier) : selector); setNotice('Identifier targeting enabled. Use an inspected identifier on the target or in a constraint.'); }}>{selected.identifier ? 'Choose targeted identifier' : 'Permit identifier constraint'}</button><button className="text-button" onClick={() => { if (!capture) return; setFallback('coordinates'); edit('point: "' + ((clickPoint?.[0] ?? (selected.bounds.x + selected.bounds.width / 2) / capture.width) * 100).toFixed(2) + '%, ' + ((clickPoint?.[1] ?? (selected.bounds.y + selected.bounds.height / 2) / capture.height) * 100).toFixed(2) + '%"'); }}>Choose coordinate fallback</button></div>
        <label htmlFor="picked-selector">Selector (literal labels, YAML)</label><textarea id="picked-selector" value={selector} onChange={event => edit(event.target.value)} spellCheck={false} maxLength={4000} />
        <p className="field-hint">Supported: text, id, index (0-based), enabled, childOf, containsChild, above, below, leftOf, rightOf. Labels are literal and escaped in executable YAML. Index follows Maestro screen order (top to bottom, then left to right); use Test selector to verify the real match. Unlabeled controls have no text selector. Coordinates support tap/input only and depend on layout.</p>
        <button className="confirm" onClick={() => void review()}>Preview selector</button>
        {preview && <><p className="field-hint">{preview.note} Matches: {preview.matches.map(match => match.id).join(', ') || 'none'}<br />Maestro eligible candidates (index order): {preview.maestroMatches.map((match, index) => `${index}: ${match.id}`).join(', ') || 'none'}</p><pre>{preview.stepsYaml}</pre><div className="scenario-actions">{onCheckSelector?<button className="confirm" disabled={!preview.canSave||blocked} onClick={()=>onCheckSelector(selector)}>Use selector for check</button>:<><button className="confirm" disabled={!preview.canSave || fallback === 'coordinates'} onClick={() => void finish('test')}>Test selector</button><button className="confirm" disabled={!preview.canSave} onClick={() => void finish('save')}>Save step</button><button className="primary" disabled={!preview.canSave} onClick={() => void finish('run')}>Save &amp; run step</button></>}</div></>}
      </fieldset>}
    </div></div>
    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
  </section>;
}
function describe(error: unknown) { return error instanceof Error ? error.message : 'Picker operation failed.'; }
