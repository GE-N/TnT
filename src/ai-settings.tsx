import {forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState} from 'react';
import {AiFlowRequestError, createAiFlowClient, type AiPublicConfig, type ProviderId} from './ai-flow-client.js';

const PROVIDERS: ProviderId[] = ['openrouter', 'openai-compatible'];
const DEFAULT_BASE = 'https://api.openai.com/v1';
const MODEL_PATTERN = /^[A-Za-z0-9._:/@+-]{1,200}$/;

type Slice = {model: string; baseUrl: string; apiKey: string; editVersion: number; modelDirty: boolean; baseDirty: boolean; revealed: boolean; useSession: boolean};
type TestRecord = {
  testId: string;
  provider: ProviderId;
  source: 'replacement' | 'stored';
  editVersion: number;
  credentialRevision: number;
  status: 'running' | 'ok' | 'failed';
  code?: string;
  message?: string;
};
type Pending = {kind: 'close'} | {kind: 'provider'; id: ProviderId} | null;

export type AiSettingsHandle = {
  hasUnsavedKey: () => boolean;
  promptClose: () => void;
};

function emptySlice(baseUrl = ''): Slice {
  return {model: '', baseUrl, apiKey: '', editVersion: 0, modelDirty: false, baseDirty: false, revealed: false, useSession: false};
}

function providerName(id: ProviderId) {
  return id === 'openrouter' ? 'OpenRouter' : 'OpenAI-compatible';
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '0.0.0.0' || host === '::1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some(part => part > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(':')) return host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd');
  return false;
}

/** Inline twin of the server cloud-URL check. http and local hosts are rejected. */
export function cloudBaseUrlProblem(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { return 'Use an https cloud URL.'; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return 'Use https://. Local endpoints are not available.';
  if (isPrivateHost(url.hostname)) return 'Use https://. Local endpoints are not available.';
  return '';
}

function keyProblem(value: string) {
  if (!value) return '';
  if (value.length > 2000 || /[\u0000-\u001F\u007F]/.test(value) || value.startsWith('-')) return 'Provide an API key.';
  return '';
}

function statusText(config: AiPublicConfig | undefined, id: ProviderId) {
  const entry = config?.providers?.[id];
  if (!entry?.configured) return 'No API key saved';
  if (entry.keySource === 'env') return 'API key saved (from TNT_AI_API_KEY, dev only)';
  if (entry.keySource === 'session') return 'API key active · Forgotten when TnT restarts';
  return 'API key saved';
}

function testFailure(id: ProviderId, code?: string, message?: string) {
  const name = providerName(id);
  if (code === 'AUTH_FAILED') return 'Key rejected (401). Check you copied the whole key from openrouter.ai/keys, without spaces. Your typed key and any saved key are unchanged.';
  if (code === 'TIMEOUT' || code === 'NETWORK_ERROR') return `Couldn't reach ${name}. Timed out after 15 s, or this Mac is offline. Check the connection and test again. You can still Save without a test.`;
  if (code === 'AI_NOT_CONFIGURED') return 'Add an API key.';
  return message || 'The connection test failed.';
}

export const AiSettings = forwardRef<AiSettingsHandle, {token: string; focusNonce: number; onCloseCard: () => void}>(function AiSettings({token, focusNonce, onCloseCard}, ref) {
  const client = useMemo(() => createAiFlowClient(token), [token]);
  const keyRef = useRef<HTMLInputElement>(null);
  const forms = useRef<Record<ProviderId, Slice>>({openrouter: emptySlice(), 'openai-compatible': emptySlice(DEFAULT_BASE)});
  const [form, setForm] = useState(forms.current);
  const [config, setConfig] = useState<AiPublicConfig>();
  const configRef = useRef(config);
  configRef.current = config;
  const [provider, setProvider] = useState<ProviderId>('openrouter');
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const [test, setTest] = useState<TestRecord | null>(null);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [sessionOffer, setSessionOffer] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [catalog, setCatalog] = useState<{provider: ProviderId; models: {id: string}[]; failed: boolean; query: string; open: boolean}>({provider: 'openrouter', models: [], failed: false, query: '', open: false});
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const booted = useRef(false);
  const listId = useId();

  function write(id: ProviderId, patch: Partial<Slice>) {
    const next = {...forms.current[id], ...patch};
    forms.current = {...forms.current, [id]: next};
    setForm(forms.current);
  }

  useImperativeHandle(ref, () => ({
    hasUnsavedKey: () => forms.current[providerRef.current].apiKey.length > 0,
    promptClose: () => setPending({kind: 'close'}),
  }), []);

  useEffect(() => {
    let cancelled = false;
    void client.getConfig().then(next => {
      if (cancelled || !next?.providers?.openrouter || !next.providers['openai-compatible']) return;
      setConfig(next);
      const seeded = {...forms.current};
      for (const id of PROVIDERS) {
        const entry = next.providers[id];
        const slice = seeded[id];
        seeded[id] = {
          ...slice,
          model: slice.modelDirty ? slice.model : entry.model,
          baseUrl: slice.baseDirty ? slice.baseUrl : (entry.baseUrl || (id === 'openai-compatible' ? DEFAULT_BASE : '')),
        };
      }
      forms.current = seeded;
      setForm(seeded);
      if (!booted.current) { booted.current = true; setProvider(next.selected); }
    }).catch(() => { /* A missing config leaves the form editable. Save reports the failure. */ });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    if (!focusNonce) return;
    keyRef.current?.focus();
  }, [focusNonce]);

  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current); }, []);

  const slice = form[provider];
  const saved = config?.providers?.[provider];
  const urlProblem = provider === 'openai-compatible' ? cloudBaseUrlProblem(slice.baseUrl.trim()) : '';
  const typedKeyProblem = keyProblem(slice.apiKey);
  const modelProblem = slice.model.trim() && !MODEL_PATTERN.test(slice.model.trim()) ? 'Provide a model name.' : '';
  const hasSavedKey = !!saved?.configured;
  const canUseKey = slice.apiKey.length > 0 || hasSavedKey;
  const canCommit = !!slice.model.trim() && !modelProblem && !urlProblem && !typedKeyProblem && (slice.apiKey.length > 0 || hasSavedKey);
  const visibleTest = test && test.provider === provider && test.editVersion === slice.editVersion && (test.source === 'replacement' || test.credentialRevision === saved?.credentialRevision) ? test : null;

  function refreshMetadata(next: AiPublicConfig) {
    setConfig(next);
    const seeded = {...forms.current};
    for (const id of PROVIDERS) {
      const entry = next.providers[id];
      const current = seeded[id];
      seeded[id] = {
        ...current,
        model: current.modelDirty ? current.model : entry.model,
        baseUrl: current.baseDirty ? current.baseUrl : (entry.baseUrl || current.baseUrl),
      };
    }
    forms.current = seeded;
    setForm(seeded);
  }

  function choose(next: ProviderId) {
    if (next === provider) return;
    if (slice.apiKey) { setPending({kind: 'provider', id: next}); return; }
    setProvider(next);
    setNotice('');
    setFailure('');
    setConfirmRemove(false);
    setSessionOffer(false);
    setCatalog(current => ({...current, open: false}));
  }

  function discardPending() {
    write(provider, {apiKey: '', revealed: false});
    const action = pending;
    setPending(null);
    setNotice('');
    if (action?.kind === 'provider') setProvider(action.id);
    if (action?.kind === 'close') onCloseCard();
  }

  async function loadCatalog(id: ProviderId) {
    setCatalog({provider: id, models: [], failed: false, query: forms.current[id].model, open: true});
    try {
      const result = await client.listModels(id);
      setCatalog(current => current.provider === id ? {...current, models: result.models, failed: false, open: true} : current);
    } catch {
      setCatalog(current => current.provider === id ? {...current, models: [], failed: true, open: true} : current);
    }
  }

  async function runTest() {
    if (test?.status === 'running' || urlProblem || typedKeyProblem) return;
    const id = providerRef.current;
    const current = forms.current[id];
    const meta = configRef.current?.providers[id];
    if (!current.apiKey && !meta?.configured) return;
    const source = current.apiKey ? 'replacement' as const : 'stored' as const;
    const testId = crypto.randomUUID();
    const snapshot: TestRecord = {
      testId, provider: id, source, editVersion: current.editVersion,
      credentialRevision: meta?.credentialRevision ?? 0, status: 'running',
    };
    setTest(snapshot);
    setNotice('');
    setFailure('');
    try {
      const result = source === 'replacement'
        ? await client.testConnection({provider: id, testId, source, apiKey: current.apiKey})
        : await client.testConnection({provider: id, testId, source: 'stored', credentialRevision: snapshot.credentialRevision});
      if (forms.current[id].editVersion !== snapshot.editVersion) {
        setTest(existing => existing?.testId === testId ? null : existing);
        return;
      }
      if (source === 'stored' && (configRef.current?.providers[id].credentialRevision ?? 0) !== snapshot.credentialRevision) {
        setTest(existing => existing?.testId === testId ? null : existing);
        return;
      }
      setTest({...snapshot, status: result.ok ? 'ok' : 'failed', code: result.code, message: result.message});
    } catch (error) {
      if (forms.current[id].editVersion !== snapshot.editVersion) {
        setTest(existing => existing?.testId === testId ? null : existing);
        return;
      }
      const code = error instanceof AiFlowRequestError ? error.code : 'NETWORK_ERROR';
      const message = error instanceof Error ? error.message : 'The connection test failed.';
      setTest(existing => existing?.testId === testId ? {...snapshot, status: 'failed', code, message} : existing);
    }
  }

  async function save(id = providerRef.current) {
    const current = forms.current[id];
    const meta = configRef.current;
    const entry = meta?.providers[id];
    if (!meta || !current.model.trim()) return;
    if (id === 'openai-compatible' && cloudBaseUrlProblem(current.baseUrl.trim())) return;
    if (keyProblem(current.apiKey)) return;
    if (!current.apiKey && !entry?.configured) return;
    if (current.apiKey && entry?.storageAvailable === false && !current.useSession) { setSessionOffer(true); return; }
    setBusy(true);
    setFailure('');
    setNotice('');
    const storage = current.useSession || entry?.storageAvailable === false ? 'session' as const : 'keychain' as const;
    const credential = current.apiKey
      ? {action: 'replace' as const, apiKey: current.apiKey, storage}
      : {action: 'keep' as const};
    try {
      const next = await client.putConfig({
        expectedSettingsRevision: meta.settingsRevision,
        selected: id,
        provider: id,
        model: current.model.trim(),
        ...(id === 'openai-compatible' ? {baseUrl: current.baseUrl.trim()} : {}),
        credential,
      });
      refreshMetadata(next);
      write(id, {apiKey: '', editVersion: forms.current[id].editVersion + 1, revealed: false, modelDirty: false, baseDirty: false, useSession: false});
      setSessionOffer(false);
      setNotice('API key saved');
      const action = pending;
      setPending(null);
      if (action?.kind === 'provider') setProvider(action.id);
      if (action?.kind === 'close') onCloseCard();
    } catch (error) {
      const code = error instanceof AiFlowRequestError ? error.code : '';
      if (code === 'SETTINGS_CHANGED') {
        try { refreshMetadata(await client.getConfig()); } catch { /* The typed key stays either way. */ }
        setFailure('Couldn\u2019t save. Settings changed in another session. Everything you typed is kept. Press Save to try again.');
      } else if (code === 'CREDENTIAL_STORAGE_FAILED') {
        write(id, {useSession: false});
        setSessionOffer(true);
        setFailure('Secure storage isn\u2019t available. macOS Keychain can\u2019t be used, so TnT won\u2019t store the key on disk.');
      } else {
        setFailure('Couldn\u2019t save. The settings service didn\u2019t answer. Everything you typed is kept; the previous saved settings are unchanged.');
      }
    } finally { setBusy(false); }
  }

  async function removeKey() {
    const id = providerRef.current;
    const meta = configRef.current;
    const current = forms.current[id];
    if (!meta) return;
    setBusy(true);
    setFailure('');
    try {
      const next = await client.putConfig({
        expectedSettingsRevision: meta.settingsRevision,
        selected: meta.selected,
        provider: id,
        model: current.model.trim() || meta.providers[id].model || 'model',
        ...(id === 'openai-compatible' ? {baseUrl: (current.baseUrl.trim() || meta.providers[id].baseUrl || DEFAULT_BASE)} : {}),
        credential: {action: 'remove'},
      });
      refreshMetadata(next);
      setConfirmRemove(false);
      setNotice('No API key saved');
    } catch (error) {
      if (error instanceof AiFlowRequestError && error.code === 'SETTINGS_CHANGED') {
        try { refreshMetadata(await client.getConfig()); } catch { /* kept */ }
      }
      setFailure(error instanceof Error ? error.message : 'The API key could not be removed.');
    } finally { setBusy(false); }
  }

  function onKey(value: string) {
    write(provider, {apiKey: value, editVersion: slice.editVersion + 1, revealed: false});
    setTest(current => current?.provider === provider ? null : current);
    setNotice('');
  }

  function reveal(on: boolean) {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    write(provider, {revealed: on});
    if (on) revealTimer.current = setTimeout(() => write(providerRef.current, {revealed: false}), 8000);
  }

  const matches = catalog.open && catalog.provider === provider
    ? catalog.models.filter(item => item.id.toLowerCase().includes(slice.model.trim().toLowerCase())).slice(0, 8)
    : [];
  const savedDetail = saved?.keySource === 'keychain' ? ' · macOS Keychain' : '';

  return <section className="ai-settings" id="ai-settings" aria-label="AI settings" data-testid="ai-settings">
    <h3 className="ai-settings-title"><span aria-hidden="true">✦</span> AI <span className="ai-settings-scope">all workspaces · this Mac only</span></h3>
    <div className="ai-provider-row" role="radiogroup" aria-label="Provider">
      {PROVIDERS.map(id => <label key={id} className="ai-provider-option">
        <input type="radio" name="ai-provider" value={id} checked={provider === id} onChange={() => choose(id)} />
        <span data-testid={'ai-provider-' + id}>{providerName(id)}</span>
      </label>)}
    </div>
    {provider === 'openrouter'
      ? <p className="ai-settings-hint">Endpoint: openrouter.ai/api/v1 · fixed</p>
      : <label className="ai-field">Base URL
        <input aria-label="Base URL" value={slice.baseUrl} spellCheck={false} aria-invalid={urlProblem ? true : undefined} onChange={event => { write(provider, {baseUrl: event.target.value, baseDirty: true}); setTest(null); }} />
      </label>}
    {urlProblem && <p className="ai-settings-error" role="alert">✕ {urlProblem}</p>}
    {provider === 'openai-compatible' && !urlProblem && <p className="ai-settings-hint">https only. Saved on this Mac with Save, never sent with each request.</p>}
    <label className="ai-field">{hasSavedKey && !slice.apiKey ? 'Replace key' : 'API key'}
      <span className="ai-key-row">
        <input ref={keyRef} aria-label="API key" data-testid="ai-api-key" type={slice.revealed ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={slice.apiKey} placeholder={hasSavedKey ? 'Leave blank to keep the saved key' : provider === 'openrouter' ? 'Paste your OpenRouter key' : 'Paste your API key'} onChange={event => onKey(event.target.value)} />
        <button type="button" className="ai-settings-text" aria-label={slice.revealed ? 'Hide API key' : 'Show API key'} onClick={() => reveal(!slice.revealed)}>{slice.revealed ? 'Hide' : 'Show'}</button>
      </span>
    </label>
    <p className="ai-key-status" data-testid="ai-has-key">{statusText(config, provider)}{hasSavedKey && saved?.keySource === 'keychain' ? savedDetail : ''}</p>
    {provider === 'openrouter' && !hasSavedKey && <p className="ai-settings-hint">Stored in macOS Keychain by TnT. After saving it is never shown again. <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Get a key</a></p>}
    <label className="ai-field">Model ID
      <span className="ai-key-row">
        <input aria-label="Model" aria-controls={listId} aria-expanded={catalog.open && catalog.provider === provider} role="combobox" value={slice.model} spellCheck={false} placeholder="vendor/model" aria-invalid={modelProblem ? true : undefined} onChange={event => { write(provider, {model: event.target.value, modelDirty: true}); setCatalog(current => ({...current, query: event.target.value})); }} onKeyDown={event => { if (event.key === 'Escape') setCatalog(current => ({...current, open: false})); }} />
        <button type="button" className="ai-settings-text" aria-label="Browse models" onClick={() => void loadCatalog(provider)}>Browse</button>
      </span>
    </label>
    {catalog.open && catalog.provider === provider && <div className="ai-catalog" id={listId}>
      {catalog.failed && <p className="ai-settings-error" role="alert">✕ Couldn&apos;t load the model list. You can still type any model ID; it is used exactly as typed. <button type="button" className="ai-settings-text" onClick={() => void loadCatalog(provider)}>Try again</button></p>}
      {!catalog.failed && matches.map(item => <button type="button" key={item.id} className="ai-catalog-row" onClick={() => { write(provider, {model: item.id, modelDirty: true}); setCatalog(current => ({...current, open: false})); }}>{item.id}</button>)}
      {!catalog.failed && !matches.length && <p className="ai-settings-hint">No catalog match. The typed model ID is kept.</p>}
    </div>}
    {modelProblem && <p className="ai-settings-error" role="alert">{modelProblem}</p>}
    <p className="ai-settings-hint">Any model ID. TnT has no allow-list and never picks one for you.</p>
    {visibleTest?.status === 'running' && <p className="ai-settings-hint" role="status">Testing connection… You can keep editing; a newer edit discards this result. Not saved yet.</p>}
    {visibleTest?.status === 'ok' && <p className="ai-test-ok" role="status" data-testid="ai-test-result">{visibleTest.message || `Connected to ${providerName(provider)}. The model hasn't been tested yet.`}</p>}
    {visibleTest?.status === 'ok' && visibleTest.source === 'replacement' && <p className="ai-settings-hint">Not saved yet. The key stays in the field. Press Save to keep it.</p>}
    {visibleTest?.status === 'failed' && <p className="ai-settings-error" role="alert" data-testid="ai-test-result">✕ {testFailure(provider, visibleTest.code, visibleTest.message)}{visibleTest.code === 'AUTH_FAILED' && <> <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Open OpenRouter keys</a></>}</p>}
    {failure && <p className="ai-settings-error" role="alert" data-testid="ai-save-error">✕ {failure}</p>}
    {notice && !failure && <p className="ai-test-ok" role="status">{notice}</p>}
    {!canUseKey && <p className="ai-settings-hint">Add an API key and a model ID to test or save.</p>}
    <div className="ai-settings-actions">
      <button type="button" className="ai-settings-text" data-testid="ai-test-connection" disabled={busy || test?.status === 'running' || !canUseKey || !!urlProblem || !!typedKeyProblem} aria-busy={test?.status === 'running' || undefined} onClick={() => void runTest()}>{visibleTest?.status === 'running' ? 'Testing…' : visibleTest?.status === 'failed' ? 'Test again' : 'Test connection'}</button>
      <button type="button" className="ai-settings-text" data-testid="ai-save" disabled={busy || !canCommit} onClick={() => void save()}>{failure ? 'Retry save' : 'Save'}</button>
      {hasSavedKey && <button type="button" className="ai-settings-danger" data-testid="ai-remove-key" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove key</button>}
    </div>
    {confirmRemove && <div className="ai-remove-confirm" role="group" aria-label={'Remove the saved ' + providerName(provider) + ' key'}>
      <p>Remove the saved {providerName(provider)} key? AI generation stops until you add a key again. Drafts already generated are kept.</p>
      <button type="button" className="ai-settings-danger" data-testid="ai-remove-confirm" disabled={busy} onClick={() => void removeKey()}>Remove key</button>
      <button type="button" className="ai-settings-text" onClick={() => setConfirmRemove(false)}>Keep key</button>
    </div>}
    {sessionOffer && <div className="ai-session-offer" role="group" aria-label="Session-only key">
      <p>Use this key for this session only? Kept in memory until TnT restarts. Forgotten when TnT restarts.</p>
      <button type="button" className="ai-settings-text" data-testid="ai-session-only" onClick={() => { write(provider, {useSession: true}); setSessionOffer(false); void save(); }}>Use for this session</button>
      <button type="button" className="ai-settings-text" onClick={() => setSessionOffer(false)}>Cancel</button>
    </div>}
    {pending && <div className="ai-unsaved" data-testid="ai-unsaved-guard" role="group" aria-label="Unsaved API key">
      <p>You have an unsaved API key. Shown when you close this card or switch provider.</p>
      <button type="button" className="ai-settings-text" onClick={() => void save()}>Save</button>
      <button type="button" className="ai-settings-text" data-testid="ai-discard-key" onClick={discardPending}>Discard</button>
      <button type="button" className="ai-settings-text" onClick={() => setPending(null)}>Keep editing</button>
    </div>}
  </section>;
});
