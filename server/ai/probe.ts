import {AiHttpError, redactSecrets} from './errors.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const PROBE_TIMEOUT_MS = 15_000;
const CATALOG_BODY_LIMIT = 8_000_000;
const CATALOG_MODEL_CAP = 2_000;
const MODEL_NAME_LIMIT = 200;

export type ProviderId = 'openrouter' | 'openai-compatible';
export type AiModelInfo = {id: string; name?: string; capabilities?: string[]};
export type KeyProbe = {ok: true; message: string} | {ok: false; code: string; message: string};

export function providerEndpoint(baseUrl: string, path: string) {
  const withSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ''), withSlash).toString();
}

function isTimeout(error: unknown) {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  const name = (error as {name?: string}).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function jsonMessage(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  if (typeof record.message === 'string') return record.message;
  return;
}

/** Upstream text is shown only after the key and Authorization header are removed. */
export function safeUpstreamMessage(status: number, body: string, secrets: readonly string[]) {
  if (status === 401 || status === 403) return 'The API key was rejected.';
  const trimmed = body.trim().slice(0, 2_000);
  if (!trimmed || trimmed.startsWith('<')) return 'The provider could not be reached.';
  let message = trimmed;
  try {
    const extracted = jsonMessage(JSON.parse(trimmed) as unknown);
    if (extracted) message = extracted;
  } catch { /* plain text */ }
  const redacted = redactSecrets(message, secrets).replace(/\s+/g, ' ').trim();
  return redacted.slice(0, 300) || 'The provider could not be reached.';
}

function codeFor(status: number) {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 402) return 'CREDITS_REQUIRED';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  return 'PROVIDER_UNAVAILABLE';
}

export async function probeKey(options: {provider: ProviderId; baseUrl: string; apiKey: string; fetch: typeof fetch}): Promise<KeyProbe> {
  const url = options.provider === 'openrouter' ? providerEndpoint(OPENROUTER_BASE_URL, 'key') : providerEndpoint(options.baseUrl, 'models');
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'GET',
      headers: {authorization: `Bearer ${options.apiKey}`, accept: 'application/json'},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (error) {
    if (isTimeout(error)) return {ok: false, code: 'TIMEOUT', message: 'The connection timed out.'};
    return {ok: false, code: 'NETWORK_ERROR', message: 'The provider is unreachable.'};
  }
  if (response.status >= 300 && response.status < 400) return {ok: false, code: 'NETWORK_ERROR', message: 'The provider redirected the connection.'};
  if (response.ok) {
    return {
      ok: true,
      message: options.provider === 'openrouter'
        ? "Connected to OpenRouter. The model hasn't been tested yet."
        : "Connected. The model hasn't been tested yet.",
    };
  }
  const body = await response.text().catch(() => '');
  return {ok: false, code: codeFor(response.status), message: safeUpstreamMessage(response.status, body, [options.apiKey])};
}

function boundedName(value: unknown) {
  if (typeof value !== 'string') return;
  const name = value.trim();
  if (!name || /[\u0000-\u001F\u007F]/.test(name)) return;
  return name.slice(0, MODEL_NAME_LIMIT);
}

function modelInfo(item: unknown): AiModelInfo | undefined {
  if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' || !item.id || item.id.length > 200) return;
  const info: AiModelInfo = {id: item.id};
  const name = boundedName('name' in item ? item.name : undefined);
  if (name) info.name = name;
  const supported = 'supported_parameters' in item && Array.isArray(item.supported_parameters)
    ? item.supported_parameters.filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 80).slice(0, 32)
    : [];
  if (supported.length) info.capabilities = supported;
  return info;
}

export async function fetchModelCatalog(options: {url: string; apiKey?: string; fetch: typeof fetch}): Promise<AiModelInfo[]> {
  let response: Response;
  try {
    response = await options.fetch(options.url, {
      method: 'GET',
      headers: {accept: 'application/json', ...(options.apiKey ? {authorization: `Bearer ${options.apiKey}`} : {})},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (error) {
    if (isTimeout(error)) throw new AiHttpError(504, 'TIMEOUT', 'The model catalog timed out.');
    throw new AiHttpError(502, 'NETWORK_ERROR', 'The model catalog is unreachable.');
  }
  if (response.status >= 300 && response.status < 400) throw new AiHttpError(502, 'NETWORK_ERROR', 'The model catalog redirected the request.');
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 401 : 502;
    throw new AiHttpError(status, response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : 'PROVIDER_UNAVAILABLE', safeUpstreamMessage(response.status, body, options.apiKey ? [options.apiKey] : []));
  }
  if (body.length > CATALOG_BODY_LIMIT) throw new AiHttpError(502, 'PROVIDER_UNAVAILABLE', 'The model catalog is unavailable.');
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { throw new AiHttpError(502, 'PROVIDER_UNAVAILABLE', 'The model catalog is unavailable.'); }
  const data = parsed && typeof parsed === 'object' && 'data' in parsed && Array.isArray(parsed.data) ? parsed.data : undefined;
  if (!data) throw new AiHttpError(502, 'PROVIDER_UNAVAILABLE', 'The model catalog is unavailable.');
  const models: AiModelInfo[] = [];
  for (const item of data) {
    const info = modelInfo(item);
    if (info) models.push(info);
    if (models.length >= CATALOG_MODEL_CAP) break;
  }
  return models;
}
