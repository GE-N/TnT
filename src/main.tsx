import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Device, LaunchResult } from '../server/runner.js';
import './style.css';
import { Scenarios } from './scenarios.js';

type Status = { ready: boolean; devices: Device[]; token: string; tool: string; node?: string; error?: string };

function App() {
  const [status, setStatus] = useState<Status>();
  const [deviceId, setDeviceId] = useState('');
  const [bundleId, setBundleId] = useState('');
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
      <div className="intro"><div><p className="eyebrow">WORKSPACE / DEVICE LAUNCH</p><h1>Start with your app.</h1><p className="subtitle">Connect a prepared simulator and bring your app into view.</p></div><span className="phase">01 <span>/ Launch</span></span></div>
      <div className="grid">
        <section className="panel launch-panel" aria-labelledby="launch-heading">
          <div className="panel-heading"><span className="section-number">01</span><div><h2 id="launch-heading">Launch configuration</h2><p>Your Mac. Your simulator. Your app.</p></div></div>
          <form onSubmit={launch}>
            <div className="label-row"><label htmlFor="device">Ready simulator</label><button className="text-button" type="button" onClick={() => void refresh()} disabled={busy}>↻ Refresh</button></div>
            <select id="device" value={deviceId} onChange={event => setDeviceId(event.target.value)} disabled={busy || !status?.devices.length}>
              {!status?.devices.length && <option value="">No running simulator</option>}
              {status?.devices.map(device => <option key={device.id} value={device.id}>{device.name} · {device.runtime.replace('com.apple.CoreSimulator.SimRuntime.', '')}</option>)}
            </select>
            <p className="field-hint">Open Simulator and install your app before launching.</p>
            <label htmlFor="bundle">App bundle identifier</label>
            <input id="bundle" value={bundleId} onChange={event => setBundleId(event.target.value)} placeholder="com.example.App" autoComplete="off" spellCheck={false} disabled={busy} required maxLength={255} />
            <p className="field-hint">Use the bundle ID of the app installed on this device.</p>
            <button className="primary" type="submit" disabled={!ready || busy || scenarioBusy || !bundleId.trim()}>{busy ? 'Working…' : 'Launch app'}<span aria-hidden="true">↗</span></button>
          </form>
          {(error || status?.error) && <div className="notice error" role="alert">{error || status?.error}</div>}
          {status?.ready && !status.devices.length && <div className="notice">No ready devices found. Open an iOS simulator, then refresh.</div>}
          <div className="local-note"><span aria-hidden="true">◎</span><div><strong>Runs locally</strong><p>Launches an installed app. Simulator provisioning and app installation stay manual.</p></div></div>
          <div className="tool-row"><span>LAUNCH TOOL</span><strong>Xcode simctl</strong></div>
        </section>
        <section className="panel evidence-panel" aria-labelledby="evidence-heading">
          <div className="panel-heading"><span className="section-number">02</span><div><h2 id="evidence-heading">Launch evidence</h2><p>Check what actually appeared on the device.</p></div><span className={'result-tag ' + (result?.status ?? '')}>{result?.status === 'confirmed' ? 'Confirmed' : result?.status === 'failed' ? 'Failed' : result ? 'Needs confirmation' : 'Waiting'}</span></div>
          {!result ? <div className="empty-state"><div className="phone-outline"><span /><div>↗</div><i /></div><h3>{busy ? 'Opening your app…' : 'Your first launch starts here'}</h3><p>{busy ? 'Waiting for the simulator and capturing its screen.' : 'Choose a simulator and enter your app’s bundle ID. A captured screen and launch log will appear here.'}</p></div> : <>
            {result.error && <div className="notice error" role="alert">{result.error}</div>}
            <div className="evidence-content">{screen && <img className="device-screen" src={screen} alt={'Captured ' + result.deviceName + ' screen after launching ' + result.bundleId} />}<div className="launch-details"><p className="eyebrow">{result.deviceName}</p><h3>{result.bundleId}</h3><p>{result.status === 'confirmed' ? 'You confirmed the app is visible in the captured screen.' : result.status === 'failed' ? 'The launch did not complete. Review the log and correct the configuration.' : 'The launch command completed. Verify the app is foregrounded in the captured screen before confirming.'}</p>{result.status === 'awaiting-confirmation' && <button className="confirm" type="button" onClick={() => void confirm()} disabled={busy || !screen}>I can see the app</button>}<p className="timestamp">{new Date(result.startedAt).toLocaleString()}</p><details><summary>Launch log</summary><pre>{result.log || 'No command output.'}</pre><p className="artifact-id">Launch ID: {result.id}</p></details></div></div>
          </>}
        </section>
      </div>
      <Scenarios token={status?.token ?? ''} deviceId={deviceId} bundleId={bundleId} launchBusy={busy} onRunning={setScenarioBusy} />
      <footer><span>iOS first · Local execution</span><span>Screen picking and mocks follow in later tickets.</span></footer>
    </main>
  </div>;
}

function describe(error: unknown) { return error instanceof Error ? error.message : 'An unexpected error occurred.'; }
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
