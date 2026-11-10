import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAi} from '../server/ai/index.js';
import {createFakeProvider, type FakeResult} from '../server/ai/providers/fake.js';
import type {ScenarioCatalog} from '../server/ai/router.js';
import {createKnowledgeService, type ContextContent} from '../server/knowledge/index.js';
import {authoringFixture, exampleDraft} from './authoring-helpers.js';

const EXISTING: ContextContent = {
  purpose: 'Old purpose',
  expectedOutcome: 'Old outcome',
  rationale: 'Old why',
  preconditions: 'Old before',
  exceptions: 'Old except',
  scope: 'Old scope',
};

function memorySecrets() {
  const values = new Map<string, string>();
  return {values, async get(service: string) { return values.get(service); }, async set(service: string, value: string) { values.set(service, value); }, async delete(service: string) { values.delete(service); }};
}

function catalog(context: ContextContent = EXISTING, extras: {id: string; title: string}[] = []): ScenarioCatalog {
  return {
    scenarios: [{id: 'guest', title: 'Guest checkout'}, ...extras],
    current: {
      id: 'guest', title: 'Guest checkout', visitTitles: ['Home', 'Cart'],
      steps: [{text: '1 · Tap text · Continue'}, {text: '2 · Tap text · Cart'}],
      context, contextRevision: 4,
    },
  };
}

function model(over: Partial<ContextContent> = {}, conflicts: string[] = []) {
  return JSON.stringify({...EXISTING, ...over, questions: [], conflicts});
}

async function settle<T extends {state: string}>(ai: {get(id: string): Promise<T>}, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await ai.get(id);
    if (job.state !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('generation did not finish');
}

async function harness(handle: (input: {call: number; system: string; messages: {role: string; content: string}[]}) => FakeResult, scenarioCatalog = catalog()) {
  const f = await authoringFixture();
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: () => {},
    readCatalog: async () => scenarioCatalog,
    provider: createFakeProvider(handle),
  });
  const start = (prompt: string, extra: Record<string, unknown> = {}) => ai.start({workspaceId: f.workspace.id, expectedRevision: f.workspace.metadata!.revision, prompt, ...extra});
  return {ai, f, start, cleanup: async () => { await ai.idle(); await f.cleanup(); }};
}

test('a knowledge draft changes only the requested field and does not invent Why', async () => {
  const g = await harness(({system}) => {
    if (system.startsWith('You route')) return {kind: 'ok', text: JSON.stringify({intent: 'knowledge'})};
    return {kind: 'ok', text: model({purpose: 'Buy a gift', expectedOutcome: 'A drafted outcome', rationale: 'Because shopping is fun', preconditions: 'Must be lucky', scope: 'Entire app'})};
  });
  try {
    const job = await settle(g.ai, (await g.start('Set the purpose to Buy a gift')).id);
    assert.equal(job.state, 'pending');
    assert.equal(job.intent, 'knowledge');
    assert.equal(job.kind, 'knowledge');
    assert.equal(job.skill, 'knowledge-update@1');
    assert.equal(job.draft, undefined);
    assert.equal(job.knowledgeDraft?.purpose, 'Buy a gift');
    assert.equal(job.knowledgeDraft?.expectedOutcome, EXISTING.expectedOutcome);
    assert.equal(job.knowledgeDraft?.rationale, EXISTING.rationale);
    assert.equal(job.knowledgeDraft?.preconditions, EXISTING.preconditions);
    assert.equal(job.knowledgeDraft?.exceptions, EXISTING.exceptions);
    assert.equal(job.knowledgeDraft?.scope, EXISTING.scope);
    assert.equal(job.knowledgeDraft?.baseContextRevision, 4);
  } finally { await g.cleanup(); }
});

test('an outcome the flow does not reach asks back, and Save as written drafts that wording', async () => {
  let knowledgeCalls = 0;
  const g = await harness(({system}) => {
    if (system.startsWith('You route')) return {kind: 'ok', text: JSON.stringify({intent: 'knowledge'})};
    knowledgeCalls += 1;
    return {kind: 'ok', text: model({expectedOutcome: 'it ends at the order confirmation', rationale: 'Because shopping is fun'})};
  });
  try {
    const asked = await settle(g.ai, (await g.start('Set the expected outcome to: it ends at the order confirmation')).id);
    assert.equal(asked.state, 'needsInfo');
    assert.equal(asked.knowledgeDraft, undefined);
    assert.equal(asked.draft, undefined);
    assert.equal(asked.questions?.[0]?.text, 'The flow ends at Cart, but this says it ends at the order confirmation.');
    assert.deepEqual(asked.questions?.[0]?.options, ['Match the flow (ends at Cart)', 'Save as written', 'Update the flow instead']);
    const callsBeforeAnswer = knowledgeCalls;
    const drafted = await settle(g.ai, (await g.start('Save as written', {previousJobId: asked.id, answers: [{key: 'conflict-outcome', answer: 'Save as written'}]})).id);
    assert.equal(knowledgeCalls, callsBeforeAnswer);
    assert.equal(drafted.state, 'pending');
    assert.equal(drafted.intent, 'knowledge');
    assert.equal(drafted.knowledgeDraft?.expectedOutcome, 'it ends at the order confirmation');
    assert.equal(drafted.knowledgeDraft?.rationale, EXISTING.rationale);
    assert.equal(drafted.knowledgeDraft?.purpose, EXISTING.purpose);
  } finally { await g.cleanup(); }
});

test('Update the flow instead re-routes the same request into a flow job', async () => {
  const g = await harness(({system}) => {
    if (system.startsWith('You route')) return {kind: 'ok', text: JSON.stringify({intent: 'knowledge'})};
    if (system.startsWith('You author')) return {kind: 'ok', text: JSON.stringify(exampleDraft)};
    return {kind: 'ok', text: model({expectedOutcome: 'it ends at the order confirmation'})};
  });
  try {
    const asked = await settle(g.ai, (await g.start('Set the expected outcome to: it ends at the order confirmation')).id);
    assert.equal(asked.questions?.[0]?.options.includes('Update the flow instead'), true);
    const flowed = await settle(g.ai, (await g.start('Update the flow instead', {previousJobId: asked.id, answers: [{key: 'conflict-outcome', answer: 'Update the flow instead'}]})).id);
    assert.equal(flowed.state, 'pending');
    assert.equal(flowed.intent, 'flow');
    assert.equal(flowed.kind, 'flow');
    assert.deepEqual(flowed.draft, exampleDraft);
    assert.equal(flowed.knowledgeDraft, undefined);
  } finally { await g.cleanup(); }
});

test('a sign-in precondition missing from the flow asks back with the other-intent option', async () => {
  const g = await harness(({system}) => {
    if (system.startsWith('You route')) return {kind: 'ok', text: JSON.stringify({intent: 'knowledge'})};
    if (system.startsWith('You author')) return {kind: 'ok', text: JSON.stringify(exampleDraft)};
    return {kind: 'ok', text: model({preconditions: 'The shopper is signed in'})};
  });
  try {
    const asked = await settle(g.ai, (await g.start('Add a precondition that the shopper is signed in')).id);
    assert.equal(asked.knowledgeDraft, undefined);
    assert.equal(asked.questions?.[0]?.text, 'This says the shopper is signed in, but the flow has no sign-in step.');
    assert.deepEqual(asked.questions?.[0]?.options, ['Save as written', 'Add a sign-in step to the flow']);
    const flowed = await settle(g.ai, (await g.start('Add a sign-in step', {previousJobId: asked.id, answers: [{key: 'conflict-precondition', answer: 'Add a sign-in step to the flow'}]})).id);
    assert.equal(flowed.intent, 'flow');
    assert.equal(flowed.knowledgeDraft, undefined);
    assert.deepEqual(flowed.draft, exampleDraft);
  } finally { await g.cleanup(); }
});

test('naming another scenario asks which one, with no model call', async () => {
  let calls = 0;
  const g = await harness(() => { calls += 1; return {kind: 'ok', text: JSON.stringify({intent: 'flow'})}; }, catalog(EXISTING, [{id: 'login', title: 'Login'}]));
  try {
    const job = await settle(g.ai, (await g.start('Update the Login scenario purpose')).id);
    assert.equal(calls, 0);
    assert.equal(job.state, 'needsInfo');
    assert.equal(job.knowledgeDraft, undefined);
    assert.equal(job.questions?.[0]?.text, 'Update Guest checkout, or Login?');
    assert.deepEqual(job.questions?.[0]?.options, ['Guest checkout', 'Login']);
  } finally { await g.cleanup(); }
});

test('a pending knowledge draft makes a flow request ask to finish it first', async () => {
  let flowCalls = 0;
  const g = await harness(({system, messages}) => {
    if (system.startsWith('You route')) {
      const user = messages.map(message => message.content).join('\n');
      return {kind: 'ok', text: JSON.stringify({intent: user.includes('Add a tap') ? 'flow' : 'knowledge'})};
    }
    if (system.startsWith('You author')) { flowCalls += 1; return {kind: 'ok', text: JSON.stringify(exampleDraft)}; }
    return {kind: 'ok', text: model({purpose: 'Keep this purpose'})};
  });
  try {
    const first = await settle(g.ai, (await g.start('Set the purpose to Keep this purpose')).id);
    assert.equal(first.state, 'pending');
    assert.equal(first.knowledgeDraft?.purpose, 'Keep this purpose');
    const second = await settle(g.ai, (await g.start('Add a tap step')).id);
    assert.equal(second.state, 'needsInfo');
    assert.equal(second.questions?.[0]?.text, 'Finish the current draft first?');
    assert.deepEqual(second.questions?.[0]?.options, ['Apply it', 'Dismiss it']);
    assert.equal(second.draft, undefined);
    assert.equal(second.knowledgeDraft, undefined);
    assert.equal(flowCalls, 0);
    const still = await g.ai.get(first.id);
    assert.equal(still.state, 'pending');
    assert.equal(still.knowledgeDraft?.purpose, 'Keep this purpose');
  } finally { await g.cleanup(); }
});

test('a mixed request drafts the flow first and leaves knowledge unpublished', async () => {
  const f = await authoringFixture();
  const workspace = await f.service.save({
    id: f.workspace.id, name: f.workspace.name, yaml: f.workspace.yaml, flows: {}, canvas: {screens: [], edges: [], paths: []},
    scenarios: [{id: 'guest', name: 'Guest checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    expectedRevision: f.workspace.metadata!.revision,
  });
  const knowledge = createKnowledgeService({root: f.root, queue: {enqueue() {}}, reconcileIntervalMs: 0});
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: line => { if (line.includes('UNIQUE_PURPOSE_SENTINEL')) throw new Error('prompt leaked'); },
    readCatalog: async () => catalog(),
    provider: createFakeProvider(({system}) => {
      if (system.startsWith('You route')) return {kind: 'ok', text: JSON.stringify({intent: 'mixed'})};
      return {kind: 'ok', text: JSON.stringify(exampleDraft)};
    }),
  });
  try {
    const job = await settle(ai, (await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: 'Add a cart step and set the purpose to UNIQUE_PURPOSE_SENTINEL'})).id);
    assert.equal(job.state, 'pending');
    assert.equal(job.intent, 'mixed');
    assert.equal(job.remainder?.includes('UNIQUE_PURPOSE_SENTINEL'), true);
    assert.deepEqual(job.draft, exampleDraft);
    assert.equal(job.knowledgeDraft, undefined);
    await assert.rejects(() => readFile(join(f.root, 'workspaces', workspace.id, 'knowledge', 'scenarios', 'guest.json'), 'utf8'), (error: unknown) => (error as {code?: string}).code === 'ENOENT');
    await knowledge.publish(workspace.id);
    const current = JSON.parse(await readFile(join(f.root, 'knowledge', 'current', `workspace-${workspace.id}.json`), 'utf8')) as {generationId: string};
    const generation = join(f.root, 'knowledge', 'generations', `workspace-${workspace.id}`, current.generationId);
    const html = await readFile(join(generation, 'workspaces', `${workspace.id}.html`), 'utf8');
    const index = await readFile(join(generation, 'index.jsonl'), 'utf8');
    assert.equal(html.includes('UNIQUE_PURPOSE_SENTINEL'), false);
    assert.equal(index.includes('UNIQUE_PURPOSE_SENTINEL'), false);
  } finally { knowledge.close(); await ai.idle(); await f.cleanup(); }
});
