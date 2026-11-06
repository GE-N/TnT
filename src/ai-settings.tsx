import {forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {AiFlowRequestError, createAiFlowClient, type AiPublicConfig, type CatalogModel, type CopilotStatus, type ProviderId} from './ai-flow-client.js';

type KeyedProviderId = Exclude<ProviderId, 'copilot'>;
const KEYED: KeyedProviderId[] = ['openrouter', 'openai-compatible'];
const PROVIDER_OPTIONS: {id: ProviderId; label: string}[] = [
  {id: 'openrouter', label: 'OpenRouter'},
  {id: 'openai-compatible', label: 'OpenAI-compatible'},
  {id: 'copilot', label: 'GitHub Copilot'},
];

const configListeners = new Set<(config: AiPublicConfig) => void>();

/** Settings Save and the composer share one config snapshot. Keys stay out of this store. */
export function subscribeAiConfig(listener: (config: AiPublicConfig) => void) {
  configListeners.add(listener);
  return () => { configListeners.delete(listener); };
}

export function publishAiConfig(config: AiPublicConfig) {
  if (!config?.providers?.openrouter || !config.providers['openai-compatible']) return;
  for (const listener of configListeners) listener(config);
}

/** Visible provider name. Copilot is never labeled as another provider. */
export function providerLabel(id: ProviderId) {
  if (id === 'copilot') return 'GitHub Copilot';
  if (id === 'openrouter') return 'OpenRouter';
  return 'OpenAI-compatible';
}

const DEFAULT_BASE = 'https://api.openai.com/v1';
const MODEL_PATTERN = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const CATALOG_RENDER_CAP = 80;

function catalogMatch(item: CatalogModel, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return item.id.toLowerCase().includes(needle) || (item.name ?? '').toLowerCase().includes(needle);
}

type Slice = {model: string; baseUrl: string; apiKey: string; editVersion: number; modelDirty: boolean; baseDirty: boolean; revealed: boolean; useSession: boolean};
type CopilotSlice = {model: string; editVersion: number; dirty: boolean};
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
type CopilotView = {kind: 'idle' | 'loading' | 'failed'} | {kind: 'ready'; status: CopilotStatus};

export type AiSettingsHandle = {
  hasUnsavedKey: () => boolean;
  promptClose: () => void;
};

function emptySlice(baseUrl = ''): Slice {
  return {model: '', baseUrl, apiKey: '', editVersion: 0, modelDirty: false, baseDirty: false, revealed: false, useSession: false};
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

function statusText(config: AiPublicConfig | undefined, id: KeyedProviderId) {
  const entry = config?.providers?.[id];
  if (!entry?.configured) return 'No API key saved';
  if (entry.keySource === 'env') return 'API key saved (from TNT_AI_API_KEY, dev only)';
  if (entry.keySource === 'session') return 'API key active · Forgotten when TnT restarts';
  return 'API key saved';
}

function testFailure(id: KeyedProviderId, code?: string, message?: string) {
  const name = providerLabel(id);
  if (code === 'AUTH_FAILED') return 'Key rejected (401). Check you copied the whole key from openrouter.ai/keys, without spaces. Your typed key and any saved key are unchanged.';
  if (code === 'TIMEOUT' || code === 'NETWORK_ERROR') return `Couldn't reach ${name}. Timed out after 15 s, or this Mac is offline. Check the connection and test again. You can still Save without a test.`;
  if (code === 'AI_NOT_CONFIGURED') return 'Add an API key.';
  return message || 'The connection test failed.';
}

function isProviderId(value: string): value is ProviderId {
  return value === 'openrouter' || value === 'openai-compatible' || value === 'copilot';
}

export const AiSettings = forwardRef<AiSettingsHandle, {token: string; focusNonce: number; onCloseCard: () => void}>(function AiSettings({token, focusNonce, onCloseCard}, ref) {
  const client = useMemo(() => createAiFlowClient(token), [token]);
  const keyRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const forms = useRef<Record<KeyedProviderId, Slice>>({openrouter: emptySlice(), 'openai-compatible': emptySlice(DEFAULT_BASE)});
  const copilotRef = useRef<CopilotSlice>({model: 'auto', editVersion: 0, dirty: false});
  const [form, setForm] = useState(forms.current);
  const [copilotForm, setCopilotForm] = useState(copilotRef.current);
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
  const [catalog, setCatalog] = useState<{provider: ProviderId; models: CatalogModel[]; failed: boolean; loading: boolean; query: string; open: boolean}>({provider: 'openrouter', models: [], failed: false, loading: false, query: '', open: false});
  const [copilot, setCopilot] = useState<CopilotView>({kind: 'idle'});
  const [copilotNonce, setCopilotNonce] = useState(0);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const booted = useRef(false);
  const touched = useRef(false);
  const refreshNext = useRef(false);
  const listId = useId();

  function write(id: KeyedProviderId, patch: Partial<Slice>) {
    const next = {...forms.current[id], ...patch};
    forms.current = {...forms.current, [id]: next};
    setForm(forms.current);
  }

  function writeCopilot(patch: Partial<CopilotSlice>) {
    copilotRef.current = {...copilotRef.current, ...patch};
    setCopilotForm(copilotRef.current);
  }

  function unsavedKey() {
    const id = providerRef.current;
    if (id === 'copilot') return false;
    return forms.current[id].apiKey.length > 0;
  }

  useImperativeHandle(ref, () => ({
    hasUnsavedKey: () => unsavedKey(),
    promptClose: () => setPending({kind: 'close'}),
  }), []);

  useEffect(() => {
    let cancelled = false;
    void client.getConfig().then(next => {
      if (cancelled || !next?.providers?.openrouter || !next.providers['openai-compatible']) return;
      setConfig(next);
      const seeded = {...forms.current};
      for (const id of KEYED) {
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
      if (!copilotRef.current.dirty) writeCopilot({model: next.providers.copilot?.model?.trim() || 'auto'});
      publishAiConfig(next);
      if (!booted.current) {
        booted.current = true;
        if (!touched.current && isProviderId(next.selected)) setProvider(next.selected);
      }
    }).catch(() => { /* A missing config leaves the form editable. Save reports the failure. */ });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    if (provider !== 'copilot') return;
    let cancelled = false;
    const refresh = refreshNext.current;
    refreshNext.current = false;
    setCopilot({kind: 'loading'});
    // Status is readiness only. It must not start a generation or a connection test.
    void client.copilotStatus(refresh).then(status => {
      if (!cancelled) setCopilot({kind: 'ready', status});
    }).catch(() => {
      if (!cancelled) setCopilot({kind: 'failed'});
    });
    return () => { cancelled = true; };
  }, [client, provider, copilotNonce]);

  useEffect(() => {
    if (!focusNonce) return;
    if (providerRef.current === 'copilot') selectRef.current?.focus();
    else keyRef.current?.focus();
  }, [focusNonce]);

  useEffect(() => {
    if (!catalog.open || catalog.failed) return;
    searchRef.current?.focus();
  }, [catalog.open, catalog.failed, catalog.provider]);

  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current); }, []);

  const keyed: KeyedProviderId | null = provider === 'copilot' ? null : provider;
  const slice = keyed ? form[keyed] : undefined;
  const saved = keyed ? config?.providers?.[keyed] : undefined;
  const urlProblem = keyed === 'openai-compatible' && slice ? cloudBaseUrlProblem(slice.baseUrl.trim()) : '';
  const typedKeyProblem = slice ? keyProblem(slice.apiKey) : '';
  const modelValue = provider === 'copilot' ? copilotForm.model : (slice?.model ?? '');
  const modelProblem = modelValue.trim() && !MODEL_PATTERN.test(modelValue.trim()) ? 'Provide a model name.' : '';
  const hasSavedKey = !!saved?.configured;
  const canUseKey = provider === 'copilot' ? copilot.kind === 'ready' && copilot.status.signedIn : (slice ? slice.apiKey.length > 0 || hasSavedKey : false);
  const canCommit = provider === 'copilot'
    ? copilot.kind === 'ready' && copilot.status.installed && copilot.status.signedIn && !!copilotForm.model.trim() && !modelProblem
    : !!slice?.model.trim() && !modelProblem && !urlProblem && !typedKeyProblem && (slice.apiKey.length > 0 || hasSavedKey);
  const visibleTest = test && test.provider === provider && test.editVersion === (provider === 'copilot' ? copilotForm.editVersion : slice?.editVersion) && (provider === 'copilot' || test.source === 'replacement' || test.credentialRevision === saved?.credentialRevision) ? test : null;
  const copilotLoading = provider === 'copilot' && (copilot.kind === 'loading' || copilot.kind === 'idle');
  const copilotReady = copilot.kind === 'ready' ? copilot.status : undefined;
  const copilotSignedIn = !!copilotReady?.installed && !!copilotReady.signedIn;
  const actionsDisabled = busy || test?.status === 'running' || copilotLoading;

  function refreshMetadata(next: AiPublicConfig) {
    setConfig(next);
    const seeded = {...forms.current};
    for (const id of KEYED) {
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
    if (!copilotRef.current.dirty) writeCopilot({model: next.providers.copilot?.model?.trim() || copilotRef.current.model || 'auto'});
    publishAiConfig(next);
  }

  function choose(next: ProviderId) {
    touched.current = true;
    if (next === provider) return true;
    if (unsavedKey()) { setPending({kind: 'provider', id: next}); return false; }
    setProvider(next);
    setNotice('');
    setFailure('');
    setConfirmRemove(false);
    setSessionOffer(false);
    setCatalog(current => ({...current, open: false}));
    return true;
  }

  function requestClose() {
    if (unsavedKey()) {
      setPending({kind: 'close'});
      return;
    }
    onCloseCard();
  }

  function discardPending() {
    const id = providerRef.current;
    if (id !== 'copilot') write(id, {apiKey: '', revealed: false});
    const action = pending;
    setPending(null);
    setNotice('');
    if (action?.kind === 'provider') setProvider(action.id);
    if (action?.kind === 'close') onCloseCard();
  }

  async function loadCatalog(id: KeyedProviderId) {
    setCatalog({provider: id, models: [], failed: false, loading: true, query: '', open: true});
    try {
      const result = await client.listModels(id);
      if (!Array.isArray(result?.models)) throw new Error('The model catalog is unavailable.');
      setCatalog(current => current.provider === id && current.open ? {...current, models: result.models, failed: false, loading: false} : current);
    } catch {
      setCatalog(current => current.provider === id && current.open ? {...current, models: [], failed: true, loading: false} : current);
    }
  }

  function openCopilotBrowse() {
    const listed = copilotReady?.models?.length ? copilotReady.models : [{id: 'auto', name: 'Auto'}];
    const models = listed.map(item => ({id: item.id, name: item.name}));
    if (!models.some(item => item.id === 'auto')) models.unshift({id: 'auto', name: 'Auto'});
    setCatalog({provider: 'copilot', models, failed: false, loading: false, query: '', open: true});
  }

  function pickModel(id: string) {
    if (providerRef.current === 'copilot') writeCopilot({model: id, dirty: true, editVersion: copilotRef.current.editVersion + 1});
    else write(providerRef.current, {model: id, modelDirty: true});
    setCatalog(current => ({...current, open: false}));
  }

  async function runCopilotTest() {
    if (test?.status === 'running') return;
    const model = copilotRef.current.model.trim() || 'auto';
    if (!MODEL_PATTERN.test(model)) return;
    const testId = crypto.randomUUID();
    const snapshot: TestRecord = {testId, provider: 'copilot', source: 'stored', editVersion: copilotRef.current.editVersion, credentialRevision: 0, status: 'running'};
    setTest(snapshot);
    setNotice('');
    setFailure('');
    try {
      const result = await client.testConnection({provider: 'copilot', testId, model});
      if (copilotRef.current.editVersion !== snapshot.editVersion) {
        setTest(existing => existing?.testId === testId ? null : existing);
        return;
      }
      setTest({...snapshot, status: result.ok ? 'ok' : 'failed', code: result.code, message: result.message});
    } catch (error) {
      if (copilotRef.current.editVersion !== snapshot.editVersion) {
        setTest(existing => existing?.testId === testId ? null : existing);
        return;
      }
      const code = error instanceof AiFlowRequestError ? error.code : 'NETWORK_ERROR';
      const message = error instanceof Error ? error.message : 'The connection test failed.';
      setTest(existing => existing?.testId === testId ? {...snapshot, status: 'failed', code, message} : existing);
    }
  }

  async function runTest() {
    const id = providerRef.current;
    if (id === 'copilot') return runCopilotTest();
    if (test?.status === 'running' || urlProblem || typedKeyProblem) return;
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

  async function saveCopilot() {
    const meta = configRef.current;
    const model = copilotRef.current.model.trim() || 'auto';
    if (!meta || !MODEL_PATTERN.test(model)) return;
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      const next = await client.putConfig({
        expectedSettingsRevision: meta.settingsRevision,
        selected: 'copilot',
        provider: 'copilot',
        model,
        credential: {action: 'keep'},
      });
      refreshMetadata(next);
      writeCopilot({dirty: false});
      setNotice('Saved');
      const action = pending;
      setPending(null);
      if (action?.kind === 'provider') setProvider(action.id);
      if (action?.kind === 'close') onCloseCard();
    } catch (error) {
      const code = error instanceof AiFlowRequestError ? error.code : '';
      if (code === 'SETTINGS_CHANGED') {
        try { refreshMetadata(await client.getConfig()); } catch { /* The typed model stays either way. */ }
        setFailure('Couldn\u2019t save. Settings changed in another session. Everything you typed is kept. Press Save to try again.');
      } else {
        setFailure('Couldn\u2019t save. The settings service didn\u2019t answer. Everything you typed is kept; the previous saved settings are unchanged.');
      }
    } finally { setBusy(false); }
  }

  async function save(id = providerRef.current) {
    if (id === 'copilot') return saveCopilot();
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
    if (id === 'copilot') return;
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
    if (!keyed) return;
    write(keyed, {apiKey: value, editVersion: (slice?.editVersion ?? 0) + 1, revealed: false});
    setTest(current => current?.provider === provider ? null : current);
    setNotice('');
  }

  function reveal(on: boolean) {
    if (!keyed) return;
    if (revealTimer.current) clearTimeout(revealTimer.current);
    write(keyed, {revealed: on});
    if (on) revealTimer.current = setTimeout(() => {
      const current = providerRef.current;
      if (current !== 'copilot') write(current, {revealed: false});
    }, 8000);
  }

  function checkAgain() {
    refreshNext.current = true;
    setCopilotNonce(value => value + 1);
  }

  const catalogOpen = catalog.open && catalog.provider === provider;
  const matches = catalogOpen && !catalog.failed ? catalog.models.filter(item => catalogMatch(item, catalog.query)) : [];
  const shown = matches.slice(0, CATALOG_RENDER_CAP);
  const hidden = matches.length - shown.length;
  const savedDetail = saved?.keySource === 'keychain' ? ' · macOS Keychain' : '';

  const sheet = <aside className="knowledge-sheet settings-sheet" id="ai-settings" role="dialog" aria-label="Settings" data-testid="ai-settings" data-side-sheet="settings" onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    requestClose();
  }}>
    <header className="knowledge-sheet-head">
      <div className="knowledge-sheet-heading"><h2>Settings</h2></div>
      <button type="button" className="knowledge-sheet-close" aria-label="Close AI settings" data-testid="ai-settings-close" onClick={() => requestClose()}>✕</button>
    </header>
    <div className="knowledge-sheet-body">
      <div className="settings-section">
        <p className="settings-section-title">AI</p>
        <p className="settings-section-hint">All workspaces · this Mac only</p>
      </div>
      <div className="ai-settings">
        <label className="ai-field ai-group">
          <span className="ai-field-label">Provider</span>
          <select ref={selectRef} className="ai-provider-select" aria-label="Provider" data-testid="ai-provider" value={provider} onChange={event => { if (isProviderId(event.target.value)) choose(event.target.value); }}>
            {PROVIDER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        {keyed === 'openai-compatible' && slice && <div className="ai-group">
          <label className="ai-field">
            <span className="ai-field-label">Base URL</span>
            <input aria-label="Base URL" value={slice.baseUrl} spellCheck={false} aria-invalid={urlProblem ? true : undefined} onChange={event => { write('openai-compatible', {baseUrl: event.target.value, baseDirty: true}); setTest(null); }} />
          </label>
          {urlProblem && <p className="ai-settings-error" role="alert">✕ {urlProblem}</p>}
          {!urlProblem && <p className="ai-settings-hint">https only. Saved on this Mac with Save, never sent with each request.</p>}
        </div>}
        {provider === 'copilot' ? <CopilotBody
          view={copilot}
          model={copilotForm.model}
          modelProblem={modelProblem}
          catalog={catalogOpen ? <Catalog catalog={catalog} listId={listId} searchRef={searchRef} shown={shown} hidden={hidden} matches={matches.length} onQuery={query => setCatalog(current => ({...current, query}))} onClose={() => setCatalog(current => ({...current, open: false}))} onPick={pickModel} onRetry={() => openCopilotBrowse()} /> : null}
          listId={listId}
          catalogOpen={catalogOpen}
          actionsDisabled={actionsDisabled}
          canCommit={canCommit}
          test={visibleTest}
          notice={notice}
          failure={failure}
          onModel={value => { writeCopilot({model: value, dirty: true, editVersion: copilotRef.current.editVersion + 1}); setNotice(''); }}
          onBrowse={() => openCopilotBrowse()}
          onCheck={checkAgain}
          onTest={() => void runTest()}
          onSave={() => void save()}
        /> : keyed && slice && <>
          <div className="ai-group">
            <label className="ai-field">
              <span className="ai-field-label">{hasSavedKey && !slice.apiKey ? 'Replace key' : 'API key'}</span>
              <span className="ai-key-row">
                <input ref={keyRef} aria-label="API key" data-testid="ai-api-key" type={slice.revealed ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={slice.apiKey} placeholder={hasSavedKey ? 'Leave blank to keep the saved key' : provider === 'openrouter' ? 'Paste your OpenRouter key' : 'Paste your API key'} onChange={event => onKey(event.target.value)} />
                <button type="button" className="ai-settings-text" aria-label={slice.revealed ? 'Hide API key' : 'Show API key'} onClick={() => reveal(!slice.revealed)}>{slice.revealed ? 'Hide' : 'Show'}</button>
              </span>
            </label>
            <p className="ai-account" data-testid="ai-has-key"><span className={'ai-dot' + (hasSavedKey ? '' : ' is-none')} aria-hidden="true" />{statusText(config, keyed)}{hasSavedKey && saved?.keySource === 'keychain' ? savedDetail : ''}</p>
            {provider === 'openrouter' && !hasSavedKey && <p className="ai-settings-hint">Stored in macOS Keychain by TnT. After saving it is never shown again. <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Get a key</a></p>}
          </div>
          <div className="ai-group">
            <label className="ai-field">
              <span className="ai-field-label">Model</span>
              <span className="ai-key-row">
                <input aria-label="Model" aria-controls={listId} aria-expanded={catalogOpen} role="combobox" value={slice.model} spellCheck={false} placeholder="vendor/model" aria-invalid={modelProblem ? true : undefined} onChange={event => { write(keyed, {model: event.target.value, modelDirty: true}); }} onKeyDown={event => { if (event.key === 'Escape' && catalog.open) { event.preventDefault(); event.stopPropagation(); setCatalog(current => ({...current, open: false})); } }} />
                <button type="button" className="ai-settings-text" aria-label="Browse models" aria-expanded={catalogOpen} onClick={() => void loadCatalog(keyed)}>Browse</button>
              </span>
            </label>
            {catalogOpen && <Catalog catalog={catalog} listId={listId} searchRef={searchRef} shown={shown} hidden={hidden} matches={matches.length} onQuery={query => setCatalog(current => ({...current, query}))} onClose={() => setCatalog(current => ({...current, open: false}))} onPick={pickModel} onRetry={() => void loadCatalog(keyed)} />}
            {modelProblem && <p className="ai-settings-error" role="alert">{modelProblem}</p>}
            <p className="ai-settings-hint">Any model ID. TnT never picks one for you.</p>
          </div>
          {visibleTest?.status === 'running' && <p className="ai-settings-hint" role="status">Testing connection… You can keep editing; a newer edit discards this result. Not saved yet.</p>}
          {visibleTest?.status === 'ok' && <p className="ai-test-ok" role="status" data-testid="ai-test-result">{visibleTest.message || `Connected to ${providerLabel(keyed)}. The model hasn't been tested yet.`}</p>}
          {visibleTest?.status === 'ok' && visibleTest.source === 'replacement' && <p className="ai-settings-hint">Not saved yet. The key stays in the field. Press Save to keep it.</p>}
          {visibleTest?.status === 'failed' && <p className="ai-settings-error" role="alert" data-testid="ai-test-result">✕ {testFailure(keyed, visibleTest.code, visibleTest.message)}{visibleTest.code === 'AUTH_FAILED' && provider === 'openrouter' && <> <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Open OpenRouter keys</a></>}</p>}
          {failure && <p className="ai-settings-error" role="alert" data-testid="ai-save-error">✕ {failure}</p>}
          {notice && !failure && <p className="ai-test-ok" role="status">{notice}</p>}
          {!canUseKey && <p className="ai-settings-hint">Add an API key and a model ID to test or save.</p>}
          <div className="ai-settings-actions">
            <button type="button" className="ai-settings-text" data-testid="ai-test-connection" disabled={actionsDisabled || !canUseKey || !!urlProblem || !!typedKeyProblem} aria-busy={test?.status === 'running' || undefined} onClick={() => void runTest()}>{visibleTest?.status === 'running' ? 'Testing…' : visibleTest?.status === 'failed' ? 'Test again' : 'Test connection'}</button>
            <button type="button" className="ai-settings-text" data-testid="ai-save" disabled={busy || !canCommit} onClick={() => void save()}>{failure ? 'Retry save' : 'Save'}</button>
            {hasSavedKey && <button type="button" className="ai-settings-danger" data-testid="ai-remove-key" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove key</button>}
          </div>
        </>}
        {confirmRemove && keyed && <div className="ai-remove-confirm" role="group" aria-label={'Remove the saved ' + providerLabel(keyed) + ' key'}>
          <p>Remove the saved {providerLabel(keyed)} key? AI generation stops until you add a key again. Drafts already generated are kept.</p>
          <button type="button" className="ai-settings-danger" data-testid="ai-remove-confirm" disabled={busy} onClick={() => void removeKey()}>Remove key</button>
          <button type="button" className="ai-settings-text" onClick={() => setConfirmRemove(false)}>Keep key</button>
        </div>}
        {sessionOffer && keyed && <div className="ai-session-offer" role="group" aria-label="Session-only key">
          <p>Use this key for this session only? Kept in memory until TnT restarts. Forgotten when TnT restarts.</p>
          <button type="button" className="ai-settings-text" data-testid="ai-session-only" onClick={() => { write(keyed, {useSession: true}); setSessionOffer(false); void save(); }}>Use for this session</button>
          <button type="button" className="ai-settings-text" onClick={() => setSessionOffer(false)}>Cancel</button>
        </div>}
        {pending && <div className="ai-unsaved" data-testid="ai-unsaved-guard" role="group" aria-label="Unsaved API key">
          <p>You have an unsaved API key. Shown when you close this sheet or switch provider.</p>
          <button type="button" className="ai-settings-text" onClick={() => void save()}>Save</button>
          <button type="button" className="ai-settings-text" data-testid="ai-discard-key" onClick={discardPending}>Discard</button>
          <button type="button" className="ai-settings-text" onClick={() => setPending(null)}>Keep editing</button>
        </div>}
      </div>
    </div>
  </aside>;
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
});

function Catalog({catalog, listId, searchRef, shown, hidden, matches, onQuery, onClose, onPick, onRetry}: {
  catalog: {failed: boolean; loading: boolean; query: string};
  listId: string;
  searchRef: {current: HTMLInputElement | null};
  shown: CatalogModel[];
  hidden: number;
  matches: number;
  onQuery: (query: string) => void;
  onClose: () => void;
  onPick: (id: string) => void;
  onRetry: () => void;
}) {
  return <div className="ai-catalog" id={listId}>
    {catalog.failed && <p className="ai-settings-error" role="alert" data-testid="ai-catalog-failed">✕ Couldn&apos;t load the model list. You can still type any model ID; it is used exactly as typed. <button type="button" className="ai-settings-text" onClick={onRetry}>Try again</button></p>}
    {!catalog.failed && <input ref={searchRef} aria-label="Search models" value={catalog.query} spellCheck={false} placeholder="Search by name or id" onChange={event => onQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }} />}
    {!catalog.failed && shown.map((item, index) => <button type="button" key={item.id + ':' + index} className="ai-catalog-row" data-model-id={item.id} onClick={() => onPick(item.id)}>{item.id}{item.name ? <span className="ai-catalog-name">{item.name}</span> : null}</button>)}
    {!catalog.failed && hidden > 0 && <p className="ai-catalog-more" data-testid="ai-catalog-more">{hidden} more — keep typing</p>}
    {!catalog.failed && !catalog.loading && !matches && <p className="ai-settings-hint">No catalog match. The typed model ID is kept.</p>}
  </div>;
}

function CopilotBody({view, model, modelProblem, catalog, listId, catalogOpen, actionsDisabled, canCommit, test, notice, failure, onModel, onBrowse, onCheck, onTest, onSave}: {
  view: CopilotView;
  model: string;
  modelProblem: string;
  catalog: ReactNode;
  listId: string;
  catalogOpen: boolean;
  actionsDisabled: boolean;
  canCommit: boolean;
  test: TestRecord | null;
  notice: string;
  failure: string;
  onModel: (value: string) => void;
  onBrowse: () => void;
  onCheck: () => void;
  onTest: () => void;
  onSave: () => void;
}) {
  const loading = view.kind === 'loading' || view.kind === 'idle';
  const failed = view.kind === 'failed';
  const status = view.kind === 'ready' ? view.status : undefined;
  const signedIn = !!status?.installed && status.signedIn;
  const missing = !!status && !status.installed;
  const signedOut = !!status?.installed && !status.signedIn;
  let statusLine: ReactNode = 'Checking Copilot…';
  if (failed) statusLine = <span className="ai-copilot-muted">Couldn’t check Copilot.</span>;
  else if (missing) statusLine = <>Copilot isn’t installed.</>;
  else if (signedOut) statusLine = <><span className="ai-dot is-off" aria-hidden="true" />Not signed in to Copilot</>;
  else if (signedIn) statusLine = <><span className="ai-dot" aria-hidden="true" />{status?.login ? `Signed in as ${status.login}` : 'Signed in to Copilot'}</>;
  const hint = loading ? ''
    : failed ? ''
    : missing ? <>Run <code className="ai-code">bash scripts/setup.sh</code>, then press Check again.</>
    : signedOut ? <>Run <code className="ai-code">copilot login</code> in Terminal, then press Check again.</>
    : 'Uses your company’s Copilot seat. No API key needed.';
  const showModel = signedIn && !loading && !failed;
  const showCheck = !loading && !signedIn;
  return <>
    <div className="ai-group ai-copilot-block">
      <p className={'ai-account' + (loading ? ' is-checking' : '')} data-testid="ai-copilot-status" role="status">{statusLine}</p>
      {(loading || hint) && <p className="ai-settings-hint">{loading ? ' ' : hint}</p>}
    </div>
    {showModel && <div className="ai-group">
      <label className="ai-field">
        <span className="ai-field-label">Model</span>
        <span className="ai-key-row">
          <input aria-label="Model" aria-controls={listId} aria-expanded={catalogOpen} role="combobox" value={model} spellCheck={false} aria-invalid={modelProblem ? true : undefined} onChange={event => onModel(event.target.value)} />
          <button type="button" className="ai-settings-text" aria-label="Browse models" aria-expanded={catalogOpen} disabled={actionsDisabled} onClick={onBrowse}>Browse</button>
        </span>
      </label>
      {catalog}
      {modelProblem && <p className="ai-settings-error" role="alert">{modelProblem}</p>}
      <p className="ai-settings-hint">auto lets Copilot choose. Browse lists the models your company allows.</p>
    </div>}
    {test?.status === 'running' && <p className="ai-settings-hint" role="status">Testing connection… Not saved yet.</p>}
    {test?.status === 'ok' && <p className="ai-test-ok" role="status" data-testid="ai-test-result">{test.message || 'Connected to GitHub Copilot.'}</p>}
    {test?.status === 'failed' && <p className="ai-settings-error" role="alert" data-testid="ai-test-result">{test.message || 'The connection test failed.'}</p>}
    {failure && <p className="ai-settings-error" role="alert" data-testid="ai-save-error">✕ {failure}</p>}
    {notice && !failure && <p className="ai-test-ok" role="status">{notice}</p>}
    <div className="ai-settings-actions">
      {loading ? <button type="button" className="ai-settings-text" disabled>Check again</button>
        : showCheck ? <button type="button" className="ai-settings-text" data-testid="ai-copilot-check" disabled={actionsDisabled} onClick={onCheck}>Check again</button> : <>
        <button type="button" className="ai-settings-text" data-testid="ai-test-connection" disabled={actionsDisabled || !canCommit} aria-busy={test?.status === 'running' || undefined} onClick={onTest}>{test?.status === 'running' ? 'Testing…' : test?.status === 'failed' ? 'Test again' : 'Test connection'}</button>
        <button type="button" className="ai-settings-text" data-testid="ai-save" disabled={actionsDisabled || !canCommit} onClick={onSave}>{failure ? 'Retry save' : 'Save'}</button>
      </>}
    </div>
  </>;
}
