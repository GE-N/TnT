import assert from 'node:assert/strict';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {referenceCatalog} from '../server/canvas.js';
import {AuthoringHttpError} from '../server/authoring/errors.js';
import {digest} from '../server/authoring/hash.js';
import type {DraftOperation, FlowDraft} from '../server/authoring/types.js';
import {createRunner} from '../server/runner.js';
import {createScenarios} from '../server/scenarios.js';
import {createWriteFaults} from '../server/workspace-store.js';
import {writeChecks} from '../shared/canvas-authoring.js';
import {authoringFixture, contentOf, exampleDraft, proofYaml} from './authoring-helpers.js';

type Fixture = Awaited<ReturnType<typeof authoringFixture>>;
type Workspace = Awaited<ReturnType<Fixture['service']['workspace']>>;

function draft(): FlowDraft {
  return structuredClone(exampleDraft) as FlowDraft;
}

function see(key: string, value: string): DraftOperation {
  return {key, kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'id', match: 'exact', value}}};
}

function go(key: string, value: string, visitKey: string): DraftOperation {
  return {key, kind: 'tap', target: {kind: 'selector', selector: {target: 'id', match: 'exact', value}}, destination: {kind: 'visit', visitKey}};
}

function endScript(key: string, source: string): FlowDraft['scripts'][number] {
  return {key, label: key, language: 'maestro-javascript', source, placement: {kind: 'scenarioEnd'}, requires: {parameters: [], mockSession: false}};
}

function flow(name: string, screens: FlowDraft['screens'], visits: FlowDraft['visits'], scripts: FlowDraft['scripts'] = []): FlowDraft {
  return {
    schemaVersion: 1, mode: 'createScenario', name, appId: 'com.example.TnTProof', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}}, screens, visits, scripts, assumptions: [],
  };
}

async function openPreview(f: Fixture, workspace: {id: string; metadata?: {revision?: number}}, value: FlowDraft, extra?: {replaceScenarioId?: unknown; placements?: unknown}) {
  const revision = workspace.metadata?.revision ?? 0;
  const context = await f.service.authoring.context({workspaceId: workspace.id, expectedRevision: revision});
  const body: Record<string, unknown> = {workspaceId: workspace.id, expectedRevision: revision, contextId: context.contextId, draft: value};
  const keys = ['workspaceId', 'expectedRevision', 'contextId', 'draft'];
  if (extra && 'placements' in extra) {
    body.placements = extra.placements;
    keys.push('placements');
  }
  if (extra && 'replaceScenarioId' in extra) {
    body.replaceScenarioId = extra.replaceScenarioId;
    keys.push('replaceScenarioId');
  }
  return {revision, preview: await f.service.authoring.preview(body, keys)};
}

function apply(f: Fixture, workspaceId: string, revision: number, previewId: string, idempotencyKey: string) {
  return f.service.authoring.apply({workspaceId, expectedRevision: revision, previewId, idempotencyKey, acknowledgedAssumptionKeys: []});
}

function at(workspace: Workspace, title: string) {
  const screen = workspace.canvas?.screens.find(item => item.title === title);
  assert.ok(screen, title);
  return screen;
}

type JournalRecord = {
  id: string;
  status: string;
  previewId: string;
  publishedRevision?: number;
  receipt?: {workspaceId: string; revision: number; scenarioId: string; pathId: string};
  intended: {scenarioId: string; pathId: string};
};

async function journalEntry(root: string, previewId: string) {
  const directory = join(root, '.tnt', 'authoring-journal');
  const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
  for (const name of names) {
    const entry = JSON.parse(await readFile(join(directory, name), 'utf8')) as JournalRecord;
    if (entry.previewId === previewId) return entry;
  }
  throw new Error(`Missing journal entry for ${previewId}.`);
}

async function reopenAsIntent(root: string, previewId: string) {
  const entry = await journalEntry(root, previewId);
  const {publishedRevision, receipt, ...intent} = entry;
  void publishedRevision;
  void receipt;
  await writeFile(join(root, '.tnt', 'authoring-journal', `${entry.id}.json`), JSON.stringify({...intent, status: 'intent'}));
}

function restartAuthoring(root: string) {
  const runner = createRunner({artifactDirectory: root, execute: async () => { throw new Error('no execution'); }});
  return createScenarios({
    root, trustDirectory: join(root, 'trust'), runner,
    maestro: {version: async () => '2.11.0', run: async () => { throw new Error('no execution'); }},
  });
}

function shorter(): FlowDraft {
  const value = flow('Shorter flow', [{key: 'only', kind: 'create', title: 'Only'}], [{
    key: 'onlyVisit', screenKey: 'only', operations: [see('seeOnly', 'only-title')],
  }], [endScript('finish', 'output.tntExample = "finished";')]);
  value.parameters = [{name: 'CODE', type: 'text', required: false}];
  return value;
}

test('replaceScenarioId overwrites that canvas scenario in place', async () => {
  const f = await authoringFixture();
  try {
    const created = await openPreview(f, f.workspace, draft());
    assert.equal(created.preview.applicable, true, created.preview.diagnostics.map(item => item.message).join('\n'));
    assert.equal(created.preview.draftHash, digest(draft()));
    assert.deepEqual(created.preview.changes.updated, []);
    assert.equal(created.preview.changes.created[0]?.kind, 'scenario');
    const applied = await apply(f, f.workspace.id, created.revision, created.preview.previewId, 'create-a');
    const original = await f.service.workspace(f.workspace.id);
    assert.equal(original.scenarios?.length, 1);
    const scenarioId = applied.scenarioId;
    assert.equal(original.scenarios?.[0].id, scenarioId);
    const oldPathId = original.scenarios?.[0].pathId;
    const withPreference = await f.service.save({
      id: original.id, name: original.name, expectedRevision: original.metadata!.revision, yaml: original.yaml, flows: original.flows ?? {}, canvas: original.canvas,
      scenarios: original.scenarios?.map(scenario => scenario.id === scenarioId ? {...scenario, skipInRunAll: true, inputs: {CODE: 'kept-value', GONE: 'drop-me'}} : scenario),
    });
    const next = shorter();
    const plain = await openPreview(f, withPreference, next);
    const opened = await openPreview(f, withPreference, next, {replaceScenarioId: scenarioId});
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    assert.equal(plain.preview.draftHash, digest(next));
    assert.equal(opened.preview.draftHash, digest({draft: next, replaceScenarioId: scenarioId}));
    assert.notEqual(opened.preview.draftHash, plain.preview.draftHash);
    assert.equal('replaceScenarioId' in opened.preview, false);
    assert.deepEqual(opened.preview.changes.updated, [{kind: 'scenario', id: scenarioId}]);
    assert.equal(opened.preview.changes.created.some(item => item.kind === 'scenario'), false);
    assert.equal(opened.preview.changes.created.some(item => item.kind === 'path'), true);
    const replaced = await apply(f, f.workspace.id, opened.revision, opened.preview.previewId, 'replace-b');
    const saved = await f.service.workspace(f.workspace.id);
    assert.equal(saved.scenarios?.length, 1);
    assert.equal(saved.scenarios?.[0].id, scenarioId);
    assert.equal(saved.scenarios?.[0].name, 'Shorter flow');
    assert.equal(saved.scenarios?.[0].skipInRunAll, true);
    assert.deepEqual(saved.scenarios?.[0].inputs, {CODE: 'kept-value'});
    assert.equal(replaced.scenarioId, scenarioId);
    assert.equal(replaced.pathId, saved.scenarios?.[0].pathId);
    assert.notEqual(saved.scenarios?.[0].pathId, oldPathId);
    assert.equal(saved.canvas?.paths.some(path => path.id === oldPathId), false);
    assert.equal(saved.canvas?.screens.some(screen => screen.title === 'Home'), false);
    assert.equal(at(saved, 'Only').title, 'Only');
    const trust = await f.service.scriptTrust(saved.id);
    assert.equal(trust.scripts.length, 1);
    assert.equal(trust.scripts[0].origin, 'imported');
    assert.equal(trust.scripts[0].trusted, false);
    const replay = await apply(f, f.workspace.id, opened.revision, opened.preview.previewId, 'replace-b');
    assert.equal(replay.scenarioId, scenarioId);
    assert.equal(replay.revision, replaced.revision);
    assert.equal((await f.service.workspace(f.workspace.id)).scenarios?.length, 1);
  } finally { await f.cleanup(); }
});

test('replace drops orphan screens and keeps shared and existing screens where they are', async () => {
  const f = await authoringFixture();
  try {
    const check = {id: 'shared-check', label: 'Visible text · Shared', role: 'assertion' as const, scenarioIds: ['manual'], reference: {kind: 'step' as const, file: 'flow.yaml', index: 1, fingerprint: 'a'.repeat(64)}, check: {visibility: 'visible' as const, target: 'text' as const, match: 'exact' as const, value: 'Shared'}};
    const graph = {screens: [{id: 'shared', title: 'Shared', x: 40, y: 40, tests: [check]}], edges: [], paths: [{id: 'manual-path', name: 'Manual', scenarioId: 'manual', screenId: 'shared', edgeIds: [], visits: [{id: 'manual-visit', operationIds: ['shared-check']}]}]};
    const yaml = writeChecks(proofYaml, {screens: [], edges: [], paths: []}, graph);
    const step = referenceCatalog(yaml).references.find(item => item.kind === 'step' && item.index === 1)!;
    check.reference = {kind: 'step', file: 'flow.yaml', index: step.index!, fingerprint: step.fingerprint};
    const seeded = await f.service.save({
      id: f.workspace.id, name: 'Authoring', expectedRevision: f.workspace.metadata!.revision, yaml, flows: {}, canvas: graph,
      scenarios: [{id: 'manual', name: 'Manual', steps: [{kind: 'step', file: 'flow.yaml', index: step.index!, fingerprint: step.fingerprint}], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    });
    const first = flow('Flow A', [
      {key: 'shared', kind: 'existing', screenId: 'shared'},
      {key: 'kept', kind: 'create', title: 'Kept'},
      {key: 'orphan', kind: 'create', title: 'Orphan'},
    ], [
      {key: 'visitShared', screenKey: 'shared', operations: [see('seeShared', 'shared-by-a'), go('leaveShared', 'leave-shared', 'visitKept')]},
      {key: 'visitKept', screenKey: 'kept', operations: [see('seeKept', 'kept-title'), go('leaveKept', 'leave-kept', 'visitOrphan')]},
      {key: 'visitOrphan', screenKey: 'orphan', operations: [see('seeOrphan', 'orphan-title')]},
    ]);
    const created = await openPreview(f, seeded, first);
    assert.equal(created.preview.applicable, true, created.preview.diagnostics.map(item => item.message).join('\n'));
    const applied = await apply(f, seeded.id, created.revision, created.preview.previewId, 'flow-a');
    const ready = await f.service.workspace(seeded.id);
    const kept = at(ready, 'Kept');
    const shared = at(ready, 'Shared');
    assert.deepEqual({x: shared.x, y: shared.y}, {x: 40, y: 40});
    assert.deepEqual({x: kept.x, y: kept.y}, {x: 300, y: 40});
    assert.equal(ready.scenarios?.map(scenario => scenario.id).join(','), `manual,${applied.scenarioId}`);
    const second = flow('Flow B', [
      {key: 'kept', kind: 'existing', screenId: kept.id},
      {key: 'pinned', kind: 'create', title: 'Pinned'},
      {key: 'packed', kind: 'create', title: 'Packed'},
    ], [
      {key: 'visitKept', screenKey: 'kept', operations: [see('seeKept', 'kept-after'), go('leaveKept', 'leave-kept-b', 'visitPinned')]},
      {key: 'visitPinned', screenKey: 'pinned', operations: [see('seePinned', 'pinned-title'), go('leavePinned', 'leave-pinned', 'visitPacked')]},
      {key: 'visitPacked', screenKey: 'packed', operations: [see('seePacked', 'packed-title')]},
    ]);
    const placements = {pinned: {x: 1000, y: 500}};
    const opened = await openPreview(f, ready, second, {replaceScenarioId: applied.scenarioId, placements});
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    assert.equal(opened.preview.draftHash, digest({draft: second, placements, replaceScenarioId: applied.scenarioId}));
    assert.equal(opened.preview.changes.reused.some(item => item.kind === 'screen' && item.id === kept.id), true);
    await apply(f, seeded.id, opened.revision, opened.preview.previewId, 'flow-b');
    const saved = await f.service.workspace(seeded.id);
    assert.equal(saved.scenarios?.length, 2);
    assert.deepEqual(saved.scenarios?.map(scenario => scenario.id), ['manual', applied.scenarioId]);
    assert.equal(saved.scenarios?.filter(scenario => scenario.authoring === 'canvas').length, 1);
    assert.equal(saved.scenarios?.[1].name, 'Flow B');
    assert.equal(saved.canvas?.paths.find(path => path.id === saved.scenarios?.[1].pathId)?.visits?.length, 3);
    assert.equal(saved.canvas?.screens.some(screen => screen.title === 'Orphan'), false);
    assert.equal(saved.canvas?.screens.some(screen => screen.id === 'shared'), true);
    assert.deepEqual({x: at(saved, 'Shared').x, y: at(saved, 'Shared').y}, {x: 40, y: 40});
    assert.equal(at(saved, 'Shared').tests.some(item => item.id === 'shared-check'), true);
    assert.deepEqual({x: at(saved, 'Kept').x, y: at(saved, 'Kept').y}, {x: kept.x, y: kept.y});
    assert.equal(at(saved, 'Kept').id, kept.id);
    assert.deepEqual({x: at(saved, 'Pinned').x, y: at(saved, 'Pinned').y}, placements.pinned);
    assert.deepEqual({x: at(saved, 'Packed').x, y: at(saved, 'Packed').y}, {x: 560, y: 40});
    assert.equal(saved.yaml.includes('orphan-title'), false);
    assert.equal(saved.yaml.includes('pinned-title'), true);
    assert.equal(saved.scenarios?.[0].name, 'Manual');
  } finally { await f.cleanup(); }
});

test('undo of a replace restores the previous flow and its trusted scripts', async () => {
  const f = await authoringFixture();
  try {
    const created = await openPreview(f, f.workspace, draft());
    const applied = await apply(f, f.workspace.id, created.revision, created.preview.previewId, 'create-a');
    const trusted = await f.service.scriptTrust(f.workspace.id);
    assert.equal(trusted.scripts.length, 3);
    for (const row of trusted.scripts) {
      assert.equal(row.origin, 'imported');
      await f.service.trustScript({workspace: f.workspace.id, rowId: row.rowId, hash: row.hash});
    }
    const before = await f.service.workspace(f.workspace.id);
    const next = shorter();
    const opened = await openPreview(f, before, next, {replaceScenarioId: applied.scenarioId});
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    const replaced = await apply(f, f.workspace.id, opened.revision, opened.preview.previewId, 'replace-b');
    const during = await f.service.scriptTrust(f.workspace.id);
    assert.equal(during.scripts.length, 1);
    assert.equal(during.scripts[0].origin, 'imported');
    assert.equal(during.scripts[0].trusted, false);
    assert.equal(trusted.scripts.some(row => row.rowId === during.scripts[0].rowId), false);
    const entry = await journalEntry(f.root, opened.preview.previewId);
    const undone = await f.service.authoring.undo({workspaceId: f.workspace.id, expectedRevision: replaced.revision, receiptId: entry.id});
    const restored = await f.service.workspace(f.workspace.id);
    assert.equal(undone.undone, true);
    assert.equal(undone.scenarioId, applied.scenarioId);
    assert.deepEqual(contentOf(restored), contentOf(before));
    assert.ok((restored.metadata?.revision ?? 0) > replaced.revision);
    const after = await f.service.scriptTrust(f.workspace.id);
    assert.equal(after.scripts.length, 3);
    for (const row of trusted.scripts) {
      const current = after.scripts.find(item => item.rowId === row.rowId);
      assert.ok(current);
      assert.equal(current.origin, 'imported');
      assert.equal(current.trusted, true);
    }
    const state = JSON.parse(await readFile(join(f.root, 'trust', 'state.json'), 'utf8')) as {workspaces: Record<string, Record<string, {origin: string}>>};
    assert.equal(state.workspaces[f.workspace.id]?.[during.scripts[0].rowId], undefined);
  } finally { await f.cleanup(); }
});

test('unknown or non-canvas replaceScenarioId is 400 and a moved workspace rejects the preview', async () => {
  const f = await authoringFixture();
  try {
    const step = referenceCatalog(proofYaml).references.find(item => item.kind === 'step')!;
    const seeded = await f.service.save({
      id: f.workspace.id, name: 'Authoring', expectedRevision: f.workspace.metadata!.revision, yaml: proofYaml, flows: {}, canvas: {screens: [], edges: [], paths: []},
      scenarios: [
        {id: 'manual', name: 'Manual', steps: [{kind: 'step', file: 'flow.yaml', index: step.index!, fingerprint: step.fingerprint}], inputs: {}, parameters: {}, enabledHandlerIds: []},
        {id: 'bare', name: 'Bare', authoring: 'canvas' as const, steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []},
      ],
    });
    const before = contentOf(await f.service.workspace(seeded.id));
    const value = draft();
    for (const [replaceScenarioId, message] of [
      ['missing-scenario', 'replaceScenarioId does not name a scenario in this workspace.'],
      ['manual', 'replaceScenarioId must name a canvas scenario with a path.'],
      ['bare', 'replaceScenarioId must name a canvas scenario with a path.'],
      ['', 'Provide a replaceScenarioId.'],
    ] as const) {
      await assert.rejects(() => openPreview(f, seeded, value, {replaceScenarioId}), (error: unknown) => {
        assert.equal((error as AuthoringHttpError).status, 400);
        assert.equal((error as AuthoringHttpError).code, 'INVALID_ENVELOPE');
        assert.equal((error as AuthoringHttpError).message, message);
        return true;
      });
    }
    assert.deepEqual(contentOf(await f.service.workspace(seeded.id)), before);
    const created = await openPreview(f, seeded, value);
    const applied = await apply(f, seeded.id, created.revision, created.preview.previewId, 'create-a');
    const current = await f.service.workspace(seeded.id);
    const opened = await openPreview(f, current, shorter(), {replaceScenarioId: applied.scenarioId});
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    const renamed = await f.service.renameWorkspace(seeded.id, 'Renamed', current.metadata!.revision);
    await assert.rejects(() => apply(f, seeded.id, opened.revision, opened.preview.previewId, 'stale-old'), (error: unknown) => {
      assert.equal((error as AuthoringHttpError).code, 'REVISION_CONFLICT');
      return true;
    });
    await assert.rejects(() => apply(f, seeded.id, renamed.metadata!.revision, opened.preview.previewId, 'stale-new'), (error: unknown) => {
      assert.equal((error as AuthoringHttpError).code, 'PREVIEW_STALE');
      return true;
    });
    const saved = await f.service.workspace(seeded.id);
    assert.equal(saved.scenarios?.length, 3);
    assert.equal(saved.scenarios?.find(scenario => scenario.id === applied.scenarioId)?.name, draft().name);
  } finally { await f.cleanup(); }
});

test('resume of a replace does not treat the existing scenario id as already published', async () => {
  const faults = createWriteFaults();
  const f = await authoringFixture({faults: faults.faults});
  try {
    const created = await openPreview(f, f.workspace, draft());
    const applied = await apply(f, f.workspace.id, created.revision, created.preview.previewId, 'create-a');
    const current = await f.service.workspace(f.workspace.id);
    const opened = await openPreview(f, current, shorter(), {replaceScenarioId: applied.scenarioId});
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    faults.failBeforeRename();
    await assert.rejects(() => apply(f, f.workspace.id, opened.revision, opened.preview.previewId, 'replace-b'), /Injected failure before rename/);
    const during = await f.service.workspace(f.workspace.id);
    assert.equal(during.scenarios?.[0].id, applied.scenarioId);
    assert.equal(during.scenarios?.[0].name, draft().name);
    assert.equal(during.metadata?.revision, current.metadata?.revision);
    faults.pass();
    const recovered = await apply(f, f.workspace.id, opened.revision, opened.preview.previewId, 'replace-b');
    const saved = await f.service.workspace(f.workspace.id);
    assert.equal(saved.scenarios?.length, 1);
    assert.equal(saved.scenarios?.[0].id, applied.scenarioId);
    assert.equal(saved.scenarios?.[0].name, 'Shorter flow');
    assert.equal(recovered.scenarioId, applied.scenarioId);
    assert.equal(recovered.pathId, saved.scenarios?.[0].pathId);
  } finally { await f.cleanup(); }
});

test('restart reconcile publishes a saved replace intent and still commits a create whose scenario exists', async () => {
  const faults = createWriteFaults();
  const f = await authoringFixture({faults: faults.faults});
  try {
    const created = await openPreview(f, f.workspace, draft());
    const applied = await apply(f, f.workspace.id, created.revision, created.preview.previewId, 'create-a');
    const scenarioId = applied.scenarioId;
    await reopenAsIntent(f.root, created.preview.previewId);
    const current = await f.service.workspace(f.workspace.id);
    assert.equal(current.scenarios?.[0].id, scenarioId);
    assert.equal(current.scenarios?.[0].name, draft().name);
    const opened = await openPreview(f, current, shorter(), {replaceScenarioId: scenarioId});
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    faults.failBeforeRename();
    await assert.rejects(() => apply(f, f.workspace.id, opened.revision, opened.preview.previewId, 'replace-b'), /Injected failure before rename/);
    const during = await f.service.workspace(f.workspace.id);
    assert.equal(during.scenarios?.[0].id, scenarioId);
    assert.equal(during.scenarios?.[0].name, draft().name);
    assert.equal(during.metadata?.revision, current.metadata?.revision);
    assert.equal((await journalEntry(f.root, opened.preview.previewId)).status, 'intent');
    faults.pass();

    const resumed = restartAuthoring(f.root);
    await assert.rejects(() => resumed.authoring.undo(null));
    const createEntry = await journalEntry(f.root, created.preview.previewId);
    assert.equal(createEntry.status, 'committed');
    assert.equal(createEntry.receipt?.scenarioId, scenarioId);
    assert.equal(createEntry.receipt?.revision, during.metadata?.revision);
    const kept = await resumed.workspace(f.workspace.id);
    assert.equal(kept.scenarios?.[0].name, draft().name);
    assert.equal(kept.metadata?.revision, during.metadata?.revision);
    const createReceipt = await resumed.authoring.apply({workspaceId: f.workspace.id, expectedRevision: created.revision, previewId: created.preview.previewId, idempotencyKey: 'create-a', acknowledgedAssumptionKeys: []});
    assert.equal(createReceipt.scenarioId, scenarioId);
    assert.equal(createReceipt.revision, createEntry.receipt?.revision);
    assert.equal(createReceipt.pathId, createEntry.receipt?.pathId);
    assert.equal((await resumed.workspace(f.workspace.id)).metadata?.revision, during.metadata?.revision);

    assert.equal((await journalEntry(f.root, opened.preview.previewId)).status, 'intent');
    const recovered = await resumed.authoring.apply({workspaceId: f.workspace.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'replace-b', acknowledgedAssumptionKeys: []});
    const saved = await resumed.workspace(f.workspace.id);
    assert.equal(saved.scenarios?.length, 1);
    assert.equal(saved.scenarios?.[0].id, scenarioId);
    assert.equal(saved.scenarios?.[0].name, 'Shorter flow');
    assert.equal(recovered.scenarioId, scenarioId);
    assert.equal(recovered.pathId, saved.scenarios?.[0].pathId);
    assert.equal(recovered.revision, saved.metadata?.revision);
    assert.equal(recovered.workspaceId, saved.id);
    const replay = await resumed.authoring.apply({workspaceId: f.workspace.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'replace-b', acknowledgedAssumptionKeys: []});
    assert.deepEqual(replay, recovered);
  } finally { await f.cleanup(); }
});
