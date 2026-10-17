import { useEffect, useState } from 'react';
import type { InstalledApp } from '../server/runner.js';

export function AppPicker({ deviceId, token, value, onChange, onReady, onAppLabel, disabled }: { deviceId: string; token: string; value: string; onChange: (value: string) => void; onReady: (ready: boolean) => void; onAppLabel?: (label: string) => void; disabled: boolean }) {
  const [manual, setManual] = useState(false);
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<{ apps: InstalledApp[]; loading: boolean; error: string; deviceId?:string; token?:string }>({ apps: [], loading: true, error: '' });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setList({ apps: [], loading: true, error: '' });
    if (!deviceId || !token) { setList({ apps: [], loading: false, error: '' }); return; }
    fetch('/api/devices/' + encodeURIComponent(deviceId) + '/apps', { headers: { 'X-TnT-Token': token }, signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Could not load installed apps. Refresh apps to retry.'); if (data.deviceId !== deviceId || !Array.isArray(data.apps)) throw new Error('The app list does not match this simulator. Refresh apps to retry.'); return data.apps as InstalledApp[]; })
      .then(apps => { if (active) setList({ apps, loading: false, error: '',deviceId,token }); })
      .catch(error => { if (active) setList({ apps: [], loading: false, error: error instanceof Error ? error.message : 'Could not load installed apps.' }); });
    return () => { active = false; controller.abort(); };
  }, [deviceId, token, revision]);
  const revalidated=list.deviceId===deviceId&&list.token===token;
  const selected = revalidated&&list.apps.some(app => app.bundleId === value) ? value : '';
  useEffect(() => { onReady(manual || (!list.loading && !!selected)); }, [manual, list.loading, selected, onReady]);
  useEffect(() => {
    if (!onAppLabel) return;
    if (manual) { onAppLabel(value.trim()); return; }
    const app = revalidated ? list.apps.find(item => item.bundleId === value) : undefined;
    onAppLabel(app ? app.name.trim() || app.bundleId : '');
  }, [manual, value, revalidated, list.apps, onAppLabel]);
  useEffect(() => { if (!manual && revalidated && !list.loading && value && !selected) onChange(''); }, [manual, revalidated, list.loading, value, selected, onChange]);
  const hint = !deviceId ? 'Choose a running simulator to view installed apps.' : list.loading ? 'Loading apps from the selected simulator…' : !list.error && !list.apps.length ? 'No installed apps found. Install an app, then refresh.' : manual ? 'Enter the bundle ID of an app installed on this simulator.' : '';
  return <div className="simulator-app">
    <div className="label-row"><label htmlFor={manual ? 'bundle' : 'installed-app'}>{manual ? 'App bundle identifier' : 'Installed app'}</label><button type="button" className="text-button" disabled={disabled || !deviceId || !token || list.loading} onClick={() => setRevision(current => current + 1)}>↻ Refresh apps</button></div>
    {manual ? <input id="bundle" value={value} onChange={event => onChange(event.target.value)} placeholder="com.example.App" autoComplete="off" spellCheck={false} disabled={disabled} required maxLength={255} /> : <span className="simulator-select"><select id="installed-app" value={selected} required disabled={disabled || list.loading || !deviceId || !list.apps.length} onChange={event => onChange(event.target.value)}>
      <option value="">{list.loading ? 'Loading installed apps…' : 'Choose an installed app'}</option>
      <optgroup label="User-installed apps">{list.apps.filter(app => app.type === 'user').map(app => <option key={app.bundleId} value={app.bundleId}>{app.name} · {app.bundleId}</option>)}</optgroup>
      <optgroup label="System apps">{list.apps.filter(app => app.type === 'system').map(app => <option key={app.bundleId} value={app.bundleId}>{app.name} · {app.bundleId}</option>)}</optgroup>
    </select></span>}
    {hint && <p className="field-hint" role="status">{hint}</p>}
    {list.error && <div className="notice error" role="alert">{list.error} Use Refresh apps to retry.</div>}
    <button type="button" className="text-button" disabled={disabled} onClick={() => { setManual(current => !current); onChange(''); }}>{manual ? 'Choose from installed apps' : 'Enter bundle ID manually'}</button>
  </div>;
}
