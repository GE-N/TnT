import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Run} from '../server/scenarios.js';
import {dotKind, resultModel} from '../src/results-view.js';

function run(patch: Partial<Run> & {status: Run['status']}): Run {
  return {mappingNote: 'test',
    id: '11111111-1111-1111-1111-111111111111',
    deviceId: 'device',
    startedAt: '2026-11-07T02:00:00.000Z',
    finishedAt: '2026-11-07T02:00:07.000Z',
    snapshot: {id: 'snap', workspaceId: 'ws', name: 'Guest checkout', yaml: '', steps: [], toolVersions: {maestro: '2.11.0', node: '22'}, runtimeInputPolicy: 'none', scenario: {id: 'scenario-guest', name: 'Guest checkout', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}, canvas: {screens: [
      {id: 'home', title: 'Home', x: 0, y: 0, tests: [{id: 'h', label: 'Home', role: 'assertion', reference: {kind: 'step', file: 'flow.yaml', fingerprint: 'draft'}, check: {visibility: 'visible', target: 'text', match: 'exact', value: 'Shop'}}]},
      {id: 'cart', title: 'Cart', x: 0, y: 0, tests: [{id: 'c', label: 'Cart', role: 'assertion', reference: {kind: 'step', file: 'flow.yaml', fingerprint: 'draft'}, check: {visibility: 'visible', target: 'text', match: 'exact', value: 'Running shoes · 1'}}]},
    ], edges: [], paths: [{id: 'route', name: 'Guest', screenId: 'home', edgeIds: []}]}},
    steps: [],
    log: 'example [redacted]',
    artifacts: ['screenshot-failure.png'],
    cleanup: {verified: true, detail: 'clean'},
    canvas: {pathId: 'route', note: '', tests: [], screens: [], edges: [], visits: [{id: 'v1', screenId: 'home', status: 'passed', checkIds: []}, {id: 'v2', screenId: 'cart', status: patch.status === 'passed' ? 'passed' : 'failed', checkIds: []}], occurrences: [
      {id: 'o1', visitId: 'v1', testId: 'h', status: 'passed', detail: ''},
      {id: 'o2', visitId: 'v2', testId: 'c', status: patch.status === 'passed' ? 'passed' : 'failed', detail: 'Runner command reported FAILED'},
    ]},
    ...patch,
  } as Run;
}

test('passed copy counts checks and never says Outcome verified', () => {
  const model = resultModel(run({status: 'passed'}));
  assert.equal(model.statusText, 'Checks passed');
  assert.equal(model.counts.startsWith('2 of 2 checks passed'), true);
  assert.equal(JSON.stringify(model).includes('Outcome verified'), false);
  assert.equal(model.rows.every(row => row.hint === '1 steps' || row.hint === '2 steps' || row.hint.endsWith('steps')), true);
});

test('failed copy names the screen and one plain cause', () => {
  const model = resultModel(run({status: 'assertion-failed'}));
  assert.equal(model.statusText, 'Failed at Cart');
  assert.match(model.cause, /wasn't on screen/);
  assert.equal(model.cause.includes('Runner command'), false);
  assert.equal(model.rows.find(row => row.name === 'Cart')?.hint, '1 of 1 failed');
  assert.equal(model.thumbnail, 'screenshot-failure.png');
});

test('running has no per-step counts and scrub stays conservative', () => {
  const running = resultModel(run({status: 'running', finishedAt: undefined, canvas: undefined}));
  assert.equal(running.statusText, 'Running…');
  assert.equal(running.counts, '');
  assert.equal(running.rows.every(row => !row.hint && !row.status), true);
  const scrub = resultModel(run({status: 'error', error: 'Evidence scrub failed', snapshot: {id: 'evidence-removed', workspaceId: 'ws', name: 'Evidence removed', yaml: '', steps: [], toolVersions: {maestro: '2.11.0', node: '22'}, runtimeInputPolicy: 'Evidence scrub failed'}, canvas: undefined, artifacts: [], log: '', steps: []}));
  assert.equal(scrub.scrub, true);
  assert.equal(scrub.title, 'Evidence removed');
  assert.equal(scrub.statusText, "Couldn't finish");
  assert.equal(scrub.thumbnail, undefined);
  assert.equal(dotKind(run({status: 'error', error: 'Evidence scrub failed'}), undefined), 'warn');
});
