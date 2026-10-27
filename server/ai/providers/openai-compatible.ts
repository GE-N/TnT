import {redactSecrets} from '../errors.js';
import {appendSchemaInstruction} from '../prompt.js';
import {OPENROUTER_BASE_URL} from '../probe.js';
import {MAX_UPSTREAM_POSTS, ProviderRequestError, RESPONSE_BYTE_LIMIT, type FlowModelProvider, type ModelDone, type UpstreamBudget, type Usage} from './types.js';

const SCHEMA_NAME = 'flow_draft';
const OPENROUTER_REFERER = 'http://localhost';
const OPENROUTER_TITLE = 'TnT';

export function parseRetryAfterMs(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function endpoint(baseUrl: string, path: string) {
  const withSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ''), withSlash).toString();
}

function structuredOutputRejected(payload: unknown) {
  const text = JSON.stringify(payload ?? {}).toLowerCase();
  return text.includes('response_format') || text.includes('json_schema') || text.includes('structured output');
}

function streamOptionsRejected(payload: unknown) {
  return JSON.stringify(payload ?? {}).toLowerCase().includes('stream_options');
}

function modelMissing(payload: unknown) {
  if (!payload || typeof payload !== 'object') return false;
  const error = 'error' in payload ? payload.error : undefined;
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  const param = 'param' in error ? error.param : undefined;
  return code === 'model_not_found' || param === 'model';
}

function embeddedCodeOf(error: unknown): number | string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return;
  const code = (error as {code?: unknown}).code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.length > 0 && code.length <= 80) return code;
  return;
}

function numericCode(code: number | string | undefined) {
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return;
}

/** HTML and malformed bodies never become the message shown to the user. */
async function errorPayload(response: Response) {
  const text = (await response.text()).slice(0, 8_000);
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) return {error: {message: 'The provider could not complete the request.'}};
  try { return JSON.parse(trimmed) as unknown; }
  catch { return {error: {message: 'The provider could not complete the request.'}}; }
}

function failure(status: number, payload: unknown, retryAfterMs: number | undefined, secret: string) {
  const message = (text: string) => redactSecrets(text, [secret]);
  if (status === 401 || status === 403) return new ProviderRequestError({code: 'PROVIDER_AUTH', message: message('The model provider rejected the API key.'), retryable: false, status});
  if (status === 402) return new ProviderRequestError({code: 'PROVIDER_REJECTED', message: message('The provider account needs credits.'), retryable: false, status, embeddedCode: 402});
  if (modelMissing(payload) || status === 404) return new ProviderRequestError({code: 'PROVIDER_CONFIG', message: message('The model is not available at this provider.'), retryable: false, status, ...(modelMissing(payload) ? {embeddedCode: 'model_not_found' as const} : {})});
  if (status === 429 || status >= 500) return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: message('The model provider is unavailable.'), retryable: true, retryAfterMs, status});
  if (status >= 400 && status < 500) return new ProviderRequestError({code: 'PROVIDER_REJECTED', message: message('The model provider rejected the request.'), retryable: false, status});
  return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: message('The model provider is unavailable.'), retryable: true, retryAfterMs, status});
}

function embeddedFailure(payload: unknown, secret: string) {
  const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
  const embeddedCode = embeddedCodeOf(error);
  const status = numericCode(embeddedCode);
  const message = (text: string) => redactSecrets(text, [secret]);
  if (embeddedCode === 'model_not_found' || status === 404) return new ProviderRequestError({code: 'PROVIDER_CONFIG', message: message('The model is not available at this provider.'), retryable: false, status: 200, embeddedCode: embeddedCode ?? 'model_not_found', reason: 'embedded'});
  if (status === 401 || status === 403) return new ProviderRequestError({code: 'PROVIDER_AUTH', message: message('The model provider rejected the API key.'), retryable: false, status: 200, embeddedCode: status, reason: 'embedded'});
  if (status === 402) return new ProviderRequestError({code: 'PROVIDER_REJECTED', message: message('The provider account needs credits.'), retryable: false, status: 200, embeddedCode: 402, reason: 'embedded'});
  return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: message('The model provider is unavailable.'), retryable: false, status: 200, ...(embeddedCode !== undefined ? {embeddedCode} : {}), reason: 'embedded'});
}

function outputTooLarge(secret: string) {
  return new ProviderRequestError({code: 'PROVIDER_REJECTED', message: redactSecrets('The model output was too large.', [secret]), retryable: false, outputTooLarge: true});
}

function mapUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== 'object') return;
  const record = usage as {prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown};
  const inputTokens = typeof record.prompt_tokens === 'number' && Number.isFinite(record.prompt_tokens) ? record.prompt_tokens : undefined;
  const outputTokens = typeof record.completion_tokens === 'number' && Number.isFinite(record.completion_tokens) ? record.completion_tokens : undefined;
  const cost = typeof record.cost === 'number' && Number.isFinite(record.cost) ? record.cost : undefined;
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) return;
  return {
    ...(inputTokens !== undefined ? {inputTokens} : {}),
    ...(outputTokens !== undefined ? {outputTokens} : {}),
    ...(cost !== undefined ? {cost} : {}),
  };
}

function reported(payload: unknown, secret: string): {model?: string; upstreamProvider?: string} {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as {model?: unknown; provider?: unknown};
  const clean = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001F\u007F]/.test(value)) return;
    const redacted = redactSecrets(value, [secret]);
    return redacted.includes(secret) ? undefined : redacted;
  };
  const model = clean(record.model);
  const upstreamProvider = clean(record.provider);
  return {...(model ? {model} : {}), ...(upstreamProvider ? {upstreamProvider} : {})};
}

function choiceOf(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('choices' in payload) || !Array.isArray(payload.choices)) return;
  const choice = payload.choices[0];
  if (!choice || typeof choice !== 'object') return;
  return choice as {delta?: unknown; message?: unknown; finish_reason?: unknown};
}

function deltaText(payload: unknown) {
  const choice = choiceOf(payload);
  if (!choice) return;
  if (choice.delta && typeof choice.delta === 'object' && 'content' in choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  if (choice.message && typeof choice.message === 'object' && 'content' in choice.message && typeof choice.message.content === 'string') return choice.message.content;
  return;
}

function finishReason(payload: unknown) {
  const choice = choiceOf(payload);
  return choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined;
}

function hasEmbeddedError(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return false;
  const error = payload.error;
  return error != null && error !== false;
}

function jsonSchemaFormat(schema: object) {
  return {type: 'json_schema', json_schema: {name: SCHEMA_NAME, strict: true, schema}};
}

function withSchemaInstructions(messages: {role: string; content: string}[], schema: object) {
  const first = messages[0];
  if (!first || first.role !== 'system') return messages;
  return [{role: first.role, content: appendSchemaInstruction(first.content, schema)}, ...messages.slice(1)];
}

function withoutStreamOptions(body: Record<string, unknown>) {
  const next = {...body};
  delete next.stream_options;
  return next;
}

function consumePost(shared: UpstreamBudget | undefined, used: {n: number}) {
  if (used.n >= MAX_UPSTREAM_POSTS) return false;
  if (shared && !shared.tryConsume()) return false;
  used.n += 1;
  return true;
}

export function createOpenAiCompatibleProvider(options: {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** OpenRouter is a preset of this adapter: fixed URL, attribution headers, and no response_format. */
  preset?: 'openrouter' | 'openai-compatible';
  /** Later capability flag. OpenRouter then also sends provider.require_parameters. */
  structuredOutput?: boolean;
}): FlowModelProvider {
  const fetchImpl = options.fetch ?? fetch;
  const openRouter = options.preset === 'openrouter';
  const baseUrl = openRouter ? OPENROUTER_BASE_URL : options.baseUrl;
  const secret = options.apiKey;

  function requestHeaders() {
    const result: Record<string, string> = {authorization: `Bearer ${secret}`};
    if (openRouter) {
      result['HTTP-Referer'] = OPENROUTER_REFERER;
      result['X-Title'] = OPENROUTER_TITLE;
    }
    return result;
  }

  async function post(body: unknown, signal: AbortSignal) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint(baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: {...requestHeaders(), 'content-type': 'application/json', accept: 'text/event-stream, application/json'},
        body: JSON.stringify(body),
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: redactSecrets('The provider could not be reached.', [secret]), retryable: true, reason: 'network'});
    }
    if (response.status >= 300 && response.status < 400) throw new ProviderRequestError({code: 'PROVIDER_REJECTED', message: redactSecrets('The model provider redirected the request.', [secret]), retryable: false, status: response.status});
    return response;
  }

  async function send(body: unknown, signal: AbortSignal, shared: UpstreamBudget | undefined, used: {n: number}) {
    if (!consumePost(shared, used)) return;
    return post(body, signal);
  }

  return {
    id: openRouter ? 'openrouter' : 'openai-compatible',
    sendsJsonSchema: openRouter ? options.structuredOutput === true : true,
    async check() {
      let response: Response;
      try {
        response = await fetchImpl(endpoint(baseUrl, 'models'), {
          headers: requestHeaders(),
          signal: AbortSignal.timeout(20_000),
          redirect: 'manual',
        });
      } catch {
        return {ok: false, error: 'The model provider is unreachable.'};
      }
      if (response.status >= 300 && response.status < 400) return {ok: false, error: 'The model provider redirected the request.'};
      if (response.status === 401 || response.status === 403) return {ok: false, error: 'The model provider rejected the API key.'};
      if (!response.ok) return {ok: false, error: response.status === 404 ? 'Unknown model.' : 'The model provider is unavailable.'};
      let payload: unknown;
      try { payload = await response.json(); }
      catch { return {ok: true, model: options.model}; }
      const data = payload && typeof payload === 'object' && 'data' in payload && Array.isArray(payload.data) ? payload.data : undefined;
      if (!data) return {ok: true, model: options.model};
      const found = data.some(item => !!item && typeof item === 'object' && 'id' in item && item.id === options.model);
      return found ? {ok: true, model: options.model} : {ok: false, error: 'Unknown model.'};
    },
    async *generate(req) {
      const messages = [{role: 'system', content: req.system}, ...req.messages.map(message => ({role: message.role, content: message.content}))];
      let body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: true,
        max_tokens: req.maxOutputTokens,
      };
      if (openRouter) {
        body.usage = {include: true};
        if (options.structuredOutput) {
          body.response_format = jsonSchemaFormat(req.schema);
          body.provider = {require_parameters: true};
        }
      } else {
        body.stream_options = {include_usage: true};
        body.response_format = jsonSchemaFormat(req.schema);
      }
      const used = {n: 0};
      const first = await send(body, req.signal, req.budget, used);
      if (!first) throw new ProviderRequestError({code: 'PROVIDER_REJECTED', message: redactSecrets('The generation request budget is exhausted.', [secret]), retryable: false, reason: 'budget'});
      let response = first;
      // OpenRouter never re-posts for json_schema or stream_options. The generic adapter may spend the second post on one fallback.
      if (!openRouter && response.status === 400) {
        const payload = await errorPayload(response);
        let nextBody: Record<string, unknown> | undefined;
        if (structuredOutputRejected(payload)) nextBody = {...body, messages: withSchemaInstructions(messages, req.schema), response_format: {type: 'json_object'}};
        else if (streamOptionsRejected(payload)) nextBody = withoutStreamOptions(body);
        else throw failure(400, payload, undefined, secret);
        const fallback = await send(nextBody, req.signal, req.budget, used);
        if (!fallback) throw failure(400, payload, undefined, secret);
        response = fallback;
      }
      if (!response.ok) {
        const payload = await errorPayload(response);
        throw failure(response.status, payload, parseRetryAfterMs(response.headers.get('retry-after')), secret);
      }
      yield* readCompletion(response, req.signal, secret);
    },
  };
}

async function* readCompletion(response: Response, signal: AbortSignal, secret: string): AsyncGenerator<{delta?: string; done?: ModelDone}> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > RESPONSE_BYTE_LIMIT) throw outputTooLarge(secret);
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('<')) throw embeddedFailure({error: {message: 'The provider could not complete the request.'}}, secret);
    let payload: unknown;
    try { payload = JSON.parse(trimmed) as unknown; }
    catch { throw embeddedFailure({error: {message: 'The provider could not complete the request.'}}, secret); }
    if (hasEmbeddedError(payload) || finishReason(payload) === 'error') throw embeddedFailure(hasEmbeddedError(payload) ? payload : {error: {message: 'The model provider is unavailable.'}}, secret);
    const text = deltaText(payload) ?? '';
    if (Buffer.byteLength(text) > RESPONSE_BYTE_LIMIT) throw outputTooLarge(secret);
    const usage = mapUsage(payload && typeof payload === 'object' && 'usage' in payload ? payload.usage : undefined);
    const meta = reported(payload, secret);
    if (text) yield {delta: text};
    yield {done: {text, ...(usage ? {usage} : {}), ...meta}};
    return;
  }
  yield* streamEvents(response, signal, secret);
}

async function* streamEvents(response: Response, signal: AbortSignal, secret: string): AsyncGenerator<{delta?: string; done?: ModelDone}> {
  if (!response.body) throw new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: redactSecrets('The model provider is unavailable.', [secret]), retryable: false, reason: 'embedded'});
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: Usage | undefined;
  let meta: {model?: string; upstreamProvider?: string} = {};
  const take = (event: string) => {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return data === '[DONE]' ? 'done' as const : undefined;
    let payload: unknown;
    try { payload = JSON.parse(data); }
    catch { throw embeddedFailure({error: {message: 'The provider could not complete the request.'}}, secret); }
    if (hasEmbeddedError(payload) || finishReason(payload) === 'error') throw embeddedFailure(hasEmbeddedError(payload) ? payload : {error: {}}, secret);
    meta = {...meta, ...reported(payload, secret)};
    const mapped = mapUsage(payload && typeof payload === 'object' && 'usage' in payload ? payload.usage : undefined);
    if (mapped) usage = {...usage, ...mapped};
    const delta = deltaText(payload);
    if (delta) {
      text += delta;
      if (Buffer.byteLength(text) > RESPONSE_BYTE_LIMIT) throw outputTooLarge(secret);
      return {delta};
    }
    return;
  };
  try {
    while (true) {
      if (signal.aborted) throw Object.assign(new Error('The operation was aborted.'), {name: 'AbortError'});
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true}).replace(/\r\n/g, '\n');
      if (Buffer.byteLength(buffer) + Buffer.byteLength(text) > RESPONSE_BYTE_LIMIT + 64 * 1024) throw outputTooLarge(secret);
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const event = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const item = take(event);
        if (item === 'done') {
          yield {done: {text, ...(usage ? {usage} : {}), ...meta}};
          return;
        }
        if (item && typeof item === 'object') yield item;
        split = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield {done: {text, ...(usage ? {usage} : {}), ...meta}};
}
