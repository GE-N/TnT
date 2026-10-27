import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {test} from 'node:test';
import {createOpenAiCompatibleProvider} from '../server/ai/providers/openai-compatible.js';
import {ProviderRequestError} from '../server/ai/providers/types.js';

type Seen = {url?: string; authorization?: string; referer?: string | string[]; title?: string | string[]; body: Record<string, unknown>};

async function listen(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>, seen: Seen[]) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    seen.push({url: request.url, authorization: request.headers.authorization, referer: request.headers['http-referer'], title: request.headers['x-title'], body});
    handler(request, response, body, seen);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {seen, baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>(resolve => server.close(() => resolve()))};
}

function sse(response: ServerResponse, parts: string[], usage: {prompt_tokens: number; completion_tokens: number}) {
  response.writeHead(200, {'content-type': 'text/event-stream'});
  for (const part of parts) response.write(`data: ${JSON.stringify({choices: [{delta: {content: part}}]})}\n\n`);
  response.write(`data: ${JSON.stringify({choices: [], usage})}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

function modelRequest() {
  return {system: 'Return JSON.', messages: [{role: 'user' as const, content: 'Open home'}], schema: {title: 'FlowDraftProbe', type: 'object'}, maxOutputTokens: 32, signal: AbortSignal.timeout(2_000)};
}

async function collect(provider: ReturnType<typeof createOpenAiCompatibleProvider>) {
  const events: {delta?: string; done?: {text: string; usage?: {inputTokens?: number; outputTokens?: number; cost?: number}; model?: string; upstreamProvider?: string}}[] = [];
  for await (const event of provider.generate(modelRequest())) events.push(event);
  return events;
}

test('the OpenAI-compatible adapter streams a json_schema chat completion', async () => {
  const server = await listen((_request, response, body) => {
    assert.equal(body.stream, true);
    assert.equal(body.model, 'gpt-test');
    assert.equal((body.response_format as {type?: string}).type, 'json_schema');
    assert.equal((body.response_format as {json_schema?: {schema?: {title?: string}}}).json_schema?.schema?.title, 'FlowDraftProbe');
    assert.equal((body.messages as {role: string}[])[0].role, 'system');
    sse(response, ['{"a":', '1}'], {prompt_tokens: 3, completion_tokens: 4});
  });
  try {
    const provider = createOpenAiCompatibleProvider({baseUrl: server.baseUrl, model: 'gpt-test', apiKey: 'sk-test-secret'});
    const events = await collect(provider);
    assert.equal(server.seen[0].authorization, 'Bearer sk-test-secret');
    assert.equal(server.seen[0].url, '/v1/chat/completions');
    assert.equal(server.seen[0].referer, undefined);
    assert.equal(server.seen[0].title, undefined);
    assert.equal(server.seen[0].body.usage, undefined);
    assert.equal(server.seen[0].body.models, undefined);
    assert.equal(events.at(-1)?.done?.text, '{"a":1}');
    assert.deepEqual(events.at(-1)?.done?.usage, {inputTokens: 3, outputTokens: 4});
    assert.equal(JSON.stringify(events).includes('sk-test-secret'), false);
  } finally { await server.close(); }
});

test('structured output falls back to a plain JSON response format', async () => {
  const server = await listen((_request, response, body) => {
    const format = body.response_format as {type?: string; json_schema?: unknown};
    const system = (body.messages as {content: string}[])[0].content;
    if (format?.type === 'json_schema') {
      assert.equal(system.includes('FlowDraftProbe'), false);
      response.writeHead(400, {'content-type': 'application/json'});
      response.end(JSON.stringify({error: {message: 'json_schema response_format is not supported', code: 'invalid_request_error'}}));
      return;
    }
    assert.equal(format?.type, 'json_object');
    assert.equal(format?.json_schema, undefined);
    assert.equal(system.includes('{"title":"FlowDraftProbe","type":"object"}'), true);
    sse(response, ['{"ok":true}'], {prompt_tokens: 1, completion_tokens: 2});
  });
  try {
    const provider = createOpenAiCompatibleProvider({baseUrl: server.baseUrl, model: 'gpt-test', apiKey: 'sk-test-secret'});
    const events = await collect(provider);
    assert.equal(server.seen.length, 2);
    assert.equal(events.at(-1)?.done?.text, '{"ok":true}');
  } finally { await server.close(); }
});

test('auth, rate limit, unknown model, and ordinary 400 responses do not echo the key', async () => {
  async function once(status: number, payload: unknown, headers: Record<string, string> = {}) {
    const server = await listen((_request, response) => {
      response.writeHead(status, {'content-type': 'application/json', ...headers});
      response.end(JSON.stringify(payload));
    });
    try {
      const provider = createOpenAiCompatibleProvider({baseUrl: server.baseUrl, model: 'missing-model', apiKey: 'sk-SUPER'});
      await collect(provider);
      assert.fail('expected a provider error');
    } catch (error) {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.message.includes('sk-SUPER'), false);
      return {error, seen: server.seen.length};
    } finally { await server.close(); }
  }
  const auth = await once(401, {error: {message: 'Incorrect API key sk-SUPER provided'}});
  assert.equal(auth.error.code, 'PROVIDER_AUTH');
  assert.equal(auth.error.retryable, false);
  assert.equal(auth.seen, 1);
  const limited = await once(429, {error: {message: 'slow down sk-SUPER'}}, {'retry-after': '7'});
  assert.equal(limited.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(limited.error.retryable, true);
  assert.equal(limited.error.retryAfterMs, 7_000);
  const missing = await once(404, {error: {code: 'model_not_found', message: 'no such model sk-SUPER'}});
  assert.equal(missing.error.code, 'PROVIDER_CONFIG');
  assert.equal(missing.error.retryable, false);
  const rejected = await once(400, {error: {message: 'bad max_tokens sk-SUPER', code: 'invalid_request_error'}});
  assert.equal(rejected.error.code, 'PROVIDER_REJECTED');
  assert.equal(rejected.error.retryable, false);
  assert.equal(rejected.seen, 1);
});

test('check reads the model list and does not return the response body', async () => {
  const server = await listen((request, response) => {
    assert.equal(request.url, '/v1/models');
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({data: [{id: 'gpt-test'}], secret: 'sk-SUPER'}));
  });
  try {
    const provider = createOpenAiCompatibleProvider({baseUrl: server.baseUrl, model: 'gpt-test', apiKey: 'sk-SUPER'});
    const result = await provider.check();
    assert.deepEqual(result, {ok: true, model: 'gpt-test'});
    assert.equal(server.seen[0].authorization, 'Bearer sk-SUPER');
    const unknown = createOpenAiCompatibleProvider({baseUrl: server.baseUrl, model: 'other', apiKey: 'sk-SUPER'});
    const missing = await unknown.check();
    assert.equal(missing.ok, false);
    assert.equal(JSON.stringify(missing).includes('sk-SUPER'), false);
  } finally { await server.close(); }
});

test('OpenRouter is the same adapter with a fixed URL, attribution headers, and no response format', async () => {
  const calls: {url: string; headers: Headers; body: Record<string, unknown>}[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}});
    return new Response(JSON.stringify({
      model: 'vendor/served', provider: 'DeepInfra',
      choices: [{message: {content: '{"ok":true}'}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 5, completion_tokens: 6, cost: 0.0042},
    }), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const provider = createOpenAiCompatibleProvider({baseUrl: 'https://evil.example/v1', model: 'vendor/model', apiKey: 'sk-test-secret', fetch: fetchImpl, preset: 'openrouter'});
  const events = await collect(provider);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer sk-test-secret');
  assert.equal(calls[0].headers.get('http-referer'), 'http://localhost');
  assert.equal(calls[0].headers.get('x-title'), 'TnT');
  assert.deepEqual(calls[0].body.usage, {include: true});
  assert.equal(calls[0].body.response_format, undefined);
  assert.equal(calls[0].body.models, undefined);
  assert.equal(calls[0].body.model, 'vendor/model');
  assert.equal(events.at(-1)?.done?.text, '{"ok":true}');
  assert.deepEqual(events.at(-1)?.done?.usage, {inputTokens: 5, outputTokens: 6, cost: 0.0042});
  assert.equal(events.at(-1)?.done?.model, 'vendor/served');
  assert.equal(events.at(-1)?.done?.upstreamProvider, 'DeepInfra');
  assert.equal(JSON.stringify(events).includes('sk-test-secret'), false);
});

test('an OpenRouter structured-output flag also requires the parameter', async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({choices: [{message: {content: '{}'}, finish_reason: 'stop'}]}), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const provider = createOpenAiCompatibleProvider({baseUrl: 'https://evil.example/v1', model: 'vendor/model', apiKey: 'sk-test-secret', fetch: fetchImpl, preset: 'openrouter', structuredOutput: true});
  await collect(provider);
  assert.equal((body.response_format as {type?: string}).type, 'json_schema');
  assert.deepEqual(body.provider, {require_parameters: true});
  assert.equal(body.models, undefined);
});

test('OpenRouter does not re-post when the endpoint rejects the request', async () => {
  let posts = 0;
  const fetchImpl: typeof fetch = async () => {
    posts += 1;
    return new Response(JSON.stringify({error: {message: 'json_schema response_format is not supported'}}), {status: 400, headers: {'content-type': 'application/json'}});
  };
  const provider = createOpenAiCompatibleProvider({baseUrl: 'https://evil.example/v1', model: 'vendor/model', apiKey: 'sk-test-secret', fetch: fetchImpl, preset: 'openrouter'});
  await assert.rejects(() => collect(provider), (error: unknown) => error instanceof ProviderRequestError && error.code === 'PROVIDER_REJECTED');
  assert.equal(posts, 1);
});

test('a fallback that also rejects stream_options stops at two posts', async () => {
  const server = await listen((_request, response, body) => {
    response.writeHead(400, {'content-type': 'application/json'});
    const format = body.response_format as {type?: string} | undefined;
    const message = format?.type === 'json_schema' ? 'response_format json_schema is not supported' : 'stream_options is not supported';
    response.end(JSON.stringify({error: {message}}));
  });
  try {
    const provider = createOpenAiCompatibleProvider({baseUrl: server.baseUrl, model: 'gpt-test', apiKey: 'sk-test-secret'});
    await assert.rejects(() => collect(provider), (error: unknown) => error instanceof ProviderRequestError && error.status === 400);
    assert.equal(server.seen.length, 2);
  } finally { await server.close(); }
});

test('402, an embedded 402, a 200 error, and a mid-stream error each post once', async () => {
  async function postsFor(fetchImpl: typeof fetch) {
    let posts = 0;
    const wrapped: typeof fetch = async (url, init) => {
      posts += 1;
      return fetchImpl(url, init);
    };
    const provider = createOpenAiCompatibleProvider({baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: 'sk-SUPER', fetch: wrapped});
    try {
      await collect(provider);
      assert.fail('expected a provider error');
    } catch (error) {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.message.includes('sk-SUPER'), false);
      return {error, posts};
    }
  }
  const credits = await postsFor(async () => new Response(JSON.stringify({error: {message: 'pay sk-SUPER'}}), {status: 402, headers: {'content-type': 'application/json'}}));
  assert.equal(credits.posts, 1);
  assert.equal(credits.error.status, 402);
  assert.equal(credits.error.retryable, false);
  const embedded = await postsFor(async () => new Response(JSON.stringify({error: {code: 402, message: 'pay sk-SUPER'}}), {status: 200, headers: {'content-type': 'application/json'}}));
  assert.equal(embedded.posts, 1);
  assert.equal(embedded.error.embeddedCode, 402);
  assert.equal(embedded.error.reason, 'embedded');
  assert.equal(embedded.error.retryable, false);
  const overloaded = await postsFor(async () => new Response(JSON.stringify({error: {message: 'overloaded sk-SUPER'}}), {status: 200, headers: {'content-type': 'application/json'}}));
  assert.equal(overloaded.posts, 1);
  assert.equal(overloaded.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(overloaded.error.reason, 'embedded');
  assert.equal(overloaded.error.retryable, false);
  const html = await postsFor(async () => new Response('<html>sk-SUPER</html>', {status: 502, headers: {'content-type': 'text/html'}}));
  assert.equal(html.posts, 1);
  assert.equal(html.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(html.error.message.includes('<html'), false);
  const stream = await postsFor(async () => new Response(
    `data: ${JSON.stringify({choices: [{delta: {content: '{'}}]})}\n\ndata: ${JSON.stringify({error: {message: 'mid sk-SUPER'}})}\n\n`,
    {status: 200, headers: {'content-type': 'text/event-stream'}},
  ));
  assert.equal(stream.posts, 1);
  assert.equal(stream.error.reason, 'embedded');
  assert.equal(stream.error.retryable, false);
});

test('a timeout aborts the one in-flight post', async () => {
  let posts = 0;
  const provider = createOpenAiCompatibleProvider({
    baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: 'sk-SUPER',
    fetch: (_url, init) => {
      posts += 1;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        };
        if (init?.signal?.aborted) { abort(); return; }
        init?.signal?.addEventListener('abort', abort, {once: true});
      });
    },
  });
  await assert.rejects(async () => {
    for await (const _event of provider.generate({...modelRequest(), signal: AbortSignal.timeout(40)})) void _event;
  }, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(posts, 1);
});
