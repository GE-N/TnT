import {ProviderRequestError, type FlowModelProvider, type Usage} from './types.js';

const SCHEMA_NAME = 'flow_draft';

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

async function errorPayload(response: Response) {
  const text = (await response.text()).slice(0, 8_000);
  try { return JSON.parse(text) as unknown; }
  catch { return {error: {message: text.slice(0, 300)}}; }
}

function failure(status: number, payload: unknown, retryAfterMs: number | undefined) {
  if (status === 401 || status === 403) return new ProviderRequestError({code: 'PROVIDER_AUTH', message: 'The model provider rejected the API key.', retryable: false, status});
  if (modelMissing(payload) || status === 404) return new ProviderRequestError({code: 'PROVIDER_CONFIG', message: 'The model is not available at this provider.', retryable: false, status});
  if (status === 429 || status >= 500) return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true, retryAfterMs, status});
  if (status >= 400 && status < 500) return new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'The model provider rejected the request.', retryable: false, status});
  return new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true, retryAfterMs, status});
}

function mapUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== 'object') return;
  const record = usage as {prompt_tokens?: unknown; completion_tokens?: unknown};
  const inputTokens = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : undefined;
  const outputTokens = typeof record.completion_tokens === 'number' ? record.completion_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return;
  return {inputTokens, outputTokens};
}

function deltaText(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('choices' in payload) || !Array.isArray(payload.choices)) return;
  const choice = payload.choices[0];
  if (!choice || typeof choice !== 'object') return;
  if ('delta' in choice && choice.delta && typeof choice.delta === 'object' && 'content' in choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  if ('message' in choice && choice.message && typeof choice.message === 'object' && 'content' in choice.message && typeof choice.message.content === 'string') return choice.message.content;
  return;
}

export function createOpenAiCompatibleProvider(options: {baseUrl: string; model: string; apiKey: string; fetch?: typeof fetch}): FlowModelProvider {
  const fetchImpl = options.fetch ?? fetch;
  async function post(body: unknown, signal: AbortSignal) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint(options.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: {authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream, application/json'},
        body: JSON.stringify(body),
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true});
    }
    if (response.status >= 300 && response.status < 400) throw new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'The model provider redirected the request.', retryable: false, status: response.status});
    return response;
  }

  return {
    id: 'openai-compatible',
    async check() {
      let response: Response;
      try {
        response = await fetchImpl(endpoint(options.baseUrl, 'models'), {
          headers: {authorization: `Bearer ${options.apiKey}`},
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
        stream_options: {include_usage: true},
        max_tokens: req.maxOutputTokens,
        response_format: {type: 'json_schema', json_schema: {name: SCHEMA_NAME, strict: true, schema: req.schema}},
      };
      let response = await post(body, req.signal);
      if (response.status === 400) {
        const payload = await errorPayload(response);
        if (structuredOutputRejected(payload)) {
          body = {...body, response_format: {type: 'json_object'}};
          response = await post(body, req.signal);
        } else if (streamOptionsRejected(payload)) {
          const {stream_options, ...rest} = body;
          void stream_options;
          body = rest;
          response = await post(body, req.signal);
        } else {
          throw failure(400, payload, undefined);
        }
      }
      if (response.status === 400) {
        const payload = await errorPayload(response);
        if (streamOptionsRejected(payload) && 'stream_options' in body) {
          const {stream_options, ...rest} = body;
          void stream_options;
          body = rest;
          response = await post(body, req.signal);
        } else if (!response.ok) throw failure(response.status, payload, parseRetryAfterMs(response.headers.get('retry-after')));
      }
      if (!response.ok) {
        const payload = await errorPayload(response);
        throw failure(response.status, payload, parseRetryAfterMs(response.headers.get('retry-after')));
      }
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('text/event-stream')) {
        const payload = await response.json();
        const text = deltaText(payload) ?? '';
        if (text) yield {delta: text};
        yield {done: {text, ...(mapUsage(payload && typeof payload === 'object' && 'usage' in payload ? payload.usage : undefined) ? {usage: mapUsage((payload as {usage?: unknown}).usage)} : {})}};
        return;
      }
      yield* streamEvents(response, req.signal);
    },
  };
}

async function* streamEvents(response: Response, signal: AbortSignal): AsyncGenerator<{delta?: string; done?: {text: string; usage?: Usage}}> {
  if (!response.body) throw new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true});
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: Usage | undefined;
  const take = (event: string) => {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return data === '[DONE]' ? 'done' as const : undefined;
    let payload: unknown;
    try { payload = JSON.parse(data); }
    catch { return; }
    if (payload && typeof payload === 'object' && 'error' in payload) throw new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true});
    const mapped = mapUsage(payload && typeof payload === 'object' && 'usage' in payload ? payload.usage : undefined);
    if (mapped) usage = {...usage, ...mapped};
    const delta = deltaText(payload);
    if (delta) { text += delta; return {delta}; }
    return;
  };
  try {
    while (true) {
      if (signal.aborted) throw Object.assign(new Error('The operation was aborted.'), {name: 'AbortError'});
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true}).replace(/\r\n/g, '\n');
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const event = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const item = take(event);
        if (item === 'done') {
          yield {done: {text, ...(usage ? {usage} : {})}};
          return;
        }
        if (item && typeof item === 'object') yield item;
        split = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield {done: {text, ...(usage ? {usage} : {})}};
}
