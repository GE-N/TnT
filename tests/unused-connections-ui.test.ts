import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement, useState} from 'react';
import type {CanvasGraph} from '../server/canvas.js';
import {getSidePanel, openPanel, resetSidePanels} from '../src/side-panels.js';

const reference = {kind: 'step' as const, file: 'flow.yaml', index: 0, fingerprint: 'a'.repeat(64)};

function step(id: string, label: string) {
  return {id, label, role: 'action' as const, reference, tap: {target: 'text' as const, match: 'exact' as const, value: label}};
}

function edge(id: string, from: string, to: string, name: string) {
  return {id, from, to, actionTestId: from + '-step', assertionTestId: to + '-step', responseCondition: name};
}

function shop(): CanvasGraph {
  return {
    screens: [
      {id: 'signin', title: 'Sign in', x: 40, y: 40, tests: [step('signin-step', 'Sign in')]},
      {id: 'home', title: 'Home', x: 360, y: 40, tests: [step('home-step', 'Home')]},
      {id: 'orders', title: 'Orders', x: 680, y: 40, tests: [step('orders-step', 'Orders')]},
      {id: 'profile', title: 'Profile', x: 360, y: 280, tests: [step('profile-step', 'Profile')]},
      {id: 'checkout', title: 'Checkout', x: 680, y: 280, tests: [step('checkout-step', 'Checkout')]},
    ],
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
      {id: 'checkout-path', name: 'Checkout', scenarioId: 'checkout', screenId: 'orders', edgeIds: ['pay']},
    ],
  };
}

async function mount(initial: CanvasGraph, options?: {running?: boolean}) {
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT'];
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class ResizeObserver { observe() {} disconnect() {} }
  for (const key of keys) Object.defineProperty(globalThis, key, {value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'ResizeObserver' ? ResizeObserver : Reflect.get(dom.window, key), configurable: true});
  const {createRoot} = await import('react-dom/client');
  const {CanvasEditor} = await import('../src/canvas.js');
  const root = createRoot(dom.window.document.getElementById('root')!);
  let saved = initial;
  function Host() {
    const [graph, setGraph] = useState(initial);
    saved = graph;
    return createElement(CanvasEditor, {
      graph, onChange: next => { if (next) setGraph(next); }, catalog: [], diagnostics: [], pathId: 'sign-in', onPathChange: () => {}, disabled: false,
      scenarioMode: true, scenarioId: 'sign-in', scenarios: [{id: 'sign-in', name: 'Sign in', pathId: 'sign-in'}, {id: 'checkout', name: 'Checkout', pathId: 'checkout-path'}],
      yaml: 'appId: com.example.App\n---\n- launchApp\n', onYamlChange: () => {}, onRun: () => {},
      run: options?.running ? {status: 'running'} : undefined,
    });
  }
  resetSidePanels();
  await act(async () => root.render(createElement(Host)));
  const document = dom.window.document;
  return {
    document,
    saved: () => saved,
    async click(label: string) {
      await act(async () => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent) === label);
        assert.ok(button, label);
        button.click();
      });
    },
    async openMenu() {
      await act(async () => document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 80, clientY: 80})));
    },
    async close() {
      await act(async () => { resetSidePanels(); root.unmount(); });
      dom.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('the empty-canvas menu opens the sheet, and Remove keeps screens and edges another path still uses', async () => {
  const page = await mount(shop());
  try {
    await page.openMenu();
    const items = [...page.document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].map(item => item.textContent);
    assert.ok(items.includes('Unused connections…'));
    assert.equal(items.at(-1), 'Unused connections…');
    await page.click('Unused connections…');
    const sheet = page.document.querySelector('[data-testid="unused-connections-sheet"]');
    assert.ok(sheet);
    assert.match(sheet.textContent ?? '', /2 will be removed/);
    assert.match(sheet.textContent ?? '', /Home → Profile/);
    assert.match(sheet.textContent ?? '', /Open profile/);
    assert.match(sheet.textContent ?? '', /Profile → Checkout/);
    assert.doesNotMatch(sheet.textContent ?? '', /Orders → Checkout|Sign in → Home|Missing screen/);
    assert.equal(getSidePanel(), 'unused');
    const before = page.saved();
    await page.click('Remove');
    assert.equal(page.document.querySelector('[data-testid="unused-connections-sheet"]'), null);
    assert.deepEqual(page.saved().edges.map(item => item.id), ['continue', 'orders', 'pay', 'ghost']);
    assert.deepEqual(page.saved().screens, before.screens);
    assert.deepEqual(page.saved().paths, before.paths);
    assert.ok(page.document.querySelector('[aria-label="Screen Profile"]'));
    assert.ok(page.document.querySelector('[aria-label="Connection Orders to Checkout"]'));
    assert.equal(page.document.querySelector('[aria-label="Connection Home to Profile"]'), null);
    const toast = page.document.querySelector('[data-testid="unused-connections-toast"]');
    assert.match(toast?.textContent ?? '', /2 unused connections removed/);
    assert.ok(toast?.querySelector('button')?.textContent === 'Undo');
    await page.click('Undo unused connection removal');
    assert.deepEqual(page.saved().edges.map(item => item.id), ['continue', 'orders', 'pay', 'profile', 'later', 'ghost']);
    assert.equal(page.document.querySelector('[data-testid="unused-connections-toast"]'), null);
    assert.ok(page.document.querySelector('[aria-label="Connection Home to Profile"]'));
  } finally { await page.close(); }
});

test('Cancel and an empty list leave the canvas unchanged', async () => {
  const page = await mount(shop());
  let closed = false;
  const shutdown = async () => { if (!closed) { closed = true; await page.close(); } };
  try {
    await act(async () => { openPanel('settings'); });
    await page.openMenu();
    await page.click('Unused connections…');
    assert.equal(getSidePanel(), 'unused');
    await page.click('Cancel');
    assert.equal(page.document.querySelector('[data-testid="unused-connections-sheet"]'), null);
    assert.equal(page.saved().edges.length, 6);
    const clean = structuredClone(page.saved());
    clean.edges = clean.edges.filter(item => item.id !== 'profile' && item.id !== 'later');
    await shutdown();
    const empty = await mount(clean);
    try {
      await empty.openMenu();
      await empty.click('Unused connections…');
      const sheet = empty.document.querySelector('[data-testid="unused-connections-sheet"]');
      assert.match(sheet?.textContent ?? '', /No unused connections/);
      assert.doesNotMatch(sheet?.textContent ?? '', /will be removed/);
      const remove = [...empty.document.querySelectorAll('button')].find(item => item.textContent === 'Remove');
      assert.equal(remove?.disabled, true);
      await empty.click('Cancel');
      assert.deepEqual(empty.saved().edges.map(item => item.id), clean.edges.map(item => item.id));
    } finally { await empty.close(); }
  } catch (error) {
    await shutdown();
    throw error;
  }
});

test('the command is disabled while a scenario is running', async () => {
  const page = await mount(shop(), {running: true});
  try {
    await page.openMenu();
    const item = [...page.document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button => button.textContent === 'Unused connections…');
    assert.ok(item);
    assert.equal(item.disabled, true);
    assert.equal(item.title, 'Unavailable while the scenario is running.');
    await act(async () => item.click());
    assert.equal(page.document.querySelector('[data-testid="unused-connections-sheet"]'), null);
    assert.equal(page.saved().edges.length, 6);
  } finally { await page.close(); }
});

test('the node menu does not offer unused connections, and the toast clears on the next canvas change', async () => {
  const page = await mount(shop());
  try {
    await act(async () => page.document.querySelector('[aria-label="Screen Home"]')!.dispatchEvent(new page.document.defaultView!.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 40, clientY: 40})));
    assert.equal([...page.document.querySelectorAll('[role=menuitem]')].some(item => item.textContent === 'Unused connections…'), false);
    await act(async () => page.document.dispatchEvent(new page.document.defaultView!.KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
    await page.openMenu();
    await page.click('Unused connections…');
    await page.click('Remove');
    assert.ok(page.document.querySelector('[data-testid="unused-connections-toast"]'));
    await act(async () => page.document.querySelector('[aria-label="Screen Home"]')!.dispatchEvent(new page.document.defaultView!.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 40, clientY: 40})));
    await page.click('Rename');
    const input = page.document.querySelector('[aria-label="Screen title for Home"]') as HTMLInputElement;
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(page.document.defaultView!.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Home base');
      input.dispatchEvent(new page.document.defaultView!.Event('input', {bubbles: true}));
      input.dispatchEvent(new page.document.defaultView!.FocusEvent('focusout', {bubbles: true}));
    });
    assert.equal(page.saved().screens.find(item => item.id === 'home')?.title, 'Home base');
    assert.equal(page.document.querySelector('[data-testid="unused-connections-toast"]'), null);
    assert.deepEqual(page.saved().edges.map(item => item.id), ['continue', 'orders', 'pay', 'ghost']);
  } finally { await page.close(); }
});

test('the undo toast clears after 8 seconds', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const page = await mount(shop());
  try {
    await page.openMenu();
    await page.click('Unused connections…');
    await page.click('Remove');
    assert.ok(page.document.querySelector('[data-testid="unused-connections-toast"]'));
    await act(async () => { t.mock.timers.tick(7999); });
    assert.ok(page.document.querySelector('[data-testid="unused-connections-toast"]'));
    await act(async () => { t.mock.timers.tick(1); });
    assert.equal(page.document.querySelector('[data-testid="unused-connections-toast"]'), null);
    assert.deepEqual(page.saved().edges.map(item => item.id), ['continue', 'orders', 'pay', 'ghost']);
  } finally {
    t.mock.timers.reset();
    await page.close();
  }
});
