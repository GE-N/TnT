import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {FlowDraft} from '../server/authoring/types.js';
import {capsuleMode, makeVersion, projectionFor, readAiVersions, relativeVersionTime, selfContainedSnapshot, sharedScreenIds, VERSION_BYTE_BUDGET, VERSION_CAP, withPoppedVersion, withPushedVersion, withRestoredVersion, type AiVersionsState, type FlowVersion} from '../src/ai-versions.js';

function draft(screens: FlowDraft['screens'], name = 'Coupon check'): FlowDraft {
  return {
    schemaVersion: 1, mode: 'createScenario', name, appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens,
    visits: [
      {key: 'v1', screenKey: 'home', operations: [{key: 'open', kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Shoes'}}, destination: {kind: 'visit', visitKey: 'v2'}}]},
      {key: 'v2', screenKey: 'cart', operations: [{key: 'see', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Save'}}}]}
    ],
    scripts: [], assumptions: [],
  };
}

function version(id: string, createdAt: string, title = id): FlowVersion {
  const made = makeVersion({
    id, createdAt, draft: draft([{key: 'home', kind: 'create', title: 'Home'}, {key: 'cart', kind: 'create', title: 'Cart'}], title),
    placements: {home: {x: 40, y: 40}, cart: {x: 320, y: 40}}, screens: [], sharedScreenIds: new Set(),
  });
  return made;
}

test('an existing screen owned only by this flow becomes a create screen with its position', () => {
  const result = selfContainedSnapshot({
    draft: draft([
      {key: 'home', kind: 'existing', screenId: 'screen-home'},
      {key: 'cart', kind: 'create', title: 'Cart'},
      {key: 'shared', kind: 'existing', screenId: 'screen-shared'},
    ]),
    placements: {cart: {x: 320, y: 80}},
    screens: [
      {id: 'screen-home', title: 'Home', x: 88, y: 120},
      {id: 'screen-shared', title: 'Catalog', x: 600, y: 120},
    ],
    sharedScreenIds: new Set(['screen-shared']),
  });
  assert.deepEqual(result.draft.screens[0], {key: 'home', kind: 'create', title: 'Home'});
  assert.deepEqual(result.draft.screens[1], {key: 'cart', kind: 'create', title: 'Cart'});
  assert.deepEqual(result.draft.screens[2], {key: 'shared', kind: 'existing', screenId: 'screen-shared'});
  assert.deepEqual(result.placements.home, {x: 88, y: 120});
  assert.deepEqual(result.placements.cart, {x: 320, y: 80});
  assert.equal(result.placements.shared, undefined);
  const projection = projectionFor(result.draft, result.placements, [{id: 'screen-shared', title: 'Catalog', x: 600, y: 120}]);
  assert.equal(projection.screens.find(screen => screen.key === 'home')?.title, 'Home');
  assert.deepEqual(projection.screens.find(screen => screen.key === 'shared'), {key: 'shared', title: 'Catalog', x: 600, y: 120, steps: []});
  assert.equal(projection.edges[0]?.label, 'Tap → Cart');
  assert.match(projection.screens.find(screen => screen.key === 'home')?.steps[0] ?? '', /Go to Cart/);
});

test('shared screen ids come from other scenarios only', () => {
  const ids = sharedScreenIds({
    screens: [],
    edges: [{id: 'e1', from: 'a', to: 'b'}, {id: 'e2', from: 'b', to: 'c'}],
    paths: [
      {id: 'path-flow', scenarioId: 'flow', screenId: 'a', edgeIds: ['e1']},
      {id: 'path-other', scenarioId: 'other', screenId: 'b', edgeIds: ['e2']},
    ],
  }, 'flow');
  assert.deepEqual([...ids].sort(), ['b', 'c']);
});

test('the stack caps at 20 and trims the oldest to stay under the byte budget', () => {
  let state: AiVersionsState = {format: 1, flows: {}};
  for (let index = 0; index < VERSION_CAP + 3; index++) {
    state = withPushedVersion(state, 'flow', version('v' + index, '2026-10-27T00:' + String(index).padStart(2, '0') + ':00.000Z'));
  }
  const list = state.flows.flow;
  assert.equal(list.length, VERSION_CAP);
  assert.equal(list[0]?.id, 'v3');
  assert.equal(list.at(-1)?.id, 'v' + (VERSION_CAP + 2));
  assert.equal(state.current, 'flow');

  const bulky = version('big', '2026-10-27T02:00:00.000Z', 'x'.repeat(16_000));
  const older = version('old', '2026-10-27T01:00:00.000Z', 'First AI draft');
  const trimmed = withPushedVersion(withPushedVersion({format: 1, flows: {}}, 'flow', older), 'flow', bulky);
  const again = withPushedVersion(trimmed, 'flow', version('newer', '2026-10-27T03:00:00.000Z', 'y'.repeat(16_000)));
  assert.ok(new TextEncoder().encode(JSON.stringify(again)).length <= VERSION_BYTE_BUDGET);
  assert.equal(again.flows.flow.some(item => item.id === 'old'), false);
  assert.equal(again.flows.flow.at(-1)?.id, 'newer');
});

test('undo pops the entry its apply pushed and restore checkpoints Now', () => {
  const first = version('v1', '2026-10-27T01:00:00.000Z', 'First AI draft');
  const second = version('v2', '2026-10-27T02:00:00.000Z', 'Home to Coordinator');
  const now = version('v3', '2026-10-27T03:00:00.000Z', 'Coupon check');
  let state = withPushedVersion(withPushedVersion(withPushedVersion({format: 1, flows: {}}, 'flow', first), 'flow', second), 'flow', now);
  const popped = withPoppedVersion(state, 'flow');
  assert.deepEqual(popped.flows.flow.map(item => item.id), ['v1', 'v2']);
  assert.equal(popped.current, 'flow');
  const cleared = withPoppedVersion(withPoppedVersion(popped, 'flow'), 'flow');
  assert.equal(cleared.current, undefined);
  assert.equal(cleared.flows.flow, undefined);

  const ids = ['checkpoint', 'restored'];
  const restored = withRestoredVersion(state, 'v2', '2026-10-27T04:00:00.000Z', () => ids.shift()!);
  const head = restored.flows.flow;
  assert.equal(head.at(-1)?.title, 'Home to Coordinator');
  assert.equal(head.at(-2)?.title, 'Coupon check');
  assert.equal(head.at(-2)?.id, 'checkpoint');
  assert.equal(head.at(-1)?.id, 'restored');
  assert.equal(head.filter(item => item.title === 'Coupon check').length, 2);
  assert.equal(restored.current, 'flow');
  const roundTrip = readAiVersions({aiVersions: restored});
  assert.equal(roundTrip.current, 'flow');
  assert.equal(roundTrip.flows.flow.length, head.length);
});

test('capsule mode prefers a draft, then undo, then versions, otherwise idle', () => {
  assert.equal(capsuleMode({draftOpen: true, undoVisible: true, versionCount: 3}), 'draft');
  assert.equal(capsuleMode({draftOpen: true, undoVisible: true, versionCount: 0}), 'draft');
  assert.equal(capsuleMode({draftOpen: true, undoVisible: false, versionCount: 3}), 'draft');
  assert.equal(capsuleMode({draftOpen: true, undoVisible: false, versionCount: 0}), 'draft');
  assert.equal(capsuleMode({draftOpen: false, undoVisible: true, versionCount: 3}), 'undo');
  assert.equal(capsuleMode({draftOpen: false, undoVisible: true, versionCount: 1}), 'undo');
  assert.equal(capsuleMode({draftOpen: false, undoVisible: true, versionCount: 0}), 'undo');
  assert.equal(capsuleMode({draftOpen: false, undoVisible: false, versionCount: 1}), 'versions');
  assert.equal(capsuleMode({draftOpen: false, undoVisible: false, versionCount: 4}), 'versions');
  assert.equal(capsuleMode({draftOpen: false, undoVisible: false, versionCount: 0}), 'idle');
});

test('relative time uses the versions microcopy', () => {
  const now = new Date(2026, 9, 27, 15, 0, 0).getTime();
  assert.equal(relativeVersionTime(new Date(now - 10_000).toISOString(), now), 'Just now');
  assert.equal(relativeVersionTime(new Date(now - 2 * 60_000).toISOString(), now), '2 min ago');
  assert.equal(relativeVersionTime(new Date(2026, 9, 27, 10, 0, 0).toISOString(), now), 'Earlier today');
  assert.equal(relativeVersionTime(new Date(2026, 9, 26, 15, 0, 0).toISOString(), now), 'Yesterday');
});
