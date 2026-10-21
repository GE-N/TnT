import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readdir, readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {AiHttpError} from '../server/ai/errors.js';
import {createKeychainStore} from '../server/ai/keychain.js';
import {createAi} from '../server/ai/index.js';
import {createFakeProvider} from '../server/ai/providers/fake.js';
import {createApiHandler} from '../server/http.js';
import {createRunner} from '../server/runner.js';
import {authoringFixture} from './authoring-helpers.js';

function memorySecrets() {
  const values = new Map<string, string>();
  return {values, async get(service: string) { return values.get(service); }, async set(service: string, value: string) { values.set(service, value); }, async delete(service: string) { values.delete(service); }};
}

async function configFixture(options: {env?: NodeJS.ProcessEnv; fetch?: typeof fetch; dev?: boolean; now?: () => Date; secrets?: ReturnType<typeof memorySecrets>} = {}) {
  const logs: string[] = [];
  const secrets = options.secrets ?? memorySecrets();
  const f = await authoringFixture();
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: options.env ?? {}, dev: options.dev, secrets, fetch: options.fetch, now: options.now, log: line => logs.push(line),
    provider: createFakeProvider(() => ({kind: 'ok', text: '{}'})),
  });
  await ai.ready;
  return {ai, f, logs, secrets, cleanup: async () => { await ai.idle(); await f.cleanup(); }};
}

function saveBody(over: Record<string, unknown> = {}) {
  return {
    expectedSettingsRevision: 0,
    selected: 'openai-compatible',
    provider: 'openai-compatible',
    model: 'gpt-test',
    baseUrl: 'https://api.openai.com/v1/',
    credential: {action: 'replace', apiKey: 'sk-SUPER-SECRET', storage: 'keychain'},
    ...over,
  };
}

async function treeHas(root: string, needle: string): Promise<boolean> {
  const entries = await readdir(root, {withFileTypes: true});
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await treeHas(path, needle)) return true;
    } else if (entry.isFile()) {
      const text = await readFile(path).catch(() => Buffer.alloc(0));
      if (text.includes(needle)) return true;
    }
  }
  return false;
}

test('keychain writes put the key on stdin and never in argv or env', async () => {
  const secret = 'sk-STDIN-ONLY';
  const previous = process.env.TNT_AI_API_KEY;
  process.env.TNT_AI_API_KEY = secret;
  const calls: {args: string[]; input?: string; env?: NodeJS.ProcessEnv}[] = [];
  const store = createKeychainStore(async request => {
    calls.push({args: request.args, input: request.input, env: request.env});
    if (request.args[0] === 'find-generic-password') return {code: 0, stdout: `${secret}\n`, stderr: ''};
    return {code: 0, stdout: '', stderr: ''};
  });
  try {
    await store.set('tnt.ai.openrouter', secret);
    assert.equal(await store.get('tnt.ai.openrouter'), secret);
    const write = calls.find(call => call.args[0] === '-i');
    assert.deepEqual(write?.args, ['-i']);
    assert.equal(write?.input?.includes(secret), true);
    for (const call of calls) {
      assert.equal(call.args.some(arg => arg.includes(secret)), false);
      assert.equal(Object.values(call.env ?? {}).some(value => typeof value === 'string' && value.includes(secret)), false);
      assert.equal(call.env?.TNT_AI_API_KEY, undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.TNT_AI_API_KEY;
    else process.env.TNT_AI_API_KEY = previous;
  }
});

test('config round-trip keeps the key out of the file, response, and logs', async () => {
  const seen: {url: string; authorization: string | null}[] = [];
  const g = await configFixture({fetch: async (url, init) => {
    seen.push({url: String(url), authorization: new Headers(init?.headers).get('authorization')});
    return new Response(JSON.stringify({data: [{id: 'gpt-test'}]}), {status: 200, headers: {'content-type': 'application/json'}});
  }});
  try {
    const saved = await g.ai.putConfig(saveBody());
    assert.equal(saved.settingsRevision, 1);
    assert.equal(saved.selected, 'openai-compatible');
    assert.equal(saved.providers['openai-compatible'].model, 'gpt-test');
    assert.equal(saved.providers['openai-compatible'].baseUrl, 'https://api.openai.com/v1');
    assert.equal(saved.providers['openai-compatible'].configured, true);
    assert.equal(saved.providers['openai-compatible'].keySource, 'keychain');
    assert.equal(saved.providers['openai-compatible'].credentialRevision, 1);
    assert.equal(saved.providers.openrouter.baseUrl, undefined);
    assert.equal(JSON.stringify(saved).includes('sk-SUPER-SECRET'), false);
    assert.equal(JSON.stringify(saved).includes('********'), false);
    const loaded = await g.ai.getConfig();
    assert.equal(loaded.providers['openai-compatible'].configured, true);
    assert.equal(JSON.stringify(loaded).includes('sk-SUPER-SECRET'), false);
    const file = await readFile(join(g.f.root, 'ai-config.json'), 'utf8');
    assert.equal(file.includes('sk-SUPER-SECRET'), false);
    assert.equal(file.includes('apiKey'), false);
    assert.equal((await stat(join(g.f.root, 'ai-config.json'))).mode & 0o777, 0o600);
    assert.equal(g.secrets.values.get('tnt.ai.openai-compatible'), 'sk-SUPER-SECRET');
    const checked = await g.ai.testConnection({provider: 'openai-compatible', testId: 'stored', source: 'stored', credentialRevision: 1});
    assert.equal(checked.ok, true);
    assert.equal(checked.message, "Connected. The model hasn't been tested yet.");
    assert.equal(JSON.stringify(checked).includes('sk-SUPER-SECRET'), false);
    assert.equal(g.logs.join('\n').includes('sk-SUPER-SECRET'), false);
    assert.equal(seen[0]?.authorization, 'Bearer sk-SUPER-SECRET');
    assert.equal(seen[0]?.url, 'https://api.openai.com/v1/models');
  } finally { await g.cleanup(); }
});

test('an environment key is reported as env in dev mode and is not written or returned', async () => {
  const g = await configFixture({env: {TNT_AI_API_KEY: 'sk-ENV-SECRET'}, fetch: async () => new Response(JSON.stringify({error: {message: 'rejected sk-ENV-SECRET'}}), {status: 401})});
  try {
    const saved = await g.ai.putConfig(saveBody({credential: {action: 'keep'}}));
    assert.equal(saved.providers['openai-compatible'].configured, false);
    assert.equal(saved.providers['openai-compatible'].keySource, 'env');
    assert.equal(JSON.stringify(saved).includes('sk-ENV-SECRET'), false);
    assert.equal(g.secrets.values.has('tnt.ai.openai-compatible'), false);
    const file = await readFile(join(g.f.root, 'ai-config.json'), 'utf8');
    assert.equal(file.includes('sk-ENV-SECRET'), false);
    const checked = await g.ai.testConnection({provider: 'openai-compatible', testId: 'env', source: 'stored', credentialRevision: 0});
    assert.equal(checked.ok, false);
    assert.equal(checked.code, 'AUTH_FAILED');
    assert.equal(JSON.stringify(checked).includes('sk-ENV-SECRET'), false);
    assert.equal(g.logs.join('\n').includes('sk-ENV-SECRET'), false);
  } finally { await g.cleanup(); }
});

test('TNT_AI_API_KEY is ignored when dev mode is off', async () => {
  const g = await configFixture({env: {TNT_AI_API_KEY: 'sk-ENV-SECRET', NODE_ENV: 'production'}, dev: false});
  try {
    const loaded = await g.ai.getConfig();
    assert.equal(loaded.providers.openrouter.keySource, undefined);
    assert.equal(loaded.providers['openai-compatible'].keySource, undefined);
    assert.equal(loaded.providers.openrouter.configured, false);
    assert.equal(JSON.stringify(loaded).includes('sk-ENV-SECRET'), false);
  } finally { await g.cleanup(); }
});

test('local providers, Anthropic, and non-cloud base URLs are rejected', async () => {
  const g = await configFixture();
  try {
    const cases = [
      saveBody({provider: 'ollama', selected: 'ollama', model: 'llama', baseUrl: 'http://127.0.0.1:11434'}),
      saveBody({provider: 'anthropic', selected: 'anthropic', model: 'claude', baseUrl: 'https://api.anthropic.com'}),
      saveBody({baseUrl: 'http://127.0.0.1:11434'}),
      saveBody({baseUrl: 'https://127.0.0.1/v1'}),
      saveBody({baseUrl: 'https://10.1.2.3/v1'}),
      saveBody({baseUrl: 'http://api.openai.com/v1'}),
    ];
    for (const body of cases) {
      await assert.rejects(() => g.ai.putConfig(body), (error: unknown) => (error as {status?: number; code?: string}).status === 400 && (error as {code?: string}).code === 'INVALID_CONFIG');
    }
    assert.equal(g.secrets.values.size, 0);
  } finally { await g.cleanup(); }
});

test('a hand-edited local base URL is not called', async () => {
  let called = false;
  const g = await configFixture({fetch: async () => { called = true; return new Response('no'); }});
  try {
    await g.ai.putConfig(saveBody());
    await writeFile(join(g.f.root, 'ai-config.json'), JSON.stringify({provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'http://127.0.0.1:11434'}));
    const loaded = await g.ai.getConfig();
    assert.equal(loaded.selected, 'openai-compatible');
    assert.equal(loaded.settingsRevision, 0);
    assert.equal(loaded.providers['openai-compatible'].baseUrl, 'http://127.0.0.1:11434');
    const connected = createAi({
      root: g.f.root, authoring: g.f.service.authoring, readWorkspace: id => g.f.service.workspace(id), env: {}, secrets: g.secrets, fetch: async () => { called = true; return new Response('no'); }, log: line => g.logs.push(line),
    });
    await connected.ready;
    const workspace = g.f.workspace;
    await assert.rejects(() => connected.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: 'Open home'}), (error: unknown) => (error as {code?: string}).code === 'PROVIDER_CONFIG');
    assert.equal(called, false);
    assert.equal(g.logs.join('\n').includes('sk-SUPER-SECRET'), false);
  } finally { await g.cleanup(); }
});

test('an empty apiKey is rejected and the stored key stays', async () => {
  const g = await configFixture();
  try {
    await g.ai.putConfig(saveBody({credential: {action: 'replace', apiKey: 'sk-KEEP', storage: 'keychain'}}));
    const before = await readFile(join(g.f.root, 'ai-config.json'), 'utf8');
    await assert.rejects(
      () => g.ai.putConfig(saveBody({expectedSettingsRevision: 1, credential: {action: 'replace', apiKey: '', storage: 'keychain'}})),
      (error: unknown) => (error as {status?: number; code?: string}).status === 400 && (error as {code?: string}).code === 'INVALID_CONFIG',
    );
    assert.equal(g.secrets.values.get('tnt.ai.openai-compatible'), 'sk-KEEP');
    assert.equal(await readFile(join(g.f.root, 'ai-config.json'), 'utf8'), before);
  } finally { await g.cleanup(); }
});

test('a stale settings revision is rejected and the typed key is not stored', async () => {
  const g = await configFixture();
  try {
    await g.ai.putConfig(saveBody({credential: {action: 'replace', apiKey: 'sk-KEEP', storage: 'keychain'}}));
    const before = await readFile(join(g.f.root, 'ai-config.json'), 'utf8');
    await assert.rejects(
      () => g.ai.putConfig(saveBody({expectedSettingsRevision: 0, model: 'other-model', credential: {action: 'replace', apiKey: 'sk-NEW', storage: 'keychain'}})),
      (error: unknown) => (error as {status?: number; code?: string}).status === 409 && (error as {code?: string}).code === 'SETTINGS_CHANGED',
    );
    assert.equal(g.secrets.values.get('tnt.ai.openai-compatible'), 'sk-KEEP');
    assert.equal(g.secrets.values.has('tnt.ai.openrouter'), false);
    assert.equal(await readFile(join(g.f.root, 'ai-config.json'), 'utf8'), before);
    const loaded = await g.ai.getConfig();
    assert.equal(loaded.providers['openai-compatible'].model, 'gpt-test');
    assert.equal(JSON.stringify(loaded).includes('sk-NEW'), false);
  } finally { await g.cleanup(); }
});

test('stored and replacement tests never change settings or the stored key', async () => {
  const seen: {url: string; authorization: string | null}[] = [];
  const g = await configFixture({fetch: async (url, init) => {
    seen.push({url: String(url), authorization: new Headers(init?.headers).get('authorization')});
    return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}});
  }});
  try {
    const saved = await g.ai.putConfig(saveBody());
    const before = await readFile(join(g.f.root, 'ai-config.json'), 'utf8');
    const stored = await g.ai.testConnection({provider: 'openai-compatible', testId: 'stored', source: 'stored', credentialRevision: saved.providers['openai-compatible'].credentialRevision});
    const replacement = await g.ai.testConnection({provider: 'openai-compatible', testId: 'typed', source: 'replacement', apiKey: 'sk-TYPED'});
    assert.equal(stored.ok, true);
    assert.equal(replacement.ok, true);
    assert.equal(replacement.testId, 'typed');
    assert.equal(await readFile(join(g.f.root, 'ai-config.json'), 'utf8'), before);
    assert.equal(g.secrets.values.get('tnt.ai.openai-compatible'), 'sk-SUPER-SECRET');
    assert.deepEqual(seen.map(call => call.authorization), ['Bearer sk-SUPER-SECRET', 'Bearer sk-TYPED']);
    const after = await g.ai.getConfig();
    assert.equal(after.settingsRevision, saved.settingsRevision);
    assert.equal(after.providers['openai-compatible'].credentialRevision, saved.providers['openai-compatible'].credentialRevision);
  } finally { await g.cleanup(); }
});

test('an OpenRouter test calls /api/v1/key once and a bad key fails without echoing it', async () => {
  const seen: string[] = [];
  const g = await configFixture({fetch: async url => {
    seen.push(String(url));
    return new Response(JSON.stringify({error: {message: 'rejected sk-BAD-KEY'}}), {status: 401, headers: {'content-type': 'application/json'}});
  }});
  try {
    const before = await g.ai.getConfig();
    const result = await g.ai.testConnection({provider: 'openrouter', testId: 'bad', source: 'replacement', apiKey: 'sk-BAD-KEY'});
    assert.deepEqual(seen, ['https://openrouter.ai/api/v1/key']);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AUTH_FAILED');
    assert.equal(result.testId, 'bad');
    assert.equal(JSON.stringify(result).includes('sk-BAD-KEY'), false);
    const after = await g.ai.getConfig();
    assert.equal(after.settingsRevision, before.settingsRevision);
    assert.equal(g.secrets.values.size, 0);
  } finally { await g.cleanup(); }
});

test('an upstream error does not echo the key', async () => {
  const g = await configFixture({fetch: async () => new Response('failed sk-LEAK upstream', {status: 500})});
  try {
    const failure = await g.ai.testConnection({provider: 'openrouter', testId: 'leak', source: 'replacement', apiKey: 'sk-LEAK'});
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(JSON.stringify(failure).includes('sk-LEAK'), false);
  } finally { await g.cleanup(); }
});

test('an OpenRouter success says the model has not been tested', async () => {
  const g = await configFixture({fetch: async url => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/key');
    return new Response('{"data":{"label":"sk-GOOD"}}', {status: 200});
  }});
  try {
    const result = await g.ai.testConnection({provider: 'openrouter', testId: 'ok', source: 'replacement', apiKey: 'sk-GOOD'});
    assert.deepEqual(result, {testId: 'ok', ok: true, message: "Connected to OpenRouter. The model hasn't been tested yet."});
    assert.equal(JSON.stringify(result).includes('sk-GOOD'), false);
  } finally { await g.cleanup(); }
});

test('remove leaves the provider unconfigured even when TNT_AI_API_KEY is set', async () => {
  let called = false;
  const g = await configFixture({env: {TNT_AI_API_KEY: 'sk-ENV-SECRET'}, fetch: async () => { called = true; return new Response('no', {status: 401}); }});
  try {
    const before = await g.ai.getConfig();
    assert.equal(before.providers.openrouter.keySource, 'env');
    assert.equal(before.providers.openrouter.configured, false);
    const removed = await g.ai.putConfig({
      expectedSettingsRevision: 0, selected: 'openrouter', provider: 'openrouter', model: 'vendor/model', credential: {action: 'remove'},
    });
    assert.equal(removed.providers.openrouter.configured, false);
    assert.equal(removed.providers.openrouter.keySource, undefined);
    assert.equal(removed.providers['openai-compatible'].keySource, 'env');
    called = false;
    const result = await g.ai.testConnection({provider: 'openrouter', testId: 'gone', source: 'stored', credentialRevision: removed.providers.openrouter.credentialRevision});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AI_NOT_CONFIGURED');
    assert.equal(called, false);
    assert.equal(JSON.stringify(removed).includes('sk-ENV-SECRET'), false);
    const file = await readFile(join(g.f.root, 'ai-config.json'), 'utf8');
    assert.equal(file.includes('sk-ENV-SECRET'), false);
  } finally { await g.cleanup(); }
});

test('a session-only key is absent from disk after save', async () => {
  const secret = 'sk-SESSION-ONLY-SENTINEL';
  const seen: string[] = [];
  const g = await configFixture({fetch: async (_url, init) => {
    seen.push(new Headers(init?.headers).get('authorization') ?? '');
    return new Response('{}', {status: 200});
  }});
  try {
    const saved = await g.ai.putConfig(saveBody({
      selected: 'openrouter', provider: 'openrouter', model: 'vendor/model', baseUrl: undefined, credential: {action: 'replace', apiKey: secret, storage: 'session'},
    }));
    assert.equal(saved.providers.openrouter.configured, true);
    assert.equal(saved.providers.openrouter.keySource, 'session');
    assert.equal(g.secrets.values.has('tnt.ai.openrouter'), false);
    const file = JSON.parse(await readFile(join(g.f.root, 'ai-config.json'), 'utf8')) as {providers: {openrouter: {storage?: string}}};
    assert.equal(file.providers.openrouter.storage, 'session');
    const checked = await g.ai.testConnection({provider: 'openrouter', testId: 'session', source: 'stored', credentialRevision: saved.providers.openrouter.credentialRevision});
    assert.equal(checked.ok, true);
    assert.deepEqual(seen, [`Bearer ${secret}`]);
    assert.equal(await treeHas(g.f.root, secret), false);
    assert.equal(g.logs.join('\n').includes(secret), false);
    assert.equal(JSON.stringify(checked).includes(secret), false);
  } finally { await g.cleanup(); }
});

test('a keychain failure leaves the previous config and key intact', async () => {
  const secrets = memorySecrets();
  let fail = false;
  const flaky = {
    values: secrets.values,
    async get(service: string) { return secrets.get(service); },
    async set(service: string, value: string) {
      if (fail) throw new AiHttpError(500, 'CREDENTIAL_STORAGE_FAILED', 'The API key could not be saved to the Keychain.');
      return secrets.set(service, value);
    },
    async delete(service: string) { return secrets.delete(service); },
  };
  const g = await configFixture({secrets: flaky});
  try {
    await g.ai.putConfig(saveBody({credential: {action: 'replace', apiKey: 'sk-KEEP', storage: 'keychain'}}));
    fail = true;
    await assert.rejects(
      () => g.ai.putConfig(saveBody({expectedSettingsRevision: 1, model: 'other-model', credential: {action: 'replace', apiKey: 'sk-NEW', storage: 'keychain'}})),
      (error: unknown) => (error as {code?: string}).code === 'CREDENTIAL_STORAGE_FAILED',
    );
    assert.equal(secrets.values.get('tnt.ai.openai-compatible'), 'sk-KEEP');
    const file = JSON.parse(await readFile(join(g.f.root, 'ai-config.json'), 'utf8')) as {settingsRevision: number; providers: {'openai-compatible': {model: string}}};
    assert.equal(file.settingsRevision, 1);
    assert.equal(file.providers['openai-compatible'].model, 'gpt-test');
  } finally { await g.cleanup(); }
});

test('each provider keeps its own key', async () => {
  const g = await configFixture();
  try {
    const first = await g.ai.putConfig(saveBody({credential: {action: 'replace', apiKey: 'sk-GENERIC', storage: 'keychain'}}));
    const second = await g.ai.putConfig({
      expectedSettingsRevision: first.settingsRevision, selected: 'openrouter', provider: 'openrouter', model: 'vendor/model',
      credential: {action: 'replace', apiKey: 'sk-ROUTER', storage: 'keychain'},
    });
    assert.equal(g.secrets.values.get('tnt.ai.openai-compatible'), 'sk-GENERIC');
    assert.equal(g.secrets.values.get('tnt.ai.openrouter'), 'sk-ROUTER');
    assert.equal(second.providers['openai-compatible'].configured, true);
    assert.equal(second.providers.openrouter.configured, true);
    assert.equal(second.selected, 'openrouter');
    await assert.rejects(() => g.ai.putConfig({...saveBody(), expectedSettingsRevision: second.settingsRevision, provider: 'openrouter', selected: 'openrouter', baseUrl: 'https://evil.example/v1'}), (error: unknown) => (error as {status?: number}).status === 400);
  } finally { await g.cleanup(); }
});

test('the model catalog is cached for 15 minutes and a failure does not block settings', async () => {
  let now = 0;
  let calls = 0;
  let fail = true;
  const g = await configFixture({
    now: () => new Date(now),
    fetch: async url => {
      calls += 1;
      assert.equal(String(url), 'https://openrouter.ai/api/v1/models');
      if (fail) return new Response(JSON.stringify({error: {message: 'down'}}), {status: 500});
      return new Response(JSON.stringify({data: [{id: 'vendor/model', supported_parameters: ['tools']}, {id: ''}, {id: 'other'}]}), {status: 200});
    },
  });
  try {
    await g.ai.putConfig({expectedSettingsRevision: 0, selected: 'openrouter', provider: 'openrouter', model: 'vendor/model', credential: {action: 'keep'}});
    const before = await readFile(join(g.f.root, 'ai-config.json'), 'utf8');
    await assert.rejects(() => g.ai.listModels('openrouter'), (error: unknown) => (error as {code?: string}).code === 'PROVIDER_UNAVAILABLE');
    assert.equal(await readFile(join(g.f.root, 'ai-config.json'), 'utf8'), before);
    fail = false;
    const listed = await g.ai.listModels('openrouter');
    assert.deepEqual(listed, {provider: 'openrouter', models: [{id: 'vendor/model', capabilities: ['tools']}, {id: 'other'}]});
    const again = await g.ai.listModels('openrouter');
    assert.equal(again.models.length, 2);
    assert.equal(calls, 2);
    now += 15 * 60 * 1000;
    await g.ai.listModels('openrouter');
    assert.equal(calls, 3);
  } finally { await g.cleanup(); }
});

async function withConfigServer(g: Awaited<ReturnType<typeof configFixture>>, run: (base: string, headers: Record<string, string>) => Promise<void>) {
  const runner = createRunner({artifactDirectory: g.f.root, execute: async () => { throw new Error('Catalog tests must not execute.'); }});
  const server = createServer(createApiHandler(runner, g.f.root, undefined, g.f.service, g.ai));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const token = ((await (await fetch(`${base}/api/status`)).json()) as {token: string}).token;
    await run(base, {origin: base, 'x-tnt-token': token});
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('GET /api/ai/models returns the full OpenRouter catalog with id and name', async () => {
  const entries = Array.from({length: 320}, (_, index) => ({
    id: index % 2 === 0 ? `openai/gpt-4o-${index}` : `anthropic/claude-3-${index}`,
    name: index % 2 === 0 ? `OpenAI: GPT-4o ${index}` : `Anthropic: Claude 3 ${index}`,
    description: 'x'.repeat(7_000),
    supported_parameters: index === 0 ? ['tools', '', 12, 'x'.repeat(81), 'json_schema'] : undefined,
  }));
  entries[0] = {...entries[0], id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini'};
  entries[1] = {...entries[1], id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet'};
  const payload = JSON.stringify({data: entries});
  assert.ok(payload.length > 2_000_000);
  assert.ok(payload.length < 8_000_000);
  let calls = 0;
  const g = await configFixture({
    fetch: async url => {
      calls += 1;
      assert.equal(String(url), 'https://openrouter.ai/api/v1/models');
      return new Response(payload, {status: 200});
    },
  });
  try {
    await g.ai.putConfig(saveBody());
    await withConfigServer(g, async (base, headers) => {
      const models = await fetch(`${base}/api/ai/models?provider=openrouter`, {headers});
      assert.equal(models.status, 200);
      const catalog = await models.json() as {provider: string; models: {id: string; name?: string; capabilities?: string[]}[]};
      assert.equal(catalog.provider, 'openrouter');
      assert.equal(catalog.models.length, entries.length);
      assert.ok(catalog.models.every(model => model.id.length > 0 && typeof model.name === 'string' && model.name.length > 0));
      assert.deepEqual(catalog.models[0], {id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini', capabilities: ['tools', 'json_schema']});
      assert.deepEqual(catalog.models[1], {id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet'});
      assert.equal(catalog.models.at(-1)?.id, entries.at(-1)?.id);
      assert.equal(catalog.models.at(-1)?.name, entries.at(-1)?.name);
      const again = await fetch(`${base}/api/ai/models?provider=openrouter`, {headers});
      assert.equal(again.status, 200);
      assert.equal(((await again.json()) as {models: unknown[]}).models.length, entries.length);
      assert.equal(calls, 1);
    });
  } finally { await g.cleanup(); }
});

test('a failed catalog fetch is not cached and GET /api/ai/models returns the catalog error', async () => {
  let calls = 0;
  let fail = true;
  const g = await configFixture({
    fetch: async url => {
      calls += 1;
      assert.equal(String(url), 'https://openrouter.ai/api/v1/models');
      if (fail) return new Response(JSON.stringify({error: {message: 'down'}}), {status: 503});
      return new Response(JSON.stringify({data: [{id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini'}]}), {status: 200});
    },
  });
  try {
    await withConfigServer(g, async (base, headers) => {
      const failed = await fetch(`${base}/api/ai/models?provider=openrouter`, {headers});
      assert.equal(failed.status, 502);
      assert.deepEqual(await failed.json(), {error: 'down', code: 'PROVIDER_UNAVAILABLE'});
      fail = false;
      const models = await fetch(`${base}/api/ai/models?provider=openrouter`, {headers});
      assert.equal(models.status, 200);
      assert.deepEqual(await models.json(), {provider: 'openrouter', models: [{id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini'}]});
      assert.equal(calls, 2);
    });
  } finally { await g.cleanup(); }
});

test('an empty catalog is not cached, and a name is optional and bounded', async () => {
  let calls = 0;
  let empty = true;
  const longName = `OpenAI: ${'G'.repeat(250)}`;
  const g = await configFixture({
    fetch: async () => {
      calls += 1;
      if (empty) return new Response(JSON.stringify({data: []}), {status: 200});
      return new Response(JSON.stringify({data: [
        {id: 'vendor/no-name'},
        {id: 'vendor/blank', name: '   '},
        {id: 'vendor/long', name: longName},
      ]}), {status: 200});
    },
  });
  try {
    assert.deepEqual(await g.ai.listModels('openrouter'), {provider: 'openrouter', models: []});
    empty = false;
    const listed = await g.ai.listModels('openrouter');
    assert.equal(calls, 2);
    assert.deepEqual(listed.models, [
      {id: 'vendor/no-name'},
      {id: 'vendor/blank'},
      {id: 'vendor/long', name: longName.slice(0, 200)},
    ]);
    assert.equal(listed.models[2]?.name?.length, 200);
  } finally { await g.cleanup(); }
});

test('a catalog body over 8 MB fails cleanly and is not cached', async () => {
  let calls = 0;
  let huge = true;
  const g = await configFixture({
    fetch: async () => {
      calls += 1;
      if (!huge) return new Response(JSON.stringify({data: [{id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini'}]}), {status: 200});
      return new Response(`{"data":[{"id":"openai/gpt-4o","name":"${'n'.repeat(8_000_000)}"}]}`, {status: 200});
    },
  });
  try {
    await assert.rejects(
      () => g.ai.listModels('openrouter'),
      (error: unknown) => (error as {code?: string; message?: string}).code === 'PROVIDER_UNAVAILABLE' && (error as {message?: string}).message === 'The model catalog is unavailable.',
    );
    huge = false;
    assert.deepEqual((await g.ai.listModels('openrouter')).models, [{id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini'}]);
    assert.equal(calls, 2);
  } finally { await g.cleanup(); }
});

test('HTTP config routes return metadata and never the key', async () => {
  const g = await configFixture({fetch: async url => new Response(JSON.stringify({data: [{id: 'vendor/model'}]}), {status: url.toString().endsWith('/key') ? 401 : 200})});
  const runner = createRunner({artifactDirectory: g.f.root, execute: async () => { throw new Error('Config HTTP tests must not execute.'); }});
  const server = createServer(createApiHandler(runner, g.f.root, undefined, g.f.service, g.ai));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const token = ((await (await fetch(`${base}/api/status`)).json()) as {token: string}).token;
    const headers = {'content-type': 'application/json', origin: base, 'x-tnt-token': token};
    const savedResponse = await fetch(`${base}/api/ai/config`, {method: 'PUT', headers, body: JSON.stringify(saveBody({credential: {action: 'replace', apiKey: 'sk-SUPER-SECRET', storage: 'keychain'}}))});
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as {settingsRevision: number; providers: {'openai-compatible': {configured: boolean; credentialRevision: number}}};
    assert.equal(saved.providers['openai-compatible'].configured, true);
    assert.equal(JSON.stringify(saved).includes('sk-SUPER-SECRET'), false);
    const loadedResponse = await fetch(`${base}/api/ai/config`, {headers});
    assert.equal(loadedResponse.status, 200);
    assert.equal(JSON.stringify(await loadedResponse.json()).includes('sk-SUPER-SECRET'), false);
    const empty = await fetch(`${base}/api/ai/config`, {method: 'PUT', headers, body: JSON.stringify(saveBody({expectedSettingsRevision: saved.settingsRevision, credential: {action: 'replace', apiKey: '', storage: 'keychain'}}))});
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as {code?: string}).code, 'INVALID_CONFIG');
    assert.equal(g.secrets.values.get('tnt.ai.openai-compatible'), 'sk-SUPER-SECRET');
    const stale = await fetch(`${base}/api/ai/config`, {method: 'PUT', headers, body: JSON.stringify(saveBody({expectedSettingsRevision: 0, credential: {action: 'replace', apiKey: 'sk-NEW', storage: 'keychain'}}))});
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as {code?: string}).code, 'SETTINGS_CHANGED');
    assert.equal(g.secrets.values.get('tnt.ai.openai-compatible'), 'sk-SUPER-SECRET');
    const tested = await fetch(`${base}/api/ai/config/test`, {method: 'POST', headers, body: JSON.stringify({provider: 'openrouter', testId: 'http', source: 'replacement', apiKey: 'sk-HTTP'})});
    assert.equal(tested.status, 200);
    const testBody = await tested.json() as {ok: boolean; testId: string};
    assert.equal(testBody.ok, false);
    assert.equal(testBody.testId, 'http');
    assert.equal(JSON.stringify(testBody).includes('sk-HTTP'), false);
    assert.equal(g.secrets.values.get('tnt.ai.openai-compatible'), 'sk-SUPER-SECRET');
    const models = await fetch(`${base}/api/ai/models?provider=openrouter`, {headers});
    assert.equal(models.status, 200);
    const catalog = await models.json() as {provider: string; models: {id: string}[]};
    assert.equal(catalog.provider, 'openrouter');
    assert.equal(catalog.models[0]?.id, 'vendor/model');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await g.cleanup();
  }
});
