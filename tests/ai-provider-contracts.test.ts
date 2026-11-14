import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {CANT_READ_IMAGES as clientMessage} from '../src/diagram-intake.js';
import {CANT_READ_IMAGES, mapProviderFailure} from '../server/ai/errors.js';
import {claudeMessageRequest, mapClaudeError, parseClaudeMessage} from '../server/ai/providers/claude-messages.js';
import {classifyCopilotFailure, copilotSendBody, mapCopilotSdkEvent} from '../server/ai/providers/copilot-runtime.js';
import {liveSmokeEnabled} from '../server/ai/providers/live-smoke.js';
import {createOpenAiCompatibleProvider} from '../server/ai/providers/openai-compatible.js';
import {ProviderRequestError} from '../server/ai/providers/types.js';

const image = {mimeType: 'image/png' as const, data: 'aGk='};
const request = {system: 'Return JSON.', messages: [{role: 'user' as const, content: 'Read this', image}], schema: {type: 'object'}, maxOutputTokens: 32, signal: AbortSignal.timeout(1000)};

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`./fixtures/providers/${name}`, import.meta.url), 'utf8')) as unknown;
}

function textFixture(name: string) {
  return readFileSync(new URL(`./fixtures/providers/${name}`, import.meta.url), 'utf8');
}

async function posted(preset: 'openai-compatible' | 'openrouter', model: string, respond: () => Response) {
  const seen: {headers: Headers; body: Record<string, unknown>}[] = [];
  const provider = createOpenAiCompatibleProvider({
    baseUrl: 'https://api.example.com/v1', model, apiKey: 'sk-SECRET', preset, fetch: async (_url, init) => {
      seen.push({headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown>});
      return respond();
    },
  });
  const events: {delta?: string; done?: {text: string; usage?: {inputTokens?: number; outputTokens?: number}; model?: string}}[] = [];
  try {
    for await (const event of provider.generate(request)) events.push(event);
    return {seen, events, error: undefined};
  } catch (error) {
    return {seen, events, error};
  }
}

test('recorded provider contracts cover image requests, responses, and errors', async () => {
  assert.equal(clientMessage, CANT_READ_IMAGES);

  const openai = await posted('openai-compatible', 'gpt-4o', () => new Response(textFixture('openai-sse.txt'), {status: 200, headers: {'content-type': 'text/event-stream'}}));
  assert.deepEqual(openai.seen[0]?.body, fixture('openai-image-request.json'));
  assert.equal(openai.events.map(event => event.delta).filter(Boolean).join(''), '{"ok":true}');
  assert.equal(openai.events.at(-1)?.done?.text, '{"ok":true}');
  assert.deepEqual(openai.events.at(-1)?.done?.usage, {inputTokens: 3, outputTokens: 4});
  assert.equal(openai.events.at(-1)?.done?.model, 'gpt-4o');
  assert.equal(JSON.stringify(openai.events).includes('sk-SECRET'), false);

  const openrouter = await posted('openrouter', 'anthropic/claude-sonnet-4.5', () => new Response('{"choices":[{"message":{"content":"{}"},"finish_reason":"stop"}]}', {status: 200, headers: {'content-type': 'application/json'}}));
  const recordedRouter = fixture('openrouter-image-request.json') as {headers: Record<string, string>; body: unknown};
  assert.deepEqual(openrouter.seen[0]?.body, recordedRouter.body);
  assert.equal(openrouter.seen[0]?.headers.get('http-referer'), recordedRouter.headers['HTTP-Referer']);
  assert.equal(openrouter.seen[0]?.headers.get('x-title'), recordedRouter.headers['X-Title']);

  const errors = fixture('openai-errors.json') as {name: string; status: number; body: unknown; code: string; retryable: boolean; appCode: string; embeddedCode?: string}[];
  for (const item of errors) {
    const result = await posted('openai-compatible', 'gpt-4o', () => new Response(JSON.stringify(item.body), {status: item.status, headers: {'content-type': 'application/json'}}));
    assert.ok(result.error instanceof ProviderRequestError, item.name);
    assert.equal(result.error.code, item.code, item.name);
    assert.equal(result.error.retryable, item.retryable, item.name);
    if (item.embeddedCode) assert.equal(result.error.embeddedCode, item.embeddedCode, item.name);
    assert.equal(result.error.message.includes('sk-SECRET'), false, item.name);
    const mapped = mapProviderFailure(result.error);
    assert.equal(mapped.code, item.appCode, item.name);
    if (item.appCode === 'MODEL_CANT_READ_IMAGES') assert.equal(mapped.message, CANT_READ_IMAGES);
  }

  assert.deepEqual(copilotSendBody({prompt: 'Read this', image}), fixture('copilot-image-request.json'));
  const copilot = fixture('copilot-events.json') as {events: unknown[]; mapped: unknown[]};
  const state = {text: ''};
  assert.deepEqual(copilot.events.map(event => mapCopilotSdkEvent(event, state)), copilot.mapped);
  assert.equal(classifyCopilotFailure({message: 'rate limit', statusCode: 429}).kind, 'rate-limit');
  assert.equal(JSON.stringify(copilot.mapped).includes('ghp_'), false);

  const claudeBody = claudeMessageRequest({model: 'claude-sonnet-4-5', system: 'Return JSON.', messages: [{role: 'user', content: 'Read this', image}], maxTokens: 32});
  assert.deepEqual(claudeBody, fixture('claude-image-request.json'));
  assert.deepEqual(parseClaudeMessage(fixture('claude-response.json')), {text: '{"ok":true}', model: 'claude-sonnet-4-5', usage: {inputTokens: 12, outputTokens: 4}});
  const claudeErrors = fixture('claude-errors.json') as {name: string; status: number; body: unknown; code: string; retryable: boolean; embeddedCode?: string}[];
  for (const item of claudeErrors) {
    const error = mapClaudeError(item.status, item.body);
    assert.equal(error.code, item.code, item.name);
    assert.equal(error.retryable, item.retryable, item.name);
    if (item.embeddedCode) {
      assert.equal(error.embeddedCode, item.embeddedCode, item.name);
      assert.equal(error.message, CANT_READ_IMAGES);
    }
  }

  assert.equal(liveSmokeEnabled({}), false);
  assert.equal(liveSmokeEnabled({TNT_PROVIDER_SMOKE_KEY: '   '}), false);
  assert.equal(liveSmokeEnabled({TNT_PROVIDER_SMOKE_KEY: 'present'}), true);
  const script = readFileSync(new URL('../scripts/provider-live-smoke.mjs', import.meta.url), 'utf8');
  assert.match(script, /TNT_PROVIDER_SMOKE_KEY is not set/);
  assert.equal(/TNT_LIVE_COPILOT\s*=/.test(script), false);
});
