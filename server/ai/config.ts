import {chmod, mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {AiHttpError} from './errors.js';
import {createKeychainStore, type SecretStore} from './keychain.js';
import {formatAiLog} from './log.js';
import {fetchModelCatalog, OPENROUTER_BASE_URL, PROBE_TIMEOUT_MS, probeKey, providerEndpoint, type AiModelInfo, type ProviderId} from './probe.js';
import {createCopilotSdkProvider} from './providers/copilot-sdk.js';
import {COPILOT_NOT_INSTALLED, classifyCopilotFailure, redactCopilotText, sharedCopilotRuntime, type CopilotAuth, type CopilotErrorKind, type CopilotModel, type CopilotRuntime} from './providers/copilot-runtime.js';
import {createOpenAiCompatibleProvider} from './providers/openai-compatible.js';
import {isAbortError, type FlowModelProvider} from './providers/types.js';

export type {SecretStore};
export {createKeychainStore};
export type {AiModelInfo, ProviderId};

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const CATALOG_TTL_MS = 15 * 60 * 1000;

export type KeySource = 'keychain' | 'session' | 'env';
export type StorageKind = 'keychain' | 'session';

export type AiProviderSettings = {
  model: string;
  baseUrl?: string;
  configured: boolean;
  keySource?: KeySource;
  credentialRevision: number;
  storageAvailable: boolean;
};

export type CopilotPublicSettings = {model: string};

export type AiPublicConfig = {
  settingsRevision: number;
  selected: ProviderId;
  providers: {
    openrouter: AiProviderSettings;
    'openai-compatible': AiProviderSettings;
    copilot: CopilotPublicSettings;
  };
};

export type AiTestResult = {testId: string; ok: boolean; code?: string; message?: string; model?: string};

export type CopilotStatus = {
  installed: boolean;
  signedIn: boolean;
  models: {id: string; name: string}[];
  login?: string;
  via?: 'copilot-login' | 'gh-cli' | 'env';
};

const COPILOT_STATUS_TTL_MS = 60_000;
const COPILOT_TEST_PROMPT = 'Reply with just: OK';
const COPILOT_TEST_SYSTEM = 'Connection check.';
const COPILOT_SIGNED_OUT = "Copilot isn't signed in.";

type KeyedProviderId = Exclude<ProviderId, 'copilot'>;
type ProviderFile = {model: string; baseUrl?: string; credentialRevision: number; storage?: StorageKind};
type CopilotFile = {model: string};
type FileConfig = {
  settingsRevision: number;
  selected: ProviderId;
  providers: {openrouter: ProviderFile; 'openai-compatible': ProviderFile; copilot: CopilotFile};
};
type CredentialAction =
  | {action: 'keep'}
  | {action: 'replace'; apiKey: string; storage: StorageKind}
  | {action: 'remove'};
type PutBody = {
  expectedSettingsRevision: number;
  selected: ProviderId;
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  credential: CredentialAction;
};
type TestBody =
  | {provider: KeyedProviderId; testId: string; source: 'stored'; credentialRevision: number}
  | {provider: KeyedProviderId; testId: string; source: 'replacement'; apiKey: string}
  | {provider: 'copilot'; testId: string; model?: string};
type Snapshot = {session?: string; keychain?: string};

export function secretService(provider: string) {
  return `tnt.ai.${provider}`;
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

/** Comma-separated hostnames, or https URLs whose host is taken. http entries are ignored. Default is empty, so private hosts stay blocked. */
export const BASE_URL_ALLOWLIST_ENV = 'TNT_AI_BASE_URL_ALLOWLIST';

export function cloudBaseUrlAllowlist(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[BASE_URL_ALLOWLIST_ENV];
  if (typeof raw !== 'string') return [];
  const hosts: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes('://')) {
      let parsed: URL;
      try { parsed = new URL(trimmed); }
      catch { continue; }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) continue;
      hosts.push(parsed.hostname.toLowerCase());
      continue;
    }
    const host = trimmed.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || /[\s/?#@:]/.test(host) || host.includes('..')) continue;
    hosts.push(host);
  }
  return hosts;
}

export function assertCloudBaseUrl(value: string, allowlist: readonly string[] = []) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an https cloud base URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an https cloud base URL.');
  const allowed = allowlist.some(host => host.toLowerCase() === url.hostname.toLowerCase());
  if (!allowed && isPrivateHost(url.hostname)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Local endpoints are not available. Use an https cloud base URL.');
  return url.toString().replace(/\/$/, '');
}

function assertModel(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:/@+-]{1,200}$/.test(value)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide a model name.');
  return value;
}

function assertSelectable(value: unknown): ProviderId {
  if (value === 'copilot') return 'copilot';
  return assertProviderId(value);
}

function assertProviderId(value: unknown): KeyedProviderId {
  if (value === 'ollama' || value === 'local' || value === 'lmstudio') throw new AiHttpError(400, 'INVALID_CONFIG', 'Local model providers are not available in this version.');
  if (value === 'anthropic') throw new AiHttpError(400, 'INVALID_CONFIG', 'Anthropic is not available in this version.');
  if (value !== 'openrouter' && value !== 'openai-compatible') throw new AiHttpError(400, 'INVALID_CONFIG', 'Choose OpenRouter or an OpenAI-compatible provider.');
  return value;
}

function assertKey(value: string) {
  if (!value || value.length > 2_000 || /[\u0000-\u001F\u007F]/.test(value) || value.startsWith('-')) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an API key.');
  return value;
}

function assertTestId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(value)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide a test id.');
  return value;
}

function revisionOf(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 0;
}

function knownKeys(record: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new AiHttpError(400, 'INVALID_CONFIG', 'Unknown AI config field.');
}

function parseCredential(value: unknown): CredentialAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide a credential action.');
  const body = value as Record<string, unknown>;
  if (body.action === 'keep' || body.action === 'remove') {
    knownKeys(body, ['action']);
    return {action: body.action};
  }
  if (body.action === 'replace') {
    knownKeys(body, ['action', 'apiKey', 'storage']);
    if (typeof body.apiKey !== 'string' || body.apiKey.trim() === '') throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an API key.');
    if (body.storage !== 'keychain' && body.storage !== 'session') throw new AiHttpError(400, 'INVALID_CONFIG', 'Choose keychain or session storage.');
    return {action: 'replace', apiKey: assertKey(body.apiKey), storage: body.storage};
  }
  throw new AiHttpError(400, 'INVALID_CONFIG', 'Choose keep, replace, or remove for the API key.');
}

function parsePut(input: unknown, allowlist: readonly string[] = []): PutBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide AI config.');
  const body = input as Record<string, unknown>;
  knownKeys(body, ['expectedSettingsRevision', 'selected', 'provider', 'model', 'baseUrl', 'credential']);
  if (!Number.isInteger(body.expectedSettingsRevision) || (body.expectedSettingsRevision as number) < 0) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide the settings revision.');
  const selected = assertSelectable(body.selected);
  if (body.provider === 'copilot') {
    if (body.baseUrl !== undefined) throw new AiHttpError(400, 'INVALID_CONFIG', 'Copilot does not take a base URL.');
    const credential = parseCredential(body.credential);
    if (credential.action !== 'keep') throw new AiHttpError(400, 'INVALID_CONFIG', 'Copilot does not take an API key.');
    return {expectedSettingsRevision: body.expectedSettingsRevision as number, selected, provider: 'copilot', model: assertModel(body.model), credential};
  }
  const provider = assertProviderId(body.provider);
  const model = assertModel(body.model);
  let baseUrl: string | undefined;
  if (provider === 'openrouter') {
    if (body.baseUrl !== undefined) throw new AiHttpError(400, 'INVALID_CONFIG', 'OpenRouter uses a fixed base URL.');
  } else baseUrl = assertCloudBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '', allowlist);
  return {expectedSettingsRevision: body.expectedSettingsRevision as number, selected, provider, model, baseUrl, credential: parseCredential(body.credential)};
}

function parseTest(input: unknown): TestBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide a connection test.');
  const body = input as Record<string, unknown>;
  if (body.provider === 'copilot') {
    knownKeys(body, ['provider', 'testId', 'model']);
    const testId = assertTestId(body.testId);
    if (body.model === undefined) return {provider: 'copilot', testId};
    return {provider: 'copilot', testId, model: assertModel(body.model)};
  }
  const provider = assertProviderId(body.provider);
  const testId = assertTestId(body.testId);
  if (body.source === 'stored') {
    knownKeys(body, ['provider', 'testId', 'source', 'credentialRevision']);
    if (!Number.isInteger(body.credentialRevision) || (body.credentialRevision as number) < 0) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide the saved credential revision.');
    return {provider, testId, source: 'stored', credentialRevision: body.credentialRevision as number};
  }
  if (body.source === 'replacement') {
    knownKeys(body, ['provider', 'testId', 'source', 'apiKey']);
    if (typeof body.apiKey !== 'string' || body.apiKey.trim() === '') throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an API key.');
    return {provider, testId, source: 'replacement', apiKey: assertKey(body.apiKey)};
  }
  throw new AiHttpError(400, 'INVALID_CONFIG', 'Choose a stored or replacement key to test.');
}

function emptyFile(): FileConfig {
  return {
    settingsRevision: 0,
    selected: 'openrouter',
    providers: {
      openrouter: {model: '', credentialRevision: 0},
      'openai-compatible': {model: '', baseUrl: DEFAULT_BASE_URL, credentialRevision: 0},
      copilot: {model: 'auto'},
    },
  };
}

function copilotFile(value: unknown): CopilotFile {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const model = typeof record.model === 'string' && record.model ? record.model : 'auto';
  return {model};
}

function providerFile(provider: KeyedProviderId, value: unknown): ProviderFile {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const storage = record.storage === 'keychain' || record.storage === 'session' ? record.storage : undefined;
  const entry: ProviderFile = {model: typeof record.model === 'string' ? record.model : '', credentialRevision: revisionOf(record.credentialRevision), ...(storage ? {storage} : {})};
  if (provider === 'openai-compatible') entry.baseUrl = typeof record.baseUrl === 'string' && record.baseUrl ? record.baseUrl : DEFAULT_BASE_URL;
  return entry;
}

function fileJson(config: FileConfig) {
  const provider = (id: KeyedProviderId, entry: ProviderFile) => {
    const record: Record<string, unknown> = {model: entry.model};
    if (id === 'openai-compatible') record.baseUrl = entry.baseUrl ?? DEFAULT_BASE_URL;
    record.credentialRevision = entry.credentialRevision;
    if (entry.storage) record.storage = entry.storage;
    return record;
  };
  return JSON.stringify({
    settingsRevision: config.settingsRevision,
    selected: config.selected,
    providers: {
      openrouter: provider('openrouter', config.providers.openrouter),
      'openai-compatible': provider('openai-compatible', config.providers['openai-compatible']),
      copilot: {model: config.providers.copilot.model || 'auto'},
    },
  });
}

function nextFile(current: FileConfig, body: PutBody): FileConfig {
  const providers: FileConfig['providers'] = {
    openrouter: {...current.providers.openrouter},
    'openai-compatible': {...current.providers['openai-compatible']},
    copilot: {model: current.providers.copilot.model || 'auto'},
  };
  if (body.provider === 'copilot') providers.copilot = {model: body.model};
  else {
    const target = providers[body.provider];
    target.model = body.model;
    if (body.provider === 'openai-compatible' && body.baseUrl) target.baseUrl = body.baseUrl;
    if (body.credential.action === 'replace') {
      target.credentialRevision += 1;
      target.storage = body.credential.storage;
    } else if (body.credential.action === 'remove') {
      target.credentialRevision += 1;
      delete target.storage;
    }
  }
  return {settingsRevision: current.settingsRevision + 1, selected: body.selected, providers};
}

function orderedCopilotModels(models: CopilotModel[]): {id: string; name: string}[] {
  const auto = models.find(model => model.id === 'auto' && model.enabled);
  const rest: {id: string; name: string}[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!model.enabled || !model.id || model.id === 'auto' || seen.has(model.id)) continue;
    seen.add(model.id);
    rest.push({id: model.id, name: model.name || model.id});
  }
  return [{id: 'auto', name: auto?.name || 'Auto'}, ...rest];
}

function copilotLogin(login: string | undefined) {
  if (typeof login !== 'string') return;
  if (/(?:gho_|ghu_|ghp_|github_pat_)/.test(login)) return;
  const cleaned = login.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!cleaned) return;
  return cleaned.slice(0, 200);
}

function copilotVia(via: CopilotAuth['via']): CopilotStatus['via'] {
  if (via === 'copilot-login' || via === 'gh-cli' || via === 'env') return via;
  return;
}

function statusFromAuth(auth: CopilotAuth, models: CopilotModel[]): CopilotStatus {
  if (auth.message === COPILOT_NOT_INSTALLED) return {installed: false, signedIn: false, models: []};
  if (!auth.signedIn) return {installed: true, signedIn: false, models: []};
  const body: CopilotStatus = {installed: true, signedIn: true, models: orderedCopilotModels(models)};
  const login = copilotLogin(auth.login);
  if (login) body.login = login;
  const via = copilotVia(auth.via);
  if (via) body.via = via;
  return body;
}

function signedOutMessage(message: string | undefined) {
  if (!message) return COPILOT_SIGNED_OUT;
  const classified = classifyCopilotFailure({message});
  if (classified.kind === 'not-signed-in') return classified.message;
  const redacted = redactCopilotText(message).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 300);
  return redacted || COPILOT_SIGNED_OUT;
}

function copilotTestFailure(event: {kind: CopilotErrorKind; message: string}): {code: string; message: string} {
  const message = redactCopilotText(event.message).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 300);
  if (event.kind === 'not-signed-in') return {code: 'NOT_SIGNED_IN', message: message || COPILOT_SIGNED_OUT};
  if (event.kind === 'policy-off') return {code: 'POLICY_OFF', message: message || 'Copilot is off for this account.'};
  if (event.kind === 'no-seat') return {code: 'NO_SEAT', message: message || 'This account has no Copilot license.'};
  if (event.kind === 'model-unavailable') return {code: 'MODEL_UNAVAILABLE', message: message || 'The model is not available at this provider.'};
  if (event.kind === 'rate-limit') return {code: 'RATE_LIMITED', message: 'The provider rate limit was reached.'};
  return {code: 'NETWORK_ERROR', message: 'The provider could not be reached.'};
}

function planMessage(model: string) {
  return `‘${model}’ isn’t on your Copilot plan.`;
}

export function createAiConfig(deps: {root: string; env?: NodeJS.ProcessEnv; secrets?: SecretStore; fetch?: typeof fetch; log?: (line: string) => void; now?: () => number; dev?: boolean; copilotRuntime?: CopilotRuntime; probeTimeoutMs?: number}) {
  const env = deps.env ?? process.env;
  const secrets = deps.secrets ?? createKeychainStore();
  const fetchImpl = deps.fetch ?? fetch;
  const log = deps.log ?? ((line: string) => console.info(line));
  const now = deps.now ?? Date.now;
  const file = join(deps.root, 'ai-config.json');
  const sessionKeys = new Map<KeyedProviderId, string>();
  const catalogCache = new Map<string, {at: number; models: AiModelInfo[]}>();
  const inflight = new Set<{provider: KeyedProviderId; abort: () => void}>();
  let pending: Promise<unknown> = Promise.resolve();
  let statusCache: {at: number; body: CopilotStatus} | undefined;

  function copilotRuntime() {
    return deps.copilotRuntime ?? sharedCopilotRuntime(join(deps.root, 'copilot'));
  }

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = pending.then(work, work);
    pending = run.then(() => undefined, () => undefined);
    return run;
  }

  function devMode() {
    if (deps.dev !== undefined) return deps.dev;
    if (env.NODE_ENV === 'production') return false;
    return !process.argv.includes('--production');
  }

  function devKey() {
    if (!devMode()) return;
    const value = env.TNT_AI_API_KEY;
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001F\u007F]/.test(value)) return;
    return value;
  }

  async function readSecret(service: string) {
    try { return (await secrets.get(service)) || undefined; }
    catch { return undefined; }
  }

  async function readFileConfig(): Promise<FileConfig> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(file, 'utf8')) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw new AiHttpError(500, 'CONFIG_UNREADABLE', 'AI config is unreadable.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyFile();
    const record = parsed as Record<string, unknown>;
    const blank = emptyFile();
    if (!record.providers || typeof record.providers !== 'object' || Array.isArray(record.providers)) {
      if (record.provider === undefined && record.model === undefined && record.baseUrl === undefined) return blank;
      const provider: KeyedProviderId = record.provider === 'openrouter' ? 'openrouter' : 'openai-compatible';
      const model = typeof record.model === 'string' ? record.model : '';
      const baseUrl = typeof record.baseUrl === 'string' && record.baseUrl ? record.baseUrl : DEFAULT_BASE_URL;
      if (provider === 'openrouter') blank.providers.openrouter = {model, credentialRevision: 0};
      else blank.providers['openai-compatible'] = {model, baseUrl, credentialRevision: 0};
      blank.selected = provider;
      return blank;
    }
    const providers = record.providers as Record<string, unknown>;
    return {
      settingsRevision: revisionOf(record.settingsRevision),
      selected: record.selected === 'openrouter' || record.selected === 'openai-compatible' || record.selected === 'copilot' ? record.selected : 'openrouter',
      providers: {
        openrouter: providerFile('openrouter', providers.openrouter),
        'openai-compatible': providerFile('openai-compatible', providers['openai-compatible']),
        copilot: copilotFile(providers.copilot),
      },
    };
  }

  async function writeFileConfig(config: FileConfig) {
    await mkdir(deps.root, {recursive: true});
    const temporary = join(deps.root, `${randomUUID()}.ai-config.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(fileJson(config));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally {
      await handle?.close();
      await rm(temporary, {force: true});
    }
  }

  /** A removed provider (revision bumped, no storage) stays unconfigured, even when the dev env key is set. */
  async function resolveKey(provider: KeyedProviderId, entry: ProviderFile): Promise<{key: string; source: KeySource} | undefined> {
    if (entry.storage === 'session') {
      const key = sessionKeys.get(provider);
      return key ? {key, source: 'session'} : undefined;
    }
    if (entry.storage === 'keychain' || entry.credentialRevision === 0) {
      const key = await readSecret(secretService(provider));
      if (key) return {key, source: 'keychain'};
      if (entry.storage === 'keychain') return;
    }
    if (entry.credentialRevision > 0) return;
    const key = devKey();
    return key ? {key, source: 'env'} : undefined;
  }

  async function snapshotCredential(provider: KeyedProviderId): Promise<Snapshot> {
    return {session: sessionKeys.get(provider), keychain: await readSecret(secretService(provider))};
  }

  async function restoreCredential(provider: KeyedProviderId, snapshot: Snapshot) {
    if (snapshot.session) sessionKeys.set(provider, snapshot.session);
    else sessionKeys.delete(provider);
    const service = secretService(provider);
    if (snapshot.keychain) await secrets.set(service, snapshot.keychain);
    else await secrets.delete(service);
  }

  async function applyCredential(provider: KeyedProviderId, credential: CredentialAction) {
    if (credential.action === 'keep') return;
    const service = secretService(provider);
    if (credential.action === 'remove') {
      sessionKeys.delete(provider);
      await secrets.delete(service);
      if (await readSecret(service)) throw new AiHttpError(500, 'CREDENTIAL_STORAGE_FAILED', 'The API key could not be removed from the Keychain.');
      return;
    }
    if (credential.storage === 'session') {
      sessionKeys.set(provider, credential.apiKey);
      await secrets.delete(service);
      if (await readSecret(service)) throw new AiHttpError(500, 'CREDENTIAL_STORAGE_FAILED', 'The API key could not be removed from the Keychain.');
      return;
    }
    await secrets.set(service, credential.apiKey);
    sessionKeys.delete(provider);
  }

  async function storageAvailable() {
    if (!secrets.available) return true;
    try { return await secrets.available(); }
    catch { return false; }
  }

  async function loadCopilotStatus(): Promise<CopilotStatus> {
    let auth: CopilotAuth;
    try { auth = await copilotRuntime().authStatus(); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === COPILOT_NOT_INSTALLED || /cannot find package '@github\/copilot-sdk'|cannot find module '@github\/copilot-sdk'/i.test(message)) {
        return {installed: false, signedIn: false, models: []};
      }
      return {installed: true, signedIn: false, models: []};
    }
    if (auth.message === COPILOT_NOT_INSTALLED || !auth.signedIn) return statusFromAuth(auth, []);
    let models: CopilotModel[] = [];
    try { models = await copilotRuntime().models(); }
    catch { models = []; }
    return statusFromAuth(auth, models);
  }

  async function copilotStatus(refresh: string | null): Promise<CopilotStatus> {
    if (refresh !== '1' && statusCache && now() - statusCache.at < COPILOT_STATUS_TTL_MS) return statusCache.body;
    const body = await loadCopilotStatus();
    statusCache = {at: now(), body};
    return body;
  }

  async function anyKeyedKey(config: FileConfig) {
    if (await resolveKey('openrouter', config.providers.openrouter)) return true;
    return Boolean(await resolveKey('openai-compatible', config.providers['openai-compatible']));
  }

  async function maybeAutoSelect() {
    const current = await readFileConfig();
    if (current.settingsRevision !== 0) return;
    if (await anyKeyedKey(current)) return;
    const status = await copilotStatus(null);
    if (!status.installed || !status.signedIn) return;
    await exclusive(async () => {
      const latest = await readFileConfig();
      if (latest.settingsRevision !== 0) return;
      if (await anyKeyedKey(latest)) return;
      await writeFileConfig({
        settingsRevision: latest.settingsRevision + 1,
        selected: 'copilot',
        providers: {
          openrouter: {...latest.providers.openrouter},
          'openai-compatible': {...latest.providers['openai-compatible']},
          copilot: {model: 'auto'},
        },
      });
    });
  }

  async function publicConfig(): Promise<AiPublicConfig> {
    const config = await readFileConfig();
    const available = await storageAvailable();
    const one = async (provider: KeyedProviderId): Promise<AiProviderSettings> => {
      const entry = config.providers[provider];
      const resolved = await resolveKey(provider, entry);
      const settings: AiProviderSettings = {
        model: entry.model,
        configured: resolved?.source === 'keychain' || resolved?.source === 'session',
        credentialRevision: entry.credentialRevision,
        storageAvailable: available,
      };
      if (provider === 'openai-compatible') settings.baseUrl = entry.baseUrl ?? DEFAULT_BASE_URL;
      if (resolved) settings.keySource = resolved.source;
      return settings;
    };
    return {
      settingsRevision: config.settingsRevision,
      selected: config.selected,
      providers: {
        openrouter: await one('openrouter'),
        'openai-compatible': await one('openai-compatible'),
        copilot: {model: config.providers.copilot.model || 'auto'},
      },
    };
  }

  function bindRemoval(provider: KeyedProviderId) {
    return (abort: () => void) => {
      const entry = {provider, abort};
      inflight.add(entry);
      return () => { inflight.delete(entry); };
    };
  }

  function abortInflight(provider: KeyedProviderId) {
    for (const entry of [...inflight]) if (entry.provider === provider) entry.abort();
  }

  async function settingsRevision() {
    return (await readFileConfig()).settingsRevision;
  }

  async function connect(): Promise<{provider: FlowModelProvider; model: string; providerId: ProviderId; bindRemoval: (abort: () => void) => () => void}> {
    await maybeAutoSelect();
    const config = await readFileConfig();
    const selected = config.selected;
    if (selected === 'copilot') {
      const model = config.providers.copilot.model || 'auto';
      return {
        model,
        providerId: 'copilot',
        bindRemoval: () => () => {},
        provider: createCopilotSdkProvider({runtime: copilotRuntime(), model}),
      };
    }
    const entry = config.providers[selected];
    if (!entry.model) throw new AiHttpError(400, 'PROVIDER_CONFIG', 'Choose a model.');
    let baseUrl = OPENROUTER_BASE_URL;
    if (selected !== 'openrouter') {
      try { baseUrl = assertCloudBaseUrl(entry.baseUrl ?? '', cloudBaseUrlAllowlist(env)); }
      catch (error) {
        if (error instanceof AiHttpError) throw new AiHttpError(400, 'PROVIDER_CONFIG', error.message);
        throw error;
      }
    }
    const resolved = await resolveKey(selected, entry);
    if (!resolved) throw new AiHttpError(400, 'PROVIDER_CONFIG', 'Add an API key.');
    return {
      model: entry.model,
      providerId: selected,
      bindRemoval: bindRemoval(selected),
      provider: createOpenAiCompatibleProvider({baseUrl, model: entry.model, apiKey: resolved.key, fetch: deps.fetch, preset: selected}),
    };
  }

  async function put(input: unknown): Promise<AiPublicConfig> {
    const body = parsePut(input, cloudBaseUrlAllowlist(env));
    return exclusive(async () => {
      const current = await readFileConfig();
      if (body.expectedSettingsRevision !== current.settingsRevision) throw new AiHttpError(409, 'SETTINGS_CHANGED', 'Settings changed in another session. Refresh and try again.');
      const next = nextFile(current, body);
      if (body.provider === 'copilot') {
        await writeFileConfig(next);
        return publicConfig();
      }
      if (body.credential.action === 'keep' && !next.providers[body.provider].storage) {
        if (sessionKeys.has(body.provider)) next.providers[body.provider].storage = 'session';
        else if (await readSecret(secretService(body.provider))) next.providers[body.provider].storage = 'keychain';
      }
      const snapshot = await snapshotCredential(body.provider);
      try {
        await applyCredential(body.provider, body.credential);
        await writeFileConfig(next);
        if (body.credential.action === 'remove') abortInflight(body.provider);
      } catch (error) {
        try { await restoreCredential(body.provider, snapshot); }
        catch { /* the original failure is the one the caller can act on */ }
        throw error;
      }
      return publicConfig();
    });
  }

  async function testCopilot(body: {testId: string; model?: string}): Promise<AiTestResult> {
    const started = now();
    const finish = (result: Omit<AiTestResult, 'testId'>, loggedModel: string) => {
      log(formatAiLog({
        provider: 'copilot',
        model: loggedModel,
        durationMs: Math.max(0, now() - started),
        contractVersion: 1,
        diagnosticCodes: result.ok ? [] : [result.code ?? 'check_failed'],
        outcome: result.ok ? 'check_ok' : 'check_failed',
      }));
      return {testId: body.testId, ...result};
    };
    const config = await readFileConfig();
    const model = body.model ?? (config.providers.copilot.model || 'auto');
    let auth: CopilotAuth;
    try { auth = await copilotRuntime().authStatus(); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === COPILOT_NOT_INSTALLED || /cannot find package '@github\/copilot-sdk'|cannot find module '@github\/copilot-sdk'/i.test(message)) {
        return finish({ok: false, code: 'NOT_SIGNED_IN', message: COPILOT_NOT_INSTALLED}, model);
      }
      return finish({ok: false, code: 'NETWORK_ERROR', message: 'The provider could not be reached.'}, model);
    }
    if (auth.message === COPILOT_NOT_INSTALLED) return finish({ok: false, code: 'NOT_SIGNED_IN', message: COPILOT_NOT_INSTALLED}, model);
    if (!auth.signedIn) return finish({ok: false, code: 'NOT_SIGNED_IN', message: signedOutMessage(auth.message)}, model);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
    let usageModel = '';
    let finished = false;
    let failure: {code: string; message: string} | undefined;
    try {
      for await (const event of copilotRuntime().run({system: COPILOT_TEST_SYSTEM, prompt: COPILOT_TEST_PROMPT, model, signal: controller.signal})) {
        if (event.type === 'usage') usageModel = event.model;
        else if (event.type === 'done') finished = true;
        else if (event.type === 'error') { failure = copilotTestFailure(event); break; }
      }
    } catch (error) {
      if (!failure) {
        if (controller.signal.aborted || isAbortError(error)) failure = {code: 'TIMEOUT', message: 'The connection timed out.'};
        else failure = {code: 'NETWORK_ERROR', message: 'The provider could not be reached.'};
      }
    } finally {
      clearTimeout(timer);
    }
    if (!failure && (controller.signal.aborted || !finished)) failure = {code: 'TIMEOUT', message: 'The connection timed out.'};
    if (!failure && model !== 'auto' && usageModel !== model) failure = {code: 'MODEL_UNAVAILABLE', message: planMessage(model)};
    if (failure) return finish({ok: false, code: failure.code, message: failure.message}, model);
    return finish({ok: true, model: usageModel || model}, usageModel || model);
  }

  async function testConnection(input: unknown): Promise<AiTestResult> {
    const body = parseTest(input);
    if (body.provider === 'copilot') return testCopilot(body);
    const prepared = await exclusive(async () => {
      const config = await readFileConfig();
      const entry = config.providers[body.provider];
      if (body.source === 'stored' && body.credentialRevision !== entry.credentialRevision) return {kind: 'stale' as const, model: entry.model};
      const apiKey = body.source === 'replacement' ? body.apiKey : (await resolveKey(body.provider, entry))?.key;
      const baseUrl = body.provider === 'openrouter' ? OPENROUTER_BASE_URL : entry.baseUrl ?? DEFAULT_BASE_URL;
      return {kind: 'ready' as const, apiKey, baseUrl, model: entry.model};
    });
    if (prepared.kind === 'stale') return {testId: body.testId, ok: false, code: 'SETTINGS_CHANGED', message: 'The saved API key changed. Refresh and try again.'};
    if (!prepared.apiKey) return {testId: body.testId, ok: false, code: 'AI_NOT_CONFIGURED', message: 'Add an API key.'};
    if (body.provider === 'openai-compatible') {
      try { assertCloudBaseUrl(prepared.baseUrl, cloudBaseUrlAllowlist(env)); }
      catch (error) {
        if (error instanceof AiHttpError) return {testId: body.testId, ok: false, code: 'INVALID_CONFIG', message: error.message};
        throw error;
      }
    }
    const started = now();
    const result = await probeKey({provider: body.provider, baseUrl: prepared.baseUrl, apiKey: prepared.apiKey, fetch: fetchImpl});
    log(formatAiLog({
      provider: body.provider,
      model: prepared.model,
      durationMs: Math.max(0, now() - started),
      contractVersion: 1,
      diagnosticCodes: result.ok ? [] : [result.code],
      outcome: result.ok ? 'check_ok' : 'check_failed',
    }));
    return {testId: body.testId, ...result};
  }

  async function listModels(providerName: string | null) {
    if (providerName === 'copilot') {
      const status = await copilotStatus(null);
      return {provider: 'copilot' as const, models: status.models};
    }
    const provider = assertProviderId(providerName);
    const config = await readFileConfig();
    const entry = config.providers[provider];
    const baseUrl = provider === 'openrouter' ? OPENROUTER_BASE_URL : assertCloudBaseUrl(entry.baseUrl ?? '', cloudBaseUrlAllowlist(env));
    const cacheKey = `${provider}\n${baseUrl}`;
    const cached = catalogCache.get(cacheKey);
    if (cached && now() - cached.at < CATALOG_TTL_MS) return {provider, models: cached.models};
    const apiKey = provider === 'openai-compatible' ? (await resolveKey(provider, entry))?.key : undefined;
    const models = await fetchModelCatalog({url: providerEndpoint(baseUrl, 'models'), apiKey, fetch: fetchImpl});
    if (models.length > 0) catalogCache.set(cacheKey, {at: now(), models});
    return {provider, models};
  }

  async function get(): Promise<AiPublicConfig> {
    await maybeAutoSelect();
    return publicConfig();
  }

  return {file, get, put, connect, testConnection, listModels, settingsRevision, copilotStatus};
}
