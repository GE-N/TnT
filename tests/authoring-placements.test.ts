import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {AuthoringHttpError} from '../server/authoring/errors.js';
import {digest} from '../server/authoring/hash.js';
import type {FlowDraft} from '../server/authoring/types.js';
import {authoringFixture, contentOf, exampleDraft, proofYaml} from './authoring-helpers.js';

type Fixture = Awaited<ReturnType<typeof authoringFixture>>;
type Screen = {id: string; title: string; x: number; y: number; tests: []};

function journey(): FlowDraft {
  const value = structuredClone(exampleDraft) as FlowDraft;
  value.scripts = [];
  value.name = 'Placed journey';
  return value;
}

function singleScreen(): FlowDraft {
  return {
    schemaVersion: 1,
    mode: 'createScenario',
    name: 'Single screen',
    appId: 'com.example.TnTProof',
    parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [{key: 'home', kind: 'create', title: 'Home'}],
    visits: [{
      key: 'homeVisit',
      screenKey: 'home',
      operations: [{key: 'seeHome', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Home'}}}],
    }],
    scripts: [],
    assumptions: [],
  };
}

/** Screens straddling every packer cell, so an unplaced create has nowhere to land. */
function blockingScreens(): Screen[] {
  const screens: Screen[] = [];
  for (const y of [41, 401, 761, 1121]) {
    for (const x of [41, 561, 1081, 1601, 2121]) screens.push({id: `block-${x}-${y}`, title: `Block ${x} ${y}`, x, y, tests: []});
  }
  return screens;
}

async function seed(f: Fixture, screens: Screen[]) {
  return f.service.save({
    id: f.workspace.id, name: 'Authoring', expectedRevision: f.workspace.metadata!.revision, yaml: proofYaml, flows: {},
    canvas: {screens, edges: [], paths: []}, scenarios: [],
  });
}

async function preview(f: Fixture, workspace: {id: string; metadata?: {revision?: number}}, draft: FlowDraft, placements?: unknown) {
  const revision = workspace.metadata?.revision ?? 0;
  const context = await f.service.authoring.context({workspaceId: workspace.id, expectedRevision: revision});
  const body: Record<string, unknown> = {workspaceId: workspace.id, expectedRevision: revision, contextId: context.contextId, draft};
  const keys = ['workspaceId', 'expectedRevision', 'contextId', 'draft'];
  if (placements !== undefined) {
    body.placements = placements;
    keys.push('placements');
  }
  return {revision, preview: await f.service.authoring.preview(body, keys)};
}

function at(workspace: {canvas?: {screens: {title: string; x: number; y: number}[]} | null}, title: string) {
  const screen = workspace.canvas?.screens.find(item => item.title === title);
  assert.ok(screen, title);
  return {x: screen.x, y: screen.y};
}

async function journalId(root: string) {
  const names = (await readdir(join(root, '.tnt', 'authoring-journal'))).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1);
  return names[0].replace(/\.json$/, '');
}

test('apply puts every create screen on its clamped placement and leaves existing screens', async () => {
  const f = await authoringFixture();
  try {
    const seeded = await seed(f, [{id: 'seed-screen', title: 'Seed', x: 512, y: 640, tests: []}]);
    const before = await f.service.workspace(seeded.id);
    const draft = journey();
    const raw = {home: {x: -0.6, y: 10.4}, details: {x: 2400.6, y: 1399.6}};
    const normalized = {home: {x: 0, y: 10}, details: {x: 2400, y: 1400}};
    const opened = await preview(f, seeded, draft, raw);
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    assert.equal('placements' in opened.preview, false);
    assert.equal(opened.preview.draftHash, digest({draft, placements: normalized}));
    assert.notEqual(opened.preview.draftHash, digest(draft));
    const again = await preview(f, seeded, draft, {details: {x: 2400, y: 1400}, home: {x: 0, y: 10}});
    assert.equal(again.preview.draftHash, opened.preview.draftHash);
    const shifted = await preview(f, seeded, draft, {home: {x: 1, y: 10}, details: {x: 2400, y: 1400}});
    assert.notEqual(shifted.preview.draftHash, opened.preview.draftHash);
    await assert.rejects(() => f.service.authoring.apply({
      workspaceId: seeded.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'placed', acknowledgedAssumptionKeys: [], placements: raw,
    }, ['workspaceId', 'expectedRevision', 'previewId', 'idempotencyKey', 'acknowledgedAssumptionKeys', 'placements']), (error: unknown) => {
      assert.equal((error as AuthoringHttpError).status, 400);
      assert.equal((error as AuthoringHttpError).code, 'INVALID_ENVELOPE');
      return true;
    });
    const applied = await f.service.authoring.apply({workspaceId: seeded.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'placed', acknowledgedAssumptionKeys: []});
    const saved = await f.service.workspace(seeded.id);
    assert.deepEqual(at(saved, 'Home'), normalized.home);
    assert.deepEqual(at(saved, 'Details'), normalized.details);
    assert.deepEqual(at(saved, 'Seed'), {x: 512, y: 640});
    const undone = await f.service.authoring.undo({workspaceId: seeded.id, expectedRevision: applied.revision, receiptId: await journalId(f.root)});
    const restored = await f.service.workspace(seeded.id);
    assert.deepEqual(contentOf(restored), contentOf(before));
    assert.equal(undone.undone, true);
    assert.equal(restored.canvas?.screens.length, 1);
  } finally { await f.cleanup(); }
});

test('partial placements pack the remaining screens around placed points and existing screens', async () => {
  const f = await authoringFixture();
  try {
    const seeded = await seed(f, [{id: 'seed-screen', title: 'Seed', x: 300, y: 40, tests: []}]);
    const draft = journey();
    const opened = await preview(f, seeded, draft, {details: {x: 39.6, y: 40.2}});
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    assert.equal(opened.preview.draftHash, digest({draft, placements: {details: {x: 40, y: 40}}}));
    await f.service.authoring.apply({workspaceId: seeded.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'partial', acknowledgedAssumptionKeys: []});
    const saved = await f.service.workspace(seeded.id);
    assert.deepEqual(at(saved, 'Details'), {x: 40, y: 40});
    assert.deepEqual(at(saved, 'Home'), {x: 560, y: 40});
    assert.deepEqual(at(saved, 'Seed'), {x: 300, y: 40});
  } finally { await f.cleanup(); }
});

test('bad placements are rejected with 400 and leave the workspace untouched', async () => {
  const f = await authoringFixture();
  try {
    const seeded = await seed(f, [{id: 'seed-screen', title: 'Seed', x: 40, y: 40, tests: []}]);
    const before = contentOf(await f.service.workspace(seeded.id));
    const draft = journey();
    draft.screens = [{key: 'seed', kind: 'existing', screenId: 'seed-screen'}, ...draft.screens];
    const cases = [
      {nope: {x: 1, y: 1}},
      {seed: {x: 1, y: 1}},
      {home: {x: Number.NaN, y: 1}},
      {home: {x: Number.POSITIVE_INFINITY, y: 1}},
      {home: {x: '12', y: 1}},
      {home: {x: 1, y: 2, z: 3}},
      {home: {x: 1, y: 1}, details: {x: 2, y: 2}, extra: {x: 3, y: 3}},
      [{x: 1, y: 1}],
      null,
    ];
    for (const placements of cases) {
      await assert.rejects(() => preview(f, seeded, draft, placements), (error: unknown) => {
        assert.equal((error as AuthoringHttpError).status, 400);
        assert.equal((error as AuthoringHttpError).code, 'INVALID_ENVELOPE');
        assert.notEqual((error as AuthoringHttpError).message, 'Unknown authoring request field.');
        return true;
      });
    }
    assert.deepEqual(contentOf(await f.service.workspace(seeded.id)), before);
    const clean = journey();
    const opened = await preview(f, seeded, clean);
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    assert.equal((await f.service.workspace(seeded.id)).scenarios?.length ?? 0, 0);
  } finally { await f.cleanup(); }
});

test('omitted placements keep the fixed grid and the draft-only hash', async () => {
  const f = await authoringFixture();
  try {
    const draft = journey();
    const opened = await preview(f, f.workspace, draft);
    const empty = await preview(f, f.workspace, draft, {});
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    assert.equal(opened.preview.draftHash, digest(draft));
    assert.equal(empty.preview.draftHash, opened.preview.draftHash);
    await f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'grid', acknowledgedAssumptionKeys: []});
    const saved = await f.service.workspace(f.workspace.id);
    assert.deepEqual(at(saved, 'Home'), {x: 40, y: 40});
    assert.deepEqual(at(saved, 'Details'), {x: 300, y: 40});
  } finally { await f.cleanup(); }
});

test('a full grid still rejects an unplaced screen and accepts one with a placement', async () => {
  const f = await authoringFixture();
  try {
    const blockers = blockingScreens();
    const seeded = await seed(f, blockers);
    const draft = singleScreen();
    const blocked = await preview(f, seeded, draft);
    assert.equal(blocked.preview.applicable, false);
    assert.equal(blocked.preview.diagnostics.some(item => item.code === 'CAPACITY_EXCEEDED'), true);
    await assert.rejects(() => f.service.authoring.apply({workspaceId: seeded.id, expectedRevision: blocked.revision, previewId: blocked.preview.previewId, idempotencyKey: 'full', acknowledgedAssumptionKeys: []}), (error: unknown) => {
      assert.equal((error as AuthoringHttpError).status, 422);
      return true;
    });
    assert.equal((await f.service.workspace(seeded.id)).canvas?.screens.length, blockers.length);
    const opened = await preview(f, seeded, draft, {home: {x: 10.2, y: -4}});
    assert.equal(opened.preview.applicable, true, opened.preview.diagnostics.map(item => item.message).join('\n'));
    await f.service.authoring.apply({workspaceId: seeded.id, expectedRevision: opened.revision, previewId: opened.preview.previewId, idempotencyKey: 'full-placed', acknowledgedAssumptionKeys: []});
    const saved = await f.service.workspace(seeded.id);
    assert.deepEqual(at(saved, 'Home'), {x: 10, y: 0});
    for (const blocker of blockers) assert.deepEqual(at(saved, blocker.title), {x: blocker.x, y: blocker.y});
  } finally { await f.cleanup(); }
});
