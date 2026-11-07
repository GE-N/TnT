import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createAiConfig} from '../server/ai/config.js';
import {createAi} from '../server/ai/index.js';
import {PROBE_TIMEOUT_MS} from '../server/ai/probe.js';
import {COPILOT_NOT_INSTALLED, createFakeCopilotRuntime, type CopilotAuth, type CopilotModel, type CopilotRuntime, type FakeCopilotRuntime} from '../server/ai/providers/copilot-runtime.js';
import {createApiHandler} from '../server/http.js';
import {createRunner} from '../server/runner.js';
import {authoringFixture} from './authoring-helpers.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TOKENS = ['gho_', 'ghu_', 'github_pat_', 'ghp_'];
const PLAN = (model: string) => `‘${model}’ isn’t on your Copilot plan.`;

function assertNoTokens(text: string) {
  for (const token of TOKENS) assert.equal(text.includes(token), false, token);
}

function memorySecrets() {
  const values = new Map<string, string>();
  return {
    values,
    async get(service: string) { return values.get(service); },
    async set(service: string, value: string) { values.set(service, value); },
    async delete(service: string) { values.delete(service); },
  };
}

function watch(runtime: FakeCopilotRuntime) {
  const counts = {auth: 0, models: 0};
  const wrapped: CopilotRuntime = {
    async authStatus() { counts.auth += 1; return runtime.authStatus(); },
    async models() { counts.models += 1; return runtime.models(); },
    run(input) { return runtime.run(input); },
  };
  return {counts, wrapped};
}

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'tnt-copilot-s2-'));
}

function harness(root: string, runtime: CopilotRuntime, extra: {env?: NodeJS.ProcessEnv; dev?: boolean; now?: () => number; fetch?: typeof fetch; probeTimeoutMs?: number} = {}) {
  const logs: string[] = [];
  const secrets = memorySecrets();
  const ai = createAiConfig({
    root, secrets, log: line => logs.push(line), copilotRuntime: runtime,
    env: extra.env ?? {}, dev: extra.dev ?? false, now: extra.now, fetch: extra.fetch, probeTimeoutMs: extra.probeTimeoutMs,
  });
  return {ai, logs, secrets};
}

function blankFile(over: {settingsRevision?: number; selected?: string; copilotModel?: string; openrouter?: Record<string, unknown>; openai?: Record<string, unknown>} = {}) {
  return JSON.stringify({
    settingsRevision: over.settingsRevision ?? 0,
    selected: over.selected ?? 'openrouter',
    providers: {
      openrouter: over.openrouter ?? {model: '', credentialRevision: 0},
      'openai-compatible': over.openai ?? {model: '', baseUrl: 'https://api.openai.com/v1', credentialRevision: 0},
      copilot: {model: over.copilotModel ?? 'auto'},
    },
  });
}

test('the Copilot probe deadline is the keyed-provider timeout', () => {
  assert.equal(PROBE_TIMEOUT_MS, 15_000);
});

test('status reports signed in, signed out, not installed, and auto first', async () => {
  const root = await tempRoot();
  try {
    const models: CopilotModel[] = [
      {id: 'gpt-5-mini', name: 'GPT-5 mini', enabled: true},
      {id: 'hidden', name: 'Hidden', enabled: false},
      {id: 'auto', name: 'Auto', enabled: true},
      {id: 'auto', name: 'Auto again', enabled: true},
      {id: 'gpt-5-mini', name: 'duplicate', enabled: true},
    ];
    const signedIn = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'}, models);
    const seen = watch(signedIn);
    const {ai} = harness(root, seen.wrapped);
    const status = await ai.copilotStatus(null);
    assert.equal('message' in status, false);
    assert.deepEqual(status, {
      installed: true,
      signedIn: true,
      login: 'octocat',
      via: 'gh-cli',
      models: [{id: 'auto', name: 'Auto'}, {id: 'gpt-5-mini', name: 'GPT-5 mini'}],
    });
    assert.deepEqual(Object.keys(status.models[0] ?? {}).sort(), ['id', 'name']);
    assert.equal(seen.counts.models, 1);
    assert.equal(signedIn.prompts.length, 0);
    await assert.rejects(() => readFile(join(root, 'ai-config.json')), (error: unknown) => (error as {code?: string}).code === 'ENOENT');

    const bare = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true}, [{id: 'gpt-5-mini', name: 'GPT-5 mini', enabled: true}]);
    const bareSeen = watch(bare);
    const bareConfig = harness(await tempRoot(), bareSeen.wrapped);
    try {
      const only = await bareConfig.ai.copilotStatus(null);
      assert.equal('login' in only, false);
      assert.equal('via' in only, false);
      assert.deepEqual(only.models, [{id: 'auto', name: 'Auto'}, {id: 'gpt-5-mini', name: 'GPT-5 mini'}]);
    } finally { await rm(bareConfig.ai.file.replace(/ai-config\.json$/, ''), {recursive: true, force: true}); }

    const signedOut = createFakeCopilotRuntime('authError', {signedIn: false, login: 'octocat', via: 'env', message: 'No authentication information'});
    const outSeen = watch(signedOut);
    const out = harness(root, outSeen.wrapped);
    const absent = await out.ai.copilotStatus('1');
    assert.deepEqual(absent, {installed: true, signedIn: false, models: []});
    assert.equal('login' in absent, false);
    assert.equal('via' in absent, false);
    assert.equal(outSeen.counts.models, 0);
    assert.equal(signedOut.prompts.length, 0);

    const missing = createFakeCopilotRuntime('authError', {signedIn: false, message: COPILOT_NOT_INSTALLED});
    const missingSeen = watch(missing);
    const missingConfig = harness(root, missingSeen.wrapped);
    assert.deepEqual(await missingConfig.ai.copilotStatus('1'), {installed: false, signedIn: false, models: []});
    assert.equal(missingSeen.counts.models, 0);
    assert.equal(missing.prompts.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('status caches for 60s and only refresh=1 recomputes', async () => {
  const root = await tempRoot();
  try {
    let clock = 10_000;
    const auth: CopilotAuth = {signedIn: true, login: 'octocat', via: 'copilot-login'};
    const runtime = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, auth);
    const seen = watch(runtime);
    const {ai} = harness(root, seen.wrapped, {now: () => clock});
    const first = await ai.copilotStatus(null);
    assert.equal(first.via, 'copilot-login');
    assert.equal(seen.counts.auth, 1);
    clock += 59_999;
    await ai.copilotStatus(null);
    await ai.copilotStatus('true');
    await ai.copilotStatus('0');
    await ai.copilotStatus('');
    assert.equal(seen.counts.auth, 1);
    clock += 1;
    assert.equal((await ai.copilotStatus(null)).signedIn, true);
    assert.equal(seen.counts.auth, 2);
    const again = await ai.copilotStatus('1');
    assert.equal(again.signedIn, true);
    assert.equal(seen.counts.auth, 3);
    auth.signedIn = false;
    assert.equal((await ai.copilotStatus(null)).signedIn, true);
    assert.equal(seen.counts.auth, 3);
    assert.equal((await ai.copilotStatus('1')).signedIn, false);
    assert.equal(seen.counts.auth, 4);
    assert.equal(runtime.prompts.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('Copilot test connection checks auth, one tiny call, and saves nothing', async () => {
  const root = await tempRoot();
  try {
    await writeFile(join(root, 'ai-config.json'), blankFile({settingsRevision: 4, copilotModel: 'auto'}));
    const ok = createFakeCopilotRuntime({kind: 'ok', text: 'OK', model: 'gpt-6-luna'}, {signedIn: true, login: 'octocat', via: 'gh-cli'});
    const {ai, logs, secrets} = harness(root, ok);
    const autoFile = await readFile(join(root, 'ai-config.json'), 'utf8');
    const result = await ai.testConnection({provider: 'copilot', testId: 'ping'});
    assert.deepEqual(result, {testId: 'ping', ok: true, model: 'gpt-6-luna'});
    assert.equal(ok.prompts.length, 1);
    assert.equal(ok.prompts[0]?.prompt, 'Reply with just: OK');
    assert.equal(ok.prompts[0]?.system, 'Connection check.');
    assert.equal(ok.prompts[0]?.model, 'auto');
    assert.equal(await readFile(join(root, 'ai-config.json'), 'utf8'), autoFile);
    assert.equal(secrets.values.size, 0);
    const logged = JSON.parse(logs.at(-1) ?? '{}') as {outcome?: string; inputTokens?: number; outputTokens?: number; cost?: number};
    assert.equal(logged.outcome, 'check_ok');
    assert.equal(logged.inputTokens, undefined);
    assert.equal(logged.outputTokens, undefined);
    assert.equal(logged.cost, undefined);

    await writeFile(join(root, 'ai-config.json'), blankFile({settingsRevision: 4, copilotModel: 'gpt-5-mini'}));
    const before = await readFile(join(root, 'ai-config.json'), 'utf8');
    const chosen = createFakeCopilotRuntime({kind: 'ok', text: 'OK', model: 'gpt-5-mini'}, {signedIn: true, login: 'octocat', via: 'env'});
    const chosenConfig = harness(root, chosen);
    const explicit = await chosenConfig.ai.testConnection({provider: 'copilot', testId: 'named'});
    assert.equal(explicit.ok, true);
    assert.equal(explicit.model, 'gpt-5-mini');
    assert.equal(chosen.prompts[0]?.model, 'gpt-5-mini');
    const overridden = createFakeCopilotRuntime({kind: 'ok', text: 'OK', model: 'gpt-4.1'}, {signedIn: true, login: 'octocat', via: 'env'});
    const override = await harness(root, overridden).ai.testConnection({provider: 'copilot', testId: 'override', model: 'gpt-4.1'});
    assert.equal(override.ok, true);
    assert.equal(overridden.prompts[0]?.model, 'gpt-4.1');

    const swapped = createFakeCopilotRuntime('modelSubstituted', {signedIn: true, login: 'octocat', via: 'gh-cli'});
    const swappedConfig = harness(root, swapped);
    const unavailable = await swappedConfig.ai.testConnection({provider: 'copilot', testId: 'swap', model: 'gpt-5-mini'});
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.code, 'MODEL_UNAVAILABLE');
    assert.equal(unavailable.message, PLAN('gpt-5-mini'));
    assert.equal(await readFile(join(root, 'ai-config.json'), 'utf8'), before);

    const signedOut = createFakeCopilotRuntime('authError', {signedIn: false, message: 'No authentication information'});
    const signedOutConfig = harness(root, signedOut);
    const offline = await signedOutConfig.ai.testConnection({provider: 'copilot', testId: 'out'});
    assert.deepEqual(offline, {testId: 'out', ok: false, code: 'NOT_SIGNED_IN', message: "Copilot isn't signed in."});
    assert.equal(signedOut.prompts.length, 0);

    const missing = createFakeCopilotRuntime('authError', {signedIn: false, message: COPILOT_NOT_INSTALLED});
    const missingConfig = harness(root, missing);
    const uninstalled = await missingConfig.ai.testConnection({provider: 'copilot', testId: 'missing'});
    assert.deepEqual(uninstalled, {testId: 'missing', ok: false, code: 'NOT_SIGNED_IN', message: "Copilot isn't installed"});
    assert.equal(missing.prompts.length, 0);

    const policy = createFakeCopilotRuntime('policyError', {signedIn: true, login: 'octocat', via: 'gh-cli'});
    assert.equal((await harness(root, policy).ai.testConnection({provider: 'copilot', testId: 'policy'})).code, 'POLICY_OFF');
    const seat = createFakeCopilotRuntime('noSeat', {signedIn: true, login: 'octocat', via: 'gh-cli'});
    assert.equal((await harness(root, seat).ai.testConnection({provider: 'copilot', testId: 'seat'})).code, 'NO_SEAT');
    const limited = createFakeCopilotRuntime('rateLimited', {signedIn: true, login: 'octocat', via: 'gh-cli'});
    const limit = await harness(root, limited).ai.testConnection({provider: 'copilot', testId: 'limit'});
    assert.equal(limit.code, 'RATE_LIMITED');
    assert.equal(limited.prompts.length, 1);

    const leaked = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'});
    const network: CopilotRuntime = {
      authStatus: () => leaked.authStatus(),
      models: () => leaked.models(),
      async *run() { yield {type: 'error', kind: 'network', message: 'proxy gho_SECRET ghu_SECRET ghp_SECRET github_pat_SECRET'}; },
    };
    const networkConfig = harness(root, network);
    const dropped = await networkConfig.ai.testConnection({provider: 'copilot', testId: 'net'});
    assert.equal(dropped.code, 'NETWORK_ERROR');
    assertNoTokens(JSON.stringify(dropped));
    assertNoTokens(networkConfig.logs.join('\n'));
    assert.equal(JSON.parse(networkConfig.logs.at(-1) ?? '{}').outcome, 'check_failed');

    const hung = createFakeCopilotRuntime('hang', {signedIn: true, login: 'octocat', via: 'gh-cli'});
    const hungConfig = harness(root, hung, {probeTimeoutMs: 30});
    const timeout = await hungConfig.ai.testConnection({provider: 'copilot', testId: 'hang'});
    assert.equal(timeout.ok, false);
    assert.equal(timeout.code, 'TIMEOUT');
    assert.equal(hung.leaked, false);
    assert.equal(await readFile(join(root, 'ai-config.json'), 'utf8'), before);
    await assert.rejects(
      () => ai.testConnection({provider: 'copilot', testId: 'bad', source: 'stored', credentialRevision: 0}),
      (error: unknown) => (error as {code?: string}).code === 'INVALID_CONFIG',
    );
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('PUT accepts a Copilot model and rejects a Copilot credential', async () => {
  const root = await tempRoot();
  try {
    const runtime = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'});
    const seen = watch(runtime);
    const {ai, secrets} = harness(root, seen.wrapped);
    const saved = await ai.put({expectedSettingsRevision: 0, selected: 'copilot', provider: 'copilot', model: 'gpt-5-mini', credential: {action: 'keep'}});
    assert.equal(saved.settingsRevision, 1);
    assert.equal(saved.selected, 'copilot');
    assert.equal(saved.providers.copilot.model, 'gpt-5-mini');
    assert.equal(secrets.values.size, 0);
    assert.equal(seen.counts.auth, 0);
    const file = JSON.parse(await readFile(join(root, 'ai-config.json'), 'utf8')) as {providers: {copilot: Record<string, unknown>}};
    assert.deepEqual(file.providers.copilot, {model: 'gpt-5-mini'});
    const before = await readFile(join(root, 'ai-config.json'), 'utf8');
    await assert.rejects(() => ai.put({expectedSettingsRevision: 1, selected: 'copilot', provider: 'copilot', model: 'auto', credential: {action: 'replace', apiKey: 'sk-NO', storage: 'keychain'}}), (error: unknown) => (error as {code?: string}).code === 'INVALID_CONFIG');
    await assert.rejects(() => ai.put({expectedSettingsRevision: 1, selected: 'copilot', provider: 'copilot', model: 'auto', credential: {action: 'remove'}}), (error: unknown) => (error as {code?: string}).code === 'INVALID_CONFIG');
    await assert.rejects(() => ai.put({expectedSettingsRevision: 1, selected: 'copilot', provider: 'copilot', model: 'auto', baseUrl: 'https://example.com', credential: {action: 'keep'}}), (error: unknown) => (error as {code?: string}).code === 'INVALID_CONFIG');
    assert.equal(await readFile(join(root, 'ai-config.json'), 'utf8'), before);
    assert.equal(secrets.values.size, 0);

    const switched = await ai.put({expectedSettingsRevision: 1, selected: 'copilot', provider: 'openrouter', model: 'vendor/model', credential: {action: 'replace', apiKey: 'sk-KEEP', storage: 'keychain'}});
    assert.equal(switched.selected, 'copilot');
    assert.equal(switched.providers.openrouter.model, 'vendor/model');
    assert.equal(switched.providers.openrouter.configured, true);
    assert.equal(switched.providers.copilot.model, 'gpt-5-mini');
    assert.equal(secrets.values.get('tnt.ai.openrouter'), 'sk-KEEP');

    const other = await ai.put({expectedSettingsRevision: 2, selected: 'openrouter', provider: 'copilot', model: 'auto', credential: {action: 'keep'}});
    assert.equal(other.selected, 'openrouter');
    assert.equal(other.providers.copilot.model, 'auto');

    await assert.rejects(() => ai.put({expectedSettingsRevision: 3, selected: 'ollama', provider: 'ollama', model: 'llama', credential: {action: 'keep'}}), (error: unknown) => (error as {code?: string; message?: string}).code === 'INVALID_CONFIG' && (error as {message?: string}).message === 'Local model providers are not available in this version.');
    await assert.rejects(() => ai.put({expectedSettingsRevision: 3, selected: 'anthropic', provider: 'anthropic', model: 'claude', credential: {action: 'keep'}}), (error: unknown) => (error as {code?: string; message?: string}).code === 'INVALID_CONFIG' && (error as {message?: string}).message === 'Anthropic is not available in this version.');
    await assert.rejects(() => ai.listModels('local'), (error: unknown) => (error as {message?: string}).message === 'Local model providers are not available in this version.');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('Copilot models match the status list and do not fetch a catalog', async () => {
  const root = await tempRoot();
  try {
    let fetches = 0;
    const runtime = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'env'}, [
      {id: 'gpt-5-mini', name: 'GPT-5 mini', enabled: true},
      {id: 'hidden', name: 'Hidden', enabled: false},
    ]);
    const seen = watch(runtime);
    const {ai} = harness(root, seen.wrapped, {fetch: async () => { fetches += 1; return new Response('no'); }});
    const status = await ai.copilotStatus(null);
    const listed = await ai.listModels('copilot');
    assert.equal(listed.provider, 'copilot');
    assert.deepEqual(listed.models, status.models);
    assert.equal(seen.counts.auth, 1);
    assert.equal(fetches, 0);
    assert.equal(runtime.prompts.length, 0);
    await assert.rejects(() => readFile(join(root, 'ai-config.json')), (error: unknown) => (error as {code?: string}).code === 'ENOENT');
    const signedOut = harness(root, watch(createFakeCopilotRuntime('authError', {signedIn: false})).wrapped);
    assert.deepEqual(await signedOut.ai.listModels('copilot'), {provider: 'copilot', models: []});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('first-run auto-select runs once from config and connect, and a save wins', async () => {
  const root = await tempRoot();
  try {
    const runtime = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'});
    const seen = watch(runtime);
    const {ai} = harness(root, seen.wrapped);
    await ai.copilotStatus(null);
    assert.equal(seen.counts.auth, 1);
    const selected = await ai.get();
    assert.equal(selected.selected, 'copilot');
    assert.equal(selected.settingsRevision, 1);
    assert.equal(selected.providers.copilot.model, 'auto');
    assert.equal(seen.counts.auth, 1);
    assert.equal(runtime.prompts.length, 0);
    runtime.authStatus = async () => ({signedIn: false});
    const again = await ai.get();
    assert.equal(again.selected, 'copilot');
    assert.equal(again.settingsRevision, 1);

    const fresh = await tempRoot();
    try {
      const connectRuntime = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'env'});
      const connected = harness(fresh, connectRuntime);
      const provider = await connected.ai.connect();
      assert.equal(provider.providerId, 'copilot');
      assert.equal(provider.model, 'auto');
      assert.equal(connectRuntime.prompts.length, 0);
      const file = JSON.parse(await readFile(join(fresh, 'ai-config.json'), 'utf8')) as {settingsRevision: number; selected: string; providers: {copilot: {model: string}}};
      assert.equal(file.settingsRevision, 1);
      assert.equal(file.selected, 'copilot');
      assert.equal(file.providers.copilot.model, 'auto');
    } finally { await rm(fresh, {recursive: true, force: true}); }

    const signedOutRoot = await tempRoot();
    try {
      const signedOut = harness(signedOutRoot, createFakeCopilotRuntime('authError', {signedIn: false}));
      const loaded = await signedOut.ai.get();
      assert.equal(loaded.selected, 'openrouter');
      assert.equal(loaded.settingsRevision, 0);
      await assert.rejects(() => signedOut.ai.connect(), (error: unknown) => (error as {code?: string}).code === 'PROVIDER_CONFIG');
      await assert.rejects(() => readFile(join(signedOutRoot, 'ai-config.json')), (error: unknown) => (error as {code?: string}).code === 'ENOENT');
    } finally { await rm(signedOutRoot, {recursive: true, force: true}); }

    const missingRoot = await tempRoot();
    try {
      const missing = harness(missingRoot, createFakeCopilotRuntime('authError', {signedIn: false, message: COPILOT_NOT_INSTALLED}));
      const loaded = await missing.ai.get();
      assert.equal(loaded.selected, 'openrouter');
      assert.equal(loaded.settingsRevision, 0);
    } finally { await rm(missingRoot, {recursive: true, force: true}); }

    const kept = await tempRoot();
    try {
      await writeFile(join(kept, 'ai-config.json'), blankFile({settingsRevision: 2, selected: 'openai-compatible'}));
      const keptSeen = watch(createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'}));
      const keptConfig = harness(kept, keptSeen.wrapped);
      const loaded = await keptConfig.ai.get();
      assert.equal(loaded.selected, 'openai-compatible');
      assert.equal(loaded.settingsRevision, 2);
      assert.equal(keptSeen.counts.auth, 0);
    } finally { await rm(kept, {recursive: true, force: true}); }

    const keychain = await tempRoot();
    try {
      const secrets = memorySecrets();
      secrets.values.set('tnt.ai.openrouter', 'sk-SAVED');
      const seenKey = watch(createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'}));
      const logs: string[] = [];
      const ai = createAiConfig({root: keychain, secrets, env: {}, dev: false, log: line => logs.push(line), copilotRuntime: seenKey.wrapped});
      const loaded = await ai.get();
      assert.equal(loaded.selected, 'openrouter');
      assert.equal(loaded.settingsRevision, 0);
      assert.equal(loaded.providers.openrouter.keySource, 'keychain');
      assert.equal(seenKey.counts.auth, 0);
    } finally { await rm(keychain, {recursive: true, force: true}); }

    const session = await tempRoot();
    try {
      const sessionRuntime = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'});
      const sessionConfig = harness(session, sessionRuntime);
      await sessionConfig.ai.put({
        expectedSettingsRevision: 0, selected: 'openai-compatible', provider: 'openai-compatible', model: 'gpt-test',
        baseUrl: 'https://api.openai.com/v1', credential: {action: 'replace', apiKey: 'sk-SESSION', storage: 'session'},
      });
      const file = JSON.parse(await readFile(join(session, 'ai-config.json'), 'utf8')) as {settingsRevision: number};
      file.settingsRevision = 0;
      await writeFile(join(session, 'ai-config.json'), JSON.stringify(file));
      const loaded = await sessionConfig.ai.get();
      assert.equal(loaded.selected, 'openai-compatible');
      assert.equal(loaded.settingsRevision, 0);
      assert.equal(loaded.providers['openai-compatible'].keySource, 'session');
    } finally { await rm(session, {recursive: true, force: true}); }

    const envRoot = await tempRoot();
    try {
      const envConfig = harness(envRoot, createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'}), {env: {TNT_AI_API_KEY: 'sk-ENV'}, dev: true});
      const loaded = await envConfig.ai.get();
      assert.equal(loaded.selected, 'openrouter');
      assert.equal(loaded.settingsRevision, 0);
      assert.equal(loaded.providers.openrouter.keySource, 'env');
      const ignored = harness(await tempRoot(), createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'}), {env: {TNT_AI_API_KEY: 'sk-ENV'}, dev: false});
      try {
        const picked = await ignored.ai.get();
        assert.equal(picked.selected, 'copilot');
        assert.equal(picked.providers.openrouter.keySource, undefined);
      } finally { await rm(ignored.ai.file.replace(/ai-config\.json$/, ''), {recursive: true, force: true}); }
    } finally { await rm(envRoot, {recursive: true, force: true}); }

    const race = await tempRoot();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      let hit = false;
      const inner = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'});
      const runtime: CopilotRuntime = {
        async authStatus() { hit = true; await gate; return inner.authStatus(); },
        models: () => inner.models(),
        run: input => inner.run(input),
      };
      const racing = harness(race, runtime);
      const pending = racing.ai.get();
      // Passing runs enter authStatus in a few milliseconds. One second only aborts a get() that never does; the pass is still that entry, before the save.
      const authEntryBudgetMs = 1000;
      await new Promise<void>((resolve, reject) => {
        let stopped = false;
        let queued: NodeJS.Immediate | undefined;
        let budget: NodeJS.Timeout;
        const finish = (error?: unknown) => {
          if (stopped) return;
          stopped = true;
          clearTimeout(budget);
          if (queued) clearImmediate(queued);
          queued = undefined;
          if (error) reject(error instanceof Error ? error : new Error(String(error)));
          else resolve();
        };
        budget = setTimeout(() => finish(new Error('authStatus was not entered within ' + authEntryBudgetMs + 'ms')), authEntryBudgetMs);
        const watch = () => {
          queued = undefined;
          if (stopped) return;
          if (hit) finish();
          else queued = setImmediate(watch);
        };
        pending.then(() => { if (!hit) finish(new Error('get() settled before authStatus')); }, finish);
        watch();
      });
      assert.equal(hit, true);
      const saved = await racing.ai.put({expectedSettingsRevision: 0, selected: 'openrouter', provider: 'openrouter', model: 'vendor/model', credential: {action: 'keep'}});
      release();
      const loaded = await pending;
      assert.equal(saved.selected, 'openrouter');
      assert.equal(saved.settingsRevision, 1);
      assert.equal(loaded.selected, 'openrouter');
      assert.equal(loaded.settingsRevision, 1);
      assert.equal(inner.prompts.length, 0);
    } finally { await rm(race, {recursive: true, force: true}); }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('OpenRouter test and models stay on their own contract', async () => {
  const root = await tempRoot();
  try {
    const seen: string[] = [];
    const {ai} = harness(root, createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'}), {
      fetch: async url => {
        seen.push(String(url));
        return new Response('{"data":{"label":"ok"}}', {status: 200, headers: {'content-type': 'application/json'}});
      },
    });
    const result = await ai.testConnection({provider: 'openrouter', testId: 'ok', source: 'replacement', apiKey: 'sk-GOOD'});
    assert.deepEqual(result, {testId: 'ok', ok: true, message: "Connected to OpenRouter. The model hasn't been tested yet."});
    assert.deepEqual(seen, ['https://openrouter.ai/api/v1/key']);
    assert.equal('model' in result, false);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('status, test, and logs never contain a token', async () => {
  const root = await tempRoot();
  try {
    const auth: CopilotAuth = {signedIn: true, login: 'gho_LOGINSECRET', via: 'gh-cli', message: 'github_pat_SECRET ghu_SECRET ghp_SECRET'};
    const runtime = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, auth);
    const {ai, logs} = harness(root, runtime);
    const status = await ai.copilotStatus(null);
    assertNoTokens(JSON.stringify(status));
    assert.equal('login' in status, false);
    assert.equal(status.signedIn, true);
    auth.signedIn = false;
    auth.message = 'No authentication information gho_SECRET ghu_SECRET ghp_SECRET github_pat_SECRET';
    const checked = await ai.testConnection({provider: 'copilot', testId: 'leak'});
    assert.equal(checked.code, 'NOT_SIGNED_IN');
    assertNoTokens(JSON.stringify(checked));
    assertNoTokens(logs.join('\n'));
    assert.equal(checked.message?.includes('Unset GH_TOKEN'), true);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the status route is read-only and config auto-selects over HTTP', async () => {
  const f = await authoringFixture();
  const counts = {auth: 0};
  const inner = createFakeCopilotRuntime({kind: 'ok', text: 'OK'}, {signedIn: true, login: 'octocat', via: 'gh-cli'}, [
    {id: 'gpt-5-mini', name: 'GPT-5 mini', enabled: true},
  ]);
  const runtime: CopilotRuntime = {
    async authStatus() { counts.auth += 1; return inner.authStatus(); },
    models: () => inner.models(),
    run: input => inner.run(input),
  };
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, dev: false,
    secrets: memorySecrets(), log: () => {}, copilotRuntime: runtime,
  });
  await ai.ready;
  const runner = createRunner({artifactDirectory: f.root, execute: async () => { throw new Error('status route must not execute'); }});
  const server = createServer(createApiHandler(runner, f.root, undefined, f.service, ai));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const token = ((await (await fetch(`${base}/api/status`)).json()) as {token: string}).token;
    const headers = {'x-tnt-token': token};
    const status = await fetch(`${base}/api/ai/copilot/status?refresh=true`, {headers});
    assert.equal(status.status, 200);
    const body = await status.json() as {installed: boolean; signedIn: boolean; models: {id: string}[]; login?: string};
    assert.equal(body.installed, true);
    assert.equal(body.signedIn, true);
    assert.equal(body.login, 'octocat');
    assert.equal(body.models[0]?.id, 'auto');
    assert.equal(counts.auth, 1);
    await assert.rejects(() => readFile(join(f.root, 'ai-config.json')), (error: unknown) => (error as {code?: string}).code === 'ENOENT');
    const cached = await fetch(`${base}/api/ai/copilot/status?refresh=0`, {headers});
    assert.equal(cached.status, 200);
    assert.equal(counts.auth, 1);
    const refreshed = await fetch(`${base}/api/ai/copilot/status?refresh=1`, {headers});
    assert.equal(refreshed.status, 200);
    assert.equal(counts.auth, 2);
    const config = await (await fetch(`${base}/api/ai/config`, {headers})).json() as {selected: string; settingsRevision: number; providers: {copilot: {model: string}}};
    assert.equal(config.selected, 'copilot');
    assert.equal(config.settingsRevision, 1);
    assert.equal(config.providers.copilot.model, 'auto');
    assert.equal(inner.prompts.length, 0);
    assertNoTokens(JSON.stringify(body));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await ai.idle();
    await f.cleanup();
  }
});

test('setup.sh prints an informational Copilot line and never a token', () => {
  const script = spawnSync('bash', ['-n', 'scripts/setup.sh'], {cwd: REPO, encoding: 'utf8'});
  assert.equal(script.status, 0, script.stderr);
  const setup = spawnSync('cat', ['scripts/setup.sh'], {cwd: REPO, encoding: 'utf8'}).stdout;
  assert.equal(setup.includes('does not use it yet'), false);
  assert.equal(setup.includes('Copilot support is not built yet'), false);
  assert.equal(setup.includes('gh auth token'), false);
  assert.equal(setup.includes('~/.copilot'), false);
  assert.equal(setup.includes('~/.config/gh'), false);
  assert.equal(setup.includes('scripts/copilot-auth-line.mjs'), true);
  assert.equal(setup.includes('Copilot: not signed in → run \\`copilot login\\`'), true);
  assert.equal(setup.includes('Copilot: SDK not installed'), true);
  const source = spawnSync('cat', ['scripts/copilot-auth-line.mjs'], {cwd: REPO, encoding: 'utf8'}).stdout;
  assert.equal(source.includes('gh auth token'), false);
  assert.equal(source.includes('process.env'), false);
  assert.equal(source.includes('.send('), false);
  assert.equal(source.includes('getAuthStatus'), true);
  const lines = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {copilotAuthLine, copilotAuthFailureLine} from './scripts/copilot-auth-line.mjs';
    const samples = [
      {isAuthenticated: true, login: 'octocat', authType: 'gh-cli'},
      {isAuthenticated: true, login: 'octocat', authType: 'user'},
      {isAuthenticated: true, login: 'octocat', authType: 'env'},
      {isAuthenticated: true, login: 'octocat', authType: 'token'},
      {isAuthenticated: false},
      {installed: false},
      {isAuthenticated: true, login: 'gho_SECRET', authType: 'gh-cli'},
      {isAuthenticated: true, login: 'github_pat_SECRET', authType: 'env'},
    ];
    for (const sample of samples) console.log(copilotAuthLine(sample));
    console.log(copilotAuthFailureLine(Object.assign(new Error("Cannot find package '@github/copilot-sdk' gho_SECRET"), {code: 'ERR_MODULE_NOT_FOUND'})));
    console.log(copilotAuthFailureLine(new Error('down gho_SECRET ghu_SECRET ghp_SECRET github_pat_SECRET')));
  `], {cwd: REPO, encoding: 'utf8'});
  assert.equal(lines.status, 0, lines.stderr);
  const printed = lines.stdout.trim().split('\n');
  assert.deepEqual(printed, [
    'Copilot: signed in as octocat (via gh)',
    'Copilot: signed in as octocat (via copilot)',
    'Copilot: signed in as octocat (via env)',
    'Copilot: signed in as octocat (via env)',
    'Copilot: not signed in → run `copilot login`',
    'Copilot: SDK not installed',
    'Copilot: signed in (via gh)',
    'Copilot: signed in (via env)',
    'Copilot: SDK not installed',
    'Copilot: not signed in → run `copilot login`',
  ]);
  assertNoTokens(lines.stdout);
  assertNoTokens(lines.stderr);
});
