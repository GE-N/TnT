import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAi} from '../server/ai/index.js';
import {CANT_READ_IMAGES} from '../server/ai/errors.js';
import {CREATE_SCENARIO_PROMPT, DIAGRAM_IMAGE_BYTE_LIMIT, IMAGE_TOO_LARGE, NOT_A_PNG_OR_JPEG, decodeDiagramImage, parseDiagram} from '../server/ai/diagram.js';
import {createFakeProvider, type FakeResult} from '../server/ai/providers/fake.js';
import {createCopilotSdkProvider} from '../server/ai/providers/copilot-sdk.js';
import {copilotSendBody, createFakeCopilotRuntime} from '../server/ai/providers/copilot-runtime.js';
import {createOpenAiCompatibleProvider, openAiMessageContent} from '../server/ai/providers/openai-compatible.js';
import type {ScenarioCatalog} from '../server/ai/router.js';
import {createKnowledgeService} from '../server/knowledge/index.js';
import {authoringFixture, exampleDraft} from './authoring-helpers.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const FLOW = [
  'flowchart TD',
  '  Home[Home] --> Pay{Paid?}',
  '  Pay -->|yes| Done[Done]',
  '  Pay -->|no| Err[Error]',
].join('\n');

function memorySecrets() {
  const values = new Map<string, string>();
  return {values, async get(service: string) { return values.get(service); }, async set(service: string, value: string) { values.set(service, value); }, async delete(service: string) { values.delete(service); }};
}

function catalog(): ScenarioCatalog {
  return {
    scenarios: [{id: 'guest', title: 'Guest checkout'}],
    current: {
      id: 'guest', title: 'Guest checkout', visitTitles: ['Home'], steps: [{text: '1 · Tap text · Continue'}],
      context: {purpose: 'Keep purpose', expectedOutcome: 'Keep outcome', rationale: 'Keep why', preconditions: '', exceptions: '', scope: ''},
      contextRevision: 0,
    },
  };
}

async function settle<T extends {state: string}>(ai: {get(id: string): Promise<T>}, id: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const job = await ai.get(id);
    if (job.state !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('generation did not finish');
}

test('a flowchart lists one path per branch and rejects other diagram kinds', () => {
  const parsed = parseDiagram(FLOW);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.paths.map(path => path.labels), [['Home', 'Paid?', 'Done'], ['Home', 'Paid?', 'Error']]);
  assert.equal(parseDiagram('sequenceDiagram\n  A->>B: Hi').ok, false);
  assert.equal(parseDiagram('```mermaid\n' + FLOW + '\n```').ok, true);
});

test('only a PNG or JPEG export is accepted', () => {
  assert.equal(decodeDiagramImage({mimeType: 'image/png', data: PNG}).mimeType, 'image/png');
  assert.equal(decodeDiagramImage({mimeType: 'image/jpeg', data: JPEG}).mimeType, 'image/jpeg');
  assert.throws(() => decodeDiagramImage({mimeType: 'image/gif', data: Buffer.from('GIF89a').toString('base64')}), (error: unknown) => (error as {message?: string}).message === NOT_A_PNG_OR_JPEG);
  assert.throws(() => decodeDiagramImage({mimeType: 'image/png', data: JPEG}), (error: unknown) => (error as {message?: string}).message === NOT_A_PNG_OR_JPEG);
  const huge = Buffer.concat([Buffer.from(PNG, 'base64').subarray(0, 8), Buffer.alloc(DIAGRAM_IMAGE_BYTE_LIMIT)]);
  assert.throws(() => decodeDiagramImage({mimeType: 'image/png', data: huge.toString('base64')}), (error: unknown) => (error as {message?: string}).message === IMAGE_TOO_LARGE);
});

test('OpenAI sends image parts and an unproven provider refuses before the network', async () => {
  const image = {mimeType: 'image/png' as const, data: PNG};
  const parts = openAiMessageContent({role: 'user', content: 'Read this', image});
  assert.ok(Array.isArray(parts));
  if (!Array.isArray(parts)) return;
  assert.equal(parts[0]?.type, 'text');
  assert.equal(parts[1]?.type, 'image_url');
  assert.equal(parts[1]?.image_url?.url.startsWith('data:image/png;base64,'), true);
  let called = false;
  const openRouter = createOpenAiCompatibleProvider({
    baseUrl: 'https://openrouter.ai/api/v1', model: 'vendor/model', apiKey: 'secret', preset: 'openrouter',
    fetch: async () => { called = true; throw new Error('network'); },
  });
  await assert.rejects(async () => {
    for await (const event of openRouter.generate({system: 'sys', messages: [{role: 'user', content: 'Read this', image}], schema: {}, maxOutputTokens: 20, signal: AbortSignal.timeout(1000)})) {
      void event;
    }
  }, (error: unknown) => (error as {message?: string}).message === CANT_READ_IMAGES);
  assert.equal(called, false);
});

test('Copilot attaches a blob only for a vision model', async () => {
  const image = {mimeType: 'image/png' as const, data: PNG};
  const body = copilotSendBody({prompt: 'Read this', image});
  assert.equal(body.prompt, 'Read this');
  assert.equal(body.attachments?.[0]?.type, 'blob');
  assert.equal(body.attachments?.[0]?.data, PNG);
  assert.equal(body.prompt.includes(PNG), false);
  const seen = createFakeCopilotRuntime({kind: 'ok', text: '{}', model: 'gpt-4.1'}, {signedIn: true, login: 'octocat', via: 'gh-cli'}, [{id: 'gpt-4.1', name: 'GPT', enabled: true, vision: true}]);
  const provider = createCopilotSdkProvider({runtime: seen, model: 'gpt-4.1'});
  for await (const event of provider.generate({system: 'sys', messages: [{role: 'user', content: 'Read this', image}], schema: {}, maxOutputTokens: 20, signal: AbortSignal.timeout(1000)})) {
    void event;
  }
  assert.equal(seen.images.length, 1);
  assert.equal(seen.prompts[0]?.prompt.includes(PNG), false);
  const blind = createFakeCopilotRuntime({kind: 'ok', text: '{}'}, {signedIn: true}, [{id: 'gpt-4.1', name: 'GPT', enabled: true}]);
  const refused = createCopilotSdkProvider({runtime: blind, model: 'gpt-4.1'});
  await assert.rejects(async () => {
    for await (const event of refused.generate({system: 'sys', messages: [{role: 'user', content: 'Read this', image}], schema: {}, maxOutputTokens: 20, signal: AbortSignal.timeout(1000)})) void event;
  }, (error: unknown) => (error as {message?: string}).message === CANT_READ_IMAGES);
  assert.equal(blind.images.length, 0);
  const automatic = createFakeCopilotRuntime({kind: 'ok', text: '{}'}, {signedIn: true}, [{id: 'auto', name: 'Auto', enabled: true, vision: true}]);
  const auto = createCopilotSdkProvider({runtime: automatic, model: 'auto'});
  await assert.rejects(async () => {
    for await (const event of auto.generate({system: 'sys', messages: [{role: 'user', content: 'Read this', image}], schema: {}, maxOutputTokens: 20, signal: AbortSignal.timeout(1000)})) void event;
  }, (error: unknown) => (error as {message?: string}).message === CANT_READ_IMAGES);
  assert.equal(automatic.prompts.length, 0);
});

test('an image becomes a confirmed Mermaid, then one chosen path, and Why stays put', async () => {
  const f = await authoringFixture();
  const workspace = await f.service.save({
    id: f.workspace.id, name: f.workspace.name, yaml: f.workspace.yaml, flows: {}, canvas: {screens: [], edges: [], paths: []},
    scenarios: [{id: 'guest', name: 'Guest checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    expectedRevision: f.workspace.metadata!.revision,
  });
  const knowledge = createKnowledgeService({root: f.root, queue: {enqueue() {}}, reconcileIntervalMs: 0});
  const seen: {system: string; content: string; image?: string}[] = [];
  let diagramCalls = 0;
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: () => {},
    readCatalog: async () => catalog(),
    readDiagram: (workspaceId, scenarioId) => knowledge.readDiagram(workspaceId, scenarioId),
    provider: createFakeProvider(({system, messages}): FakeResult => {
      const content = messages.map(message => message.content).join('\n');
      seen.push({system, content, image: messages.find(message => message.image)?.image?.data});
      if (system.startsWith('You read one TnT flow diagram.')) {
        diagramCalls += 1;
        if (diagramCalls === 1) return {kind: 'ok', text: JSON.stringify({mermaid: '', questions: [{key: 'arrow', text: 'Which way does Pay go?', options: ['Done', 'Error']}]})};
        return {kind: 'ok', text: JSON.stringify({mermaid: FLOW, questions: []})};
      }
      if (system.startsWith('You author')) return {kind: 'ok', text: JSON.stringify(exampleDraft)};
      return {kind: 'ok', text: JSON.stringify({intent: 'flow'})};
    }),
  });
  try {
    const asked = await settle(ai, (await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: '', image: {mimeType: 'image/png', data: PNG}})).id);
    assert.equal(asked.state, 'needsInfo');
    assert.equal(asked.intent, 'diagram');
    assert.equal(asked.questions?.[0]?.text, 'Which way does Pay go?');
    assert.equal(asked.diagramDraft, undefined);
    assert.equal(JSON.stringify(asked).includes(PNG), false);
    const ready = await settle(ai, (await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: 'Error', previousJobId: asked.id, answers: [{key: 'arrow', answer: 'Error'}]})).id);
    assert.equal(ready.state, 'pending');
    assert.equal(ready.intent, 'diagram');
    assert.equal(ready.diagramDraft?.paths.some(path => path.labels.includes('Error') && !path.labels.includes('Done')), true);
    assert.equal(ready.knowledgeDraft, undefined);
    await knowledge.saveContext(workspace.id, 'guest', {expectedContextRevision: 0, context: {purpose: 'Keep purpose', expectedOutcome: 'Keep outcome', rationale: 'Keep why', preconditions: '', exceptions: '', scope: ''}});
    const before = await knowledge.readContext(workspace.id, 'guest');
    const applied = await knowledge.applyDiagram(workspace.id, 'guest', {
      jobId: ready.id, expectedContextRevision: before.context.contextRevision, idempotencyKey: 'diagram-apply-1', mermaid: ready.diagramDraft!.mermaid, skill: 'diagram@1', skillHash: ready.skillHash,
    });
    assert.deepEqual(applied.followUp.options, ['Yes', 'Not now']);
    assert.equal(applied.followUp.options.some(option => option.includes('Done') || option.includes('Error')), false);
    assert.equal(applied.detail.context.rationale, 'Keep why');
    assert.equal(JSON.stringify(applied.detail).includes('flowchart'), false);
    const stored = await knowledge.readDiagram(workspace.id, 'guest');
    assert.equal(stored?.mermaid.includes('flowchart TD'), true);
    assert.equal(applied.receipt.previousDiagram, null);
    assert.equal(applied.receipt.skill, 'diagram@1');
    const callsBeforeAsk = seen.length;
    const ask = await settle(ai, (await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: CREATE_SCENARIO_PROMPT})).id);
    assert.equal(ask.state, 'needsInfo');
    assert.equal(ask.questions?.[0]?.text, 'Create a scenario from this diagram?');
    assert.deepEqual(ask.questions?.[0]?.options, ['Yes', 'Not now']);
    assert.equal(seen.length, callsBeforeAsk);
    const named = await settle(ai, (await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: 'Yes', previousJobId: ask.id, answers: [{key: 'create-scenario', answer: 'Yes'}]})).id);
    assert.equal(named.questions?.[0]?.text, 'Name the one path to author.');
    assert.deepEqual(named.questions?.[0]?.options, ['The path I named', 'Not now']);
    assert.equal(named.questions?.[0]?.options.some(option => option.includes('Done') || option.includes('Error')), false);
    const errorPath = stored!.paths.find(path => path.labels.includes('Error'));
    assert.ok(errorPath);
    const authored = await settle(ai, (await ai.start({
      workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: errorPath!.title, previousJobId: named.id,
      answers: [{key: 'which-path', answer: errorPath!.title}], authorPath: errorPath!.id,
    })).id);
    assert.equal(authored.state, 'pending');
    assert.equal(authored.kind, 'flow');
    assert.ok(authored.draft);
    const flowCall = seen.filter(item => item.system.startsWith('You author')).at(-1);
    assert.ok(flowCall);
    assert.equal(flowCall.content.includes('Error'), true);
    assert.equal(flowCall.content.includes('Done'), false);
    assert.equal(flowCall.image, undefined);
    const after = await knowledge.readContext(workspace.id, 'guest');
    assert.equal(after.context.rationale, 'Keep why');
    assert.equal(after.context.purpose, 'Keep purpose');
    await knowledge.undo(workspace.id, 'guest', {receiptId: applied.receipt.receiptId, expectedContextRevision: after.context.contextRevision});
    assert.equal(await knowledge.readDiagram(workspace.id, 'guest'), null);
  } finally {
    await ai.idle();
    knowledge.close();
    await f.cleanup();
  }
});

test('a provider that cannot read images does not get the picture', async () => {
  const f = await authoringFixture();
  const workspace = await f.service.save({
    id: f.workspace.id, name: f.workspace.name, yaml: f.workspace.yaml, flows: {}, canvas: {screens: [], edges: [], paths: []},
    scenarios: [{id: 'guest', name: 'Guest checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    expectedRevision: f.workspace.metadata!.revision,
  });
  let calls = 0;
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: () => {},
    readCatalog: async () => catalog(),
    provider: createFakeProvider(() => { calls += 1; return {kind: 'ok', text: '{}'}; }, {readsImages: false}),
  });
  try {
    const job = await settle(ai, (await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: '', image: {mimeType: 'image/png', data: PNG}})).id);
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.message, CANT_READ_IMAGES);
    assert.equal(calls, 0);
    await assert.rejects(() => ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: 'hello', image: {mimeType: 'image/webp', data: PNG}}), (error: unknown) => (error as {message?: string}).message === NOT_A_PNG_OR_JPEG);
  } finally {
    await ai.idle();
    await f.cleanup();
  }
});

test('pasted Mermaid skips the image and still asks before authoring', async () => {
  const f = await authoringFixture();
  const workspace = await f.service.save({
    id: f.workspace.id, name: f.workspace.name, yaml: f.workspace.yaml, flows: {}, canvas: {screens: [], edges: [], paths: []},
    scenarios: [{id: 'guest', name: 'Guest checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    expectedRevision: f.workspace.metadata!.revision,
  });
  const knowledge = createKnowledgeService({root: f.root, queue: {enqueue() {}}, reconcileIntervalMs: 0});
  let sawImage = false;
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets: memorySecrets(), log: () => {},
    readCatalog: async () => catalog(),
    readDiagram: (workspaceId, scenarioId) => knowledge.readDiagram(workspaceId, scenarioId),
    provider: createFakeProvider(({system, messages}) => {
      if (messages.some(message => message.image)) sawImage = true;
      if (system.startsWith('You read')) return {kind: 'ok', text: JSON.stringify({mermaid: FLOW, questions: []})};
      return {kind: 'ok', text: JSON.stringify(exampleDraft)};
    }),
  });
  try {
    const ready = await settle(ai, (await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: FLOW})).id);
    assert.equal(ready.state, 'pending');
    assert.equal(ready.intent, 'diagram');
    assert.equal(sawImage, false);
    assert.equal(ready.kind, 'diagram');
  } finally {
    await ai.idle();
    knowledge.close();
    await f.cleanup();
  }
});
