import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAi} from '../server/ai/index.js';
import {createFakeProvider} from '../server/ai/providers/fake.js';
import {createApiHandler} from '../server/http.js';
import {createKnowledgeService, RECEIPT_RETENTION_MS, UNDO_CLIENT_WINDOW_MS, type ContextContent} from '../server/knowledge/index.js';
import {loadSkill} from '../server/ai/skills.js';
import {createRunner} from '../server/runner.js';
import {createWorkspaceStore} from '../server/workspace-store.js';
import {authoringFixture} from './authoring-helpers.js';
import {scriptFixture} from './run-script-helpers.js';

const skill = loadSkill('knowledge-update');
const context: ContextContent = {purpose: 'Navigate Home', expectedOutcome: 'Home appears', rationale: 'Show the app entry', preconditions: 'App installed', exceptions: 'None specified', scope: 'Navigation'};

function applyBody(over: Partial<ContextContent> = {}, revision = 0, key = 'idem-apply-1') {
  return {jobId: randomUUID(), expectedContextRevision: revision, idempotencyKey: key, context: {...context, ...over}, skill: skill.id, skillHash: skill.hash};
}

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'tnt-knowledge-apply-'));
  const store = createWorkspaceStore(root, workspace => workspace);
  const workspace = await store.save({id: '', name: 'Knowledge apply', yaml: 'appId: example.App\n---\n- launchApp\n', scenarios: [{id: 'one', name: 'One', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}]});
  const knowledge = createKnowledgeService({root, store, queue: {enqueue() {}}, reconcileIntervalMs: 0});
  return {root, store, workspace, knowledge, async close() { knowledge.close(); }};
}

test('the server keeps receipts for 24 hours and leaves the 10 second undo window to the client', () => {
  assert.equal(UNDO_CLIENT_WINDOW_MS, 10_000);
  assert.ok(RECEIPT_RETENTION_MS > UNDO_CLIENT_WINDOW_MS);
  assert.equal(RECEIPT_RETENTION_MS, 24 * 60 * 60 * 1000);
});

test('apply writes a receipt of the previous sidecar and replays the same idempotency key', async () => {
  const f = await workspaceFixture();
  try {
    const first = await f.knowledge.applyDraft(f.workspace.id, 'one', applyBody({purpose: 'Applied purpose'}));
    assert.equal(first.receipt.origin, 'ai');
    assert.equal(first.receipt.skill, 'knowledge-update@1');
    assert.equal(first.receipt.previousSidecar, null);
    assert.equal(first.detail.context.purpose, 'Applied purpose');
    assert.equal(first.detail.context.contextRevision, 1);
    const sidecar = await readFile(join(f.root, 'workspaces', f.workspace.id, 'knowledge', 'scenarios', 'one.json'), 'utf8');
    assert.equal(sidecar.includes('"origin"'), false);
    assert.equal(sidecar.includes('"skill"'), false);
    const second = await f.knowledge.applyDraft(f.workspace.id, 'one', {...applyBody({purpose: 'Other purpose'}), idempotencyKey: first.receipt.idempotencyKey, jobId: first.receipt.jobId});
    assert.equal(second.receipt.receiptId, first.receipt.receiptId);
    assert.equal(second.detail.context.contextRevision, 1);
    assert.equal(second.detail.context.purpose, 'Applied purpose');
    const names = await readdir(join(f.root, 'workspaces', f.workspace.id, 'knowledge', 'receipts'));
    assert.equal(names.filter(name => name.endsWith('.json')).length, 1);
  } finally { await f.close(); }
});

test('a context revision conflict writes no receipt and no sidecar', async () => {
  const f = await workspaceFixture();
  try {
    const before = await f.knowledge.readContext(f.workspace.id, 'one');
    await assert.rejects(() => f.knowledge.applyDraft(f.workspace.id, 'one', applyBody({}, 3)), (error: unknown) => {
      const conflict = error as {code?: string; status?: number; currentContextRevision?: number};
      assert.equal(conflict.status, 409);
      assert.equal(conflict.code, 'CONTEXT_REVISION_CONFLICT');
      assert.equal(conflict.currentContextRevision, 0);
      return true;
    });
    const after = await f.knowledge.readContext(f.workspace.id, 'one');
    assert.equal(after.context.contextRevision, before.context.contextRevision);
    assert.equal(after.context.purpose, '');
    await assert.rejects(() => readdir(join(f.root, 'workspaces', f.workspace.id, 'knowledge', 'receipts')), (error: unknown) => (error as {code?: string}).code === 'ENOENT');
  } finally { await f.close(); }
});

test('undo restores the previous sidecar bytes, so a needs-review context stays needs review', async () => {
  const f = await workspaceFixture();
  try {
    const saved = await f.knowledge.saveContext(f.workspace.id, 'one', {expectedContextRevision: 0, context});
    assert.equal(saved.intentFreshness, 'reviewed');
    const current = await f.store.read(f.workspace.id);
    await f.store.save({...current, yaml: current.yaml.replace('example.App', 'example.Other')}, current.metadata!.revision);
    const stale = await f.knowledge.readContext(f.workspace.id, 'one');
    assert.equal(stale.intentFreshness, 'intent-needs-review');
    assert.equal(stale.freshness, 'needs-review');
    const previous = await readFile(join(f.root, 'workspaces', f.workspace.id, 'knowledge', 'scenarios', 'one.json'));
    const applied = await f.knowledge.applyDraft(f.workspace.id, 'one', applyBody({purpose: 'Applied over a stale review'}, stale.context.contextRevision, 'idem-undo-01'));
    const reviewed = await f.knowledge.readContext(f.workspace.id, 'one');
    assert.equal(reviewed.intentFreshness, 'reviewed');
    assert.notEqual(reviewed.context.reviewedAgainstSourceHash, stale.context.reviewedAgainstSourceHash);
    const restored = await f.knowledge.undo(f.workspace.id, 'one', {receiptId: applied.receipt.receiptId, expectedContextRevision: applied.detail.context.contextRevision});
    const bytes = await readFile(join(f.root, 'workspaces', f.workspace.id, 'knowledge', 'scenarios', 'one.json'));
    assert.equal(applied.receipt.previousSidecar, previous.toString('utf8'));
    assert.deepEqual(bytes, previous);
    assert.equal(restored.intentFreshness, 'intent-needs-review');
    assert.equal(restored.freshness, 'needs-review');
    assert.equal(restored.context.reviewedAgainstSourceHash, stale.context.reviewedAgainstSourceHash);
    const rewritten = await f.knowledge.saveContext(f.workspace.id, 'one', {expectedContextRevision: restored.context.contextRevision, context});
    assert.equal(rewritten.intentFreshness, 'reviewed');
    assert.notEqual(rewritten.context.reviewedAgainstSourceHash, restored.context.reviewedAgainstSourceHash);
  } finally { await f.close(); }
});

test('receipts older than the retention window are pruned', async () => {
  let clock = Date.parse('2026-11-10T00:00:00.000Z');
  const root = await mkdtemp(join(tmpdir(), 'tnt-knowledge-prune-'));
  const store = createWorkspaceStore(root, workspace => workspace);
  const workspace = await store.save({id: '', name: 'Prune', yaml: 'appId: example.App\n---\n- launchApp\n', scenarios: [{id: 'one', name: 'One', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}]});
  const knowledge = createKnowledgeService({root, store, queue: {enqueue() {}}, reconcileIntervalMs: 0, now: () => new Date(clock)});
  try {
    const applied = await knowledge.applyDraft(workspace.id, 'one', applyBody({purpose: 'Temporary'}, 0, 'idem-prune-1'));
    clock += RECEIPT_RETENTION_MS + 60_000;
    await assert.rejects(() => knowledge.undo(workspace.id, 'one', {receiptId: applied.receipt.receiptId, expectedContextRevision: 1}), (error: unknown) => (error as {code?: string; status?: number}).status === 404 && (error as {code?: string}).code === 'KNOWLEDGE_NOT_FOUND');
    const detail = await knowledge.readContext(workspace.id, 'one');
    assert.equal(detail.context.purpose, 'Temporary');
  } finally { knowledge.close(); }
});

test('KN-09: knowledge apply and undo preserve authored YAML, compiled output, script trust and the execution snapshot', async () => {
  const f = await scriptFixture();
  const knowledge = createKnowledgeService({root: f.root, queue: {enqueue() {}}, reconcileIntervalMs: 0});
  try {
    const path = join(f.root, 'workspaces', f.workspace.id, 'workspace.json');
    const recordBefore = await readFile(path);
    const before = await f.service.preview({...f.workspace, scenarioId: 'one'});
    const trust = await f.service.scriptTrust(f.workspace.id);
    const runBefore = await f.service.wait((await f.start()).id);
    assert.equal(runBefore.status, 'passed');
    const filesBefore = await readdir(join(f.root, 'runs', runBefore.id));
    const snapshotBefore = await readFile(join(f.root, 'runs', runBefore.id, 'snapshot.json'));
    const applied = await knowledge.applyDraft(f.workspace.id, 'one', applyBody({purpose: 'Applied purpose'}, 0, 'idem-kn09-01'));
    assert.equal(applied.detail.context.purpose, 'Applied purpose');
    assert.deepEqual(await readFile(path), recordBefore);
    assert.equal((await f.service.workspace(f.workspace.id)).yaml, f.workspace.yaml);
    assert.deepEqual(await f.service.preview({...f.workspace, scenarioId: 'one'}), before);
    assert.deepEqual(await f.service.scriptTrust(f.workspace.id), trust);
    assert.deepEqual(await readFile(join(f.root, 'runs', runBefore.id, 'snapshot.json')), snapshotBefore);
    assert.deepEqual(await readdir(join(f.root, 'runs', runBefore.id)), filesBefore);
    const restored = await knowledge.undo(f.workspace.id, 'one', {receiptId: applied.receipt.receiptId, expectedContextRevision: applied.detail.context.contextRevision});
    assert.equal(restored.context.contextRevision, 0);
    assert.deepEqual(await readFile(path), recordBefore);
    assert.deepEqual(await f.service.preview({...f.workspace, scenarioId: 'one'}), before);
    assert.deepEqual(await f.service.scriptTrust(f.workspace.id), trust);
    assert.deepEqual(await readFile(join(f.root, 'runs', runBefore.id, 'snapshot.json')), snapshotBefore);
    const runAfter = await f.service.wait((await f.start()).id);
    assert.equal(runAfter.snapshot.authoredYaml, runBefore.snapshot.authoredYaml);
    assert.equal(runAfter.snapshot.executionYaml, runBefore.snapshot.executionYaml);
  } finally { knowledge.close(); await f.cleanup(); }
});

test('RFC:55 an unapplied or dismissed knowledge draft is absent from the sidecar, HTML, and index', async () => {
  const f = await authoringFixture();
  const workspace = await f.service.save({
    id: f.workspace.id, name: f.workspace.name, yaml: f.workspace.yaml, flows: {}, canvas: {screens: [], edges: [], paths: []},
    scenarios: [{id: 'guest', name: 'Guest checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    expectedRevision: f.workspace.metadata!.revision,
  });
  const knowledge = createKnowledgeService({root: f.root, queue: {enqueue() {}}, reconcileIntervalMs: 0});
  const secrets = {async get() { return undefined; }, async set() {}, async delete() {}};
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets, log: () => {},
    readCatalog: async () => ({
      scenarios: [{id: 'guest', title: 'Guest checkout'}],
      current: {id: 'guest', title: 'Guest checkout', visitTitles: ['Home'], steps: [{text: '1 · Launch app'}], context: {purpose: '', expectedOutcome: '', rationale: '', preconditions: '', exceptions: '', scope: ''}, contextRevision: 0},
    }),
    provider: createFakeProvider(({system}) => {
      if (system.startsWith('You route')) return {kind: 'ok', text: JSON.stringify({intent: 'knowledge'})};
      return {kind: 'ok', text: JSON.stringify({purpose: 'UNAPPLIED_DRAFT_SENTINEL', expectedOutcome: '', rationale: '', preconditions: '', exceptions: '', scope: '', questions: [], conflicts: []})};
    }),
  });
  try {
    const started = await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: 'Set the purpose to UNAPPLIED_DRAFT_SENTINEL'});
    let job = await ai.get(started.id);
    for (let attempt = 0; attempt < 100 && job.state === 'running'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      job = await ai.get(started.id);
    }
    assert.equal(job.knowledgeDraft?.purpose, 'UNAPPLIED_DRAFT_SENTINEL');
    await ai.cancel(job.id);
    await assert.rejects(() => readFile(join(f.root, 'workspaces', workspace.id, 'knowledge', 'scenarios', 'guest.json'), 'utf8'), (error: unknown) => (error as {code?: string}).code === 'ENOENT');
    await knowledge.publish(workspace.id);
    const current = JSON.parse(await readFile(join(f.root, 'knowledge', 'current', `workspace-${workspace.id}.json`), 'utf8')) as {generationId: string};
    const generation = join(f.root, 'knowledge', 'generations', `workspace-${workspace.id}`, current.generationId);
    const html = await readFile(join(generation, 'index.html'), 'utf8');
    const page = await readFile(join(generation, 'workspaces', `${workspace.id}.html`), 'utf8');
    const index = await readFile(join(generation, 'index.jsonl'), 'utf8');
    const document = await readFile(join(generation, 'documents', 'guest.txt'), 'utf8');
    for (const body of [html, page, index, document]) assert.equal(body.includes('UNAPPLIED_DRAFT_SENTINEL'), false);
  } finally { knowledge.close(); await ai.idle(); await f.cleanup(); }
});

test('apply and undo HTTP routes keep no-store, idempotency, and revision conflicts', async () => {
  const f = await authoringFixture();
  const workspace = await f.service.save({
    id: f.workspace.id, name: f.workspace.name, yaml: f.workspace.yaml, flows: {}, canvas: {screens: [], edges: [], paths: []},
    scenarios: [{id: 'guest', name: 'Guest checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    expectedRevision: f.workspace.metadata!.revision,
  });
  const knowledge = createKnowledgeService({root: f.root, queue: {enqueue() {}}, reconcileIntervalMs: 0});
  const secrets = {async get() { return undefined; }, async set() {}, async delete() {}};
  const ai = createAi({
    root: f.root, authoring: f.service.authoring, readWorkspace: id => f.service.workspace(id), env: {}, secrets, log: () => {},
    readCatalog: async () => ({
      scenarios: [{id: 'guest', title: 'Guest checkout'}],
      current: {id: 'guest', title: 'Guest checkout', visitTitles: [], steps: [], context: {purpose: '', expectedOutcome: '', rationale: '', preconditions: '', exceptions: '', scope: ''}, contextRevision: 0},
    }),
    provider: createFakeProvider(({system}) => {
      if (system.startsWith('You route')) return {kind: 'ok', text: JSON.stringify({intent: 'knowledge'})};
      return {kind: 'ok', text: JSON.stringify({purpose: 'HTTP purpose', expectedOutcome: '', rationale: '', preconditions: '', exceptions: '', scope: '', questions: [], conflicts: []})};
    }),
  });
  const runner = createRunner({artifactDirectory: join(f.root, 'launches'), execute: async () => ({stdout: JSON.stringify({devices: {}}), stderr: ''})});
  const server = createServer(createApiHandler(runner, join(f.root, 'launches'), undefined, undefined, ai, knowledge));
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server');
    const base = `http://127.0.0.1:${address.port}`;
    const token = (await (await fetch(base + '/api/status')).json()).token as string;
    const started = await ai.start({workspaceId: workspace.id, expectedRevision: workspace.metadata!.revision, prompt: 'Set the purpose to HTTP purpose'});
    let job = await ai.get(started.id);
    for (let attempt = 0; attempt < 100 && job.state === 'running'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      job = await ai.get(started.id);
    }
    assert.equal(job.state, 'pending');
    const path = `/api/knowledge/workspaces/${workspace.id}/scenarios/guest`;
    const request = (url: string, method: string, body?: unknown) => fetch(base + url, {method, headers: {origin: base, 'x-tnt-token': token, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
    const method = await request(path + '/apply', 'GET');
    assert.equal(method.status, 405);
    const applied = await request(path + '/apply', 'POST', {jobId: job.id, expectedContextRevision: 0, idempotencyKey: 'idem-http-1'});
    assert.equal(applied.status, 200);
    assert.equal(applied.headers.get('cache-control'), 'no-store');
    const body = await applied.json();
    assert.equal(body.detail.context.purpose, 'HTTP purpose');
    assert.equal(body.receipt.origin, 'ai');
    assert.equal(body.receipt.skill, 'knowledge-update@1');
    const replay = await request(path + '/apply', 'POST', {jobId: job.id, expectedContextRevision: 0, idempotencyKey: 'idem-http-1'});
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).receipt.receiptId, body.receipt.receiptId);
    const conflict = await request(path + '/apply', 'POST', {jobId: job.id, expectedContextRevision: 0, idempotencyKey: 'idem-http-2'});
    assert.equal(conflict.status, 409);
    const rejected = await conflict.json();
    assert.equal(rejected.code, 'CONTEXT_REVISION_CONFLICT');
    assert.equal(rejected.currentContextRevision, 1);
    const undone = await request(path + '/undo', 'POST', {receiptId: body.receipt.receiptId, expectedContextRevision: 1});
    assert.equal(undone.status, 200);
    assert.equal(undone.headers.get('cache-control'), 'no-store');
    assert.equal((await undone.json()).context.contextRevision, 0);
  } finally {
    knowledge.close();
    await ai.idle();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});
