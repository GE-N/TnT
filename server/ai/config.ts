import {chmod, mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {AiHttpError} from './errors.js';
import {createKeychainStore, type SecretStore} from './keychain.js';
import {formatAiLog} from './log.js';
import {createOpenAiCompatibleProvider} from './providers/openai-compatible.js';
import type {FlowModelProvider} from './providers/types.js';

export type {SecretStore};
export {createKeychainStore};

const PROVIDER = 'openai-compatible';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export type AiPublicConfig = {provider: typeof PROVIDER; model: string; baseUrl: string; hasKey: boolean};

export function secretService(provider: string) {
  return `tnt.ai.${provider}`;
}

type FileConfig = {provider: typeof PROVIDER; model: string; baseUrl: string};

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

function assertProvider(value: unknown) {
  if (value === 'ollama' || value === 'local' || value === 'lmstudio') throw new AiHttpError(400, 'INVALID_CONFIG', 'Local model providers are not available in this version.');
  if (value === 'anthropic') throw new AiHttpError(400, 'INVALID_CONFIG', 'Anthropic is not available in this version.');
  if (value !== PROVIDER) throw new AiHttpError(400, 'INVALID_CONFIG', 'Use the OpenAI-compatible provider.');
  return PROVIDER;
}

function assertKey(value: string) {
  if (!value || value.length > 2_000 || /[\u0000-\u001F\u007F]/.test(value) || value.startsWith('-')) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an API key.');
  return value;
}

export function createAiConfig(deps: {root: string; env?: NodeJS.ProcessEnv; secrets?: SecretStore; fetch?: typeof fetch; log?: (line: string) => void; now?: () => number}) {
  const env = deps.env ?? process.env;
  const secrets = deps.secrets ?? createKeychainStore();
  const log = deps.log ?? ((line: string) => console.info(line));
  const now = deps.now ?? Date.now;
  const file = join(deps.root, 'ai-config.json');
  const service = secretService(PROVIDER);

  async function readFileConfig(): Promise<FileConfig> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {provider: PROVIDER, model: '', baseUrl: DEFAULT_BASE_URL};
      const record = parsed as Record<string, unknown>;
      const model = typeof record.model === 'string' ? record.model : '';
      const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl : DEFAULT_BASE_URL;
      return {provider: PROVIDER, model, baseUrl};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {provider: PROVIDER, model: '', baseUrl: DEFAULT_BASE_URL};
      throw new AiHttpError(500, 'CONFIG_UNREADABLE', 'AI config is unreadable.');
    }
  }

  async function writeFileConfig(config: FileConfig) {
    await mkdir(deps.root, {recursive: true});
    const temporary = join(deps.root, `${randomUUID()}.ai-config.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({provider: config.provider, model: config.model, baseUrl: config.baseUrl}));
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

  async function storedKey() {
    const value = await secrets.get(service);
    return value || undefined;
  }

  async function envKey() {
    const value = env.TNT_AI_API_KEY;
    if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) return undefined;
    return value;
  }

  async function resolveKey() {
    return await storedKey() ?? await envKey();
  }

  async function publicConfig(): Promise<AiPublicConfig> {
    const config = await readFileConfig();
    return {provider: PROVIDER, model: config.model, baseUrl: config.baseUrl, hasKey: !!(await resolveKey())};
  }

  async function connect(): Promise<{provider: FlowModelProvider; model: string}> {
    const config = await readFileConfig();
    if (!config.model) throw new AiHttpError(400, 'PROVIDER_CONFIG', 'Choose a model.');
    let baseUrl: string;
    try { baseUrl = assertCloudBaseUrl(config.baseUrl); }
    catch (error) {
      if (error instanceof AiHttpError) throw new AiHttpError(400, 'PROVIDER_CONFIG', error.message);
      throw error;
    }
    const apiKey = await resolveKey();
    if (!apiKey) throw new AiHttpError(400, 'PROVIDER_CONFIG', 'Add an API key.');
    return {model: config.model, provider: createOpenAiCompatibleProvider({baseUrl, model: config.model, apiKey, fetch: deps.fetch})};
  }

  return {
    file,
    get: publicConfig,
    async put(input: unknown): Promise<AiPublicConfig> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide AI config.');
      const body = input as Record<string, unknown>;
      if (Object.keys(body).some(key => !['provider', 'model', 'baseUrl', 'apiKey'].includes(key))) throw new AiHttpError(400, 'INVALID_CONFIG', 'Unknown AI config field.');
      assertProvider(body.provider);
      const model = assertModel(body.model);
      const baseUrl = assertCloudBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '');
      await writeFileConfig({provider: PROVIDER, model, baseUrl});
      if (typeof body.apiKey === 'string') {
        if (body.apiKey) await secrets.set(service, assertKey(body.apiKey));
        else await secrets.delete(service);
      } else if (body.apiKey !== undefined) throw new AiHttpError(400, 'INVALID_CONFIG', 'Provide an API key.');
      return publicConfig();
    },
    connect,
    async check() {
      const started = now();
      let model = '';
      try {
        const connected = await connect();
        model = connected.model;
        const result = await connected.provider.check();
        log(formatAiLog({provider: PROVIDER, model, durationMs: Math.max(0, now() - started), contractVersion: 1, diagnosticCodes: [], outcome: result.ok ? 'check_ok' : 'check_failed'}));
        return result;
      } catch (error) {
        log(formatAiLog({provider: PROVIDER, model, durationMs: Math.max(0, now() - started), contractVersion: 1, diagnosticCodes: [], outcome: 'check_failed'}));
        if (error instanceof AiHttpError) return {ok: false, error: error.message};
        return {ok: false, error: 'The model provider is unreachable.'};
      }
    },
  };
}
