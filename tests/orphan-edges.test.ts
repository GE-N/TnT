import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {referenceCatalog} from '../server/canvas.js';
import type {DraftOperation, FlowDraft} from '../server/authoring/types.js';
import type {CanvasGraph} from '../server/canvas.js';
import {writeChecks} from '../shared/canvas-authoring.js';
import {authoringFixture, proofYaml} from './authoring-helpers.js';

const reference = {kind: 'step' as const, file: 'flow.yaml', index: 0, fingerprint: 'a'.repeat(64)};

function see(key: string, value: string): DraftOperation {
  return {key, kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'id', match: 'exact', value}}};
}

function go(key: string, value: string, visitKey: string): DraftOperation {
  return {key, kind: 'tap', target: {kind: 'selector', selector: {target: 'id', match: 'exact', value}}, destination: {kind: 'visit', visitKey}};
}

function flow(name: string, screens: FlowDraft['screens'], visits: FlowDraft['visits']): FlowDraft {
  return {
    schemaVersion: 1, mode: 'createScenario', name, appId: 'com.example.TnTProof', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}}, screens, visits, scripts: [], assumptions: [],
  };
}

test('loading a workspace with an edge to a missing screen keeps the file open and the next save drops that edge', async () => {
  const f = await authoringFixture();
  try {
    const graph: CanvasGraph = {
      screens: [
        {id: 'home', title: 'Home', x: 40, y: 40, tests: [{id: 'stay', label: 'Home', role: 'assertion', reference, check: {visibility: 'visible', target: 'text', match: 'exact', value: 'Home'}}]},
        {id: 'details', title: 'Details', x: 400, y: 40, tests: [{id: 'arrived', label: 'Details', role: 'assertion', reference, check: {visibility: 'visible', target: 'text', match: 'exact', value: 'Details'}}]},
      ],
      edges: [{id: 'kept', from: 'home', to: 'details', actionTestId: 'stay', assertionTestId: 'arrived', responseCondition: 'Home → Details'}],
      paths: [{id: 'route', name: 'Home', scenarioId: 'main', screenId: 'home', edgeIds: ['kept'], visits: [{id: 'first', operationIds: ['stay']}, {id: 'second', operationIds: ['arrived']}]}],
    };
    const saved = await f.service.save({
      id: f.workspace.id, name: 'Authoring', expectedRevision: f.workspace.metadata!.revision, yaml: proofYaml, flows: {}, canvas: graph,
      scenarios: [{id: 'main', name: 'Main', authoring: 'canvas', pathId: 'route', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    });
    const file = join(f.root, 'workspaces', saved.id, 'workspace.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.canvas.edges.push({id: 'gone', from: 'home', to: 'ghost', actionTestId: 'stay', assertionTestId: 'pending:gone', responseCondition: 'Home → Ghost'});
    await writeFile(file, JSON.stringify(raw));
    const loaded = await f.service.workspace(saved.id);
    assert.deepEqual(loaded.canvas!.edges.map(edge => edge.id), ['kept']);
    assert.deepEqual(loaded.canvas!.screens.map(screen => screen.id), ['home', 'details']);
    const stored = await f.service.save({
      id: loaded.id, name: loaded.name, expectedRevision: loaded.metadata!.revision, yaml: loaded.yaml, flows: loaded.flows ?? {}, canvas: loaded.canvas, scenarios: loaded.scenarios,
    });
    assert.deepEqual(stored.canvas!.edges.map(edge => edge.id), ['kept']);
    const rewritten = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(rewritten.canvas.edges.map((edge: {id: string}) => edge.id), ['kept']);
    assert.equal(rewritten.canvas.edges.some((edge: {to: string}) => edge.to === 'ghost'), false);
  } finally { await f.cleanup(); }
});

test('replacing a scenario, including the apply Versions Restore uses, drops an edge whose screen was removed', async () => {
  const f = await authoringFixture();
  try {
    const anchor = {id: 'anchor-check', label: 'Anchor', role: 'assertion' as const, scenarioIds: ['manual'], reference, check: {visibility: 'visible' as const, target: 'text' as const, match: 'exact' as const, value: 'Anchor'}};
    const graph: CanvasGraph = {
      screens: [{id: 'anchor', title: 'Anchor', x: 40, y: 40, tests: [anchor]}],
      edges: [],
      paths: [{id: 'manual-path', name: 'Manual', scenarioId: 'manual', screenId: 'anchor', edgeIds: [], visits: [{id: 'manual-visit', operationIds: ['anchor-check']}]}],
    };
    const yaml = writeChecks(proofYaml, {screens: [], edges: [], paths: []}, graph);
    const step = referenceCatalog(yaml).references.find(item => item.kind === 'step' && item.index === 1)!;
    anchor.reference = {kind: 'step', file: 'flow.yaml', index: step.index!, fingerprint: step.fingerprint};
    const seeded = await f.service.save({
      id: f.workspace.id, name: 'Authoring', expectedRevision: f.workspace.metadata!.revision, yaml, flows: {}, canvas: graph,
      scenarios: [{id: 'manual', name: 'Manual', steps: [{kind: 'step', file: 'flow.yaml', index: step.index!, fingerprint: step.fingerprint}], inputs: {}, parameters: {}, enabledHandlerIds: []}],
    });
    const createdDraft = flow('Flow A', [
      {key: 'anchor', kind: 'existing', screenId: 'anchor'},
      {key: 'side', kind: 'create', title: 'Side'},
    ], [
      {key: 'visitAnchor', screenKey: 'anchor', operations: [see('seeAnchor', 'anchor-title'), go('leave', 'leave-anchor', 'visitSide')]},
      {key: 'visitSide', screenKey: 'side', operations: [see('seeSide', 'side-title')]},
    ]);
    const context = await f.service.authoring.context({workspaceId: seeded.id, expectedRevision: seeded.metadata!.revision});
    const created = await f.service.authoring.preview({workspaceId: seeded.id, expectedRevision: seeded.metadata!.revision, contextId: context.contextId, draft: createdDraft}, ['workspaceId', 'expectedRevision', 'contextId', 'draft']);
    assert.equal(created.applicable, true, created.diagnostics.map(item => item.message).join('\n'));
    const applied = await f.service.authoring.apply({workspaceId: seeded.id, expectedRevision: seeded.metadata!.revision, previewId: created.previewId, idempotencyKey: 'flow-a', acknowledgedAssumptionKeys: []});
    const ready = await f.service.workspace(seeded.id);
    const side = ready.canvas!.screens.find(screen => screen.title === 'Side')!;
    const home = ready.canvas!.screens.find(screen => screen.id === 'anchor')!;
    const kept = {id: 'kept-link', from: 'anchor', to: 'anchor', actionTestId: 'anchor-check', assertionTestId: 'anchor-check', responseCondition: 'Stay on Anchor'};
    const dangling = {id: 'off-path', from: side.id, to: home.id, actionTestId: side.tests[0]!.id, actionTestIds: [side.tests[0]!.id], assertionTestId: 'pending:off-path', responseCondition: 'Side → Anchor'};
    const withBranch = await f.service.save({
      id: ready.id, name: ready.name, expectedRevision: ready.metadata!.revision, yaml: ready.yaml, flows: ready.flows ?? {},
      canvas: {...ready.canvas!, edges: [...ready.canvas!.edges, kept, dangling]}, scenarios: ready.scenarios,
    });
    assert.equal(withBranch.canvas!.edges.some(edge => edge.id === 'off-path'), true);
    const replacement = flow('Restored', [
      {key: 'anchor', kind: 'existing', screenId: 'anchor'},
    ], [
      {key: 'stay', screenKey: 'anchor', operations: [see('seeAnchor', 'anchor-after')]},
    ]);
    const again = await f.service.authoring.context({workspaceId: withBranch.id, expectedRevision: withBranch.metadata!.revision});
    const preview = await f.service.authoring.preview({
      workspaceId: withBranch.id, expectedRevision: withBranch.metadata!.revision, contextId: again.contextId, draft: replacement, replaceScenarioId: applied.scenarioId,
    }, ['workspaceId', 'expectedRevision', 'contextId', 'draft', 'replaceScenarioId']);
    assert.equal(preview.applicable, true, preview.diagnostics.map(item => item.message).join('\n'));
    await f.service.authoring.apply({workspaceId: withBranch.id, expectedRevision: withBranch.metadata!.revision, previewId: preview.previewId, idempotencyKey: 'restore', acknowledgedAssumptionKeys: []});
    const restored = await f.service.workspace(withBranch.id);
    const ids = new Set(restored.canvas!.screens.map(screen => screen.id));
    assert.equal(restored.canvas!.screens.some(screen => screen.id === side.id), false);
    assert.equal(ids.has('anchor'), true);
    assert.equal(restored.canvas!.edges.some(edge => edge.id === 'off-path'), false);
    assert.equal(restored.canvas!.edges.some(edge => edge.from === side.id || edge.to === side.id), false);
    assert.equal(restored.canvas!.edges.some(edge => edge.id === 'kept-link'), true);
    assert.equal(restored.canvas!.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to)), false);
  } finally { await f.cleanup(); }
});
