import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {test} from 'node:test';
import {createOpenAiCompatibleProvider} from '../server/ai/providers/openai-compatible.js';
import {ProviderRequestError} from '../server/ai/providers/types.js';

type Seen = {url?: string; authorization?: string; body: Record<string, unknown>};

async function listen(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>, seen: Seen[]) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    seen.push({url: request.url, authorization: request.headers.authorization, body});
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
  const events: {delta?: string; done?: {text: string; usage?: {inputTokens?: number; outputTokens?: number}}}[] = [];
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
    assert.equal(events.at(-1)?.done?.text, '{"a":1}');
    assert.deepEqual(events.at(-1)?.done?.usage, {inputTokens: 3, outputTokens: 4});
    assert.equal(JSON.stringify(events).includes('sk-test-secret'), false);
  } finally { await server.close(); }
});

test('structured output falls back to a plain JSON response format', async () => {
  const server = await listen((_request, response, body) => {
    const format = body.response_format as {type?: string; json_schema?: unknown};
    if (format?.type === 'json_schema') {
      response.writeHead(400, {'content-type': 'application/json'});
      response.end(JSON.stringify({error: {message: 'json_schema response_format is not supported', code: 'invalid_request_error'}}));
      return;
    }
    assert.equal(format?.type, 'json_object');
    assert.equal(format?.json_schema, undefined);
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
