import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAi} from '../server/ai/index.js';
import {CALL_TIMEOUT_MS, FIRST_TOKEN_MS, JOB_TIMEOUT_MS, MAX_PROVIDER_RETRIES, RETRY_BACKOFF_MS} from '../server/ai/job.js';
import {PROMPT_CHAR_LIMIT, packPrompt} from '../server/ai/prompt.js';
import {createFakeProvider, type FakeResult} from '../server/ai/providers/fake.js';
import {ProviderRequestError} from '../server/ai/providers/types.js';
import {MAX_REPAIR_ROUNDS} from '../server/ai/repair.js';
import {createApiHandler} from '../server/http.js';
import {createRunner} from '../server/runner.js';
import {authoringFixture, exampleDraft, proofYaml} from './authoring-helpers.js';

const PROMPT = 'Open details and return home. UNIQUE_PROMPT_SENTINEL';

function memorySecrets() {
  const values = new Map<string, string>();
  return {values, async get(service: string) { return values.get(service); }, async set(service: string, value: string) { values.set(service, value); }, async delete(service: string) { values.delete(service); }};
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

async function generation(handle: (input: {call: number; system: string; messages: {role: string; content: string}[]}) => FakeResult | Promise<FakeResult>, options: {now?: () => Date; timeouts?: {firstTokenMs?: number; callMs?: number; jobMs?: number}; holdDelay?: boolean} = {}) {
  const logs: string[] = [];
  const waits: number[] = [];
  const f = await authoringFixture(options.now ? {now: options.now} : {});
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), now: options.now, env: {}, secrets: memorySecrets(),
    log: line => logs.push(line), provider: createFakeProvider(handle), timeouts: options.timeouts,
    scheduler: {
      now: () => Date.now(),
      delay(ms, signal) {
        waits.push(ms);
        if (!options.holdDelay) return Promise.resolve();
        return new Promise((resolve, reject) => {
          if (signal?.aborted) { reject(abortError()); return; }
          signal?.addEventListener('abort', () => reject(abortError()), {once: true});
          void resolve;
        });
      },
      schedule(ms, fn) {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
  });
  await ai.ready;
  return {ai, f, logs, waits, cleanup: async () => { await ai.idle(); await f.cleanup(); }};
}

function inputOf(workspace: {id: string; metadata?: {revision: number}}, prompt = PROMPT) {
  return {workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt};
}

async function settle<T extends {state: string}>(ai: {get(id: string): Promise<T>}, id: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await ai.get(id);
    if (job.state !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('generation did not finish');
}

test('generation limits match the provider budget', () => {
  assert.equal(FIRST_TOKEN_MS, 20_000);
  assert.equal(CALL_TIMEOUT_MS, 90_000);
  assert.equal(JOB_TIMEOUT_MS, 180_000);
  assert.deepEqual([...RETRY_BACKOFF_MS], [1_000, 4_000]);
  assert.equal(MAX_PROVIDER_RETRIES, 2);
  assert.equal(MAX_REPAIR_ROUNDS, 2);
  assert.equal(PROMPT_CHAR_LIMIT, 4_000);
});

test('a valid draft becomes an applicable preview and the prompt stays out of logs and the job file', async () => {
  const g = await generation(() => ({kind: 'ok', text: JSON.stringify(exampleDraft), usage: {inputTokens: 11, outputTokens: 22}}));
  try {
    const started = await g.ai.start(inputOf(g.f.workspace));
    assert.equal(started.state, 'running');
    assert.equal(started.phase, 'context');
    assert.equal(started.provenance, 'ai');
    assert.equal(started.contractVersion, 1);
    const job = await settle(g.ai, started.id);
    assert.equal(job.state, 'pending');
    assert.equal(job.preview?.applicable, true);
    assert.equal(typeof job.previewId, 'string');
    const body = JSON.stringify(job);
    assert.equal(body.includes('UNIQUE_PROMPT_SENTINEL'), false);
    assert.equal(body.includes(exampleDraft.name), false);
    const stored = await readFile(join(g.f.root, 'ai-jobs', `${started.id}.json`), 'utf8');
    assert.equal(stored.includes('UNIQUE_PROMPT_SENTINEL'), false);
    assert.equal(stored.includes('"draft"'), true);
    assert.equal((await stat(join(g.f.root, 'ai-jobs', `${started.id}.json`))).mode & 0o777, 0o600);
    const logged = g.logs.join('\n');
    assert.equal(logged.includes('UNIQUE_PROMPT_SENTINEL'), false);
    assert.equal(logged.includes(exampleDraft.name), false);
    assert.equal(logged.includes('"inputTokens":11'), true);
    assert.equal(logged.includes('"outputTokens":22'), true);
    assert.equal(logged.includes('"contractVersion":1'), true);
  } finally { await g.cleanup(); }
});

test('an invalid draft is repaired and a later call stays inside the prompt budget', async () => {
  const bad = structuredClone(exampleDraft) as {visits: {operations: {destination?: {visitKey?: string}}[]}[]};
  bad.visits[0].operations[1].destination!.visitKey = 'missingVisit';
  let calls = 0;
  const g = await generation(({call, system, messages}) => {
    calls = call;
    const size = system.length + messages.reduce((total, message) => total + message.content.length, 0);
    assert.ok(size <= PROMPT_CHAR_LIMIT, `prompt is ${size}`);
    if (call === 1) return {kind: 'ok', text: JSON.stringify(bad)};
    assert.equal(messages.some(message => message.content.includes('INVALID_TRANSITION')), true);
    return {kind: 'ok', text: JSON.stringify(exampleDraft)};
  });
  try {
    const started = await g.ai.start(inputOf(g.f.workspace));
    const job = await settle(g.ai, started.id);
    assert.equal(calls, 2);
    assert.equal(job.state, 'pending');
    assert.equal(job.preview?.applicable, true);
  } finally { await g.cleanup(); }
});

test('unresolved facts are not sent back for another repair round', async () => {
  const draft = structuredClone(exampleDraft) as {visits: {operations: {target?: unknown}[]}[]};
  draft.visits[0].operations[0].target = {kind: 'unresolved', description: 'Home title'};
  let calls = 0;
  const g = await generation(({call}) => { calls = call; return {kind: 'ok', text: JSON.stringify(draft)}; });
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(calls, 1);
    assert.equal(job.state, 'needsInfo');
    assert.equal(job.preview?.applicable, false);
    assert.equal(job.preview?.diagnostics.some(item => item.code === 'UNRESOLVED_TARGET'), true);
  } finally { await g.cleanup(); }
});

test('repair stops after two rounds and keeps the last preview', async () => {
  const bad = structuredClone(exampleDraft) as {visits: {operations: {destination?: {visitKey?: string}}[]}[]};
  bad.visits[0].operations[1].destination!.visitKey = 'missingVisit';
  let calls = 0;
  const g = await generation(({call}) => { calls = call; return {kind: 'ok', text: JSON.stringify(bad)}; });
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(calls, 3);
    assert.equal(job.state, 'needsInfo');
    assert.equal(job.preview?.applicable, false);
    assert.equal(typeof job.previewId, 'string');
  } finally { await g.cleanup(); }
});

test('a 429 is retried once after Retry-After, ahead of the 1s backoff', async () => {
  let calls = 0;
  const g = await generation(({call}) => {
    calls = call;
    if (call === 1) return {kind: 'fail', error: new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true, retryAfterMs: 3_000, status: 429})};
    return {kind: 'ok', text: JSON.stringify(exampleDraft)};
  });
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(calls, 2);
    assert.deepEqual(g.waits, [3_000]);
    assert.equal(job.state, 'pending');
  } finally { await g.cleanup(); }
});

test('provider failures stop after two retries and auth failures are not retried', async () => {
  let unavailable = 0;
  const busy = await generation(() => {
    unavailable++;
    return {kind: 'fail', error: new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: true, retryAfterMs: 3_000, status: 503})};
  });
  let authCalls = 0;
  const auth = await generation(() => {
    authCalls++;
    return {kind: 'fail', error: new ProviderRequestError({code: 'PROVIDER_AUTH', message: 'The model provider rejected the API key.', retryable: false, status: 401})};
  });
  try {
    const failed = await settle(busy.ai, (await busy.ai.start(inputOf(busy.f.workspace))).id);
    assert.equal(unavailable, 3);
    assert.deepEqual(busy.waits, [3_000, 4_000]);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error?.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(failed.error?.retryable, true);
    const rejected = await settle(auth.ai, (await auth.ai.start(inputOf(auth.f.workspace))).id);
    assert.equal(authCalls, 1);
    assert.deepEqual(auth.waits, []);
    assert.equal(rejected.error?.code, 'PROVIDER_AUTH');
    assert.equal(rejected.error?.retryable, false);
  } finally { await busy.cleanup(); await auth.cleanup(); }
});

test('the first-token timeout fails the job and a late draft is ignored', async () => {
  const g = await generation(() => ({kind: 'delay', ms: 200, text: JSON.stringify(exampleDraft)}), {timeouts: {firstTokenMs: 40, callMs: 5_000, jobMs: 5_000}});
  try {
    const started = await g.ai.start(inputOf(g.f.workspace));
    const job = await settle(g.ai, started.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'PROVIDER_TIMEOUT');
    assert.match(job.error?.message ?? '', /first token/);
    assert.equal(job.previewId, undefined);
    await new Promise(resolve => setTimeout(resolve, 250));
    const late = await g.ai.get(started.id);
    assert.equal(late.state, 'failed');
    assert.equal(late.previewId, undefined);
    assert.equal(JSON.stringify(late).includes(exampleDraft.name), false);
  } finally { await g.cleanup(); }
});

test('cancel ignores a model result that arrives afterwards', async () => {
  let release: () => void = () => {};
  const open = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void = () => {};
  const startedWaiting = new Promise<void>(resolve => { entered = resolve; });
  const g = await generation(() => ({kind: 'gate', text: JSON.stringify(exampleDraft), onEnter: entered, open}));
  try {
    const started = await g.ai.start(inputOf(g.f.workspace));
    await startedWaiting;
    assert.equal((await g.ai.get(started.id)).phase, 'model');
    const cancelled = await g.ai.cancel(started.id);
    assert.equal(cancelled.state, 'cancelled');
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    const late = await g.ai.get(started.id);
    assert.equal(late.state, 'cancelled');
    assert.equal(late.previewId, undefined);
    assert.equal(JSON.stringify(late).includes(exampleDraft.name), false);
  } finally { await g.cleanup(); }
});

test('a second generation for the same workspace is GENERATION_BUSY until the first finishes', async () => {
  let release: () => void = () => {};
  const open = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void = () => {};
  const startedWaiting = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const g = await generation(({call}) => {
    calls = call;
    if (call === 1) return {kind: 'gate', text: JSON.stringify(exampleDraft), onEnter: entered, open};
    return {kind: 'ok', text: JSON.stringify(exampleDraft)};
  });
  try {
    const other = await g.f.service.save({name: 'Other', yaml: proofYaml, flows: {}, scenarios: [], canvas: {screens: [], edges: [], paths: []}});
    const first = await g.ai.start(inputOf(g.f.workspace));
    await startedWaiting;
    await assert.rejects(() => g.ai.start(inputOf(g.f.workspace)), (error: unknown) => {
      assert.equal((error as {status?: number; code?: string}).status, 409);
      assert.equal((error as {code?: string}).code, 'GENERATION_BUSY');
      return true;
    });
    const second = await settle(g.ai, (await g.ai.start(inputOf(other))).id);
    assert.equal(second.state, 'pending');
    await g.ai.cancel(first.id);
    release();
    const retried = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(retried.state, 'pending');
    assert.ok(calls >= 2);
  } finally { await g.cleanup(); }
});

test('packed context stays within 4000 characters', () => {
  const screens = Array.from({length: 80}, (_, index) => ({screenId: `screen${index}`, title: 'T'.repeat(80)}));
  const targets = Array.from({length: 200}, (_, index) => ({ref: `target${index}`, screenId: 'screen0', role: 'tap', selector: {target: 'id', match: 'exact', value: 'x'.repeat(40)}}));
  const packed = packPrompt({
    prompt: 'Open the home screen', appId: 'com.example.TnTProof',
    context: {screens, targets, setups: [{ref: 'setup-1', file: 'launch.yaml', parameterNames: ['EMAIL']}], handlers: [], mocks: [], omissions: [{kind: 'mock', reason: 'secret-values-omitted'}], availableScreens: 40, availableTransitions: 80},
  });
  assert.ok(packed.system.length + packed.user.length <= PROMPT_CHAR_LIMIT);
  assert.equal(packed.user.includes('com.example.TnTProof'), true);
  assert.equal(packed.user.includes('Open the home screen'), true);
  assert.equal(packed.user.includes('EMAIL'), true);
  assert.equal(packed.user.includes('targets omitted:'), true);
});

test('a restarted workbench drops a poisoned key from a retained job', async () => {
  const g = await generation(() => ({kind: 'ok', text: JSON.stringify(exampleDraft)}));
  try {
    const id = (await g.ai.start(inputOf(g.f.workspace))).id;
    await settle(g.ai, id);
    const path = join(g.f.root, 'ai-jobs', `${id}.json`);
    const poisoned = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    poisoned.apiKey = 'sk-POISON';
    poisoned.prompt = PROMPT;
    await writeFile(path, JSON.stringify(poisoned));
    const restarted = createAi({
      root: g.f.root, authoring: g.f.service.authoring, readWorkspace: workspaceId => g.f.service.workspace(workspaceId), env: {}, secrets: memorySecrets(), log: () => {}, provider: createFakeProvider(() => ({kind: 'ok', text: '{}'})),
    });
    await restarted.ready;
    const job = await restarted.get(id);
    const body = JSON.stringify(job);
    assert.equal(body.includes('sk-POISON'), false);
    assert.equal(body.includes('UNIQUE_PROMPT_SENTINEL'), false);
    const rewritten = await readFile(path, 'utf8');
    assert.equal(rewritten.includes('sk-POISON'), false);
    assert.equal(rewritten.includes('UNIQUE_PROMPT_SENTINEL'), false);
  } finally { await g.cleanup(); }
});

test('preview bodies expire after 30 minutes and jobs expire after 7 days', async () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const g = await generation(() => ({kind: 'ok', text: JSON.stringify(exampleDraft)}), {now: () => new Date(clock)});
  try {
    const id = (await g.ai.start(inputOf(g.f.workspace))).id;
    const ready = await settle(g.ai, id);
    assert.equal(ready.preview?.applicable, true);
    clock += 31 * 60 * 1000;
    const aged = await g.ai.get(id);
    assert.equal(aged.state, 'pending');
    assert.equal(aged.preview, undefined);
    assert.equal(typeof aged.previewId, 'string');
    clock += 8 * 24 * 60 * 60 * 1000;
    await assert.rejects(() => g.ai.get(id), (error: unknown) => (error as {status?: number}).status === 404);
  } finally { await g.cleanup(); }
});

test('HTTP generation routes poll, reject a busy workspace, and cancel', async () => {
  let release: () => void = () => {};
  const open = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void = () => {};
  const startedWaiting = new Promise<void>(resolve => { entered = resolve; });
  const g = await generation(() => ({kind: 'gate', text: JSON.stringify(exampleDraft), onEnter: entered, open}));
  const runner = createRunner({artifactDirectory: g.f.root, execute: async () => { throw new Error('HTTP generation tests must not execute.'); }});
  const server = createServer(createApiHandler(runner, g.f.root, undefined, g.f.service, g.ai));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const token = ((await (await fetch(`${base}/api/status`)).json()) as {token: string}).token;
    const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST', headers: {'content-type': 'application/json', origin: base, ...headers}, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const anonymous = await request('/api/ai/generations', inputOf(g.f.workspace));
    assert.equal(anonymous.status, 403);
    const headers = {'x-tnt-token': token};
    const startedResponse = await request('/api/ai/generations', inputOf(g.f.workspace), headers);
    assert.equal(startedResponse.status, 202);
    const started = await startedResponse.json() as {id: string; state: string};
    assert.equal(started.state, 'running');
    assert.equal(JSON.stringify(started).includes('UNIQUE_PROMPT_SENTINEL'), false);
    await startedWaiting;
    const busy = await request('/api/ai/generations', inputOf(g.f.workspace), headers);
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, 'GENERATION_BUSY');
    const polled = await request(`/api/ai/generations/${started.id}`, undefined, headers);
    assert.equal(polled.status, 200);
    assert.equal((await polled.json()).phase, 'model');
    const cancelled = await request(`/api/ai/generations/${started.id}/cancel`, {}, headers);
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).state, 'cancelled');
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    const late = await (await request(`/api/ai/generations/${started.id}`, undefined, headers)).json() as {state: string; previewId?: string};
    assert.equal(late.state, 'cancelled');
    assert.equal(late.previewId, undefined);
  } finally {
    release();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await g.cleanup();
  }
});
