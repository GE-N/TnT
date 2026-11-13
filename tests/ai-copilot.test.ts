import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAiConfig} from '../server/ai/config.js';
import {canAutoRetry, mapProviderFailure} from '../server/ai/errors.js';
import {createAi} from '../server/ai/index.js';
import {createCopilotSdkProvider, flattenCopilotMessages} from '../server/ai/providers/copilot-sdk.js';
import {COPILOT_NOT_INSTALLED, classifyCopilotFailure, copilotClientOptions, copilotSessionConfig, createFakeCopilotRuntime, createSdkCopilotRuntime, mapCopilotSdkEvent, type CopilotAuth, type FakeCopilotRuntime, type FakeCopilotScript} from '../server/ai/providers/copilot-runtime.js';
import {ProviderRequestError} from '../server/ai/providers/types.js';
import {authoringFixture, exampleDraft} from './authoring-helpers.js';

const PROMPT = 'Open details and return home.';

function memorySecrets() {
  const values = new Map<string, string>();
  const gets: string[] = [];
  return {
    gets,
    values,
    async get(service: string) { gets.push(service); return values.get(service); },
    async set(service: string, value: string) { values.set(service, value); },
    async delete(service: string) { values.delete(service); },
  };
}

async function settle<T extends {state: string}>(ai: {get(id: string): Promise<T>}, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await ai.get(id);
    if (job.state !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('generation did not finish');
}

async function copilotJob(script: FakeCopilotScript | ((call: number, input: {system: string; prompt: string; model: string}) => FakeCopilotScript), options: {model?: string; auth?: CopilotAuth} = {}) {
  const logs: string[] = [];
  const runtime = createFakeCopilotRuntime(script, options.auth);
  const f = await authoringFixture();
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(),
    log: line => logs.push(line), provider: createCopilotSdkProvider({runtime, model: options.model ?? 'auto'}),
  });
  await ai.ready;
  return {ai, f, logs, runtime, cleanup: async () => { await ai.idle(); await f.cleanup(); }};
}

function inputOf(workspace: {id: string; metadata?: {revision: number}}) {
  return {workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: PROMPT};
}

const badDraft = structuredClone(exampleDraft) as {visits: {operations: {destination?: {visitKey?: string}}[]}[]};
badDraft.visits[0].operations[1].destination!.visitKey = 'missingVisit';

test('the Copilot SDK stays pinned at 1.0.28', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {optionalDependencies: Record<string, string>};
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8')) as {packages: Record<string, {version?: string; optional?: boolean}>};
  assert.equal(pkg.optionalDependencies['@github/copilot-sdk'], '1.0.28');
  assert.equal(lock.packages['node_modules/@github/copilot-sdk'].version, '1.0.28');
  assert.equal(lock.packages['node_modules/@github/copilot-sdk'].optional, true);
});

test('contract fixtures keep the recorded SDK event fields', async () => {
  const events = JSON.parse(await readFile(new URL('./fixtures/copilot/sdk-stream.json', import.meta.url), 'utf8')) as {type: string; data: Record<string, unknown>}[];
  const delta = events.find(event => event.type === 'assistant.message_delta');
  const usage = events.find(event => event.type === 'assistant.usage');
  assert.equal(delta?.data.deltaContent, 'OK');
  assert.equal((usage?.data.copilotUsage as {totalNanoAiu: number}).totalNanoAiu, 95153000);
  assert.equal((usage?.data.quotaSnapshots as {chat: {entitlementRequests: number}}).chat.entitlementRequests, 200);
  const state = {text: ''};
  const mapped = events.flatMap(event => {
    const next = mapCopilotSdkEvent(event, state);
    return next ? [next] : [];
  });
  assert.equal(mapped[0]?.type === 'delta' ? mapped[0].text : '', 'OK');
  const reported = mapped.find(event => event.type === 'usage');
  assert.equal(reported && reported.type === 'usage' ? reported.nanoAiu : 0, 95153000);
  assert.equal(reported && reported.type === 'usage' ? reported.model : '', 'gpt-6-luna');
  assert.equal(mapped.at(-1)?.type, 'done');
});

test('session config replaces the system prompt and denies tools', () => {
  const auto = copilotSessionConfig({system: 'Stay terse.', model: 'auto'});
  assert.equal(auto.systemMessage.mode, 'replace');
  assert.equal(auto.systemMessage.content, 'Stay terse.');
  assert.deepEqual(auto.availableTools, []);
  assert.deepEqual(auto.disabledMcpServers, ['github-mcp-server']);
  assert.equal(auto.streaming, true);
  assert.equal(auto.model, undefined);
  assert.deepEqual(auto.onPermissionRequest(), {kind: 'denied-by-rules', rules: []});
  const named = copilotSessionConfig({system: 'Stay terse.', model: 'gpt-5-mini'});
  assert.equal(named.model, 'gpt-5-mini');
  const client = copilotClientOptions('/tmp/tnt-copilot');
  assert.deepEqual(client, {mode: 'empty', baseDirectory: '/tmp/tnt-copilot', useLoggedInUser: true, logLevel: 'error'});
  assert.equal('gitHubToken' in client, false);
  assert.equal('env' in client, false);
});

test('runtime strings map to the Copilot error kinds', () => {
  assert.equal(classifyCopilotFailure({message: 'No authentication information'}).kind, 'not-signed-in');
  assert.equal(classifyCopilotFailure({message: 'No authentication information found'}).message, "Copilot isn't signed in.");
  assert.equal(classifyCopilotFailure({statusCode: 401, message: 'unauthorized'}).kind, 'not-signed-in');
  assert.equal(classifyCopilotFailure({message: 'Bad credentials in GH_TOKEN github_pat_SECRET'}).message, "Copilot isn't signed in. Unset GH_TOKEN or GITHUB_TOKEN if it is a classic personal access token.");
  assert.equal(classifyCopilotFailure({message: 'Bad credentials in GH_TOKEN github_pat_SECRET'}).message.includes('github_pat_'), false);
  assert.equal(classifyCopilotFailure({message: 'Access denied by policy settings'}).kind, 'policy-off');
  assert.equal(classifyCopilotFailure({message: 'not authorized to use this Copilot feature'}).message, 'Copilot is off for this account.');
  assert.equal(classifyCopilotFailure({message: 'not licensed to use Copilot'}).kind, 'no-seat');
  assert.equal(classifyCopilotFailure({message: 'Model gpt-5-mini is not available'}).kind, 'model-unavailable');
  assert.equal(classifyCopilotFailure({statusCode: 429, message: 'slow down'}).kind, 'rate-limit');
  assert.equal(classifyCopilotFailure({message: 'getaddrinfo ENOTFOUND api.github.com'}).kind, 'network');
  const signedOut = new ProviderRequestError({code: 'PROVIDER_REJECTED', message: "Copilot isn't signed in.", retryable: false, embeddedCode: 'not-signed-in', reason: 'embedded'});
  const policy = new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'Copilot is off for this account.', retryable: false, embeddedCode: 'policy-off', reason: 'embedded'});
  const seat = new ProviderRequestError({code: 'PROVIDER_REJECTED', message: 'This account has no Copilot license.', retryable: false, embeddedCode: 'no-seat', reason: 'embedded'});
  assert.equal(mapProviderFailure(signedOut).code, 'NOT_SIGNED_IN');
  assert.equal(mapProviderFailure(policy).code, 'POLICY_OFF');
  assert.equal(mapProviderFailure(seat).code, 'NO_SEAT');
  assert.equal(canAutoRetry(signedOut), false);
  assert.equal(canAutoRetry(policy), false);
  assert.equal(canAutoRetry(seat), false);
  const limited = new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'The provider rate limit was reached.', retryable: true, status: 429});
  assert.equal(mapProviderFailure(limited).code, 'RATE_LIMITED');
  assert.equal(canAutoRetry(limited), true);
});

test('an old config without copilot still loads, and connect does not read a key', async () => {
  const f = await authoringFixture();
  const secrets = memorySecrets();
  try {
    await writeFile(join(f.root, 'ai-config.json'), JSON.stringify({
      settingsRevision: 2,
      selected: 'openrouter',
      providers: {openrouter: {model: 'vendor/model', credentialRevision: 1}},
    }));
    const config = createAiConfig({root: f.root, env: {GH_TOKEN: 'github_pat_SHOULD_NOT_LAND', GITHUB_TOKEN: 'gho_SHOULD_NOT_LAND'}, secrets, dev: false, log: () => {}, copilotRuntime: createFakeCopilotRuntime({kind: 'ok', text: '{}'}, {signedIn: false})});
    const loaded = await config.get();
    assert.equal(loaded.providers.copilot.model, 'auto');
    assert.equal(loaded.selected, 'openrouter');
    assert.equal(loaded.providers.openrouter.model, 'vendor/model');
    assert.equal('credentialRevision' in loaded.providers.copilot, false);
    assert.equal('baseUrl' in loaded.providers.copilot, false);
    const untouched = await readFile(join(f.root, 'ai-config.json'), 'utf8');
    assert.equal(untouched.includes('copilot'), false);
    assert.equal(untouched.includes('github_pat_'), false);
    assert.equal(untouched.includes('gho_'), false);
    await writeFile(join(f.root, 'ai-config.json'), JSON.stringify({
      settingsRevision: 2,
      selected: 'copilot',
      providers: {
        openrouter: {model: '', credentialRevision: 0},
        'openai-compatible': {model: '', baseUrl: 'https://api.openai.com/v1', credentialRevision: 0},
        copilot: {model: 'auto'},
      },
    }));
    secrets.gets.length = 0;
    const connected = await config.connect();
    assert.equal(connected.providerId, 'copilot');
    assert.equal(connected.model, 'auto');
    assert.equal(connected.provider.id, 'copilot');
    assert.equal(connected.provider.sendsJsonSchema, false);
    assert.deepEqual(secrets.gets, []);
    const saved = await config.put({expectedSettingsRevision: 2, selected: 'copilot', provider: 'copilot', model: 'gpt-5-mini', credential: {action: 'keep'}});
    assert.equal(saved.settingsRevision, 3);
    assert.equal(saved.selected, 'copilot');
    assert.equal(saved.providers.copilot.model, 'gpt-5-mini');
    assert.equal(secrets.values.size, 0);
  } finally { await f.cleanup(); }
});

test('saving another provider writes copilot as model only', async () => {
  const f = await authoringFixture();
  const logs: string[] = [];
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id),
    env: {GH_TOKEN: 'github_pat_FILE', GITHUB_TOKEN: 'ghu_FILE'}, dev: false, secrets: memorySecrets(), log: line => logs.push(line),
    provider: createCopilotSdkProvider({runtime: createFakeCopilotRuntime({kind: 'ok', text: '{}'}), model: 'auto'}),
  });
  await ai.ready;
  try {
    await ai.putConfig({
      expectedSettingsRevision: 0, selected: 'openrouter', provider: 'openrouter', model: 'vendor/model',
      credential: {action: 'replace', apiKey: 'sk-SUPER-SECRET', storage: 'keychain'},
    });
    const file = JSON.parse(await readFile(join(f.root, 'ai-config.json'), 'utf8')) as {providers: {copilot: Record<string, unknown>}};
    assert.deepEqual(file.providers.copilot, {model: 'auto'});
    const text = JSON.stringify(file);
    assert.equal(text.includes('github_pat_'), false);
    assert.equal(text.includes('gho_'), false);
    assert.equal(text.includes('ghu_'), false);
    assert.equal(text.includes('sk-SUPER-SECRET'), false);
    assert.equal(logs.join('\n').includes('github_pat_'), false);
    assert.equal(logs.join('\n').includes('ghu_'), false);
  } finally { await ai.idle(); await f.cleanup(); }
});

test('check reports signed in, not signed in, and not installed', async () => {
  const signedIn = createCopilotSdkProvider({runtime: createFakeCopilotRuntime('authError', {signedIn: true, login: 'octocat', via: 'gh-cli'}), model: 'auto'});
  assert.deepEqual(await signedIn.check(), {ok: true, model: 'auto', login: 'octocat'});
  const signedOut = createCopilotSdkProvider({runtime: createFakeCopilotRuntime('policyError', {signedIn: false, message: 'No authentication information'}), model: 'auto'});
  assert.deepEqual(await signedOut.check(), {ok: false, error: 'Not signed in'});
  const directory = await mkdtemp(join(tmpdir(), 'tnt-copilot-missing-'));
  let loads = 0;
  const missing = createSdkCopilotRuntime({
    baseDirectory: directory,
    loadSdk: async () => { loads += 1; throw Object.assign(new Error("Cannot find package '@github/copilot-sdk'"), {code: 'ERR_MODULE_NOT_FOUND'}); },
  });
  const provider = createCopilotSdkProvider({runtime: missing, model: 'auto'});
  assert.equal(loads, 0);
  assert.deepEqual(await provider.check(), {ok: false, error: COPILOT_NOT_INSTALLED});
  assert.equal(loads, 1);
  const missingCall = provider.generate({system: 's', messages: [{role: 'user', content: 'hi'}], schema: {}, maxOutputTokens: 8, signal: new AbortController().signal})[Symbol.asyncIterator]();
  await assert.rejects(() => missingCall.next(), (error: unknown) => {
    assert.equal(error instanceof ProviderRequestError, true);
    assert.equal((error as ProviderRequestError).message, COPILOT_NOT_INSTALLED);
    return true;
  });
});

test('a missing SDK package fails the job with NOT_SIGNED_IN and does not block startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-copilot-start-'));
  const runtime = createSdkCopilotRuntime({
    baseDirectory: directory,
    loadSdk: async () => { throw Object.assign(new Error('Cannot find module @github/copilot-sdk'), {code: 'MODULE_NOT_FOUND'}); },
  });
  const logs: string[] = [];
  const f = await authoringFixture();
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(),
    log: line => logs.push(line), provider: createCopilotSdkProvider({runtime, model: 'auto'}),
  });
  await ai.ready;
  try {
    const job = await settle(ai, (await ai.start(inputOf(f.workspace))).id);
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'NOT_SIGNED_IN');
    assert.equal(job.error?.message, COPILOT_NOT_INSTALLED);
    assert.equal(job.error?.retryable, false);
    assert.equal(job.draft, undefined);
    assert.equal(logs.join('\n').includes('github_pat_'), false);
  } finally { await ai.idle(); await f.cleanup(); }
});

test('usage credits come from totalNanoAiu and a fence still parses', async () => {
  const ok = await copilotJob({kind: 'ok', text: JSON.stringify(exampleDraft), deltas: ['{', '}'], model: 'gpt-6-luna', inputTokens: 2714, outputTokens: 1828, nanoAiu: 95153000});
  const fenced = await copilotJob({kind: 'fenced', json: JSON.stringify(exampleDraft), nanoAiu: 1_000_000_000, inputTokens: 4, outputTokens: 5});
  try {
    const job = await settle(ok.ai, (await ok.ai.start(inputOf(ok.f.workspace))).id);
    assert.equal(job.state, 'pending');
    assert.equal(job.model, 'gpt-6-luna');
    assert.equal(job.inputTokens, 2714);
    assert.equal(job.outputTokens, 1828);
    assert.equal(job.cost, 0.095153);
    assert.equal(job.upstreamProvider, 'github-copilot');
    assert.equal(ok.runtime.prompts[0]?.prompt.includes('<user>'), false);
    const fencedJob = await settle(fenced.ai, (await fenced.ai.start(inputOf(fenced.f.workspace))).id);
    assert.equal(fencedJob.state, 'pending');
    assert.equal(fencedJob.cost, 1);
  } finally { await ok.cleanup(); await fenced.cleanup(); }
});

test('prose repairs, and an invalid draft flattens the second prompt', async () => {
  const prose = await copilotJob(call => call === 1 ? {kind: 'prose', json: JSON.stringify(exampleDraft)} : {kind: 'ok', text: JSON.stringify(exampleDraft), model: 'gpt-6-luna', nanoAiu: 2_000_000});
  const invalid = await copilotJob(call => call === 1 ? {kind: 'invalidDraft', text: JSON.stringify(badDraft)} : {kind: 'ok', text: JSON.stringify(exampleDraft), model: 'gpt-6-luna', nanoAiu: 2_000_000});
  try {
    const repaired = await settle(prose.ai, (await prose.ai.start(inputOf(prose.f.workspace))).id);
    assert.equal(prose.runtime.prompts.length, 2);
    assert.equal(repaired.state, 'pending');
    const fixed = await settle(invalid.ai, (await invalid.ai.start(inputOf(invalid.f.workspace))).id);
    assert.equal(fixed.state, 'pending');
    const second = invalid.runtime.prompts[1]?.prompt ?? '';
    assert.equal(second.includes('<user>'), true);
    assert.equal(second.includes('<assistant>'), true);
    assert.equal(second.includes('Answer the last <user> message.'), true);
    assert.equal(second.includes('missingVisit'), true);
    assert.equal(flattenCopilotMessages([{role: 'user', content: 'a'}, {role: 'assistant', content: 'b'}, {role: 'user', content: 'c'}]).includes('<assistant>\nb\n</assistant>'), true);
  } finally { await prose.cleanup(); await invalid.cleanup(); }
});

test('auth, policy, and seat failures are not retried', async () => {
  const cases = [
    ['authError', 'NOT_SIGNED_IN'],
    ['policyError', 'POLICY_OFF'],
    ['noSeat', 'NO_SEAT'],
  ] as const;
  for (const [script, code] of cases) {
    const g = await copilotJob(script);
    try {
      const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
      assert.equal(g.runtime.prompts.length, 1, code);
      assert.equal(job.state, 'failed');
      assert.equal(job.error?.code, code);
      assert.equal(job.error?.retryable, false);
      assert.equal(job.draft, undefined);
      assert.equal(JSON.stringify(job).includes('gho_'), false);
    } finally { await g.cleanup(); }
  }
});

test('a substituted model fails with MODEL_UNAVAILABLE and keeps no draft', async () => {
  const g = await copilotJob({kind: 'modelSubstituted', text: JSON.stringify(exampleDraft), model: 'gpt-6-luna'}, {model: 'gpt-5-mini'});
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(g.runtime.prompts.length, 1);
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'MODEL_UNAVAILABLE');
    assert.equal(job.draft, undefined);
    assert.equal(job.model, undefined);
  } finally { await g.cleanup(); }
});

test('auto keeps the model that answered', async () => {
  const g = await copilotJob({kind: 'ok', text: JSON.stringify(exampleDraft), model: 'gpt-6-luna', nanoAiu: 800_000});
  try {
    const job = await settle(g.ai, (await g.ai.start(inputOf(g.f.workspace))).id);
    assert.equal(job.state, 'pending');
    assert.equal(job.model, 'gpt-6-luna');
    assert.equal(job.draft !== undefined, true);
  } finally { await g.cleanup(); }
});

test('a rate limit retries once inside the two-call budget', async () => {
  const recovered = await copilotJob(call => call === 1 ? 'rateLimited' : {kind: 'ok', text: JSON.stringify(exampleDraft), model: 'gpt-6-luna', nanoAiu: 1_000});
  const exhausted = await copilotJob('rateLimited');
  try {
    const job = await settle(recovered.ai, (await recovered.ai.start(inputOf(recovered.f.workspace))).id);
    assert.equal(recovered.runtime.prompts.length, 2);
    assert.equal(job.state, 'pending');
    const failed = await settle(exhausted.ai, (await exhausted.ai.start(inputOf(exhausted.f.workspace))).id);
    assert.equal(exhausted.runtime.prompts.length, 2);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error?.code, 'RATE_LIMITED');
    assert.equal(failed.draft, undefined);
  } finally { await recovered.cleanup(); await exhausted.cleanup(); }
});

test('too much output is rejected and a hang abort does not leak', async () => {
  const huge = await copilotJob('tooLarge');
  const hung = await copilotJob('hang');
  try {
    const job = await settle(huge.ai, (await huge.ai.start(inputOf(huge.f.workspace))).id);
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'INVALID_AI_OUTPUT');
    assert.equal(job.draft, undefined);
    const started = await hung.ai.start(inputOf(hung.f.workspace));
    for (let attempt = 0; attempt < 50 && !hung.runtime.leaked; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(hung.runtime.leaked, true);
    const cancelled = await hung.ai.cancel(started.id);
    await hung.ai.idle();
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(hung.runtime.leaked, false);
  } finally { await huge.cleanup(); await hung.cleanup(); }
});

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

test('abort force-stops a session that does not exit within 5s', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const seen = {options: undefined as object | undefined, sessions: [] as object[], abort: 0, disconnect: 0, forceStop: 0, stop: 0};
  class CopilotClient {
    constructor(options: object) { seen.options = options; }
    async start() {}
    async stop() { seen.stop += 1; return []; }
    async forceStop() { seen.forceStop += 1; }
    async getAuthStatus() { return {isAuthenticated: true, login: 'octocat', authType: 'gh-cli' as const}; }
    async listModels() { return [{id: 'gpt-6-luna', name: 'GPT-6 Luna', policy: {state: 'enabled'}}, {id: 'hidden', name: 'Hidden', policy: {state: 'disabled'}}]; }
    async createSession(config: object) {
      seen.sessions.push(config);
      return {
        on() {},
        async send() {},
        abort() { seen.abort += 1; return new Promise<void>(() => {}); },
        async disconnect() { seen.disconnect += 1; },
      };
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'tnt-copilot-abort-'));
  const runtime = createSdkCopilotRuntime({baseDirectory: directory, loadSdk: async () => ({CopilotClient}), stopGraceMs: 5_000, idleMs: 60_000});
  try {
    const models = await runtime.models();
    assert.deepEqual(models, [{id: 'gpt-6-luna', name: 'GPT-6 Luna', enabled: true}]);
    assert.deepEqual(seen.options, {mode: 'empty', baseDirectory: directory, useLoggedInUser: true, logLevel: 'error'});
    const controller = new AbortController();
    const pending = runtime.run({system: 'Stay terse.', prompt: 'hi', model: 'auto', signal: controller.signal})[Symbol.asyncIterator]().next();
    controller.abort();
    for (let attempt = 0; attempt < 50 && seen.abort === 0; attempt++) await flush();
    assert.equal(seen.abort, 1);
    assert.equal(seen.forceStop, 0);
    t.mock.timers.tick(4_999);
    await flush();
    assert.equal(seen.forceStop, 0);
    t.mock.timers.tick(1);
    await flush();
    await pending;
    assert.equal(seen.forceStop, 1);
    const session = seen.sessions[0] as {systemMessage: {mode: string}; availableTools: string[]; disabledMcpServers: string[]; model?: string};
    assert.equal(session.systemMessage.mode, 'replace');
    assert.deepEqual(session.availableTools, []);
    assert.deepEqual(session.disabledMcpServers, ['github-mcp-server']);
    assert.equal(session.model, undefined);
    await runtime.stop();
  } finally { t.mock.timers.reset(); }
});

test('a finished session disconnects without aborting or force-stopping', async () => {
  const seen = {abort: 0, disconnect: 0, forceStop: 0};
  class CopilotClient {
    constructor(_options: object) {}
    async start() {}
    async stop() { return []; }
    async forceStop() { seen.forceStop += 1; }
    async getAuthStatus() { return {isAuthenticated: true, login: 'octocat', authType: 'gh-cli' as const}; }
    async listModels() { return []; }
    async createSession() {
      let handler: (event: unknown) => void = () => {};
      return {
        on(next: (event: unknown) => void) { handler = next; },
        async send() {
          handler({type: 'assistant.message_delta', data: {deltaContent: 'OK'}});
          handler({type: 'session.idle'});
        },
        abort() { seen.abort += 1; return Promise.resolve(); },
        async disconnect() { seen.disconnect += 1; },
      };
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'tnt-copilot-done-'));
  const runtime = createSdkCopilotRuntime({baseDirectory: directory, loadSdk: async () => ({CopilotClient}), idleMs: 60_000});
  const events = [];
  for await (const event of runtime.run({system: 'Stay terse.', prompt: 'hi', model: 'auto', signal: new AbortController().signal})) events.push(event.type);
  assert.deepEqual(events, ['delta', 'done']);
  assert.equal(seen.abort, 0);
  assert.equal(seen.disconnect, 1);
  assert.equal(seen.forceStop, 0);
  await runtime.stop();
});

test('the shared client stops after 10 idle minutes', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const seen = {stop: 0, forceStop: 0};
  class CopilotClient {
    constructor(_options: object) {}
    async start() {}
    async stop() { seen.stop += 1; return []; }
    async forceStop() { seen.forceStop += 1; }
    async getAuthStatus() { return {isAuthenticated: false, statusMessage: 'No authentication information'}; }
    async listModels() { return []; }
    async createSession(): Promise<never> { throw new Error('idle test must not open a session'); }
  }
  const directory = await mkdtemp(join(tmpdir(), 'tnt-copilot-idle-'));
  const runtime = createSdkCopilotRuntime({baseDirectory: directory, loadSdk: async () => ({CopilotClient}), idleMs: 10 * 60 * 1000});
  try {
    const status = await runtime.authStatus();
    assert.equal(status.signedIn, false);
    assert.equal(seen.stop, 0);
    t.mock.timers.tick(10 * 60 * 1000 - 1);
    assert.equal(seen.stop, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(seen.stop, 1);
    assert.equal(seen.forceStop, 0);
  } finally { t.mock.timers.reset(); }
});

test('a token in a session error is not returned or logged', async () => {
  const leaking = {
    prompts: [],
    images: [],
    leaked: false,
    async authStatus() { return {signedIn: true, login: 'octocat', via: 'gh-cli' as const}; },
    async models() { return []; },
    async *run() {
      yield {type: 'error' as const, kind: 'not-signed-in' as const, message: classifyCopilotFailure({message: 'GH_TOKEN rejected github_pat_SECRET ghu_SECRET gho_SECRET'}).message};
    },
  } satisfies FakeCopilotRuntime;
  const logs: string[] = [];
  const f = await authoringFixture();
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(),
    log: line => logs.push(line), provider: createCopilotSdkProvider({runtime: leaking, model: 'auto'}),
  });
  await ai.ready;
  try {
    const job = await settle(ai, (await ai.start(inputOf(f.workspace))).id);
    const stored = await readFile(join(f.root, 'ai-jobs', `${job.id}.json`), 'utf8');
    const config = await readFile(join(f.root, 'ai-config.json'), 'utf8').catch(() => '');
    for (const token of ['github_pat_', 'gho_', 'ghu_']) {
      assert.equal(job.error?.message.includes(token), false, token);
      assert.equal(stored.includes(token), false, token);
      assert.equal(logs.join('\n').includes(token), false, token);
      assert.equal(config.includes(token), false, token);
    }
    assert.equal(job.error?.message.includes('Unset GH_TOKEN'), true);
  } finally { await ai.idle(); await f.cleanup(); }
});

test('an already-aborted Copilot run does not create a session or send', async () => {
  const seen = {start: 0, sessions: 0, send: 0, forceStop: 0};
  class CopilotClient {
    constructor(_options: object) {}
    async start() { seen.start += 1; }
    async stop() { return []; }
    async forceStop() { seen.forceStop += 1; }
    async getAuthStatus() { return {isAuthenticated: true, login: 'octocat', authType: 'gh-cli' as const}; }
    async listModels() { return []; }
    async createSession() {
      seen.sessions += 1;
      return {on() {}, async send() { seen.send += 1; }, async abort() {}, async disconnect() {}};
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'tnt-copilot-preabort-'));
  const runtime = createSdkCopilotRuntime({baseDirectory: directory, loadSdk: async () => ({CopilotClient}), idleMs: 60_000});
  const events = [];
  for await (const event of runtime.run({system: 'Stay terse.', prompt: 'hi', model: 'auto', signal: AbortSignal.abort()})) events.push(event);
  assert.deepEqual(events, []);
  assert.equal(seen.start, 0);
  assert.equal(seen.sessions, 0);
  assert.equal(seen.send, 0);
  assert.equal(seen.forceStop, 0);
  await runtime.stop();
});
