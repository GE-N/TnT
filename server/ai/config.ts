import {chmod, mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {AiHttpError} from './errors.js';
import {createKeychainStore, type SecretStore} from './keychain.js';
import {formatAiLog} from './log.js';
import {fetchModelCatalog, OPENROUTER_BASE_URL, probeKey, providerEndpoint, type AiModelInfo, type ProviderId} from './probe.js';
import {createOpenAiCompatibleProvider} from './providers/openai-compatible.js';
import type {FlowModelProvider} from './providers/types.js';

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

export type AiPublicConfig = {
  settingsRevision: number;
  selected: ProviderId;
  providers: Record<ProviderId, AiProviderSettings>;
};

export type AiTestResult = {testId: string; ok: boolean; code?: string; message?: string};

type ProviderFile = {model: string; baseUrl?: string; credentialRevision: number; storage?: StorageKind};
type FileConfig = {settingsRevision: number; selected: ProviderId; providers: Record<ProviderId, ProviderFile>};
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
  | {provider: ProviderId; testId: string; source: 'stored'; credentialRevision: number}
  | {provider: ProviderId; testId: string; source: 'replacement'; apiKey: string};
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

export function assertCloudBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an https cloud base URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an https cloud base URL.');
  if (isPrivateHost(url.hostname)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Local endpoints are not available. Use an https cloud base URL.');
  return url.toString().replace(/\/$/, '');
}

function assertModel(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:/@+-]{1,200}$/.test(value)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide a model name.');
  return value;
}

function assertProviderId(value: unknown): ProviderId {
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

function parsePut(input: unknown): PutBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide AI config.');
  const body = input as Record<string, unknown>;
  knownKeys(body, ['expectedSettingsRevision', 'selected', 'provider', 'model', 'baseUrl', 'credential']);
  if (!Number.isInteger(body.expectedSettingsRevision) || (body.expectedSettingsRevision as number) < 0) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide the settings revision.');
  const selected = assertProviderId(body.selected);
  const provider = assertProviderId(body.provider);
  const model = assertModel(body.model);
  let baseUrl: string | undefined;
  if (provider === 'openrouter') {
    if (body.baseUrl !== undefined) throw new AiHttpError(400, 'INVALID_CONFIG', 'OpenRouter uses a fixed base URL.');
  } else baseUrl = assertCloudBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '');
  return {expectedSettingsRevision: body.expectedSettingsRevision as number, selected, provider, model, baseUrl, credential: parseCredential(body.credential)};
}

function parseTest(input: unknown): TestBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide a connection test.');
  const body = input as Record<string, unknown>;
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
    },
  };
}

function providerFile(provider: ProviderId, value: unknown): ProviderFile {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const storage = record.storage === 'keychain' || record.storage === 'session' ? record.storage : undefined;
  const entry: ProviderFile = {model: typeof record.model === 'string' ? record.model : '', credentialRevision: revisionOf(record.credentialRevision), ...(storage ? {storage} : {})};
  if (provider === 'openai-compatible') entry.baseUrl = typeof record.baseUrl === 'string' && record.baseUrl ? record.baseUrl : DEFAULT_BASE_URL;
  return entry;
}

function fileJson(config: FileConfig) {
  const provider = (id: ProviderId, entry: ProviderFile) => {
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
    },
  });
}

function nextFile(current: FileConfig, body: PutBody): FileConfig {
  const providers: FileConfig['providers'] = {
    openrouter: {...current.providers.openrouter},
    'openai-compatible': {...current.providers['openai-compatible']},
  };
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
  return {settingsRevision: current.settingsRevision + 1, selected: body.selected, providers};
}

export function createAiConfig(deps: {root: string; env?: NodeJS.ProcessEnv; secrets?: SecretStore; fetch?: typeof fetch; log?: (line: string) => void; now?: () => number; dev?: boolean}) {
  const env = deps.env ?? process.env;
  const secrets = deps.secrets ?? createKeychainStore();
  const fetchImpl = deps.fetch ?? fetch;
  const log = deps.log ?? ((line: string) => console.info(line));
  const now = deps.now ?? Date.now;
  const file = join(deps.root, 'ai-config.json');
  const sessionKeys = new Map<ProviderId, string>();
  const catalogCache = new Map<string, {at: number; models: AiModelInfo[]}>();
  const inflight = new Set<{provider: ProviderId; abort: () => void}>();
  let pending: Promise<unknown> = Promise.resolve();

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
      const provider: ProviderId = record.provider === 'openrouter' ? 'openrouter' : 'openai-compatible';
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
      selected: record.selected === 'openrouter' || record.selected === 'openai-compatible' ? record.selected : 'openrouter',
      providers: {
        openrouter: providerFile('openrouter', providers.openrouter),
        'openai-compatible': providerFile('openai-compatible', providers['openai-compatible']),
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
  async function resolveKey(provider: ProviderId, entry: ProviderFile): Promise<{key: string; source: KeySource} | undefined> {
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

  async function snapshotCredential(provider: ProviderId): Promise<Snapshot> {
    return {session: sessionKeys.get(provider), keychain: await readSecret(secretService(provider))};
  }

  async function restoreCredential(provider: ProviderId, snapshot: Snapshot) {
    if (snapshot.session) sessionKeys.set(provider, snapshot.session);
    else sessionKeys.delete(provider);
    const service = secretService(provider);
    if (snapshot.keychain) await secrets.set(service, snapshot.keychain);
    else await secrets.delete(service);
  }

  async function applyCredential(provider: ProviderId, credential: CredentialAction) {
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

  async function publicConfig(): Promise<AiPublicConfig> {
    const config = await readFileConfig();
    const available = await storageAvailable();
    const one = async (provider: ProviderId): Promise<AiProviderSettings> => {
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
      providers: {openrouter: await one('openrouter'), 'openai-compatible': await one('openai-compatible')},
    };
  }

  function bindRemoval(provider: ProviderId) {
    return (abort: () => void) => {
      const entry = {provider, abort};
      inflight.add(entry);
      return () => { inflight.delete(entry); };
    };
  }

  function abortInflight(provider: ProviderId) {
    for (const entry of [...inflight]) if (entry.provider === provider) entry.abort();
  }

  async function settingsRevision() {
    return (await readFileConfig()).settingsRevision;
  }

  async function connect(): Promise<{provider: FlowModelProvider; model: string; providerId: ProviderId; bindRemoval: (abort: () => void) => () => void}> {
    const config = await readFileConfig();
    const selected = config.selected;
    const entry = config.providers[selected];
    if (!entry.model) throw new AiHttpError(400, 'PROVIDER_CONFIG', 'Choose a model.');
    let baseUrl = OPENROUTER_BASE_URL;
    if (selected !== 'openrouter') {
      try { baseUrl = assertCloudBaseUrl(entry.baseUrl ?? ''); }
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
    const body = parsePut(input);
    return exclusive(async () => {
      const current = await readFileConfig();
      if (body.expectedSettingsRevision !== current.settingsRevision) throw new AiHttpError(409, 'SETTINGS_CHANGED', 'Settings changed in another session. Refresh and try again.');
      const next = nextFile(current, body);
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

  async function testConnection(input: unknown): Promise<AiTestResult> {
    const body = parseTest(input);
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
      try { assertCloudBaseUrl(prepared.baseUrl); }
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
    const provider = assertProviderId(providerName);
    const config = await readFileConfig();
    const entry = config.providers[provider];
    const baseUrl = provider === 'openrouter' ? OPENROUTER_BASE_URL : assertCloudBaseUrl(entry.baseUrl ?? '');
    const cacheKey = `${provider}\n${baseUrl}`;
    const cached = catalogCache.get(cacheKey);
    if (cached && now() - cached.at < CATALOG_TTL_MS) return {provider, models: cached.models};
    const apiKey = provider === 'openai-compatible' ? (await resolveKey(provider, entry))?.key : undefined;
    const models = await fetchModelCatalog({url: providerEndpoint(baseUrl, 'models'), apiKey, fetch: fetchImpl});
    if (models.length > 0) catalogCache.set(cacheKey, {at: now(), models});
    return {provider, models};
  }

  return {file, get: publicConfig, put, connect, testConnection, listModels, settingsRevision};
}
