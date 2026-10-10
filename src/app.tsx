import { useCallback, useEffect, useState } from 'react';
import type { Device, LaunchResult } from '../server/runner.js';
import { Scenarios } from './scenarios.js';
import { AppPicker } from './app-picker.js';

type Status = { ready: boolean; devices: Device[]; token: string; tool: string; node?: string; error?: string };

export function App() {
  const [status, setStatus] = useState<Status>();
  const [deviceId, setDeviceId] = useState(()=>{try{return localStorage.getItem('tnt-device')??'';}catch{return '';}});
  const [appSelection, setAppSelection] = useState(()=>{try{return JSON.parse(localStorage.getItem('tnt-app')??'null')??{deviceId:'',bundleId:''};}catch{return {deviceId:'',bundleId:''};}});
  const bundleId = appSelection.deviceId === deviceId ? appSelection.bundleId : '';
  const setBundleId = useCallback((bundleId: string) => setAppSelection({ deviceId, bundleId }), [deviceId]);
  useEffect(()=>{try{localStorage.setItem('tnt-device',deviceId);localStorage.setItem('tnt-app',JSON.stringify(appSelection));}catch{}},[deviceId,appSelection]);
  const [pickerReady, setPickerReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<LaunchResult>();
  const [screen, setScreen] = useState('');

  async function refresh() {
    setError('');
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error('The local runner is unavailable. Check the terminal and refresh.');
      const next: Status = await response.json();
      setStatus(next);
      setDeviceId(current => next.devices.some(device => device.id === current) ? current : next.devices[0]?.id ?? '');
    } catch (error) { setStatus(undefined); setError(describe(error)); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!result?.screenshot || !status?.token) { setScreen(''); return; }
    let active = true;
    let objectUrl: string | undefined;
    fetch(result.screenshot, { headers: { 'X-TnT-Token': status.token } })
      .then(response => { if (!response.ok) throw new Error('The captured screen could not be loaded.'); return response.blob(); })
      .then(blob => { if (active) { objectUrl = URL.createObjectURL(blob); setScreen(objectUrl); } })
      .catch(error => { if (active) setError(describe(error)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [result?.screenshot, status?.token]);

  async function request(path: string, body: unknown) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TnT-Token': status?.token ?? '' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Runner request failed.');
    return data as LaunchResult;
  }
  async function launch(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setResult(undefined); setScreen('');
    try { const next = await request('/api/launches', { deviceId, bundleId: bundleId.trim() }); setResult(next); }
    catch (error) { setError(describe(error)); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!result) return;
    setBusy(true); setError('');
    try { setResult(await request('/api/launches/' + result.id + '/confirm', {})); }
    catch (error) { setError(describe(error)); }
    finally { setBusy(false); }
  }
  const ready = status?.ready && deviceId;

  return <div className="workbench">
    <header className="topbar"><a className="brand" href="/">tnt<span className="brand-dot">.</span></a><span className="product">MOBILE TEST WORKBENCH</span><span className={'connection ' + (status?.ready ? 'connected' : '')}><i />{status?.ready ? 'Local runner connected' : status ? 'Runner needs attention' : 'Connecting to runner'}</span></header>
    <main>
      <div className="workspace-device-controls">
        <label htmlFor="device">Simulator</label><select id="device" value={deviceId} disabled={busy||scenarioBusy} onChange={event=>setDeviceId(event.target.value)}><option value="">Design offline</option>{status?.devices.map(device=><option key={device.id} value={device.id}>{device.name}</option>)}</select>
        <button className="text-button" disabled={busy||scenarioBusy} onClick={()=>void refresh()}>Refresh devices</button>
        <AppPicker key={deviceId+status?.token} deviceId={deviceId} token={status?.token??''} value={bundleId} onChange={setBundleId} onReady={setPickerReady} disabled={busy||scenarioBusy}/>
      </div>
      {(error||status?.error)&&<div className="notice error" role="alert">{error||status?.error}</div>}
      <Scenarios token={status?.token??''} deviceId={deviceId} bundleId={bundleId} launchBusy={busy} onRunning={setScenarioBusy}/>
      <details><summary>Advanced launch tools</summary><form onSubmit={launch}><button className="confirm" disabled={!ready||!pickerReady||busy||scenarioBusy}>Launch app</button></form>{result&&<><p>{result.bundleId} · {result.status}</p>{screen&&<img className="device-screen" src={screen} alt="Captured launch screen"/>}{result.status==='awaiting-confirmation'&&<button onClick={()=>void confirm()} disabled={busy||!screen}>I can see the app</button>}<pre>{result.log}</pre></>}</details>
      <footer><span>iOS first · Local execution</span><span>Pick reviewed steps from the simulator · Isolated mock scenarios and reusable assertions.</span></footer>
    </main>
  </div>;
}

function describe(error: unknown) { return error instanceof Error ? error.message : 'An unexpected error occurred.'; }
