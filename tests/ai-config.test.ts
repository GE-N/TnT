import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAi} from '../server/ai/index.js';
import {createFakeProvider} from '../server/ai/providers/fake.js';
import {createApiHandler} from '../server/http.js';
import {createRunner} from '../server/runner.js';
import {authoringFixture} from './authoring-helpers.js';

function memorySecrets() {
  const values = new Map<string, string>();
  return {values, async get(service: string) { return values.get(service); }, async set(service: string, value: string) { values.set(service, value); }, async delete(service: string) { values.delete(service); }};
}

async function configFixture(env: NodeJS.ProcessEnv = {}, fetchImpl?: typeof fetch) {
  const logs: string[] = [];
  const secrets = memorySecrets();
  const f = await authoringFixture();
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env, secrets, fetch: fetchImpl, log: line => logs.push(line),
    provider: createFakeProvider(() => ({kind: 'ok', text: '{}'})),
  });
  await ai.ready;
  return {ai, f, logs, secrets, cleanup: async () => { await ai.idle(); await f.cleanup(); }};
}

test('config round-trip keeps the key out of the file, response, and logs', async () => {
  const seen: {url: string; authorization: string | null}[] = [];
  const g = await configFixture({}, async (url, init) => {
    seen.push({url: String(url), authorization: new Headers(init?.headers).get('authorization')});
    return new Response(JSON.stringify({data: [{id: 'gpt-test'}], echo: 'sk-SUPER-SECRET'}), {status: 200, headers: {'content-type': 'application/json'}});
  });
  try {
    const saved = await g.ai.putConfig({provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-SUPER-SECRET'});
    assert.deepEqual(saved, {provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://api.openai.com/v1', hasKey: true});
    assert.equal(JSON.stringify(saved).includes('sk-SUPER-SECRET'), false);
    const loaded = await g.ai.getConfig();
    assert.equal(loaded.hasKey, true);
    assert.equal(JSON.stringify(loaded).includes('sk-SUPER-SECRET'), false);
    const file = await readFile(join(g.f.root, 'ai-config.json'), 'utf8');
    assert.equal(file.includes('sk-SUPER-SECRET'), false);
    assert.equal(file.includes('apiKey'), false);
    assert.equal((await stat(join(g.f.root, 'ai-config.json'))).mode & 0o777, 0o600);
    assert.equal(g.secrets.values.get('tnt.ai.openai-compatible'), 'sk-SUPER-SECRET');
    const check = await g.ai.check();
    assert.deepEqual(check, {ok: true, model: 'gpt-test'});
    assert.equal(JSON.stringify(check).includes('sk-SUPER-SECRET'), false);
    assert.equal(g.logs.join('\n').includes('sk-SUPER-SECRET'), false);
    assert.equal(seen[0]?.authorization, 'Bearer sk-SUPER-SECRET');
    assert.equal(seen[0]?.url.endsWith('/models'), true);
  } finally { await g.cleanup(); }
});

test('an environment key counts as hasKey and is not written or returned', async () => {
  const g = await configFixture({TNT_AI_API_KEY: 'sk-ENV-SECRET'}, async () => new Response(JSON.stringify({error: {message: 'rejected sk-ENV-SECRET'}}), {status: 401}));
  try {
    const saved = await g.ai.putConfig({provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://api.openai.com/v1'});
    assert.equal(saved.hasKey, true);
    assert.equal(JSON.stringify(saved).includes('sk-ENV-SECRET'), false);
    assert.equal(g.secrets.values.has('tnt.ai.openai-compatible'), false);
    const file = await readFile(join(g.f.root, 'ai-config.json'), 'utf8');
    assert.equal(file.includes('sk-ENV-SECRET'), false);
    const check = await g.ai.check();
    assert.equal(check.ok, false);
    assert.equal(JSON.stringify(check).includes('sk-ENV-SECRET'), false);
    assert.equal(g.logs.join('\n').includes('sk-ENV-SECRET'), false);
  } finally { await g.cleanup(); }
});

test('local providers, Anthropic, and non-cloud base URLs are rejected', async () => {
  const g = await configFixture();
  try {
    const cases = [
      {provider: 'ollama', model: 'llama', baseUrl: 'http://127.0.0.1:11434'},
      {provider: 'anthropic', model: 'claude', baseUrl: 'https://api.anthropic.com'},
      {provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'http://127.0.0.1:11434'},
      {provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://127.0.0.1/v1'},
      {provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://10.1.2.3/v1'},
      {provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'http://api.openai.com/v1'},
    ];
    for (const body of cases) {
      await assert.rejects(() => g.ai.putConfig(body), (error: unknown) => (error as {status?: number; code?: string}).status === 400 && (error as {code?: string}).code === 'INVALID_CONFIG');
    }
  } finally { await g.cleanup(); }
});

test('a hand-edited local base URL is not called', async () => {
  let called = false;
  const g = await configFixture({}, async () => { called = true; return new Response('no'); });
  try {
    await g.ai.putConfig({provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-SUPER-SECRET'});
    await writeFile(join(g.f.root, 'ai-config.json'), JSON.stringify({provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'http://127.0.0.1:11434'}));
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

test('HTTP config routes return hasKey and never the key', async () => {
  const g = await configFixture();
  const runner = createRunner({artifactDirectory: g.f.root, execute: async () => { throw new Error('Config HTTP tests must not execute.'); }});
  const server = createServer(createApiHandler(runner, g.f.root, undefined, g.f.service, g.ai));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const token = ((await (await fetch(`${base}/api/status`)).json()) as {token: string}).token;
    const headers = {'content-type': 'application/json', origin: base, 'x-tnt-token': token};
    const savedResponse = await fetch(`${base}/api/ai/config`, {method: 'PUT', headers, body: JSON.stringify({provider: 'openai-compatible', model: 'gpt-test', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-SUPER-SECRET'})});
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as {hasKey: boolean};
    assert.equal(saved.hasKey, true);
    assert.equal(JSON.stringify(saved).includes('sk-SUPER-SECRET'), false);
    const loadedResponse = await fetch(`${base}/api/ai/config`, {headers});
    assert.equal(loadedResponse.status, 200);
    assert.equal(JSON.stringify(await loadedResponse.json()).includes('sk-SUPER-SECRET'), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await g.cleanup();
  }
});
