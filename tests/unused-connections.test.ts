import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CanvasGraph, Transition} from '../server/canvas.js';
import {removeUnusedConnections, unusedConnections} from '../shared/canvas-authoring.js';

function screen(id: string, title = id): CanvasGraph['screens'][number] {
  return {id, title, x: 0, y: 0, tests: [{id: id + '-step', label: title, role: 'action', reference: {kind: 'step', file: 'flow.yaml', index: 0, fingerprint: 'a'.repeat(64)}, tap: {target: 'text', match: 'exact', value: title}}]};
}

function edge(id: string, from: string, to: string, name = id): Transition {
  return {id, from, to, actionTestId: from + '-step', assertionTestId: to + '-step', responseCondition: name};
}

function shop(): CanvasGraph {
  return {
    screens: [screen('signin', 'Sign in'), screen('home', 'Home'), screen('orders', 'Orders'), screen('profile', 'Profile'), screen('checkout', 'Checkout')],
    edges: [
      edge('continue', 'signin', 'home', 'Continue'),
      edge('orders', 'home', 'orders', 'Open orders'),
      edge('pay', 'orders', 'checkout', 'Pay'),
      edge('profile', 'home', 'profile', 'Open profile'),
      edge('later', 'profile', 'checkout', 'Continue'),
      edge('ghost', 'home', 'missing', 'Missing screen'),
    ],
    paths: [
      {id: 'sign-in', name: 'Sign in', scenarioId: 'sign-in', screenId: 'signin', edgeIds: ['continue', 'orders']},
      {id: 'checkout', name: 'Checkout', scenarioId: 'checkout', screenId: 'orders', edgeIds: ['pay']},
      {id: 'legacy', name: 'Legacy route', screenId: 'home', edgeIds: []},
    ],
  };
}

function restore(canvas: CanvasGraph, removed: {edge: Transition; index: number}[]): CanvasGraph {
  const edges = [...canvas.edges];
  for (const item of [...removed].sort((a, b) => a.index - b.index)) {
    if (!edges.some(edge => edge.id === item.edge.id)) edges.splice(Math.min(item.index, edges.length), 0, item.edge);
  }
  return {...canvas, edges};
}

test('unused connections are edges whose screens both exist and that no path lists', () => {
  const canvas = shop();
  assert.deepEqual(unusedConnections(canvas).map(item => item.id), ['profile', 'later']);
  const next = removeUnusedConnections(canvas);
  assert.deepEqual(next.edges.map(item => item.id), ['continue', 'orders', 'pay', 'ghost']);
  assert.equal(next.screens, canvas.screens);
  assert.equal(next.paths, canvas.paths);
  assert.deepEqual(next.screens.map(item => item.tests), canvas.screens.map(item => item.tests));
});

test('an edge used by another scenario, a legacy path, or a shared screen stays', () => {
  const canvas = shop();
  canvas.paths[2].edgeIds = ['profile'];
  assert.deepEqual(unusedConnections(canvas).map(item => item.id), ['later']);
  const shared = removeUnusedConnections(canvas);
  assert.ok(shared.edges.some(item => item.id === 'profile'), 'Home is shared, and Sign in does not have to list the edge');
  assert.ok(shared.edges.some(item => item.id === 'pay'));
  assert.equal(shared.screens.find(item => item.id === 'home'), canvas.screens.find(item => item.id === 'home'));
});

test('dangling edges are not unused and are not removed', () => {
  const canvas = shop();
  canvas.edges.push(edge('orphan-from', 'missing', 'home', 'From nowhere'));
  const ids = unusedConnections(canvas).map(item => item.id);
  assert.equal(ids.includes('ghost'), false);
  assert.equal(ids.includes('orphan-from'), false);
  const next = removeUnusedConnections(canvas);
  assert.ok(next.edges.some(item => item.id === 'ghost'));
  assert.ok(next.edges.some(item => item.id === 'orphan-from'));
  assert.equal(next.screens.length, canvas.screens.length);
});

test('removal is idempotent and undo splices the removed edges back in order', () => {
  const canvas = shop();
  const removed = unusedConnections(canvas).map(item => ({edge: item, index: canvas.edges.indexOf(item)}));
  const once = removeUnusedConnections(canvas);
  const twice = removeUnusedConnections(once);
  assert.equal(twice, once);
  assert.deepEqual(unusedConnections(once), []);
  const restored = restore(once, removed);
  assert.deepEqual(restored.edges, canvas.edges);
  assert.equal(restored.screens, once.screens);
  assert.equal(restored.paths, once.paths);
});

test('a path with no scenario still protects its edge, including one of two parallel links', () => {
  const canvas = shop();
  canvas.edges.push(edge('pay-again', 'orders', 'checkout', 'Pay later'));
  canvas.paths.push({id: 'plain', name: 'Plain', screenId: 'orders', edgeIds: ['pay-again']});
  assert.equal(unusedConnections(canvas).some(item => item.id === 'pay-again'), false);
  assert.deepEqual(removeUnusedConnections(canvas).edges.filter(item => item.from === 'orders' && item.to === 'checkout').map(item => item.id), ['pay', 'pay-again']);
});
