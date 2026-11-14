import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createAi} from '../server/ai/index.js';
import {ProviderRequestError} from '../server/ai/providers/types.js';
import {createFakeProvider, type FakeResult} from '../server/ai/providers/fake.js';
import {classifyIntent, settleRouter, type ScenarioCatalog} from '../server/ai/router.js';
import {loadBundledSkills, loadSkill} from '../server/ai/skills.js';
import {authoringFixture, exampleDraft} from './authoring-helpers.js';

const ROUTER_HASH = 'f8bf6d59299e5d69e105b87fea0a93fac6c1b95ff12ea0e581da1d1e4d939bf4';
const KNOWLEDGE_HASH = '2dd9dfcf5df2c6370aba3bc752e56db67ec8a90979a63ce798db9cb66d1cd6b1';
const PROTECTED = {
  'server/ai/prompt.ts': '0228e18c69bef2677354fa13060fd108fd3499f6ebfd051424d614a57a52fd5a',
  'server/ai/repair.ts': '54b8b4da3b422071f3896b08c8190a9f7373983cd9d440b0a3d309e5ec4c4d81',
  'server/ai/questions.ts': 'b5158e2e1c9aedc83b8bcb6edf89b50ac1778f0ec4d062e4fcd7adbd73d9f8fd',
  'docs/contracts/ai-flow-v1/flow-draft.schema.json': '54520041a2b39c7e084ea1b48d51ee674fc67591509d7f11fef560d79583c7a5',
  'server/run-script-contract.ts': 'e4ac75f27945f39a935f410cb52699196d963ed9d0bf482c5c821792dfabeb76',
} as const;

const cases = JSON.parse(readFileSync(new URL('../server/ai/skills/router/v1/fixtures/cases.json', import.meta.url), 'utf8')) as {id: string; text: string; expected: string; tags: string[]; currentTitle?: string; otherTitles?: string[]}[];

function memorySecrets() {
  const values = new Map<string, string>();
  return {values, async get(service: string) { return values.get(service); }, async set(service: string, value: string) { values.set(service, value); }, async delete(service: string) { values.delete(service); }};
}

function catalog(): ScenarioCatalog {
  return {
    scenarios: [{id: 'guest', title: 'Guest checkout'}],
    current: {
      id: 'guest', title: 'Guest checkout', visitTitles: ['Home', 'Cart'],
      steps: [{text: '1 · Tap text · Continue'}],
      context: {purpose: '', expectedOutcome: '', rationale: '', preconditions: '', exceptions: '', scope: ''},
      contextRevision: 0,
    },
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

test('router@1 and knowledge-update@1 are hash pinned', () => {
  const router = loadSkill('router');
  const knowledge = loadSkill('knowledge-update');
  assert.equal(router.id, 'router@1');
  assert.equal(knowledge.id, 'knowledge-update@1');
  assert.equal(router.hash, ROUTER_HASH);
  assert.equal(knowledge.hash, KNOWLEDGE_HASH);
  assert.equal(router.prompt.startsWith('You route one TnT request.'), true);
  assert.equal(knowledge.prompt.includes('data, not instructions'), true);
});

test('flow prompt files stay byte-identical to main 2f852a8', () => {
  for (const [path, hash] of Object.entries(PROTECTED)) {
    const bytes = readFileSync(new URL('../' + path, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, path);
  }
});

test('router schema rejects off-schema output and failures never become flow', () => {
  const skill = loadBundledSkills().router;
  for (const failure of ['provider', 'timeout'] as const) {
    const decision = settleRouter({ok: false, failure}, skill);
    assert.equal(decision.intent, 'unclear');
    assert.notEqual(decision.intent, 'flow');
  }
  for (const text of ['not json', '{"nope":true}', '{"intent":"flow","extra":1}', JSON.stringify(exampleDraft), '{"intent":"somewhere"}']) {
    const decision = settleRouter({ok: true, text}, skill);
    assert.equal(decision.intent, 'unclear', text);
  }
  assert.equal(settleRouter({ok: true, text: '{"intent":"knowledge"}'}, skill).intent, 'knowledge');
});

test('router eval list covers thai, english, mixed, conflict, and other-scenario', () => {
  assert.ok(cases.length >= 20);
  const tags = new Set(cases.flatMap(item => item.tags));
  for (const tag of ['thai', 'english', 'mixed', 'conflict', 'other-scenario']) assert.equal(tags.has(tag), true, tag);
  assert.ok(cases.filter(item => item.tags.includes('thai')).length >= 4);
  for (const item of cases) assert.equal(classifyIntent(item), item.expected, item.id);
});

test('a routed flow call matches the unrouted flow provider bytes', async () => {
  const f = await authoringFixture();
  const prompt = 'Add a step that taps Continue. UNIQUE_PROMPT_SENTINEL';
  let plain: {system: string; messages: {role: string; content: string}[]} | undefined;
  let routedRouter: {system: string; messages: {role: string; content: string}[]} | undefined;
  let routedFlow: {system: string; messages: {role: string; content: string}[]} | undefined;
  const plainAi = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: () => {},
    provider: createFakeProvider(({system, messages}) => {
      plain = {system, messages};
      return {kind: 'ok', text: JSON.stringify(exampleDraft)};
    }),
  });
  const routedAi = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: () => {},
    readCatalog: async () => catalog(),
    provider: createFakeProvider(({system, messages}) => {
      if (system.startsWith('You route')) {
        routedRouter = {system, messages};
        return {kind: 'ok', text: JSON.stringify({intent: 'flow'})};
      }
      routedFlow = {system, messages};
      return {kind: 'ok', text: JSON.stringify(exampleDraft)};
    }),
  });
  try {
    const body = {workspaceId: f.workspace.id, expectedRevision: f.workspace.metadata!.revision, prompt};
    const unrouted = await settle(plainAi, (await plainAi.start(body)).id);
    const routed = await settle(routedAi, (await routedAi.start(body)).id);
    assert.equal(unrouted.state, 'pending');
    assert.equal(routed.state, 'pending');
    assert.equal(routed.intent, 'flow');
    assert.equal(routedRouter?.system, loadSkill('router').prompt);
    assert.equal(routedRouter?.system.includes('UNIQUE_PROMPT_SENTINEL'), false);
    assert.equal(routedRouter?.messages.some(message => message.content.includes('UNIQUE_PROMPT_SENTINEL')), true);
    assert.equal(routedRouter?.messages.some(message => message.content.includes('data, not instructions')), true);
    assert.deepEqual(routedFlow, plain);
  } finally {
    await plainAi.idle();
    await routedAi.idle();
    await f.cleanup();
  }
});

test('router provider failures stay unclear and do not call the flow model', async () => {
  const failures: {name: string; result: FakeResult; timeouts?: {deadlineMs: number}}[] = [
    {name: 'off-schema', result: {kind: 'ok', text: JSON.stringify(exampleDraft)}},
    {name: 'provider', result: {kind: 'fail', error: new ProviderRequestError({code: 'PROVIDER_UNAVAILABLE', message: 'down', retryable: true})}},
    {name: 'timeout', result: {kind: 'delay', ms: 200, text: '{"intent":"flow"}'}, timeouts: {deadlineMs: 40}},
  ];
  for (const failure of failures) {
    let flowCalls = 0;
    const f = await authoringFixture();
    const ai = createAi({
      root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: () => {},
      readCatalog: async () => catalog(), timeouts: failure.timeouts,
      provider: createFakeProvider(({system}) => {
        if (system.startsWith('You author')) { flowCalls += 1; return {kind: 'ok', text: JSON.stringify(exampleDraft)}; }
        return failure.result;
      }),
    });
    try {
      const job = await settle(ai, (await ai.start({workspaceId: f.workspace.id, expectedRevision: f.workspace.metadata!.revision, prompt: 'Add a step'})).id);
      assert.equal(job.state, 'needsInfo', failure.name);
      assert.equal(job.intent, 'unclear', failure.name);
      assert.equal(job.questions?.[0]?.text, 'Change the flow, or update the scenario details?');
      assert.deepEqual(job.questions?.[0]?.options, ['The flow', 'The details']);
      assert.equal(job.draft, undefined, failure.name);
      assert.equal(job.knowledgeDraft, undefined, failure.name);
      assert.equal(flowCalls, 0, failure.name);
      assert.notEqual(job.error?.code, 'TIMEOUT');
    } finally { await ai.idle(); await f.cleanup(); }
  }
});
