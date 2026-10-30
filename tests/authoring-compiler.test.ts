import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canvasOperationFingerprints} from '../server/run-script-plan.js';
import {AuthoringHttpError} from '../server/authoring/errors.js';
import {decodeAuthoringJson} from '../server/authoring/schema.js';
import {REQUEST_LIMIT} from '../server/authoring/types.js';
import type {FlowDraft} from '../server/authoring/types.js';
import {authoringFixture, exampleDraft} from './authoring-helpers.js';

function draft(): FlowDraft {
  return structuredClone(exampleDraft);
}

async function previewOf(service: Awaited<ReturnType<typeof authoringFixture>>['service'], workspace: {id: string; metadata?: {revision: number}}, value: unknown) {
  const revision = workspace.metadata?.revision ?? 0;
  const context = await service.authoring.context({workspaceId: workspace.id, expectedRevision: revision});
  return service.authoring.preview({workspaceId: workspace.id, expectedRevision: revision, contextId: context.contextId, draft: value});
}

function codes(preview: {diagnostics: {code: string}[]}) {
  return new Set(preview.diagnostics.map(item => item.code));
}

test('the supplied example yields five authored ordinals and script rows at [1, 1, 5]', async () => {
  const f = await authoringFixture();
  try {
    const value = draft();
    const preview = await previewOf(f.service, f.workspace, value);
    assert.equal(preview.applicable, true);
    assert.equal(preview.authoringComplete, true);
    assert.equal(preview.runReadiness, 'blocked');
    assert.deepEqual(preview.timeline.filter(item => item.kind === 'uiOperation').map(item => item.kind === 'uiOperation' ? item.ordinal : -1), [0, 1, 2, 3, 4]);
    const scripts = preview.timeline.filter(item => item.kind === 'runScript');
    assert.deepEqual(scripts.map(item => item.kind === 'runScript' ? item.anchorOrdinal : -1), [1, 1, 5]);
    assert.deepEqual(scripts.map(item => item.kind === 'runScript' ? item.atEnd : false), [false, false, true]);
    assert.equal(scripts.every(item => item.kind === 'runScript' && item.trust === 'required'), true);
    assert.equal(codes(preview).has('UNVERIFIED_SELECTOR'), true);
    assert.equal(codes(preview).has('SCRIPT_TRUST_REQUIRED'), true);
    assert.equal(preview.timeline.some(item => item.kind === 'system' && item.label === 'Launch app'), true);
    const applied = await f.service.authoring.apply({workspaceId: f.workspace.id, expectedRevision: f.workspace.metadata!.revision, previewId: preview.previewId, idempotencyKey: 'example', acknowledgedAssumptionKeys: []});
    const saved = await f.service.workspace(f.workspace.id);
    assert.equal(saved.scenarios?.length, 1);
    const scenario = saved.scenarios![0];
    assert.equal(scenario.id, applied.scenarioId);
    assert.deepEqual(scenario.scripts?.map(row => row.beforeStep.index), [1, 1, 5]);
    assert.deepEqual(scenario.scripts?.map(row => row.source), value.scripts.map(script => script.source));
    const fingerprints = canvasOperationFingerprints(saved.canvas!, scenario.pathId!);
    assert.equal(fingerprints.length, 5);
    assert.equal(scenario.scripts![2].beforeStep.fingerprint, fingerprints[4] + ':end');
    assert.equal(scenario.scripts![0].beforeStep.fingerprint, fingerprints[1]);
    assert.equal(saved.yaml.includes('runScript'), false);
    const home = saved.canvas!.screens.find(screen => screen.title === 'Home')!;
    const checks = home.tests.filter(test => test.check?.value === 'home-title');
    assert.equal(checks.length, 2);
    assert.notEqual(checks[0].id, checks[1].id);
    assert.deepEqual(scenario.scripts!.slice(0, 2).map(row => row.beforeStep.index), [1, 1]);
    assert.deepEqual(scenario.scripts!.slice(0, 2).map(row => row.label), ['Initialize script state', 'Check prepared script state']);
  } finally { await f.cleanup(); }
});

test('setup and handlers do not shift authored ordinals', async () => {
  const f = await authoringFixture();
  try {
    const flow = 'appId: com.example.TnTProof\n---\n- launchApp\n';
    const workspace = await f.service.save({
      id: f.workspace.id, name: 'Authoring', expectedRevision: f.workspace.metadata!.revision, yaml: flow, flows: {'setup.yaml': flow},
      canvas: f.workspace.canvas, scenarios: [],
      automation: {setup: {file: 'setup.yaml', parameters: {}}, actions: [{id: 'dismiss', name: 'Dismiss', file: 'setup.yaml', parameters: {}, enabled: false, condition: {id: 'banner'}}], checkpoints: []},
    });
    const value = draft();
    value.execution = {setup: {kind: 'context', ref: 'setup-1'}, handlerRefs: ['dismiss'], mock: {kind: 'none'}};
    const preview = await previewOf(f.service, workspace, value);
    assert.equal(preview.applicable, true, preview.diagnostics.map(item => item.code + ' ' + item.message).join('\n'));
    assert.deepEqual(preview.timeline.filter(item => item.kind === 'uiOperation').map(item => item.kind === 'uiOperation' ? item.ordinal : -1), [0, 1, 2, 3, 4]);
    assert.deepEqual(preview.timeline.filter(item => item.kind === 'runScript').map(item => item.kind === 'runScript' ? item.anchorOrdinal : -1), [1, 1, 5]);
    assert.equal(preview.timeline.some(item => item.kind === 'system' && item.label === 'Setup · setup.yaml'), true);
    assert.equal(preview.timeline.some(item => item.kind === 'system' && item.label === 'Handler · dismiss'), true);
  } finally { await f.cleanup(); }
});

test('unknown and deleted script anchors fail', async () => {
  const f = await authoringFixture();
  try {
    const missing = draft();
    missing.scripts[0].placement = {kind: 'beforeOperation', visitKey: 'homeFirst', operationKey: 'missing'};
    const unknown = await previewOf(f.service, f.workspace, missing);
    assert.equal(unknown.applicable, false);
    assert.equal(codes(unknown).has('UNKNOWN_SCRIPT_ANCHOR'), true);
    const otherVisit = draft();
    otherVisit.scripts[0].placement = {kind: 'beforeOperation', visitKey: 'detailsVisit', operationKey: 'openDetails'};
    const deleted = await previewOf(f.service, f.workspace, otherVisit);
    assert.equal(deleted.applicable, false);
    assert.equal(codes(deleted).has('UNKNOWN_SCRIPT_ANCHOR'), true);
  } finally { await f.cleanup(); }
});

test('every contract diagnostic code is produced by a fixture', async () => {
  const f = await authoringFixture();
  try {
    const seen = new Set<string>();
    const expectCode = async (value: unknown, code: string) => {
      const preview = await previewOf(f.service, await f.service.workspace(f.workspace.id), value);
      assert.equal(codes(preview).has(code), true, preview.diagnostics.map(item => item.code + ' ' + item.message).join('\n'));
      seen.add(code);
      return preview;
    };
    const unresolved = draft();
    (unresolved.visits[0].operations[1] as {target: unknown}).target = {kind: 'unresolved', description: 'the details control'};
    await expectCode(unresolved, 'UNRESOLVED_TARGET');
    const transition = draft();
    (transition.visits[0].operations[1] as {destination: unknown}).destination = {kind: 'stay'};
    await expectCode(transition, 'INVALID_TRANSITION');
    const anchor = draft();
    anchor.scripts[0].placement = {kind: 'beforeOperation', visitKey: 'homeReturn', operationKey: 'openDetails'};
    await expectCode(anchor, 'UNKNOWN_SCRIPT_ANCHOR');
    const syntax = draft();
    syntax.scripts[0].source = 'function (';
    await expectCode(syntax, 'SCRIPT_SYNTAX');
    const trusted = await previewOf(f.service, f.workspace, draft());
    assert.equal(codes(trusted).has('SCRIPT_TRUST_REQUIRED'), true);
    seen.add('SCRIPT_TRUST_REQUIRED');
    const mock = draft();
    mock.scripts[0].requires.mockSession = true;
    await expectCode(mock, 'MOCK_REQUIRED');
    const missing = draft();
    missing.visits[0].operations.splice(1, 0, {key: 'typeQuery', kind: 'input', value: {kind: 'parameter', name: 'QUERY'}});
    (missing.visits[0].operations[2] as {destination: {kind: string}}).destination = {kind: 'stay'};
    await expectCode(missing, 'MISSING_PARAMETER_DECLARATION');
    const runtime = draft();
    runtime.scripts = [];
    runtime.parameters = [{name: 'USER_ID', type: 'text', required: true}];
    const runtimePreview = await expectCode(runtime, 'RUNTIME_INPUT_REQUIRED');
    assert.equal(runtimePreview.runReadiness, 'requires-preflight');
    const noChecks = draft();
    noChecks.screens = [{key: 'home', kind: 'create', title: 'Home'}];
    noChecks.visits = [{key: 'only', screenKey: 'home', operations: [{key: 'press', kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Go'}}, destination: {kind: 'stay'}}]}];
    noChecks.scripts = [];
    const assertions = await expectCode(noChecks, 'NO_UI_ASSERTIONS');
    assert.equal(assertions.applicable, true);
    assert.equal(assertions.diagnostics.find(item => item.code === 'NO_UI_ASSERTIONS')?.blocks.length, 0);
    const unverified = await previewOf(f.service, await f.service.workspace(f.workspace.id), draft());
    assert.equal(codes(unverified).has('UNVERIFIED_SELECTOR'), true);
    seen.add('UNVERIFIED_SELECTOR');
    const legacy = await authoringFixture({yaml: 'appId: com.example.TnTProof\n---\n- launchApp\n- tapOn: Go\n'});
    try {
      const shared = await previewOf(legacy.service, legacy.workspace, draft());
      assert.equal(codes(shared).has('UNSUPPORTED_SHARED_YAML'), true);
      assert.equal(shared.applicable, false);
      seen.add('UNSUPPORTED_SHARED_YAML');
    } finally { await legacy.cleanup(); }
    const automated = await f.service.save({
      id: f.workspace.id, name: 'Authoring', expectedRevision: (await f.service.workspace(f.workspace.id)).metadata!.revision,
      yaml: 'appId: com.example.TnTProof\n---\n- launchApp\n', flows: {'setup.yaml': 'appId: com.example.TnTProof\n---\n- launchApp\n'}, canvas: {screens: [], edges: [], paths: []}, scenarios: [],
      automation: {setup: {file: 'setup.yaml', parameters: {}}, actions: [], checkpoints: []},
    });
    const conflictPreview = await previewOf(f.service, automated, draft());
    assert.equal(codes(conflictPreview).has('SHARED_EXECUTION_CONFLICT'), true);
    seen.add('SHARED_EXECUTION_CONFLICT');
    const clean = await f.service.save({
      id: f.workspace.id, name: 'Authoring', expectedRevision: automated.metadata!.revision,
      yaml: 'appId: com.example.TnTProof\n---\n- launchApp\n', flows: {}, canvas: {screens: [], edges: [], paths: []}, scenarios: [],
    });
    const emptyFinal = draft();
    emptyFinal.screens = [{key: 'home', kind: 'create', title: 'Home'}];
    emptyFinal.visits = [{key: 'only', screenKey: 'home', operations: []}];
    emptyFinal.scripts = [emptyFinal.scripts[2]];
    const unverifiedDestination = await previewOf(f.service, clean, emptyFinal);
    assert.equal(unverifiedDestination.applicable, true, unverifiedDestination.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'));
    assert.equal(codes(unverifiedDestination).has('DESTINATION_UNVERIFIED'), true);
    const applied = await f.service.authoring.apply({workspaceId: clean.id, expectedRevision: clean.metadata!.revision, previewId: unverifiedDestination.previewId, idempotencyKey: 'empty-final', acknowledgedAssumptionKeys: []});
    const saved = await f.service.workspace(automated.id);
    assert.equal(saved.scenarios!.find(scenario => scenario.id === applied.scenarioId)!.scripts![0].beforeStep.fingerprint, 'end');
    const empty = draft();
    empty.visits = [{key: 'only', screenKey: 'home', operations: []}];
    empty.scripts = [];
    empty.screens = [{key: 'home', kind: 'create', title: 'Home'}];
    await expectCode(empty, 'EMPTY_FLOW');
    for (const code of ['UNRESOLVED_TARGET', 'INVALID_TRANSITION', 'UNKNOWN_SCRIPT_ANCHOR', 'SCRIPT_SYNTAX', 'SCRIPT_TRUST_REQUIRED', 'MOCK_REQUIRED', 'MISSING_PARAMETER_DECLARATION', 'RUNTIME_INPUT_REQUIRED', 'NO_UI_ASSERTIONS', 'UNVERIFIED_SELECTOR', 'UNSUPPORTED_SHARED_YAML', 'SHARED_EXECUTION_CONFLICT']) assert.equal(seen.has(code), true, code);
  } finally { await f.cleanup(); }
});

test('oversize drafts, duplicate JSON members and unknown properties are rejected', async () => {
  const f = await authoringFixture();
  try {
    try { decodeAuthoringJson(' '.repeat(REQUEST_LIMIT + 1)); assert.fail('expected a 413'); }
    catch (error) { assert.equal((error as AuthoringHttpError).status, 413); assert.equal((error as AuthoringHttpError).code, 'REQUEST_TOO_LARGE'); }
    try { decodeAuthoringJson('{"workspaceId":"a","workspaceId":"b"}'); assert.fail('expected a 400'); }
    catch (error) { assert.equal((error as AuthoringHttpError).status, 400); assert.equal((error as AuthoringHttpError).code, 'DUPLICATE_MEMBER'); }
    const extra = {...draft(), extra: true};
    const unknown = await previewOf(f.service, f.workspace, extra);
    assert.equal(unknown.applicable, false);
    assert.equal(codes(unknown).has('INVALID_DRAFT'), true);
    const coordinates = draft();
    (coordinates.screens[0] as {x?: number}).x = 10;
    const pointed = await previewOf(f.service, f.workspace, coordinates);
    assert.equal(pointed.diagnostics.some(item => item.code === 'INVALID_DRAFT' && item.message.includes('Coordinates')), true);
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const timed = await authoringFixture({now: () => new Date(clock)});
    try {
      const context = await timed.service.authoring.context({workspaceId: timed.workspace.id, expectedRevision: timed.workspace.metadata!.revision});
      clock += 31 * 60 * 1000;
      await assert.rejects(() => timed.service.authoring.preview({workspaceId: timed.workspace.id, expectedRevision: timed.workspace.metadata!.revision, contextId: context.contextId, draft: draft()}), (error: unknown) => { assert.equal((error as AuthoringHttpError).status, 410); assert.equal((error as AuthoringHttpError).code, 'CONTEXT_EXPIRED'); return true; });
    } finally { await timed.cleanup(); }
  } finally { await f.cleanup(); }
});
