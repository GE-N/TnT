import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {referenceCatalog} from '../server/canvas.js';
import {projectCanvasRoute} from '../server/canvas-route.js';
import {AuthoringHttpError} from '../server/authoring/errors.js';
import {selectScenario} from '../server/scenario-definitions.js';
import {writeChecks} from '../shared/canvas-authoring.js';
import {createWriteFaults} from '../server/workspace-store.js';
import {deviceId} from './run-script-helpers.js';
import {authoringFixture, contentOf, exampleDraft, proofYaml} from './authoring-helpers.js';
import type {FlowDraft} from '../server/authoring/types.js';

function draft(): FlowDraft { return structuredClone(exampleDraft); }

async function openPreview(service: Awaited<ReturnType<typeof authoringFixture>>['service'], workspace: {id: string; metadata?: {revision: number}}, value: FlowDraft = draft()) {
  const revision = workspace.metadata?.revision ?? 0;
  const context = await service.authoring.context({workspaceId: workspace.id, expectedRevision: revision});
  const preview = await service.authoring.preview({workspaceId: workspace.id, expectedRevision: revision, contextId: context.contextId, draft: value});
  return {revision, preview};
}

function projection(workspace: Awaited<ReturnType<Awaited<ReturnType<typeof authoringFixture>>['service']['workspace']>>, scenarioId: string) {
  const selection = selectScenario(structuredClone(workspace), scenarioId, {}, []);
  if (!selection?.canvas || !selection.scenario.pathId) throw new Error('Missing canvas projection.');
  return projectCanvasRoute(selection.canvas, selection.yaml, workspace.flows ?? {}, selection.scenario.pathId, selection.automation).yaml;
}

async function trustState(root: string) {
  return JSON.parse(await readFile(join(root, 'trust', 'state.json'), 'utf8')) as {workspaces: Record<string, Record<string, {origin: string; approved?: string}>>};
}

test('apply adds one scenario, leaves other projections unchanged, and does not trust copied source', async () => {
  const f = await authoringFixture();
  try {
    const source = exampleDraft.scripts[0].source as string;
    const check = {id: 'seed-check', label: 'Visible text · Home', role: 'assertion' as const, scenarioIds: ['seed'], reference: {kind: 'step' as const, file: 'flow.yaml', index: 1, fingerprint: 'a'.repeat(64)}, check: {visibility: 'visible' as const, target: 'text' as const, match: 'exact' as const, value: 'Home'}};
    const graph = {screens: [{id: 'seed-screen', title: 'Seed', x: 40, y: 40, tests: [check]}], edges: [], paths: [{id: 'seed-path', name: 'Seed', scenarioId: 'seed', screenId: 'seed-screen', edgeIds: [], visits: [{id: 'seed-visit', operationIds: ['seed-check']}]}]};
    const yaml = writeChecks(proofYaml, {screens: [], edges: [], paths: []}, graph);
    const step = referenceCatalog(yaml).references.find(item => item.kind === 'step' && item.index === 1)!;
    check.reference = {kind: 'step', file: 'flow.yaml', index: step.index!, fingerprint: step.fingerprint};
    const seeded = await f.service.save({
      id: f.workspace.id, name: 'Authoring', expectedRevision: f.workspace.metadata!.revision, yaml, flows: {}, canvas: graph, scenarios: [{
        id: 'seed', name: 'Seed', authoring: 'canvas', pathId: 'seed-path', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: [],
        scripts: [{id: 'seed-script', label: 'Seed', source, beforeStep: {index: 0, fingerprint: step.fingerprint}}],
      }],
    });
    const before = projection(seeded, 'seed');
    const {revision, preview} = await openPreview(f.service, seeded);
    assert.equal(preview.applicable, true, preview.diagnostics.map(item => item.message).join('\n'));
    const applied = await f.service.authoring.apply({workspaceId: seeded.id, expectedRevision: revision, previewId: preview.previewId, idempotencyKey: 'once', acknowledgedAssumptionKeys: []});
    const saved = await f.service.workspace(seeded.id);
    assert.equal(saved.scenarios?.length, 2);
    assert.equal(saved.scenarios?.some(scenario => scenario.id === 'seed'), true);
    assert.equal(saved.scenarios?.some(scenario => scenario.id === applied.scenarioId), true);
    assert.equal(projection(saved, 'seed'), before);
    const trust = await f.service.scriptTrust(saved.id);
    const kept = trust.scripts.find(item => item.rowId === 'seed-script')!;
    const created = trust.scripts.find(item => item.rowId !== 'seed-script' && item.hash === kept.hash)!;
    assert.equal(kept.origin, 'local');
    assert.equal(kept.trusted, true);
    assert.equal(created.origin, 'imported');
    assert.equal(created.trusted, false);
    const replay = await f.service.authoring.apply({workspaceId: seeded.id, expectedRevision: revision, previewId: preview.previewId, idempotencyKey: 'once', acknowledgedAssumptionKeys: []});
    assert.equal(replay.revision, applied.revision);
    assert.equal(replay.scenarioId, applied.scenarioId);
    assert.equal((await f.service.workspace(seeded.id)).scenarios?.length, 2);
  } finally { await f.cleanup(); }
});

test('stale revisions, conflicting keys and a second preview key cannot overwrite or duplicate', async () => {
  const f = await authoringFixture();
  try {
    const first = await openPreview(f.service, f.workspace);
    await assert.rejects(() => f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: 0, previewId: first.preview.previewId, idempotencyKey: 'k', acknowledgedAssumptionKeys: []}), (error: unknown) => { assert.equal((error as AuthoringHttpError).code, 'REVISION_CONFLICT'); return true; });
    assert.equal((await f.service.workspace(f.workspace.id)).scenarios?.length ?? 0, 0);
    const applied = await f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: first.revision, previewId: first.preview.previewId, idempotencyKey: 'k', acknowledgedAssumptionKeys: []});
    const other = draft();
    other.name = 'Another journey';
    const second = await openPreview(f.service, await f.service.workspace(f.workspace.id), other);
    await assert.rejects(() => f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: second.revision, previewId: second.preview.previewId, idempotencyKey: 'k', acknowledgedAssumptionKeys: []}), (error: unknown) => { assert.equal((error as AuthoringHttpError).code, 'IDEMPOTENCY_CONFLICT'); return true; });
    await assert.rejects(() => f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: applied.revision, previewId: first.preview.previewId, idempotencyKey: 'other-key', acknowledgedAssumptionKeys: []}), (error: unknown) => { assert.equal((error as AuthoringHttpError).code, 'PREVIEW_STALE'); return true; });
    const renamed = await f.service.renameWorkspace(f.workspace.id, 'Renamed', applied.revision);
    await assert.rejects(() => f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: renamed.metadata!.revision, previewId: second.preview.previewId, idempotencyKey: 'fresh', acknowledgedAssumptionKeys: []}), (error: unknown) => { assert.equal((error as AuthoringHttpError).code, 'PREVIEW_STALE'); return true; });
    assert.equal((await f.service.workspace(f.workspace.id)).scenarios?.length, 1);
  } finally { await f.cleanup(); }
});

test('apply is refused while a run is active', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await authoringFixture({run: async ({signal}) => { await gate; signal.throwIfAborted?.(); return {code: 0, log: 'done', cleanup: {verified: true, detail: 'exited'}}; }});
  try {
    const refs = await f.service.references({yaml: proofYaml});
    const step = refs.references.find(item => item.kind === 'step')!;
    const busy = await f.service.save({name: 'Busy', yaml: proofYaml, scenarios: [{id: 'busy', name: 'Busy', steps: [{kind: 'step', file: 'flow.yaml', index: step.index, fingerprint: step.fingerprint}], inputs: {}, parameters: {}, enabledHandlerIds: []}]});
    const opened = await openPreview(f.service, busy);
    const run = await f.service.start({workspaceId: busy.id, deviceId, scenarioId: 'busy'});
    try {
      await assert.rejects(() => f.service.authoring.apply({workspaceId: busy.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'busy', acknowledgedAssumptionKeys: []}), (error: unknown) => { assert.equal((error as AuthoringHttpError).status, 409); assert.equal((error as AuthoringHttpError).code, 'WORKSPACE_BUSY'); return true; });
      assert.equal((await f.service.workspace(busy.id)).scenarios?.length, 1);
    } finally { release(); await f.service.cancel(run.id); }
  } finally { await f.cleanup(); }
});

test('crashes after trust registration and after publication recover as one untrusted scenario', async () => {
  const faults = createWriteFaults();
  const f = await authoringFixture({faults: faults.faults});
  try {
    const opened = await openPreview(f.service, f.workspace);
    faults.failBeforeRename();
    await assert.rejects(() => f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'crash', acknowledgedAssumptionKeys: []}), /Injected failure before rename/);
    const partial = await trustState(f.root);
    const rows = partial.workspaces[f.workspace.id];
    assert.ok(rows && Object.values(rows).every(row => row.origin === 'imported' && row.approved === undefined));
    assert.equal((await f.service.workspace(f.workspace.id)).metadata?.revision, opened.revision);
    faults.pass();
    const recovered = await f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'crash', acknowledgedAssumptionKeys: []});
    const saved = await f.service.workspace(f.workspace.id);
    assert.equal(saved.scenarios?.length, 1);
    assert.equal(saved.scenarios![0].id, recovered.scenarioId);
    const trust = await f.service.scriptTrust(saved.id);
    assert.equal(trust.scripts.length, 3);
    assert.equal(trust.scripts.every(item => item.origin === 'imported' && item.trusted === false), true);
  } finally { await f.cleanup(); }

  const published = createWriteFaults();
  const again = await authoringFixture({faults: published.faults});
  try {
    const opened = await openPreview(again.service, again.workspace);
    again.service.authoring.faults.afterPublish = () => { throw new Error('crash after publication'); };
    await assert.rejects(() => again.service.authoring.apply({workspaceId: again.workspace.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'published', acknowledgedAssumptionKeys: []}), /crash after publication/);
    const {createScenarios} = await import('../server/scenarios.js');
    const {createRunner} = await import('../server/runner.js');
    const runner = createRunner({artifactDirectory: again.root, execute: async () => { throw new Error('no execution'); }});
    const resumed = createScenarios({root: again.root, trustDirectory: join(again.root, 'trust'), faults: published.faults, runner, maestro: {version: async () => '2.11.0', run: async () => { throw new Error('no execution'); }}});
    const receipt = await resumed.authoring.apply({workspaceId: again.workspace.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'published', acknowledgedAssumptionKeys: []});
    const saved = await resumed.workspace(again.workspace.id);
    assert.equal(saved.scenarios?.length, 1);
    assert.equal(receipt.scenarioId, saved.scenarios![0].id);
    assert.equal(receipt.authoring, 'external');
    const duplicate = await again.service.authoring.apply({workspaceId: again.workspace.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'published', acknowledgedAssumptionKeys: []});
    assert.equal(duplicate.scenarioId, receipt.scenarioId);
    assert.equal((await resumed.workspace(again.workspace.id)).scenarios?.length, 1);
  } finally { await again.cleanup(); }
});

test('undo restores the pre-apply workspace byte-for-byte and removes imported trust', async () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const f = await authoringFixture({now: () => new Date(clock)});
  try {
    const before = await f.service.workspace(f.workspace.id);
    const opened = await openPreview(f.service, before);
    const applied = await f.service.authoring.apply({workspaceId: before.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'undo-me', acknowledgedAssumptionKeys: []}, undefined, {authoring: 'ai'});
    assert.equal(applied.authoring, 'ai');
    const created = (await f.service.scriptTrust(before.id)).scripts.map(item => item.rowId);
    assert.equal(created.length, 3);
    const undone = await f.service.authoring.undo({workspaceId: before.id, expectedRevision: applied.revision, receiptId: (await journalId(f.root))});
    const restored = await f.service.workspace(before.id);
    assert.deepEqual(contentOf(restored), contentOf(before));
    assert.ok((restored.metadata?.revision ?? 0) > applied.revision);
    const state = await trustState(f.root);
    for (const id of created) assert.equal(state.workspaces[before.id]?.[id], undefined);
    const replay = await f.service.authoring.apply({workspaceId: before.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'undo-me', acknowledgedAssumptionKeys: []}, undefined, {authoring: 'ai'});
    assert.equal(replay.scenarioId, applied.scenarioId);
    assert.equal((await f.service.workspace(before.id)).scenarios?.length ?? 0, 0);
    await assert.rejects(() => f.service.authoring.undo({workspaceId: before.id, expectedRevision: undone.revision, receiptId: undone.receiptId}), (error: unknown) => { assert.equal((error as AuthoringHttpError).status, 409); return true; });
    clock += 8 * 24 * 60 * 60 * 1000;
    await assert.rejects(() => f.service.authoring.apply({workspaceId: before.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'undo-me', acknowledgedAssumptionKeys: []}, undefined, {authoring: 'ai'}), (error: unknown) => { assert.equal((error as AuthoringHttpError).code, 'IDEMPOTENCY_EXPIRED'); return true; });
  } finally { await f.cleanup(); }
});

test('mixed legacy YAML is refused', async () => {
  const f = await authoringFixture({yaml: 'appId: com.example.TnTProof\n---\n- launchApp\n- tapOn: Go\n'});
  try {
    const opened = await openPreview(f.service, f.workspace);
    assert.equal(opened.preview.applicable, false);
    assert.equal(opened.preview.diagnostics.some(item => item.code === 'UNSUPPORTED_SHARED_YAML'), true);
    await assert.rejects(() => f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'legacy', acknowledgedAssumptionKeys: []}), (error: unknown) => {
      const rejected = error as AuthoringHttpError;
      assert.equal(rejected.status, 422);
      assert.equal(rejected.diagnostics?.some(item => item.code === 'UNSUPPORTED_SHARED_YAML'), true);
      return true;
    });
    assert.equal((await f.service.workspace(f.workspace.id)).scenarios?.length ?? 0, 0);
  } finally { await f.cleanup(); }
});

async function journalId(root: string) {
  const {readdir} = await import('node:fs/promises');
  const names = (await readdir(join(root, '.tnt', 'authoring-journal'))).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1);
  return names[0].replace(/\.json$/, '');
}
