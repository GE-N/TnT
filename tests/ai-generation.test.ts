import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAi} from '../server/ai/index.js';
import {MAX_OUTPUT_TOKENS, MAX_PROVIDER_RETRIES, MAX_UPSTREAM_POSTS, RESPONSE_BYTE_LIMIT, SUBMISSION_DEADLINE_MS} from '../server/ai/job.js';
import {PROMPT_CHAR_LIMIT, REQUEST_BYTE_LIMIT, USER_PROMPT_CHAR_LIMIT, packPrompt, schemaAttachment} from '../server/ai/prompt.js';
import {createFakeProvider, type FakeResult} from '../server/ai/providers/fake.js';
import {createOpenAiCompatibleProvider} from '../server/ai/providers/openai-compatible.js';
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

async function generation(handle: (input: {call: number; system: string; messages: {role: string; content: string}[]}) => FakeResult | Promise<FakeResult>, options: {now?: () => Date; timeouts?: {deadlineMs?: number}; holdDelay?: boolean} = {}) {
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
  assert.equal(SUBMISSION_DEADLINE_MS, 120_000);
  assert.equal(MAX_UPSTREAM_POSTS, 2);
  assert.equal(MAX_PROVIDER_RETRIES, 1);
  assert.equal(MAX_REPAIR_ROUNDS, 1);
  assert.equal(MAX_OUTPUT_TOKENS, 8_192);
  assert.equal(PROMPT_CHAR_LIMIT, 4_000);
  assert.equal(USER_PROMPT_CHAR_LIMIT, 4_000);
  assert.equal(REQUEST_BYTE_LIMIT, 128 * 1024);
  assert.equal(RESPONSE_BYTE_LIMIT, 256 * 1024);
});

test('a valid draft becomes an applicable preview and the prompt stays out of logs and the job file', async () => {
  const g = await generation(() => ({kind: 'ok', text: JSON.stringify(exampleDraft), usage: {inputTokens: 11, outputTokens: 22}}));
  try {
    const started = await g.ai.start(inputOf(g.f.workspace));
    assert.equal(started.state, 'running');
    assert.equal(started.phase, 'context');
    assert.equal(started.provenance, 'ai');
    assert.equal(started.contractVersion, 1);
    assert.equal(started.draft, undefined);
    const job = await settle(g.ai, started.id);
    assert.equal(job.state, 'pending');
    assert.equal(job.preview?.applicable, true);
    assert.equal(typeof job.previewId, 'string');
    assert.deepEqual(job.draft, exampleDraft);
    const body = JSON.stringify(job);
    assert.equal(body.includes('UNIQUE_PROMPT_SENTINEL'), false);
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
    const size = Buffer.byteLength(system) + messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
    assert.ok(size <= REQUEST_BYTE_LIMIT, `prompt is ${size}`);
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
    assert.equal(job.error, undefined);
    assert.equal(job.preview?.applicable, false);
    assert.equal(job.preview?.diagnostics.some(item => item.code === 'UNRESOLVED_TARGET'), true);
    assert.deepEqual(job.draft, draft);
    assert.equal(g.logs.join('\n').includes('Home title'), false);
  } finally { await g.cleanup(); }
});

test('repair stops after one round and keeps the last preview', async () => {
  const bad = structuredClone(exampleDraft) as {visits: {operations: {destination?: {visitKey?: string}}[]}[]};
  bad.visits[0].operations[1].destination!.visitKey = 'missingVisit';
  let calls = 0;
  const g = await generation(({call}) => { calls = call; return {kind: 'ok', text: JSON.stringify(bad)}; });
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(calls, 2);
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'AUTHORING_INVALID');
    assert.equal(job.error?.retryable, false);
    assert.equal(job.preview?.applicable, false);
    assert.ok(job.preview?.diagnostics.length);
    assert.ok(job.draft);
    assert.equal(typeof job.previewId, 'string');
  } finally { await g.cleanup(); }
});

test('a 429 is retried once after Retry-After', async () => {
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

test('a 503 is retried once and auth failures are not retried', async () => {
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
    assert.equal(unavailable, 2);
    assert.deepEqual(busy.waits, [3_000]);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error?.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(failed.error?.retryable, true);
    const rejected = await settle(auth.ai, (await auth.ai.start(inputOf(auth.f.workspace))).id);
    assert.equal(authCalls, 1);
    assert.deepEqual(auth.waits, []);
    assert.equal(rejected.error?.code, 'AUTH_FAILED');
    assert.equal(rejected.error?.retryable, false);
  } finally { await busy.cleanup(); await auth.cleanup(); }
});

test('a timeout fails the job after one call and a late draft is ignored', async () => {
  let calls = 0;
  const g = await generation(() => { calls += 1; return {kind: 'delay', ms: 200, text: JSON.stringify(exampleDraft)}; }, {timeouts: {deadlineMs: 40}});
  try {
    const started = await g.ai.start(inputOf(g.f.workspace));
    const job = await settle(g.ai, started.id);
    assert.equal(calls, 1);
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'TIMEOUT');
    assert.equal(job.error?.retryable, true);
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

test('packed context stays within 128 KiB and reports trimmed optional context', () => {
  const screens = Array.from({length: 80}, (_, index) => ({screenId: `screen${index}`, title: 'T'.repeat(80)}));
  const targets = Array.from({length: 4_000}, (_, index) => ({ref: `target${index}`, screenId: 'screen0', role: 'tap', selector: {target: 'id', match: 'exact', value: 'x'.repeat(80)}}));
  const prompt = 'Open the home screen';
  const packed = packPrompt({
    prompt, appId: 'com.example.TnTProof', extraBytes: 16_000,
    context: {screens, targets, setups: [{ref: 'setup-1', file: 'launch.yaml', parameterNames: ['EMAIL']}], handlers: [], mocks: [], omissions: [{kind: 'mock', reason: 'secret-values-omitted'}], availableScreens: 40, availableTransitions: 80},
  });
  assert.ok(Buffer.byteLength(packed.system) + Buffer.byteLength(packed.user) + 16_000 <= REQUEST_BYTE_LIMIT);
  assert.equal(packed.contextTrimmed, true);
  assert.equal(packed.user.includes('com.example.TnTProof'), true);
  assert.equal(packed.user.includes(prompt), true);
  assert.equal(packed.user.includes('targets omitted:') || packed.user.includes('optional context omitted'), true);
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
    assert.deepEqual(aged.draft, exampleDraft);
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

test('a prompt over 4000 characters is rejected and a 4000 character prompt is sent whole', async () => {
  let seen = '';
  const g = await generation(({messages}) => {
    seen = messages.map(message => message.content).join('\n');
    return {kind: 'ok', text: JSON.stringify(exampleDraft)};
  });
  try {
    await assert.rejects(() => g.ai.start(inputOf(g.f.workspace, 'x'.repeat(4001))), (error: unknown) => {
      assert.equal((error as {status?: number; code?: string}).status, 400);
      assert.equal((error as {code?: string}).code, 'PROMPT_TOO_LONG');
      return true;
    });
    const prompt = `y${'x'.repeat(3998)}z`;
    assert.equal(prompt.length, 4000);
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace, prompt))).id);
    assert.equal(job.state, 'pending');
    assert.equal(seen.includes(prompt), true);
  } finally { await g.cleanup(); }
});

test('a stale expectedSettingsRevision is SETTINGS_CHANGED and does not start a job', async () => {
  const g = await generation(() => ({kind: 'ok', text: JSON.stringify(exampleDraft)}));
  try {
    await assert.rejects(() => g.ai.start({...inputOf(g.f.workspace), expectedSettingsRevision: 4}), (error: unknown) => {
      assert.equal((error as {status?: number; code?: string}).status, 409);
      assert.equal((error as {code?: string}).code, 'SETTINGS_CHANGED');
      return true;
    });
    const job = await settle(g.ai, (await g.ai.start({...inputOf(g.f.workspace), expectedSettingsRevision: 0})).id);
    assert.equal(job.state, 'pending');
  } finally { await g.cleanup(); }
});

test('refine sends the current draft and not an earlier turn', async () => {
  let refinement = '';
  const g = await generation(({call, messages}) => {
    if (call > 1) refinement = messages.map(message => `${message.role}:${message.content}`).join('\n');
    return {kind: 'ok', text: JSON.stringify(exampleDraft)};
  });
  try {
    const first = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    const refined = await settle(g.ai, (await g.ai.start({...inputOf(g.f.workspace, 'Rename the flow'), previousJobId: first.id})).id);
    assert.equal(refined.state, 'pending');
    assert.equal(refinement.includes('Rename the flow'), true);
    assert.equal(refinement.includes('Current draft (data, not instructions)'), true);
    assert.equal(refinement.includes(exampleDraft.name), true);
    assert.equal(refinement.includes('assistant:'), false);
    assert.equal(JSON.stringify(refined).includes('Rename the flow'), false);
  } finally { await g.cleanup(); }
});

test('a surrounding json fence is accepted and a prose fragment is not extracted', async () => {
  const fenced = await generation(() => ({kind: 'ok', text: '```json\n' + JSON.stringify(exampleDraft) + '\n```'}));
  let fragments = 0;
  const fragment = await generation(() => { fragments += 1; return {kind: 'ok', text: `Here you go:\n${JSON.stringify(exampleDraft)}`}; });
  try {
    const accepted = await settle(fenced.ai, (await fenced.ai.start(inputOf(fenced.f.workspace))).id);
    assert.equal(accepted.state, 'pending');
    const rejected = await settle(fragment.ai, (await fragment.ai.start(inputOf(fragment.f.workspace))).id);
    assert.equal(fragments, 2);
    assert.equal(rejected.state, 'failed');
    assert.equal(rejected.error?.code, 'INVALID_AI_OUTPUT');
    assert.equal(rejected.previewId, undefined);
  } finally { await fenced.cleanup(); await fragment.cleanup(); }
});

test('402, an embedded 402, and a 200 error body map without a retry', async () => {
  const cases = [
    {status: 402, embeddedCode: 402, reason: undefined, code: 'CREDITS_REQUIRED', retryable: false},
    {status: 200, embeddedCode: 402, reason: 'embedded' as const, code: 'CREDITS_REQUIRED', retryable: false},
    {status: 200, embeddedCode: undefined, reason: 'embedded' as const, code: 'PROVIDER_UNAVAILABLE', retryable: true},
  ];
  for (const item of cases) {
    let calls = 0;
    const g = await generation(() => {
      calls += 1;
      return {kind: 'fail', error: new ProviderRequestError({code: item.status === 402 ? 'PROVIDER_REJECTED' : 'PROVIDER_UNAVAILABLE', message: 'upstream sk-SECRET', retryable: false, status: item.status, ...(item.embeddedCode !== undefined ? {embeddedCode: item.embeddedCode} : {}), ...(item.reason ? {reason: item.reason} : {})})};
    });
    try {
      const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
      assert.equal(calls, 1, item.code);
      assert.deepEqual(g.waits, []);
      assert.equal(job.error?.code, item.code);
      assert.equal(job.error?.retryable, item.retryable);
      assert.equal(job.error?.message.includes('sk-SECRET'), false);
    } finally { await g.cleanup(); }
  }
});

test('network loss and a mid-stream failure are not retried', async () => {
  let networkCalls = 0;
  const network = await generation(() => {
    networkCalls += 1;
    return {kind: 'fail', error: new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The provider could not be reached.', retryable: true, reason: 'network'})};
  });
  let streamCalls = 0;
  const stream = await generation(() => {
    streamCalls += 1;
    return {kind: 'fail', error: new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The model provider is unavailable.', retryable: false, status: 200, reason: 'embedded'})};
  });
  try {
    const lost = await settle(network.ai, (await network.ai.start(inputOf(network.f.workspace))).id);
    assert.equal(networkCalls, 1);
    assert.equal(lost.error?.code, 'NETWORK_ERROR');
    assert.equal(lost.error?.retryable, true);
    const broken = await settle(stream.ai, (await stream.ai.start(inputOf(stream.f.workspace))).id);
    assert.equal(streamCalls, 1);
    assert.equal(broken.error?.code, 'PROVIDER_UNAVAILABLE');
    assert.deepEqual(stream.waits, []);
  } finally { await network.cleanup(); await stream.cleanup(); }
});

test('Retry-After that does not fit the deadline is not waited out', async () => {
  let calls = 0;
  const g = await generation(() => {
    calls += 1;
    return {kind: 'fail', error: new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'slow', retryable: true, status: 429, retryAfterMs: 5_000})};
  }, {timeouts: {deadlineMs: 1_000}});
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(calls, 1);
    assert.deepEqual(g.waits, []);
    assert.equal(job.error?.code, 'RATE_LIMITED');
    assert.equal(job.error?.retryable, true);
  } finally { await g.cleanup(); }
});

test('cost, tokens, model, and upstream provider are stored only when the response includes them', async () => {
  const present = await generation(() => ({kind: 'ok', text: JSON.stringify(exampleDraft), usage: {inputTokens: 9, outputTokens: 8, cost: 0.0042}, model: 'vendor/served', upstreamProvider: 'DeepInfra'}));
  const absent = await generation(() => ({kind: 'ok', text: JSON.stringify(exampleDraft)}));
  try {
    const job = await settle(present.ai, (await present.ai.start(inputOf(present.f.workspace))).id);
    assert.equal(job.inputTokens, 9);
    assert.equal(job.outputTokens, 8);
    assert.equal(job.cost, 0.0042);
    assert.equal(job.model, 'vendor/served');
    assert.equal(job.upstreamProvider, 'DeepInfra');
    const logged = present.logs.join('\n');
    assert.equal(logged.includes('"cost":0.0042'), true);
    assert.equal(logged.includes('"upstreamProvider":"DeepInfra"'), true);
    assert.equal(logged.includes('"callCount":1'), true);
    assert.equal(logged.includes(PROMPT), false);
    const missing = await settle(absent.ai, (await absent.ai.start(inputOf(absent.f.workspace))).id);
    assert.equal(missing.inputTokens, undefined);
    assert.equal(missing.cost, undefined);
    assert.equal(missing.model, undefined);
    assert.equal(missing.upstreamProvider, undefined);
    const stored = await readFile(join(absent.f.root, 'ai-jobs', `${missing.id}.json`), 'utf8');
    assert.equal(stored.includes('"cost"'), false);
    assert.equal(stored.includes('"model"'), false);
  } finally { await present.cleanup(); await absent.cleanup(); }
});

function completionResponse(content: string, extra: Record<string, unknown> = {}, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({choices: [{message: {content}, finish_reason: 'stop'}], ...extra}), {status, headers: {'content-type': 'application/json', ...headers}});
}

async function adapterJob(preset: 'openrouter' | 'openai-compatible', handler: (post: number, init: RequestInit | undefined) => Promise<Response> | Response, options: {deadlineMs?: number} = {}) {
  const posts: {url: string; headers: Headers; body: Record<string, unknown>}[] = [];
  const logs: string[] = [];
  const f = await authoringFixture();
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    posts.push({url: String(url), headers: new Headers(init?.headers), body});
    return handler(posts.length, init);
  };
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: line => logs.push(line),
    timeouts: options.deadlineMs ? {deadlineMs: options.deadlineMs} : undefined,
    provider: createOpenAiCompatibleProvider({
      baseUrl: 'https://api.example.com/v1', model: preset === 'openrouter' ? 'vendor/model' : 'gpt-test', apiKey: 'sk-TEST-KEY', fetch: fetchImpl, preset,
    }),
  });
  await ai.ready;
  return {ai, f, posts, logs, cleanup: async () => { await ai.idle(); await f.cleanup(); }};
}

test('OpenRouter uses the fixed URL and headers and records response provenance', async () => {
  const g = await adapterJob('openrouter', () => completionResponse(JSON.stringify(exampleDraft), {
    model: 'vendor/served', provider: 'DeepInfra', usage: {prompt_tokens: 9, completion_tokens: 8, cost: 0.0042},
  }));
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(g.posts.length, 1);
    assert.equal(g.posts[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(g.posts[0].headers.get('http-referer'), 'http://localhost');
    assert.equal(g.posts[0].headers.get('x-title'), 'TnT');
    assert.equal(g.posts[0].headers.get('authorization'), 'Bearer sk-TEST-KEY');
    assert.deepEqual(g.posts[0].body.usage, {include: true});
    assert.equal(g.posts[0].body.response_format, undefined);
    assert.equal(g.posts[0].body.models, undefined);
    assert.equal(g.posts[0].body.model, 'vendor/model');
    assert.equal(job.state, 'pending');
    assert.equal(job.inputTokens, 9);
    assert.equal(job.outputTokens, 8);
    assert.equal(job.cost, 0.0042);
    assert.equal(job.model, 'vendor/served');
    assert.equal(job.upstreamProvider, 'DeepInfra');
    const stored = await readFile(join(g.f.root, 'ai-jobs', `${job.id}.json`), 'utf8');
    assert.equal(stored.includes('sk-TEST-KEY'), false);
    assert.equal(g.logs.join('\n').includes('sk-TEST-KEY'), false);
  } finally { await g.cleanup(); }
});

test('an embedded 4xx code is UNSUPPORTED_REQUEST and posts once', async () => {
  const numeric = await adapterJob('openrouter', () => new Response(JSON.stringify({error: {code: 400}}), {status: 200, headers: {'content-type': 'application/json'}}));
  const text = await adapterJob('openrouter', () => new Response(JSON.stringify({error: {code: '400'}}), {status: 200, headers: {'content-type': 'application/json'}}));
  try {
    const job = await settle(numeric.ai, (await numeric.ai.start(inputOf(numeric.f.workspace))).id);
    assert.equal(numeric.posts.length, 1);
    assert.equal(job.error?.code, 'UNSUPPORTED_REQUEST');
    assert.equal(job.error?.retryable, false);
    assert.equal(job.error?.message, 'The provider rejected the request.');
    const stringCode = await settle(text.ai, (await text.ai.start(inputOf(text.f.workspace))).id);
    assert.equal(text.posts.length, 1);
    assert.equal(stringCode.error?.code, 'UNSUPPORTED_REQUEST');
    assert.equal(stringCode.error?.retryable, false);
  } finally { await numeric.cleanup(); await text.cleanup(); }
});

test('the generic OpenAI-compatible provider still generates', async () => {
  const g = await adapterJob('openai-compatible', () => completionResponse(JSON.stringify(exampleDraft), {usage: {prompt_tokens: 2, completion_tokens: 3}}));
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(job.state, 'pending');
    assert.equal(g.posts.length, 1);
    assert.equal(g.posts[0].url, 'https://api.example.com/v1/chat/completions');
    assert.equal((g.posts[0].body.response_format as {type?: string}).type, 'json_schema');
    assert.equal(g.posts[0].body.usage, undefined);
    assert.equal(g.posts[0].body.models, undefined);
    assert.equal(g.posts[0].headers.get('http-referer'), null);
    assert.equal(g.posts[0].headers.get('x-title'), null);
    assert.equal(job.inputTokens, 2);
    assert.equal(job.outputTokens, 3);
    assert.equal(job.cost, undefined);
  } finally { await g.cleanup(); }
});

test('json_schema fallback plus a needed repair stays at two posts', async () => {
  const bad = structuredClone(exampleDraft) as {visits: {operations: {destination?: {visitKey?: string}}[]}[]};
  bad.visits[0].operations[1].destination!.visitKey = 'missingVisit';
  const g = await adapterJob('openai-compatible', post => {
    if (post === 1) return new Response(JSON.stringify({error: {message: 'json_schema response_format is not supported'}}), {status: 400, headers: {'content-type': 'application/json'}});
    if (post === 2) return completionResponse(JSON.stringify(bad));
    throw new Error(`unexpected post ${post}`);
  });
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(g.posts.length, 2);
    assert.equal((g.posts[1].body.response_format as {type?: string}).type, 'json_object');
    const compact = JSON.stringify(JSON.parse(readFileSync(new URL('../docs/contracts/ai-flow-v1/flow-draft.schema.json', import.meta.url), 'utf8')));
    const systemOf = (body: Record<string, unknown>) => (body.messages as {content: string}[])[0].content;
    assert.equal(systemOf(g.posts[0].body).includes(compact), false);
    assert.equal(systemOf(g.posts[1].body).includes(compact), true);
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'AUTHORING_INVALID');
    assert.equal(job.error?.retryable, false);
    assert.equal(job.preview?.applicable, false);
    assert.ok(job.draft);
  } finally { await g.cleanup(); }
});

test('a 429 is retried once and a second 429 is not posted again', async () => {
  const recovered = await adapterJob('openai-compatible', post => {
    if (post === 1) return new Response(JSON.stringify({error: {message: 'slow'}}), {status: 429, headers: {'content-type': 'application/json', 'retry-after': '0'}});
    if (post === 2) return completionResponse(JSON.stringify(exampleDraft));
    throw new Error(`unexpected post ${post}`);
  });
  const exhausted = await adapterJob('openai-compatible', post => {
    if (post > 2) throw new Error(`unexpected post ${post}`);
    return new Response(JSON.stringify({error: {message: 'slow'}}), {status: 429, headers: {'content-type': 'application/json', 'retry-after': '0'}});
  });
  try {
    const job = await settle(recovered.ai, (await recovered.ai.start(inputOf(recovered.f.workspace))).id);
    assert.equal(recovered.posts.length, 2);
    assert.equal(job.state, 'pending');
    const failed = await settle(exhausted.ai, (await exhausted.ai.start(inputOf(exhausted.f.workspace))).id);
    assert.equal(exhausted.posts.length, 2);
    assert.equal(failed.error?.code, 'RATE_LIMITED');
    assert.equal(failed.error?.retryable, true);
  } finally { await recovered.cleanup(); await exhausted.cleanup(); }
});

test('a mid-stream error, a timeout, HTTP 402, and a 200 error body each make one post', async () => {
  const stream = await adapterJob('openrouter', () => new Response(
    `data: ${JSON.stringify({choices: [{delta: {content: '{'}}]})}\n\ndata: ${JSON.stringify({error: {message: 'blew up sk-TEST-KEY', code: 500}})}\n\n`,
    {status: 200, headers: {'content-type': 'text/event-stream'}},
  ));
  const timeout = await adapterJob('openrouter', (_post, init) => new Promise((_resolve, reject) => {
    const abort = () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    if (init?.signal?.aborted) { abort(); return; }
    init?.signal?.addEventListener('abort', abort, {once: true});
  }), {deadlineMs: 40});
  const credits = await adapterJob('openrouter', () => new Response(JSON.stringify({error: {message: 'pay sk-TEST-KEY'}}), {status: 402, headers: {'content-type': 'application/json'}}));
  const embedded = await adapterJob('openrouter', () => new Response(JSON.stringify({error: {code: 402, message: 'pay sk-TEST-KEY'}}), {status: 200, headers: {'content-type': 'application/json'}}));
  const overloaded = await adapterJob('openrouter', () => new Response(JSON.stringify({error: {message: '<html>sk-TEST-KEY</html>', code: 'overloaded'}}), {status: 200, headers: {'content-type': 'application/json'}}));
  try {
    const streamed = await settle(stream.ai, (await stream.ai.start(inputOf(stream.f.workspace))).id);
    assert.equal(stream.posts.length, 1);
    assert.equal(streamed.error?.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(streamed.error?.message.includes('sk-TEST-KEY'), false);
    const timed = await settle(timeout.ai, (await timeout.ai.start(inputOf(timeout.f.workspace))).id);
    assert.equal(timeout.posts.length, 1);
    assert.equal(timed.error?.code, 'TIMEOUT');
    const billed = await settle(credits.ai, (await credits.ai.start(inputOf(credits.f.workspace))).id);
    assert.equal(credits.posts.length, 1);
    assert.equal(billed.error?.code, 'CREDITS_REQUIRED');
    assert.equal(billed.error?.retryable, false);
    assert.equal(billed.error?.message.includes('sk-TEST-KEY'), false);
    const embeddedCredits = await settle(embedded.ai, (await embedded.ai.start(inputOf(embedded.f.workspace))).id);
    assert.equal(embedded.posts.length, 1);
    assert.equal(embeddedCredits.error?.code, 'CREDITS_REQUIRED');
    const unavailable = await settle(overloaded.ai, (await overloaded.ai.start(inputOf(overloaded.f.workspace))).id);
    assert.equal(overloaded.posts.length, 1);
    assert.equal(unavailable.error?.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(unavailable.error?.message.includes('sk-TEST-KEY'), false);
    assert.equal(unavailable.error?.message.includes('<html'), false);
  } finally {
    await stream.cleanup();
    await timeout.cleanup();
    await credits.cleanup();
    await embedded.cleanup();
    await overloaded.cleanup();
  }
});

test('a generation error keeps the saved key and removing it aborts the in-flight call', async () => {
  const secrets = memorySecrets();
  const f = await authoringFixture();
  let entered: () => void = () => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let releaseLate: (response: Response) => void = () => {};
  const late = new Promise<Response>(resolve => { releaseLate = resolve; });
  const fetchImpl: typeof fetch = (url, init) => {
    if (!String(url).includes('chat/completions')) return Promise.resolve(new Response('{}', {status: 200, headers: {'content-type': 'application/json'}}));
    entered();
    return new Promise((resolve, reject) => {
      const abort = () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      };
      if (init?.signal?.aborted) { abort(); return; }
      init?.signal?.addEventListener('abort', abort, {once: true});
      void late.then(resolve, reject);
    });
  };
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets, fetch: fetchImpl, log: () => {},
  });
  await ai.ready;
  const save = {expectedSettingsRevision: 0, selected: 'openrouter', provider: 'openrouter', model: 'vendor/model', credential: {action: 'replace', apiKey: 'sk-LIVE-KEY', storage: 'keychain'}};
  try {
    await ai.putConfig(save);
    const failing = createAi({
      root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets, log: () => {},
      fetch: async () => new Response(JSON.stringify({error: {message: 'nope sk-LIVE-KEY'}}), {status: 401, headers: {'content-type': 'application/json'}}),
    });
    await failing.ready;
    const failed = await settle(failing, (await failing.start({...inputOf(f.workspace), expectedSettingsRevision: 1})).id);
    assert.equal(failed.error?.code, 'AUTH_FAILED');
    assert.equal(secrets.values.get('tnt.ai.openrouter'), 'sk-LIVE-KEY');
    assert.equal((await failing.getConfig()).providers.openrouter.configured, true);
    assert.equal((await failing.getConfig()).providers.openrouter.model, 'vendor/model');
    const started = await ai.start({...inputOf(f.workspace), expectedSettingsRevision: 1});
    await waiting;
    await ai.putConfig({expectedSettingsRevision: 1, selected: 'openrouter', provider: 'openrouter', model: 'vendor/model', credential: {action: 'remove'}});
    const removed = await settle(ai, started.id);
    assert.equal(removed.error?.code, 'AI_NOT_CONFIGURED');
    assert.equal(removed.previewId, undefined);
    releaseLate(completionResponse(JSON.stringify(exampleDraft)));
    await new Promise(resolve => setTimeout(resolve, 30));
    const after = await ai.get(started.id);
    assert.equal(after.state, 'failed');
    assert.equal(after.previewId, undefined);
    assert.equal(JSON.stringify(after).includes(exampleDraft.name), false);
    assert.equal((await ai.getConfig()).providers.openrouter.configured, false);
  } finally {
    releaseLate(new Response('{}'));
    await ai.idle();
    await f.cleanup();
  }
});

function systemOf(body: Record<string, unknown>) {
  const messages = body.messages as {role: string; content: string}[];
  assert.equal(messages[0].role, 'system');
  return messages[0].content;
}

test('schema text in the instructions is counted once toward the request limit', () => {
  const schema = JSON.parse(readFileSync(new URL('../docs/contracts/ai-flow-v1/flow-draft.schema.json', import.meta.url), 'utf8')) as object;
  const compact = JSON.stringify(schema);
  const context = {screens: [{screenId: 'screen0', title: 'Home'}], targets: [], setups: [], handlers: [], mocks: [], omissions: []};
  const input = {prompt: 'Open the home screen', appId: 'com.example.TnTProof', context, extraBytes: 0};
  const plain = packPrompt(input);
  const withSchema = packPrompt({...input, schema});
  const plainBytes = Buffer.byteLength(plain.system) + Buffer.byteLength(plain.user);
  const schemaBytes = Buffer.byteLength(withSchema.system) + Buffer.byteLength(withSchema.user);
  assert.equal(withSchema.system.split(compact).length, 2);
  assert.equal(schemaBytes - plainBytes, Buffer.byteLength(schemaAttachment(schema)));
  assert.ok(schemaBytes <= REQUEST_BYTE_LIMIT);
  assert.equal(withSchema.contextTrimmed, false);
});

test('OpenRouter sends the flow schema in both calls and fails a draft that stays schema-invalid', async () => {
  const schema = JSON.parse(await readFile(new URL('../docs/contracts/ai-flow-v1/flow-draft.schema.json', import.meta.url), 'utf8')) as object;
  const compact = JSON.stringify(schema);
  const bad = await readFile(new URL('./fixtures/deepseek-invalid-draft.json', import.meta.url), 'utf8');
  const g = await adapterJob('openrouter', () => completionResponse(bad));
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(g.posts.length, 2);
    for (const post of g.posts) {
      assert.equal(post.body.response_format, undefined);
      const system = systemOf(post.body);
      assert.equal(system.split(compact).length, 2);
      assert.equal(system.includes('"handlerRefs"'), true);
      assert.equal(system.includes('"mock"'), true);
      assert.equal(system.includes('"key"'), true);
      assert.equal(system.includes('"title"'), true);
      const messages = post.body.messages as {content: string}[];
      const bytes = messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
      assert.ok(bytes <= REQUEST_BYTE_LIMIT);
    }
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'AUTHORING_INVALID');
    assert.equal(job.error?.retryable, false);
    assert.equal(typeof job.error?.message, 'string');
    assert.ok(job.draft);
    assert.equal(typeof job.previewId, 'string');
    assert.equal(typeof job.previewExpiresAt, 'string');
    assert.ok(job.preview?.diagnostics.some(item => item.code === 'INVALID_DRAFT' && item.path === '/execution' && item.message.includes('handlerRefs')));
    assert.ok(job.preview?.diagnostics.some(item => item.code === 'INVALID_DRAFT' && item.message.includes("property 'key'")));
  } finally { await g.cleanup(); }
});

test('provider and model on a generation are unknown fields', async () => {
  const g = await generation(() => ({kind: 'ok', text: JSON.stringify(exampleDraft)}));
  try {
    for (const extra of [{provider: 'openrouter'}, {model: 'vendor/model'}, {provider: 'openrouter', model: 'vendor/model'}]) {
      await assert.rejects(() => g.ai.start({...inputOf(g.f.workspace), ...extra}), (error: unknown) => {
        assert.equal((error as {status?: number}).status, 400);
        assert.equal((error as {code?: string}).code, 'INVALID_ENVELOPE');
        return true;
      });
    }
  } finally { await g.cleanup(); }
});

test('a workspace revision mismatch is WORKSPACE_STALE', async () => {
  let calls = 0;
  const g = await generation(() => { calls += 1; return {kind: 'ok', text: JSON.stringify(exampleDraft)}; });
  try {
    const job = await settle(g.ai, (await g.ai.start({workspaceId: g.f.workspace.id, expectedRevision: g.f.workspace.metadata!.revision + 3, prompt: PROMPT})).id);
    assert.equal(calls, 0);
    assert.equal(job.error?.code, 'WORKSPACE_STALE');
    assert.equal(job.error?.retryable, false);
  } finally { await g.cleanup(); }
});
